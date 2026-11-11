/**
 * The canvas backing store at the device pixel ratio (item 18a): the ONE
 * place that converts between CSS pixels (the table layout, the HUD, every
 * game object's coordinates) and canvas pixels.
 *
 *   game size (scale.width/height) = CSS size x dpr   (the backing store)
 *   scale.zoom = 1 / dpr                               (drawn at CSS size)
 *   main camera zoom = dpr, origin 0,0                 (world units = CSS px)
 *
 * Phaser's input maps a pointer through the canvas bounds to game pixels and
 * the camera back to world (CSS) pixels, so hit areas stay in CSS pixels.
 */

/** The highest ratio rendered (a 3x phone; anything above costs memory for nothing). */
export const MAX_DPR = 3;

/** The window's device pixel ratio, clamped to [1, MAX_DPR]. */
export function deviceScale() {
  const d = (typeof window !== 'undefined' && Number(window.devicePixelRatio)) || 1;
  return Math.min(MAX_DPR, Math.max(1, d));
}

/**
 * The canvas size in CSS pixels and its ratio, from a scale manager (a
 * stand-in without the backing-store fields is CSS sized at 1x).
 * @returns {{w: number, h: number, dpr: number}}
 */
export function cssSize(scale) {
  const dpr = scale?.babDpr || 1;
  const css = scale?.babCss;
  const w = scale?.width || 0;
  const h = scale?.height || 0;
  // the CSS size this backing store was made for (exact), unless someone
  // resized the scale manager directly since (tests, Phaser itself)
  if (css && Math.round(css.w * dpr) === w && Math.round(css.h * dpr) === h) return { w: css.w, h: css.h, dpr };
  return { w: w / dpr, h: h / dpr, dpr };
}

/**
 * Size the backing store for a canvas of cssW x cssH at `dpr`: the canvas
 * style keeps the CSS size, the scale manager resizes (emitting 'resize':
 * GameScene.relayout) and every scene's main camera zooms by dpr.
 * @returns {boolean} whether anything changed
 */
export function applyBackingStore(game, cssW, cssH, dpr = deviceScale()) {
  const scale = game?.scale;
  if (!scale || !(cssW > 0) || !(cssH > 0)) return false;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  const same = scale.babDpr === dpr && scale.width === bw && scale.height === bh
    && scale.babCss?.w === cssW && scale.babCss?.h === cssH;
  if (same) return false;
  scale.babDpr = dpr;
  scale.babCss = { w: cssW, h: cssH };
  scale.zoom = 1 / dpr;
  const canvas = game.canvas || scale.canvas;
  if (canvas?.style) {
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  for (const scene of game.scene?.getScenes?.(false) || []) zoomCamera(scene, dpr);
  scale.resize(bw, bh);
  if (canvas?.style) {
    // Phaser's resize styles the canvas from the zoom (bw / dpr, rounded):
    // the CSS size is the container's, exactly
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  return true;
}

/** A scene's main camera draws world (CSS) pixels at the backing store's ratio. */
export function zoomCamera(scene, dpr = scene?.scale?.babDpr || 1) {
  const cam = scene?.cameras?.main;
  if (!cam) return;
  if (cam.originX !== 0 || cam.originY !== 0) cam.setOrigin?.(0, 0);
  if (cam.zoom !== dpr) cam.setZoom?.(dpr);
}

/**
 * Call fn() when the device pixel ratio changes (the window moved to a
 * display with another ratio, or the page zoom changed). Returns an
 * unsubscribe function.
 */
export function onDprChange(fn) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let mq = null;
  let stopped = false;
  const listen = () => {
    if (stopped) return;
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const handler = () => {
      mq?.removeEventListener?.('change', handler);
      fn();
      listen();
    };
    mq.addEventListener?.('change', handler, { once: true });
  };
  listen();
  return () => { stopped = true; };
}
