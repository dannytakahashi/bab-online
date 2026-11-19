/**
 * VoiceChatManager's talk mode on the FALLBACK path (a browser with no
 * AudioContext destination, as this file's fake: no silent sender track;
 * the silent-track path, the muted start, is mutedStart.test.js;
 * docs/claude/voice.md): listen-only sessions (no
 * microphone, recvonly offers, answers without a track), a refused
 * microphone falls back to listen-only and still flushes, the mode a
 * voiceSettings sets during the microphone prompt wins, setTalk re-offers
 * every call (a call waiting for its answer after it), per-person mute and
 * volume survive a re-created call, and a blocked autoplay re-arms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceChatManager, REOFFER_DELAY_MS, AUDIO_POOL_SIZE } from './VoiceChatManager.js';
import { CLIENT_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';

const TURN = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: true, expiresInSec: 4 * 3600 };

class FakePC {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.tracks = [];
    this.transceivers = [];
    FakePC.all.push(this);
  }
  addTrack(t) { this.tracks.push(t); }
  addTransceiver(kind, init = {}) { this.transceivers.push({ kind, ...init }); }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    if (this.signalingState !== 'closed') this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    if (this.signalingState !== 'closed') this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  getSenders() { return []; }
  getConfiguration() { return { ...this.config }; }
  setConfiguration(c) { this.config = c; }
  close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
}
FakePC.all = [];

function fakeSocketManager(id = 'sock-a') {
  const sent = [];
  return {
    id,
    sent,
    emit: vi.fn((event, data) => sent.push({ event, data })),
    requests: () => sent.filter((s) => s.event === CLIENT_EVENTS.GET_VOICE_ICE_SERVERS),
    offers: () => sent.filter((s) => s.event === CLIENT_EVENTS.VOICE_OFFER),
    answers: () => sent.filter((s) => s.event === CLIENT_EVENTS.VOICE_ANSWER),
  };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const OFFER = { type: 'offer', sdp: 'v=0 offer' };
const ANSWER = { type: 'answer', sdp: 'v=0 answer' };

let tracks;
function newStream() {
  const track = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({}) };
  tracks.push(track);
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = [];
  tracks = [];
  getGameState().username = 'alice';
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('RTCSessionDescription', function RTCSessionDescription(d) { return d; });
  vi.stubGlobal('RTCIceCandidate', function RTCIceCandidate(c) { return c; });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => newStream()) } });
  // jsdom has no media playback: play() resolves (the autoplay test refuses it)
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  const node = () => ({ connect() {}, disconnect() {} });
  window.AudioContext = function AudioContext() {
    return {
      state: 'running',
      createMediaStreamSource: node,
      createAnalyser: () => ({ ...node(), fftSize: 256, getFloatTimeDomainData() {} }),
      close: async () => {},
    };
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.AudioContext;
  getGameState().username = null;
});

/** initialize() with the server answering TURN (opts.talk: start with the microphone; default muted). */
async function start(vm, sm, opts) {
  const p = vm.initialize(sm, opts);
  await flush();
  const req = sm.requests().at(-1);
  if (req) vm.onIceServers({ ...TURN, requestId: req.data.requestId });
  await flush();
  await p;
}

/** The remote stream arrives on a peer's current connection. */
function track(vm, id) {
  const pc = vm.peers.get(id).connection;
  pc.ontrack({ streams: [{ id: `stream-${id}` }] });
  return vm.peers.get(id).audioEl;
}

