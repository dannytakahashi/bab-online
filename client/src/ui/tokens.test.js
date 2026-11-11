/**
 * Design tokens (item 18a): the generated files are what tokens.json says
 * (run `npm run tokens` after editing it), and every text-on-surface pair
 * the UI uses meets WCAG AA, computed from tokens.json itself.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../testing/files.js';
import { renderAll, contrastReport, contrastRatio, parseColor, composite } from '../../tokens/generate.mjs';
import * as T from './tokens.js';

const tokens = JSON.parse(readFileSync(resolve(REPO_ROOT, 'client/tokens/tokens.json'), 'utf8'));

describe('generated token files', () => {
  it('client/styles/tokens.css and client/src/ui/tokens.js are up to date (npm run tokens)', () => {
    for (const [rel, want] of Object.entries(renderAll(tokens))) {
      const have = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(have, `${rel} is stale: run npm run tokens`).toBe(want);
    }
  });

  it('the module carries the scales the roadmap names', () => {
    expect(Object.values(T.TYPE)).toEqual([12, 14, 16, 20, 24, 32, 48]);
    expect(T.RADIUS).toMatchObject({ sm: 6, md: 10, lg: 16 });
    expect(Object.keys(T.Z)).toEqual(expect.arrayContaining(['table', 'hud', 'panel', 'modal', 'toast', 'transition']));
    // the z scale is ordered
    const z = ['table', 'hud', 'panel', 'modal', 'toast', 'transition'].map((k) => T.Z[k]);
    expect([...z].sort((a, b) => a - b)).toEqual(z);
    expect(T.MOTION).toMatchObject({ fast: 120, base: 200, slow: 350, dealStagger: 35 });
    expect(T.MOTION.easing.emphasized).toEqual([0.2, 0.8, 0.2, 1]);
    // a 4 px grid
    for (const [k, v] of Object.entries(T.SPACE)) expect(v % 4, k).toBe(0);
    expect(T.HIT_TARGET).toBe(44);
    expect(T.FONT_UI.startsWith('-apple-system, BlinkMacSystemFont, "SF Pro Text"')).toBe(true);
    expect(Object.keys(tokens.elevation)).toHaveLength(3);
  });

  it('hex() and alpha() give Phaser values', () => {
    expect(T.hex('#0f3d2e')).toBe(0x0f3d2e);
    expect(T.alpha('#00000080')).toBeCloseTo(0.502, 3);
    expect(T.alpha('#ffffff')).toBe(1);
  });

  it('the JSON stays platform-neutral for a Theme.swift generator (item 29)', () => {
    const walk = (node, path) => {
      if (typeof node === 'string') {
        expect(() => parseColor(node), path).not.toThrow();
        return;
      }
      for (const [k, v] of Object.entries(node)) {
        expect(k, `${path}.${k} is an identifier`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
        walk(v, `${path}.${k}`);
      }
    };
    walk(tokens.color, 'color');
    for (const layers of Object.values(tokens.elevation)) {
      for (const l of layers) expect(Object.keys(l).sort()).toEqual(['blur', 'color', 'spread', 'x', 'y']);
    }
  });
});

describe('contrast (WCAG AA from tokens.json)', () => {
  it('the ratio math matches known values', () => {
    expect(contrastRatio(parseColor('#000000'), parseColor('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#777777'), parseColor('#ffffff'))).toBeCloseTo(4.48, 2);
    const half = composite([{ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 }]);
    expect(Math.round(half.r)).toBe(128);
  });

  it('every text-on-surface pair the UI uses meets 4.5:1 (3:1 for large text and UI glyphs)', () => {
    const report = contrastReport(tokens);
    expect(report.length).toBeGreaterThan(20);
    const failing = report.filter((p) => !p.ok).map((p) => `${p.fg} on ${p.bg.join(' over ')}: ${p.ratio} < ${p.min}`);
    expect(failing).toEqual([]);
    for (const p of report) expect([3, 4.5]).toContain(p.min);
  });

  it('every text color is checked against the surfaces it sits on', () => {
    const fgs = new Set(tokens.contrast.map((p) => p.fg));
    for (const k of ['text.primary', 'text.secondary', 'text.dim', 'team.a', 'team.b', 'gold', 'danger.text', 'success', 'warning', 'card.red', 'card.black', 'card.joker']) {
      expect(fgs.has(k), k).toBe(true);
    }
  });
});
