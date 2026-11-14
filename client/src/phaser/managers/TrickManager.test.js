import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrickManager, pileBorder } from './TrickManager.js';
import { bidTotalsFor } from '../../rules/bids.js';
import { getGameState } from '../../state/GameState.js';

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
    expect(card.texture).toBe('back-red'); // no hand yet (GameState.handNo 0): red
    expect(card.setTexture).toHaveBeenCalledWith('cards', 'back-red');
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

describe('TrickManager collect gate', () => {
  let scene;
  let tm;
  let tweens;
  let timers;

  beforeEach(() => {
    tweens = [];
    timers = [];
    scene = {
      scale: { width: 1920, height: 953 },
      tweens: { add: vi.fn((cfg) => { tweens.push(cfg); return { stop: vi.fn() }; }), killTweensOf: vi.fn() },
      time: { delayedCall: vi.fn((ms, fn) => { const t = { ms, fn, remove: vi.fn() }; timers.push(t); return t; }) },
    };
    tm = new TrickManager(scene);
    tm.setPlayerPosition(1);
    setVisibility('visible');
  });

  afterEach(() => setVisibility('visible'));

  const fullTrick = () => { for (let i = 0; i < 4; i++) tm._currentTrick.push(createMockCard({ faceKey: 'two_of_hearts' })); };

  it('is collecting from completeTrick until the last tween lands, then runs the callbacks once', () => {
    fullTrick();
    tm.completeTrick(2, true);
    expect(tm.isCollecting()).toBe(true);
    expect(tweens.every((t) => t.duration === 500)).toBe(true);
    const cb = vi.fn();
    tm.onCollected(cb);
    tweens.slice(0, 3).forEach((t) => t.onComplete());
    expect(cb).not.toHaveBeenCalled();
    tweens[3].onComplete();
    expect(tm.isCollecting()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(timers[0].remove).toHaveBeenCalled();
  });

  it('the last trick of a hand sizes the collect to half of resumeInMs (150-500 ms)', () => {
    fullTrick();
    tm.completeTrick(2, true, 600);
    expect(tweens.every((t) => t.duration === 300)).toBe(true);
  });

  it('a killed tween is covered by the fallback timer (CARD_COLLECT + 150)', () => {
    fullTrick();
    tm.completeTrick(3, false);
    const cb = vi.fn();
    tm.onCollected(cb);
    expect(timers[0].ms).toBe(650);
    timers[0].fn();
    expect(tm.isCollecting()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a stale fallback does not end a newer collect', () => {
    fullTrick();
    tm.completeTrick(3, false);
    const first = timers[0];
    fullTrick();
    tm.completeTrick(4, true);
    first.fn();
    expect(tm.isCollecting()).toBe(true);
  });

  it('clearing the table or snapping (resize) ends it; a hidden tab never starts one', () => {
    fullTrick();
    tm.completeTrick(2, true);
    const cb = vi.fn();
    tm.onCollected(cb);
    tm.clearCurrentTrick();
    expect(tm.isCollecting()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);

    fullTrick();
    tm.completeTrick(2, true);
    tm.repositionTrickHistory();
    expect(tm.isCollecting()).toBe(false);

    setVisibility('hidden');
    fullTrick();
    tm.completeTrick(2, true);
    expect(tm.isCollecting()).toBe(false);
    const now = vi.fn();
    tm.onCollected(now);
    expect(now).toHaveBeenCalledTimes(1);
  });
});

describe('TrickManager addPlayedCard animate flag', () => {
  it('animate=false never tweens, even when only y differs (was `animate && x || y`)', () => {
    const scene = createMockScene();
    scene.add = { image: vi.fn(() => createMockCard({ x: 0, y: 0 })) };
    const tm = new TrickManager(scene);
    tm.setPlayerPosition(1);
    tm.updatePlayPositions();
    const pos = tm._playPositions.partner;
    const card = createMockCard({ x: pos.x, y: pos.y + 40 });
    tm.addPlayedCard({ suit: 'spades', rank: 'A' }, 3, card, false);
    expect(scene.tweens.add).not.toHaveBeenCalled();
    expect([card.x, card.y]).toEqual([pos.x, pos.y]);

    const moving = createMockCard({ x: pos.x, y: pos.y + 40 });
    tm.addPlayedCard({ suit: 'spades', rank: 'K' }, 3, moving, true);
    expect(scene.tweens.add).toHaveBeenCalledTimes(1);
  });
});

describe('TrickManager collect back (the hand the trick was played in)', () => {
  afterEach(() => {
    getGameState().handNo = 0;
    setVisibility('visible');
  });

  it('an opponents\' trick turns face down in its own hand\'s back, even once the next gameStart moved handNo on', () => {
    setVisibility('hidden');
    const scene = createMockScene();
    const tm = new TrickManager(scene);
    tm.setPlayerPosition(1);
    tm.updatePlayPositions();
    getGameState().handNo = 1; // hand 1: red
    const card = createMockCard({ faceKey: 'ace_of_spades' });
    tm.addPlayedCard({ suit: 'spades', rank: 'A' }, 2, card, false);
    getGameState().handNo = 2; // the next hand's gameStart landed before the collect
    tm.completeTrick(2, false);
    expect(card.texture).toBe('back-red');
  });
});

describe('TrickManager trick-stack hover', () => {
  let scene;
  let tm;
  let handlers;

  function hoverableCard() {
    const card = createMockCard();
    card.on = vi.fn((event, fn) => { (handlers.get(card) || handlers.set(card, {}).get(card))[event] = fn; });
    return card;
  }

  beforeEach(() => {
    handlers = new Map();
    scene = createMockScene();
    scene.tweens.add = vi.fn((cfg) => ({ cfg, stop: vi.fn() }));
    scene.time = { delayedCall: vi.fn(() => ({ remove: vi.fn() })) };
    tm = new TrickManager(scene);
    tm.setPlayerPosition(1);
    setVisibility('visible');
  });

  afterEach(() => setVisibility('visible'));

  it('fans from the stack\'s CURRENT position after a resize (the history entry, not a stale copy)', () => {
    const cards = [hoverableCard(), hoverableCard()];
    tm._currentTrick.push(...cards);
    tm.completeTrick(1, true);
    tm._endCollect(); // the collect landed
    const entry = tm._teamTrickHistory[0];
    const before = { ...entry.position };

    scene.scale.width = 1000; // resize: the stack moves
    scene.scale.height = 600;
    tm.repositionTrickHistory();
    const moved = { ...entry.position };
    expect(moved).not.toEqual(before);
    scene.tweens.add.mockClear();

    handlers.get(cards[1]).pointerover();
    const targets = scene.tweens.add.mock.calls.map(([cfg]) => [cfg.x, cfg.y]);
    // the fan's step is the new layout's (read at hover time, ui-6)
    const { fanDx, fanDy } = tm.layout().history.team;
    expect(fanDx).toBeLessThan(30);
    expect(targets[0]).toEqual([moved.x, moved.y]);
    expect(targets[1][0]).toBeCloseTo(moved.x + fanDx);
    expect(targets[1][1]).toBeCloseTo(moved.y - fanDy);

    scene.tweens.add.mockClear();
    handlers.get(cards[1]).pointerout();
    expect(scene.tweens.add.mock.calls.every(([cfg]) => cfg.x === moved.x && cfg.y === moved.y)).toBe(true);
  });

  it('only the previous hover tween is stopped; never killTweensOf (it would kill the collect / whisk)', () => {
    const cards = [hoverableCard()];
    tm._currentTrick.push(...cards);
    tm.completeTrick(1, true);
    tm._endCollect();
    scene.tweens.killTweensOf.mockClear();

    handlers.get(cards[0]).pointerover();
    const first = cards[0].getData('hoverTween');
    handlers.get(cards[0]).pointerout();
    expect(first.stop).toHaveBeenCalled();
    expect(scene.tweens.killTweensOf).not.toHaveBeenCalled();
  });

  it('ignores hovers while the trick is still flying to its stack or being whisked away', () => {
    const cards = [hoverableCard()];
    tm._currentTrick.push(...cards);
    tm.completeTrick(1, true);
    expect(tm.isCollecting()).toBe(true);
    scene.tweens.add.mockClear();
    handlers.get(cards[0]).pointerover();
    handlers.get(cards[0]).pointerout();
    expect(scene.tweens.add).not.toHaveBeenCalled();

    tm._endCollect();
    tm._animatingAway = true;
    handlers.get(cards[0]).pointerover();
    expect(scene.tweens.add).not.toHaveBeenCalled();
  });

  it('another trick\'s collect does not stop an older fanned stack from closing', () => {
    const older = [hoverableCard(), hoverableCard()];
    tm._currentTrick.push(...older);
    tm.completeTrick(1, true);
    tm._endCollect();
    const entry = tm._teamTrickHistory[0];
    handlers.get(older[0]).pointerover(); // fanned

    // The next trick starts collecting while the older stack is fanned
    const next = [hoverableCard()];
    tm._currentTrick.push(...next);
    tm.completeTrick(1, true);
    expect(tm.isCollecting()).toBe(true);
    scene.tweens.add.mockClear();

    handlers.get(older[0]).pointerout();
    expect(scene.tweens.add.mock.calls.map(([cfg]) => cfg.targets)).toEqual(older);
    expect(scene.tweens.add.mock.calls.every(([cfg]) => cfg.x === entry.position.x && cfg.y === entry.position.y)).toBe(true);
    expect(older.map((c) => c.originalDepth)).toEqual([200, 201]);

    // The collecting trick's own cards stay untouched until it lands
    scene.tweens.add.mockClear();
    handlers.get(next[0]).pointerover();
    expect(scene.tweens.add).not.toHaveBeenCalled();
    tm._endCollect();
    handlers.get(next[0]).pointerover();
    expect(scene.tweens.add).toHaveBeenCalled();
  });

  it('restored placeholder stacks hover from their history entry too', () => {
    scene.add = { image: vi.fn(() => hoverableCard()) };
    tm.restoreTrickPlaceholders(1, 0);
    const entry = tm._teamTrickHistory[0];
    entry.position.x = 777; // what repositionTrickHistory does
    handlers.get(entry.cards[0]).pointerover();
    expect(scene.tweens.add.mock.calls[0][0].x).toBe(777);
  });
});

describe('TrickManager bid totals (a bore is the whole hand)', () => {
  it('the bore team\'s pile stays "danger" until it has every trick, past the partner\'s bid', () => {
    const tm = new TrickManager(createMockScene());
    // seat 1 bores, its partner bid 2, on the 5-card hand
    const totals = bidTotalsFor(['B', '1', '2', '1'], 1, 5);
    expect(totals).toEqual({ team: 5, opp: 2 });
    tm.setBidTotals(totals.team, totals.opp);
    const borders = [];
    for (let won = 0; won <= 5; won++) {
      tm._teamTrickCount = won;
      borders.push(tm.pileBorders().team);
    }
    expect(borders).toEqual(['danger', 'danger', 'danger', 'danger', 'danger', 'safe']);
    expect([pileBorder(1, 2), pileBorder(2, 2), pileBorder(0, 0)]).toEqual(['danger', 'safe', 'safe']);
  });

  it('the end-of-hand whisk forgets only its own hand\'s totals, never the next hand\'s', () => {
    const tm = new TrickManager(createMockScene());
    tm.setBidTotals(4, 3);
    const finished = tm.bidTotalsGen();
    // the next hand's doneBidding lands before the whisk does
    tm.setBidTotals(2, 5);
    tm.clearBidTotals(finished);
    expect([tm._teamBidTotal, tm._oppBidTotal]).toEqual([2, 5]);
    tm.clearBidTotals(tm.bidTotalsGen());
    expect([tm._teamBidTotal, tm._oppBidTotal]).toEqual([0, 0]);
  });
});
