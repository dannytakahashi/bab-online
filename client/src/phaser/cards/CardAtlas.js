/**
 * The card atlas (item 18a, webclient-12 / ui-15): every face, the back and
 * the raised card's shadow drawn by cardFaces.js into ONE canvas texture
 * ('cards'), so the whole table binds one card texture.
 *
 * Bitmap size: each frame is the largest card on screen (the hand card at
 * the current layout scale) times the device pixel ratio, in even device
 * pixels, so hand cards sample 1:1 (the layout sizes them from the frame;
 * the game config's roundPixels snaps every quad to device pixels) and every smaller card (trick, backs, history) is a downscale
 * with linear filtering. It is capped at CARD_CONFIG.TEX_MAX_W (the iOS 3x
 * card). The layout carries the size (computeTableLayout: cardTexture), and
 * the atlas is redrawn only when that size changes: a resize that changes
 * the table's scale, or a move to a display with another ratio. A render
 * never re-allocates it.
 *
 * Texture memory is width x height x 4 bytes for the one page
 * (atlasBytes): see atlasLayout for the grid.
 */
import { CARD_CONFIG } from '../config.js';
import { ALL_CARDS, FACE_FRAMES, BACK_FRAME, SHADOW_FRAME, CARD_DESIGN, CARD_ASPECT, drawCard, drawShadow } from './cardFaces.js';

export const CARD_TEXTURE_KEY = 'cards';
/** Grid columns and the transparent gutter between cells (no bleed under linear filtering). */
export const ATLAS_COLS = 8;
export const ATLAS_PAD = 2;
/** The shadow's blur margin inside its cell, as a share of the cell width. */
export const SHADOW_MARGIN = 0.12;

/** Every frame of the atlas in order: 54 faces, the back, the shadow. */
export const ATLAS_FRAMES = Object.freeze([...FACE_FRAMES, BACK_FRAME, SHADOW_FRAME]);

/**
 * The frame bitmap for a card `cardH` CSS px tall at `dpr`: its height in
 * device pixels (rounded up, then down to an EVEN number: within one device
 * pixel of the card), the width at the card's proportions, also even. Even,
 * so a card centred on a whole device pixel (the layout snaps every card
 * centre) has whole-pixel edges: an odd frame would start half a pixel off,
 * where linear filtering blends every texel row with the next and the
 * quad's rounding (roundPixels) is a coin toss. (Down, not up: a card one
 * pixel larger could cost the table its scale where it is tight.) The cap
 * is the iOS 3x card, as it is.
 * @returns {{w: number, h: number}} px
 */
export function cardTextureSize(cardH, dpr = 1) {
  const maxH = Math.round(CARD_CONFIG.TEX_MAX_W * CARD_ASPECT);
  const px = Math.ceil(cardH * (dpr > 0 ? dpr : 1) - 1e-6);
  if (px >= maxH) return { w: CARD_CONFIG.TEX_MAX_W, h: maxH };
  const h = Math.max(12, px - (px % 2));
  return { w: 2 * Math.round(h / CARD_ASPECT / 2), h };
}

/**
 * The atlas page for frames of w x h: an ATLAS_COLS-wide grid of cells with
 * an ATLAS_PAD gutter (56 cells for the 56 frames).
 * @returns {{width: number, height: number, frames: Object<string, {x, y, w, h}>}}
 */
export function atlasLayout({ w, h }) {
  const rows = Math.ceil(ATLAS_FRAMES.length / ATLAS_COLS);
  const frames = {};
  ATLAS_FRAMES.forEach((name, i) => {
    const col = i % ATLAS_COLS;
    const row = Math.floor(i / ATLAS_COLS);
    frames[name] = { x: ATLAS_PAD + col * (w + ATLAS_PAD), y: ATLAS_PAD + row * (h + ATLAS_PAD), w, h };
  });
  return { width: ATLAS_PAD + ATLAS_COLS * (w + ATLAS_PAD), height: ATLAS_PAD + rows * (h + ATLAS_PAD), frames };
}

/** Texture memory of the page in bytes (RGBA8: w x h x 4). */
export function atlasBytes(spec) {
  const { width, height } = atlasLayout(spec);
  return width * height * 4;
}

/** The card (or BACK_FRAME) a frame shows. */
const cardOfFrame = new Map([...ALL_CARDS.map((c, i) => [FACE_FRAMES[i], c]), [BACK_FRAME, BACK_FRAME]]);

/**
 * Draw every frame of the page onto a 2D context (the canvas already has
 * the page's size). Returns the frames drawn (tests count them).
 */
