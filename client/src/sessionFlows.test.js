/**
 * Screen and reconnect flows of the real page (main.js + every handler
 * module) on a fake socket and scene: server events in, the screen, the
 * DOM and the emits out (roadmap item 15). The client session
 * (state/ClientSession.js) is the one owner of the screen and the table.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  loadPage, tick, mainRoomPayload, clientState, spectatorState, seatDeal,
  tournamentPayload, litterTableDom, tableLeftovers, CLEAN,
} from './testing/fakePage.js';

vi.mock('./vendor.js', () => ({}));
vi.mock('./socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('./voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let SCREEN;
let ROLE;
let socketCount = 1;
const nextSocketId = () => `sock-${++socketCount}`;

beforeAll(async () => {
  page = await loadPage({ connected: false });
  socket = page.socket;
  ({ SCREEN, ROLE } = await import('./state/ClientSession.js'));
});

/** A known start: signed in on a fresh socket, in the main room. */
async function signIn(name = 'me') {
  // forceLogout is the page's own full reset: every screen and table goes
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(nextSocketId());
  socket.clearEmits();
  socket.fire('signInResponse', { success: true, username: name, sessionToken: `tok-${name}`, blockedUsers: [] });
  expect(socket.emitted('joinMainRoom')).toHaveLength(1);
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
  socket.clearEmits();
  page.voice.shutdown.mockClear();
}

/** Lobby -> draw -> first deal at seat 1. */
async function playGame({ gameId = 'g1', tournament = false } = {}) {
  if (!tournament) socket.fire('lobbyCreated', { lobbyId: 'L1', players: [{ username: 'me', isReady: true }], messages: [] });
  socket.fire('allPlayersReady', { gameId });
  socket.fire('startDraw', { start: true });
  socket.fire('createUI', {});
  socket.fire('gameStart', seatDeal({ gameId }));
}

/** Seated through a rejoin (gameId persisted the way a reload needs it). */
async function rejoinSeat({ gameId = 'g1', isLazy, tournamentId = null } = {}) {
  socket.reconnect(nextSocketId());
  expect(socket.emitted('restoreSession')).toHaveLength(1);
  socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: gameId, blockedUsers: [] });
  expect(socket.emitted('rejoinGame')).toEqual([{ gameId, username: 'me', sessionToken: 'tok-me' }]);
  socket.fire('rejoinSuccess', clientState({ gameId, isLazy, tournamentId }));
  await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
  socket.clearEmits();
}

function gameEndPayload(tournamentId = null) {
  return { score: { team1: 300, team2: 120 }, playerStats: {}, tournamentId };
}

function returnButton() {
  return document.querySelector('#finalScoreOverlay button, #finalScore button');
}

beforeEach(async () => {
  await signIn();
});

describe('rejoin and /leave', () => {
  it('rejoin then /leave shows the main room, and a later reconnect does not rejoin the left game', async () => {
    await rejoinSeat();
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(sessionStorage.getItem('gameId')).toBe('g1');

    socket.fire('leftGame');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());

    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    expect(tableLeftovers(page)).toEqual(CLEAN);

    socket.clearEmits();
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toHaveLength(0);
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
  });

  it("a rejoinFailed 'Already connected' keeps the table and the gameId", async () => {
    await rejoinSeat();
    socket.fire('rejoinFailed', { reason: 'Already connected' });
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(sessionStorage.getItem('gameId')).toBe('g1');
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
  });
});

