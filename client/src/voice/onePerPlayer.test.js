/**
 * One call per player after a reconnect (owner 2026-11-27: an update went out
 * during a game and "the voices sounded strange, like there was maybe an
 * echo"; docs/claude/voice.md "One call per player after a reconnect"). A
 * deploy's hand-off (or a blip that drops every socket at once) gives every
 * player a new socket id while their RTCPeerConnections keep flowing, and
 * nobody is told the old sockets left. Before, the new peer list made a
 * second call to every player (each heard twice: live, 2 calls per player
 * after a hand-off, 3 after a blip on top). Now a call to a player on an
 * older socket id moves to the new id while its audio flows, else closes,
 * and an offer from the player replaces any older call of theirs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceChatManager, FLOW_SAMPLE_MS, REKEY_VERIFY_MS, LIVENESS_SAMPLE_MS } from './VoiceChatManager.js';
import { CLIENT_EVENTS } from '../constants/events.js';
import { getGameState } from '../state/GameState.js';
import { forgetSessionMute } from './voiceSessionMute.js';

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
  close() { this.signalingState = 'closed'; this.connectionState = 'closed'; this.flowing = false; }
  // inbound audio: the packets grow on every read while the far end sends
  // `sendsNothing`: the far end is up but sends no audio (a muted tab with a
  // suspended AudioContext, a spectator): no inbound-rtp at all, only its
  // transport's consent pings (one each 2.5 s, as Chromium's selected pair)
  async getStats() {
    if (this.flowing && !this.sendsNothing) this.packets = (this.packets || 0) + 25;
    const rows = [];
    if (!this.sendsNothing) rows.push({ type: 'inbound-rtp', kind: 'audio', packetsReceived: this.packets || 0 });
    if (this.withTransport) {
      if (this.flowing) this.pings = Math.floor(Date.now() / 2500);
      rows.push({ type: 'candidate-pair', state: 'succeeded', nominated: true, bytesReceived: 0, requestsReceived: this.pings || 0, responsesReceived: this.pings || 0 });
    }
    return { forEach: (fn) => rows.forEach(fn) };
  }
  /** Test helper: the call is up and receives audio. */
  up() { this.connectionState = 'connected'; this.iceConnectionState = 'connected'; this.flowing = true; this.onconnectionstatechange?.(); return this; }
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
    candidates: () => sent.filter((s) => s.event === CLIENT_EVENTS.VOICE_ICE_CANDIDATE),
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


const livePcs = () => FakePC.all.filter((pc) => pc.signalingState !== 'closed');

/** alice's voice with one up and flowing call to bob on `bobId`, made from her socket `aliceId`. */
async function withCallToBob(aliceId = 'a1', bobId = 'b1') {
  const vm = new VoiceChatManager();
  const sm = fakeSocketManager(aliceId);
  await start(vm, sm);
  await vm.connectToPeer(bobId, 'bob');
  await vm.handleAnswer(bobId, ANSWER);
  vm.peers.get(bobId).connection.up();
  return { vm, sm, pc: vm.peers.get(bobId).connection };
}

