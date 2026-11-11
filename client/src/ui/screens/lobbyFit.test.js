/**
 * The game lobby on a short window (screens.css, max-height 820px). A lobby
 * that is not full shows the Add Bot row too and is 628 px tall; at
 * 1024 x 668 its 90vh cap (601 px) made it scroll ~30 px with Add Bot and
 * Leave cut off. jsdom has no layout, so this pins the two rules that fix
 * it; measured in a browser (built page): 1024x668 628/628 px (no scroll),
 * 1440x790 unchanged, 1280x620 10 px scroll (was 70), 844x390 still scrolls.
 */
import { describe, it, expect } from 'vitest';
import { readClientFile } from '../../testing/files.js';

const css = readClientFile('styles/screens.css');

/** The body of the first `@media (max-height: 820px)` block. */
function shortWindowBlock() {
  const start = css.indexOf('@media (max-height: 820px)');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error('unclosed @media block');
}

/** Declarations of `selector { ... }` inside `text`, as a map. */
function rule(text, selector) {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = text.match(re);
  expect(m, selector).toBeTruthy();
  return Object.fromEntries(m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
  }));
}

describe('game lobby on a short window', () => {
  const block = shortWindowBlock();

  it('may use the window height but its gutter (as max-width does), not 90vh', () => {
    expect(rule(block, '.screen--lobby')['max-height']).toBe('calc(100vh - 2 * var(--space-4))');
  });

  it('its chat log gives up height before the panel scrolls (down to 64 px)', () => {
    expect(rule(block, '.screen--lobby .chat-log--short')).toEqual({ flex: '0 1 96px', height: 'auto', 'min-height': '64px' });
  });
});
