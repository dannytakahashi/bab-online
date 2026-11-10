import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ClientSession, SCREEN, ROLE, EXIT, CONNECTION, TRANSITIONS, IllegalTransitionError, ROUTE_TIMEOUT_MS,
} from './ClientSession.js';
import { GameState } from './GameState.js';
import { SocketManager, CONNECTION_STATE } from '../socket/SocketManager.js';

function fakeSocket(id = 's1') {
  return { id, connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), io: null };
}

function setup({ strict } = {}) {
  sessionStorage.clear();
  const socket = fakeSocket();
  const socketManager = new SocketManager(socket);
  socketManager._state = CONNECTION_STATE.CONNECTED;
  const gameState = new GameState();
  const logger = { log: vi.fn(), error: vi.fn() };
  const session = new ClientSession({ ...(strict === undefined ? {} : { strict }), logger });
  const teardownTable = vi.fn();
  const hooks = {};
  for (const screen of Object.values(SCREEN)) {
    hooks[screen] = { enter: vi.fn(), exit: vi.fn() };
  }
  session.attach({ socketManager, gameState });
  session.setHooks({ screens: hooks, teardownTable });
  const emitted = (event) => socket.emit.mock.calls.filter(([e]) => e === event).map(([, d]) => d);
  return { session, socket, socketManager, gameState, teardownTable, hooks, logger, emitted };
}

describe('ClientSession screen FSM', () => {
  let t;
  beforeEach(() => {
    t = setup();
  });

  it('starts in BOOT', () => {
    expect(t.session.screen).toBe(SCREEN.BOOT);
  });

  it('an illegal transition throws under Vitest', () => {
    expect(() => t.session.transition(SCREEN.GAME_END)).toThrow(IllegalTransitionError);
    t.session.transition(SCREEN.SIGN_IN);
    expect(() => t.session.transition(SCREEN.LOBBY)).toThrow(/signIn -> lobby/);
    expect(t.session.screen).toBe(SCREEN.SIGN_IN);
  });

  it('outside tests an illegal transition logs and fails closed', () => {
    t = setup({ strict: false });
    t.session.transition(SCREEN.MAIN_ROOM);
    expect(t.session.transition(SCREEN.GAME_END)).toBe(false);
    expect(t.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(t.logger.error).toHaveBeenCalledWith(expect.stringContaining('mainRoom -> gameEnd'));
    expect(t.hooks[SCREEN.MAIN_ROOM].exit).not.toHaveBeenCalled();
  });

  it('nothing transitions back to BOOT, and every screen can reach SIGN_IN', () => {
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      expect(tos, from).not.toContain(SCREEN.BOOT);
      expect(tos, from).toContain(SCREEN.SIGN_IN);
    }
  });

  it('runs exit(from) then enter(to); a self-transition re-enters without exit', () => {
    const order = [];
    t.hooks[SCREEN.BOOT].exit.mockImplementation(() => order.push('boot.exit'));
    t.hooks[SCREEN.MAIN_ROOM].enter.mockImplementation((data, ctx) => order.push(`main.enter${ctx.reenter ? '*' : ''}:${data?.n ?? '-'}`));
    t.session.transition(SCREEN.MAIN_ROOM);
    t.session.transition(SCREEN.MAIN_ROOM, { n: 1 });
    expect(order).toEqual(['boot.exit', 'main.enter:-', 'main.enter*:1']);
    expect(t.hooks[SCREEN.MAIN_ROOM].exit).not.toHaveBeenCalled();
  });
});