describe('after a hand-off: the peer list names a player I still have a call with on an old socket id', () => {
  it('a call still receiving their audio moves to the new id: the same connection, no new offer, no second call', async () => {
    const { vm, sm, pc } = await withCallToBob();
    // the hand-off: alice and bob both reconnect on new sockets; the server lists bob@b2
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(livePcs()).toEqual([pc]);
    expect(FakePC.all).toHaveLength(1);
    expect(sm.offers()).toHaveLength(1); // only the first call's
    expect([...vm.peers.keys()]).toEqual(['b2']);
    expect(vm.peers.get('b2').connection).toBe(pc);
    expect(vm.peers.get('b2').viaSocketId).toBe('a2');
    expect(vm.getPeers()).toEqual([{ socketId: 'b2', username: 'bob' }]);
    // its signaling goes to the new socket from now on
    pc.onicecandidate({ candidate: { candidate: 'c' } });
    expect(sm.candidates().at(-1).data.targetSocketId).toBe('b2');
    // still flowing at the check: kept
    await vi.advanceTimersByTimeAsync(REKEY_VERIFY_MS + FLOW_SAMPLE_MS);
    expect(livePcs()).toEqual([pc]);
    expect(sm.offers()).toHaveLength(1);
    vm.shutdown();
  });

  it('keeps my mute and volume of that player on the moved call', async () => {
    const { vm, sm } = await withCallToBob();
    vm.mutePeer('b1');
    vm.setPeerVolume('b1', 1.5);
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(vm.isPeerMuted('b2')).toBe(true);
    expect(vm.getPeerVolume('b2')).toBe(1.5);
    expect(vm.peers.get('b2').audioEl.id).toBe('voice-audio-b2');
    vm.shutdown();
  });

  it('a silent call (their side closed it) is closed and a new call is offered to the new id', async () => {
    const { vm, sm, pc } = await withCallToBob();
    pc.flowing = false;
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(pc.signalingState).toBe('closed');
    expect(livePcs()).toHaveLength(1);
    expect([...vm.peers.keys()]).toEqual(['b2']);
    expect(sm.offers().at(-1).data.targetSocketId).toBe('b2');
    vm.shutdown();
  });

  it('a call not up (failed, still connecting) is never moved', async () => {
    const { vm, sm, pc } = await withCallToBob();
    pc.connectionState = 'failed';
    pc.iceConnectionState = 'failed';
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(pc.signalingState).toBe('closed');
    expect(livePcs()).toHaveLength(1);
    expect(vm.peers.get('b2').connection).not.toBe(pc);
    vm.shutdown();
  });

  it('a moved call that goes silent is offered again on the new id', async () => {
    const { vm, sm, pc } = await withCallToBob();
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(vm.peers.get('b2').connection).toBe(pc);
    pc.flowing = false; // bob's side was closed after all
    await vi.advanceTimersByTimeAsync(REKEY_VERIFY_MS + FLOW_SAMPLE_MS);
    expect(pc.signalingState).toBe('closed');
    expect(livePcs()).toHaveLength(1);
    expect(sm.offers()).toHaveLength(2);
    expect(sm.offers()[1].data.targetSocketId).toBe('b2');
    vm.shutdown();
  });

  it('the list twice while the check runs still makes one call', async () => {
    const { vm, sm, pc } = await withCallToBob();
    pc.flowing = false;
    sm.id = 'a2';
    const p1 = vm.connectToPeer('b2', 'bob');
    const p2 = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await Promise.all([p1, p2]);
    expect(livePcs()).toHaveLength(1);
    expect(sm.offers().filter((o) => o.data.targetSocketId === 'b2')).toHaveLength(1);
    vm.shutdown();
  });

  it('every player of a table: one call each, whatever order the lists come in', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('a1');
    await start(vm, sm);
    for (const [id, name] of [['b1', 'bob'], ['c1', 'cat'], ['d1', 'dan']]) {
      await vm.connectToPeer(id, name);
      await vm.handleAnswer(id, ANSWER);
      vm.peers.get(id).connection.up();
    }
    const before = [...FakePC.all];
    sm.id = 'a2';
    // bob reconnected first (alice is listed to him: peerJoined), cat and dan after alice (her list)
    const ps = [vm.peerJoined('b2', 'bob'), vm.connectToPeer('c2', 'cat'), vm.connectToPeer('d2', 'dan')];
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await Promise.all(ps);
    expect(livePcs()).toEqual(before);
    expect([...vm.peers.keys()].sort()).toEqual(['b2', 'c2', 'd2']);
    vm.shutdown();
  });
});

