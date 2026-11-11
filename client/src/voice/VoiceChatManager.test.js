import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VoiceChatManager, STUN_ICE_SERVERS, ICE_FETCH_TIMEOUT_MS, REFRESH_BEFORE_MS, RESTART_WAIT_MS, CONNECT_TIMEOUT_MS, sanitizeIceServers,
} from './VoiceChatManager.js';
import { CLIENT_EVENTS, SERVER_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';
import { readClientFile } from '../testing/files.js';

// Voice through Cloudflare TURN (owner, 2026-11-11): ICE servers come from
// the server before the first peer connection (STUN when that fails), are
// reused and refreshed; the PCM relay is gone; a failed connection gets one
// restart, then the peer is "voice unavailable".

const TURN_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
];

class FakePC {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.tracks = [];
    FakePC.all.push(this);
  }
  addTrack(t) { this.tracks.push(t); }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate() {}
  getSenders() { return []; }
  getConfiguration() { return { ...this.config }; }
  setConfiguration(c) { this.config = c; this.reconfigured = (this.reconfigured || 0) + 1; }
  close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
  set(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
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
  };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = [];
  getGameState().username = 'alice';
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('RTCSessionDescription', function RTCSessionDescription(d) { return d; });
  vi.stubGlobal('RTCIceCandidate', function RTCIceCandidate(c) { return c; });
  const track = { kind: 'audio', enabled: true, stop: vi.fn(), getSettings: () => ({}) };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  const node = () => ({ connect() {}, disconnect() {} });
  window.AudioContext = function AudioContext() {
    return {
      state: 'running',
      createMediaStreamSource: node,
      createAnalyser: () => ({ ...node(), fftSize: 0, getFloatTimeDomainData() {} }),
      createScriptProcessor: vi.fn(() => { throw new Error('no ScriptProcessor any more'); }),
      close: async () => {},
    };
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.AudioContext;
  getGameState().username = null;
});

/** initialize() with the server answering `reply` (or not at all). */
async function start(vm, sm, reply) {
  const p = vm.initialize(sm);
  await flush();
  const req = sm.requests().at(-1);
  if (reply !== undefined && req) vm.onIceServers({ ...reply, requestId: req.data.requestId });
  await flush();
  await p;
  return req;
}