describe('enterTable / exitTable', () => {
  let t;
  beforeEach(() => {
    t = setup();
    t.session.transition(SCREEN.MAIN_ROOM);
  });

  it('a seat persists gameId in sessionStorage, SocketManager and GameState', () => {
    t.session.enterTable(ROLE.PLAYER, 'g1');
    expect(t.session.screen).toBe(SCREEN.TABLE);
    expect(sessionStorage.getItem('gameId')).toBe('g1');
    expect(t.socketManager._gameId).toBe('g1');
    expect(t.gameState.gameId).toBe('g1');
    expect(sessionStorage.getItem('spectatingGameId')).toBeNull();
  });

  it('a spectator persists spectatingGameId only', () => {
    t.socketManager.setGameId('stale');
    t.session.enterTable(ROLE.SPECTATOR, 'g2');
    expect(sessionStorage.getItem('spectatingGameId')).toBe('g2');
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(t.socketManager.gameId).toBeNull();
    // and its deals (no position) never persist one
    t.session.noteDeal({ gameId: 'g2' });
    expect(sessionStorage.getItem('gameId')).toBeNull();
  });

  it('exitTable tears down, clears every copy and the rejoin flags, keeps the identity, and routes to the main room', () => {
    t.gameState.username = 'me';
    t.session.enterTable(ROLE.LAZY, 'g1');
    t.session.rejoinAttempted = true;
    t.session.rejoinSucceeded = true;
    sessionStorage.setItem('spectatingGameId', 'x');

    expect(t.session.exitTable(EXIT.LEFT_GAME)).toBe(SCREEN.MAIN_ROOM);

    expect(t.teardownTable).toHaveBeenCalledWith(EXIT.LEFT_GAME);
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(sessionStorage.getItem('spectatingGameId')).toBeNull();
    expect(t.socketManager._gameId).toBeNull();
    expect(t.gameState.gameId).toBeNull();
    expect(t.session.rejoinAttempted).toBe(false);
    expect(t.session.rejoinSucceeded).toBe(false);
    expect(t.session.role).toBeNull();
    expect(t.gameState.username).toBe('me');
    expect(t.emitted('joinMainRoom')).toHaveLength(1);
  });

  it('a tournament player exits to the tournament (returnToTournament), as iOS does', () => {
    t.gameState.tournamentId = 't1';
    t.session.enterTable(ROLE.PLAYER, 'g1');
    expect(t.session.exitTable(EXIT.ABORT)).toBe(SCREEN.TOURNAMENT_LOBBY);
    expect(t.emitted('returnToTournament')).toHaveLength(1);
    expect(t.emitted('joinMainRoom')).toHaveLength(0);
    expect(t.gameState.tournamentId).toBe('t1');
  });

  it('one route request at a time: a second joinMainRoom waits for the reply', () => {
    t.gameState.tournamentId = 't1';
    t.session.enterTable(ROLE.PLAYER, 'g1');
    t.session.exitTable(EXIT.ABORT);
    t.gameState.tournamentId = null;
    expect(t.session.requestMainRoom()).toBe(false);
    t.session.routeArrived();
    expect(t.session.requestMainRoom()).toBe(true);
    expect(t.emitted('joinMainRoom')).toHaveLength(1);
  });

  it('a route request in flight expires', () => {
    vi.useFakeTimers();
    try {
      t.session.requestMainRoom();
      vi.advanceTimersByTime(ROUTE_TIMEOUT_MS + 1);
      expect(t.session.requestMainRoom()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exitTable with route:false tears down only', () => {
    t.session.enterTable(ROLE.PLAYER, 'g1');
    t.session.endGame();
    expect(t.session.exitTable(EXIT.NEW_TABLE, { route: false })).toBeNull();
    expect(t.session.screen).toBe(SCREEN.GAME_END);
    expect(t.socket.emit).not.toHaveBeenCalled();
  });

  it('endGame keeps the table on screen but leaves nothing to rejoin', () => {
    t.session.enterTable(ROLE.SPECTATOR, 'g2');
    t.session.endGame();
    expect(t.session.screen).toBe(SCREEN.GAME_END);
    expect(sessionStorage.getItem('spectatingGameId')).toBeNull();
    expect(t.session.isSpectator).toBe(true);
  });

  it('a new table from the game-end screen tears the old one down first', () => {
    t.session.enterTable(ROLE.PLAYER, 'g1');
    t.session.endGame();
    const gen = t.session.tableGeneration;
    t.session.enterTable(ROLE.PLAYER, 'g2');
    expect(t.teardownTable).toHaveBeenCalledWith(EXIT.NEW_TABLE);
    expect(t.session.tableGeneration).toBeGreaterThan(gen);
  });

  it('setRole switches between player and lazy at the same table', () => {
    t.session.enterTable(ROLE.PLAYER, 'g1');
    const gen = t.session.tableGeneration;
    t.session.setRole(ROLE.LAZY);
    expect(t.session.role).toBe(ROLE.LAZY);
    expect(sessionStorage.getItem('gameId')).toBe('g1');
    expect(t.session.tableGeneration).toBe(gen);
    expect(t.session.setRole.call(setup().session, ROLE.LAZY)).toBe(false);
  });
});

describe('session resume', () => {
  let t;
  beforeEach(() => {
    t = setup();
    sessionStorage.setItem('username', 'me');
    sessionStorage.setItem('sessionToken', 'tok');
  });

  it('nothing goes out before start(); restoreSession once per socket id after', () => {
    t.session.resume();
    expect(t.socket.emit).not.toHaveBeenCalled();
    t.session.start();
    t.session.resume();
    expect(t.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok' }]);
    t.socket.id = 's2';
    t.session.resume();
    expect(t.emitted('restoreSession')).toHaveLength(2);
  });

  it('the SocketManager connect resumes it', () => {
    t.session.start();
    t.socket.emit.mockClear();
    t.socket.id = 's9';
    t.socketManager._setState(CONNECTION_STATE.CONNECTED);
    expect(t.emitted('restoreSession')).toHaveLength(1);
  });

  it('restored: the server active game first, exactly one rejoinGame per socket', () => {
    t.session.start();
    expect(t.session.onSessionRestored({ username: 'me', activeGameId: 'g1' })).toBe('rejoin');
    expect(t.session.rejoin('g1')).toBe(false);
    expect(t.emitted('rejoinGame')).toEqual([{ gameId: 'g1', username: 'me', sessionToken: 'tok' }]);
    expect(t.gameState.username).toBe('me');
  });

  it('restored: a persisted seat rejoins, a persisted spectate re-spectates', () => {
    sessionStorage.setItem('gameId', 'g1');
    expect(t.session.onSessionRestored({ username: 'me' })).toBe('rejoin');
    sessionStorage.removeItem('gameId');
    sessionStorage.setItem('spectatingGameId', 'g2');
    t.socket.id = 's2';
    expect(t.session.onSessionRestored({ username: 'me' })).toBe('spectate');
    expect(t.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);
    expect(t.session.pendingSpectate).toBe('g2');
  });

  it('restored: re-enters the current screen', () => {
    t.session.transition(SCREEN.MAIN_ROOM);
    expect(t.session.onSessionRestored({ username: 'me' })).toBe('mainRoom');
    expect(t.emitted('joinMainRoom')).toHaveLength(1);

    t.session.routeArrived();
    t.session.transition(SCREEN.LOBBY);
    t.session.noteLobby('L1');
    expect(t.session.onSessionRestored({ username: 'me' })).toBe('lobby');
    expect(t.emitted('joinLobby')).toEqual([{ lobbyId: 'L1' }]);
    expect(t.session.takePendingLobbyRejoin()).toBe('L1');

    t.session.transition(SCREEN.MAIN_ROOM);
    t.gameState.tournamentId = 't1';
    t.session.transition(SCREEN.TOURNAMENT_LOBBY);
    expect(t.session.onSessionRestored({ username: 'me' })).toBe('tournament');
    expect(t.emitted('joinTournament')).toEqual([{ tournamentId: 't1' }]);
  });

  it('restored at a table with nothing to rejoin (a draw before seating): leaves it', () => {
    t.session.transition(SCREEN.MAIN_ROOM);
    t.session.enterTable(ROLE.PLAYER, null);
    expect(t.session.onSessionRestored({ username: 'me' })).toBe('mainRoom');
    expect(t.teardownTable).toHaveBeenCalledWith(EXIT.TABLE_LOST);
    expect(t.session.screen).toBe(SCREEN.MAIN_ROOM);
  });

  it('a repeated rejoinSuccess on the same socket is a duplicate', () => {
    t.session.transition(SCREEN.MAIN_ROOM);
    expect(t.session.noteRejoinSuccess('g1')).toBe(true);
    t.session.enterTable(ROLE.LAZY, 'g1');
    expect(t.session.noteRejoinSuccess('g1')).toBe(false);
    t.socket.id = 's2';
    expect(t.session.noteRejoinSuccess('g1')).toBe(true);
  });
});

describe('connection region', () => {
  it('follows the SocketManager: connected | reconnecting | offline', () => {
    const t = setup();
    const seen = [];
    t.session.onConnectionChange((c) => seen.push(c));
    expect(t.session.connection).toBe(CONNECTION.CONNECTED);
    t.socketManager._setState(CONNECTION_STATE.DISCONNECTED);
    t.socketManager._setState(CONNECTION_STATE.RECONNECTING);
    t.socketManager._setState(CONNECTION_STATE.CONNECTED);
    t.socketManager._emitStateChange('reconnectFailed');
    expect(seen).toEqual([CONNECTION.RECONNECTING, CONNECTION.CONNECTED, CONNECTION.OFFLINE]);

    const u = setup();
    u.socketManager._emitStateChange('disconnect', { reason: 'io server disconnect' });
    expect(u.session.connection).toBe(CONNECTION.OFFLINE);
  });
});
