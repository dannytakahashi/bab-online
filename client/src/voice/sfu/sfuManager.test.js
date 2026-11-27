/**
 * The SFU room inside the VoiceChatManager (docs/claude/voice.md, "SFU
 * voice, web"): every pulled track mixed in the session's ONE AudioContext
 * (a GainNode and an AnalyserNode per pull, one muted element for all of
 * them), the per-person volume (0-200%), mute and speaking indicator under
 * `sfu:<username>` ids, the first unmute's push and mute by track.enabled,
 * the stop's sfuLeave; and the mesh unchanged (flag off: no SFU traffic; a
 * mesh room while an SFU session is held closes it first).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getVoiceChatManager, resetVoiceChatManager, sfuPeerId } from '../VoiceChatManager.js';
import { registerVoiceHandlers } from '../../handlers/voiceHandlers.js';
import { SERVER_EVENTS, CLIENT_EVENTS } from '../../constants/events.js';
import { getGameState } from '../../state/GameState.js';
import { forgetSessionMute } from '../voiceSessionMute.js';
import { FakeSfuPC, createFakeSfuServer } from '../../testing/fakeSfu.js';

const settle = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

let contexts;
let micTracks;
class FakeMediaStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
  getAudioTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}

function fakeContext() {
  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: { name: 'destination' },
    sources: [],
    gains: [],
    analysers: [],
    level: new Map(), // track -> rms the analyser reads
    createMediaStreamSource(stream) {
      const src = { stream, connected: [], connect(n) { this.connected.push(n); }, disconnect: vi.fn() };
      ctx.sources.push(src);
      return src;
    },
    createAnalyser() {
      const a = {
        fftSize: 256,
        connect() {},
        disconnect() {},
        getFloatTimeDomainData(buf) {
          const src = ctx.sources.find((s) => s.connected.includes(a));
          const v = ctx.level.get(src?.stream.tracks[0]) || 0;
          buf.fill(v);
        },
      };
      ctx.analysers.push(a);
      return a;
    },
    createGain() {
      const g = {
        gain: { value: 1, setTargetAtTime: vi.fn(function set(v) { this.value = v; }) },
        connected: [],
        connect(n) { this.connected.push(n); },
        disconnect: vi.fn(),
      };
      ctx.gains.push(g);
      return g;
    },
    createMediaStreamDestination() {
      const track = { kind: 'audio', id: 'silent', enabled: true, stop: vi.fn() };
      return { connect() {}, disconnect() {}, stream: new FakeMediaStream([track]) };
    },
    resume: async () => {},
    close: async () => {},
  };
  contexts.push(ctx);
  return ctx;
}

function newMic() {
  const track = { kind: 'audio', id: `mic-${micTracks.length}`, enabled: true, stop: vi.fn(), getSettings: () => ({}) };
  micTracks.push(track);
  return new FakeMediaStream([track]);
}

/** A SocketManager-shaped fake that the voice handlers register on, wired to the scripted SFU server. */
function fakeSignalSocket(server) {
  const handlers = new Map();
  const sm = server.socket;
  sm.on = (event, cb) => handlers.set(event, cb);
  sm.fire = (event, data) => handlers.get(event)?.(data);
  return sm;
}

async function startVoice(vm, sm) {
  const p = vm.initialize(sm);
  await settle();
  const req = sm.emit.mock.calls.filter((c) => c[0] === CLIENT_EVENTS.GET_VOICE_ICE_SERVERS).at(-1);
  if (req) vm.onIceServers({ iceServers: [{ urls: 'stun:stun.example.invalid:3478' }], turn: false, expiresInSec: null, requestId: req[1].requestId });
  await settle();
  await p;
}

const A = { username: 'alice', sessionId: 'sa', trackName: 'mic' };
const B = { username: 'bob', sessionId: 'sb', trackName: 'mic' };
const sfuEmits = (sm) => sm.emit.mock.calls.filter((c) => String(c[0]).startsWith('sfu'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  forgetSessionMute();
  FakeSfuPC.reset();
  contexts = [];
  micTracks = [];
  getGameState().username = 'me';
  vi.stubGlobal('RTCPeerConnection', FakeSfuPC);
  vi.stubGlobal('RTCSessionDescription', function RTCSessionDescription(d) { return d; });
  vi.stubGlobal('RTCIceCandidate', function RTCIceCandidate(c) { return c; });
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => newMic()) } });
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  window.AudioContext = function AudioContext() { return fakeContext(); };
});

afterEach(() => {
  resetVoiceChatManager();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.AudioContext;
  getGameState().username = null;
  document.querySelectorAll('audio').forEach((el) => el.remove());
});

