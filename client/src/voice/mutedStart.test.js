/**
 * Voice starts muted (owner 2026-11-18: "by default the mic should be
 * muted and you can click to unmute / activate mic"; docs/claude/voice.md):
 * joining asks for no microphone, every call still carries an audio sender
 * (a silent track from the session's AudioContext), the first unmute asks
 * for the microphone and swaps it onto every call's sender (replaceTrack: no
 * new offer, no call re-created), muting again keeps the microphone, a
 * refused microphone stays muted (listen only) and a later unmute asks
 * again. The fallback without a silent track is listenOnly.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceChatManager, REOFFER_DELAY_MS } from './VoiceChatManager.js';
import { CLIENT_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';

const TURN = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: true, expiresInSec: 4 * 3600 };

class FakeSender {
  constructor(track) {
    this.track = track;
    this.replaced = [];
  }
  async replaceTrack(t) {
    this.replaced.push(t);
    this.track = t;
  }
}

class FakePC {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.added = []; // [{track, stream}] in call order, with when (before/after the remote description)
    this.transceivers = [];
    this.senders = [];
    FakePC.all.push(this);
  }
  addTrack(track, stream) {
    this.added.push({ track, stream, beforeRemote: !this.remoteDescription });
    const sender = new FakeSender(track);
    this.senders.push(sender);
    return sender;
  }
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
  getSenders() { return this.senders; }
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

let micTracks;
let silentTracks;
function newMic() {
  const track = { kind: 'audio', id: `mic-${micTracks.length}`, enabled: true, stop: vi.fn(), getSettings: () => ({}) };
  micTracks.push(track);
  return { id: `micstream-${micTracks.length}`, getAudioTracks: () => [track], getTracks: () => [track] };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = [];
  micTracks = [];
  silentTracks = [];
  getGameState().username = 'alice';
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('RTCSessionDescription', function RTCSessionDescription(d) { return d; });
  vi.stubGlobal('RTCIceCandidate', function RTCIceCandidate(c) { return c; });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => newMic()) } });
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  const node = () => ({ connect() {}, disconnect() {} });
  // An AudioContext that can make a destination: the silent sender track
  window.AudioContext = function AudioContext() {
    return {
      state: 'suspended',
      createMediaStreamSource: node,
      createAnalyser: () => ({ ...node(), fftSize: 256, getFloatTimeDomainData() {} }),
      createMediaStreamDestination: () => {
        const track = { kind: 'audio', id: `silent-${silentTracks.length}`, enabled: true, stop: vi.fn() };
        silentTracks.push(track);
        const stream = { id: `silentstream-${silentTracks.length}`, getAudioTracks: () => [track], getTracks: () => [track] };
        return { ...node(), stream };
      },
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

/** initialize() (muted: no options) with the server answering TURN. */
async function start(vm, sm, opts) {
  const p = vm.initialize(sm, opts);
  await flush();
  const req = sm.requests().at(-1);
  if (req) vm.onIceServers({ ...TURN, requestId: req.data.requestId });
  await flush();
  await p;
}

const senderOf = (vm, id) => vm.peers.get(id).sender;

describe('joining voice: muted, no microphone prompt', () => {
  it('asks for no microphone; every call sends the silent track (an offer and an answer alike), never a recvonly transceiver', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    expect(vm.isMuted()).toBe(true);
    await start(vm, sm);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(vm.active).toBe(true);
    expect(vm.isMuted()).toBe(true);
    expect(vm.selfMuted).toBe(true);
    expect(vm.isTalking()).toBe(false);
    expect(silentTracks).toHaveLength(1);

    await vm.connectToPeer('sock-b', 'bob');
    const offerPc = FakePC.all[0];
    expect(offerPc.transceivers).toEqual([]);
    expect(offerPc.added).toHaveLength(1);
    expect(offerPc.added[0].track).toBe(silentTracks[0]);
    expect(offerPc.added[0].stream.id).toBe('silentstream-1');
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-b']);

    await vm.handleOffer('sock-c', OFFER, 'cat');
    const answerPc = FakePC.all[1];
    // added before the remote description: the offer's audio section takes it
    expect(answerPc.added).toEqual([expect.objectContaining({ track: silentTracks[0], beforeRemote: true })]);
    expect(sm.answers().map((a) => a.data.targetSocketId)).toEqual(['sock-c']);
    vm.shutdown();
  });

  it('buffered peers and offers (before the start) are flushed muted too', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.connectToPeer('sock-b', 'bob');
    await vm.handleOffer('sock-c', OFFER, 'cat');
    await start(vm, sm);
    await flush();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['sock-b']);
    expect(sm.answers().map((a) => a.data.targetSocketId)).toEqual(['sock-c']);
    for (const id of ['sock-b', 'sock-c']) expect(senderOf(vm, id).track).toBe(silentTracks[0]);
    vm.shutdown();
  });
});

