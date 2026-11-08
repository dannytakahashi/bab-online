import { describe, it, expect, beforeAll, vi } from 'vitest';

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