describe('reconnect order: restoreSession first, then rejoin / re-spectate / re-enter', () => {
  it('a reconnect while in the main room re-registers (restoreSession) and receives chat', () => {
    socket.reconnect(nextSocketId());
    // restoreSession is the first thing the new socket sends
    expect(socket.emittedNames()[0]).toBe('restoreSession');
    expect(socket.emitted('restoreSession')).toEqual([{ username: 'me', sessionToken: 'tok-me' }]);

    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
    socket.fire('mainRoomMessage', { username: 'bob', message: 'back again', timestamp: Date.now() });

    // (the chat writes innerText, which jsdom keeps as a plain property)
    const spans = [...document.querySelectorAll('#mainRoomChatMessages span')];
    expect(spans.map((s) => s.innerText)).toContain('back again');
  });

  it('restoreSession goes out once per socket id', () => {
    const id = nextSocketId();
    socket.reconnect(id);
    socket.fire('connect');
    expect(socket.emitted('restoreSession')).toHaveLength(1);
  });

  it('a spectator reconnect re-spectates (spectators never persist gameId)', async () => {
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(page.session.role).toBe(ROLE.SPECTATOR);
    expect(sessionStorage.getItem('spectatingGameId')).toBe('g2');
    // the spectator's deal: gameId but no position
    socket.fire('gameStart', { gameId: 'g2', trump: { suit: 'clubs', rank: '5' }, score1: 0, score2: 0, dealer: 1, currentHand: 1, hand: [], playerInfo: [] });
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(page.socketManager._gameId).toBeNull();
    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());

    socket.clearEmits();
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('rejoinGame')).toHaveLength(0);
    expect(socket.emitted('joinAsSpectator')).toEqual([{ gameId: 'g2' }]);

    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
    expect(page.session.role).toBe(ROLE.SPECTATOR);
    expect(document.querySelectorAll('#gameFeed')).toHaveLength(1);
    expect(document.querySelectorAll('#spectating-indicator')).toHaveLength(1);
  });

  it('a re-spectate of a game that ended meanwhile lands in the main room', async () => {
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.clearEmits();
    socket.fire('error', { message: 'Game not found' });
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(tableLeftovers(page)).toEqual(CLEAN);
  });

  it('a reconnect in a lobby re-enters it, or lands in the main room when it closed', () => {
    socket.fire('lobbyCreated', { lobbyId: 'L9', players: [{ username: 'me', isReady: false }], messages: [] });
    expect(page.session.screen).toBe(SCREEN.LOBBY);

    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'L9' }]);
    socket.fire('lobbyCreated', { lobbyId: 'L9', players: [{ username: 'me', isReady: false }], messages: [] });
    expect(page.session.screen).toBe(SCREEN.LOBBY);
    expect(document.getElementById('gameLobbyContainer')).not.toBeNull();

    socket.clearEmits();
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    socket.fire('error', { message: 'Lobby not found' });
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(document.getElementById('gameLobbyContainer')).toBeNull();
  });

  it('a reconnect in the tournament lobby rejoins the tournament', () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(socket.emitted('joinTournament')).toEqual([{ tournamentId: 't1' }]);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
  });
});

