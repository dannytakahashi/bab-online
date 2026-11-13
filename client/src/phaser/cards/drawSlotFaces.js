/**
 * The draw for deal's four drawn cards, each in its own frame of a small
 * canvas texture ('drawSlots': one cell per slot, frames 'slot0'..'slot3').
 *
 * Why not the card atlas: the atlas's frames are the hand card's size, and
 * the draw's slot row grows past it where the canvas has the height
 * (computeTableLayout placeDraw, DRAW_GROW), as iOS's results fill the
 * screen. An atlas frame scaled up would be soft; a slot's face drawn at its
 * own size (the layout's `draw.slotCard.tex`, the card's height in even
 * device pixels) samples 1:1 like the hand. Four cells of one card each, so
 * it costs next to nothing; a face is drawn when its card turns up, and
 * every face again only when the slot size changes (a relayout).
 */
import { ALL_CARDS, FACE_FRAMES, CARD_DESIGN, drawCard } from './cardFaces.js';
import { ATLAS_PAD } from './CardAtlas.js';

export const DRAW_SLOTS_KEY = 'drawSlots';
export const DRAW_SLOT_COUNT = 4;

/** A slot's frame name (index 0-3). */
export const slotFrame = (i) => `slot${i}`;

const cardOfFace = new Map(ALL_CARDS.map((c, i) => [FACE_FRAMES[i], c]));

/** Per texture manager: {canvas, tex, spec, faces[4]}. */
const slots = new WeakMap();

function cellOf(spec, i) {
  return { x: ATLAS_PAD + i * (spec.w + ATLAS_PAD), y: ATLAS_PAD, w: spec.w, h: spec.h };
}

function paint(st, i) {
  const ctx = st.canvas.getContext?.('2d');
  if (!ctx) return;
  const c = cellOf(st.spec, i);
  ctx.clearRect(c.x - 1, c.y - 1, c.w + 2, c.h + 2);
  const card = cardOfFace.get(st.faces[i]);
  if (!card) return;
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.scale(c.w / CARD_DESIGN.w, c.h / CARD_DESIGN.h);
  drawCard(ctx, card);
  ctx.restore();
}

/**
 * Slot `i` shows face `faceKey` (an atlas face name, getCardImageKey) at
 * `spec` (w x h px). Makes or resizes the texture as needed and repaints
 * only what changed. Returns the frame name to show it with.
 * @param {Phaser.Textures.TextureManager} textures
 * @param {{w: number, h: number}} spec
 * @param {number} i - 0-3
 * @param {string} faceKey
 */
export function ensureDrawSlotFace(textures, spec, i, faceKey) {
  const width = ATLAS_PAD + DRAW_SLOT_COUNT * (spec.w + ATLAS_PAD);
  const height = spec.h + 2 * ATLAS_PAD;
  let st = slots.get(textures);
  let tex = textures.exists?.(DRAW_SLOTS_KEY) ? textures.get(DRAW_SLOTS_KEY) : null;
  if (st && tex && tex.canvas !== st.canvas) {
    // a texture under this key that is not ours (a hot reload): replace it
    textures.remove?.(DRAW_SLOTS_KEY);
    tex = null;
  }
  const makeCanvas = textures._createAtlasCanvas ? () => textures._createAtlasCanvas() : () => document.createElement('canvas');
  const resized = !st || !tex || st.spec.w !== spec.w || st.spec.h !== spec.h;
  if (!st || !tex) {
    const canvas = st?.canvas || makeCanvas();
    canvas.width = width;
    canvas.height = height;
    tex = textures.addCanvas(DRAW_SLOTS_KEY, canvas);
    st = { canvas, tex, spec: { w: spec.w, h: spec.h }, faces: st?.faces || new Array(DRAW_SLOT_COUNT).fill(null) };
    slots.set(textures, st);
  } else if (resized) {
    if (tex.setSize) tex.setSize(width, height);
    else {
      st.canvas.width = width;
      st.canvas.height = height;
    }
    st.spec = { w: spec.w, h: spec.h };
  }
  st.tex = tex;
  if (resized) {
    for (let k = 0; k < DRAW_SLOT_COUNT; k++) {
      const c = cellOf(st.spec, k);
      const frame = tex.frames?.[slotFrame(k)];
      if (frame?.setSize) frame.setSize(c.w, c.h, c.x, c.y);
      else tex.add(slotFrame(k), 0, c.x, c.y, c.w, c.h);
    }
    // linear filtering (Phaser.Textures.FilterMode.LINEAR is 0)
    tex.setFilter?.(globalThis.Phaser?.Textures?.FilterMode?.LINEAR ?? 0);
  }
  const changed = st.faces[i] !== faceKey;
  st.faces[i] = faceKey;
  if (resized) for (let k = 0; k < DRAW_SLOT_COUNT; k++) paint(st, k);
  else if (changed) paint(st, i);
  if (resized || changed) tex.refresh?.();
  return slotFrame(i);
}

/** What each slot's frame shows now (tests, live checks): face keys or null. */
export function drawSlotFaces(textures) {
  const st = slots.get(textures);
  return st ? { spec: { ...st.spec }, faces: [...st.faces] } : null;
}
