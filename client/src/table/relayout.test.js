/**
 * Resizes on a recorded live table (events-bots-s12, seat 1, the real page,
 * GameScene and managers on testing/fakePhaser.js): every manager reads the
 * one table layout, and GameScene.relayout() (Phaser's scale 'resize')
 * moves everything to the new layout, also in the middle of an animation:
 *
 *   - the draw: the deck follows a resize, and a click picks the card under
 *     the pointer (ui-19: per-card hit areas, topmost first);
 *   - the deal: a resize while the backs fly in leaves none at the old
 *     spots (webclient-17(c): the director fast-forwards to the model);
 *   - mid-trick: all four played cards move to the new slots, the
 *     opponents' too (cli-12); a card still flying fast-forwards;
 *   - a stack's hover fans from its new position, by the new step (ui-6);
 *   - the DOM HUD (seats, bubble, frog) follows; relayout() then render()
 *     draws the same table as the relayout left (a fresh render).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;
let L;
let at = 0;
let layoutMod;

const r2 = (v) => Math.round(v * 100) / 100;

/** Phaser's ScaleManager after a window resize: new size, then 'resize'. */
function resize(w, h) {
  page.scene.scale.width = w;
  page.scene.scale.height = h;
  page.scene.scale.emit('resize', { width: w, height: h });
  return page.scene.getLayout();
}

/**
 * Every live game object's geometry, sorted: texture, frame, position,
 * scale, rotation, alpha (no graphics: they redraw; not the kind: my
 * played card is the hand's sprite live and an image after a render).
 */
function geometry(scene) {
  const box = (o) => { const b = o.getBounds(); return [b.x, b.y, b.width, b.height].map(r2).join(','); };
  return scene.liveObjects()
    .filter((o) => o.kind !== 'graphics')
    .map((o) => [o.kind === 'sprite' ? 'image' : o.kind, o.texture?.key, o.frame?.name, r2(o.x), r2(o.y), r2(o.scaleX), r2(o.scaleY), r2(o.rotation), o.alpha, box(o)].join('|'))
    .sort();
}

const near = (a, b, label) => expect(Math.abs(a - b), `${label}: ${a} vs ${b}`).toBeLessThan(0.01);
function expectRect(b, r, label) {
  near(b.x, r.x, `${label} x`);
  near(b.y, r.y, `${label} y`);
  near(b.width, r.w, `${label} w`);
  near(b.height, r.h, `${label} h`);
}

/**
 * What is DRAWN matches the layout (getBounds: position less the display
 * origin, times the scale), not only the positions the managers set: the
 * trump's box and card, the trick cards, the hand, the stacks and the
 * history containers (graphics: their drawn rects).
 */
function expectRendered(scene, layout) {
  const { trump } = layout;
  const bg = scene.tableCardBackground;
  expect(bg?.active).toBe(true);
  expectRect(bg.getBounds(), { x: trump.x - trump.box / 2, y: trump.y - trump.box / 2, w: trump.box, h: trump.box }, 'trump box');
  const card = scene.tableCardSprite.getBounds();
  near(card.centerX, trump.x, 'trump card x');
  near(card.centerY, trump.y, 'trump card y');
  near(card.width, trump.card.frame, 'trump card w');
  const label = scene.tableCardLabel;
  near(label.x, trump.label.x, 'trump label x');
  expect([label.originX, label.originY]).toEqual([0.5, 0.5]);
  for (const s of scene.trickManager.getCurrentTrickSprites()) {
    if (!s.active) continue;
    const b = s.getBounds();
    const slot = layout.trick.slots[s.getData('playPosition')];
    near(b.centerX, slot.x, 'trick x');
    near(b.centerY, slot.y, 'trick y');
    near(b.width, layout.card.trick.frame, 'trick w');
  }
  for (const s of scene.cardManager.getHandSprites()) {
    const b = s.getBounds();
    near(b.width, layout.card.hand.frame, 'hand w');
    // the visible card (the frame less its padding) inside the hand box
    const vis = { x: b.centerX - layout.card.hand.w / 2, y: b.y, w: layout.card.hand.w, h: b.height };
    expect(layoutMod.contains({ ...layout.hand.rect, y: -1e6, h: 2e6 }, vis), 'hand card in the box').toBe(true);
  }
  const g = scene.trickManager._backgroundGraphics;
  if (g?.active) {
    expect([g.x, g.y, g.scaleX, g.scaleY]).toEqual([0, 0, 1, 1]);
    const blocks = g.drawn.filter((d) => d.op === 'fill');
    expect(blocks.length).toBeGreaterThan(0);
    for (const d of blocks) {
      // (half a pixel: the slots snap to device pixels inside the block)
      const inBlock = ['team', 'opp'].some((side) => layoutMod.contains(layout.history[side].rect, d, 0.51));
      expect(inBlock, `history graphics ${JSON.stringify(d)}`).toBe(true);
    }
  }
}

