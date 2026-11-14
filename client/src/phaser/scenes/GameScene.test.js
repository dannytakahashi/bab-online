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
    scene.state = Object.freeze({ position: 2, playerData: {}, bids: {} });
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
      expect(formatHandCompleteMessages).toHaveBeenCalledWith(
        expect.objectContaining({ teamScore: -40, oppScore: 120 })
      );
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
});
