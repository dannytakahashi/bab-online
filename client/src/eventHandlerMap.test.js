/**
 * Each server event the web client handles reaches exactly one handler.
 *
 * main.js used to attach ~34 `scene.handleX = function` fallbacks in
 * setGameScene behind `if (!scene.handleX)`; GameScene's own methods made
 * most of them unreachable, and nothing told which copy ran. This loads the
 * real entry module (Phaser and the socket faked), registers every handler
 * module as the page does, and checks the event -> handler map.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import mainSource from './main.js?raw';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// One fake socket for the page: records every listener, fires them on demand
const listeners = new Map();
const socket = {
  connected: false,
  id: 'test-socket',
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return socket;
  },
  once(event, fn) { return socket.on(event, fn); },
  off(event, fn) {
    listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn));
    return socket;
  },
  onAny() {},
  emit() {},
  connect() {},
  disconnect() {},
  io: { on() {}, off() {} },
};
function fire(event, data) {
  for (const fn of [...(listeners.get(event) || [])]) fn(data);
}

// Phaser is bundled by vendor.js in production; the scene only needs a base class
globalThis.Phaser = { Scene: class {}, Game: class {}, AUTO: 0, Scale: {} };
vi.mock('./vendor.js', () => ({}));
vi.mock('./socket/createSocket.js', () => ({ createSocket: () => socket }));

let SERVER_EVENTS;
let SocketManager;
let GameScene;
// event -> number of registrations made through SocketManager.on/onGame
const managed = new Map();
// events main.js listens to directly on the socket (module level)
let direct;

beforeAll(async () => {
  ({ SERVER_EVENTS } = await import('./constants/events.js'));
  ({ SocketManager } = await import('./socket/SocketManager.js'));
  ({ GameScene } = await import('./phaser/scenes/GameScene.js'));
  for (const method of ['on', 'onGame']) {
    const original = SocketManager.prototype[method];
    vi.spyOn(SocketManager.prototype, method).mockImplementation(function (event, cb) {
      managed.set(event, (managed.get(event) || 0) + 1);
      return original.call(this, event, cb);
    });
  }
  await import('./main.js');
  // module-level listeners exist now; the handler modules register on load
  direct = new Set(listeners.keys());
  window.dispatchEvent(new Event('load'));
});

describe('server event -> handler map', () => {
  it('every event the handler modules register is a server event, registered once', () => {
    const known = new Set(Object.values(SERVER_EVENTS));
    expect(managed.size).toBeGreaterThan(50);
    for (const [event, count] of managed) {
      expect(known.has(event), `${event} is not in SERVER_EVENTS`).toBe(true);
      expect(count, `${event} registered ${count} times`).toBe(1);
    }
  });

  it('every sequenced event (contract seq: true) has a handler, registered through the seq gate', async () => {
    const root = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');
    const schema = JSON.parse(readFileSync(resolve(root, 'contract/events.schema.json'), 'utf8'));
    const sequenced = Object.entries(schema.s2c).filter(([, e]) => e.seq).map(([name]) => name);
    expect(sequenced.length).toBeGreaterThan(20);
    // an unhandled one would leave a hole in the count: every next event a gap
    expect(sequenced.filter((e) => !managed.has(e))).toEqual([]);
    const { getSocketManager } = await import('./socket/SocketManager.js');
    expect(getSocketManager()._gate).toBeTruthy();
    // the replies that carry a snapshot reach one handler each too
    for (const e of ['stateSnapshot', 'actionRejected', 'rejoinSuccess', 'restorePlayerState']) expect(managed.get(e), e).toBe(1);
  });

  it('main.js direct listeners are server events and never overlap the handler modules', () => {
    const known = new Set(Object.values(SERVER_EVENTS));
    for (const event of direct) expect(known.has(event), event).toBe(true);
    // The session/reconnection bookkeeping (rejoin flags, gameId copies)
    // that used to run next to the handler modules is the client session's
    // now (state/ClientSession.js), reached from the one handler
    const overlap = [...direct].filter((e) => managed.has(e)).sort();
    expect(overlap).toEqual([]);
  });

  it('no listener for an event the server never sends, but activeGameFound (V1_REMOVALS #3)', () => {
    const root = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');
    const schema = JSON.parse(readFileSync(resolve(root, 'contract/events.schema.json'), 'utf8'));
    const neverSent = Object.entries(schema.s2c).filter(([, e]) => e.status === 'clientOnly').map(([name]) => name);
    expect(neverSent).toEqual(expect.arrayContaining(['lobbyJoined', 'roomFull', 'activeTournamentFound', 'activeGameFound']));
    const heard = (e) => managed.has(e) || (listeners.get(e) || []).length > 0;
    // activeGameFound stays: a possible server hook to nudge an old app back into its game
    expect(neverSent.filter((e) => e !== 'activeGameFound' && heard(e))).toEqual([]);
    expect(heard('activeGameFound')).toBe(true);
  });

  it('no playerAssigned listener: my seat comes from positionUpdate / gameStart / the snapshot (V1_REMOVALS #7)', () => {
    expect(managed.has('playerAssigned')).toBe(false);
    expect((listeners.get('playerAssigned') || []).length).toBe(0);
  });

  it('app-level errors are heard on serverError only: the v1 error is gone (V1_REMOVALS #1 phase B)', () => {
    expect((listeners.get('error') || []).length).toBe(0);
    expect((listeners.get('serverError') || []).length).toBe(1);
  });

  it('setGameScene adds no handler functions to the scene (GameScene owns them all)', () => {
    const scene = new GameScene();
    const before = new Set(Object.keys(scene));
    window.ModernUtils.setGameScene(scene);
    const added = Object.keys(scene).filter((k) => !before.has(k));
    expect(added.filter((k) => typeof scene[k] === 'function')).toEqual([]);
    expect(window.gameScene).toBe(scene);
  });

  it('every scene method main.js calls is defined on GameScene (a missing one would be skipped by its guard)', () => {
    const called = new Set();
    // scene.x(, scene?.x(, scene.x?.( and scene.x && ...
    for (const m of mainSource.matchAll(/(?<![\w.$])scene\??\.([a-zA-Z_]\w*)\s*(?:\(|\)|&&|\?\.\()/g)) called.add(m[1]);
    // Phaser's own scene members, the managers and private fields
    const phaser = new Set(['scene', 'children', 'game']);
    const sceneMethods = [...called].filter((n) => !phaser.has(n) && !/Manager$/.test(n) && !n.startsWith('_'));
    expect(sceneMethods.length).toBeGreaterThan(20);
    for (const name of sceneMethods) {
      expect(typeof GameScene.prototype[name], `GameScene.${name}`).toBe('function');
    }
  });

  describe('table events dispatch to exactly one GameScene handler', () => {
    // event -> the GameScene method it ends in (payloads: just what the
    // handler modules read before dispatching)
    const table = [
      ['startDraw', 'handleStartDraw', {}],
      ['youDrew', 'handleYouDrew', { card: { suit: 'spades', rank: 'A' } }],
      ['playerDrew', 'handlePlayerDrew', { username: 'a', card: { suit: 'spades', rank: 'A' } }],
      ['teamsAnnounced', 'handleTeamsAnnounced', { team1: ['a', 'b'], team2: ['c', 'd'] }],
      ['createUI', 'handleCreateUI', {}],
      ['bidReceived', 'handleBidReceived', { position: 2, bid: '3', bidArray: [] }],
      ['doneBidding', 'handleDoneBidding', { bids: ['1', '2', '3', '4'], lead: 1 }],
      ['updateTurn', 'handleUpdateTurn', { currentTurn: 1 }],
      ['cardPlayed', 'handleCardPlayed', { card: { suit: 'spades', rank: 'A' }, position: 2 }],
      ['trickComplete', 'handleTrickComplete', { winner: 1 }],
      ['handComplete', 'handleHandComplete', { score: { team1: 0, team2: 0 } }],
      ['rainbow', 'handleRainbow', { position: 1 }],
      ['destroyHands', 'handleDestroyHands', {}],
      ['playerResigned', 'handlePlayerResigned', { position: 2, oldUsername: 'a', botUsername: 'b' }],
      ['playerLazyMode', 'handlePlayerLazyMode', { position: 2, botUsername: 'b' }],
      ['playerActiveMode', 'handlePlayerActiveMode', { position: 2, username: 'a' }],
      ['chatMessage', 'handleShowChatBubble', { username: 'a', position: 2, message: 'hi' }],
      ['abortGame', 'handleAbortGame', { reason: 'test' }],
    ];
    const handlerNames = [...new Set(table.map(([, h]) => h).concat('handleAddToGameFeed'))];
    let spies;

    function mountScene() {
      const scene = new GameScene();
      scene.scene = { restart: vi.fn() };
      scene.children = { removeAll: vi.fn() };
      // A created scene has its managers: the director runs table work only then
      scene.cardManager = { clearAll: vi.fn() };
      window.ModernUtils.setGameScene(scene);
      return scene;
    }

    afterEach(() => {
      spies?.forEach((s) => s.mockRestore());
    });

    it.each(table)('%s -> GameScene.%s, once', async (event, handler, data) => {
      spies = handlerNames.map((n) => vi.spyOn(GameScene.prototype, n).mockImplementation(() => {}));
      const { getGameState } = await import('./state/GameState.js');
      getGameState().position = 1;
      mountScene();

      fire(event, data);

      const calls = Object.fromEntries(handlerNames.map((n, i) => [n, spies[i].mock.calls.length]));
      const expected = Object.fromEntries(handlerNames.map((n) => [n, n === handler ? 1 : 0]));
      // chat also writes the game log line through the scene
      if (event === 'chatMessage') expected.handleAddToGameFeed = 1;
      expect(calls).toEqual(expected);
    });
  });
});
