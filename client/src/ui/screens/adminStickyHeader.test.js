/**
 * The admin tables' sticky header (owner, 2026-11-13: scrolled rows "peek
 * through between the table header and above"): a sticky `top: 0` sticks at
 * the scroll container's content edge, so .admin-section's top padding (kept
 * for focus rings) left a strip above the header where rows showed. The
 * header's `top` must cancel exactly that padding.
 */
import { describe, it, expect } from 'vitest';
import { readClientFile } from '../../testing/files.js';

const CSS = readClientFile('styles/screens.css');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(';')
    .map((d) => d.trim()).filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}

describe('admin tables: the sticky header covers the scroll area to its top edge', () => {
  it('cancels .admin-section\'s top padding', () => {
    const section = rule('.admin-section');
    expect(section['overflow-y']).toBe('auto');
    const paddingTop = section.padding.split(/\s+(?![^(]*\))/)[0];
    const th = rule('.admin-table th');
    expect(th.position).toBe('sticky');
    expect(th.top).toBe(`calc(-1 * ${paddingTop})`);
  });

  it('paints an opaque background so rows scroll under it, not through it', () => {
    const th = rule('.admin-table th');
    expect(th.background).toMatch(/^var\(--surface-/);
    expect(Number(th['z-index'])).toBeGreaterThanOrEqual(1);
  });
});
