import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CardManager } from './CardManager.js';
import { CARD_CONFIG } from '../config.js';

// Mock global Phaser (loaded via script tag in production, not available in test)
globalThis.Phaser = {
  Geom: {
    Rectangle: class Rectangle {
      constructor(x, y, width, height) {
        this.x = x; this.y = y; this.width = width; this.height = height;
      }
      static Contains() { return true; }
    },
  },
};

// Mock Phaser scene
function createMockScene() {
  const sprites = [];

  return {
    scale: {
      width: 1920,
      height: 1080,
    },
    add: {
      sprite: vi.fn((x, y, texture, frame) => {
        const sprite = {
          x,
          y,
          texture,
          frame,
          scale: 1,
          depth: 0,
          data: {},
          setScale: vi.fn(function (s) {
            this.scale = s;
            return this;
          }),
          setDepth: vi.fn(function (d) {
            this.depth = d;
            return this;
          }),
          setData: vi.fn(function (key, value) {
            this.data[key] = value;
            return this;
          }),
          getData: vi.fn(function (key) {
            return this.data[key];
          }),
          setInteractive: vi.fn().mockReturnThis(),
          on: vi.fn(),
          destroy: vi.fn(),
        };
        sprites.push(sprite);
        return sprite;
      }),
    },
    tweens: {
      add: vi.fn((config) => {
        // Immediately complete tween for testing
        if (config.onComplete) {
          config.onComplete();
        }
        return {};
      }),
    },
    time: {
      delayedCall: vi.fn((delay, callback) => {
        // Execute callback immediately for testing
        callback();
        return {};
      }),
    },
    input: {
      setDefaultCursor: vi.fn(),
    },
    _sprites: sprites,
  };
}

describe('CardManager', () => {
  let manager;
  let mockScene;

  beforeEach(() => {
    mockScene = createMockScene();
    manager = new CardManager(mockScene);
  });

  describe('getTextureKey', () => {
    it('returns correct key for regular card', () => {
      expect(manager.getTextureKey({ rank: 'A', suit: 'spades' })).toBe('a_spades');
      expect(manager.getTextureKey({ rank: 'K', suit: 'Hearts' })).toBe('k_hearts');
    });

    it('returns correct key for jokers', () => {
      expect(manager.getTextureKey({ rank: 'HI', suit: 'joker' })).toBe('hi_joker');
      expect(manager.getTextureKey({ rank: 'LO', suit: 'joker' })).toBe('lo_joker');
    });
  });

  describe('calculateHandPositions', () => {
    it('returns correct number of positions', () => {
      const positions = manager.calculateHandPositions(5, 1920);
      expect(positions).toHaveLength(5);
    });

    it('centers single card at screen center', () => {
      // With screenWidth=1920, single card should be at x=960 (center)
      const positions = manager.calculateHandPositions(1, 1920);
      expect(positions[0].x).toBe(960);
      // Y position is calculated from scene.scale.height
      expect(positions[0].y).toBeDefined();
    });

    it('spreads cards with correct spacing', () => {
      // At 1920 width, scaleFactorX = 1, so spacing = HAND_SPACING (50)
      const positions = manager.calculateHandPositions(3, 1920);
      const spacing = CARD_CONFIG.HAND_SPACING;

      expect(positions[1].x - positions[0].x).toBe(spacing);
      expect(positions[2].x - positions[1].x).toBe(spacing);
    });
  });

  describe('displayHand', () => {
    it('creates sprites for each card', () => {
      const cards = [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'hearts' },
      ];

      manager.displayHand(cards, { animate: false });

      expect(mockScene.add.sprite).toHaveBeenCalledTimes(2);
      expect(manager.getHandCount()).toBe(2);
    });

    it('does nothing with empty cards', () => {
      manager.displayHand([]);

      expect(mockScene.add.sprite).not.toHaveBeenCalled();
      expect(manager.getHandCount()).toBe(0);
    });

    it('clears existing hand before displaying new one', () => {
      const cards1 = [{ rank: 'A', suit: 'spades' }];
      const cards2 = [{ rank: 'K', suit: 'hearts' }];

      manager.displayHand(cards1, { animate: false });
      manager.displayHand(cards2, { animate: false });

      expect(manager.getHandCount()).toBe(1);
    });

    it('sets card data on sprites', () => {
      const card = { rank: 'A', suit: 'spades' };
      manager.displayHand([card], { animate: false });

      const sprite = mockScene._sprites[0];
      expect(sprite.setData).toHaveBeenCalledWith('card', card);
      expect(sprite.setData).toHaveBeenCalledWith('index', 0);
    });
  });

  describe('setCardClickHandler', () => {
    it('stores click handler', () => {
      const handler = vi.fn();
      manager.setCardClickHandler(handler);

      expect(manager._onCardClick).toBe(handler);
    });
  });

  describe('clearHand', () => {
    it('destroys all hand sprites', () => {
      manager.displayHand(
        [
          { rank: 'A', suit: 'spades' },
          { rank: 'K', suit: 'hearts' },
        ],
        { animate: false }
      );

      const sprites = [...mockScene._sprites];
      manager.clearHand();

      sprites.forEach((sprite) => {
        expect(sprite.destroy).toHaveBeenCalled();
      });
      expect(manager.getHandCount()).toBe(0);
    });
  });

  describe('clearPlayed', () => {
    it('destroys all played card sprites', () => {
      manager._playedSprites[1] = { destroy: vi.fn() };
      manager._playedSprites[2] = { destroy: vi.fn() };

      manager.clearPlayed();

      expect(manager.getPlayedCount()).toBe(0);
    });
  });

  describe('clearAll', () => {
    it('clears both hand and played cards', () => {
      manager.displayHand([{ rank: 'A', suit: 'spades' }], { animate: false });
      manager._playedSprites[1] = { destroy: vi.fn() };

      manager.clearAll();

      expect(manager.getHandCount()).toBe(0);
      expect(manager.getPlayedCount()).toBe(0);
    });
  });

  describe('collectTrick', () => {
    it('animates cards to winner position', () => {
      const sprite1 = { destroy: vi.fn() };
      const sprite2 = { destroy: vi.fn() };
      manager._playedSprites[1] = sprite1;
      manager._playedSprites[2] = sprite2;

      manager.collectTrick(1);

      expect(mockScene.tweens.add).toHaveBeenCalled();
      // After tween completes, sprites should be destroyed
      expect(sprite1.destroy).toHaveBeenCalled();
      expect(sprite2.destroy).toHaveBeenCalled();
    });

    it('clears played sprites after collection', () => {
      manager._playedSprites[1] = { destroy: vi.fn() };
      manager.collectTrick(1);

      expect(manager.getPlayedCount()).toBe(0);
    });
  });
});