describe('listen-only', () => {
  it('asks for no microphone; an offer receives only (recvonly transceiver), an answer adds no track', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.setTalk(false); // before the start: only the mode (voiceSettings arrived first)
    await start(vm, sm);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(vm.active).toBe(true);
    expect(vm.isListenOnly()).toBe(true);
    expect(vm.isTalking()).toBe(false);

    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all[0].transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    expect(FakePC.all[0].tracks).toEqual([]);
    expect(sm.offers()).toHaveLength(1);

    await vm.handleOffer('sock-c', OFFER, 'cat');
    expect(FakePC.all[1].tracks).toEqual([]);
    expect(FakePC.all[1].transceivers).toEqual([]);
    expect(sm.answers()).toHaveLength(1);
    vm.shutdown();
  });

  it('a refused microphone: listen-only, the session starts and flushes what was buffered', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); });
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const modes = [];
    vm.onModeChange((m) => modes.push(m));
    // buffered before the start (inactive)
    await vm.connectToPeer('sock-b', 'bob');
    await vm.handleOffer('sock-c', OFFER, 'cat');
    expect(FakePC.all).toHaveLength(0);
    await start(vm, sm, { talk: true });
    await flush();
    expect(vm.active).toBe(true);
    expect(vm.micDenied).toBe(true);
    expect(vm.isListenOnly()).toBe(true);
    expect(modes.at(-1)).toEqual({ talking: false, micDenied: true });
    // the offer was answered, the peer was offered to (listen-only)
    expect(sm.answers().map((a) => a.data.targetSocketId)).toEqual(['sock-c']);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-b']);
    expect(vm.peers.get('sock-b').connection.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    vm.shutdown();
    // a new session starts muted again, asking nothing until an unmute
    expect(vm.micDenied).toBe(false);
    expect(vm.wantsTalk).toBe(false);
  });

  it('a voiceSettings during the microphone prompt: the latest mode wins (the granted mic is released)', async () => {
    let grant;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { grant = r; }));
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const p = vm.initialize(sm, { talk: true });
    await flush();
    vm.onIceServers({ ...TURN, requestId: sm.requests().at(-1).data.requestId });
    await vm.setTalk(false); // the prompt is still up
    grant(newStream());
    await flush();
    await p;
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(vm.isListenOnly()).toBe(true);
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all[0].transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    vm.shutdown();
  });

  it('and the other way: talk wanted while a listen-only start waits for its ICE servers asks for the mic', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.setTalk(false);
    const p = vm.initialize(sm);
    await flush();
    await vm.setTalk(true);
    vm.onIceServers({ ...TURN, requestId: sm.requests().at(-1).data.requestId });
    await flush();
    await p;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vm.isTalking()).toBe(true);
    vm.shutdown();
  });
});

describe('setTalk on a running session', () => {
  it('re-offers every call in the new mode; a call waiting for its answer is re-offered after it', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    expect(vm.isTalking()).toBe(true);
    await vm.connectToPeer('sock-b', 'bob'); // stays have-local-offer
    await vm.connectToPeer('sock-c', 'cat');
    await vm.handleAnswer('sock-c', ANSWER);
    expect(vm.peers.get('sock-b').connection.signalingState).toBe('have-local-offer');
    expect(vm.peers.get('sock-c').connection.signalingState).toBe('stable');
    sm.sent.length = 0;

    expect(await vm.setTalk(false)).toBe(false);
    // the microphone goes at once
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(vm.localStream).toBeNull();
    expect(sm.offers()).toHaveLength(0); // re-offers wait REOFFER_DELAY_MS
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-c']);
    expect(vm.peers.get('sock-c').connection.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    // b's answer to the old offer lands: now b is re-offered
    await vm.handleAnswer('sock-b', ANSWER);
    await flush();
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-c', 'sock-b']);
    expect(vm.peers.get('sock-b').connection.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);

    // talk again: the microphone comes back and every call is re-offered with it
    sm.sent.length = 0;
    await vm.handleAnswer('sock-b', ANSWER);
    await vm.handleAnswer('sock-c', ANSWER);
    expect(await vm.setTalk(true)).toBe(true);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    expect(sm.offers().map((o) => o.data.targetSocketId).sort()).toEqual(['sock-b', 'sock-c']);
    expect(vm.peers.get('sock-b').connection.tracks).toHaveLength(1);
    // the same mode twice changes nothing
    sm.sent.length = 0;
    await vm.setTalk(true);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    expect(sm.offers()).toHaveLength(0);
    vm.shutdown();
  });

  it('a pending re-offer whose answer never comes goes at the connect timeout', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    await vm.connectToPeer('sock-b', 'bob');
    sm.sent.length = 0;
    await vm.setTalk(false);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    expect(sm.offers()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-b']);
    expect(vm.isUnavailable('sock-b')).toBe(false);
    vm.shutdown();
  });

  it('a call that failed for good ("voice unavailable") is re-offered in the new mode too (a retry)', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-a'); // the lower id: it restarts, then gives up
    await start(vm, sm, { talk: true });
    await vm.connectToPeer('sock-b', 'bob');
    await vm.handleAnswer('sock-b', ANSWER);
    vm.peers.get('sock-b').connection.connectionState = 'failed';
    vm.peers.get('sock-b').connection.onconnectionstatechange();
    await flush();
    await vm.handleAnswer('sock-b', ANSWER); // the restart's offer answered
    vm.peers.get('sock-b').connection.connectionState = 'failed';
    vm.peers.get('sock-b').connection.onconnectionstatechange();
    expect(vm.isUnavailable('sock-b')).toBe(true);
    sm.sent.length = 0;
    await vm.setTalk(false);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-b']);
    expect(vm.peers.get('sock-b').connection.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    vm.shutdown();
  });

  it('a refused microphone on "tap to talk" stays listen-only', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.setTalk(false);
    await start(vm, sm);
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw new Error('denied'); });
    expect(await vm.setTalk(true)).toBe(false);
    expect(vm.micDenied).toBe(true);
    expect(vm.isListenOnly()).toBe(true);
    vm.shutdown();
  });
});

