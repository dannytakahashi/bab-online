/**
 * The hi-res cards (item 18a): every face and the back are drawn (on a
 * recording 2D context: jsdom has no canvas), suits are vector paths (never
 * text, so never a color emoji), the frame bitmap is the hand card times
 * the device pixel ratio, and the atlas is one page, re-drawn only when its
 * size changes.
 */
import { describe, it, expect } from 'vitest';
import { recordingContext } from '../../testing/recordingContext.js';
import { FakeTextures } from '../../testing/fakePhaser.js';
import {
  ALL_CARDS, FACE_FRAMES, BACK_FRAME, SHADOW_FRAME, CARD_DESIGN, drawCard, drawSuit,
} from './cardFaces.js';
import {
  ATLAS_FRAMES, atlasLayout, atlasBytes, cardTextureSize, drawAtlas, ensureCardAtlas, cardAtlasInfo, CARD_TEXTURE_KEY,
} from './CardAtlas.js';
import { layoutForViewport, handPositions } from '../layout/computeTableLayout.js';
import { COLOR, FONT_UI } from '../../ui/tokens.js';

const C = COLOR.card;
// suit symbols, the star, playing-card emoji, variation selectors (FE0E/FE0F)
const GLYPHS = /[♠-♧★☆︎️]|\uD83C[\uDCA0-\uDCFF]/u;

function draw(card) {
  const ctx = recordingContext();
  drawCard(ctx, card);
  return ctx;
}
const fills = (ctx, color) => ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === color);
const texts = (ctx) => ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]);

