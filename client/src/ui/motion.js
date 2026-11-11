/**
 * Motion (roadmap item 18a): every cosmetic duration and ease comes from
 * the motion tokens (tokens.json -> ui/tokens.js), in CSS and in Phaser.
 *
 * prefers-reduced-motion: reduce is read live (matchMedia, no cache), so a
 * change in the OS setting applies to the next tween. Cosmetic motion then
 * becomes instant or a short fade; game pacing (the fly-in, collect and
 * teams fade sized to the server's resumeInMs, phaser/pacing.js) is not
 * cosmetic and never changes here. CSS does the same through the media
 * query in tokens.css (every --dur-* is 0ms).
 */
import { MOTION } from './tokens.js';

let override = null;

/** Tests and live checks: force reduced motion on (true), off (false) or follow the OS (null). */
export function setReducedMotionOverride(value) {
  override = value === null || value === undefined ? null : !!value;
}

/** Whether the viewer asked for reduced motion (live). */
export function prefersReducedMotion() {
  if (override !== null) return override;
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * A cosmetic duration in ms from the motion tokens ('fast' 120, 'base' 200,
 * 'slow' 350, or a number), `reduced` (default 0: instant) under reduced motion.
 */
export function motionMs(name, { reduced = 0 } = {}) {
  if (prefersReducedMotion()) return reduced;
  return typeof name === 'number' ? name : (MOTION[name] ?? MOTION.base);
}

/** The deal stagger per card (ms), 0 under reduced motion. */
export function dealStaggerMs() {
  return prefersReducedMotion() ? 0 : MOTION.dealStagger;
}

/**
 * A cubic-bezier easing as a function of t in [0, 1] (Phaser accepts an
 * ease function), solved by Newton steps then bisection on x(t).
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return t;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
}

/** The emphasized ease (cubic-bezier(.2,.8,.2,1)) for Phaser tweens. */
export const EASE_EMPHASIZED = cubicBezier(...MOTION.easing.emphasized);
/** The standard ease (cubic-bezier(.4,0,.2,1)). */
export const EASE_STANDARD = cubicBezier(...MOTION.easing.standard);