describe('mute and volume across a re-created call', () => {
  it('my mute and volume of a peer survive its replacement offer and my own re-offer', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    await vm.handleOffer('sock-b', OFFER, 'bob');
    track(vm, 'sock-b');
    vm.setPeerVolume('sock-b', 0.5);
    vm.mutePeer('sock-b');
    // the spectator switched modes: its replacement offer
    await vm.handleOffer('sock-b', OFFER, 'bob');
    const el = track(vm, 'sock-b');
    expect(vm.isPeerMuted('sock-b')).toBe(true);
    expect(el.volume).toBe(0);
    vm.unmutePeer('sock-b');
    expect(el.volume).toBe(0.5);
    // my own mode change re-creates it too
    vm.mutePeer('sock-b');
    await vm.setTalk(false);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    const el2 = track(vm, 'sock-b');
    expect(el2).not.toBe(el);
    expect(el2.volume).toBe(0);
    expect(vm.getPeerVolume('sock-b')).toBe(0.5);
    vm.shutdown();
  });
});

describe('autoplay blocked (a page that receives voice before any gesture)', () => {
  it('tells once, plays every call on the next gesture, and re-arms for a re-created call', async () => {
    let allow = false;
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => (allow
      ? Promise.resolve()
      : Promise.reject(Object.assign(new Error('no gesture'), { name: 'NotAllowedError' }))));
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    const blocked = vi.fn();
    vm.onAutoplayBlocked(blocked);
    await vm.handleOffer('sock-b', OFFER, 'bob');
    await vm.handleOffer('sock-c', OFFER, 'cat');
    track(vm, 'sock-b');
    track(vm, 'sock-c');
    await flush();
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(vm.autoplayBlocked).toBe(true);
    allow = true;
    play.mockClear();
    const callEls = [vm.peers.get('sock-b').audioEl, vm.peers.get('sock-c').audioEl];
    document.dispatchEvent(new Event('pointerdown'));
    await flush();
    // every call's element, once (and the unlocked spares)
    expect(play.mock.contexts.filter((el) => callEls.includes(el))).toHaveLength(2);
    expect(vm.autoplayBlocked).toBe(false);
    // a re-created call blocked again: told again
    allow = false;
    await vm.handleOffer('sock-b', OFFER, 'bob');
    track(vm, 'sock-b');
    await flush();
    expect(blocked).toHaveBeenCalledTimes(2);
    vm.shutdown();
    expect(vm.autoplayBlocked).toBe(false);
  });
});

describe('audio unlocked at the first gesture (Safari: a muted start captures no microphone; review 2026-11-18)', () => {
  it('the first pointerdown unlocks every call\'s element and a pool of spares; a replaced call and a new peer reuse unlocked elements', async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play');
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.handleOffer('sock-b', OFFER, 'bob');
    const bEl = track(vm, 'sock-b');
    expect(bEl._voiceUnlocked).toBeFalsy();
    play.mockClear();
    document.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(bEl._voiceUnlocked).toBe(true);
    expect(play.mock.contexts).toContain(bEl);
    const spares = [...document.querySelectorAll('audio')].filter((el) => el !== bEl);
    expect(spares).toHaveLength(AUDIO_POOL_SIZE);
    expect(spares.every((el) => el._voiceUnlocked && play.mock.contexts.includes(el))).toBe(true);
    // only the first gesture (later ones change nothing)
    play.mockClear();
    document.dispatchEvent(new Event('pointerdown'));
    expect(play).not.toHaveBeenCalled();
    // bob's call replaced (a restart or a new offer): the same unlocked element
    await vm.handleOffer('sock-b', OFFER, 'bob');
    expect(vm.peers.get('sock-b').audioEl).toBe(bEl);
    expect(bEl.id).toBe('voice-audio-sock-b');
    // a new peer takes an unlocked spare, not a new (locked) element
    await vm.handleOffer('sock-c', OFFER, 'cat');
    const cEl = vm.peers.get('sock-c').audioEl;
    expect(spares).toContain(cEl);
    expect(cEl.id).toBe('voice-audio-sock-c');
    expect(document.querySelectorAll('audio')).toHaveLength(AUDIO_POOL_SIZE + 1);
    // cat leaves: its element goes back to the pool, nothing added
    vm.removePeer('sock-c');
    expect(cEl.isConnected).toBe(true);
    expect(cEl.id).toBe('');
    expect(document.querySelectorAll('audio')).toHaveLength(AUDIO_POOL_SIZE + 1);
    vm.shutdown();
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });

  it('a refused unlock (no gesture after all) leaves the element locked; a new session arms again', async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(Object.assign(new Error('no gesture'), { name: 'NotAllowedError' })));
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    document.dispatchEvent(new Event('keydown'));
    await flush();
    const els = [...document.querySelectorAll('audio')];
    expect(els).toHaveLength(AUDIO_POOL_SIZE);
    expect(els.some((el) => el._voiceUnlocked)).toBe(false);
    vm.shutdown();
    expect(document.querySelectorAll('audio')).toHaveLength(0);
    // no listener left behind
    document.dispatchEvent(new Event('pointerdown'));
    expect(document.querySelectorAll('audio')).toHaveLength(0);
  });
});