describe('after a hand-off: voicePeerJoined names a player I still have a call with on an old socket id', () => {
  it('a call still receiving their audio moves to the new id (they move theirs at their list): no offer either way', async () => {
    const { vm, sm, pc } = await withCallToBob();
    sm.id = 'a2';
    const p = vm.peerJoined('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(livePcs()).toEqual([pc]);
    expect([...vm.peers.keys()]).toEqual(['b2']);
    expect(sm.offers()).toHaveLength(1);
    // bob's restart or re-offer later reaches the same call by the new id
    await vm.handleIceCandidate('b2', { candidate: 'x' });
    expect(pc.candidates.at(-1).c).toEqual({ candidate: 'x' });
    vm.shutdown();
  });

  it('a silent call is closed; their offer makes the one new call', async () => {
    const { vm, sm, pc } = await withCallToBob();
    pc.flowing = false;
    sm.id = 'a2';
    const p = vm.peerJoined('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p;
    expect(pc.signalingState).toBe('closed');
    expect(vm.peers.size).toBe(0);
    expect(sm.offers()).toHaveLength(1); // the joined side never offers
    await vm.handleOffer('b2', OFFER, 'bob');
    expect(livePcs()).toHaveLength(1);
    expect(sm.answers().at(-1).data.targetSocketId).toBe('b2');
    vm.shutdown();
  });

  it('a player I have no call with: nothing (the newcomer offers)', async () => {
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('a1');
    await start(vm, sm);
    await vm.peerJoined('b2', 'bob');
    expect(FakePC.all).toHaveLength(0);
    vm.shutdown();
  });
});

describe('an offer from a player I still have a call with on an old socket id', () => {
  it('replaces that call: one connection, answered on the new id, my mute carried', async () => {
    const { vm, sm, pc } = await withCallToBob();
    vm.mutePeer('b1');
    // bob reloaded (or an older build reconnected and offers at once)
    await vm.handleOffer('b2', OFFER, 'bob');
    expect(pc.signalingState).toBe('closed');
    expect(livePcs()).toHaveLength(1);
    expect([...vm.peers.keys()]).toEqual(['b2']);
    expect(sm.answers().at(-1).data.targetSocketId).toBe('b2');
    expect(vm.isPeerMuted('b2')).toBe(true);
    vm.shutdown();
  });

  it('an offer naming nobody (no username) replaces nothing', async () => {
    const { vm, pc } = await withCallToBob();
    await vm.handleOffer('x9', OFFER, undefined);
    expect(pc.signalingState).not.toBe('closed');
    expect(livePcs()).toHaveLength(2);
    vm.shutdown();
  });
});

describe('a muted tab sends silence (review 2026-11-27: an empty destination sends no packets)', () => {
  it('the silent track carries a zero-gain tone, stopped at shutdown', async () => {
    const made = { osc: [], gain: [] };
    const Base = window.AudioContext;
    window.AudioContext = function AudioContext() {
      const ctx = Base();
      ctx.createOscillator = () => {
        const osc = { connected: [], started: false, stopped: false, connect(n) { this.connected.push(n); }, start() { this.started = true; }, stop() { this.stopped = true; } };
        made.osc.push(osc);
        return osc;
      };
      ctx.createGain = () => {
        const g = { gain: { value: 1 }, connected: [], connect(n) { this.connected.push(n); }, disconnect() { this.disconnected = true; } };
        made.gain.push(g);
        return g;
      };
      return ctx;
    };
    const vm = new VoiceChatManager();
    const sm = fakeSocketManager('a1');
    await start(vm, sm);
    await vm.connectToPeer('b1', 'bob');
    const pc = vm.peers.get('b1').connection;
    expect(pc.added[0].track.id).toMatch(/^silent-/);
    expect(made.osc).toHaveLength(1);
    expect(made.osc[0].started).toBe(true);
    expect(made.osc[0].connected).toEqual([made.gain[0]]);
    expect(made.gain[0].gain.value).toBe(0);
    expect(made.gain[0].connected).toEqual([vm._silent.dest]);
    vm.shutdown();
    expect(made.osc[0].stopped).toBe(true);
  });
});

describe('after a hand-off: a player who sends no audio (muted, a spectator)', () => {
  /** alice's call to bob, up, whose far end sends no audio but answers its consent pings. */
  async function withQuietBob() {
    const r = await withCallToBob();
    r.pc.sendsNothing = true;
    r.pc.withTransport = true;
    return r;
  }

  it('the list: the call still hears their transport, so it moves (no offer, no gap), not closed', async () => {
    const { vm, sm, pc } = await withQuietBob();
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(LIVENESS_SAMPLE_MS);
    await p;
    expect(livePcs()).toEqual([pc]);
    expect([...vm.peers.keys()]).toEqual(['b2']);
    expect(sm.offers()).toHaveLength(1);
    // still alive at the check: kept, no re-offer
    await vi.advanceTimersByTimeAsync(REKEY_VERIFY_MS + LIVENESS_SAMPLE_MS);
    expect(livePcs()).toEqual([pc]);
    expect(sm.offers()).toHaveLength(1);
    vm.shutdown();
  });

  it('voicePeerJoined: the same move (so the talker does not drop the muted player\'s call)', async () => {
    const { vm, sm, pc } = await withQuietBob();
    sm.id = 'a2';
    const p = vm.peerJoined('b2', 'bob');
    await vi.advanceTimersByTimeAsync(LIVENESS_SAMPLE_MS);
    await p;
    expect(livePcs()).toEqual([pc]);
    expect([...vm.peers.keys()]).toEqual(['b2']);
    vm.shutdown();
  });

  it('a far end that is gone (no pings either) is still closed and offered anew', async () => {
    const { vm, sm, pc } = await withQuietBob();
    pc.flowing = false; // nothing at all comes back
    sm.id = 'a2';
    const p = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(LIVENESS_SAMPLE_MS);
    await p;
    expect(pc.signalingState).toBe('closed');
    expect(livePcs()).toHaveLength(1);
    expect(sm.offers().at(-1).data.targetSocketId).toBe('b2');
    vm.shutdown();
  });
});

describe('two reconnects in a row: the player announced on two new ids within one check', () => {
  it('the list for b2, then for b3 200 ms later: one call, on b3, no offer', async () => {
    const { vm, sm, pc } = await withCallToBob();
    sm.id = 'a2';
    const p1 = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(200);
    sm.id = 'a3';
    const p2 = vm.connectToPeer('b3', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await Promise.all([p1, p2]);
    expect(livePcs()).toEqual([pc]);
    expect([...vm.peers.keys()]).toEqual(['b3']);
    expect(sm.offers()).toHaveLength(1);
    // the moved call's check later neither re-offers nor moves it back
    await vi.advanceTimersByTimeAsync(REKEY_VERIFY_MS + LIVENESS_SAMPLE_MS);
    expect(livePcs()).toEqual([pc]);
    expect([...vm.peers.keys()]).toEqual(['b3']);
    expect(sm.offers()).toHaveLength(1);
    pc.onicecandidate({ candidate: { candidate: 'c' } });
    expect(sm.candidates().at(-1).data.targetSocketId).toBe('b3');
    vm.shutdown();
  });

  it('voicePeerJoined for b2, then for b3: one call, on b3', async () => {
    const { vm, sm, pc } = await withCallToBob();
    sm.id = 'a2';
    const p1 = vm.peerJoined('b2', 'bob');
    await vi.advanceTimersByTimeAsync(200);
    const p2 = vm.peerJoined('b3', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await Promise.all([p1, p2]);
    expect(livePcs()).toEqual([pc]);
    expect([...vm.peers.keys()]).toEqual(['b3']);
    vm.shutdown();
  });

  it('a silent old call: closed once, one new call offered to b3 only', async () => {
    const { vm, sm, pc } = await withCallToBob();
    pc.flowing = false;
    sm.id = 'a2';
    const p1 = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(200);
    const p2 = vm.connectToPeer('b3', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await Promise.all([p1, p2]);
    expect(pc.signalingState).toBe('closed');
    expect(livePcs()).toHaveLength(1);
    expect([...vm.peers.keys()]).toEqual(['b3']);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['b1', 'b3']);
    vm.shutdown();
  });

  it('a newer id announced after the move, while the moved call went silent: settles on the newest id', async () => {
    const { vm, sm, pc } = await withCallToBob();
    sm.id = 'a2';
    const p1 = vm.connectToPeer('b2', 'bob');
    await vi.advanceTimersByTimeAsync(FLOW_SAMPLE_MS);
    await p1;
    expect([...vm.peers.keys()]).toEqual(['b2']);
    await vi.advanceTimersByTimeAsync(REKEY_VERIFY_MS - 300);
    pc.flowing = false;
    const p2 = vm.connectToPeer('b3', 'bob');
    await vi.advanceTimersByTimeAsync(LIVENESS_SAMPLE_MS + REKEY_VERIFY_MS);
    await p2;
    expect(livePcs()).toHaveLength(1);
    expect([...vm.peers.keys()]).toEqual(['b3']);
    expect(sm.offers().map((o) => o.data.targetSocketId)).toEqual(['b1', 'b3']);
    vm.shutdown();
  });
});