function replayTo(i) {
  at = replay.replayLog(page, log, { from: at, to: i });
}

const ffs = () => page.scene.director.stats.fastForwards;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  layoutMod = await import('../phaser/layout/computeTableLayout.js');
  rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
});

afterAll(() => vi.useRealTimers());

describe('the draw (ui-19)', () => {
  it('a resize mid-deal-in moves the deck; a click picks the card under the pointer, not two to the left', () => {
    const startDraw = log.findIndex((e) => e.event === 'startDraw');
    replayTo(startDraw + 1);
    replay.advance(300); // the deck is still flying in
    const dm = page.scene.drawManager;
    expect(dm.deckCards()).toHaveLength(54);

    L = resize(1100, 700);
    expect(L.w).toBe(1100);
    // every deck card at its new spot, its fly-in stopped
    for (const { card } of dm.deckCards()) {
      const p = layoutMod.deckPosition(L, card.getData('deckIndex'));
      expect([card.x, card.y]).toEqual([p.x, p.y]);
      expect(card.scaleX).toBeCloseTo(L.draw.deck.card.scale, 6);
    }
    replay.advance(1000);
    const c0 = dm.deckCards()[0].card;
    expect([c0.x, c0.y]).toEqual([layoutMod.deckPosition(L, 0).x, layoutMod.deckPosition(L, 0).y]);

    // empty felt right of the deck draws nothing
    const last = layoutMod.deckPosition(L, 53);
    const visibleW = L.draw.deck.card.w;
    page.socket.clearEmits();
    expect(page.scene.pointerDownAt(last.x + visibleW / 2 + 6, last.y)).toBeNull();
    expect(page.socket.emitted('draw')).toEqual([]);

    // the strip of card 20 that card 21 does not cover
    const p20 = layoutMod.deckPosition(L, 20);
    const x = p20.x - visibleW / 2 + L.draw.deck.overlap / 2;
    const top = page.scene.objectsAt(x, p20.y)[0];
    expect(top.getData('deckIndex')).toBe(20);
    page.scene.pointerDownAt(x, p20.y);
    expect(page.socket.emitted('draw')).toHaveLength(1);
    expect(dm.clickedCardSprite.getData('deckIndex')).toBe(20);
    // one draw only
    page.scene.pointerDownAt(x, p20.y);
    expect(page.socket.emitted('draw')).toHaveLength(1);
  });
});

describe('the teams overlay', () => {
  it('a resize while it is up keeps the dim over the whole canvas (its drawn box, not only its centre)', () => {
    const teams = log.findIndex((e) => e.event === 'teamsAnnounced');
    expect(teams).toBeGreaterThan(at);
    replayTo(teams + 1);
    replay.advance(100);
    const dm = page.scene.drawManager;
    const overlay = dm._teamElements?.[0];
    expect(overlay?.active).toBe(true);
    for (const [w, h] of [[390 - 130, 844], [1440, 790], [1024, 668]]) {
      L = resize(w, h);
      expectRect(overlay.getBounds(), { x: 0, y: 0, w: L.w, h: L.h }, `teams overlay at ${w}x${h}`);
    }
  });
});