/**
 * Two managers wired through a fake server relay (one sender's signals
 * arrive in order, `latency` ms later), as two spectators in one game.
 */
function pair({ latency = 40 } = {}) {
  const ends = {};
  const mk = (id, other) => {
    const sm = fakeSocketManager(id);
    sm.emit = vi.fn((event, data) => {
      sm.sent.push({ event, data });
      const to = ends[other];
      if (!to || data?.targetSocketId !== other) return;
      setTimeout(() => {
        if (event === CLIENT_EVENTS.VOICE_OFFER) to.vm.handleOffer(id, data.offer, id);
        else if (event === CLIENT_EVENTS.VOICE_ANSWER) to.vm.handleAnswer(id, data.answer);
      }, latency);
    });
    return { vm: new VoiceChatManager(), sm };
  };
  ends['sock-a'] = mk('sock-a', 'sock-b');
  ends['sock-b'] = mk('sock-b', 'sock-a');
  return { a: ends['sock-a'], b: ends['sock-b'] };
}

/** The two ends hold one matched call: each side's remote description is the other's local one. */
function expectOneCall(a, b) {
  const pa = a.vm.peers.get('sock-b').connection;
  const pb = b.vm.peers.get('sock-a').connection;
  expect(pa.signalingState).toBe('stable');
  expect(pb.signalingState).toBe('stable');
  expect(pa.remoteDescription).toBe(pb.localDescription);
  expect(pb.remoteDescription).toBe(pa.localDescription);
  return { pa, pb };
}

