/**
 * The DOM screens on tokens and kit classes (item 18b), like the table's
 * HUD files in hudStyles.test.js: no hex color literal and no inline style
 * assignment in these files, the same greps the roadmap measures with.
 * The one per-user dynamic value is named and counted here: the chat
 * name hue (--name-hue), and every hue keeps 4.5:1 on the chat well.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readClientFile, REPO_ROOT } from '../testing/files.js';
import { contrastRatio, parseColor, resolveColor } from '../../tokens/generate.mjs';

const SCREEN_FILES = [
  'src/ui/screens/MainRoom.js', 'src/ui/screens/ProfilePage.js', 'src/ui/screens/GameLobby.js',
  'src/ui/screens/TournamentLobby.js', 'src/ui/screens/RecordsPage.js', 'src/ui/screens/LeaderboardPage.js',
  'src/ui/screens/PlayerSearchPage.js', 'src/ui/screens/SignIn.js', 'src/ui/screens/Register.js',
  'src/ui/screens/common.js', 'src/ui/components/PlayerQueue.js', 'src/ui/components/ResignationDialog.js',
  'src/ui/kit/modal.js', 'src/ui/kit/elements.js', 'src/ui/UIManager.js', 'src/main.js',
];
const PAGE_CSS = ['styles/screens.css', 'styles.css', 'styles/kit.css', 'styles/components.css', 'index.html'];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const INLINE = /style\.cssText|\.style\.[a-zA-Z]+ *=|style="/;
const SET_PROPERTY = /style\.setProperty\(\s*'([^']+)'/g;

/** The per-user values the screens may set (name: count over SCREEN_FILES). */
const PER_USER_VALUES = { '--name-hue': 1 };