describe('card faces (the iOS CardTextureGenerator, on a 300 x 435 canvas)', () => {
  it('54 faces: 52 cards and the two jokers, each its own frame', () => {
    expect(ALL_CARDS).toHaveLength(54);
    expect(new Set(FACE_FRAMES).size).toBe(54);
    expect(FACE_FRAMES).toEqual(expect.arrayContaining(['a_spades', '10_hearts', 'q_diamonds', '2_clubs', 'hi_joker', 'lo_joker']));
    expect(CARD_DESIGN).toEqual({ w: 300, h: 435, radius: 24 });
  });

  it('every face renders: a white rounded face, ONE corner index (top left) and a centre pip, in the suit color', () => {
    for (const card of ALL_CARDS.filter((c) => c.suit !== 'joker')) {
      const ctx = draw(card);
      const color = ['hearts', 'diamonds'].includes(card.suit) ? C.red : C.black;
      expect(fills(ctx, C.face), `${card.rank} ${card.suit} face`).toHaveLength(1);
      // the grey 3-unit border, clipped to the card
      const border = ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.border);
      expect(border?.lineWidth).toBe(3);
      expect(ctx.calls.some((c) => c.op === 'clip')).toBe(true);
      // the corner index's suit and the pip: 2 suit shapes in the suit color
      expect(fills(ctx, color), `${card.rank} ${card.suit} suits`).toHaveLength(2);
      // the rank, top left only (no rotated copy at the bottom right;
      // the jumbo index's geometry: cardFaces.test.js)
      const ranks = ctx.calls.filter((c) => c.op === 'fillText');
      expect(ranks.map((c) => c.args[0])).toEqual([card.rank]);
      expect(ranks[0].fillStyle).toBe(color);
      expect(ranks[0].m.a).toBe(1);
      expect(ranks[0].at.x).toBeLessThan(CARD_DESIGN.w / 2);
      expect(ranks[0].at.y).toBeLessThan(CARD_DESIGN.h / 2);
      // the pip is centred across the card
      const pip = ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === color).pop();
      expect(pip.m.a * 50 + pip.m.e).toBeCloseTo(CARD_DESIGN.w / 2, 6);
    }
  });

  it('jokers: the word (HI red, LO black) once, in the corner, on the faithful sprite (no purple, no star, no JOKER)', () => {
    for (const [rank, color] of [['HI', C.red], ['LO', C.black]]) {
      const ctx = draw({ suit: 'joker', rank });
      expect(texts(ctx)).toEqual([rank]);
      expect(ctx.calls.find((c) => c.op === 'fillText').fillStyle).toBe(color);
      expect(ctx.calls.some((c) => c.fillStyle === C.joker || c.strokeStyle === C.joker)).toBe(false);
    }
  });

  it('the back: a white card edge, then iOS dark green, a lighter border, an inner frame and the app icon\'s four suits', () => {
    const ctx = draw(BACK_FRAME);
    // The white edge is painted first (the whole card), so an overlapped fan
    // of backs reads as separate cards on the green felt; the green panel is inset.
    const firstFill = ctx.calls.find((c) => c.op === 'fill');
    expect(firstFill.fillStyle).toBe(C.face);
    expect(ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.border)?.lineWidth).toBe(3);
    expect(fills(ctx, C.back)).toHaveLength(1);
    expect(ctx.calls.indexOf(fills(ctx, C.back)[0])).toBeGreaterThan(ctx.calls.indexOf(firstFill));
    expect(ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.backBorder)?.lineWidth).toBe(4);
    expect(ctx.calls.some((c) => c.op === 'stroke' && c.strokeStyle === C.backInner)).toBe(true);
    // iOS PR 239's back: no diamond; spade and club in text.primary at the
    // top left and bottom right, heart and diamond in danger.text at the
    // top right and bottom left, 2 x 2 around the centre, as vector paths
    expect(fills(ctx, C.backDiamond)).toHaveLength(0);
    const light = fills(ctx, COLOR.text.primary);
    const red = fills(ctx, COLOR.danger.text);
    expect(light).toHaveLength(2);
    expect(red).toHaveLength(2);
    // each suit's 100-unit box is scaled (m.a) and moved (m.e, m.f): its centre
    const centre = (c) => ({ x: Math.round(c.m.a * 50 + c.m.e), y: Math.round(c.m.d * 50 + c.m.f) });
    const { w, h } = CARD_DESIGN;
    expect(light.map(centre)).toEqual([{ x: w / 2 - 34, y: Math.round(h / 2 - 34) }, { x: w / 2 + 34, y: Math.round(h / 2 + 34) }]);
    expect(red.map(centre)).toEqual([{ x: w / 2 + 34, y: Math.round(h / 2 - 34) }, { x: w / 2 - 34, y: Math.round(h / 2 + 34) }]);
    expect(texts(ctx)).toEqual([]);
  });

  it('suits are vector paths, never text: no suit, star, card emoji or variation selector is ever drawn as a glyph', () => {
    for (const card of [...ALL_CARDS, BACK_FRAME]) {
      for (const t of texts(draw(card))) expect(GLYPHS.test(t), `${JSON.stringify(card)}: "${t}"`).toBe(false);
    }
    // a suit draws with bezier/arc paths and a fill, no text
    for (const suit of ['spades', 'hearts', 'diamonds', 'clubs']) {
      const ctx = recordingContext();
      drawSuit(ctx, suit, 50, 50, 100);
      expect(ctx.calls.some((c) => c.op === 'bezierCurveTo' || c.op === 'arc')).toBe(true);
      expect(ctx.calls.filter((c) => c.op === 'fill')).toHaveLength(1);
      expect(texts(ctx)).toEqual([]);
    }
  });

  it('text is the UI font in bold (the rank and the joker word; sizes: cardFaces.test.js)', () => {
    const fonts = (ctx) => ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.font);
    for (const card of [{ suit: 'spades', rank: 'K' }, { suit: 'joker', rank: 'HI' }]) {
      const f = fonts(draw(card));
      expect(f).toHaveLength(1);
      expect(f[0]).toMatch(new RegExp(`^700 [0-9.]+px ${FONT_UI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    }
    expect(FONT_UI.startsWith('-apple-system')).toBe(true);
  });
});

describe('the atlas: one page, hand card x DPR', () => {
  it('draws every frame (54 faces, the back, the shadow) into its own cell, no cell over another', () => {
    const spec = { w: 64, h: 93 };
    const ctx = recordingContext();
    const drawn = drawAtlas(ctx, spec);
    expect(drawn).toEqual([...FACE_FRAMES, BACK_FRAME, SHADOW_FRAME]);
    const page = atlasLayout(spec);
    const cells = ATLAS_FRAMES.map((n) => page.frames[n]);
    for (let i = 0; i < cells.length; i++) {
      const a = cells[i];
      expect(a.x + a.w).toBeLessThanOrEqual(page.width);
      expect(a.y + a.h).toBeLessThanOrEqual(page.height);
      for (let j = i + 1; j < cells.length; j++) {
        const b = cells[j];
        const apart = a.x + a.w + 2 <= b.x || b.x + b.w + 2 <= a.x || a.y + a.h + 2 <= b.y || b.y + b.h + 2 <= a.y;
        expect(apart, `${ATLAS_FRAMES[i]} / ${ATLAS_FRAMES[j]}`).toBe(true);
      }
    }
    // every card is drawn under its cell's transform: the design canvas onto the cell
    const faceFill = ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === C.face);
    expect(faceFill).toHaveLength(55); // 54 faces + the back's white card edge
    expect(ctx.depth).toBe(0); // save/restore balanced
  });

  it('the frame bitmap is the hand card at the layout scale times the device pixel ratio (hand cards sample 1:1)', () => {
    for (const [vw, vh] of [[1920, 1080], [1440, 790], [1024, 668], [2560, 1440]]) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const L = layoutForViewport({ vw, vh, dpr });
        const want = cardTextureSize(L.card.hand.h, dpr);
        expect(L.cardTexture).toEqual({ ...want, dpr });
        expect(L.cardTexture.h).toBe(Math.ceil(L.card.hand.h * dpr - 1e-6));
        // the hand sprite maps one frame pixel to exactly one device pixel
        const devicePerTexel = L.card.hand.scale * dpr;
        expect(devicePerTexel).toBeCloseTo(1, 9);
        // every other card is the same size or smaller: no upscaling anywhere
        for (const k of Object.keys(L.card)) expect(L.card[k].scale, k).toBeLessThanOrEqual(L.card.hand.scale + 1e-9);
      }
    }
  });

  it('every hand card lands texel-on-pixel: its quad, snapped as Phaser snaps it (roundPixels), is the frame in device px', () => {
    // Phaser 3.55 rounds each corner of a textured quad in backing-store px
    // when roundPixels is on (camera zoom included): a frame centred on a
    // whole pixel with an odd height no longer starts half a pixel off (the
    // game config's roundPixels: backingStore.test.js)
    const sizes = [[1920, 1080], [1440, 790], [1366, 768], [1024, 668], [1536, 864], [2560, 1440], [1280, 720]];
    for (const [vw, vh] of sizes) {
      for (const dpr of [1, 1.25, 1.5, 2, 3]) {
        const L = layoutForViewport({ vw, vh, dpr });
        const { w, h } = L.card.hand;
        const tex = L.cardTexture;
        for (const p of handPositions(L, 13)) {
          const x0 = Math.round((p.x - w / 2) * dpr);
          const x1 = Math.round((p.x + w / 2) * dpr);
          const y0 = Math.round((p.y - h / 2) * dpr);
          const y1 = Math.round((p.y + h / 2) * dpr);
          expect([x1 - x0, y1 - y0], `${vw}x${vh}@${dpr}`).toEqual([tex.w, tex.h]);
        }
      }
    }
  });

  it('the bitmap is capped (the iOS 3x card) and keeps the 300 x 435 proportions', () => {
    const big = cardTextureSize(10000, 4);
    expect(big.h).toBe(435);
    expect(big.w).toBe(300);
    const s = cardTextureSize(93, 2);
    expect(s).toEqual({ w: 128, h: 186 });
    expect(s.w / s.h).toBeCloseTo(300 / 435, 2);
  });

  it('texture memory (one RGBA page): 1920x1080 at DPR 1 and 2', () => {
    const at = (dpr) => layoutForViewport({ vw: 1920, vh: 1080, dpr }).cardTexture;
    const one = atlasBytes(at(1));
    const two = atlasBytes(at(2));
    // 64 x 92 frames: 530 x 660 px = 1.40 MB; 128 x 186: 1042 x 1318 px = 5.49 MB (the old 64 px atlas page: 13.9 MB)
    expect(atlasLayout(at(1))).toMatchObject({ width: 530, height: 660 });
    expect(one).toBe(530 * 660 * 4);
    expect(atlasLayout(at(2))).toMatchObject({ width: 1042, height: 1318 });
    expect(two).toBe(1042 * 1318 * 4);
    expect(two).toBeLessThan(8 * 1024 * 1024);
  });

  it('ensureCardAtlas builds one texture, re-draws only on a size change, and resizes its frames in place', () => {
    const textures = new FakeTextures();
    const a = ensureCardAtlas(textures, { w: 64, h: 93 });
    expect(a.changed).toBe(true);
    const tex = textures.get(CARD_TEXTURE_KEY);
    expect(Object.keys(tex.frames)).toEqual(ATLAS_FRAMES);
    expect(tex.filter).toBe(0); // linear
    const canvas = tex.canvas;
    const uploads = textures.uploads;
    const draws = textures.drawCalls;
    expect(draws).toBeGreaterThan(54 * 3);

    // the same size (every render): nothing drawn, uploaded or allocated
    expect(ensureCardAtlas(textures, { w: 64, h: 93 }).changed).toBe(false);
    expect([textures.uploads, textures.drawCalls, textures.get(CARD_TEXTURE_KEY).canvas]).toEqual([uploads, draws, canvas]);

    // a new size (DPR 2): the same texture and canvas, frames resized in place
    const frame = tex.frames.a_spades;
    const b = ensureCardAtlas(textures, { w: 128, h: 186 });
    expect(b.changed).toBe(true);
    expect(textures.get(CARD_TEXTURE_KEY)).toBe(tex);
    expect(tex.canvas).toBe(canvas);
    expect(tex.frames.a_spades).toBe(frame);
    expect([frame.width, frame.height]).toEqual([128, 186]);
    expect([canvas.width, canvas.height]).toEqual([atlasLayout({ w: 128, h: 186 }).width, atlasLayout({ w: 128, h: 186 }).height]);
    expect(cardAtlasInfo(textures)).toMatchObject({ frame: { w: 128, h: 186 }, bytes: b.bytes });
  });
});