describe('table entry and exit', () => {
  it('game end as a lazy player removes the spectating pill', async () => {
    await rejoinSeat({ isLazy: true });
    expect(page.session.role).toBe(ROLE.LAZY);
    await vi.waitFor(() => expect(document.getElementById('spectating-indicator')).not.toBeNull());

    socket.fire('gameEnd', gameEndPayload());
    expect(page.session.screen).toBe(SCREEN.GAME_END);
    expect(document.getElementById('spectating-indicator')).toBeNull();
    // nothing to rejoin from the score modal
    expect(sessionStorage.getItem('gameId')).toBeNull();

    returnButton().click();
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    expect(tableLeftovers(page)).toEqual(CLEAN);
  });

  it('signing in twice in one tab still creates a game log', async () => {
    await playGame();
    expect(document.getElementById('gameFeed')).not.toBeNull();

    // The saved session is refused on a reconnect: the sign-in screen
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: false, message: 'Invalid session token' });
    expect(page.session.screen).toBe(SCREEN.SIGN_IN);
    expect(document.getElementById('sign-in-container')).not.toBeNull();
    expect(document.getElementById('gameFeed')).toBeNull();
    await tick();

    socket.fire('signInResponse', { success: true, username: 'me', sessionToken: 'tok-me', blockedUsers: [] });
    socket.fire('mainRoomJoined', mainRoomPayload());
    await playGame({ gameId: 'g9' });
    expect(document.getElementById('gameFeed')).not.toBeNull();
    expect(document.getElementById('gameFeed').textContent).toContain('Game started!');
  });

  it('spectate then /leave, then a new game, shows the own box and the bid grid', async () => {
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
    expect(page.gameState.isSpectator).toBe(true);

    socket.fire('chatMessage', { message: '/leave' }); // nothing: the server answers
    socket.fire('leftGame');
    expect(page.gameState.isSpectator).toBe(false);
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    socket.fire('mainRoomJoined', mainRoomPayload());
    await tick();

    await playGame({ gameId: 'g3' });
    const { scene } = page;
    expect(scene.createPlayerInfoBox).toHaveBeenCalled();
    expect(scene.layoutManager.createDomBackgrounds).toHaveBeenLastCalledWith({ skipHandArea: false });
    window.dispatchEvent(new Event('trumpFlipComplete'));
    expect(scene.bidManager.showBidUI).toHaveBeenCalledWith(1, expect.any(Function));
    expect(sessionStorage.getItem('gameId')).toBe('g3');
    expect(sessionStorage.getItem('spectatingGameId')).toBeNull();
  });

  it('/leave from a tournament game returns to the tournament lobby', async () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    await playGame({ gameId: 'g7', tournament: true });
    expect(document.getElementById('tournamentLobbyContainer')).toBeNull();
    socket.clearEmits();

    socket.fire('leftGame');
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(socket.emitted('joinMainRoom')).toHaveLength(0);
    expect(page.session.screen).toBe(SCREEN.TOURNAMENT_LOBBY);

    socket.fire('tournamentJoined', tournamentPayload({ phase: 'round_active' }));
    expect(document.getElementById('tournamentLobbyContainer')).not.toBeNull();
    expect(tableLeftovers(page)).toEqual(CLEAN);
  });

  it('abortGame then tournamentCancelled sends one joinMainRoom at most', async () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    await playGame({ gameId: 'g7', tournament: true });
    socket.clearEmits();

    socket.fire('abortGame', { reason: 'Tournament cancelled' });
    socket.fire('tournamentCancelled', {});
    const routes = socket.emitted('joinMainRoom').length + socket.emitted('returnToTournament').length;
    expect(socket.emitted('joinMainRoom').length).toBeLessThanOrEqual(1);
    expect(routes).toBe(1);

    // The server answers the returnToTournament of a cancelled tournament
    socket.fire('tournamentLeft', {});
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    expect(page.gameState.tournamentId).toBeNull();
  });

  it('abortGame then tournamentCancelled before the draw (still in the tournament lobby) sends one route', () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    socket.fire('allPlayersReady', { gameId: 'g7' });
    socket.clearEmits();

    socket.fire('abortGame', { reason: 'Tournament cancelled' });
    socket.fire('tournamentCancelled', {});
    expect(socket.emitted('joinMainRoom').length + socket.emitted('returnToTournament').length).toBe(1);
  });

  it('a reconnect at a tournament draw whose table ended offline returns to the tournament lobby', async () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    socket.fire('allPlayersReady', { gameId: 'g7' });
    socket.fire('startDraw', { start: true });
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(sessionStorage.getItem('gameId')).toBeNull(); // persisted at the deal only

    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', activeTournamentId: 't1', blockedUsers: [] });
    expect(socket.emitted('joinTournament')).toHaveLength(0);
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(page.session.screen).toBe(SCREEN.TOURNAMENT_LOBBY);
    socket.fire('tournamentJoined', tournamentPayload({ phase: 'round_active' }));
    expect(document.getElementById('tournamentLobbyContainer')).not.toBeNull();
    expect(tableLeftovers(page)).toEqual(CLEAN);
  });

  it('a tournament spectator who watches a table and types /leave gets the lobby without player controls', async () => {
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'bob' }), players: [{ username: 'bob', isReady: false, isCreator: true }], isSpectator: true });
    expect(document.getElementById('tournamentReadyBtn')).toBeNull();
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g7' }));
    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
    socket.clearEmits();

    socket.fire('leftGame');
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    // the server's reply to returnToTournament carries no isSpectator flag
    socket.fire('tournamentJoined', { ...tournamentPayload({ creator: 'bob', phase: 'round_active' }), players: [{ username: 'bob', isReady: false, isCreator: true }] });
    expect(document.getElementById('tournamentLobbyContainer')).not.toBeNull();
    expect(document.getElementById('tournamentReadyBtn')).toBeNull();

    // leaving it forgets the spectator flag: a later real join is a player's
    socket.fire('tournamentLeft', {});
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(sessionStorage.getItem('tournamentSpectate')).toBeNull();
    socket.fire('tournamentJoined', tournamentPayload({ creator: 'bob' }));
    expect(document.getElementById('tournamentReadyBtn')).not.toBeNull();
  });

  it('tournamentCancelled in the tournament lobby sends exactly one joinMainRoom', () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.fire('tournamentCancelled', {});
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.session.screen).toBe(SCREEN.MAIN_ROOM);
    expect(document.getElementById('tournamentLobbyContainer')).toBeNull();
  });

  it('a new tournament round while the score modal is up tears the finished table down first', async () => {
    socket.fire('tournamentJoined', tournamentPayload());
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    await playGame({ gameId: 'g7', tournament: true });
    socket.fire('gameEnd', gameEndPayload('t1'));
    expect(returnButton().textContent).toBe('Return to Tournament');

    socket.fire('tournamentGameAssignment', { gameId: 'g8', tournamentId: 't1', roundNumber: 2 });
    socket.fire('allPlayersReady', { gameId: 'g8' });
    socket.fire('startDraw', { start: true });
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(returnButton()).toBeNull();
    // the draw reaches the restarted scene
    await vi.waitFor(() => expect(page.scene.handleStartDraw).toHaveBeenCalled());
    expect(page.gameState.tournamentId).toBe('t1');
  });

  it('playerReconnected dismisses that seat\'s resignation dialog', async () => {
    await rejoinSeat();
    socket.fire('resignationAvailable', { position: 2, username: 'bob' });
    expect(document.getElementById('resignation-dialog')).not.toBeNull();
    socket.fire('playerReconnected', { position: 3, username: 'cat' });
    expect(document.getElementById('resignation-dialog')).not.toBeNull();
    socket.fire('playerReconnected', { position: 2, username: 'bob' });
    expect(document.getElementById('resignation-dialog')).toBeNull();
  });

  it('restorePlayerState rebuilds the table in place: same seat, gameId kept, the open offer stays', async () => {
    await rejoinSeat();
    socket.fire('resignationAvailable', { position: 2, username: 'bob' });
    page.voice.shutdown.mockClear();
    socket.fire('restorePlayerState', clientState({ gameId: 'g1' }));
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(page.session.role).toBe(ROLE.PLAYER);
    expect(sessionStorage.getItem('gameId')).toBe('g1');
    expect(document.getElementById('resignation-dialog')).not.toBeNull();
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
  });

  it('a stale mainRoomJoined at the table is ignored', async () => {
    await rejoinSeat();
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.screen).toBe(SCREEN.TABLE);
    expect(document.getElementById('mainRoomContainer')).toBeNull();
  });
});

