import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrickManager } from './TrickManager.js';

function createMockScene() {
  return {
    scale: { width: 1920, height: 953 },
    tweens: { add: vi.fn(), killTweensOf: vi.fn() },
  };
}

function createMockCard({ x = 960, y = 476, faceKey, flipTimer, moveTween } = {}) {
  const data = { faceKey, flipTimer, moveTween, playPosition: 'partner' };
  return {
    x,
    y,
    active: true,
    texture: 'cardBack',
    setTexture: vi.fn(function (key, frame) { this.texture = frame ?? key; return this; }),
    setScale: vi.fn(function () { return this; }),
    setDepth: vi.fn(function () { return this; }),
    setRotation: vi.fn(function () { return this; }),
    setInteractive: vi.fn(function () { return this; }),
    on: vi.fn(),
    getData: vi.fn((key) => data[key]),
    setData: vi.fn((key, value) => { data[key] = value; }),
  };
}

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('TrickManager stale animations', () => {
  let scene;
  let tm;

  beforeEach(() => {
    scene = createMockScene();
    tm = new TrickManager(scene);
    tm.setPlayerPosition(1);
  });

  afterEach(() => {
    setVisibility('visible');
  });

  it('completeTrick (hidden) kills pending tweens and the flip timer before snapping', () => {
    setVisibility('hidden');
    const flipTimer = { remove: vi.fn() };
    const card = createMockCard({ faceKey: 'ace_of_spades', flipTimer });
    tm._currentTrick.push(card);

    tm.completeTrick(2, false);

    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(card);
    expect(flipTimer.remove).toHaveBeenCalledWith(false);
    expect(card.setData).toHaveBeenCalledWith('flipTimer', null);
    // Opponents' tricks stay face down, snapped to the stack without a tween
    expect(card.texture).toBe('cardBack');
    expect(scene.tweens.add).not.toHaveBeenCalled();
    expect(card.setRotation).toHaveBeenCalledWith(0);
  });

  it('completeTrick shows the face of an interrupted flip on our team stack', () => {
    setVisibility('hidden');
    const card = createMockCard({ faceKey: 'ace_of_spades' });
    tm._currentTrick.push(card);

    tm.completeTrick(1, true);

    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(card);
    expect(card.setTexture).toHaveBeenCalledWith('cards', 'ace_of_spades');
  });

  it('repositionTrickHistory cancels in-flight tweens on stacked cards', () => {
    const card = createMockCard();
    card.originalDepth = 200;
    tm._teamTrickHistory.push({ cards: [card], position: { x: 0, y: 0 }, trickNumber: 1 });

    tm.repositionTrickHistory();

    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(card);
    expect(card.setDepth).toHaveBeenCalledWith(200);
  });

  it('completeTrick (hidden) stops a queued move tween that killTweensOf cannot see', () => {
    setVisibility('hidden');
    const moveTween = { stop: vi.fn() };
    const card = createMockCard({ moveTween });
    tm._currentTrick.push(card);

    tm.completeTrick(2, false);

    expect(moveTween.stop).toHaveBeenCalled();
    expect(card.setData).toHaveBeenCalledWith('moveTween', null);
  });

  it('a resize during the end-of-hand whisk does not cancel it', () => {
    // Tween list where killTweensOf really removes a target's tweens
    const queued = [];
    scene.tweens.add = vi.fn((cfg) => { queued.push(cfg); return cfg; });
    scene.tweens.killTweensOf = vi.fn((target) => {
      for (let i = queued.length - 1; i >= 0; i--) {
        if (queued[i].targets === target) queued.splice(i, 1);
      }
    });
    const cards = [createMockCard(), createMockCard(), createMockCard(), createMockCard()];
    cards.forEach((card) => {
      card.destroy = vi.fn(function () { this.active = false; });
    });
    tm._teamTrickHistory.push({ cards, position: { x: 0, y: 0 }, trickNumber: 1 });
    const done = vi.fn();

    tm.animateTricksAway(500, 500, done);
    // Phaser scale 'resize' -> GameScene.handleResize -> repositionCurrentTrick
    tm.repositionCurrentTrick();
    queued.splice(0).forEach((tween) => tween.onComplete?.());

    expect(cards.every((card) => card.destroy.mock.calls.length === 1)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(tm._teamTrickHistory).toEqual([]);

    // Once the whisk is over, resizes reposition the next hand's stacks again
    const next = createMockCard();
    tm._teamTrickHistory.push({ cards: [next], position: { x: 0, y: 0 }, trickNumber: 1 });
    tm.repositionTrickHistory();
    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(next);
  });

  it('repositionCurrentTrick cancels tweens and settles the card at its slot', () => {
    const card = createMockCard({ faceKey: 'king_of_hearts' });
    tm._currentTrick.push(card);

    tm.repositionCurrentTrick();

    expect(scene.tweens.killTweensOf).toHaveBeenCalledWith(card);
    expect(card.setTexture).toHaveBeenCalledWith('cards', 'king_of_hearts');
    expect(card.x).toBe(tm._playPositions.partner.x);
    expect(card.y).toBe(tm._playPositions.partner.y);
  });
});
