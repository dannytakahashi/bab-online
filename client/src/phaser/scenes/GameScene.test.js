import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// Phaser is a CDN global in production; the scene only needs a base class here
globalThis.Phaser = { Scene: class Scene {} };

vi.mock('../managers/LayoutManager.js', () => ({ LayoutManager: class { update() {} } }));
vi.mock('../managers/CardManager.js', () => ({ CardManager: class {} }));
vi.mock('../managers/OpponentManager.js', () => ({ OpponentManager: class {} }));
vi.mock('../managers/TrickManager.js', () => ({ TrickManager: class {} }));
vi.mock('../managers/EffectsManager.js', () => ({ EffectsManager: class {} }));
vi.mock('../managers/DrawManager.js', () => ({ DrawManager: class {} }));
vi.mock('../managers/BidManager.js', () => ({ BidManager: class {} }));

// Minimal event emitter with the on/off/once/emit surface Phaser exposes
function createEmitter(extra = {}) {
  const listeners = new Map();
  const emitter = {
    ...extra,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push({ fn, once: false });
      return emitter;
    },
    once(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push({ fn, once: true });
      return emitter;
    },
    off(event, fn) {
      listeners.set(event, (listeners.get(event) || []).filter((l) => l.fn !== fn));
      return emitter;
    },
    emit(event, ...args) {
      const current = listeners.get(event) || [];
      listeners.set(event, current.filter((l) => !l.once));
      current.forEach((l) => l.fn(...args));
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
  };
  return emitter;
}

let GameScene;

beforeAll(async () => {
  ({ GameScene } = await import('./GameScene.js'));
});

describe('GameScene resize listener', () => {
  it('keeps a single scale resize listener across scene restarts', () => {
    const scene = new GameScene();
    // ScaleManager is game-wide and outlives restarts; scene events do not
    scene.scale = createEmitter({ width: 1920, height: 953 });
    scene.events = createEmitter();
    scene.handleResize = vi.fn();

    for (let i = 0; i < 3; i++) {
      scene.create();
      expect(scene.scale.listenerCount('resize')).toBe(1);
      scene.events.emit('shutdown');
    }
    expect(scene.scale.listenerCount('resize')).toBe(0);

    scene.create();
    scene.scale.emit('resize', { width: 800, height: 600 });
    expect(scene.handleResize).toHaveBeenCalledTimes(1);
    expect(scene.handleResize).toHaveBeenCalledWith(800, 600);
  });
});

describe('GameScene preload', () => {
  it('does not preload profile avatars as textures', () => {
    const scene = new GameScene();
    const image = vi.fn();
    scene.load = { atlas: vi.fn(), image };

    scene.preload();

    const keys = image.mock.calls.map(([key]) => key);
    expect(keys.some((key) => key.startsWith('profile'))).toBe(false);
    expect(keys).not.toContain('background');
    // Textures the scene does draw are still loaded
    expect(keys).toEqual(expect.arrayContaining(['cardBack', 'rainbow', 'ot', 'b', '2b', '3b', '4b']));
  });
});

describe('GameScene handleCardPlayed (opponent)', () => {
  it('records the slot and keeps the move tween handle so a trick can cancel it', () => {
    const scene = new GameScene();
    const sprite = { setData: vi.fn(), setDepth: vi.fn(), x: 0, y: 0, scene: {} };
    const moveTween = { stop: vi.fn() };
    const flipTimer = { remove: vi.fn() };
    scene.state = { position: 1, currentTrick: [{}, {}], isSpectator: false, isLazy: false };
    scene.callbacks = {};
    scene.tweens = { add: vi.fn(() => moveTween) };
    scene.time = { delayedCall: vi.fn(() => flipTimer) };
    scene.opponentManager = { removeCard: vi.fn(() => sprite) };
    scene.trickManager = {
      setPlayerPosition: vi.fn(),
      updatePlayPositions: vi.fn(),
      getRelativePositionKey: vi.fn(() => 'opponent1'),
      _playPositions: { opponent1: { x: 100, y: 200 } },
      _stopCardAnimations: vi.fn(),
      _currentTrick: [],
    };

    scene.handleCardPlayed({ card: { suit: 'spades', rank: 'A' }, position: 2 });

    // Deal tweens queued while hidden are cancelled through the held handle too
    expect(scene.trickManager._stopCardAnimations).toHaveBeenCalledWith(sprite);
    expect(sprite.setData).toHaveBeenCalledWith('playPosition', 'opponent1');
    expect(sprite.setData).toHaveBeenCalledWith('moveTween', moveTween);
    expect(sprite.setData).toHaveBeenCalledWith('flipTimer', flipTimer);
    expect(scene.trickManager._currentTrick).toEqual([sprite]);
  });
});

