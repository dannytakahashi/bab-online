/**
 * Motion tokens and reduced motion (item 18a): durations come from the
 * tokens; prefers-reduced-motion is read live from matchMedia; the CSS
 * collapses every cosmetic duration under the same media query.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readClientFile } from '../testing/files.js';
import { motionMs, dealStaggerMs, prefersReducedMotion, setReducedMotionOverride, cubicBezier, EASE_EMPHASIZED } from './motion.js';

const tokensCss = readClientFile('styles/tokens.css');

afterEach(() => {
  setReducedMotionOverride(null);
  vi.unstubAllGlobals();
  delete window.matchMedia;
});

describe('motion', () => {
  it('durations come from the tokens', () => {
    setReducedMotionOverride(false);
    expect([motionMs('fast'), motionMs('base'), motionMs('slow')]).toEqual([120, 200, 350]);
    expect(dealStaggerMs()).toBe(35);
  });

  it('reads prefers-reduced-motion live: a change applies to the next call', () => {
    let reduce = false;
    window.matchMedia = vi.fn((q) => ({ matches: q.includes('reduce') && reduce, media: q }));
    expect(prefersReducedMotion()).toBe(false);
    expect(motionMs('base')).toBe(200);
    reduce = true;
    expect(prefersReducedMotion()).toBe(true);
    expect(motionMs('base')).toBe(0);
    expect(motionMs('base', { reduced: 80 })).toBe(80);
    expect(dealStaggerMs()).toBe(0);
  });

  it('CSS: every cosmetic duration and the deal stagger are 0 under reduced motion', () => {
    const block = tokensCss.slice(tokensCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const v of ['--dur-fast: 0ms', '--dur-base: 0ms', '--dur-slow: 0ms', '--stagger-deal: 0ms']) expect(block).toContain(v);
    expect(tokensCss).toContain('--ease-emphasized: cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  it('the emphasized ease is the token cubic-bezier', () => {
    expect(EASE_EMPHASIZED(0)).toBe(0);
    expect(EASE_EMPHASIZED(1)).toBe(1);
    // fast start, long settle: well past half way at a quarter of the time
    expect(EASE_EMPHASIZED(0.25)).toBeGreaterThan(0.6);
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.3)).toBeCloseTo(0.3, 4);
  });
});