function setup() {
  const server = createFakeSfuServer();
  const sm = fakeSignalSocket(server);
  resetVoiceChatManager();
  const vm = getVoiceChatManager();
  server.transport = vm.sfu;
  registerVoiceHandlers(sm, {});
  return { vm, sm, server };
}

describe('step 14: every pull mixed in ONE AudioContext', () => {
  it('a GainNode + AnalyserNode per pull into the one destination; one muted element for all; no element per person', async () => {
    const { vm, sm, server } = setup();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A, B]));
    await startVoice(vm, sm);
    await settle();
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0];
    expect(ctx.gains).toHaveLength(2);
    expect(ctx.gains.every((g) => g.connected.includes(ctx.destination))).toBe(true);
    expect(ctx.analysers).toHaveLength(2);
    const audios = [...document.querySelectorAll('audio')];
    expect(audios).toHaveLength(1);
    expect(audios[0].id).toBe('voice-sfu-sink');
    expect(audios[0].muted).toBe(true);
    expect(audios[0].srcObject.getAudioTracks()).toHaveLength(2);
    // the peer-facing API: by username
    expect(vm.getPeers()).toEqual([
      { socketId: sfuPeerId('alice'), username: 'alice' },
      { socketId: sfuPeerId('bob'), username: 'bob' },
    ]);
    expect(vm.peerUsername('sfu:bob')).toBe('bob');
    expect(vm.isUnavailable('sfu:bob')).toBe(false);
    vm.shutdown();
  });

  it('per-person volume 0-200% on the GainNode (an element capped at 100%), my mute of a person to 0', async () => {
    const { vm, sm, server } = setup();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    await startVoice(vm, sm);
    await settle();
    const gain = contexts[0].gains[0];
    expect(gain.gain.value).toBe(1);
    vm.setPeerVolume('sfu:alice', 1.8);
    expect(gain.gain.value).toBeCloseTo(1.8);
    expect(vm.getPeerVolume('sfu:alice')).toBeCloseTo(1.8);
    vm.setPeerVolume('sfu:alice', 5);
    expect(gain.gain.value).toBe(2);
    vm.setPeerVolume('sfu:alice', 0);
    expect(gain.gain.value).toBe(0);
    vm.setPeerVolume('sfu:alice', 1);
    vm.mutePeer('sfu:alice');
    expect(gain.gain.value).toBe(0);
    expect(vm.isPeerMuted('sfu:alice')).toBe(true);
    vm.unmutePeer('sfu:alice');
    expect(gain.gain.value).toBe(1);
    vm.shutdown();
  });

  it('the speaking indicator and the noise gate per pull; a member leaving stops its ring and its nodes', async () => {
    const { vm, sm, server } = setup();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    await startVoice(vm, sm);
    const seen = [];
    vm.onSpeakingChange((id, on) => seen.push([id, on]));
    await settle();
    const ctx = contexts[0];
    const track = ctx.sources.find((s) => s.stream.tracks[0]?.id?.startsWith('remote')).stream.tracks[0];
    ctx.level.set(track, 0.2);
    await settle(200);
    expect(seen).toContainEqual(['sfu:alice', true]);
    expect(vm.isSpeaking('sfu:alice')).toBe(true);
    ctx.level.set(track, 0);
    await settle(600);
    expect(seen).toContainEqual(['sfu:alice', false]);
    // the gate closed: silence between words
    expect(ctx.gains[0].gain.value).toBe(0);
    ctx.level.set(track, 0.2);
    await settle(200);
    expect(ctx.gains[0].gain.value).toBe(1);
    sm.fire(SERVER_EVENTS.SFU_MEMBER, server.member('left', A, { rev: 2 }));
    await settle();
    expect(seen.at(-1)).toEqual(['sfu:alice', false]);
    expect(ctx.gains[0].disconnect).toHaveBeenCalled();
    expect(document.getElementById('voice-sfu-sink').srcObject.getAudioTracks()).toHaveLength(0);
    expect(vm.getPeers()).toEqual([]);
    vm.shutdown();
  });

  it('a suspended AudioContext waits for a gesture ("Click anywhere to hear voice chat.")', async () => {
    const { vm, sm, server } = setup();
    window.AudioContext = function AudioContext() {
      const c = fakeContext();
      c.state = 'suspended';
      c.resume = vi.fn(async () => {});
      return c;
    };
    const blocked = vi.fn();
    vm.onAutoplayBlocked(blocked);
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    await startVoice(vm, sm);
    await settle(1100);
    expect(blocked).toHaveBeenCalled();
    contexts[0].resume.mockImplementation(async () => { contexts[0].state = 'running'; });
    document.dispatchEvent(new Event('pointerdown'));
    await settle();
    expect(contexts[0].state).toBe('running');
    vm.shutdown();
  });
});

