/**
 * The web SFU transport against a scripted fake server and a fake
 * RTCPeerConnection (docs/claude/voice.md, "SFU voice (server)": the 15
 * steps of the client protocol; "SFU voice, web"). Each block names the
 * step it checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SfuTransport, PULL_BATCH, PULL_RETRY_MAX, PULL_SLOW_RETRY_MS, BOOT_HOLD_MS, BUSY_STUCK_MS, ICE_RESTART_MAX_AWAY_MS, STALL_COOLDOWN_MS, CONNECT_TIMEOUT_MS, classifyError,
} from './SfuTransport.js';
import { REPLY_TIMEOUT_MS } from './sfuRequests.js';
import { FakeSfuPC, createFakeSfuServer } from '../../testing/fakeSfu.js';

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function setup({ mic = null, socketId = 'sock-1' } = {}) {
  const server = createFakeSfuServer({ socketId });
  const audio = { add: vi.fn(), remove: vi.fn() };
  const win = new EventTarget();
  const state = { mic };
  const t = new SfuTransport({
    getSocket: () => server.socket,
    audio,
    getMicTrack: () => state.mic,
    createPeerConnection: (cfg) => new FakeSfuPC(cfg),
    win,
    log: () => {},
  });
  server.transport = t;
  return { t, server, audio, win, state, pc: () => t.session?.pc };
}

const micTrack = () => ({ kind: 'audio', id: `mic-${Math.random().toString(36).slice(2, 6)}`, enabled: true });
const A = { username: 'alice', sessionId: 'sa', trackName: 'mic' };
const B = { username: 'bob', sessionId: 'sb', trackName: 'mic' };
const QUIET = { username: 'carol', sessionId: null, trackName: null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  FakeSfuPC.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('step 1: mode', () => {
  it('an sfuRoster makes it an SFU room; a mesh event a mesh room (a held session closes, no sfuLeave)', async () => {
    const { t, server, pc } = setup();
    expect(t.mode).toBe(null);
    t.start();
    t.onRoster(server.roster([A]));
    expect(t.mode).toBe('sfu');
    await settle();
    expect(pc()).toBeTruthy();
    const held = pc();
    t.onMeshEvent();
    expect(t.mode).toBe('mesh');
    expect(held.connectionState).toBe('closed');
    expect(t.session).toBe(null);
    expect(server.sent('sfuLeave')).toHaveLength(0);
    expect(t.hasCompany()).toBe(false);
  });

  it('enterRoom undecides the mode and keeps the session for the next roster', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const s = t.session;
    t.enterRoom();
    expect(t.mode).toBe(null);
    expect(t.hasCompany()).toBe(false);
    expect(t.session).toBe(s);
    t.onRoster(server.roster([A], { rev: 2, self: { sessionId: s.sessionId, trackName: null, state: 'live' } }));
    expect(t.hasCompany()).toBe(true);
    await settle();
    expect(t.session).toBe(s);
  });

  it('waiting: no company, no session; out: the session ends with no sfuLeave', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([], { status: 'waiting', cap: 2 }));
    await settle();
    expect(t.status).toBe('waiting');
    expect(t.cap).toBe(2);
    expect(t.hasCompany()).toBe(false);
    expect(server.sent('sfuSession')).toHaveLength(0);
    t.onRoster(server.roster([A], { rev: 2 }));
    await settle();
    const pc = t.session.pc;
    t.onRoster(server.roster([], { status: 'out', rev: 3 }));
    await settle();
    expect(pc.connectionState).toBe('closed');
    expect(t.session).toBe(null);
    expect(server.sent('sfuLeave')).toHaveLength(0);
  });

  it('nothing is sent before voice runs (no voice alone), and a roster before start is kept', async () => {
    const { t, server } = setup();
    t.onRoster(server.roster([A]));
    await settle();
    expect(server.requests).toHaveLength(0);
    expect(t.hasCompany()).toBe(true);
    t.start();
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(1);
  });
});

describe('step 2: the lazy session', () => {
  it('no session while nobody publishes and I am muted; one when someone publishes', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([QUIET]));
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(0);
    t.onMember(server.member('published', { username: 'carol', sessionId: 'sc', trackName: 'mic' }, { rev: 2 }));
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(1);
    expect(server.sent('sfuPull')).toHaveLength(1);
  });

  it('the first unmute makes a session when there is nothing to pull', async () => {
    const { t, server, state } = setup();
    t.start();
    t.onRoster(server.roster([QUIET]));
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(0);
    state.mic = micTrack();
    t.micReady();
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(1);
    expect(server.sent('sfuPush')).toHaveLength(1);
  });
});

describe('step 3: one PeerConnection per session, one serial queue', () => {
  it('max-bundle with the Cloudflare STUN server', async () => {
    const { t, server, pc } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    expect(FakeSfuPC.all).toHaveLength(1);
    expect(pc().config.bundlePolicy).toBe('max-bundle');
    expect(pc().config.iceServers).toEqual([{ urls: 'stun:stun.cloudflare.com:3478' }]);
  });

  it('never two requests of a session in flight at once', async () => {
    const { t, server, state } = setup({ mic: micTrack() });
    server.autoReply = false;
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    expect(server.held.map((h) => h.event)).toEqual(['sfuSession']);
    server.release();
    await settle();
    // the push waits for nothing but its own reply; the pull waits behind it
    expect(server.held.map((h) => h.event)).toEqual(['sfuPush']);
    server.release();
    await settle();
    expect(server.held.map((h) => h.event)).toEqual(['sfuPull']);
    server.release();
    await settle();
    expect(server.held.map((h) => h.event)).toEqual(['sfuRenegotiate']);
    server.release();
    await settle();
    expect(server.held).toHaveLength(0);
    expect(state.mic).toBeTruthy();
  });
});

describe('step 4: push on the first unmute, never before', () => {
  it('a muted listener pushes nothing; the unmute adds a sendonly transceiver and pushes it as "mic"', async () => {
    const { t, server, state, pc } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    expect(server.sent('sfuPush')).toHaveLength(0);
    expect(pc().transceivers.filter((x) => x.direction === 'sendonly')).toHaveLength(0);
    state.mic = micTrack();
    t.micReady();
    await settle();
    const push = server.last('sfuPush');
    expect(push.data.trackName).toBe('mic');
    const tx = pc().transceivers.find((x) => x.direction === 'sendonly');
    expect(tx.sender.track).toBe(state.mic);
    expect(push.data.mid).toBe(tx.mid);
    expect(push.data.offer.type).toBe('offer');
    expect(pc().log).toContainEqual(['setRemote', 'answer']);
    expect(t.session.published).toMatchObject({ mid: tx.mid, trackName: 'mic' });
    // mute is the track's enabled flag (the manager's): nothing more is pushed
    state.mic.enabled = false;
    t.micReady();
    await settle();
    expect(server.sent('sfuPush')).toHaveLength(1);
  });

  it('already_published is a bug: never the same push again', async () => {
    const { t, server } = setup({ mic: micTrack() });
    server.fail('sfuPush', 'already_published');
    t.start();
    t.onRoster(server.roster([QUIET]));
    await settle(10000);
    expect(server.sent('sfuPush')).toHaveLength(1);
    expect(t.session.publishFailed).toBe(true);
  });

  it('a failed push rolls its offer back and retries on the same transceiver', async () => {
    const { t, server, pc } = setup({ mic: micTrack() });
    server.fail('sfuPush', 'busy', { retryable: true, retryAfterMs: 500 });
    t.start();
    t.onRoster(server.roster([QUIET]));
    await settle();
    expect(pc().log).toContainEqual(['setLocal', 'rollback']);
    await settle(600);
    expect(server.sent('sfuPush')).toHaveLength(2);
    expect(pc().transceivers.filter((x) => x.direction === 'sendonly')).toHaveLength(1);
    expect(t.session.published).toBeTruthy();
  });

  it('the Opus cap, when set, is applied to the published sender', async () => {
    const { t, server, pc } = setup({ mic: micTrack() });
    t.opusMaxBitrate = 24000;
    t.start();
    t.onRoster(server.roster([QUIET]));
    await settle();
    const tx = pc().transceivers.find((x) => x.direction === 'sendonly');
    expect(tx.sender.params.encodings[0].maxBitrate).toBe(24000);
  });
});

describe('step 5: batched pulls', () => {
  it('maps every mid to its member before setRemoteDescription, answers, renegotiates', async () => {
    const { t, server, audio, pc } = setup();
    t.start();
    t.onRoster(server.roster([A, B, QUIET]));
    await settle();
    const pull = server.last('sfuPull');
    expect(pull.data.tracks).toEqual([{ sessionId: 'sa', trackName: 'mic' }, { sessionId: 'sb', trackName: 'mic' }]);
    // ontrack fired inside setRemoteDescription, already mapped
    expect(audio.add.mock.calls.map((c) => c[0]).sort()).toEqual(['alice', 'bob']);
    expect(pc().log.map((x) => x.join(' '))).toEqual(expect.arrayContaining(['setRemote offer', 'setLocal answer']));
    expect(server.sent('sfuRenegotiate')).toHaveLength(1);
    expect(server.last('sfuRenegotiate').data.answer.type).toBe('answer');
    expect(t.members().filter((m) => m.pulled).map((m) => m.username)).toEqual(['alice', 'bob']);
  });

  it(`at most ${PULL_BATCH} tracks a pull`, async () => {
    const { t, server } = setup();
    const many = Array.from({ length: 70 }, (_, i) => ({ username: `p${i}`, sessionId: `s${i}`, trackName: 'mic' }));
    t.start();
    t.onRoster(server.roster(many));
    await settle();
    expect(server.sent('sfuPull').map((r) => r.data.tracks.length)).toEqual([64, 6]);
  });

  it(`empty_track_error / not_found_track_error: retried every 1 s ${PULL_RETRY_MAX} times, then every ${PULL_SLOW_RETRY_MS / 1000} s while the member is live; the offer is still answered`, async () => {
    const { t, server, audio, pc } = setup();
    server.script('sfuPull', (data, def) => {
      const r = def();
      r.tracks = r.tracks.map((x) => (x.sessionId === 'sa' ? { ...x, mid: null, errorCode: 'empty_track_error' } : x));
      return r;
    });
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    pc().setState('connected');
    expect(server.sent('sfuRenegotiate')).toHaveLength(1);
    expect(audio.add.mock.calls.map((c) => c[0])).toEqual(['bob']);
    const asksForA = () => server.sent('sfuPull').filter((r) => r.data.tracks.some((x) => x.sessionId === 'sa')).length;
    for (let i = 0; i < PULL_RETRY_MAX + 2; i++) await settle(1000);
    expect(asksForA()).toBe(PULL_RETRY_MAX);
    // never given up (review of #434: a publisher Cloudflare lost is made
    // pullable again by a new session; the slow tries catch a late heal)
    await settle(PULL_SLOW_RETRY_MS * 3);
    expect(asksForA()).toBe(PULL_RETRY_MAX + 3);
    // not while the member is reconnecting
    t.onMember(server.member('reconnecting', { ...A, state: 'reconnecting' }, { rev: 2 }));
    await settle(PULL_SLOW_RETRY_MS * 3);
    expect(asksForA()).toBe(PULL_RETRY_MAX + 3);
    t.onMember(server.member('resumed', A, { rev: 3 }));
    await settle();
    expect(asksForA()).toBe(PULL_RETRY_MAX + 4);
  });

  it('blocked / not_in_room / own_track / too_many_pulls / no_result: no retry until the roster changes', async () => {
    for (const code of ['blocked', 'not_in_room', 'own_track', 'too_many_pulls', 'no_result']) {
      const { t, server } = setup();
      server.script('sfuPull', (data) => ({ requiresImmediateRenegotiation: false, offer: null, tracks: data.tracks.map((x) => ({ ...x, username: null, mid: null, errorCode: code, errorDescription: null })) }));
      t.start();
      t.onRoster(server.roster([A]));
      await settle(5000);
      expect(server.sent('sfuPull')).toHaveLength(1);
      t.onMember(server.member('session', { ...A }, { rev: 5 }));
      await settle();
      expect(server.sent('sfuPull')).toHaveLength(2);
      t.stop();
    }
  });

  it('duplicate naming a mid I do not use: that mid is closed by force, then pulled again', async () => {
    const { t, server } = setup();
    server.once('sfuPull', (data) => ({ requiresImmediateRenegotiation: false, offer: null, tracks: data.tracks.map((x) => ({ ...x, username: 'alice', mid: null, errorCode: 'duplicate', errorDescription: 'already pulled as mid 7' })) }));
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const force = server.sent('sfuClose').find((r) => r.data.force);
    expect(force.data.mids).toEqual(['7']);
    expect(server.sent('sfuPull')).toHaveLength(2);
    expect(t.members()[0].pulled).toBe(true);
  });
});

describe('step 6: close', () => {
  it('a member left: its pull closes negotiated (transceiver stopped, my offer, the answer), audio gone at once', async () => {
    const { t, server, audio, pc } = setup();
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    const aliceMid = t.session.pulls.get('alice').mid;
    t.onMember(server.member('left', A, { rev: 2 }));
    expect(audio.remove).toHaveBeenCalledWith('alice');
    await settle();
    const close = server.last('sfuClose');
    expect(close.data).toMatchObject({ mids: [aliceMid] });
    expect(close.data.offer.type).toBe('offer');
    expect(close.data.force).toBeUndefined();
    expect(pc().transceivers.find((x) => x.mid === aliceMid).stopped).toBe(true);
    expect(pc().log.at(-1)).toEqual(['setRemote', 'answer']);
    expect(t.session.pulls.has('alice')).toBe(false);
    expect(t.session.pulls.has('bob')).toBe(true);
  });

  it('a failed negotiated close rolls back and closes by force', async () => {
    const { t, server, pc } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    server.fail('sfuClose', 'cloudflare_error');
    t.onMember(server.member('left', A, { rev: 2 }));
    await settle();
    const closes = server.sent('sfuClose');
    expect(closes).toHaveLength(2);
    expect(closes[1].data.force).toBe(true);
    expect(pc().log).toContainEqual(['setLocal', 'rollback']);
  });

  it('a new pair (another session) closes the old pull and pulls the new track; the same pair does nothing', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    t.onMember(server.member('session', { ...A }, { rev: 2 }));
    await settle();
    expect(server.sent('sfuClose')).toHaveLength(0);
    expect(server.sent('sfuPull')).toHaveLength(1);
    t.onMember(server.member('published', { ...A, sessionId: 'sa2' }, { rev: 3 }));
    await settle();
    expect(server.sent('sfuClose')).toHaveLength(1);
    expect(server.last('sfuPull').data.tracks).toEqual([{ sessionId: 'sa2', trackName: 'mic' }]);
  });

  it('unpublished (trackName null) closes; reconnecting keeps the pull', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    t.onMember(server.member('reconnecting', { ...A, state: 'reconnecting' }, { rev: 2 }));
    await settle();
    expect(server.sent('sfuClose')).toHaveLength(0);
    t.onMember(server.member('resumed', { ...A }, { rev: 3 }));
    await settle();
    expect(server.sent('sfuClose')).toHaveLength(0);
    expect(server.sent('sfuPull')).toHaveLength(1);
    t.onMember(server.member('unpublished', { ...B, trackName: null }, { rev: 4 }));
    await settle();
    expect(server.sent('sfuClose')).toHaveLength(1);
  });
});

describe('step 7: roster events', () => {
  it('an upsert by username; old revs and other bootIds ignored', async () => {
    const { t, server } = setup();
    t.onRoster(server.roster([QUIET], { rev: 5 }));
    t.onMember(server.member('joined', A, { rev: 4 }));
    expect(t.members().map((m) => m.username)).toEqual(['carol']);
    t.onMember(server.member('joined', A, { rev: 6, bootId: 'other' }));
    expect(t.members().map((m) => m.username)).toEqual(['carol']);
    t.onMember(server.member('joined', A, { rev: 6 }));
    t.onMember(server.member('published', { ...QUIET, sessionId: 'sc', trackName: 'mic' }, { rev: 7 }));
    expect(t.members()).toEqual([
      { username: 'carol', state: 'live', publishing: true, pulled: false },
      { username: 'alice', state: 'live', publishing: true, pulled: false },
    ]);
    t.onMember(server.member('left', QUIET, { rev: 8 }));
    expect(t.members().map((m) => m.username)).toEqual(['alice']);
  });
});

describe('step 8: errors', () => {
  it('session_gone: the PeerConnection closes, a new session, pushed again, everyone pulled again', async () => {
    const { t, server, state, pc } = setup({ mic: micTrack() });
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    pc().setState('connected');
    await settle();
    const first = t.session;
    server.fail('sfuClose', 'session_gone', { status: 410 });
    t.onMember(server.member('left', B, { rev: 2 }));
    await settle();
    pc().setState('connected');
    await settle();
    expect(first.pc.connectionState).toBe('closed');
    expect(t.session).not.toBe(first);
    expect(server.sent('sfuSession')).toHaveLength(2);
    expect(server.sent('sfuPush')).toHaveLength(2);
    expect(server.last('sfuPull').data.sessionId).toBe(t.session.sessionId);
    expect(server.last('sfuPull').data.tracks).toEqual([{ sessionId: 'sa', trackName: 'mic' }]);
    expect(state.mic).toBeTruthy();
  });

  it('superseded: the work is dropped (no retry)', async () => {
    const { t, server } = setup();
    server.fail('sfuPull', 'superseded');
    t.start();
    t.onRoster(server.roster([A]));
    await settle(5000);
    expect(classifyError({ error: { code: 'superseded' } })).toBe('drop');
    // the next roster change asks again
    t.onMember(server.member('session', A, { rev: 2 }));
    await settle();
    expect(server.sent('sfuPull').length).toBeGreaterThanOrEqual(2);
  });

  it('not_your_session: the session is registered on this socket (sfuResume) and the work goes on', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    const sid = t.session.sessionId;
    t.onRoster(server.roster([A, B], { rev: 2, self: { sessionId: sid, trackName: null, state: 'live' } }));
    await settle();
    expect(server.sent('sfuResume')).toHaveLength(0);
    server.fail('sfuClose', 'not_your_session');
    t.onMember(server.member('left', B, { rev: 3 }));
    await settle();
    expect(server.last('sfuResume').data.sessionId).toBe(sid);
    expect(server.sent('sfuClose').length).toBeGreaterThanOrEqual(2);
    expect(t.session.sessionId).toBe(sid);
  });

  it('not_in_room: SFU voice pauses until the next sfuRoster', async () => {
    const { t, server } = setup();
    server.fail('sfuSession', 'not_in_room');
    t.start();
    t.onRoster(server.roster([A]));
    await settle(10000);
    expect(server.sent('sfuSession')).toHaveLength(1);
    t.onMember(server.member('joined', B, { rev: 2 }));
    await settle(10000);
    expect(server.sent('sfuSession')).toHaveLength(1);
    t.onRoster(server.roster([A, B], { rev: 3 }));
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(2);
  });

  it('rate_limited / busy / timeout / cloudflare_unreachable / retryable cloudflare_error: backoff 0.5, 1, 2, 4 s (at least retryAfterMs)', async () => {
    const { t, server } = setup();
    for (let i = 0; i < 5; i++) server.fail('sfuSession', ['rate_limited', 'busy', 'timeout', 'cloudflare_unreachable', 'cloudflare_error'][i], { retryable: true, retryAfterMs: i === 0 ? 1500 : null });
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const at = () => server.sent('sfuSession').map((r) => r.at);
    expect(at()).toHaveLength(1);
    await settle(1499);
    expect(at()).toHaveLength(1); // retryAfterMs 1500 beats the first step (500)
    await settle(1);
    expect(at()).toHaveLength(2);
    await settle(1000);
    expect(at()).toHaveLength(3);
    await settle(2000);
    expect(at()).toHaveLength(4);
    await settle(4000);
    expect(at()).toHaveLength(5);
    await settle(4000);
    expect(at()).toHaveLength(6);
    expect(t.session).toBeTruthy();
  });

  it('invalid / unavailable on sfuSession: never asked again until the next roster', async () => {
    for (const code of ['invalid', 'unavailable']) {
      const { t, server } = setup();
      server.fail('sfuSession', code);
      t.start();
      t.onRoster(server.roster([A]));
      await settle(20000);
      expect(server.sent('sfuSession')).toHaveLength(1);
      t.stop();
    }
  });

  it('bad_token on a resume: a new session, never that resume again', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const first = t.session;
    server.socket.id = 'sock-2';
    server.fail('sfuResume', 'bad_token');
    t.onRoster(server.roster([A], { rev: 2, self: { sessionId: first.sessionId, trackName: null, state: 'reconnecting' } }));
    await settle();
    expect(server.sent('sfuResume')).toHaveLength(1);
    expect(first.pc.connectionState).toBe('closed');
    expect(server.sent('sfuSession')).toHaveLength(2);
  });

  it('no reply within 12 s: retried after a backoff; the late reply is ignored by its requestId', async () => {
    const { t, server } = setup();
    server.once('sfuSession', () => null);
    t.start();
    t.onRoster(server.roster([A]));
    await settle(REPLY_TIMEOUT_MS - 1);
    expect(server.sent('sfuSession')).toHaveLength(1);
    await settle(1);
    await settle(600);
    expect(server.sent('sfuSession')).toHaveLength(2);
    const sessionNow = t.session;
    expect(sessionNow.sessionId).toBe('sess1');
    // the first request's reply comes now: ignored (no second PeerConnection)
    server.release(0, { sessionId: 'late', sessionToken: 'late' });
    await settle();
    expect(t.session).toBe(sessionNow);
    expect(FakeSfuPC.all).toHaveLength(1);
  });

  it('a disconnected socket sends nothing (socket.io would deliver it on the next socket)', async () => {
    const { t, server } = setup();
    server.socket.isConnected = false;
    t.start();
    t.onRoster(server.roster([A]));
    await settle(10000);
    expect(server.socket.emit).not.toHaveBeenCalled();
  });
});

describe('step 9: media drops', () => {
  async function connectedPublisher() {
    const env = setup({ mic: micTrack() });
    env.t.start();
    env.t.onRoster(env.server.roster([A]));
    await settle();
    env.pc().setState('connected');
    await settle();
    return env;
  }

  it('the first disconnected does nothing; healed within 2 s nothing at all', async () => {
    const { server, pc } = await connectedPublisher();
    pc().setState('disconnected');
    await settle(1900);
    pc().setState('connected');
    await settle(5000);
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    expect(server.sent('sfuSession')).toHaveLength(1);
  });

  it('still disconnected after 2 s: an ICE restart on the same session (restartIce, iceRestart offer, the answer)', async () => {
    const { t, server, pc } = await connectedPublisher();
    const s = t.session;
    pc().setState('disconnected');
    await settle(2000);
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
    expect(pc().restarts).toBe(1);
    expect(pc().offerOpts.at(-1)).toEqual({ iceRestart: true });
    pc().setState('connected');
    await settle();
    expect(t.session).toBe(s);
    expect(s.recover).toBe(false);
    expect(server.sent('sfuSession')).toHaveLength(1);
  });

  it('failed: at once; two restarts that never connect: a new session', async () => {
    const { t, server, pc } = await connectedPublisher();
    const s = t.session;
    pc().setState('failed');
    await settle();
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
    await settle(6000);
    expect(server.sent('sfuIceRestart')).toHaveLength(2);
    await settle(6000);
    expect(s.pc.connectionState).toBe('closed');
    expect(t.session).not.toBe(s);
    expect(server.sent('sfuSession')).toHaveLength(2);
    expect(server.sent('sfuPush')).toHaveLength(2);
  });

  it('a failed restart request rolls its offer back', async () => {
    const { server, pc } = await connectedPublisher();
    server.fail('sfuIceRestart', 'cloudflare_error');
    pc().setState('failed');
    await settle();
    expect(pc().log).toContainEqual(['setLocal', 'rollback']);
  });

  it(`away ${ICE_RESTART_MAX_AWAY_MS / 1000} s or more: a new session, no ICE restart`, async () => {
    const { t, server, pc } = await connectedPublisher();
    const s = t.session;
    // the 2 s timer is the only clock: a page asleep for 30 s wakes late
    s.downSince = Date.now() - 30000;
    pc().setState('failed');
    await settle();
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    expect(t.session).not.toBe(s);
    expect(server.sent('sfuSession')).toHaveLength(2);
  });

  it('a session that pushed nothing recovers with a new session (the restart form needs my track)', async () => {
    const { t, server, pc } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    pc().setState('connected');
    const s = t.session;
    pc().setState('failed');
    await settle();
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    expect(t.session).not.toBe(s);
    expect(server.last('sfuPull').data.sessionId).toBe(t.session.sessionId);
  });

  it('no_local_track from the server: a new session', async () => {
    const { t, server, pc } = await connectedPublisher();
    const s = t.session;
    server.fail('sfuIceRestart', 'no_local_track');
    pc().setState('failed');
    await settle();
    expect(t.session).not.toBe(s);
  });

  it(`a new session not connected ${CONNECT_TIMEOUT_MS / 1000} s after its first negotiation: a new session (no ICE restart); connected in time: nothing`, async () => {
    const { t, server, pc } = setup({ mic: micTrack() });
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const first = t.session;
    await settle(CONNECT_TIMEOUT_MS - 100);
    expect(t.session).toBe(first);
    await settle(200);
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    expect(first.pc.connectionState).toBe('closed');
    expect(t.session).not.toBe(first);
    pc().setState('connected');
    await settle(CONNECT_TIMEOUT_MS * 3);
    expect(server.sent('sfuSession')).toHaveLength(2);
  });

  it('a drop that healed by itself while the socket was away: no ICE restart once the room is back', async () => {
    const { t, server, pc, win } = await connectedPublisher();
    const s = t.session;
    const mid = s.pulls.get('alice').mid;
    let n = 0;
    const flow = setInterval(() => { n += 100; pc().bytes[mid] = n; }, 200);
    await settle(1000);
    clearInterval(flow);
    server.socket.isConnected = false;
    server.socket.id = null;
    win.dispatchEvent(new Event('offline'));
    await settle(4000);
    // the network is back (a forced recovery, ICE still says connected); the socket comes back later
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(s.recover).toBe(true);
    const flow2 = setInterval(() => { n += 100; pc().bytes[mid] = n; }, 200);
    await settle(3000);
    server.socket.isConnected = true;
    server.socket.id = 'sock-2';
    t.onRoster(server.roster([A], { rev: 5, self: { sessionId: s.sessionId, trackName: 'mic', state: 'reconnecting' } }));
    await settle(1000);
    clearInterval(flow2);
    expect(server.sent('sfuResume')).toHaveLength(1);
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    expect(t.session).toBe(s);
    expect(s.recover).toBe(false);
  });

  it('the online event recovers at once (an ICE restart while connected says nothing yet)', async () => {
    const { server, win } = await connectedPublisher();
    win.dispatchEvent(new Event('offline'));
    await settle(3000);
    win.dispatchEvent(new Event('online'));
    await settle();
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
  });
});

describe('step 10: the downlink stall detector', () => {
  it('connected, every pulled track silent for 2 s: an ICE restart, at most once per 10 s', async () => {
    const { t, server, pc, state } = setup({ mic: micTrack() });
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    pc().setState('connected');
    await settle();
    const [ma, mb] = ['alice', 'bob'].map((u) => t.session.pulls.get(u).mid);
    let n = 0;
    const flow = setInterval(() => { n += 100; pc().bytes[ma] = n; pc().bytes[mb] = n; }, 200);
    await settle(5000);
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    clearInterval(flow);
    await settle(2600);
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
    expect(t.session.pc).toBe(pc());
    await settle(5000);
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
    await settle(STALL_COOLDOWN_MS);
    expect(server.sent('sfuIceRestart')).toHaveLength(2);
    expect(state.mic).toBeTruthy();
  });

  it('one track still flowing: no stall; a reconnecting member is not counted', async () => {
    const { t, server, pc } = setup({ mic: micTrack() });
    t.start();
    t.onRoster(server.roster([A, B]));
    await settle();
    pc().setState('connected');
    await settle();
    const [ma, mb] = ['alice', 'bob'].map((u) => t.session.pulls.get(u).mid);
    pc().bytes[ma] = 100;
    pc().bytes[mb] = 100;
    await settle(600);
    let n = 100;
    const flow = setInterval(() => { n += 100; pc().bytes[mb] = n; }, 200);
    await settle(6000);
    expect(server.sent('sfuIceRestart')).toHaveLength(0);
    clearInterval(flow);
    // bob reconnects (his media stops): alice alone is watched
    t.onMember(server.member('reconnecting', { ...B, state: 'reconnecting' }, { rev: 2 }));
    await settle(600);
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
  });
});

describe('step 11: a socket reconnect resumes the session', () => {
  it('the new socket\'s roster lists my session reconnecting: sfuResume at once with my track and pulls', async () => {
    const { t, server, pc } = setup({ mic: micTrack() });
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    pc().setState('connected');
    await settle();
    const s = t.session;
    server.socket.isConnected = false;
    server.socket.id = null;
    await settle(5000);
    server.socket.isConnected = true;
    server.socket.id = 'sock-2';
    const before = server.requests.length;
    t.onRoster(server.roster([A], { rev: 9, self: { sessionId: s.sessionId, trackName: 'mic', state: 'reconnecting' } }));
    await settle();
    const next = server.requests.slice(before);
    expect(next[0].event).toBe('sfuResume');
    expect(next[0].data).toEqual({
      requestId: expect.any(String),
      sessionId: s.sessionId,
      sessionToken: s.token,
      trackName: 'mic',
      mid: s.published.mid,
      pulls: [{ mid: s.pulls.get('alice').mid, sessionId: 'sa', trackName: 'mic' }],
    });
    expect(t.session).toBe(s);
    expect(next.filter((r) => r.event === 'sfuPull' || r.event === 'sfuSession')).toHaveLength(0);
  });

  it('a PeerConnection that failed meanwhile: a new session instead', async () => {
    const { t, server, pc } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const s = t.session;
    server.socket.id = 'sock-2';
    s.pc.connectionState = 'failed';
    t.onRoster(server.roster([A], { rev: 2, self: { sessionId: s.sessionId, trackName: null, state: 'reconnecting' } }));
    await settle();
    expect(server.sent('sfuResume')).toHaveLength(0);
    expect(server.sent('sfuSession')).toHaveLength(2);
    expect(pc()).not.toBe(s.pc);
  });

  it('the same bootId with self.sessionId null: the server dropped it (the grace ran out): pc.close, a new session, never a resume', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const s = t.session;
    server.socket.id = 'sock-2';
    t.onRoster(server.roster([A], { rev: 2, self: { sessionId: null, trackName: null, state: 'live' } }));
    await settle();
    expect(server.sent('sfuResume')).toHaveLength(0);
    expect(s.pc.connectionState).toBe('closed');
    expect(server.sent('sfuSession')).toHaveLength(2);
  });

  it('requests wait while the socket is gone (no roster of this socket yet)', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    server.socket.id = 'sock-2';
    const before = server.requests.length;
    t.onMember(server.member('joined', B, { rev: 2 }));
    await settle(10000);
    expect(server.requests.length).toBe(before);
  });
});

describe('step 12: a server restart (a new bootId)', () => {
  it('resumes the SAME session and holds the pulls of members missing or with no session for 20 s', async () => {
    const { t, server, pc } = setup({ mic: micTrack() });
    t.start();
    t.onRoster(server.roster([A, B], { bootId: 'boot1' }));
    await settle();
    pc().setState('connected');
    const s = t.session;
    server.socket.id = 'sock-2';
    // the new process: nobody registered yet
    t.onRoster(server.roster([], { bootId: 'boot2', rev: 1, self: { sessionId: null, trackName: null, state: 'live' } }));
    await settle();
    expect(server.last('sfuResume').data.sessionId).toBe(s.sessionId);
    expect(t.session).toBe(s);
    t.onMember(server.member('joined', { username: 'alice', sessionId: null, trackName: null }, { rev: 2, bootId: 'boot2' }));
    t.onMember(server.member('session', A, { rev: 3, bootId: 'boot2' }));
    await settle(BOOT_HOLD_MS - 1000);
    expect(server.sent('sfuClose')).toHaveLength(0);
    expect(server.sent('sfuPull')).toHaveLength(1);
    expect(s.pulls.has('bob')).toBe(true);
    // bob never came back: after the hold his pull closes
    await settle(2000);
    expect(server.sent('sfuClose')).toHaveLength(1);
    expect(s.pulls.has('bob')).toBe(false);
    expect(s.pulls.has('alice')).toBe(true);
  });
});

describe('step 13: leaving', () => {
  it('stop: sfuLeave (best effort) then pc.close; never on a socket drop', async () => {
    const { t, server, audio } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const s = t.session;
    server.socket.isConnected = false;
    await settle(5000);
    expect(server.sent('sfuLeave')).toHaveLength(0);
    server.socket.isConnected = true;
    t.stop();
    expect(server.sent('sfuLeave')).toHaveLength(1);
    expect(server.last('sfuLeave').data.sessionId).toBe(s.sessionId);
    expect(s.pc.connectionState).toBe('closed');
    expect(audio.remove).toHaveBeenCalledWith('alice');
    expect(t.session).toBe(null);
    // the roster stays: voice can start again on the next arrival
    expect(t.hasCompany()).toBe(true);
    await settle(5000);
    expect(server.sent('sfuSession')).toHaveLength(1);
  });

  it('pagehide sends sfuLeave and makes nothing new while the page unloads', async () => {
    const { t, server, win } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    win.dispatchEvent(new Event('pagehide'));
    await settle(3000);
    expect(server.sent('sfuLeave')).toHaveLength(1);
    expect(server.sent('sfuSession')).toHaveLength(1);
  });

  it('exitRoom forgets the room', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    t.stop();
    t.exitRoom();
    expect(t.mode).toBe(null);
    expect(t.hasCompany()).toBe(false);
    expect(t.members()).toEqual([]);
  });
});

describe('review of #434', () => {
  async function connectedPublisher(members = [A]) {
    const env = setup({ mic: micTrack() });
    env.t.start();
    env.t.onRoster(env.server.roster(members));
    await settle();
    env.pc().setState('connected');
    await settle();
    return env;
  }

  it('stop() while an ICE restart waits for connected frees the loop: the next tournament makes a session', async () => {
    const { t, server, pc } = await connectedPublisher();
    pc().setState('failed');
    await settle();
    expect(server.sent('sfuIceRestart')).toHaveLength(1);
    // waiting up to 6 s for connected: the screen is left
    t.stop();
    t.exitRoom();
    await settle(20000);
    expect(t._busy).toBe(false);
    const before = server.sent('sfuSession').length;
    t.enterRoom();
    t.start();
    t.onRoster(server.roster([B], { tournamentId: 't2', rev: 1 }));
    await settle();
    expect(server.sent('sfuSession').length - before).toBe(1);
    pc().setState('connected');
    await settle();
    expect(server.last('sfuPull').data.tracks).toEqual([{ sessionId: 'sb', trackName: 'mic' }]);
  });

  it(`a loop step stuck past ${BUSY_STUCK_MS / 1000} s is freed (logged), never SFU voice dead for the page`, async () => {
    const { t, server } = setup();
    const step = t._step.bind(t);
    let hung = true;
    t._step = () => (hung ? new Promise(() => {}) : step());
    t.start();
    t.onRoster(server.roster([A]));
    await settle(BUSY_STUCK_MS - 1000);
    hung = false;
    t.onMember(server.member('joined', B, { rev: 2 }));
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(0);
    await settle(2000);
    t.onMember(server.member('joined', { username: 'dan', sessionId: 'sd', trackName: 'mic' }, { rev: 3 }));
    await settle();
    expect(server.sent('sfuSession')).toHaveLength(1);
    expect(server.sent('sfuPull')).toHaveLength(1);
  });

  it('a pull offer the browser refuses: no member left asking; its mids closed by force and pulled again', async () => {
    const { t, server, audio } = setup();
    t.start();
    FakeSfuPC.failRemote = true;
    t.onRoster(server.roster([A]));
    await settle();
    expect(server.sent('sfuPull')).toHaveLength(1);
    const firstMid = server.requests.length && t.session.byMid.size === 0;
    expect(firstMid).toBe(true);
    expect(t.session.pulls.has('alice')).toBe(false);
    await settle(1000);
    const force = server.sent('sfuClose').find((r) => r.data.force);
    expect(force.data.mids).toEqual(['100']);
    expect(server.sent('sfuPull')).toHaveLength(2);
    expect(t.session.pulls.get('alice')).toMatchObject({ mid: '101', asking: false });
    expect(audio.add).toHaveBeenCalledWith('alice', expect.anything(), { mid: '101' });
  });

  it('a step that throws leaves no pull asking (the loop catch)', async () => {
    const { t, server } = setup();
    t.start();
    t.onRoster(server.roster([A]));
    await settle();
    const s = t.session;
    s.pulls.set('bob', { sessionId: 'sb', trackName: 'mic', mid: null, asking: true });
    s.byMid.set('42', 'bob');
    t._abandonAsks();
    expect(s.pulls.has('bob')).toBe(false);
    expect(s.byMid.has('42')).toBe(false);
    expect(s.closeBacklog).toEqual(['42']);
    expect(s.pulls.get('alice').mid).toBeTruthy();
  });

  it('a request in flight when the socket drops: the resume goes within one tick of the new roster (disconnect hook)', async () => {
    const { t, server } = await connectedPublisher();
    const sid = t.session.sessionId;
    server.autoReply = false;
    t.onMember(server.member('joined', B, { rev: 2 }));
    await settle();
    expect(server.held.map((h) => h.event)).toEqual(['sfuPull']);
    server.socket.isConnected = false;
    t.onSocketDisconnect();
    await settle(500);
    server.socket.id = 'sock-2';
    server.socket.isConnected = true;
    server.autoReply = true;
    t.onRoster(server.roster([A, B], { rev: 3, self: { sessionId: sid, trackName: 'mic', state: 'reconnecting' } }));
    await settle();
    expect(server.sent('sfuResume')).toHaveLength(1);
    expect(t.session.sessionId).toBe(sid);
  });

  it('... and with no disconnect hook: the new socket\'s roster fails the old requests itself', async () => {
    const { t, server } = await connectedPublisher();
    const sid = t.session.sessionId;
    server.autoReply = false;
    t.onMember(server.member('joined', B, { rev: 2 }));
    await settle();
    server.socket.isConnected = false;
    await settle(500);
    server.socket.id = 'sock-2';
    server.socket.isConnected = true;
    server.autoReply = true;
    t.onRoster(server.roster([A, B], { rev: 3, self: { sessionId: sid, trackName: 'mic', state: 'reconnecting' } }));
    await settle();
    expect(server.sent('sfuResume')).toHaveLength(1);
  });

  it('a pull refused for good (too_many_pulls) does not outlive its session: a new session pulls that member again', async () => {
    const { t, server } = setup();
    t.start();
    server.once('sfuPull', (data, def) => { const d = def(); d.tracks = d.tracks.map((x) => ({ ...x, mid: null, errorCode: 'too_many_pulls' })); d.offer = null; return d; });
    t.onRoster(server.roster([A]));
    await settle(1000);
    const s1 = t.session;
    expect(server.sent('sfuPull')).toHaveLength(1);
    t._closeSession(s1, { leave: false });
    await settle(1000);
    expect(t.session).not.toBe(s1);
    expect(t.session).toBeTruthy();
    expect(server.sent('sfuPull')).toHaveLength(2);
    expect(t.session.pulls.get('alice').mid).toBeTruthy();
  });

  it('an sfuSession answered after the room became a mesh: no PeerConnection, the session let go', async () => {
    const { t, server } = setup();
    t.start();
    server.autoReply = false;
    t.onRoster(server.roster([A]));
    await settle();
    expect(server.held.map((h) => h.event)).toEqual(['sfuSession']);
    t.onMeshEvent();
    server.autoReply = true;
    server.release(0);
    await settle(100);
    expect(t.mode).toBe('mesh');
    expect(t.session).toBe(null);
    expect(FakeSfuPC.all).toHaveLength(0);
    expect(server.last('sfuLeave').data.sessionId).toBe('sess1');
  });

  it('the same socket and bootId list my session as gone (the server ended it): pc.close, a new session, pushed again', async () => {
    const { t, server, pc } = await connectedPublisher([A]);
    const s = t.session;
    expect(server.sent('sfuPush')).toHaveLength(1);
    t.onRoster(server.roster([A], { rev: 7, self: { sessionId: null, trackName: null, state: 'live' } }));
    await settle();
    expect(s.pc.connectionState).toBe('closed');
    expect(t.session).not.toBe(s);
    expect(server.sent('sfuResume')).toHaveLength(0);
    expect(server.sent('sfuSession')).toHaveLength(2);
    expect(server.sent('sfuPush')).toHaveLength(2);
    pc().setState('connected');
    await settle();
    expect(server.last('sfuPull').data.sessionId).toBe(t.session.sessionId);
    // a relisted roster that still names my session changes nothing
    const s2 = t.session;
    t.onRoster(server.roster([A], { rev: 8, self: { sessionId: s2.sessionId, trackName: 'mic', state: 'live' } }));
    await settle();
    expect(t.session).toBe(s2);
  });

  it('a pull Cloudflare did not answer in time (timeout), or a 406 invalid_session_description: a new session at once, everyone pulled again', async () => {
    for (const [code, extra] of [['timeout', { retryable: true, retryAfterMs: 1000 }], ['cloudflare_error', { retryable: true, retryAfterMs: 1000, status: 406, cfCode: 'invalid_session_description' }]]) {
      const { t, server } = setup();
      server.fail('sfuPull', code, extra);
      t.start();
      t.onRoster(server.roster([A]));
      await settle();
      const first = FakeSfuPC.all.at(-2);
      expect(first.connectionState).toBe('closed');
      expect(server.sent('sfuSession')).toHaveLength(2);
      expect(server.sent('sfuPull')).toHaveLength(2);
      expect(server.last('sfuPull').data.sessionId).toBe(t.session.sessionId);
      expect(t.session.pulls.get('alice').mid).toBeTruthy();
      t.stop();
      FakeSfuPC.reset();
    }
  });
});
