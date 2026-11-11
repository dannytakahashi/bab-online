/**
 * Test harness: the real web client entry (main.js) on a fake socket, a
 * fake Phaser scene and a fake voice manager, so tests can drive server
 * events through every registered handler and assert the screen, the DOM
 * and what the page emits. Each test file is one page load (Vitest isolates
 * modules per file); a "reload" test sets sessionStorage before loadPage().
 *
 * Every test file using it must mock, at its top level:
 *   vi.mock('../vendor.js', () => ({}));
 *   vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
 *   vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));
 * (paths relative to the test file).
 */
import { vi } from 'vitest';

export function createFakeSocket({ id = 'sock-1', connected = false } = {}) {
  const listeners = new Map();
  const ioListeners = new Map();
  const add = (map, event, fn) => {
    if (!map.has(event)) map.set(event, []);
    map.get(event).push(fn);
  };
  const socket = {
    id,
    connected,
    emits: [],
    on(event, fn) {
      add(listeners, event, fn);
      return socket;
    },
    once(event, fn) {
      const wrapped = (...args) => {
        socket.off(event, wrapped);
        fn(...args);
      };
      return socket.on(event, wrapped);
    },
    off(event, fn) {
      listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn));
      return socket;
    },
    onAny() {},
    emit(event, data) {
      socket.emits.push([event, data]);
      return socket;
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    io: {
      on(event, fn) {
        add(ioListeners, event, fn);
      },
      off() {},
    },
    /** Deliver a server event to every listener. */
    fire(event, data) {
      for (const fn of [...(listeners.get(event) || [])]) fn(data);
    },
    fireIo(event, data) {
      for (const fn of [...(ioListeners.get(event) || [])]) fn(data);
    },
    /** Payloads the page emitted for an event. */
    emitted(event) {
      return socket.emits.filter(([e]) => e === event).map(([, d]) => d);
    },
    emittedNames() {
      return socket.emits.map(([e]) => e).filter((e) => e !== 'clientHello');
    },
    clearEmits() {
      socket.emits.length = 0;
    },
    /** A new transport connection (a reconnect gets a new socket id). */
    reconnect(newId) {
      socket.connected = false;
      socket.fire('disconnect', 'transport close');
      socket.id = newId;
      socket.connected = true;
      socket.fire('connect');
    },
  };
  return socket;
}

export function createFakeVoice() {
  return {
    active: false,
    peers: new Map(),
    initialize: vi.fn(async function initialize() {
      this.active = true;
    }),
    shutdown: vi.fn(function shutdown() {
      this.active = false;
    }),
    onSpeakingChange: vi.fn(),
    toggleSelfMute: vi.fn(() => false),
    connectToPeer: vi.fn(),
    removePeer: vi.fn(),
    handleOffer: vi.fn(),
    handleAnswer: vi.fn(),
    handleIceCandidate: vi.fn(),
    onIceServers: vi.fn(),
    isUnavailable: vi.fn(() => false),
    getPeers: vi.fn(() => []),
    isSpeaking: vi.fn(() => false),
    isPeerMuted: vi.fn(() => false),
    selfMuted: false,
  };
}

// Any property is a (cached) vi.fn: stands in for a scene manager
function autoMock() {
  const cache = {};
  return new Proxy(cache, {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (!(key in target)) target[key] = vi.fn();
      return target[key];
    },
  });
}

/**
 * A fake GameScene: every method is a vi.fn (handleCreateUI runs its UI
 * callback, as the real fade does), the managers are auto-mocks, and
 * scene.restart re-registers the same object with fresh managers on the
 * next tick (Phaser restarts a scene on its next step and create() calls
 * setGameScene).
 */
export function createFakeScene() {
  const freshManagers = () => ({
    cardManager: autoMock(),
    bidManager: autoMock(),
    trickManager: autoMock(),
    opponentManager: autoMock(),
    layoutManager: autoMock(),
    effectsManager: autoMock(),
    drawManager: autoMock(),
  });
  const base = {
    _playerInfo: null,
    restarts: 0,
    game: null,
    children: { removeAll: vi.fn() },
    ...freshManagers(),
  };
  const scene = new Proxy(base, {
    get(target, key) {
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (!(key in target)) target[key] = vi.fn();
      return target[key];
    },
  });
  base.handleCreateUI = vi.fn((data, onUIReady) => onUIReady?.());
  base.createPlayerInfoBox = vi.fn(() => {
    base._playerInfo = { avatarContainer: null };
  });
  base.clearPlayerInfo = vi.fn(() => {
    base._playerInfo = null;
  });
  base.scene = {
    restart: vi.fn(() => {
      base.restarts++;
      setTimeout(() => {
        Object.assign(base, freshManagers());
        base._playerInfo = null;
        window.ModernUtils.setGameScene(scene);
      }, 0);
    }),
  };
  return scene;
}

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load the page: sessionStorage first (a reload), then main.js and the
 * window load event. Returns the page's handles.
 */