describe('the deal (webclient-17(c))', () => {
  it('a resize while the backs fly in leaves every back at its new fan spot', () => {
    const deal2 = log.findIndex((e, i) => i > 20 && e.event === 'gameStart');
    replayTo(deal2 + 1);
    // the whisk, then the deal flies in from the trump
    let guard = 0;
    while (page.scene.opponentManager.cardCounts().partner === 0 && guard++ < 100) replay.advance(25);
    replay.advance(100);
    const om = page.scene.opponentManager;
    const backs = () => ['partner', 'opp1', 'opp2'].flatMap((slot) => om._cardSprites[slot].map((s, i) => ({ slot, s, i })));
    expect(backs().length).toBeGreaterThan(0);
    expect(backs().some(({ s }) => s.getData('moveTween')?.isPlaying())).toBe(true); // in flight

    const before = ffs();
    L = resize(1280 - 240, 620);
    expect(ffs()).toBe(before + 1); // work in flight: the director rendered the model at the new size
    const check = () => {
      const seatOf = { partner: 'partner', opp1: 'opp1', opp2: 'opp2' };
      for (const slot of ['partner', 'opp1', 'opp2']) {
        const sprites = om._cardSprites[slot];
        const spots = layoutMod.fanPositions(L, seatOf[slot], sprites.length);
        sprites.forEach((s, i) => {
          expect([r2(s.x), r2(s.y)]).toEqual([r2(spots[i].x), r2(spots[i].y)]);
          expect(s.scaleX).toBeCloseTo(L.card.back.scale, 6);
        });
      }
      for (const [i, p] of layoutMod.handPositions(L, page.scene.cardManager.getHandCount()).entries()) {
        const s = page.scene.cardManager.getHandSprites()[i];
        expect([s.x, s.y]).toEqual([p.x, p.y]);
      }
    };
    check();
    replay.advance(1500); // no old tween lands later
    check();
    expect(replay.liveCounts(page.scene)).toMatchObject({ opponentBacks: backs().length });
  });

  it('OpponentManager.reposition alone stops a deal tween still heading for the old spot', () => {
    const om = page.scene.opponentManager;
    om.displayOpponentCards(5); // a fresh deal, flying in
    expect(om._cardSprites.partner[0].getData('moveTween').isPlaying()).toBe(true);
    page.scene.scale.width = 900;
    page.scene.scale.height = 600;
    om.reposition();
    const L2 = page.scene.getLayout();
    replay.advance(1500);
    const spots = layoutMod.fanPositions(L2, 'partner', 5);
    om._cardSprites.partner.forEach((s, i) => expect([s.x, s.y]).toEqual([spots[i].x, spots[i].y]));
    // back to the table the recording is at
    page.scene.scale.width = L.w;
    page.scene.scale.height = L.h;
    page.scene.render();
  });
});