describe('GameScene handleHandComplete', () => {
  it('logs and scores the final 13-card hand', () => {
    const scene = new GameScene();
    scene.state = { position: 2, playerData: {}, bids: {} };
    scene.callbacks = {};
    const formatHandCompleteMessages = vi.fn(() => ['hand line 1', 'hand line 2']);
    window.ModernUtils = {
      formatHandCompleteMessages,
      getTeamNames: vi.fn(() => ({ teamName: 'Us', oppName: 'Them' })),
    };
    window.addToGameFeedFromLegacy = vi.fn();
    window.updateGameLogScoreFromLegacy = vi.fn();

    try {
      scene.handleHandComplete({
        team1Tricks: 7,
        team2Tricks: 6,
        score: { team1: 120, team2: -40 },
        team1OldScore: 50,
        team2OldScore: 20,
      });

      // Position 2 is on team 2, so team/opp values are swapped
      expect(scene.state.teamScore).toBe(-40);
      expect(scene.state.oppScore).toBe(120);
      expect(formatHandCompleteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ teamTricks: 6, oppTricks: 7, teamOldScore: 20, oppOldScore: 50 })
      );
      expect(window.addToGameFeedFromLegacy).toHaveBeenCalledWith('hand line 1');
      expect(window.addToGameFeedFromLegacy).toHaveBeenCalledWith('hand line 2');
      expect(window.updateGameLogScoreFromLegacy).toHaveBeenCalledWith('Us', 'Them', -40, 120);
    } finally {
      delete window.ModernUtils;
      delete window.addToGameFeedFromLegacy;
      delete window.updateGameLogScoreFromLegacy;
    }
  });
});

describe('GameScene handleUpdateTurn legality gate (collect before the next card is legal)', () => {
  function sceneFor({ collecting }) {
    const scene = new GameScene();
    let pending = [];
    scene.state = {
      position: 1, currentTurn: 1, isSpectator: false, isLazy: false, isBidding: false, hasPlayedCard: false,
      myCards: [], playedCardIndex: 0, trump: null, trumpBroken: false, leadCard: null, leadPosition: null,
    };
    scene.callbacks = {};
    scene.cardManager = { updatePlayerTurnGlow: vi.fn(), updateCardLegality: vi.fn() };
    scene.opponentManager = { updateTurnGlow: vi.fn() };
    let isCollecting = collecting;
    scene.trickManager = {
      isCollecting: () => isCollecting,
      onCollected: (cb) => { if (!isCollecting) cb(); else pending.push(cb); },
    };
    const land = () => { isCollecting = false; const cbs = pending; pending = []; cbs.forEach((cb) => cb()); };
    return { scene, land };
  }
  const lastCanPlay = (scene) => scene.cardManager.updateCardLegality.mock.calls.at(-1)[1];

  it('no collect in flight: the turn applies at once', () => {
    const { scene } = sceneFor({ collecting: false });
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(scene.cardManager.updateCardLegality).toHaveBeenCalledTimes(1);
    expect(lastCanPlay(scene)).toBe(true);
  });

  it('during the collect the hand stays dimmed, then the turn applies when it lands', () => {
    const { scene, land } = sceneFor({ collecting: true });
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(lastCanPlay(scene)).toBe(false);
    land();
    expect(scene.cardManager.updateCardLegality).toHaveBeenCalledTimes(2);
    expect(lastCanPlay(scene)).toBe(true);
  });

  it('a newer updateTurn or a moved turn cancels the deferred apply', () => {
    const { scene, land } = sceneFor({ collecting: true });
    scene.handleUpdateTurn({ currentTurn: 1 });
    scene.state.currentTurn = 2;
    scene.handleUpdateTurn({ currentTurn: 2 });
    land();
    expect(scene.cardManager.updateCardLegality.mock.calls.every((c) => c[1] === false)).toBe(true);

    const b = sceneFor({ collecting: true });
    b.scene.handleUpdateTurn({ currentTurn: 1 });
    b.scene.state.currentTurn = 3; // turn moved on without an updateTurn here
    b.land();
    expect(b.scene.cardManager.updateCardLegality).toHaveBeenCalledTimes(1);
  });

  it('a card already played meanwhile is not re-enabled', () => {
    const { scene, land } = sceneFor({ collecting: true });
    scene.handleUpdateTurn({ currentTurn: 1 });
    scene.state.hasPlayedCard = true;
    land();
    expect(scene.cardManager.updateCardLegality).toHaveBeenCalledTimes(1);
  });

  it('another seat\'s turn during the collect is applied at once (dimmed)', () => {
    const { scene } = sceneFor({ collecting: true });
    scene.state.currentTurn = 3;
    scene.handleUpdateTurn({ currentTurn: 3 });
    expect(scene.cardManager.updateCardLegality).toHaveBeenCalledTimes(1);
    expect(lastCanPlay(scene)).toBe(false);
  });
});