export async function loadPage({ session = {}, connected = true, socketId = 'sock-1', realScene = false, createScene = true } = {}) {
  if (realScene) {
    // The real GameScene and managers on testing/fakePhaser.js
    const { installFakePhaser } = await import('./fakePhaser.js');
    installFakePhaser();
  } else {
    globalThis.Phaser = { Scene: class {}, Game: class {}, AUTO: 0, Scale: {} };
  }
  sessionStorage.clear();
  try { window.localStorage?.clear(); } catch { /* no storage in this environment */ }
  for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, v);
  const socket = createFakeSocket({ id: socketId, connected });
  const voice = createFakeVoice();
  globalThis.__fakeSocket = socket;
  globalThis.__fakeVoice = voice;
  // jsdom has no WebRTC/getUserMedia: the voice manager is faked
  window.alert = vi.fn();

  await import('../main.js');
  window.dispatchEvent(new Event('load'));

  const { getClientSession } = await import('../state/ClientSession.js');
  const { getGameState } = await import('../state/GameState.js');
  const { getSocketManager } = await import('../socket/SocketManager.js');
  let scene;
  let makeScene = () => scene;
  if (realScene) {
    const { GameScene } = await import('../phaser/scenes/GameScene.js');
    scene = new GameScene();
    // Phaser runs create() once its preload is done (createScene: false: later)
    makeScene = () => {
      scene.create();
      return scene;
    };
    if (createScene) makeScene();
  } else {
    scene = createFakeScene();
    window.ModernUtils.setGameScene(scene);
  }

  return {
    socket,
    voice,
    scene,
    createScene: makeScene,
    session: getClientSession(),
    gameState: getGameState(),
    socketManager: getSocketManager(),
  };
}

// ---------- payload builders (the server's shapes, trimmed) ----------

export function players(names = ['me', 'bob', 'cat', 'dan']) {
  return names.map((username, i) => ({ position: i + 1, username, socketId: `s-${username}`, pic: 1 }));
}

export function mainRoomPayload(extra = {}) {
  return { messages: [], recentMessages: [], lobbies: [], onlineCount: 1, onlineUsers: ['me'], inProgressGames: [], tournaments: [], ...extra };
}

export function clientState({ gameId = 'g1', position = 1, names, isLazy, tournamentId, gameLog } = {}) {
  const state = {
    gameId,
    position,
    hand: [{ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: '2' }],
    trump: { suit: 'clubs', rank: '5' },
    dealer: 2,
    currentTurn: 3,
    bidding: false,
    playedCards: [null, null, null, null],
    score: { team1: 10, team2: 20 },
    tricks: { team1: 0, team2: 0 },
    playerBids: ['1', '1', '1', '1'],
    currentHand: 2,
    gameLog: gameLog || [{ message: 'Hand 1 started' }, { message: 'Hand 2 started' }],
    players: players(names),
  };
  if (isLazy !== undefined) state.isLazy = isLazy;
  if (tournamentId !== undefined) state.tournamentId = tournamentId;
  return state;
}

export function spectatorState({ gameId = 'g2', names = ['ann', 'bob', 'cat', 'dan'] } = {}) {
  return {
    gameId,
    players: players(names),
    trump: { suit: 'clubs', rank: '5' },
    score: { team1: 0, team2: 0 },
    tricks: { team1: 0, team2: 0 },
    playerBids: [],
    bidding: true,
    currentHand: 1,
    dealer: 1,
    playedCards: [null, null, null, null],
    gameLog: [{ message: 'Game started!' }],
  };
}

export function seatDeal({ gameId = 'g1', position = 1 } = {}) {
  return {
    gameId,
    players: ['s-me', 's-bob', 's-cat', 's-dan'],
    hand: [{ suit: 'spades', rank: 'A' }],
    trump: { suit: 'clubs', rank: '5' },
    score1: 0,
    score2: 0,
    dealer: 2,
    position,
    currentHand: 1,
    hsiValues: { 1: 1, 2: 1, 3: 1, 4: 1 },
    playerInfo: players().map(({ position: p, username, pic }) => ({ position: p, username, pic })),
  };
}

export function tournamentPayload({ tournamentId = 't1', creator = 'me', phase = 'lobby' } = {}) {
  return {
    tournamentId,
    creatorUsername: creator,
    phase,
    players: [{ username: 'me', isReady: false, isCreator: creator === 'me', connected: true }],
    messages: [],
    scoreboard: [],
    currentRound: 0,
    totalRounds: 4,
  };
}

/** Litter the page with every piece of game-owned DOM an exit must remove. */
export function litterTableDom() {
  const make = (id, cls) => {
    const el = document.createElement('div');
    if (id) el.id = id;
    if (cls) el.className = cls;
    document.body.appendChild(el);
    return el;
  };
  make('transition-overlay');
  make('spectating-indicator');
  make('resignation-dialog').dataset.position = '2';
  make(null, 'chat-bubble');
  make(null, 'chat-bubble bid');
}

/** What an exit must leave: no table DOM, no gameId copy anywhere. */
export function tableLeftovers(page) {
  return {
    transitionOverlay: !!document.getElementById('transition-overlay'),
    spectatingIndicator: !!document.getElementById('spectating-indicator'),
    resignationDialog: !!document.getElementById('resignation-dialog'),
    bubbles: document.querySelectorAll('.chat-bubble').length,
    gameFeed: !!document.getElementById('gameFeed'),
    storageGameId: sessionStorage.getItem('gameId'),
    storageSpectatingGameId: sessionStorage.getItem('spectatingGameId'),
    socketManagerGameId: page.socketManager._gameId,
    gameStateGameId: page.gameState.gameId,
  };
}

export const CLEAN = {
  transitionOverlay: false,
  spectatingIndicator: false,
  resignationDialog: false,
  bubbles: 0,
  gameFeed: false,
  storageGameId: null,
  storageSpectatingGameId: null,
  socketManagerGameId: null,
  gameStateGameId: null,
};
