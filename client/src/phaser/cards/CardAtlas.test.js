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
import { layoutForViewport } from '../layout/computeTableLayout.js';
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

  it('every face renders: a white rounded face, the index twice (one rotated) and a centre pip, in the suit color', () => {
    for (const card of ALL_CARDS.filter((c) => c.suit !== 'joker')) {
      const ctx = draw(card);
      const color = ['hearts', 'diamonds'].includes(card.suit) ? C.red : C.black;
      expect(fills(ctx, C.face), `${card.rank} ${card.suit} face`).toHaveLength(1);
      // the grey 3-unit border, clipped to the card
      const border = ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.border);
      expect(border?.lineWidth).toBe(3);
      expect(ctx.calls.some((c) => c.op === 'clip')).toBe(true);
      // two corner indices and the pip: 3 suit shapes in the suit color
      expect(fills(ctx, color), `${card.rank} ${card.suit} suits`).toHaveLength(3);
      // the rank, top left and (rotated 180) bottom right
      const ranks = ctx.calls.filter((c) => c.op === 'fillText');
      expect(ranks.map((c) => c.args[0])).toEqual([card.rank, card.rank]);
      expect(ranks.every((c) => c.fillStyle === color)).toBe(true);
      const [tl, br] = ranks;
      expect(tl.at.x).toBeCloseTo(20, 6);
      expect(br.m.a).toBeCloseTo(-1, 6); // rotated by pi
      expect(br.at.x).toBeCloseTo(CARD_DESIGN.w - 20, 6);
      // the pip is centred
      const pip = ctx.calls.filter((c) => c.op === 'fill' && c.fillStyle === color).pop();
      expect(pip.m.a * 50 + pip.m.e).toBeCloseTo(CARD_DESIGN.w / 2, 6);
      expect(pip.m.d * 50 + pip.m.f).toBeCloseTo(CARD_DESIGN.h / 2, 6);
    }
  });

  it('jokers: purple HI / LO in both corners, a star and JOKER, a 4-unit purple border', () => {
    for (const rank of ['HI', 'LO']) {
      const ctx = draw({ suit: 'joker', rank });
      expect(texts(ctx)).toEqual([rank, rank, 'JOKER']);
      expect(ctx.calls.filter((c) => c.op === 'fillText').every((c) => c.fillStyle === C.joker)).toBe(true);
      expect(fills(ctx, C.joker)).toHaveLength(1); // the star (a path)
      expect(ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.joker)?.lineWidth).toBe(4);
    }
  });

  it('the back: iOS dark green, a lighter border, an inner frame and the centre diamond', () => {
    const ctx = draw(BACK_FRAME);
    expect(fills(ctx, C.back)).toHaveLength(1);
    expect(ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.backBorder)?.lineWidth).toBe(4);
    expect(ctx.calls.some((c) => c.op === 'stroke' && c.strokeStyle === C.backInner)).toBe(true);
    expect(fills(ctx, C.backDiamond)).toHaveLength(1);
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

  it('text is the UI font at the iOS weights (bold 40 rank, bold 34 HI/LO, heavy 36 JOKER)', () => {
    const fonts = (ctx) => ctx.calls.filter((c) => c.op === 'fillText').map((c) => c.font);
    expect(fonts(draw({ suit: 'spades', rank: 'K' }))).toEqual([`700 40px ${FONT_UI}`, `700 40px ${FONT_UI}`]);
    expect(fonts(draw({ suit: 'joker', rank: 'HI' }))).toEqual([`700 34px ${FONT_UI}`, `700 34px ${FONT_UI}`, `800 36px ${FONT_UI}`]);
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
    expect(faceFill).toHaveLength(54);
    expect(ctx.depth).toBe(0); // save/restore balanced
  });

  it('the frame bitmap is the hand card at the layout scale times the device pixel ratio (hand cards sample 1:1)', () => {
    for (const [vw, vh] of [[1920, 1080], [1440, 790], [1024, 668], [2560, 1440]]) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const L = layoutForViewport({ vw, vh, dpr });
        const want = cardTextureSize(L.card.hand.h, dpr);
        expect(L.cardTexture).toEqual({ ...want, dpr });
        expect(L.cardTexture.h).toBe(Math.ceil(L.card.hand.h * dpr - 1e-6));
        // the hand sprite maps one frame pixel to (at most) one device pixel
        const devicePerTexel = L.card.hand.scale * dpr;
        expect(devicePerTexel).toBeLessThanOrEqual(1 + 1e-9);
        expect(devicePerTexel).toBeGreaterThan(1 - 1 / L.cardTexture.h);
        // every other card is the same size or smaller: no upscaling anywhere
        for (const k of Object.keys(L.card)) expect(L.card[k].scale, k).toBeLessThanOrEqual(L.card.hand.scale + 1e-9);
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
    // 64 x 93 frames: 530 x 667 px = 1.41 MB; 128 x 186: 1042 x 1318 px = 5.49 MB (the old 64 px atlas page: 13.9 MB)
    expect(atlasLayout(at(1))).toMatchObject({ width: 530, height: 667 });
    expect(one).toBe(530 * 667 * 4);
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
