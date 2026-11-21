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
vi.mock('../../ui/components/VoiceChatUI.js', () => ({ reattachMuteButton: vi.fn() }));

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
    // Textures the scene does draw are still loaded; the cards are drawn
    // (cards/CardAtlas.js), never loaded: no 64 px atlas, no card_back.png
    expect(keys).toEqual(expect.arrayContaining(['rainbow', 'ot', 'b', '2b', '3b', '4b']));
    expect(keys).not.toContain('cardBack');
    expect(scene.load.atlas).not.toHaveBeenCalled();
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
  it('logs and scores the final 13-card hand (a view: GameState is not written)', () => {
    const scene = new GameScene();
    const playerData = {
      position: [1, 2, 3, 4],
      username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
    };
    scene.state = Object.freeze({ position: 2, playerData, bids: {} });
    scene.callbacks = {};
    const formatHandCompleteMessages = vi.fn(() => ['hand line 1', 'hand line 2']);
    window.ModernUtils = { formatHandCompleteMessages };
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
      expect(formatHandCompleteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ teamScore: -40, oppScore: 120 })
      );
      expect(formatHandCompleteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ teamTricks: 6, oppTricks: 7, teamOldScore: 20, oppOldScore: 50 })
      );
      expect(window.addToGameFeedFromLegacy).toHaveBeenCalledWith('hand line 1');
      expect(window.addToGameFeedFromLegacy).toHaveBeenCalledWith('hand line 2');
      // the header by name: me/partner (2/4), then opp1/opp2 (3/1)
      expect(window.updateGameLogScoreFromLegacy).toHaveBeenCalledWith('bob/dan', 'cat/ann', -40, 120);
      // the announcer names the sides too, mine first (owner 2026-11-17:
      // never "your team" / "opponents")
      const lines = [...document.querySelectorAll('.hud-announcer p')].map((p) => p.textContent);
      expect(lines.at(-1)).toBe('Hand over. Score: bob and dan -40, cat and ann 120.');
      expect(lines.join(' ')).not.toMatch(/your team|opponents|Team [12]/i);
    } finally {
      delete window.ModernUtils;
      delete window.addToGameFeedFromLegacy;
      delete window.updateGameLogScoreFromLegacy;
    }
  });
});