describe('ICE servers from the server', () => {
  it('asks once before the first peer connection and builds connections with the answer', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const req = await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600 });
    expect(req.data).toEqual({ requestId: expect.stringMatching(/^ice-\d+$/) });
    expect(vm.active).toBe(true);
    expect(vm.hasTurn()).toBe(true);
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all).toHaveLength(1);
    expect(FakePC.all[0].config.iceServers).toEqual(TURN_SERVERS);
    expect(sm.offers()).toHaveLength(1);
    vm.shutdown();
  });

  it('no answer within ICE_FETCH_TIMEOUT_MS: STUN only, voice still starts', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const p = vm.initialize(sm);
    await flush();
    expect(vm.active).toBe(false);
    await vi.advanceTimersByTimeAsync(ICE_FETCH_TIMEOUT_MS);
    await p;
    expect(vm.active).toBe(true);
    expect(vm.hasTurn()).toBe(false);
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all[0].config.iceServers).toEqual(STUN_ICE_SERVERS.map((s) => ({ ...s })));
    // a fallback is not kept: the next session asks again
    vm.shutdown();
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 3600 * 4 });
    expect(sm.requests()).toHaveLength(2);
    expect(vm.hasTurn()).toBe(true);
    vm.shutdown();
  });

  it('a server STUN answer is used as is; a garbled one falls back to STUN', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turn: false, expiresInSec: null });
    expect(vm.hasTurn()).toBe(false);
    vm.shutdown();
    expect(sanitizeIceServers([{ urls: ['http://x'] }, null, 5])).toBeNull();
    expect(sanitizeIceServers([{ urls: 'turn:x:3478', username: 'u', credential: 'c', other: 1 }])).toEqual([{ urls: ['turn:x:3478'], username: 'u', credential: 'c' }]);
  });

  it('a server STUN answer (Cloudflare failure, backoff, env unset) is not kept: the next session asks again', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const STUN_REPLY = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turn: false, expiresInSec: null };
    await start(vm, sm, STUN_REPLY);
    expect(sm.requests()).toHaveLength(1);
    vm.shutdown();
    await start(vm, sm, STUN_REPLY);
    expect(sm.requests()).toHaveLength(2);
    vm.shutdown();
    // TURN back: this one is kept
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600 });
    expect(sm.requests()).toHaveLength(3);
    expect(vm.hasTurn()).toBe(true);
    vm.shutdown();
    await start(vm, sm);
    expect(sm.requests()).toHaveLength(3);
    vm.shutdown();
  });

  it('a STUN session asks for TURN again on the restart and rebuilds the connection with it', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-a');
    await start(vm, sm, { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turn: false, expiresInSec: null });
    await vm.connectToPeer('sock-b', 'bob');
    FakePC.all[0].set('failed');
    await flush();
    const req = sm.requests().at(-1);
    expect(sm.requests()).toHaveLength(2);
    vm.onIceServers({ iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600, requestId: req.data.requestId });
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[1].config.iceServers).toEqual(TURN_SERVERS);
    vm.shutdown();
  });

  it('the waiting side (higher socket id) of a STUN session asks for TURN too and hands it to the restart connection', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-z');
    await start(vm, sm, { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], turn: false, expiresInSec: null });
    await vm.connectToPeer('sock-b', 'bob');
    FakePC.all[0].set('failed');
    await flush();
    expect(sm.requests()).toHaveLength(2);
    await vm.handleOffer('sock-b', { type: 'offer', sdp: 'v=0 restart' }, 'bob');
    const req = sm.requests().at(-1);
    vm.onIceServers({ iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600, requestId: req.data.requestId });
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[1].config.iceServers).toEqual(TURN_SERVERS);
    vm.shutdown();
  });

  it('an answer to no open request (late, another request id) is ignored', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const p = vm.initialize(sm);
    await flush();
    vm.onIceServers({ iceServers: TURN_SERVERS, turn: true, expiresInSec: 100, requestId: 'ice-999' });
    vm.onIceServers(null);
    await vi.advanceTimersByTimeAsync(ICE_FETCH_TIMEOUT_MS);
    await p;
    expect(vm.hasTurn()).toBe(false);
    vm.shutdown();
  });

  it('reused for the session (per username) until REFRESH_BEFORE_MS before expiry', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600 });
    vm.shutdown();
    await start(vm, sm);
    expect(sm.requests()).toHaveLength(1);
    vm.shutdown();
    getGameState().username = 'carol';
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600 });
    expect(sm.requests()).toHaveLength(2);
    vm.shutdown();
  });

  it('refreshes before expiry and hands the new credentials to open connections', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 3600 });
    await vm.connectToPeer('sock-b', 'bob');
    FakePC.all[0].set('connected');
    expect(sm.requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3600 * 1000 - REFRESH_BEFORE_MS);
    expect(sm.requests()).toHaveLength(2);
    const fresh = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u2', credential: 'c2' }];
    vm.onIceServers({ iceServers: fresh, turn: true, expiresInSec: 4 * 3600, requestId: sm.requests()[1].data.requestId });
    await flush();
    expect(FakePC.all[0].reconfigured).toBe(1);
    expect(FakePC.all[0].config.iceServers).toEqual(fresh);
    vm.shutdown();
    // shutdown stops the refresh timer
    await vi.advanceTimersByTimeAsync(5 * 3600 * 1000);
    expect(sm.requests()).toHaveLength(2);
  });

  it('shutdown while waiting for the microphone and the servers releases the stream and stays off', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const p = vm.initialize(sm);
    await flush();
    vm.shutdown();
    await p;
    expect(vm.active).toBe(false);
    expect(vm.localStream).toBeNull();
  });
});

describe('no PCM relay any more', () => {
  it('no ScriptProcessor, no relay emits, no relay API; the handlers register no relay listener', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600 });
    await vm.connectToPeer('sock-b', 'bob');
    FakePC.all[0].set('failed');
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS * 2);
    expect(sm.sent.some((s) => s.event === CLIENT_EVENTS.VOICE_RELAY_AUDIO)).toBe(false);
    expect(vm._onRelayAudio).toBeUndefined();
    expect(vm.isRelayed).toBeUndefined();
    const src = readClientFile('src/voice/VoiceChatManager.js');
    expect(src).not.toMatch(/createScriptProcessor|_relayedPeers|VOICE_RELAY_AUDIO/);
    const handlers = readClientFile('src/handlers/voiceHandlers.js');
    expect(handlers).not.toContain('VOICE_RELAY_AUDIO');
    expect(handlers).toContain('SERVER_EVENTS.VOICE_ICE_SERVERS');
    expect(SERVER_EVENTS.VOICE_ICE_SERVERS).toBe('voiceIceServers');
    vm.shutdown();
  });
});

