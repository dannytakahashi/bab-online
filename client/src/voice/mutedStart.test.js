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
import { forgetSessionMute, sessionWantsUnmuted, SESSION_MUTE_KEY } from './voiceSessionMute.js';
import { clearAllSessionData } from '../utils/sessionPersistence.js';

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
  async addIceCandidate(c) { (this.candidates ||= []).push({ c, afterRemote: !!this.remoteDescription }); }
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
  // a fresh tab: no mute choice made by hand yet
  forgetSessionMute();
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
  it('with no unmute by hand (setMuted alone) starts muted again; the silent track goes with the old one', async () => {
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
    // (unchanged by the tab's choice)
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm, { talk: true });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vm.isMuted()).toBe(false);
    vm.shutdown();
  });
});

/**
 * Owner 2026-11-19: "once you unmute in a session it should stay unmuted".
 * The tab's first start is muted; after an unmute by hand every later start
 * (a new lobby, a table, voice back after company, a reconnect, a reload in
 * the same tab) opens the already-allowed microphone and starts unmuted; a
 * mute by hand holds the same way (voiceSessionMute.js).
 */
describe('the session keeps a manual unmute (owner 2026-11-19)', () => {
  const allowMic = (state = 'granted') => {
    navigator.permissions = { query: vi.fn(async ({ name }) => ({ name, state })) };
  };

  it('the first start of a tab is muted and asks nothing, even with the microphone allowed', async () => {
    allowMic();
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    expect(vm.isMuted()).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    vm.shutdown();
  });

  it('after an unmute by hand the next session (a new lobby, voice back after company) starts unmuted on the microphone, with no prompt', async () => {
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    expect(await vm.toggleSelfMute()).toBe(false);
    expect(sessionWantsUnmuted()).toBe(true);
    vm.shutdown();
    expect(micTracks[0].stop).toHaveBeenCalled();
    // no Permissions API here: this page got the microphone once
    await start(vm, fakeSocketManager());
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(vm.isMuted()).toBe(false);
    expect(vm.isTalking()).toBe(true);
    expect(micTracks[1].enabled).toBe(true);
    // its calls send the microphone from their first offer
    await vm.connectToPeer('sock-b', 'bob');
    expect(senderOf(vm, 'sock-b').track).toBe(micTracks[1]);
    vm.shutdown();
  });

  it('a sign-out forgets it: the next person to sign in on the tab starts muted with no microphone', async () => {
    allowMic('granted');
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    expect(await vm.toggleSelfMute()).toBe(false);
    vm.shutdown();
    clearAllSessionData();
    expect(sessionWantsUnmuted()).toBe(false);
    // a new page (Sign Out reloads the tab)
    const next = new VoiceChatManager();
    await start(next, fakeSocketManager());
    expect(next.isMuted()).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    next.shutdown();
  });

  it('a mute by hand holds too: the next session starts muted with no microphone', async () => {
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    await vm.toggleSelfMute();
    expect(await vm.toggleSelfMute()).toBe(true);
    expect(sessionWantsUnmuted()).toBe(false);
    vm.shutdown();
    await start(vm, fakeSocketManager());
    expect(vm.isMuted()).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    vm.shutdown();
  });

  it('a reload in the same tab (a new page, the tab\'s storage kept) starts unmuted where the browser says the microphone is granted', async () => {
    window.sessionStorage.setItem(SESSION_MUTE_KEY, '1');
    allowMic('granted');
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    expect(navigator.permissions.query).toHaveBeenCalledWith({ name: 'microphone' });
    expect(vm.isMuted()).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    vm.shutdown();
  });

  it('a reload where the microphone is not allowed yet (prompt, denied, no API): muted as today, nothing asked', async () => {
    for (const setup of [() => allowMic('prompt'), () => allowMic('denied'), () => { delete navigator.permissions; }]) {
      window.sessionStorage.setItem(SESSION_MUTE_KEY, '1');
      setup();
      const vm = new VoiceChatManager();
      await start(vm, fakeSocketManager());
      expect(vm.isMuted()).toBe(true);
      expect(vm.micDenied).toBe(false);
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      vm.shutdown();
    }
  });

  it('denied in this page is denied: a refusal after a remembered unmute never reopens it silently', async () => {
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    await vm.toggleSelfMute();
    vm.shutdown();
    allowMic('denied');
    await start(vm, fakeSocketManager());
    expect(vm.isMuted()).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    vm.shutdown();
  });

  it('a microphone that fails to open again starts muted with no denied toast state', async () => {
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    await vm.toggleSelfMute();
    vm.shutdown();
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundError' }); });
    await start(vm, fakeSocketManager());
    expect(vm.isMuted()).toBe(true);
    expect(vm.micDenied).toBe(false);
    vm.shutdown();
  });

  it('a refused unmute leaves the tab muted (the next start asks nothing)', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); });
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    expect(await vm.toggleSelfMute()).toBe(true);
    expect(sessionWantsUnmuted()).toBe(false);
    vm.shutdown();
  });

  it('a shutdown while the remembered microphone opens: released, the next start is not stuck talking', async () => {
    window.sessionStorage.setItem(SESSION_MUTE_KEY, '1');
    allowMic('granted');
    let open;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { open = r; }));
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    const p = vm.initialize(sm);
    await flush();
    expect(open).toBeTypeOf('function');
    vm.shutdown();
    const stream = newMic();
    open(stream);
    await p;
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
    expect(vm.active).toBe(false);
    expect(vm.wantsTalk).toBe(false);
  });
});

