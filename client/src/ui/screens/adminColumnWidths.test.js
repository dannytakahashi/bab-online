/**
 * The admin Players table is `table-layout: fixed`, so every column needs a
 * width. Widths used to be positional (th:nth-child) and went one column off
 * when Bot games was added: Actions got 0 px and every row grew ~180 px tall
 * (owner, 2026-11-14). Widths are now keyed by column (.admin-col--<key>);
 * these checks fail when a column is added without one.
 */
import { describe, it, expect } from 'vitest';
import { readClientFile } from '../../testing/files.js';
import { PLAYER_COLUMNS } from './adminPlayers.js';

const CSS = readClientFile('styles/screens.css').replace(/\/\*[\s\S]*?\*\//g, '');
const KEYS = [...PLAYER_COLUMNS.map((c) => c.key), 'actions'];

/** The width (in %) set for `.admin-players th.admin-col--<key>`, or null. */
function widthOf(key) {
  const m = CSS.match(new RegExp(`\\.admin-players th\\.admin-col--${key}\\s*\\{\\s*width:\\s*([\\d.]+)%;?\\s*\\}`));
  return m ? Number(m[1]) : null;
}

describe('admin Players table: one width per column, by key', () => {
  it('every column (and Actions) has a percentage width', () => {
    const missing = KEYS.filter((k) => widthOf(k) === null);
    expect(missing).toEqual([]);
  });

  it('the widths add up to 100%', () => {
    const total = KEYS.reduce((sum, k) => sum + (widthOf(k) || 0), 0);
    expect(total).toBeCloseTo(100, 5);
  });

  it('no width rule names a column that does not exist, and none is positional', () => {
    const named = [...CSS.matchAll(/\.admin-players th\.admin-col--([A-Za-z]+)/g)].map((m) => m[1]);
    expect(named.filter((k) => !KEYS.includes(k))).toEqual([]);
    expect(CSS).not.toMatch(/\.admin-players th:nth-child/);
  });

  it('Actions keeps room for its two buttons side by side', () => {
    expect(widthOf('actions')).toBeGreaterThanOrEqual(20);
  });
});