describe('each exit path leaves no table DOM and no gameId copy', () => {
  const exits = [
    ['game end Return to Lobby', async () => {
      socket.fire('gameEnd', gameEndPayload());
      litterTableDom();
      returnButton().click();
      return { route: 'joinMainRoom' };
    }],
    ['/leave (leftGame)', async () => {
      socket.fire('leftGame');
      return { route: 'joinMainRoom' };
    }],
    ['abortGame', async () => {
      socket.fire('abortGame', { reason: 'All players left' });
      return { route: 'joinMainRoom' };
    }],
    ['rejoinFailed', async () => {
      socket.reconnect(nextSocketId());
      socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: 'g1', blockedUsers: [] });
      socket.fire('rejoinFailed', { reason: 'Game no longer exists' });
      return { route: 'joinMainRoom' };
    }],
    ['forceLogout (sign-in screen)', async () => {
      socket.fire('forceLogout');
      return { route: null, screen: 'signIn' };
    }],
    ['a refused session restore (sign-in screen)', async () => {
      socket.reconnect(nextSocketId());
      socket.fire('restoreSessionResponse', { success: false, message: 'Invalid session token' });
      return { route: null, screen: 'signIn' };
    }],
    ['reconnect_failed (sign-in screen)', async () => {
      socket.fireIo('reconnect_failed');
      return { route: null, screen: 'signIn' };
    }],
    ['tournamentCancelled on the score modal', async () => {
      page.gameState.tournamentId = 't1';
      socket.fire('gameEnd', gameEndPayload('t1'));
      litterTableDom();
      socket.fire('tournamentCancelled', {});
      return { route: 'joinMainRoom' };
    }],
    ['returnToTournament (game end in a tournament)', async () => {
      socket.fire('gameEnd', gameEndPayload('t1'));
      litterTableDom();
      returnButton().click();
      return { route: 'returnToTournament', screen: 'tournamentLobby' };
    }],
  ];

  it.each(exits)('%s', async (_name, exit) => {
    await rejoinSeat();
    litterTableDom();
    sessionStorage.setItem('spectatingGameId', 'stale');
    expect(tableLeftovers(page)).not.toEqual(CLEAN);
    socket.clearEmits();

    const { route, screen = 'mainRoom' } = await exit();

    expect(tableLeftovers(page)).toEqual(CLEAN);
    expect(page.session.screen).toBe(screen);
    expect(page.voice.shutdown).toHaveBeenCalled();
    if (route) expect(socket.emitted(route)).toHaveLength(1);
    else expect(socket.emitted('joinMainRoom')).toHaveLength(0);
    // the scene restarts and registers again
    await tick();
    expect(window.gameScene).toBe(page.scene);
  });
});