export function drawAtlas(ctx, spec) {
  const page = atlasLayout(spec);
  ctx.clearRect(0, 0, page.width, page.height);
  const drawn = [];
  for (const name of ATLAS_FRAMES) {
    const f = page.frames[name];
    ctx.save();
    ctx.translate(f.x, f.y);
    if (name === SHADOW_FRAME) {
      drawShadow(ctx, f.w, f.h, Math.round(f.w * SHADOW_MARGIN));
    } else {
      ctx.scale(f.w / CARD_DESIGN.w, f.h / CARD_DESIGN.h);
      drawCard(ctx, cardOfFrame.get(name));
    }
    ctx.restore();
    drawn.push(name);
  }
  return drawn;
}

/** Per texture manager (the game's: it outlives scene restarts). */
const atlases = new WeakMap();

/**
 * Make sure the 'cards' texture holds frames of `spec` (w x h px). Draws and
 * uploads only when the size changes.
 * @param {Phaser.Textures.TextureManager} textures
 * @param {{w: number, h: number}} spec
 * @param {Object} [opts]
 * @param {Function} [opts.createCanvas] - () => HTMLCanvasElement
 * @returns {{changed: boolean, spec: Object, bytes: number}}
 */
export function ensureCardAtlas(textures, spec, { createCanvas = null } = {}) {
  if (!textures || !spec) return { changed: false, spec: null, bytes: 0 };
  // (a test harness's texture manager brings its own canvas: jsdom has none)
  const makeCanvas = createCanvas || (textures._createAtlasCanvas ? () => textures._createAtlasCanvas() : () => document.createElement('canvas'));
  let atlas = atlases.get(textures);
  const same = atlas && atlas.spec.w === spec.w && atlas.spec.h === spec.h && textures.exists?.(CARD_TEXTURE_KEY);
  if (same) return { changed: false, spec: atlas.spec, bytes: atlas.bytes };

  const page = atlasLayout(spec);
  const canvas = atlas?.canvas || makeCanvas();
  let tex = textures.exists?.(CARD_TEXTURE_KEY) ? textures.get(CARD_TEXTURE_KEY) : null;
  if (tex && tex.canvas !== canvas) {
    // a texture under this key that is not ours (a hot reload): replace it
    textures.remove?.(CARD_TEXTURE_KEY);
    tex = null;
  }
  if (tex?.setSize) tex.setSize(page.width, page.height);
  else {
    canvas.width = page.width;
    canvas.height = page.height;
  }

  const ctx = canvas.getContext?.('2d') || null;
  if (ctx) drawAtlas(ctx, spec);

  if (!tex) tex = textures.addCanvas(CARD_TEXTURE_KEY, canvas);
  for (const name of ATLAS_FRAMES) {
    const f = page.frames[name];
    const frame = tex.frames?.[name];
    if (frame?.setSize) frame.setSize(f.w, f.h, f.x, f.y);
    else tex.add(name, 0, f.x, f.y, f.w, f.h);
  }
  // linear filtering: hand cards sample 1:1, every other card is a downscale
  // (Phaser.Textures.FilterMode.LINEAR is 0)
  tex.setFilter?.(globalThis.Phaser?.Textures?.FilterMode?.LINEAR ?? 0);
  tex.refresh?.();

  atlas = { canvas, spec: { w: spec.w, h: spec.h }, bytes: page.width * page.height * 4, drawn: !!ctx };
  atlases.set(textures, atlas);
  return { changed: true, spec: atlas.spec, bytes: atlas.bytes };
}

/** The atlas a texture manager holds now (live checks, tests). */
export function cardAtlasInfo(textures) {
  const a = atlases.get(textures);
  if (!a) return null;
  const page = atlasLayout(a.spec);
  return { frame: { ...a.spec }, page: { w: page.width, h: page.height }, bytes: a.bytes, drawn: a.drawn };
}

/**
 * After a resize of the frames: every live game object showing a card
 * frame takes its frame's new size (its scale is the layout's, set by the
 * managers' relayout or the render that follows), and a card's hit area
 * (the whole frame: the visible card) the new size too.
 */
export function refreshCardSprites(scene) {
  const list = scene?.children?.list || [];
  for (const obj of list) {
    if (obj?.texture?.key !== CARD_TEXTURE_KEY || !obj.frame?.name) continue;
    obj.setFrame?.(obj.frame.name);
    const hit = obj.input?.hitArea;
    if (hit && typeof hit.setSize === 'function' && hit.x === 0 && hit.y === 0) hit.setSize(obj.width, obj.height);
  }
}
