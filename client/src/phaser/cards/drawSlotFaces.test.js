/**
 * The draw's slot faces: one small canvas texture, a cell per slot, each
 * face drawn at the slot card's own size (1:1 however large the slot row
 * grows), redrawn only when its face or the size changes.
 */
import { describe, it, expect } from 'vitest';
import { FakeTextures } from '../../testing/fakePhaser.js';
import { ATLAS_PAD } from './CardAtlas.js';
import { DRAW_SLOTS_KEY, ensureDrawSlotFace, drawSlotFaces, slotFrame } from './drawSlotFaces.js';

describe('drawSlotFaces', () => {
  it('a face per slot in its own cell; uploads only on a change; a resize redraws every face at the new size', () => {
    const textures = new FakeTextures();
    const spec = { w: 128, h: 186 };
    expect(ensureDrawSlotFace(textures, spec, 0, 'k_hearts')).toBe(slotFrame(0));
    const tex = textures.get(DRAW_SLOTS_KEY);
    expect([tex.width, tex.height]).toEqual([ATLAS_PAD + 4 * (spec.w + ATLAS_PAD), spec.h + 2 * ATLAS_PAD]);
    for (let i = 0; i < 4; i++) {
      expect(tex.frames[slotFrame(i)]).toMatchObject({ width: spec.w, height: spec.h, cutX: ATLAS_PAD + i * (spec.w + ATLAS_PAD), cutY: ATLAS_PAD });
    }
    const uploads = textures.uploads;
    const draws = textures.drawCalls;
    // the same face again: nothing drawn, nothing uploaded
    ensureDrawSlotFace(textures, spec, 0, 'k_hearts');
    expect([textures.uploads, textures.drawCalls]).toEqual([uploads, draws]);
    // another slot: drawn and uploaded once
    ensureDrawSlotFace(textures, spec, 2, 'hi_joker');
    expect(textures.uploads).toBe(uploads + 1);
    expect(textures.drawCalls).toBeGreaterThan(draws);
    expect(drawSlotFaces(textures).faces).toEqual(['k_hearts', null, 'hi_joker', null]);
    // a relayout's new size: the cells and frames follow, both faces redrawn
    const big = { w: 174, h: 252 };
    const before = textures.drawCalls;
    ensureDrawSlotFace(textures, big, 0, 'k_hearts');
    expect(textures.get(DRAW_SLOTS_KEY)).toBe(tex);
    expect(tex.width).toBe(ATLAS_PAD + 4 * (big.w + ATLAS_PAD));
    expect(tex.frames[slotFrame(3)]).toMatchObject({ width: big.w, height: big.h, cutX: ATLAS_PAD + 3 * (big.w + ATLAS_PAD) });
    expect(textures.drawCalls).toBeGreaterThan(before);
    expect(drawSlotFaces(textures)).toEqual({ spec: big, faces: ['k_hearts', null, 'hi_joker', null] });
  });
});