describe('GameScene handleCardPlayed fly-in timing', () => {
  function opponentScene() {
    const scene = new GameScene();
    const sprite = { setData: vi.fn(), setDepth: vi.fn(), x: 0, y: 0, scene: {} };
    scene.state = { position: 1, currentTrick: [{}, {}], isSpectator: false, isLazy: false };
    scene.callbacks = {};
    scene.tweens = { add: vi.fn(() => ({ stop: vi.fn() })) };
    scene.time = { delayedCall: vi.fn(() => ({ remove: vi.fn() })) };
    scene.opponentManager = { removeCard: vi.fn(() => sprite) };
    scene.trickManager = {
      setPlayerPosition: vi.fn(), updatePlayPositions: vi.fn(), getRelativePositionKey: vi.fn(() => 'opponent1'),
      _playPositions: { opponent1: { x: 100, y: 200 } }, _stopCardAnimations: vi.fn(), _currentTrick: [],
    };
    return scene;
  }

  it('flies in over CARD_PLAY (300 ms) with a 30 ms flip delay', () => {
    const scene = opponentScene();
    scene.handleCardPlayed({ card: { suit: 'spades', rank: 'A' }, position: 2 });
    expect(scene.tweens.add.mock.calls[0][0].duration).toBe(300);
    expect(scene.time.delayedCall.mock.calls[0][0]).toBe(30);
  });

  it('the trick-completing card lands within a quarter of resumeInMs', () => {
    const scene = opponentScene();
    scene.handleCardPlayed({ card: { suit: 'spades', rank: 'A' }, position: 2, resumeInMs: 600 });
    expect(scene.tweens.add.mock.calls[0][0].duration).toBe(150);
  });
});

describe('GameScene refreshControlAfterActive (/lazy then /active)', () => {
  function activeScene(state) {
    const scene = new GameScene();
    scene.state = {
      position: 1, currentTurn: 1, isSpectator: false, isLazy: false, isBidding: false, hasPlayedCard: false,
      myCards: [{ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: '2' }], bids: {}, playedCardIndex: 0,
      trump: null, trumpBroken: false, leadCard: null, leadPosition: null, ...state,
    };
    scene.cardManager = { updateCardLegality: vi.fn() };
    scene.bidManager = { showBidUI: vi.fn() };
    return scene;
  }
  const onBid = () => {};

  it('mid-bid with no bid placed: cards stay dimmed and the bid UI comes back for the hand', () => {
    const scene = activeScene({ isBidding: true });
    scene.refreshControlAfterActive(onBid);
    expect(scene.cardManager.updateCardLegality).toHaveBeenCalledWith(expect.any(Function), false);
    expect(scene.bidManager.showBidUI).toHaveBeenCalledWith(2, onBid);
  });

  it('mid-bid after the bot already bid for the seat: no bid UI', () => {
    const scene = activeScene({ isBidding: true, bids: { 1: '3' } });
    scene.refreshControlAfterActive(onBid);
    expect(scene.bidManager.showBidUI).not.toHaveBeenCalled();
  });

  it('playing, my turn: legality is recomputed with canPlay (lazy mode had dimmed every card)', () => {
    const scene = activeScene({});
    scene.refreshControlAfterActive(onBid);
    const [checker, canPlay] = scene.cardManager.updateCardLegality.mock.calls.at(-1);
    expect(canPlay).toBe(true);
    expect(typeof checker).toBe('function');
    expect(scene.bidManager.showBidUI).not.toHaveBeenCalled();
  });

  it('playing, not my turn or already played this trick: stays dimmed', () => {
    for (const s of [{ currentTurn: 2 }, { hasPlayedCard: true }]) {
      const scene = activeScene(s);
      scene.refreshControlAfterActive(onBid);
      expect(scene.cardManager.updateCardLegality.mock.calls.at(-1)[1]).toBe(false);
    }
  });

  it('a collect in flight keeps the hand dimmed until it lands', () => {
    const scene = activeScene({});
    let landed;
    scene.trickManager = { isCollecting: () => true, onCollected: (cb) => { landed = cb; } };
    scene.refreshControlAfterActive(onBid);
    expect(scene.cardManager.updateCardLegality.mock.calls.at(-1)[1]).toBe(false);
    landed();
    expect(scene.cardManager.updateCardLegality.mock.calls.at(-1)[1]).toBe(true);
  });
});

