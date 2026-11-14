/**
 * V1_REMOVALS #1 phase B, on the real page: the server sends each
 * app-level error once, as `serverError {code, message, handler}`
 * (server/socket/serverError.js); the v1 `error` is gone. One failure is
 * one message, one table resync, one restore refusal, one retry, and a
 * stray v1 `error` (no server sends one) does nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, seatDeal } from './testing/fakePage.js';

vi.mock('./vendor.js', () => ({}));
vi.mock('./socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('./voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let SCREEN;
let errors;
let n = 1;

/** What the server sends for one failure. */
function fail({ message, handler = null, code = 'rejected' }) {
  socket.fire('serverError', { code, message, handler });
}

const reported = () => errors.mock.calls.filter((c) => c[0] === 'Server error:');

beforeAll(async () => {
  page = await loadPage({ connected: false });
  socket = page.socket;
  ({ SCREEN } = await import('./state/ClientSession.js'));
});

beforeEach(async () => {
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(`sock-${++n}`);
  socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  socket.clearEmits();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errors.mockRestore());

describe('a refusal (lobby is full)', () => {
  it('reported once', () => {
    fail({ message: 'Lobby is full', handler: 'joinLobby' });
    expect(reported()).toHaveLength(1);
    expect(reported()[0][1]).toMatchObject({ type: 'rejected', message: 'Lobby is full', handler: 'joinLobby' });
  });

  it('two failures in a row are two (nothing is deduped any more)', () => {
    fail({ message: 'Lobby is full', handler: 'joinLobby' });
    fail({ message: 'Lobby is full', handler: 'joinLobby' });
    expect(reported()).toHaveLength(2);
  });

  it('a v1 error is not heard', () => {
    socket.fire('error', { message: 'Lobby is full', handler: 'joinLobby' });
    expect(reported()).toHaveLength(0);
  });
});

describe('a restore refusal (the lobby closed while offline)', () => {
  it('back to the main room once, no error toast', async () => {
    socket.fire('lobbyCreated', { lobbyId: 'L9', players: [{ username: 'me', isReady: false }], messages: [] });
    expect(page.session.screen).toBe(SCREEN.LOBBY);
    socket.reconnect(`sock-${++n}`);
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'L9' }]);
    socket.clearEmits();
    fail({ message: 'Lobby not found', handler: 'joinLobby' });
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(reported()).toHaveLength(0);
  });
});

describe('"User not registered yet": one joinMainRoom retry per failure', () => {
  it('one retry', async () => {
    fail({ message: 'User not registered yet', handler: 'joinMainRoom' });
    await tick(150);
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
  });
});

describe('a refused play or bid resyncs the table at once, once', () => {
  async function seated() {
    socket.fire('lobbyCreated', { lobbyId: 'L1', players: [{ username: 'me', isReady: true }], messages: [] });
    socket.fire('allPlayersReady', { gameId: 'g1' });
    socket.fire('startDraw', { start: true });
    socket.fire('createUI', {});
    socket.fire('gameStart', seatDeal({ gameId: 'g1' }));
    socket.clearEmits();
    const { getMyAction } = await import('./state/MyAction.js');
    return getMyAction();
  }
  const acks = () => socket.emitted('requestSnapshot').filter((d) => String(d.requestId).startsWith('ack-'));

  it('a rate-limited play', async () => {
    const myAction = await seated();
    expect(myAction.submitPlay({ suit: 'spades', rank: 'A' }, 1)).toBe(true);
    fail({ message: 'Too many requests', handler: 'playCard', code: 'rateLimit' });
    expect(acks()).toEqual([{ requestId: `ack-${myAction.pending.reqId}`, log: false, customPics: false }]);
    expect(reported()).toHaveLength(1);
    myAction.reset();
  });

  it('a refused bid', async () => {
    const myAction = await seated();
    expect(myAction.submitBid('1', 1)).toBe(true);
    fail({ message: 'Invalid input', handler: 'playerBid', code: 'validation' });
    expect(acks()).toHaveLength(1);
    myAction.reset();
  });

  it('an error of another request leaves a pending play alone', async () => {
    const myAction = await seated();
    myAction.submitPlay({ suit: 'spades', rank: 'A' }, 1);
    fail({ message: 'Lobby is full', handler: 'joinLobby' });
    expect(acks()).toEqual([]);
    myAction.reset();
  });

  it('a v1 error for a play does not resync (the server never sends one)', async () => {
    const myAction = await seated();
    myAction.submitPlay({ suit: 'spades', rank: 'A' }, 1);
    socket.fire('error', { type: 'rateLimit', message: 'Too many requests', handler: 'playCard' });
    expect(acks()).toEqual([]);
    myAction.reset();
  });

  it('a refused requestSnapshot applies what the seq gate buffered (no snapshot is coming)', async () => {
    await seated();
    const { getSeqGate } = await import('./state/SeqGate.js');
    const gate = getSeqGate();
    const applied = vi.fn();
    gate.reset('g1');
    gate.admit('cardPlayed', { seq: 10 }, () => {});
    gate.admit('cardPlayed', { seq: 12 }, applied); // a gap: buffered, gap-N asked
    expect(gate.buffered).toBe(1);
    fail({ message: 'Too many requests', handler: 'requestSnapshot', code: 'rateLimit' });
    expect(applied).toHaveBeenCalledTimes(1);
    expect(gate.buffered).toBe(0);
  });
});