describe('identity and errors', () => {
  it('the username survives a game (lobby ready state and voice read it)', async () => {
    await playGame();
    socket.fire('leftGame');
    expect(page.gameState.username).toBe('me');
    const { getUIManager } = await import('./ui/UIManager.js');
    expect(getUIManager()._username).toBe('me');
  });

  it('UIManager reads the screen from the client session', async () => {
    const { getUIManager, SCREENS } = await import('./ui/UIManager.js');
    expect(getUIManager().getCurrentScreen()).toBe(SCREENS.MAIN_ROOM);
    socket.fire('lobbyCreated', { lobbyId: 'L1', players: [], messages: [] });
    expect(getUIManager().isScreen(SCREENS.GAME_LOBBY)).toBe(true);
  });

  it('a specific server error message reaches the player', () => {
    socket.fire('error', { message: 'Not all players are ready' });
    const toast = document.querySelector('.error-toast');
    expect(toast.textContent).toBe('Not all players are ready');
  });

  it("a spectator's score header names the seats, not '<me>/null'", async () => {
    socket.fire('spectatorJoined', spectatorState({ gameId: 'g2' }));
    // a spectator deal names the seats (setPlayerData at view seat 1)
    socket.fire('gameStart', {
      gameId: 'g2', trump: { suit: 'clubs', rank: '5' }, score1: 0, score2: 0, dealer: 1, currentHand: 1, hand: [],
      playerInfo: spectatorState().players.map(({ position, username, pic }) => ({ position, username, pic })),
    });
    // the spectator's view seat is someone else's: the identity stays
    expect(page.gameState.username).toBe('me');
    const { GameScene } = await import('./phaser/scenes/GameScene.js');
    const spy = vi.spyOn(window, 'updateGameLogScoreFromLegacy');
    GameScene.prototype.updateGameLogAfterTrick.call({ state: page.gameState });
    const [teamNames, oppNames] = spy.mock.calls.at(-1);
    expect(teamNames).toBe('ann/cat');
    expect(oppNames).toBe('bob/dan');
    spy.mockRestore();
  });
});