describe('GameScene handleCreateUI fade-out', () => {
  let raf;
  beforeEach(() => {
    vi.useFakeTimers();
    raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(); return 1; });
  });
  afterEach(() => {
    raf.mockRestore();
    vi.useRealTimers();
    document.getElementById('transition-overlay')?.remove();
    window._transitionOverlay = null;
    window._readyForGameUI = false;
  });

  function sceneWithDraw() {
    const scene = new GameScene();
    scene.drawManager = { cleanup: vi.fn() };
    return scene;
  }

  it('lifts the overlay and signals gameUIReady even when transitionend never fires', () => {
    const ready = vi.fn();
    window.addEventListener('gameUIReady', ready, { once: true });
    const onUIReady = vi.fn();
    sceneWithDraw().handleCreateUI({}, onUIReady);
    expect(onUIReady).toHaveBeenCalled();
    expect(document.getElementById('transition-overlay')).not.toBeNull();
    vi.advanceTimersByTime(1200 + 250);
    expect(document.getElementById('transition-overlay')).toBeNull();
    expect(window._transitionOverlay).toBeNull();
    vi.advanceTimersByTime(500);
    expect(window._readyForGameUI).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('a rejoin/exit that removed the overlay mid-fade owns the UI: no late gameUIReady', async () => {
    const { removeTransitionOverlay } = await import('../../ui/transitionOverlay.js');
    const ready = vi.fn();
    window.addEventListener('gameUIReady', ready);
    sceneWithDraw().handleCreateUI({}, vi.fn());
    removeTransitionOverlay();
    vi.advanceTimersByTime(5000);
    expect(ready).not.toHaveBeenCalled();
    expect(window._readyForGameUI).toBe(false);
    window.removeEventListener('gameUIReady', ready);
  });
});

describe('GameScene handleCardPlayed (lazy: the bot played my card)', () => {
  it('stops the hand sprite\'s hover/layout tweens before flying it in', () => {
    const scene = new GameScene();
    const sprite = { removeAllListeners: vi.fn(), disableInteractive: vi.fn(), setData: vi.fn(), setDepth: vi.fn() };
    scene.state = {
      position: 1, currentTrick: [{}, {}], isSpectator: false, isLazy: true,
      optimisticPlayCard: vi.fn(), confirmCardPlay: vi.fn(),
    };
    scene.callbacks = {};
    scene.tweens = { add: vi.fn(() => ({ stop: vi.fn() })) };
    scene.cardManager = { extractCard: vi.fn(() => sprite), repositionHand: vi.fn() };
    scene.trickManager = {
      setPlayerPosition: vi.fn(), updatePlayPositions: vi.fn(), _playPositions: { self: { x: 5, y: 6 } },
      _stopCardAnimations: vi.fn(), _currentTrick: [],
    };
    scene.handleCardPlayed({ card: { suit: 'spades', rank: 'A' }, position: 1 });
    expect(scene.trickManager._stopCardAnimations).toHaveBeenCalledWith(sprite);
    expect(scene.trickManager._stopCardAnimations.mock.invocationCallOrder[0])
      .toBeLessThan(scene.tweens.add.mock.invocationCallOrder[0]);
    expect(sprite.setData).toHaveBeenCalledWith('playPosition', 'self');
  });
});
