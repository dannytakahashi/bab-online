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
  ALL_CARDS, FACE_FRAMES, BACK_FRAMES, SHADOW_FRAME, CARD_DESIGN, drawCard, drawSuit, backFrameForHand, isBackFrame,
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

  it('the back: the lattice, a cream card with the faces\' grey edge, an inset ink panel, a cream trellis and medallion, no text', () => {
    const ctx = draw(BACK_FRAMES.red);
    // the card first (cream, the faces' grey 3-unit edge, clipped to the card)
    const firstFill = ctx.calls.find((c) => c.op === 'fill');
    expect(firstFill.fillStyle).toBe(C.backPaper);
    expect(ctx.calls.find((c) => c.op === 'stroke' && c.strokeStyle === C.border)?.lineWidth).toBe(3);
    // the ink panel (inset 16: a white margin, so an overlapped fan reads
    // as separate cards) and the medallion's moat, both in the red ink
    const ink = fills(ctx, C.backRed);
    expect(ink).toHaveLength(2);
    expect(ctx.calls.indexOf(ink[0])).toBeGreaterThan(ctx.calls.indexOf(firstFill));
    // the trellis: a cream double line split by an ink line, clipped to the field
    expect(ctx.calls.filter((c) => c.op === 'clip').length).toBeGreaterThanOrEqual(2);
    expect(ctx.calls.some((c) => c.op === 'stroke' && c.strokeStyle === C.backPaper && c.lineWidth === 3.8)).toBe(true);
    expect(ctx.calls.some((c) => c.op === 'stroke' && c.strokeStyle === C.backRed && c.lineWidth === 1.2)).toBe(true);
    // the four lozenges of the harlequin medallion: the last fill, centred
    const last = ctx.calls.filter((c) => c.op === 'fill').pop();
    expect(last.fillStyle).toBe(C.backPaper);
    // nothing of the old four-suit back, no other colour, no text
    for (const old of [C.back, C.backBorder, C.backInner, C.backBlue, COLOR.text.primary, COLOR.danger.text]) {
      expect(ctx.calls.some((c) => (c.op === 'fill' && c.fillStyle === old) || (c.op === 'stroke' && c.strokeStyle === old)), old).toBe(false);
    }
    expect(texts(ctx)).toEqual([]);
    expect(ctx.depth).toBe(0);
  });

  it('the blue back is the red one in the blue ink: the same drawing, only the ink differs', () => {
    const red = draw(BACK_FRAMES.red).calls;
    const blue = draw(BACK_FRAMES.blue).calls;
    expect(blue).toHaveLength(red.length);
    const swap = (v) => (v === C.backRed ? C.backBlue : v);
    blue.forEach((b, i) => {
      const r = red[i];
      expect([b.op, b.args, b.m, b.lineWidth, b.globalAlpha]).toEqual([r.op, r.args, r.m, r.lineWidth, r.globalAlpha]);
      expect([b.fillStyle, b.strokeStyle]).toEqual([swap(r.fillStyle), swap(r.strokeStyle)]);
    });
    expect(blue.some((c) => c.fillStyle === C.backBlue)).toBe(true);
    expect(blue.some((c) => c.fillStyle === C.backRed || c.strokeStyle === C.backRed)).toBe(false);
    expect([C.backRed, C.backBlue, C.backPaper]).toEqual(['#b22222', '#1f4e9b', '#fffdf8']);
  });

  it('small sizes hint themselves: the trellis doubles its pitch and drops its dots, rules stay >= ~1 device px', () => {
    // under the atlas's cell transform: a card `px` device px tall
    const at = (px) => {
      const ctx = recordingContext();
      ctx.scale(px / CARD_DESIGN.h, px / CARD_DESIGN.h);
      drawCard(ctx, BACK_FRAMES.red);
      return ctx;
    };
    const ops = (ctx, op) => ctx.calls.filter((c) => c.op === op).length;
    const big = at(435);
    const small = at(60);
    const tiny = at(40);
    // fewer trellis lines (pitch doubled) and no crossing dots when small
    expect(ops(small, 'lineTo')).toBeLessThan(ops(big, 'lineTo'));
    expect(ops(tiny, 'lineTo')).toBeLessThanOrEqual(ops(small, 'lineTo'));
    expect(ops(small, 'arc')).toBeLessThan(ops(big, 'arc'));
    // the structural rules (the field's 1.6 rule, the medallion's 2.2
    // outline) widen to 0.9 device px where they would be thinner
    const ruleWidths = (ctx) => ctx.calls.filter((c) => c.op === 'stroke' && c.strokeStyle === C.backPaper && c.globalAlpha === 1).map((c) => c.lineWidth);
    expect(ruleWidths(big)).toEqual(expect.arrayContaining([1.6, 2.2]));
    for (const [px, ctx] of [[60, small], [40, tiny]]) {
      const k = px / CARD_DESIGN.h;
      const device = ruleWidths(ctx).map((w) => w * k);
      expect(device.filter((d) => Math.abs(d - 0.9) < 1e-9).length, `${px}px`).toBeGreaterThanOrEqual(2);
      expect(device.some((d) => Math.abs(d - 1.6 * k) < 1e-9 || Math.abs(d - 2.2 * k) < 1e-9), `${px}px`).toBe(false);
    }
    // the medallion: four lozenges at full size, one bold diamond at 40 px
    const lastFillMoves = (ctx) => {
      const calls = ctx.calls;
      const end = calls.map((c) => c.op).lastIndexOf('fill');
      const begin = calls.slice(0, end).map((c) => c.op).lastIndexOf('beginPath');
      return calls.slice(begin, end).filter((c) => c.op === 'moveTo').length;
    };
    expect(lastFillMoves(big)).toBe(4);
    expect(lastFillMoves(tiny)).toBe(1);
  });

  it('backFrameForHand: hand 1 red, 2 blue, 3 red, ... 13 red; no hand yet (the draw) and nonsense red', () => {
    const want = Array.from({ length: 13 }, (_, i) => ((i + 1) % 2 === 0 ? 'back-blue' : 'back-red'));
    expect(Array.from({ length: 13 }, (_, i) => backFrameForHand(i + 1))).toEqual(want);
    expect(want.slice(0, 4)).toEqual(['back-red', 'back-blue', 'back-red', 'back-blue']);
    for (const none of [0, null, undefined, NaN, -2, 2.5, 'x']) expect(backFrameForHand(none), String(none)).toBe('back-red');
    expect(BACK_FRAMES).toEqual({ red: 'back-red', blue: 'back-blue' });
    expect(isBackFrame('back-red') && isBackFrame('back-blue')).toBe(true);
    expect(isBackFrame('back') || isBackFrame('shadow') || isBackFrame('a_spades')).toBe(false);
  });

  it('suits are vector paths, never text: no suit, star, card emoji or variation selector is ever drawn as a glyph', () => {
    for (const card of [...ALL_CARDS, BACK_FRAMES.red, BACK_FRAMES.blue]) {
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
  it('draws every frame (54 faces, the red and the blue back, the shadow) into its own cell, no cell over another', () => {
    const spec = { w: 64, h: 93 };
    const ctx = recordingContext();
    const drawn = drawAtlas(ctx, spec);
    expect(drawn).toEqual([...FACE_FRAMES, 'back-red', 'back-blue', SHADOW_FRAME]);
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
    expect(faceFill).toHaveLength(54); // the 54 faces (the backs are cream: card.backPaper)
    // both backs, each in its own ink under its own cell's transform
    for (const [name, ink] of [['back-red', C.backRed], ['back-blue', C.backBlue]]) {
      const f = page.frames[name];
      const panel = ctx.calls.find((c) => c.op === 'fill' && c.fillStyle === ink);
      expect([panel.m.e, panel.m.f], name).toEqual([f.x, f.y]);
      expect(panel.m.a).toBeCloseTo(f.w / CARD_DESIGN.w, 9);
    }
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
    // 64 x 92 frames: 662 x 566 px = 1.50 MB; 128 x 186: 1302 x 1130 px = 5.88 MB (10 x 6 cells for
    // 57 frames; 8 x 7 held the old 56 at 1.40 / 5.49 MB; the old 64 px atlas page: 13.9 MB)
    expect(atlasLayout(at(1))).toMatchObject({ width: 662, height: 566 });
    expect(one).toBe(662 * 566 * 4);
    expect(atlasLayout(at(2))).toMatchObject({ width: 1302, height: 1130 });
    expect(two).toBe(1302 * 1130 * 4);
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