describe('crossing offers (review 2026-11-16: two spectators change mode on one voiceSettings)', () => {
  it('both re-offer at once: the lower socket id keeps its offer, the higher answers it; one call, both talking', async () => {
    const { a, b } = pair();
    await a.vm.setTalk(false);
    await b.vm.setTalk(false);
    await start(a.vm, a.sm);
    await start(b.vm, b.sm);
    // the later extra offers the earlier one listen-only (voicePeerList)
    await b.vm.connectToPeer('sock-a', 'a');
    await vi.advanceTimersByTimeAsync(200);
    expectOneCall(a, b);
    a.sm.sent.length = 0;
    b.sm.sent.length = 0;

    // the switch comes back on: both take the mic on the same voiceSettings
    await Promise.all([a.vm.setTalk(true), b.vm.setTalk(true)]);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS + 500);
    // both offered (they crossed), only a's offer was answered
    expect(a.sm.offers()).toHaveLength(1);
    expect(b.sm.offers()).toHaveLength(1);
    expect(a.sm.answers()).toHaveLength(0);
    expect(b.sm.answers()).toHaveLength(1);
    const { pa, pb } = expectOneCall(a, b);
    expect(pa.localDescription.type).toBe('offer');
    expect(pa.tracks).toHaveLength(1);
    expect(pb.tracks).toHaveLength(1);
    // nothing more happens: no further re-offer, and no failure at the connect timer
    pa.connectionState = 'connected';
    pa.onconnectionstatechange();
    pb.connectionState = 'connected';
    pb.onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(25000);
    expect(a.sm.offers()).toHaveLength(1);
    expect(b.sm.offers()).toHaveLength(1);
    expect(a.vm.isUnavailable('sock-b')).toBe(false);
    a.vm.shutdown();
    b.vm.shutdown();
  });

  it('and both losing talk at once (no microphone step): the same, one listen-only call', async () => {
    const { a, b } = pair();
    await start(a.vm, a.sm, { talk: true });
    await start(b.vm, b.sm, { talk: true });
    await a.vm.connectToPeer('sock-b', 'b');
    await vi.advanceTimersByTimeAsync(200);
    expectOneCall(a, b);
    await Promise.all([a.vm.setTalk(false), b.vm.setTalk(false)]);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS + 500);
    const { pa, pb } = expectOneCall(a, b);
    expect(pa.transceivers).toEqual([{ kind: 'audio', direction: 'recvonly' }]);
    expect(pb.tracks).toHaveLength(0);
    a.vm.shutdown();
    b.vm.shutdown();
  });

  it('the lower end ignores an offer only while its own is unanswered; one that follows the answer is taken', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-a');
    await start(vm, sm, { talk: true });
    await vm.connectToPeer('sock-b', 'bob');
    const mine = vm.peers.get('sock-b').connection;
    await vm.handleOffer('sock-b', OFFER, 'bob');
    expect(vm.peers.get('sock-b').connection).toBe(mine);
    expect(sm.answers()).toHaveLength(0);
    // the answer to mine lands, then an offer: a new negotiation, answered,
    // even while the browser is still applying that answer (signalingState
    // still have-local-offer: a real setRemoteDescription is not instant)
    const apply = mine.setRemoteDescription.bind(mine);
    mine.setRemoteDescription = (d) => new Promise((resolve) => setTimeout(() => resolve(apply(d)), 5));
    const answering = vm.handleAnswer('sock-b', ANSWER);
    expect(mine.signalingState).toBe('have-local-offer');
    await vm.handleOffer('sock-b', OFFER, 'bob');
    expect(vm.peers.get('sock-b').connection).not.toBe(mine);
    expect(sm.answers()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    await answering;
    vm.shutdown();
  });

  it('the higher end answers a crossing offer and drops its own (its answer is in its current mode)', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-z');
    await start(vm, sm, { talk: true });
    await vm.connectToPeer('sock-b', 'bob');
    const mine = vm.peers.get('sock-b').connection;
    await vm.handleOffer('sock-b', OFFER, 'bob');
    expect(mine.signalingState).toBe('closed');
    expect(sm.answers()).toHaveLength(1);
    expect(vm.peers.get('sock-b').connection.tracks).toHaveLength(1);
    vm.shutdown();
  });

  it('a call built in the new mode after the change is not re-offered', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    await vm.connectToPeer('sock-b', 'bob');
    await vm.handleAnswer('sock-b', ANSWER);
    await vm.setTalk(false);
    // inside the re-offer delay: a new peer offered listen-only, another one's offer answered
    await vm.connectToPeer('sock-c', 'cat');
    await vm.handleAnswer('sock-c', ANSWER);
    await vm.handleOffer('sock-d', OFFER, 'dan');
    sm.sent.length = 0;
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-b']);
    vm.shutdown();
  });
});

describe('a call that ends while its peer speaks (review 2026-11-16)', () => {
  it('reports the peer as stopped: on leaving and on a replacement call', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    const seen = [];
    vm.onSpeakingChange((id, on) => seen.push([id, on, vm.peers.get(id)?.username ?? null]));
    const speak = async (id) => {
      track(vm, id);
      vm._analysers.get(id).analyser.getFloatTimeDomainData = (arr) => arr.fill(0.5);
      await vi.advanceTimersByTimeAsync(150);
    };
    await vm.handleOffer('sock-b', OFFER, 'bob');
    await speak('sock-b');
    expect(vm.isSpeaking('sock-b')).toBe(true);
    // its listen-only replacement offer (no track: no poll would ever say so)
    await vm.handleOffer('sock-b', OFFER, 'bob');
    // the stop names the peer while it is still known (main.js maps it to a username)
    expect(seen.at(-1)).toEqual(['sock-b', false, 'bob']);
    expect(vm.isSpeaking('sock-b')).toBe(false);
    await speak('sock-b');
    vm.removePeer('sock-b');
    expect(seen.at(-1)).toEqual(['sock-b', false, 'bob']);
    // a silent peer leaving says nothing
    await vm.handleOffer('sock-c', OFFER, 'cat');
    const n = seen.length;
    vm.removePeer('sock-c');
    expect(seen).toHaveLength(n);
    vm.shutdown();
  });
});