describe('the first unmute', () => {
  it('asks for the microphone once and swaps it onto every call (no new offer, no call re-created)', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    await vm.handleAnswer('sock-b', ANSWER);
    await vm.handleOffer('sock-c', OFFER, 'cat');
    const pcs = ['sock-b', 'sock-c'].map((id) => vm.peers.get(id).connection);
    sm.sent.length = 0;

    expect(await vm.setMuted(false)).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vm.isMuted()).toBe(false);
    expect(vm.isTalking()).toBe(true);
    expect(micTracks[0].enabled).toBe(true);
    for (const id of ['sock-b', 'sock-c']) {
      expect(senderOf(vm, id).track).toBe(micTracks[0]);
      expect(senderOf(vm, id).replaced).toEqual([micTracks[0]]);
    }
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS + 50);
    expect(sm.offers()).toEqual([]);
    expect(['sock-b', 'sock-c'].map((id) => vm.peers.get(id).connection)).toEqual(pcs);

    // a call made after it sends the microphone itself
    await vm.connectToPeer('sock-d', 'dan');
    expect(vm.peers.get('sock-d').connection.added[0].track).toBe(micTracks[0]);
    vm.shutdown();
  });

  it('mute again keeps the microphone (its track disabled); the next unmute asks nothing', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    await vm.toggleSelfMute(); // unmute
    expect(vm.isMuted()).toBe(false);
    expect(await vm.toggleSelfMute()).toBe(true);
    expect(vm.isMuted()).toBe(true);
    expect(micTracks[0].enabled).toBe(false);
    expect(micTracks[0].stop).not.toHaveBeenCalled();
    expect(senderOf(vm, 'sock-b').track).toBe(micTracks[0]);
    expect(await vm.toggleSelfMute()).toBe(false);
    expect(micTracks[0].enabled).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    vm.shutdown();
  });

  it('a refused microphone stays muted and listens; the calls keep the silent track; a later unmute asks again', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); });
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const modes = [];
    vm.onModeChange((m) => modes.push(m));
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    sm.sent.length = 0;
    expect(await vm.setMuted(false)).toBe(true);
    expect(vm.micDenied).toBe(true);
    expect(vm.isMuted()).toBe(true);
    expect(vm.isListenOnly()).toBe(true);
    expect(senderOf(vm, 'sock-b').track).toBe(silentTracks[0]);
    expect(modes.at(-1)).toEqual({ talking: false, micDenied: true });
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS + 50);
    expect(sm.offers()).toEqual([]);
    // allowed this time: the denial clears
    navigator.mediaDevices.getUserMedia = vi.fn(async () => newMic());
    expect(await vm.setMuted(false)).toBe(false);
    expect(vm.micDenied).toBe(false);
    expect(senderOf(vm, 'sock-b').track).toBe(micTracks[0]);
    vm.shutdown();
  });

  it('a mute while the prompt is up wins: the granted microphone comes muted', async () => {
    let grant;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { grant = r; }));
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    const unmuting = vm.setMuted(false);
    await flush();
    await vm.setMuted(true);
    grant(newMic());
    expect(await unmuting).toBe(true);
    expect(vm.isMuted()).toBe(true);
    expect(micTracks[0].enabled).toBe(false);
    vm.shutdown();
  });

  it('dropping the microphone (setTalk false) puts the silent track back and mutes', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    await vm.setMuted(false);
    sm.sent.length = 0;
    expect(await vm.setTalk(false)).toBe(false);
    expect(micTracks[0].stop).toHaveBeenCalled();
    expect(senderOf(vm, 'sock-b').track).toBe(silentTracks[0]);
    expect(vm.isMuted()).toBe(true);
    await vi.advanceTimersByTimeAsync(REOFFER_DELAY_MS + 50);
    expect(sm.offers()).toEqual([]);
    vm.shutdown();
  });
});

describe('a new session', () => {
  it('starts muted again (an unmuted session never carries into the next); the silent track goes with the old one', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.setMuted(false);
    expect(vm.isMuted()).toBe(false);
    vm.shutdown();
    expect(silentTracks[0].stop).toHaveBeenCalled();
    expect(vm.isMuted()).toBe(true);
    expect(vm.selfMuted).toBe(true);
    const sm2 = fakeSocketManager();
    await start(vm, sm2);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vm.isMuted()).toBe(true);
    await vm.connectToPeer('sock-b', 'bob');
    expect(senderOf(vm, 'sock-b').track).toBe(silentTracks[1]);
    vm.shutdown();
  });

  it('initialize({talk: true}) still starts with the microphone, unmuted', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vm.isMuted()).toBe(false);
    vm.shutdown();
  });
});
