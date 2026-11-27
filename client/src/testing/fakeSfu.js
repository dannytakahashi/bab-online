/**
 * Test fakes for the SFU transport (voice/sfu/): a scripted server that
 * answers every sfu* request the way server/socket/sfuHandlers.js does
 * (or as a test scripts it), the socket between them, and a fake
 * RTCPeerConnection that assigns mids, creates a receiving transceiver for
 * each mid an SFU offer names (firing ontrack inside setRemoteDescription,
 * as a browser does) and reports inbound bytes per mid from getStats.
 */
import { vi } from 'vitest';

let pcSeq = 0;

export class FakeSender {
  constructor(track) {
    this.track = track;
    this.params = { encodings: [{}] };
  }
  async replaceTrack(t) { this.track = t; }
  getParameters() { return JSON.parse(JSON.stringify(this.params)); }
  async setParameters(p) { this.params = p; }
}

export class FakeSfuPC {
  constructor(config) {
    this.id = ++pcSeq;
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.nextMid = 0;
    this.bytes = {}; // mid -> inbound bytes (tests move them)
    this.log = []; // what happened, in order
    this.restarts = 0;
    this.offerOpts = [];
    FakeSfuPC.all.push(this);
  }
  addTransceiver(track, init = {}) {
    const tx = { mid: null, direction: init.direction, sender: new FakeSender(track), receiver: { track: null }, stopped: false, stop() { this.stopped = true; this.direction = 'stopped'; } };
    this.transceivers.push(tx);
    this.log.push(['addTransceiver', init.direction]);
    return tx;
  }
  getTransceivers() { return this.transceivers; }
  // the mesh's calls (VoiceChatManager), so one fake serves both transports
  addTrack(track) {
    const sender = new FakeSender(track);
    (this.senders ||= []).push(sender);
    this.log.push(['addTrack']);
    return sender;
  }
  getSenders() { return this.senders || []; }
  async addIceCandidate() {}
  getConfiguration() { return { ...this.config }; }
  setConfiguration(c) { this.config = c; }
  async createOffer(opts = {}) {
    this.offerOpts.push(opts);
    for (const tx of this.transceivers) if (tx.mid === null) tx.mid = String(this.nextMid++);
    return { type: 'offer', sdp: `v=0 offer pc${this.id}${opts.iceRestart ? ' iceRestart' : ''}` };
  }
  async createAnswer() { return { type: 'answer', sdp: `v=0 answer pc${this.id}` }; }
  async setLocalDescription(d) {
    if (this.signalingState === 'closed') throw new Error('closed');
    this.log.push(['setLocal', d.type]);
    if (d.type === 'rollback') {
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    if (this.signalingState === 'closed') throw new Error('closed');
    if (FakeSfuPC.failRemote) {
      FakeSfuPC.failRemote = false;
      throw new Error('setRemoteDescription failed (scripted)');
    }
    this.log.push(['setRemote', d.type]);
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    const m = /mids=([0-9,]+)/.exec(d.sdp || '');
    if (d.type === 'offer' && m) {
      for (const mid of m[1].split(',')) {
        let tx = this.transceivers.find((x) => x.mid === mid && !x.stopped);
        if (tx) continue;
        const track = { kind: 'audio', id: `remote-${this.id}-${mid}-${Math.random().toString(36).slice(2, 6)}` };
        tx = { mid, direction: 'recvonly', sender: new FakeSender(null), receiver: { track }, stopped: false, stop() { this.stopped = true; this.direction = 'stopped'; } };
        this.transceivers.push(tx);
        this.ontrack?.({ transceiver: tx, track, streams: [] });
      }
    }
  }
  restartIce() { this.restarts++; }
  async getStats() {
    const out = new Map();
    for (const [mid, bytes] of Object.entries(this.bytes)) out.set(`in-${mid}`, { type: 'inbound-rtp', kind: 'audio', mid, bytesReceived: bytes });
    return out;
  }
  /** Move the connection (both state machines) and fire the handlers. */
  setState(state) {
    this.connectionState = state;
    this.iceConnectionState = state === 'connected' ? 'connected' : state;
    this.onconnectionstatechange?.();
    this.oniceconnectionstatechange?.();
  }
  close() {
    this.signalingState = 'closed';
    this.connectionState = 'closed';
    this.log.push(['close']);
  }
}
FakeSfuPC.all = [];
FakeSfuPC.failRemote = false;
FakeSfuPC.reset = () => { FakeSfuPC.all = []; FakeSfuPC.failRemote = false; };

/**
 * A scripted server and the socket the transport talks through.
 * `server.script(event, fn)`: fn(data, defaults) -> the reply fields, or
 * {ok: false, error} / null (no reply at all: the request hangs).
 */
export function createFakeSfuServer({ socketId = 'sock-1' } = {}) {
  const server = {
    requests: [],
    scripts: new Map(),
    onceScripts: new Map(),
    sessions: 0,
    midSeq: 100,
    held: [],
    members: new Map(), // sessionId -> username (who published what, for pull replies)
    transport: null,
    socket: null,
    autoReply: true,
  };
  const socket = {
    id: socketId,
    isConnected: true,
    emit: vi.fn((event, data) => {
      server.requests.push({ event, data, at: Date.now() });
      const reply = server.answer(event, data);
      if (reply === null) {
        server.held.push({ event, data });
        return;
      }
      Promise.resolve().then(() => server.transport?.onReply(reply));
    }),
  };
  server.socket = socket;

  const err = (code, extra = {}) => ({ code, retryable: false, retryAfterMs: null, status: null, cfCode: null, ...extra });
  server.err = err;

  server.defaults = (event, data) => {
    switch (event) {
      case 'sfuSession': {
        server.sessions++;
        return { sessionId: `sess${server.sessions}`, sessionToken: `tok${server.sessions}` };
      }
      case 'sfuPush':
        return { answer: { type: 'answer', sdp: 'v=0 push answer' }, tracks: [{ mid: data.mid, trackName: data.trackName, errorCode: null, errorDescription: null }] };
      case 'sfuPull': {
        const tracks = data.tracks.map((t) => ({ username: server.members.get(t.sessionId) ?? null, sessionId: t.sessionId, trackName: t.trackName, mid: String(server.midSeq++), errorCode: null, errorDescription: null }));
        const mids = tracks.map((t) => t.mid).join(',');
        return { requiresImmediateRenegotiation: true, offer: { type: 'offer', sdp: `v=0 sfu offer mids=${mids}` }, tracks };
      }
      case 'sfuRenegotiate': return {};
      case 'sfuClose':
        return { answer: data.force ? null : { type: 'answer', sdp: 'v=0 close answer' }, tracks: data.mids.map((mid) => ({ mid, trackName: null, errorCode: null, errorDescription: null })) };
      case 'sfuIceRestart': return { answer: { type: 'answer', sdp: 'v=0 ice answer' }, tracks: [] };
      case 'sfuResume': return {};
      case 'sfuLeave': return {};
      default: return {};
    }
  };

  server.answer = (event, data) => {
    const op = event.replace(/^sfu/, '').replace(/^./, (c) => c.toLowerCase());
    const base = { requestId: data.requestId, op, sessionId: data.sessionId ?? null };
    const once = server.onceScripts.get(event);
    let fields;
    if (once && once.length) {
      fields = once.shift()(data, () => server.defaults(event, data));
    } else if (server.scripts.has(event)) {
      fields = server.scripts.get(event)(data, () => server.defaults(event, data));
    } else if (!server.autoReply) {
      return null;
    } else {
      fields = server.defaults(event, data);
    }
    if (fields === null) return null;
    if (fields && fields.ok === false) return { ...base, ok: false, error: fields.error };
    return { ...base, ok: true, ...fields };
  };

  /** Answer the next `event` request with `fn` (once). */
  server.once = (event, fn) => {
    if (!server.onceScripts.has(event)) server.onceScripts.set(event, []);
    server.onceScripts.get(event).push(fn);
  };
  server.script = (event, fn) => server.scripts.set(event, fn);
  server.fail = (event, code, extra) => server.once(event, () => ({ ok: false, error: err(code, extra) }));
  server.sent = (event) => server.requests.filter((r) => r.event === event);
  server.last = (event) => server.sent(event).at(-1);
  /** Send a held request's reply now (by default its default reply). */
  server.release = (i = 0, fields = null) => {
    const h = server.held.splice(i, 1)[0];
    const reply = fields ?? server.defaults(h.event, h.data);
    const op = h.event.replace(/^sfu/, '').replace(/^./, (c) => c.toLowerCase());
    server.transport?.onReply({ requestId: h.data.requestId, op, ok: true, sessionId: h.data.sessionId ?? null, ...reply });
  };

  /** A roster for the transport ({username, sessionId, trackName, state}[]). */
  server.roster = (members, { status = 'admitted', bootId = 'boot1', rev = 1, self = null, cap = 100, tournamentId = 't1' } = {}) => {
    for (const m of members) if (m.sessionId) server.members.set(m.sessionId, m.username);
    return { tournamentId, bootId, rev, status, cap, graceMs: 38000, self, members: members.map((m) => ({ username: m.username, sessionId: m.sessionId ?? null, trackName: m.trackName ?? null, state: m.state || 'live' })) };
  };
  server.member = (event, m, { rev, bootId = 'boot1', tournamentId = 't1' } = {}) => {
    if (m.sessionId) server.members.set(m.sessionId, m.username);
    return { tournamentId, bootId, rev, event, member: { username: m.username, sessionId: m.sessionId ?? null, trackName: m.trackName ?? null, state: m.state || 'live' } };
  };
  return server;
}