describe('the mic button while the microphone prompt is up (review 2026-11-18)', () => {
  it('a second toggle is a mute and wins over the unmute that asked; a third unmutes again', async () => {
    let grant;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { grant = r; }));
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    const first = vm.toggleSelfMute();
    await flush();
    expect(vm.micRequestInFlight).toBe(true);
    // no microphone yet, so isMuted() still reads true: the toggle must not unmute again
    expect(vm.isMuted()).toBe(true);
    expect(await vm.toggleSelfMute()).toBe(true);
    expect(vm.selfMuted).toBe(true);
    grant(newMic());
    expect(await first).toBe(true);
    expect(vm.micRequestInFlight).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(micTracks[0].enabled).toBe(false);
    // the microphone is on the call (disabled): the next toggle unmutes, nothing asked
    expect(senderOf(vm, 'sock-b').track).toBe(micTracks[0]);
    expect(await vm.toggleSelfMute()).toBe(false);
    expect(micTracks[0].enabled).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    vm.shutdown();
  });

  it('three toggles during the prompt: unmuted when it is granted, one prompt', async () => {
    let grant;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((r) => { grant = r; }));
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    const first = vm.toggleSelfMute();
    await flush();
    await vm.toggleSelfMute(); // mute
    const third = vm.toggleSelfMute(); // unmute again
    await flush();
    grant(newMic());
    await first;
    expect(await third).toBe(false);
    expect(vm.isMuted()).toBe(false);
    expect(micTracks[0].enabled).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    vm.shutdown();
  });

  it('a refused prompt after a mute during it: muted, denied, nothing in flight', async () => {
    let refuse;
    navigator.mediaDevices.getUserMedia = vi.fn(() => new Promise((_r, j) => { refuse = j; }));
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    const first = vm.toggleSelfMute();
    await flush();
    await vm.toggleSelfMute();
    refuse(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    expect(await first).toBe(true);
    expect(vm.micDenied).toBe(true);
    expect(vm.micRequestInFlight).toBe(false);
    vm.shutdown();
  });
});

describe('choosing a microphone before the first unmute (review 2026-11-18)', () => {
  it('a pick before any microphone is remembered and used by the first unmute', async () => {
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    await vm.switchAudioDevice('usb-mic');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(vm.getActiveDeviceId()).toBe('usb-mic');
    expect(await vm.setMuted(false)).toBe(false);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'usb-mic' } } });
    vm.shutdown();
  });

  it('a picked microphone that is gone falls back to the default; a refusal is never asked twice', async () => {
    const vm = new VoiceChatManager();
    await start(vm, fakeSocketManager());
    await vm.switchAudioDevice('gone-mic');
    navigator.mediaDevices.getUserMedia = vi.fn(async (c) => {
      if (c.audio?.deviceId) throw Object.assign(new Error('no such device'), { name: 'OverconstrainedError' });
      return newMic();
    });
    expect(await vm.setMuted(false)).toBe(false);
    expect(navigator.mediaDevices.getUserMedia.mock.calls.map((c) => c[0])).toEqual([
      { audio: { deviceId: { exact: 'gone-mic' } } },
      { audio: true },
    ]);
    vm.shutdown();

    const vm2 = new VoiceChatManager();
    await start(vm2, fakeSocketManager());
    await vm2.switchAudioDevice('usb-mic');
    navigator.mediaDevices.getUserMedia = vi.fn(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); });
    expect(await vm2.setMuted(false)).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vm2.micDenied).toBe(true);
    vm2.shutdown();
  });
});