describe('mid-trick (cli-12, ui-6)', () => {
  let trickEnd;

  it('a resize with all four cards down moves every one to its new slot, the opponents\' too', () => {
    // a full trick on the table, a few tricks into hand 2 (stacks exist)
    trickEnd = log.findIndex((e, i) => i > at + 25 && e.event === 'trickComplete');
    replayTo(trickEnd);
    replay.advance(400); // the last fly-in landed
    const tm = page.scene.trickManager;
    const trick = tm.getCurrentTrickSprites();
    expect(trick).toHaveLength(4);
    expect(trick.filter((s) => s.getData('playPosition') !== 'self')).toHaveLength(3);
    expect(page.scene.director.pending()).toBe(0);

    const before = ffs();
    L = resize(1920 - 320, 1080);
    expect(ffs()).toBe(before); // nothing in flight: every manager snapped (no render)
    for (const s of trick) {
      const slot = L.trick.slots[s.getData('playPosition')];
      expect(s.active).toBe(true);
      expect([s.x, s.y]).toEqual([slot.x, slot.y]);
      expect(s.scaleX).toBeCloseTo(L.card.trick.scale, 6);
    }
    // and again at a small window
    L = resize(1440 - 320, 790);
    for (const s of trick) {
      const slot = L.trick.slots[s.getData('playPosition')];
      expect([s.x, s.y]).toEqual([slot.x, slot.y]);
    }
    // what is drawn is where the layout says (the trump's box kept its
    // first size's origin: drawn off-centre after a resize)
    expectRendered(page.scene, L);
    // the stacks sit on their new slots
    const stacks = [...tm._teamTrickHistory.map((t) => ['team', t]), ...tm._oppTrickHistory.map((t) => ['opp', t])];
    expect(stacks.length).toBeGreaterThan(0);
    for (const [side, t] of stacks) {
      const p = layoutMod.historySlot(L, side, t.trickNumber);
      expect(t.position).toEqual({ x: p.x, y: p.y });
      for (const c of t.cards) expect([c.x, c.y]).toEqual([p.x, p.y]);
    }
  });

  it('the HUD follows: every seat node at its avatar, the frog in the dealer\'s seat', () => {
    const hud = document.getElementById('table-hud');
    expect(hud).toBeTruthy();
    for (const seat of hud.querySelectorAll('.hud-seat')) {
      const s = L.seats[seat.dataset.seat];
      expect(seat.style.left).toBe(`${s.avatar.x}px`);
      expect(seat.style.top).toBe(`${s.avatar.y}px`);
    }
    const frog = hud.querySelector('.dealer-button');
    expect(frog.closest('.hud-seat')).toBeTruthy();
    expect(hud.querySelectorAll('.opponent-avatar-container')).toHaveLength(3);
    expect(hud.querySelector('#player-avatar-container').closest('.hud-seat').dataset.seat).toBe('self');
  });

  it('relayout() then render() draws the same table (the relayout is a fresh render)', () => {
    const after = geometry(page.scene);
    page.scene.render();
    expect(geometry(page.scene)).toEqual(after);
  });

  it('a stack\'s hover fans from its new position by the new step', () => {
    const tm = page.scene.trickManager;
    replay.advance(100); // the render's hand timer
    expect(page.scene.director.pending()).toBe(0);
    const entry = tm._teamTrickHistory[0] || tm._oppTrickHistory[0];
    const side = tm._teamTrickHistory[0] ? 'team' : 'opp';
    L = resize(1024 - 240, 668);
    expectRendered(page.scene, L);
    // a phone, then back: the box follows both ways
    L = resize(390 - 130, 844);
    expectRendered(page.scene, L);
    L = resize(1024 - 240, 668);
    expectRendered(page.scene, L);
    const p = layoutMod.historySlot(L, side, entry.trickNumber);
    expect(entry.position).toEqual({ x: p.x, y: p.y });
    entry.cards[1].emit('pointerover');
    replay.advance(250);
    const { fanDx, fanDy } = L.history.team;
    entry.cards.forEach((c, i) => {
      expect(c.x).toBeCloseTo(p.x + i * fanDx, 6);
      expect(c.y).toBeCloseTo(p.y - i * fanDy, 6);
    });
    entry.cards[1].emit('pointerout');
    replay.advance(250);
    entry.cards.forEach((c) => expect([c.x, c.y]).toEqual([p.x, p.y]));
  });

  it('a resize while a played card is still flying in fast-forwards it to its new slot', () => {
    replayTo(trickEnd + 1); // the trick is collected
    const next = log.findIndex((e, i) => i >= at && e.event === 'cardPlayed');
    replayTo(next + 1);
    replay.advance(40); // mid-flight
    const tm = page.scene.trickManager;
    expect(page.scene.director.pending()).toBeGreaterThan(0);
    const before = ffs();
    L = resize(1600, 1080);
    expect(ffs()).toBe(before + 1);
    const trick = tm.getCurrentTrickSprites();
    expect(trick.length).toBeGreaterThan(0);
    for (const s of trick) {
      const slot = L.trick.slots[s.getData('playPosition')];
      expect([s.x, s.y]).toEqual([slot.x, slot.y]);
    }
    replay.advance(1000);
    for (const s of trick) {
      if (!s.active) continue;
      const slot = L.trick.slots[s.getData('playPosition')];
      expect([s.x, s.y]).toEqual([slot.x, slot.y]);
    }
    // the rest of the game still matches the server at every checkpoint
    const cps = new Map(replay.tableCheckpoints(rec, 'seat1').map((c) => [c.afterIndex, c]));
    const bad = [];
    replay.replayLog(page, log, {
      from: at,
      before: (e) => {
        const cp = cps.get(e.i);
        if (!cp || page.scene.director.waiting > 0) return;
        const live = replay.liveCounts(page.scene);
        const want = replay.expectedCounts(cp.snapshot);
        if (JSON.stringify(live) !== JSON.stringify(want)) bad.push({ i: e.i, live, want });
      },
    });
    expect(bad).toEqual([]);
  });
});