describe('the screens on tokens and kit classes', () => {
  for (const file of SCREEN_FILES) {
    it(`${file}: no hex literal, no inline style`, () => {
      const src = readClientFile(file);
      expect(src.match(HEX) || [], 'hex literals').toEqual([]);
      const inline = src.split('\n').filter((l) => INLINE.test(l));
      expect(inline, 'inline style assignments').toEqual([]);
    });
  }

  it('the only dynamic style is the chat name hue (named and counted)', () => {
    const found = {};
    for (const file of SCREEN_FILES) {
      for (const m of readClientFile(file).matchAll(SET_PROPERTY)) found[m[1]] = (found[m[1]] || 0) + 1;
    }
    expect(found).toEqual(PER_USER_VALUES);
  });

  for (const file of PAGE_CSS) {
    it(`${file}: no hex literal (colors are tokens)`, () => {
      expect(readClientFile(file).match(HEX) || []).toEqual([]);
    });
  }

  it('no Arial body and no bright green gradient: the page is the tokens\' dark surfaces and font stack', () => {
    const css = readClientFile('styles.css');
    const body = css.slice(css.indexOf('\nbody {'), css.indexOf('}', css.indexOf('\nbody {')));
    expect(body).toContain('font-family: var(--font-ui)');
    expect(body).toContain('background: var(--page-bg)');
    expect(css).not.toMatch(/Arial|228B22|#0d1a0d/i);
    expect(css).toMatch(/--page-bg: radial-gradient\([^;]*var\(--felt-deep\)[^;]*var\(--surface-0\)/);
  });

  it('index.html loads screens.css after the kit and before the table', () => {
    const html = readClientFile('index.html');
    const at = (f) => html.indexOf(`href="/styles/${f}"`);
    expect(at('screens.css')).toBeGreaterThan(at('kit.css'));
    expect(at('screens.css')).toBeLessThan(at('table.css'));
  });

  it('no JS hover color swaps: hover and focus are CSS', () => {
    for (const file of SCREEN_FILES) {
      const src = readClientFile(file);
      expect(src, file).not.toMatch(/addEventListener\('mouse(enter|leave|over|out)'/);
    }
    const css = readClientFile('styles/screens.css');
    expect(css).toMatch(/\.screen :is\(button, a, input, textarea, \[tabindex\]\):focus-visible/);
    expect(css).toMatch(/\.kit-modal :is\(button, a, input, textarea, \[tabindex\]\):focus-visible/);
    expect(css).toMatch(/\.auth-screen :is\(button, a, input\):focus-visible/);
  });

  it('no dialog is a native alert / prompt / confirm', () => {
    for (const file of SCREEN_FILES) {
      expect(readClientFile(file), file).not.toMatch(/(window\.|[^.\w])(alert|prompt|confirm)\(/);
    }
  });
});

describe('motion on the screens', () => {
  it('no infinite animation in the page stylesheets (only the table\'s opacity turn ring, which is not idle)', () => {
    for (const css of ['styles/screens.css', 'styles.css', 'styles/kit.css', 'styles/components.css', 'styles/table.css']) {
      const text = readClientFile(css);
      const infinite = [...text.matchAll(/animation:\s*([\w-]+)[^;]*infinite/g)].map((m) => m[1]);
      expect(infinite.every((n) => n === 'kit-turn-glow'), `${css}: ${infinite}`).toBe(true);
    }
    // the turn ring only runs on a seat whose turn it is
    expect(readClientFile('styles/kit.css')).toMatch(/\.turn-glow::after,\s*\.kit-avatar\.turn-glow::after \{/);
  });

  it('screen transitions and animations take their durations and easings from the tokens', () => {
    const css = readClientFile('styles/screens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const decls = [...css.matchAll(/(?:transition|animation):([^;]+);/g)].map((m) => m[1]);
    expect(decls.length).toBeGreaterThan(3);
    for (const d of decls) {
      if (/none/.test(d)) continue;
      expect(d, d).toMatch(/var\(--dur-(fast|base|slow)\)/);
      expect(d, d).toMatch(/var\(--ease-(standard|emphasized)\)/);
      expect(d, d).not.toMatch(/\b\d*\.?\d+(ms|s)\b/);
    }
  });
});

describe('HIG on the screens', () => {
  const css = readClientFile('styles/screens.css');
  const rule = (sel) => {
    const i = css.indexOf(`\n${sel} {`);
    expect(i, sel).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('targets that are not kit buttons are at least 44 px (sort headers, seat rows, search results)', () => {
    expect(rule('.lb-sort')).toContain('min-height: var(--hit-target)');
    expect(rule('.seat-row')).toContain('min-height: var(--hit-target)');
    expect(rule('.search-result')).toMatch(/min-height: (5[6-9]|[6-9]\d)px/);
    expect(rule('.avatar-option')).toMatch(/width: 80px/);
    // the remove-bot button is drawn at 32 px; the kit keeps its 44 px target
    expect(rule('.seat-remove')).toContain('--icon-btn-size: 32px');
  });

  it('forms and modal pages are capped at about 440 px of readable width', () => {
    expect(rule('.auth-card')).toContain('max-width: 440px');
    expect(rule('.kit-modal.page-modal')).toContain('width: 440px');
  });
});

describe('contrast of the per-user chat name hue', () => {
  const tokens = JSON.parse(readFileSync(resolve(REPO_ROOT, 'client/tokens/tokens.json'), 'utf8'));

  /** hsl(h s% l%) to {r,g,b,a} in 0-255. */
  function hsl(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return { r: 255 * f(0), g: 255 * f(8), b: 255 * f(4), a: 1 };
  }

  it('screens.css draws the hue at 70% / 72%, and every hue 0-359 is 4.5:1 on the chat well (surface 0)', () => {
    const css = readClientFile('styles/screens.css');
    expect(css).toMatch(/\.chat-line__name \{[^}]*color: hsl\(var\(--name-hue, 150\) 70% 72%\)/);
    expect(css).toMatch(/\.chat-log \{[^}]*background: var\(--surface-0\)/);
    const well = resolveColor(tokens, 'surface.s0');
    expect(well).toEqual(parseColor(tokens.color.surface.s0));
    let worst = Infinity;
    for (let h = 0; h < 360; h++) worst = Math.min(worst, contrastRatio(hsl(h, 0.7, 0.72), well));
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  it('the screens\' text/surface pairs are in the contrast check', () => {
    const pairs = tokens.contrast.map((p) => `${p.fg} on ${p.bg.join('/')}`);
    for (const p of [
      'text.secondary on surface.s0', 'text.dim on surface.s0', 'text.dim on surface.s3', 'primary.base on surface.s1',
      'primary.base on surface.s2', 'success on surface.s2', 'danger.text on surface.s2', 'warning on surface.s2',
      'team.a on surface.s2', 'team.b on surface.s2', 'danger.text on danger.solid@0.14/surface.s1',
      'text.primary on surface.s1@0.92/felt.deep', 'primary.hover on felt.deep',
    ]) expect(pairs, p).toContain(p);
  });
});