describe('step 4 through the manager: the first unmute publishes, mute is track.enabled', () => {
  it('muted at the start: no push; unmute: getUserMedia once and sfuPush; mute / unmute only flip enabled', async () => {
    const { vm, sm, server } = setup();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    await startVoice(vm, sm);
    await settle();
    expect(server.sent('sfuPush')).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await vm.toggleSelfMute();
    await settle();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(server.sent('sfuPush')).toHaveLength(1);
    const tx = vm.sfu.session.pc.transceivers.find((x) => x.direction === 'sendonly');
    expect(tx.sender.track).toBe(micTracks[0]);
    expect(micTracks[0].enabled).toBe(true);
    await vm.toggleSelfMute();
    expect(micTracks[0].enabled).toBe(false);
    await vm.toggleSelfMute();
    await settle();
    expect(micTracks[0].enabled).toBe(true);
    expect(server.sent('sfuPush')).toHaveLength(1);
    expect(server.sent('sfuSession')).toHaveLength(1);
    vm.shutdown();
  });

  it('shutdown sends sfuLeave, closes the PeerConnection and removes the mixer', async () => {
    const { vm, sm, server } = setup();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    await startVoice(vm, sm);
    await settle();
    const pc = vm.sfu.session.pc;
    vm.shutdown();
    expect(server.sent('sfuLeave')).toHaveLength(1);
    expect(pc.connectionState).toBe('closed');
    expect(document.getElementById('voice-sfu-sink')).toBe(null);
  });
});

describe('the mesh is unchanged', () => {
  it('flag off (no sfuRoster): a tournament room\'s voicePeerList makes mesh calls and no sfu* request is ever sent', async () => {
    const { vm, sm } = setup();
    await startVoice(vm, sm);
    sm.fire(SERVER_EVENTS.VOICE_PEER_LIST, { peers: [{ socketId: 'peer-b', username: 'bob' }] });
    await settle();
    expect(vm.sfu.mode).toBe('mesh');
    const offers = sm.emit.mock.calls.filter((c) => c[0] === CLIENT_EVENTS.VOICE_OFFER);
    expect(offers.map((c) => c[1].targetSocketId)).toEqual(['peer-b']);
    expect(sfuEmits(sm)).toEqual([]);
    expect(vm.getPeers()).toEqual([{ socketId: 'peer-b', username: 'bob' }]);
    sm.fire(SERVER_EVENTS.TOURNAMENT_VOICE_STATUS, { admitted: false, cap: 8 });
    await settle(30000);
    expect(sfuEmits(sm)).toEqual([]);
    vm.shutdown();
    expect(sfuEmits(sm)).toEqual([]);
  });

  it('a mesh room while an SFU session is held (a deploy onto a flag-off process): pc.close first, no sfuLeave, then the mesh', async () => {
    const { vm, sm, server } = setup();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    await startVoice(vm, sm);
    await settle();
    const pc = vm.sfu.session.pc;
    vm.sfu.enterRoom();
    sm.fire(SERVER_EVENTS.VOICE_PEER_LIST, { peers: [{ socketId: 'peer-b', username: 'bob' }] });
    await settle();
    expect(pc.connectionState).toBe('closed');
    expect(server.sent('sfuLeave')).toHaveLength(0);
    expect(vm.getPeers()).toEqual([{ socketId: 'peer-b', username: 'bob' }]);
    expect(document.getElementById('voice-sfu-sink').srcObject.getAudioTracks()).toHaveLength(0);
    vm.shutdown();
    expect(server.sent('sfuLeave')).toHaveLength(0);
  });

  it('sfuReply / sfuRoster / sfuMember reach the transport through the voice handlers', async () => {
    const { vm, sm, server } = setup();
    const spy = vi.spyOn(vm.sfu, 'onReply');
    sm.fire(SERVER_EVENTS.SFU_REPLY, { requestId: 'x', op: 'session', ok: true });
    expect(spy).toHaveBeenCalled();
    sm.fire(SERVER_EVENTS.SFU_ROSTER, server.roster([A]));
    expect(vm.sfu.hasCompany()).toBe(true);
    sm.fire(SERVER_EVENTS.SFU_MEMBER, server.member('left', A, { rev: 2 }));
    expect(vm.sfu.hasCompany()).toBe(false);
  });
});