describe('a failed connection: one restart, then voice unavailable', () => {
  async function connected(myId, peerId) {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager(myId);
    await start(vm, sm, { iceServers: TURN_SERVERS, turn: true, expiresInSec: 4 * 3600 });
    await vm.connectToPeer(peerId, 'bob');
    return { vm, sm };
  }

  it('the lower socket id offers again on a new connection; a second failure is final', async () => {
    const { vm, sm } = await connected('sock-a', 'sock-b');
    FakePC.all[0].set('failed');
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].signalingState).toBe('closed');
    expect(sm.offers()).toHaveLength(2);
    expect(vm.isUnavailable('sock-b')).toBe(false);
    FakePC.all[1].set('failed');
    await flush();
    expect(vm.isUnavailable('sock-b')).toBe(true);
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[1].signalingState).toBe('closed');
    // the row stays (the overlay shows it as unavailable)
    expect(vm.getPeers()).toEqual([{ socketId: 'sock-b', username: 'bob' }]);
    vm.shutdown();
  });

  it('a restart that connects clears the failure (and a later failure gets its own restart)', async () => {
    const { vm, sm } = await connected('sock-a', 'sock-b');
    FakePC.all[0].set('failed');
    await flush();
    FakePC.all[1].set('connected');
    FakePC.all[1].set('failed');
    await flush();
    expect(sm.offers()).toHaveLength(3);
    expect(vm.isUnavailable('sock-b')).toBe(false);
    vm.shutdown();
  });

  it('the higher socket id waits for the restart offer; none in RESTART_WAIT_MS: unavailable, no hang', async () => {
    const { vm, sm } = await connected('sock-z', 'sock-b');
    FakePC.all[0].set('failed');
    await flush();
    expect(sm.offers()).toHaveLength(1); // no offer of its own
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS - 1);
    expect(vm.isUnavailable('sock-b')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(vm.isUnavailable('sock-b')).toBe(true);
    vm.shutdown();
  });

  it('the higher socket id: the restart offer replaces the connection; if that fails too, unavailable at once', async () => {
    const { vm } = await connected('sock-z', 'sock-b');
    FakePC.all[0].set('failed');
    await flush();
    await vm.handleOffer('sock-b', { type: 'offer', sdp: 'v=0 restart' }, 'bob');
    expect(FakePC.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS);
    expect(vm.isUnavailable('sock-b')).toBe(false); // the offer cleared the wait
    FakePC.all[1].set('failed');
    await flush();
    expect(vm.isUnavailable('sock-b')).toBe(true);
    // a fresh offer from that peer later tries again
    await vm.handleOffer('sock-b', { type: 'offer', sdp: 'v=0 again' }, 'bob');
    expect(vm.isUnavailable('sock-b')).toBe(false);
    vm.shutdown();
  });

  it('a connection that never comes up (no candidate pair: it never says failed) times out like a failure', async () => {
    const { vm, sm } = await connected('sock-a', 'sock-b');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(FakePC.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakePC.all).toHaveLength(2); // the one restart
    expect(sm.offers()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);
    await flush();
    expect(vm.isUnavailable('sock-b')).toBe(true);
    // a connected one is left alone
    vm.shutdown();
    const again = await connected('sock-a', 'sock-c');
    FakePC.all.at(-1).set('connected');
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(again.vm.isUnavailable('sock-c')).toBe(false);
    expect(again.sm.offers()).toHaveLength(1);
    again.vm.shutdown();
  });

  it('a peer that leaves forgets its failure state', async () => {
    const { vm } = await connected('sock-a', 'sock-b');
    FakePC.all[0].set('failed');
    await flush();
    FakePC.all[1].set('failed');
    await flush();
    vm.removePeer('sock-b');
    expect(vm.isUnavailable('sock-b')).toBe(false);
    expect(vm.getPeers()).toEqual([]);
    vm.shutdown();
  });
});

describe('overlay styles', () => {
  it('the unavailable badge replaces the relay badge', () => {
    const css = readClientFile('styles/table.css');
    expect(css).toMatch(/\.voice-row__unavailable\.is-on \{ display: block; \}/);
    expect(css).not.toContain('voice-row__relay');
    const ui = readClientFile('src/ui/components/VoiceChatUI.js');
    expect(ui).toContain('voice unavailable');
    expect(ui).not.toContain('isRelayed');
  });
});
