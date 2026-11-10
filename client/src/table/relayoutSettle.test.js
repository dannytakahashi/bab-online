/**
 * Relayout edge cases on a recorded live table (events-bots-s12, seat 1,
 * the real page and GameScene on testing/fakePhaser.js):
 *
 *   - the first hand's face-down trump is drawn before the log column
 *     narrows the canvas (createUI and gameStart arrive together): the
 *     relayout that follows gives it the layout's scale, and the flip
 *     lands on that scale, not the one it was drawn at;
 *   - a window drag (a resize every frame) after one fast-forward snaps
 *     instead of rendering the table again every frame: a render's own
 *     settle timer is no work in flight;
 *   - a seat plate that truncates a long name shows it on hover (title).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let log;
let at = 0;

function resize(w, h) {
  page.scene.scale.width = w;
  page.scene.scale.height = h;
  page.scene.scale.emit('resize', { width: w, height: h });
  return page.scene.getLayout();
}

function replayTo(i) {
  at = replay.replayLog(page, log, { from: at, to: i });
}

const ffs = () => page.scene.director.stats.fastForwards;

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  // the draw on the full-width canvas (no log column yet)
  page.scene.scale.width = 1024;
  page.scene.scale.height = 668;
});

afterAll(() => vi.useRealTimers());

describe('the first hand\'s trump (drawn before the log column narrows the canvas)', () => {
  it('takes the layout\'s scale at the relayout, and keeps it through the flip', () => {
    const first = log.findIndex((e) => e.event === 'gameStart');
    replayTo(first + 1);
    const scene = page.scene;
    const trump = () => scene.tableCardSprite;
    expect(trump()?.active).toBe(true);
    expect(trump().texture.key).toBe('cardBack'); // face down, the flip still ahead
    expect(scene.director.uiReady).toBe(false); // the teams / createUI fade
    expect(scene.director.pending('deal')).toBeGreaterThan(0); // the flip's wait
    const drawnAt = trump().scaleY;

    // the log column comes on: a narrower canvas
    const before = ffs();
    const L = resize(824, 668);
    expect(ffs()).toBe(before); // the fade: no fast-forward, every manager snaps
    expect(L.trump.card.scale).toBeLessThan(drawnAt);
    expect(trump().scaleX).toBeCloseTo(L.trump.card.scale, 6);
    expect(trump().scaleY).toBeCloseTo(L.trump.card.scale, 6);
    expect([trump().x, trump().y]).toEqual([L.trump.x, L.trump.y]);

    // the flip (after the fade) and the deal land on the same scale
    let guard = 0;
    while (trump()?.texture.key === 'cardBack' && guard++ < 400) replay.advance(25);
    replay.advance(400);
    expect(trump().texture.key).toBe('cards');
    const L2 = scene.getLayout();
    expect(trump().scaleX).toBeCloseTo(L2.trump.card.scale, 6);
    expect(trump().scaleY).toBeCloseTo(L2.trump.card.scale, 6);
    // the same size as my hand's cards (the layout's promise)
    expect(trump().scaleY).toBeCloseTo(scene.cardManager.getHandSprites()[0].scaleY, 6);
  });

  for (const [half, w, h] of [['first', 760, 560], ['second', 640, 480]]) {
    it(`a snap in the flip's ${half} half lands it on the new scale`, () => {
      const scene = page.scene;
      const next = log.findIndex((e, i) => i >= at && e.event === 'gameStart');
      replayTo(next + 1);
      // the whisk, the deal, then the flip (face up in its second half)
      const inHalf = (s) => s?.getData('flipping') && (half === 'first') === (s.texture.key === 'cardBack');
      let guard = 0;
      while (!inHalf(scene.tableCardSprite) && guard++ < 1000) replay.advance(5, 5);
      expect(inHalf(scene.tableCardSprite)).toBe(true);
      // relayout's snap path (a later hand's relayout fast-forwards a flip;
      // the first hand's, inside the fade, snaps)
      const was = scene.getLayout().trump.card.scale;
      scene.scale.width = w;
      scene.scale.height = h;
      scene._layout = null;
      scene.repositionTrumpDisplay();
      const L = scene.getLayout();
      expect(L.w).toBe(w);
      expect(Math.abs(L.trump.card.scale - was)).toBeGreaterThan(0.05); // a real change
      expect(scene.tableCardSprite.scaleY).toBeCloseTo(L.trump.card.scale, 6);
      replay.advance(600);
      const sprite = scene.tableCardSprite;
      expect(sprite.texture.key).toBe('cards');
      expect(sprite.getData('flipping')).toBe(false);
      expect(sprite.scaleX).toBeCloseTo(L.trump.card.scale, 6);
      expect(sprite.scaleY).toBeCloseTo(L.trump.card.scale, 6);
    });
  }
});

describe('a window drag (a resize every frame)', () => {
  it('fast-forwards once for the work in flight, then snaps: no render per frame', async () => {
    const scene = page.scene;
    // a bot's card flying in
    const played = log.findIndex((e, i) => i >= at && e.event === 'cardPlayed' && e.data.position !== 1);
    replayTo(played + 1);
    replay.advance(40);
    expect(scene.director._unsettled()).toBeGreaterThan(0);

    const before = ffs();
    let L = resize(1300, 760);
    expect(ffs()).toBe(before + 1); // the fly-in: rendered at the new size
    // the render's own settle timer is pending, and is no work in flight
    expect(scene.director.pending()).toBeGreaterThan(0);
    expect(scene.director._unsettled()).toBe(0);
    const avatar = document.getElementById('opponent-avatar-partner');
    expect(avatar).toBeTruthy();

    for (let k = 1; k <= 10; k++) {
      replay.advance(16);
      L = resize(1300 - 8 * k, 760 - 4 * k);
    }
    expect(ffs()).toBe(before + 1); // every later frame snapped
    expect(document.getElementById('opponent-avatar-partner')).toBe(avatar); // not rebuilt
    // ...to the last size
    for (const s of scene.trickManager.getCurrentTrickSprites()) {
      const slot = L.trick.slots[s.getData('playPosition')];
      expect([s.x, s.y]).toEqual([slot.x, slot.y]);
    }
    const { handPositions } = await import('../phaser/layout/computeTableLayout.js');
    const hand = scene.cardManager.getHandSprites();
    expect(hand.length).toBeGreaterThan(0);
    for (const [i, p] of handPositions(L, hand.length).entries()) {
      expect([hand[i].x, hand[i].y]).toEqual([p.x, p.y]);
    }
  });

  it('a snap after the render\'s timer ran draws the same table as a fresh render', () => {
    replay.advance(100);
    const scene = page.scene;
    const geometry = () => scene.liveObjects()
      .filter((o) => o.kind !== 'graphics')
      .map((o) => [o.kind === 'sprite' ? 'image' : o.kind, o.texture?.key, o.frame?.name, Math.round(o.x * 100), Math.round(o.y * 100), Math.round(o.scaleX * 1000), Math.round(o.scaleY * 1000)].join('|'))
      .sort();
    if (scene.director.pending() > 0) replay.advance(1500);
    resize(1180, 700);
    const snapped = geometry();
    scene.render();
    expect(geometry()).toEqual(snapped);
  });
});

describe('seat plates', () => {
  it('every plate carries the full name as its title (a long name truncates)', () => {
    const plates = [...document.querySelectorAll('.hud-plate')];
    expect(plates).toHaveLength(4);
    for (const plate of plates) {
      expect(plate.textContent.length).toBeGreaterThan(0);
      expect(plate.title).toBe(plate.textContent);
    }
  });
});