// No voice alone (owner 2026-11-19): a page whose voice is not running
// (alone until now) starts it when a newcomer arrives, and the newcomer's
// offer and its trickled candidates can come first
describe('signals before voice runs (no voice alone)', () => {
  const CAND = (n) => ({ candidate: `candidate:${n} 1 udp 1 192.0.2.1 ${5000 + n} typ host`, sdpMid: '0', sdpMLineIndex: 0 });

  it('an offer and its candidates that came before the start are answered at the start, the candidates after the offer', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.handleOffer('sock-b', OFFER, 'bob');
    await vm.handleIceCandidate('sock-b', CAND(1));
    await vm.handleIceCandidate('sock-b', CAND(2));
    // a candidate from someone with no offer waiting is dropped
    await vm.handleIceCandidate('sock-z', CAND(9));
    expect(FakePC.all).toHaveLength(0);
    await start(vm, sm);
    await flush();
    expect(FakePC.all).toHaveLength(1);
    const pc = vm.peers.get('sock-b').connection;
    expect(pc.candidates.map((x) => x.c.candidate)).toEqual([CAND(1).candidate, CAND(2).candidate]);
    expect(pc.candidates.every((x) => x.afterRemote)).toBe(true);
    expect(sm.answers()).toHaveLength(1);
    vm.shutdown();
  });

  it('a newer offer from the same peer replaces the older one and its candidates', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.handleOffer('sock-b', OFFER, 'bob');
    await vm.handleIceCandidate('sock-b', CAND(1));
    await vm.handleOffer('sock-b', { type: 'offer', sdp: 'v=0 offer 2' }, 'bob');
    await vm.handleIceCandidate('sock-b', CAND(2));
    await start(vm, sm);
    await flush();
    expect(FakePC.all).toHaveLength(1);
    const pc = vm.peers.get('sock-b').connection;
    expect(pc.remoteDescription.sdp).toBe('v=0 offer 2');
    expect(pc.candidates.map((x) => x.c.candidate)).toEqual([CAND(2).candidate]);
    vm.shutdown();
  });

  it('a peer that left before the start (voicePeerLeft) is neither answered nor called', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager();
    await vm.handleOffer('sock-b', OFFER, 'bob');
    await vm.handleIceCandidate('sock-b', CAND(1));
    await vm.connectToPeer('sock-c', 'cat');
    vm.removePeer('sock-b');
    vm.removePeer('sock-c');
    await start(vm, sm);
    await flush();
    expect(FakePC.all).toHaveLength(0);
    expect(sm.answers()).toHaveLength(0);
    expect(sm.offers()).toHaveLength(0);
    vm.shutdown();
  });
});

/**
 * A reconnect without a reload keeps the voice session and its calls, but
 * the server told every peer my old socket left; a voicePeerList that
 * names them again (reconnectOwner, /active from the watch view) must make
 * new calls from the new socket (live check 2026-11-19: the call stayed
 * 'failed' and the list was skipped as "already connected").
 */
describe('a voicePeerList after a reconnect without a reload', () => {
  it('a call made from the previous socket is replaced: a new connection and an offer from the new socket', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-a');
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    const old = vm.peers.get('sock-b').connection;
    expect(sm.offers()).toHaveLength(1);
    // the same list again on the same socket: nothing new
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all).toHaveLength(1);
    // the tab's socket reconnects (new id); the server lists bob again
    sm.id = 'sock-a2';
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all).toHaveLength(2);
    expect(old.signalingState).toBe('closed');
    expect(vm.peers.get('sock-b').connection).toBe(FakePC.all[1]);
    expect(vm.peers.get('sock-b').viaSocketId).toBe('sock-a2');
    expect(sm.offers()).toHaveLength(2);
    expect(sm.offers()[1].data.targetSocketId).toBe('sock-b');
    vm.shutdown();
  });

  it('a failed call on the same socket is replaced too; one being set up is kept', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('sock-a');
    await start(vm, sm);
    await vm.connectToPeer('sock-b', 'bob');
    vm.peers.get('sock-b').connection.connectionState = 'connecting';
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all).toHaveLength(1);
    vm.peers.get('sock-b').connection.connectionState = 'failed';
    await vm.connectToPeer('sock-b', 'bob');
    expect(FakePC.all).toHaveLength(2);
    expect(sm.offers()).toHaveLength(2);
    vm.shutdown();
  });
});