describe('GameScene handleHandComplete writes no fault line (the server sends them, owner 2026-11-19)', () => {
  const playerData = {
    position: [1, 2, 3, 4],
    username: [{ username: 'ann' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
  };
  const feed = [];
  beforeEach(() => {
    feed.length = 0;
    window.ModernUtils = { formatHandCompleteMessages: () => ['--- HAND COMPLETE ---', 'line a', 'line b'] };
    window.addToGameFeedFromLegacy = (m) => feed.push(['plain', m]);
    window.addFaultToGameFeed = (m) => feed.push(['fault', m]);
    window.updateGameLogScoreFromLegacy = () => {};
  });
  afterEach(() => {
    delete window.ModernUtils;
    delete window.addToGameFeedFromLegacy;
    delete window.addFaultToGameFeed;
    delete window.updateGameLogScoreFromLegacy;
  });

  it('a set hand: only the three hand lines (the red rows arrive as gameLogEntry with fault)', () => {
    const scene = new GameScene();
    scene.callbacks = {};
    scene.state = Object.freeze({ position: 2, playerData, bids: {}, tricksByPosition: { 1: 1, 2: 1, 3: 2, 4: 1 }, currentHand: 5 });
    // ann/cat bid 5, took 3: set (a page-side rule would have named ann)
    scene.handleHandComplete({ team1Tricks: 3, team2Tricks: 2, score: { team1: -50, team2: 20 }, team1OldScore: 0, team2OldScore: 0 },
      { bids: { 1: '3', 2: '1', 3: '2', 4: '0' } });
    expect(feed).toEqual([['plain', '--- HAND COMPLETE ---'], ['plain', 'line a'], ['plain', 'line b']]);
  });
});

describe('GameScene _teamsSaid', () => {
  it('says each name whole: a legacy username with a "/" is one player, never split from the shown "a/b"', () => {
    const scene = new GameScene();
    const playerData = {
      position: [1, 2, 3, 4],
      username: [{ username: 'x/y' }, { username: 'bob' }, { username: 'cat' }, { username: 'dan' }],
    };
    scene.state = Object.freeze({ position: 1, playerData });
    expect(scene._teamsSaid(' Tricks:', 3, 2)).toBe(' Tricks: x/y and cat 3, bob and dan 2.');
    scene.state = Object.freeze({ position: 2, playerData });
    expect(scene._teamsSaid(' Tricks:', 3, 2)).toBe(' Tricks: bob and dan 3, cat and x/y 2.');
    // names not known yet: no tally
    scene.state = Object.freeze({ position: 1, playerData: null });
    expect(scene._teamsSaid(' Tricks:', 3, 2)).toBe('');
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
  });

  async function sceneWithDraw() {
    const { TableDirector } = await import('../TableDirector.js');
    const scene = new GameScene();
    scene.drawManager = { cleanup: vi.fn() };
    scene.director = new TableDirector();
    return scene;
  }

  it('lifts the overlay and lets the first deal show (director.uiReady) even when transitionend never fires', async () => {
    const scene = await sceneWithDraw();
    const dealt = vi.fn();
    const onUIReady = vi.fn();
    scene.handleCreateUI({}, onUIReady);
    expect(onUIReady).toHaveBeenCalled();
    expect(scene.director.uiReady).toBe(false);
    scene.director.afterTransition(dealt); // the deal waits for the fade
    expect(document.getElementById('transition-overlay')).not.toBeNull();
    vi.advanceTimersByTime(1200 + 250);
    expect(document.getElementById('transition-overlay')).toBeNull();
    expect(dealt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(scene.director.uiReady).toBe(true);
    expect(dealt).toHaveBeenCalledTimes(1);
  });

  it('a rejoin/exit that removed the overlay mid-fade owns the UI: the waiting deal is dropped, no late endFade', async () => {
    const { removeTransitionOverlay } = await import('../../ui/transitionOverlay.js');
    const scene = await sceneWithDraw();
    const dealt = vi.fn();
    const endFade = vi.spyOn(scene.director, 'endFade');
    scene.handleCreateUI({}, vi.fn());
    scene.director.afterTransition(dealt);
    removeTransitionOverlay();
    vi.advanceTimersByTime(5000);
    expect(endFade).not.toHaveBeenCalled();
    expect(dealt).not.toHaveBeenCalled();
    expect(scene.director.uiReady).toBe(true);
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

describe('GameScene handleDestroyHands (all-zero redeal)', () => {
  it('clears the hand and the trick through the managers and drops the bid grid', () => {
    const scene = new GameScene();
    // a view: GameState (the handler) already cleared the bids
    scene.state = Object.freeze({ bids: {}, position: 1 });
    scene.cardManager = { clearHand: vi.fn() };
    scene.trickManager = { clearAll: vi.fn() };
    scene.bidManager = { hideBidUI: vi.fn() };

    scene.handleDestroyHands({});

    expect(scene.cardManager.clearHand).toHaveBeenCalledTimes(1);
    expect(scene.trickManager.clearAll).toHaveBeenCalledTimes(1);
    expect(scene.bidManager.hideBidUI).toHaveBeenCalledWith(false);
  });
});

describe('GameScene cleanup (Return to Lobby, abortGame)', () => {
  it('resets every manager, hand before trick, and destroys the trump display', () => {
    const scene = new GameScene();
    const order = [];
    const rec = (name) => vi.fn(() => order.push(name));
    scene.cardManager = { clearAll: rec('card') };
    scene.opponentManager = { clearAll: rec('opponent') };
    scene.trickManager = { clearAll: rec('trick') };
    scene.effectsManager = { clearAll: rec('effects') };
    scene.drawManager = { cleanup: rec('draw') };
    const trump = ['tableCardSprite', 'tableCardBackground', 'tableCardLabel'].map((k) => {
      scene[k] = { destroy: vi.fn() };
      return scene[k];
    });

    scene.cleanup();

    expect(order).toEqual(['card', 'opponent', 'trick', 'effects', 'draw']);
    trump.forEach((t) => expect(t.destroy).toHaveBeenCalledTimes(1));
    expect(scene.tableCardSprite).toBeNull();
    expect(scene.tableCardBackground).toBeNull();
    expect(scene.tableCardLabel).toBeNull();
  });

  it('handleAbortGame runs it; a scene before create() (no managers) does not throw', () => {
    const scene = new GameScene();
    expect(() => scene.handleAbortGame({ reason: 'x' })).not.toThrow();
  });
});

describe('GameScene own avatar box (moved from main.js setGameScene)', () => {
  let getGameState;
  beforeAll(async () => {
    ({ getGameState } = await import('../../state/GameState.js'));
  });
  let container;
  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  });
  afterEach(() => {
    document.getElementById('player-avatar-container')?.remove();
    container.remove();
    getGameState().reset();
  });

  /** The HUD seat holding my box: its left/top are my avatar's centre. */
  const selfSeat = () => document.getElementById('player-avatar-container').closest('.hud-seat');

  const playerData = {
    position: [1, 2, 3, 4],
    username: [{ username: 'me' }, { username: 'b' }, { username: 'c' }, { username: 'd' }],
    pics: [3, 4, 5, 6],
  };
  function sceneAt(width = 1920, height = 953) {
    const scene = new GameScene();
    scene.scale = { width, height };
    return scene;
  }

  it('creates the box in my HUD seat (the layout\'s spot) with avatar, name and HSI, and clicking it asks for the profile', () => {
    const scene = sceneAt(960, 953);
    window.socket = { emit: vi.fn() };
    try {
      const info = scene.createPlayerInfoBox(playerData, 1);
      const el = document.getElementById('player-avatar-container');
      expect(info.avatarContainer).toBe(el);
      expect(scene._playerInfo).toBe(info);
      // my seat's node is at the layout's self avatar (canvas coordinates, ui-4)
      const L = scene.getLayout();
      expect(selfSeat().dataset.seat).toBe('self');
      expect(selfSeat().style.left).toBe(`${L.seats.self.avatar.x}px`);
      expect(selfSeat().style.top).toBe(`${L.seats.self.avatar.y}px`);
      // right of the hand box, inside the canvas
      expect(L.seats.self.block.x).toBeGreaterThan(L.hand.rect.x + L.hand.rect.w);
      expect(L.seats.self.block.x + L.seats.self.block.w).toBeLessThanOrEqual(960);
      expect(info.avatarImg.classList.contains('player-avatar-img')).toBe(true);
      expect(info.avatarImg.alt).toBe('me');
      expect(info.nameLabel.textContent).toBe('me');
      expect(info.hsiBox.id).toBe('player-hsi-box');
      expect(info.hsiBox.textContent).toBe('HSI: --');
      el.click();
      // with the device's stats scope (state/statsScope.js; default human)
      expect(window.socket.emit).toHaveBeenCalledWith('getPlayerProfile', { username: 'me', scope: 'human' });
    } finally {
      delete window.socket;
    }
  });

  it('refuses playerData that is not ready or lacks the seat', () => {
    const scene = sceneAt();
    expect(scene.createPlayerInfoBox({}, 1)).toBeNull();
    expect(scene.createPlayerInfoBox(playerData, 9)).toBeNull();
    expect(document.getElementById('player-avatar-container')).toBeNull();
  });

  it('repositions on resize, shows the HSI, and clears', () => {
    const scene = sceneAt();
    scene.createPlayerInfoBox(playerData, 1);
    const before = selfSeat().style.left;
    scene.scale = { width: 960, height: 476.5 };
    scene.repositionPlayerInfo();
    const L = scene.getLayout();
    expect(L.w).toBe(960);
    expect(selfSeat().style.left).not.toBe(before);
    expect(selfSeat().style.left).toBe(`${L.seats.self.avatar.x}px`);
    expect(selfSeat().style.top).toBe(`${L.seats.self.avatar.y}px`);
    scene.updatePlayerHsi(12.345);
    expect(scene._playerInfo.hsiBox.textContent).toBe('HSI: 12.3');
    scene.updatePlayerHsi(undefined);
    expect(scene._playerInfo.hsiBox.textContent).toBe('HSI: 12.3');
    scene.clearPlayerInfo();
    expect(document.getElementById('player-avatar-container')).toBeNull();
    expect(scene._playerInfo).toBeNull();
    expect(() => scene.repositionPlayerInfo()).not.toThrow();
  });

  it('handleDisplayOpponentHands draws the opponents and the own box once, never for a pure spectator', () => {
    const state = getGameState();
    state.position = 1;
    state.playerData = playerData;
    const scene = sceneAt();
    scene.opponentManager = { setPlayerPosition: vi.fn(), displayOpponentHands: vi.fn() };

    scene.handleDisplayOpponentHands(5, 2, playerData, true);
    expect(scene.opponentManager.setPlayerPosition).toHaveBeenCalledWith(1);
    expect(scene.opponentManager.displayOpponentHands).toHaveBeenCalledWith(5, 2, playerData, true);
    const first = scene._playerInfo;
    expect(first).not.toBeNull();
    scene.handleDisplayOpponentHands(5, 2, playerData, true);
    expect(scene._playerInfo).toBe(first);
    expect(document.querySelectorAll('#player-avatar-container')).toHaveLength(1);

    scene.clearPlayerInfo();
    state.isSpectator = true;
    scene.handleDisplayOpponentHands(5, 2, playerData, true);
    expect(scene._playerInfo).toBeNull();
    // a lazy owner watching the seat still gets the box
    state.isLazy = true;
    scene.handleDisplayOpponentHands(5, 2, playerData, true);
    expect(scene._playerInfo).not.toBeNull();
  });
});

describe('GameScene handleDisplayHand (moved from main.js setGameScene)', () => {
  let getGameState;
  beforeAll(async () => {
    ({ getGameState } = await import('../../state/GameState.js'));
  });
  afterEach(() => getGameState().reset());

  function handScene() {
    const scene = new GameScene();
    let clickHandler;
    scene.cardManager = {
      setCardClickHandler: vi.fn((fn) => { clickHandler = fn; }),
      displayHand: vi.fn(),
      updateCardLegality: vi.fn(),
      extractCard: vi.fn(() => null),
      repositionHand: vi.fn(),
    };
    return { scene, click: (...a) => clickHandler(...a) };
  }

  it('displays the hand sorted by trump, with the deal animation unless skipped', () => {
    const state = getGameState();
    state.trump = { suit: 'hearts', rank: '2' };
    const { scene } = handScene();
    const cards = [{ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: 'K' }];
    scene.handleDisplayHand(cards, false);
    const [shown, opts] = scene.cardManager.displayHand.mock.calls[0];
    expect(shown).toHaveLength(2);
    expect(shown).toEqual(expect.arrayContaining(cards));
    expect(opts).toEqual({ animate: true });
    scene.handleDisplayHand(cards, true);
    expect(scene.cardManager.displayHand.mock.calls[1][1]).toEqual({ animate: false });
  });

  it('nothing without cards', () => {
    const { scene } = handScene();
    scene.handleDisplayHand([], false);
    scene.handleDisplayHand(null, false);
    expect(scene.cardManager.displayHand).not.toHaveBeenCalled();
  });

  it('legality: playable on my turn after bidding, dimmed during bidding', () => {
    const state = getGameState();
    state.position = 1;
    state.currentTurn = 1;
    state.isBidding = false;
    const { scene } = handScene();
    scene.handleDisplayHand([{ suit: 'spades', rank: 'A' }], true);
    expect(scene.cardManager.updateCardLegality.mock.calls.at(-1)[1]).toBe(true);
    state.isBidding = true;
    scene.handleDisplayHand([{ suit: 'spades', rank: 'A' }], true);
    expect(scene.cardManager.updateCardLegality.mock.calls.at(-1)[1]).toBe(false);
  });

  it('a click on a legal card plays it once (pending in MyAction) and dims the hand; an illegal one is ignored', async () => {
    const { resetMyAction } = await import('../../state/MyAction.js');
    const myAction = resetMyAction();
    const state = getGameState();
    state.position = 3;
    state.playedCardIndex = 0;
    window.socket = { emit: vi.fn(), connected: true };
    try {
      const { scene, click } = handScene();
      const card = { suit: 'spades', rank: 'A' };
      state.setCards([card]);
      scene.handleDisplayHand([card], true);

      click(card, { getData: () => false, x: 0, y: 0 });
      expect(window.socket.emit).not.toHaveBeenCalled();

      click(card, { getData: () => true, x: 0, y: 0 });
      expect(window.socket.emit).toHaveBeenCalledWith('playCard', { card, position: 3 });
      expect(myAction.pendingCard).toEqual(card);
      // the click never writes the table: the echo does
      expect(state.leadCard).toBeNull();
      expect(state.hasPlayedCard).toBe(false);
      expect(state.myCards).toEqual([card]);
      expect(scene.cardManager.updateCardLegality.mock.calls.at(-1)[1]).toBe(false);
      // the hand closes up around the played card
      expect(scene.cardManager.repositionHand).toHaveBeenCalledTimes(1);

      // a second click while the first is pending sends nothing
      click(card, { getData: () => true, x: 0, y: 0 });
      expect(window.socket.emit).toHaveBeenCalledTimes(1);

      // a dead socket would buffer the play ahead of the rejoin: ignored
      myAction.reset();
      window.socket.connected = false;
      click(card, { getData: () => true, x: 0, y: 0 });
      expect(window.socket.emit).toHaveBeenCalledTimes(1);
    } finally {
      delete window.socket;
      myAction.reset();
    }
  });

  describe('a refused click says why (iOS\'s table notice: an amber toast for 3 s)', () => {
    let clearToasts;
    let myAction;
    beforeAll(async () => {
      ({ clearToasts } = await import('../../ui/kit/toast.js'));
    });
    beforeEach(async () => {
      const { resetMyAction } = await import('../../state/MyAction.js');
      myAction = resetMyAction();
      clearToasts();
      window.socket = { emit: vi.fn(), connected: true };
    });
    afterEach(() => {
      delete window.socket;
      myAction.reset();
      clearToasts();
      vi.useRealTimers();
    });

    const notice = () => {
      const all = [...document.querySelectorAll('.kit-toast')];
      expect(all.length).toBeLessThanOrEqual(1);
      const t = all[0];
      return t ? { text: t.textContent, warning: t.classList.contains('toast-warning') } : null;
    };
    const dimmed = { getData: () => false, x: 0, y: 0 };
    const legal = { getData: () => true, x: 0, y: 0 };

    /** My turn to follow (seat 2), with `hand`; trump spades. */
    function following(hand, lead, { leadPosition = 1 } = {}) {
      const state = getGameState();
      state.position = 2;
      state.currentTurn = 2;
      state.isBidding = false;
      state.trump = { suit: 'spades', rank: '5' };
      state.trumpBroken = true;
      state.playedCardIndex = 1;
      state.leadCard = lead;
      state.leadPosition = leadPosition;
      state.setCards(hand);
      const h = handScene();
      h.scene.handleDisplayHand(hand, true);
      return h;
    }

    it('the three rule reasons, word for word', () => {
      let h = following([{ suit: 'hearts', rank: 'A' }, { suit: 'clubs', rank: 'K' }], { suit: 'hearts', rank: '9' });
      h.click({ suit: 'clubs', rank: 'K' }, dimmed);
      expect(notice()).toEqual({ text: 'Must follow suit.', warning: true });

      clearToasts();
      const state = getGameState();
      h = following([{ suit: 'spades', rank: 'K' }, { suit: 'clubs', rank: 'A' }], null);
      state.playedCardIndex = 0;
      state.trumpBroken = false;
      h.click({ suit: 'spades', rank: 'K' }, dimmed);
      expect(notice()).toEqual({ text: 'Cannot lead trump until trump is broken.', warning: true });

      clearToasts();
      h = following([{ suit: 'spades', rank: 'A' }, { suit: 'spades', rank: 'K' }], { suit: 'joker', rank: 'HI' });
      h.click({ suit: 'spades', rank: 'K' }, dimmed);
      expect(notice()).toEqual({ text: 'Must play highest trump when HI joker leads.', warning: true });
      expect(window.socket.emit).not.toHaveBeenCalled();
    });

    it('the turn states: bid first, not your turn, the card on its way, the trick clearing; a bot playing the seat', () => {
      const card = { suit: 'hearts', rank: 'A' };
      const h = following([card], { suit: 'hearts', rank: '9' });
      const state = getGameState();
      const says = (text) => {
        clearToasts();
        h.click(card, dimmed);
        expect(notice()).toEqual({ text, warning: true });
      };
      state.isBidding = true;
      says('Bid first.');
      state.isBidding = false;
      state.currentTurn = 3;
      says('Not your turn.');
      state.currentTurn = 2;
      state.hasPlayedCard = true;
      says('Your card is on its way.');
      state.hasPlayedCard = false;
      // my turn, the card is legal by the rules, yet dimmed: the trick is clearing
      says('Wait for the trick to clear.');
      state.isLazy = true;
      says('A bot is playing your seat.');
      state.isLazy = false;
      expect(window.socket.emit).not.toHaveBeenCalled();
    });

    it('a spectator\'s click says nothing', () => {
      const card = { suit: 'hearts', rank: 'A' };
      const h = following([card], { suit: 'hearts', rank: '9' });
      getGameState().isSpectator = true;
      h.click(card, dimmed);
      expect(notice()).toBeNull();
      getGameState().isSpectator = false;
    });

    it('five quick clicks on a dimmed card leave one toast (restarted, nudged)', () => {
      vi.useFakeTimers();
      const h = following([{ suit: 'hearts', rank: 'A' }, { suit: 'clubs', rank: 'K' }], { suit: 'hearts', rank: '9' });
      for (let i = 0; i < 5; i++) h.click({ suit: 'clubs', rank: 'K' }, dimmed);
      expect(document.querySelectorAll('.kit-toast')).toHaveLength(1);
      expect(document.querySelector('.kit-toast').classList.contains('is-nudged')).toBe(true);
      vi.advanceTimersByTime(3200);
      expect(document.querySelector('.kit-toast')).toBeNull();
    });

    it('a click while disconnected: "Reconnecting. Try again in a moment.", nothing sent', () => {
      const card = { suit: 'hearts', rank: 'A' };
      const h = following([card], { suit: 'hearts', rank: '9' });
      window.socket.connected = false;
      h.click(card, legal);
      expect(notice()).toEqual({ text: 'Reconnecting. Try again in a moment.', warning: true });
      expect(window.socket.emit).not.toHaveBeenCalled();
    });

    it('a double-click\'s second press (the pointer, within 400 ms of my play) on the neighbour that slid under it: silent; a later press, or the keyboard, says why', () => {
      vi.useFakeTimers();
      const card = { suit: 'hearts', rank: 'A' };
      const next = { suit: 'hearts', rank: 'K' };
      const h = following([card, next], { suit: 'hearts', rank: '9' });
      h.click(card, legal, 'pointer');
      expect(window.socket.emit).toHaveBeenCalledTimes(1);
      // the neighbour is dimmed now (and the play pending)
      h.click(next, dimmed, 'pointer');
      h.click(next, legal, 'pointer');
      expect(notice()).toBeNull();
      // the keyboard in that window still says why
      h.click(next, dimmed, 'keyboard');
      expect(notice()).toEqual({ text: 'Your card is on its way.', warning: true });
      clearToasts();
      // a press after the window says why too
      vi.advanceTimersByTime(450);
      h.click(next, dimmed, 'pointer');
      expect(notice()).toEqual({ text: 'Your card is on its way.', warning: true });
      expect(window.socket.emit).toHaveBeenCalledTimes(1);
    });

    it('a second click while my card is pending: "Your card is on its way."', () => {
      const card = { suit: 'hearts', rank: 'A' };
      const h = following([card, { suit: 'hearts', rank: 'K' }], { suit: 'hearts', rank: '9' });
      h.click(card, legal);
      expect(window.socket.emit).toHaveBeenCalledTimes(1);
      expect(notice()).toBeNull();
      h.click({ suit: 'hearts', rank: 'K' }, legal);
      expect(window.socket.emit).toHaveBeenCalledTimes(1);
      expect(notice()).toEqual({ text: 'Your card is on its way.', warning: true });
    });
  });
});

describe('GameScene /help (plan H3: the private suggestion)', () => {
  let getGameState;
  let resetMyAction;
  let assist;
  let card;
  let clearToasts;
  beforeAll(async () => {
    ({ getGameState } = await import('../../state/GameState.js'));
    ({ resetMyAction } = await import('../../state/MyAction.js'));
    assist = await import('../../state/assistHint.js');
    card = await import('../../ui/components/AssistCard.js');
    ({ clearToasts } = await import('../../ui/kit/toast.js'));
  });
  let rows;
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"><div id="table-hud"></div></div>';
    card.resetAssistCard();
    assist.resetAssistUses();
    resetMyAction();
    clearToasts();
    rows = [];
    window.addPrivateToGameFeed = (m) => rows.push(m);
    window.socket = { emit: vi.fn(() => true), connected: true };
  });
  afterEach(() => {
    getGameState().reset();
    resetMyAction();
    delete window.addPrivateToGameFeed;
    delete window.socket;
    clearToasts();
  });

  const cardHint = (over = {}) => ({
    v: 1, source: 'help', kind: 'card', turnKey: '2|PLAYING|1|4|0', headline: 'Lead A♣',
    reasons: ['You and Bob bid 4.', 'The A♣ is the highest club left.'], uses: 1, freeUses: 3, assisted: false,
    counted: true, details: ['Carol and Dan bid 3.'], confidence: 'clear', suggest: { card: { suit: 'clubs', rank: 'A' } }, codes: ['L.top'],
    ...over,
  });
  const bidHint = (over = {}) => ({
    v: 1, source: 'help', kind: 'bid', turnKey: '2|BIDDING|1|1|0', headline: 'Bid 3', reasons: ['Your hand is worth about 3 tricks.'],
    uses: 2, freeUses: 3, assisted: false, counted: true, details: [], confidence: 'close', suggest: { bid: '3' }, codes: [],
    ...over,
  });

  /** My seat 1 on my play turn (or bid turn), managers faked. */
  function mySeat({ bidding = false } = {}) {
    const state = getGameState();
    state.position = 1;
    state.currentTurn = 1;
    state.isSpectator = false;
    state.isLazy = false;
    state.isBidding = bidding;
    state.phase = bidding ? 'bidding' : 'playing';
    state.stage = bidding ? 'BIDDING' : 'PLAYING';
    state.bids = bidding ? { 4: '2' } : { 1: '2', 2: '1', 3: '2', 4: '2' };
    state.myCards = [{ suit: 'clubs', rank: 'A' }, { suit: 'hearts', rank: '4' }];
    state.hasPlayedCard = false;
    const scene = new GameScene();
    scene.state = state;
    scene.callbacks = {};
    scene.cardManager = {
      setSuggestedCard: vi.fn(), updatePlayerTurnGlow: vi.fn(), updateCardLegality: vi.fn(), clearHand: vi.fn(), clearAll: vi.fn(),
    };
    scene.bidManager = { setSuggestedBid: vi.fn(), updateVisibility: vi.fn(), updateBoreButtonStates: vi.fn(), showBidBubble: vi.fn(), hideBidUI: vi.fn() };
    scene.opponentManager = { updateTurnGlow: vi.fn() };
    return { scene, state };
  }
  const shown = () => {
    const el = document.querySelector('.hud-assist');
    return el && !el.hidden ? el.querySelector('.assist-card__head').textContent : null;
  };
  const lastCard = (scene) => scene.cardManager.setSuggestedCard.mock.calls.at(-1)?.[0];
  const lastBid = (scene) => scene.bidManager.setSuggestedBid.mock.calls.at(-1)?.[0];
  const ask = () => document.querySelector('.hud-assist-ask');

  it('a card answer: the card, the ring on the card, the local row, spoken once, the uses noted', () => {
    const { scene } = mySeat();
    scene.handleAssistHint(cardHint());
    expect(shown()).toBe('Lead A♣');
    expect(lastCard(scene)).toEqual({ suit: 'clubs', rank: 'A' });
    expect(lastBid(scene)).toBeNull();
    expect(rows).toEqual(['Help: Lead A♣ (only you see this)']);
    const said = [...document.querySelectorAll('.hud-announcer p')].map((p) => p.textContent);
    expect(said).toEqual(['Suggestion: Lead A♣. The A♣ is the highest club left.']);
    expect(assist.helpDescription()).toBe('Ask a bot for advice (1 of 3 free used)');
    expect(scene.assistHint()).toEqual(cardHint());
  });

  it('a game with a native bot seat: the footer and the chat line name no count (the hint or the table says)', () => {
    const { scene, state } = mySeat();
    const foot = () => document.querySelector('.hud-assist .assist-card__foot')?.textContent;
    // the table knows first (a native bot seat), before the server has said
    state.nativeBotSeat = true;
    assist.resetAssistUses(state.gameId);
    expect(assist.helpDescription(state.gameId, { unlimited: assist.helpIsUnlimited(state) })).toBe('Ask a bot for advice');
    // a hint without the flag is the server's word (the limit; as on iOS), whatever the table
    scene.handleAssistHint(cardHint({ uses: 3, note: 'That\'s your 3rd free /help.' }));
    expect(foot()).toBe('What our strongest bot would play · Help 3 of 3 free');
    expect(assist.helpDescription(state.gameId, { unlimited: assist.helpIsUnlimited(state) }))
      .toBe('Ask a bot for advice (the next one makes this game bot-assisted)');
    // the hint's own flag, the table not knowing (yet)
    state.nativeBotSeat = false;
    scene.handleAssistHint(cardHint({ uses: 5, unlimited: true }));
    expect(foot()).toBe('What our strongest bot would play');
    expect(assist.helpDescription()).toBe('Ask a bot for advice');
    // the unlimited hint's announcement (the last one) names no count
    const said = [...document.querySelectorAll('.hud-announcer p')].map((p) => p.textContent).at(-1);
    expect(said).toMatch(/^Suggestion: /);
    expect(said).not.toMatch(/free|unlimited|bot-assisted|\b[0-9] of\b/i);
    state.nativeBotSeat = false;
  });

  it('a bid answer rings the bid; my own bid clears it', () => {
    const { scene, state } = mySeat({ bidding: true });
    scene.handleAssistHint(bidHint());
    expect(shown()).toBe('Bid 3');
    expect(lastBid(scene)).toBe('3');
    state.bids[1] = '3';
    scene.handleBidReceived({ position: 1, bid: '3' });
    expect(shown()).toBeNull();
    expect(lastBid(scene)).toBeNull();
  });

  it('another seat\'s bid leaves it (still my turn until updateTurn), the next updateTurn clears it', () => {
    const { scene, state } = mySeat({ bidding: true });
    scene.handleAssistHint(bidHint());
    state.bids[2] = '1';
    scene.handleBidReceived({ position: 2, bid: '1' });
    expect(shown()).toBe('Bid 3');
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(shown()).toBeNull();
  });

  it('an updateTurn that repeats this turn (a resync) leaves a live answer; a status reply goes at any updateTurn', () => {
    const { scene } = mySeat({ bidding: true });
    scene.handleAssistHint(bidHint());
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(shown()).toBe('Bid 3');
    expect(lastBid(scene)).toBe('3');
    scene.clearAssist();
    scene.handleAssistHint({ v: 1, source: 'help', kind: 'status', turnKey: 'k', headline: 'Nothing to suggest right now.', reasons: [], uses: 0, freeUses: 3, assisted: false, counted: false });
    expect(shown()).toBe('Nothing to suggest right now.');
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(shown()).toBeNull();
  });

  it('a status reply while my live suggestion is up (the rate limit after repeated asks): the suggestion and its ring stay, the status is a notice, no extra row', () => {
    const { scene } = mySeat();
    scene.handleAssistHint(cardHint());
    expect(rows).toHaveLength(1);
    scene.handleAssistHint({ v: 1, source: 'help', kind: 'status', turnKey: '2|PLAYING|1|4|0', headline: 'One moment: try again in a few seconds.', reasons: [], uses: 1, freeUses: 3, assisted: false, counted: false });
    expect(shown()).toBe('Lead A♣');
    expect(lastCard(scene)).toEqual({ suit: 'clubs', rank: 'A' });
    expect(document.querySelector('.kit-toast')?.textContent).toBe('One moment: try again in a few seconds.');
    expect(rows).toHaveLength(1);
  });

  it('an answer that came ahead of my held updateTurn (a seq gap) shows once the state reaches my turn', () => {
    const { scene, state } = mySeat();
    state.currentTurn = 4; // the gap: my updateTurn is held
    scene.handleAssistHint(cardHint());
    expect(shown()).toBeNull();
    expect(rows).toEqual([]);
    state.currentTurn = 1; // the gap fills
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(shown()).toBe('Lead A♣');
    expect(rows).toEqual(['Help: Lead A♣ (only you see this)']);
    // or by the resync's render
    scene.clearAssist();
    state.currentTurn = 4;
    scene.handleAssistHint(cardHint());
    state.currentTurn = 1;
    scene.syncAssist();
    expect(shown()).toBe('Lead A♣');
  });

  it('an answer whose turn had passed leaves a row saying so (at the next updateTurn), never a stale card', () => {
    const { scene, state } = mySeat();
    state.trickNo = 2; // my trick-2 turn; the answer was for trick 1 (cardIndex 0)
    state.playedCards = [];
    scene.handleAssistHint(cardHint());
    expect(shown()).toBeNull();
    state.currentTurn = 2;
    scene.handleUpdateTurn({ currentTurn: 2 });
    expect(shown()).toBeNull();
    expect(rows).toEqual(['Help: that turn had passed before the answer came (only you see this)']);
    // given up once: the next updateTurn adds nothing
    scene.handleUpdateTurn({ currentTurn: 3 });
    expect(rows).toHaveLength(1);
  });

  it('one "?" click, one ask: the "?" waits for the answer (or the next turn, or 10 s)', () => {
    vi.useFakeTimers();
    try {
      const { scene } = mySeat();
      scene.handleUpdateTurn({ currentTurn: 1 });
      ask().click();
      expect(window.socket.emit).toHaveBeenCalledTimes(1);
      expect(ask().hidden).toBe(true);
      // no answer yet: it comes back after the wait
      vi.advanceTimersByTime(10000);
      expect(ask().hidden).toBe(false);
      ask().click();
      expect(ask().hidden).toBe(true);
      // a turn change (a repeat of mine here) lets it show again
      scene.handleUpdateTurn({ currentTurn: 1 });
      expect(ask().hidden).toBe(false);
      ask().click();
      scene.handleAssistHint(cardHint());
      scene.clearAssist();
      expect(ask().hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the "?" while the session is being restored: one reconnecting notice, nothing emitted (no notice about a message)', async () => {
    const { getSocketManager } = await import('../../socket/SocketManager.js');
    const mgr = getSocketManager();
    const spy = vi.spyOn(mgr, 'canSend').mockReturnValue(false);
    try {
      const { scene } = mySeat();
      scene.handleUpdateTurn({ currentTurn: 1 });
      ask().click();
      expect(window.socket.emit).not.toHaveBeenCalled();
      const toasts = [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);
      expect(toasts).toEqual(['Reconnecting. Try again in a moment.']);
      // the gate refused an emit itself (it showed its own notice): none more
      spy.mockReturnValue(true);
      clearToasts();
      window.socket.emit = vi.fn(() => false);
      ask().click();
      expect(document.querySelector('.kit-toast')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('my card played (the echo), hand end, a redeal, a bot taking my seat and cleanup clear it', () => {
    const { scene } = mySeat();
    const again = () => { scene.handleAssistHint(cardHint()); expect(shown()).toBe('Lead A♣'); };
    scene.trickManager = { setPlayerPosition: vi.fn(), updatePlayPositions: vi.fn(), _currentTrick: [{ getData: () => ({ suit: 'clubs', rank: 'A' }) }], clearAll: vi.fn() };
    scene._flyMyCard = vi.fn();
    scene.state.currentTrick = [];
    again();
    scene.handleCardPlayed({ card: { suit: 'clubs', rank: 'A' }, position: 1 });
    expect(shown()).toBeNull();
    scene.state.hasPlayedCard = false;
    again();
    scene._animateTricksAndTrumpAway = vi.fn();
    scene.handleHandComplete({ score: { team1: 0, team2: 0 } });
    expect(shown()).toBeNull();
    again();
    scene.handleDestroyHands({});
    expect(shown()).toBeNull();
    again();
    scene.handlePlayerLazyMode({ position: 1 });
    expect(shown()).toBeNull();
    again();
    // the table's teardown (the other managers' parts are their own tests)
    scene.opponentManager = null;
    scene.trickManager = null;
    scene.cleanup();
    expect(shown()).toBeNull();
    expect(lastCard(scene)).toBeNull();
  });

  it('the ✕ dismisses it and takes the rings down; focus in the card goes to the "?"', () => {
    const { scene } = mySeat();
    scene.handleAssistHint(cardHint());
    const close = document.querySelector('.assist-card__close');
    close.focus();
    close.click();
    expect(shown()).toBeNull();
    expect(lastCard(scene)).toBeNull();
    expect(scene.assistHint()).toBeNull();
    expect(ask().hidden).toBe(false);
    expect(document.activeElement).toBe(ask());
  });

  it('a stale answer (the turn moved, another seat in its turnKey, my card on its way) is dropped, its uses kept', () => {
    const { scene, state } = mySeat();
    scene.handleAssistHint(cardHint({ turnKey: '2|PLAYING|2|4|0', uses: 2 }));
    expect(shown()).toBeNull();
    expect(rows).toEqual([]);
    expect(assist.helpDescription()).toBe('Ask a bot for advice (2 of 3 free used)');
    state.currentTurn = 3;
    scene.handleAssistHint(cardHint());
    expect(shown()).toBeNull();
  });

  it('a render keeps a live answer (rings again) and drops a stale one', () => {
    const { scene, state } = mySeat();
    scene.handleAssistHint(cardHint());
    scene.cardManager.setSuggestedCard.mockClear();
    scene.syncAssist();
    expect(shown()).toBe('Lead A♣');
    expect(lastCard(scene)).toEqual({ suit: 'clubs', rank: 'A' });
    state.hasPlayedCard = true;
    scene.syncAssist();
    expect(shown()).toBeNull();
  });

  it('a status reply shows for a spectator too, without touching my uses', () => {
    const { scene, state } = mySeat();
    state.isSpectator = true;
    assist.noteAssistUses({ uses: 2, freeUses: 3 });
    scene.handleAssistHint({ v: 1, source: 'help', kind: 'status', turnKey: 'k', headline: '/help is for players only.', reasons: [], uses: 0, freeUses: 3, assisted: false, counted: false });
    expect(shown()).toBe('/help is for players only.');
    expect(rows).toEqual(['Help: /help is for players only. (only you see this)']);
    expect(assist.helpDescription()).toBe('Ask a bot for advice (2 of 3 free used)');
  });

  it('the "?" shows on my own turn at my seat, hides while the answer is up, and sends /help', () => {
    const { scene, state } = mySeat();
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(ask().hidden).toBe(false);
    ask().click();
    expect(window.socket.emit).toHaveBeenCalledWith('chatMessage', { message: '/help' });
    scene.handleAssistHint(cardHint());
    expect(ask().hidden).toBe(true);
    // not my turn: no "?"
    state.currentTurn = 2;
    scene.handleUpdateTurn({ currentTurn: 2 });
    expect(ask().hidden).toBe(true);
    // a bot plays my seat: no "?"
    state.currentTurn = 1;
    state.isLazy = true;
    scene.handleUpdateTurn({ currentTurn: 1 });
    expect(ask().hidden).toBe(true);
  });

  it('the "?" during bidding, not once my bid is in; offline it says reconnecting', () => {
    const { scene, state } = mySeat({ bidding: true });
    scene.syncAssistButton();
    expect(ask().hidden).toBe(false);
    window.socket.connected = false;
    ask().click();
    expect(window.socket.emit).not.toHaveBeenCalled();
    expect(document.querySelector('.kit-toast')?.textContent).toMatch(/Reconnecting\. Try again in a moment\./);
    state.bids[1] = '2';
    scene.syncAssistButton();
    expect(ask().hidden).toBe(true);
  });
});

describe('GameScene the tutorial (tips, its advice)', () => {
  let getGameState;
  let resetMyAction;
  let assist;
  let tut;
  let card;
  let clearToasts;
  beforeAll(async () => {
    ({ getGameState } = await import('../../state/GameState.js'));
    ({ resetMyAction } = await import('../../state/MyAction.js'));
    assist = await import('../../state/assistHint.js');
    tut = await import('../../state/tutorial.js');
    card = await import('../../ui/components/AssistCard.js');
    ({ clearToasts } = await import('../../ui/kit/toast.js'));
  });
  let rows;
  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"><div id="table-hud"></div></div>';
    card.resetAssistCard();
    assist.resetAssistUses();
    tut.resetTutorial();
    resetMyAction();
    clearToasts();
    rows = [];
    window.addPrivateToGameFeed = (m) => { if (m) rows.push(m); };
    window.socket = { emit: vi.fn(() => true), connected: true };
  });
  afterEach(() => {
    getGameState().reset();
    resetMyAction();
    tut.forgetTutorial();
    delete window.addPrivateToGameFeed;
    delete window.socket;
    clearToasts();
  });

  const base = { v: 1, source: 'tutorial', uses: 0, freeUses: 3, assisted: false, counted: false };
  const tip = (id, title, text, over = {}) => ({ ...base, kind: 'tip', turnKey: '1|BIDDING|1|1|0', headline: title, reasons: [text], tipId: id, ...over });
  const welcome = () => tip('T.welcome', 'Tutorial on', 'Tips will appear above your cards. Only you see them. Close one with ×, or choose Turn off to stop them.', { actions: ['keep', 'off'] });
  const trump = () => tip('T.trump', 'Trump', 'Trump this hand is hearts ♥. Any heart beats any card of another suit, and the two jokers are the highest trumps.');
  const bidAdvice = (over = {}) => ({
    ...base, kind: 'bid', turnKey: '1|BIDDING|1|1|0', headline: 'Bid 3', reasons: ['Your hand is worth about 3 tricks.'],
    details: [], confidence: 'clear', suggest: { bid: '3' }, codes: [], ...over,
  });
  const cardAdvice = (over = {}) => ({
    ...base, kind: 'card', turnKey: '1|PLAYING|1|4|0', headline: 'Lead A♣', reasons: ['The A♣ is the highest club left.'],
    details: [], confidence: 'clear', suggest: { card: { suit: 'clubs', rank: 'A' } }, codes: [], ...over,
  });

  function mySeat({ bidding = false } = {}) {
    const state = getGameState();
    state.gameId = 'g1';
    state.position = 1;
    state.currentTurn = 1;
    state.isSpectator = false;
    state.isLazy = false;
    state.isBidding = bidding;
    state.phase = bidding ? 'bidding' : 'playing';
    state.stage = bidding ? 'BIDDING' : 'PLAYING';
    state.bids = bidding ? { 4: '2' } : { 1: '2', 2: '1', 3: '2', 4: '2' };
    state.myCards = [{ suit: 'clubs', rank: 'A' }, { suit: 'hearts', rank: '4' }];
    state.hasPlayedCard = false;
    if (!bidding) state.trickNo = 1;
    const scene = new GameScene();
    scene.state = state;
    scene.callbacks = {};
    scene.cardManager = {
      setSuggestedCard: vi.fn(), updatePlayerTurnGlow: vi.fn(), updateCardLegality: vi.fn(), clearHand: vi.fn(), clearAll: vi.fn(),
    };
    scene.bidManager = { setSuggestedBid: vi.fn(), updateVisibility: vi.fn(), updateBoreButtonStates: vi.fn(), showBidBubble: vi.fn(), hideBidUI: vi.fn() };
    scene.opponentManager = { updateTurnGlow: vi.fn() };
    return { scene, state };
  }
  const q = (sel) => document.querySelector(sel);
  const titles = () => [...document.querySelectorAll('.hud-assist:not([hidden]) .assist-tip__title')].map((e) => e.textContent);
  const head = () => q('.hud-assist:not([hidden]) .assist-card__head')?.textContent ?? null;
  const said = () => [...document.querySelectorAll('.hud-announcer p')].map((p) => p.textContent);
  const sent = () => window.socket.emit.mock.calls.filter(([e]) => e === 'chatMessage').map(([, d]) => d.message);
  const on = (auto = false) => tut.noteTutorialState({ tutorial: true, auto, uses: 0, freeUses: 3, assisted: false });

  it('a tip and the advice of one decision: the tip above the advice, a "Tutorial:" row, each said once; no "Help:" row for the advice', () => {
    on();
    const { scene } = mySeat({ bidding: true });
    scene.handleAssistHint(trump());
    scene.handleAssistHint(bidAdvice());
    expect(titles()).toEqual(['Trump']);
    expect(head()).toBe('Bid 3');
    const card = q('.hud-assist');
    // the tip first, then the advice; the card sits above the bid sheet
    expect(card.firstElementChild.classList.contains('assist-tip')).toBe(true);
    expect(card.querySelector('.assist-card__advice')).not.toBeNull();
    expect(card.dataset.place).toBe('bid');
    expect(card.getAttribute('aria-label')).toBe('Suggestion');
    expect(rows).toEqual(['Tutorial: Trump this hand is hearts ♥. Any heart beats any card of another suit, and the two jokers are the highest trumps. (only you see this)']);
    expect(said()).toEqual([
      'Tip: Trump. Trump this hand is hearts ♥. Any heart beats any card of another suit, and the two jokers are the highest trumps.',
      'Suggestion: Bid 3. Your hand is worth about 3 tricks.',
    ]);
    // the advice: the /help card's chip and ring, the footer names no count
    expect(q('.assist-card__chip').textContent).toBe('Clear choice');
    expect(scene.bidManager.setSuggestedBid).toHaveBeenLastCalledWith('3');
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    expect(assist.helpDescription('g1', { tutorial: tut.tutorialIsOn('g1') })).toBe('Ask a bot for advice');
  });

  it('one tip card at a time: a rule tip waits behind the welcome (its row in, not said), shows and is said after Keep', () => {
    on(true);
    const { scene } = mySeat({ bidding: true });
    scene.handleAssistHint(welcome());
    scene.handleAssistHint(trump());
    scene.handleAssistHint(tip('T.bid', 'Bidding', 'Bid how many tricks you expect to win.'));
    scene.handleAssistHint(bidAdvice());
    expect(titles()).toEqual(['Tutorial on']);
    expect(document.querySelectorAll('.hud-assist .assist-tip')).toHaveLength(1);
    expect(head()).toBe('Bid 3');
    // every rule tip in the log, shown or not; the welcome is its card only
    // (owner 2026-11-20: card + row read as the start message twice)
    expect(rows.filter((r) => r.startsWith('Tutorial: '))).toHaveLength(2);
    expect(rows.some((r) => r.includes('Tips will appear above your cards'))).toBe(false);
    // (as built; the page's feed keeps the note on its first only: tutorial.test.js tutorialFeedRow)
    expect(rows.every((r) => r.endsWith('(only you see this)'))).toBe(true);
    // the announcer says only the card shown (and the advice)
    expect(said().filter((t) => t.startsWith('Tip: ')).map((t) => t.split('.')[0])).toEqual(['Tip: Tutorial on']);
    q('.assist-tip__action.is-keep').click();
    // the newest rule tip replaced the older behind the welcome; said now, once
    expect(titles()).toEqual(['Bidding']);
    expect(head()).toBe('Bid 3');
    expect(said().filter((t) => t.startsWith('Tip: ')).map((t) => t.split('.')[0])).toEqual(['Tip: Tutorial on', 'Tip: Bidding']);
    scene.drawTips();
    expect(said().filter((t) => t.startsWith('Tip: '))).toHaveLength(2);
  });

  it('Turn off on the welcome takes every tip down at once (a waiting rule tip never comes up)', () => {
    on(true);
    const { scene } = mySeat({ bidding: true });
    scene.handleAssistHint(welcome());
    scene.handleAssistHint(trump());
    q('.assist-tip__action.is-off').click();
    expect(titles()).toEqual([]);
    expect(said().filter((t) => t.startsWith('Tip: Trump'))).toEqual([]);
  });

  it('my own bid takes the rule tip and the advice down; the welcome stays until Keep / Turn off / ✕', () => {
    on(true);
    const { scene, state } = mySeat({ bidding: true });
    scene.handleAssistHint(welcome());
    scene.handleAssistHint(trump());
    scene.handleAssistHint(bidAdvice());
    expect(titles()).toEqual(['Tutorial on']);
    state.bids[1] = '3';
    scene.handleBidReceived({ position: 1, bid: '3' });
    expect(titles()).toEqual(['Tutorial on']);
    expect(head()).toBeNull();
    // tips alone: above the hand once it is not my bid turn
    expect(q('.hud-assist').dataset.kind).toBe('tip');
    expect(q('.hud-assist').getAttribute('aria-label')).toBe('Tutorial tip');
    // Keep: '/tutorial keep', the welcome goes
    const keep = q('.assist-tip__action.is-keep');
    expect(keep.textContent).toBe('Keep');
    keep.click();
    expect(sent()).toEqual(['/tutorial keep']);
    expect(q('.hud-assist').hidden).toBe(true);
  });

  it('the welcome\'s ✕ sends /tutorial close (not Keep); Turn off sends /tutorial off', () => {
    on(true);
    const { scene } = mySeat();
    scene.handleAssistHint(welcome());
    q('.assist-tip__close').click();
    expect(sent()).toEqual(['/tutorial close']);
    scene.handleAssistHint({ ...welcome() });
    const off = q('.assist-tip__action.is-off');
    expect(off.textContent).toBe('Turn off');
    off.click();
    expect(sent()).toEqual(['/tutorial close', '/tutorial off']);
    expect(titles()).toEqual([]);
  });

  it('a rule tip\'s ✕ sends nothing; a newer tip replaces the one up', () => {
    on();
    const { scene } = mySeat();
    scene.handleAssistHint(trump());
    scene.handleAssistHint(tip('T.lead', 'Leading', 'You lead this trick.'));
    expect(titles()).toEqual(['Leading']);
    q('.assist-tip__close').click();
    expect(sent()).toEqual([]);
    expect(titles()).toEqual([]);
  });

  it('a tip between my decisions stays through other seats\' turns and goes with my card', () => {
    on();
    const { scene, state } = mySeat();
    state.currentTurn = 2;
    scene.handleAssistHint(tip('T.made', 'Bid made', 'You and Bob (your partner) made your bid! Extra tricks are worth 1 point each.'));
    scene.handleUpdateTurn({ currentTurn: 3 });
    expect(titles()).toEqual(['Bid made']);
    state.currentTurn = 1;
    scene.handleUpdateTurn({ currentTurn: 1 });
    scene.handleAssistHint(cardAdvice());
    expect(titles()).toEqual(['Bid made']);
    expect(head()).toBe('Lead A♣');
    state.playedCards = [{ card: { suit: 'clubs', rank: 'A' }, position: 1 }];
    state.currentTrick = [{ card: { suit: 'clubs', rank: 'A' }, position: 1 }];
    scene.updateCardLegalityAfterPlay = vi.fn();
    scene._seatName = () => 'Alice';
    scene.handleCardPlayed({ position: 1, card: { suit: 'clubs', rank: 'A' } });
    expect(titles()).toEqual([]);
    expect(head()).toBeNull();
  });

  it('the game-end tip is its row alone; a hand-end tip survives the hand\'s end', () => {
    on();
    const { scene } = mySeat();
    scene.handleAssistHint(tip('T.handScore', 'Hand score', 'This hand, you and Bob (your partner) bid 2 and won 2: 2 × 10 = +20.'));
    scene.clearAssist();
    expect(titles()).toEqual(['Hand score']);
    scene.handleAssistHint(tip('T.done', 'Tutorial complete', 'Thanks for playing with the tutorial. Type /help any time for a suggestion.'));
    expect(titles()).toEqual(['Hand score']);
    expect(rows.at(-1)).toBe('Tutorial: Thanks for playing with the tutorial. Type /help any time for a suggestion. (only you see this)');
  });

  it('no in-hand "Tutorial on" chip, on or off (owner 2026-11-21: the game log\'s Tutorial button replaced it)', () => {
    const { scene } = mySeat();
    scene.syncTutorial();
    expect(q('.hud-tutorial')).toBeNull();
    on();
    scene.syncTutorial();
    expect(q('.hud-tutorial')).toBeNull();
    expect(q('#table-hud').classList.contains('has-tutorial-chip')).toBe(false);
  });

  it('the server says off: the tips and the tutorial\'s advice go; a /help answer stays', () => {
    on();
    const { scene } = mySeat();
    scene.handleAssistHint(trump());
    scene.handleAssistHint(cardAdvice());
    scene.syncTutorial();
    expect(titles()).toEqual(['Trump']);
    tut.noteTutorialState({ tutorial: false, auto: false, uses: 0, freeUses: 3, assisted: true });
    scene.syncTutorial();
    expect(titles()).toEqual([]);
    expect(head()).toBeNull();
    // a /help answer is not the tutorial's
    on();
    scene.handleAssistHint(cardAdvice({ source: 'help', counted: true, uses: 1 }));
    tut.noteTutorialState({ tutorial: false });
    scene.syncTutorial();
    expect(head()).toBe('Lead A♣');
  });

  it('/help asked while the tutorial is on: answered, its footer says no count', () => {
    on();
    const { scene } = mySeat();
    scene.handleAssistHint(cardAdvice({ source: 'help', counted: false, uses: 0 }));
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    expect(rows).toEqual(['Help: Lead A♣ (only you see this)']);
  });

  it('a tutorial answer that came late leaves no "turn had passed" row', () => {
    on();
    const { scene, state } = mySeat();
    state.currentTurn = 2;
    scene.handleAssistHint(cardAdvice());
    scene.handleUpdateTurn({ currentTurn: 3 });
    expect(rows).toEqual([]);
  });

  it('a bot taking my seat, and the table going, take every tip down', () => {
    on();
    const { scene } = mySeat();
    scene.handleAssistHint(welcome());
    scene.showSeatDisplay = vi.fn();
    scene.handlePlayerLazyMode({ position: 1 });
    expect(titles()).toEqual([]);
    scene.handleAssistHint(welcome());
    scene.opponentManager = { clearAll: vi.fn() };
    scene.trickManager = { clearAll: vi.fn() };
    scene.cleanup();
    expect(titles()).toEqual([]);
    expect(q('.hud-tutorial')).toBeNull();
  });
});
