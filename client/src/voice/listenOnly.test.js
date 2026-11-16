/**
 * VoiceChatManager's talk mode (family lobbies, owner 2026-11-16;
 * docs/claude/voice.md, Spectator voice): listen-only sessions (no
 * microphone, recvonly offers, answers without a track), a refused
 * microphone falls back to listen-only and still flushes, the mode a
 * voiceSettings sets during the microphone prompt wins, setTalk re-offers
 * every call (a call waiting for its answer after it), per-person mute and
 * volume survive a re-created call, the forced mute holds against every
 * volume write (the noise gate too), and a blocked autoplay re-arms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceChatManager, REOFFER_DELAY_MS } from './VoiceChatManager.js';
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

/** initialize() with the server answering TURN. */
async function start(vm, sm) {
  const p = vm.initialize(sm);
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
    await start(vm, sm);
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
    // a new session asks again
    expect(vm.micDenied).toBe(false);
    expect(vm.wantsTalk).toBe(true);
  });

  it('a voiceSettings during the microphone prompt: the latest mode wins (the granted mic is released)', async () => {
    let grant;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { grant = r; }));
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const p = vm.initialize(sm);
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
    await start(vm, sm);
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
    await start(vm, sm);
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

  it('a call that failed for good ("voice unavailable") is re-offered in the new mode too (else the server backstop tears it down)', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-a'); // the lower id: it restarts, then gives up
    await start(vm, sm);
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
    await start(vm, sm);
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

describe('forced mute (a player while spectators may not talk)', () => {
  it('holds against volume, unmute, a new track and the noise gate; lifting it restores the level', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.handleOffer('sock-b', OFFER, 'bob');
    let el = track(vm, 'sock-b');
    expect(el.volume).toBe(1);
    vm.setForcedMute((_id, username) => username === 'bob');
    expect(el.volume).toBe(0);
    expect(vm.isForcedMuted('sock-b')).toBe(true);
    expect(vm.isPeerMuted('sock-b')).toBe(false); // never shown as my own mute
    vm.setPeerVolume('sock-b', 1.5);
    expect(el.volume).toBe(0);
    vm.unmutePeer('sock-b');
    expect(el.volume).toBe(0);
    await vm.handleOffer('sock-b', OFFER, 'bob');
    el = track(vm, 'sock-b');
    expect(el.volume).toBe(0);
    // the noise gate opening (bob speaks) does not open it
    vm._analysers.get('sock-b').analyser.getFloatTimeDomainData = (arr) => arr.fill(0.5);
    await vi.advanceTimersByTimeAsync(150);
    expect(vm.isSpeaking('sock-b')).toBe(true);
    expect(el.volume).toBe(0);
    vm.setForcedMute(null);
    expect(el.volume).toBe(1);
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
    await start(vm, sm);
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
    document.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(play).toHaveBeenCalledTimes(2); // every call's element
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
