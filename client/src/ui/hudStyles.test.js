/**
 * The table and its HUD are on tokens and kit classes (item 18a, ui-d1 /
 * ui-d2 for the table): no hex color literal and no inline style
 * assignment in these files (dynamic geometry goes through CSS variables,
 * style.setProperty('--x', ...), which the roadmap counts separately).
 * The same greps the roadmap measures with.
 */
import { describe, it, expect } from 'vitest';
import { readClientFile } from '../testing/files.js';

const HUD_FILES = [
  'src/phaser/managers/BidManager.js', 'src/ui/components/GameLog.js', 'src/ui/components/ScoreModal.js',
  'src/ui/components/VoiceChatUI.js', 'src/ui/components/TournamentScoreboard.js', 'src/phaser/managers/LayoutManager.js',
  'src/phaser/scenes/GameScene.js', 'src/phaser/managers/DrawManager.js', 'src/ui/components/Toast.js',
  'src/ui/components/ConnectionBanner.js', 'src/ui/components/ChatBubble.js', 'src/ui/tableHud.js', 'src/ui/transitionOverlay.js',
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const INLINE = /style\.cssText|\.style\.[a-zA-Z]+ *=|style="/;

describe('the table on tokens and kit classes', () => {
  for (const file of HUD_FILES) {
    it(`${file}: no hex literal, no inline style`, () => {
      const src = readClientFile(file);
      expect(src.match(HEX) || [], 'hex literals').toEqual([]);
      const inline = src.split('\n').filter((l) => INLINE.test(l));
      expect(inline, 'inline style assignments').toEqual([]);
    });
  }

  it('no infinite animation on the table but the opacity-only turn glow', () => {
    for (const css of ['styles/table.css', 'styles/kit.css', 'styles/components.css', 'styles.css', 'styles/gate.css']) {
      const text = readClientFile(css);
      const infinite = [...text.matchAll(/animation:\s*([\w-]+)[^;]*infinite/g)].map((m) => m[1]);
      expect(infinite.every((n) => n === 'kit-turn-glow'), `${css}: ${infinite}`).toBe(true);
    }
  });
});

/** The declarations of the rule for `sel` in a stylesheet (its first block). */
function ruleOf(css, sel) {
  const i = css.indexOf(`\n${sel} {`);
  expect(i, sel).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

describe('HUD hit targets (HIG 44 pt)', () => {
  const table = readClientFile('styles/table.css');
  const components = readClientFile('styles/components.css');
  const kit = readClientFile('styles/kit.css');

  it('each voice button in the table slot keeps its own hit extension (the mute button\'s does not cover the gear)', () => {
    // the kit's 44 px extension is an absolute ::before on a positioned button...
    expect(ruleOf(kit, '.kit-icon-btn')).toContain('position: relative');
    expect(ruleOf(kit, '.kit-icon-btn::before')).toContain('position: absolute');
    // ...so a rule that makes a slot button static hands its ::before to the
    // (absolute) .hud-voice slot, where the last button's covers both
    expect(ruleOf(components, '.hud-voice')).toContain('position: absolute');
    for (const [css, sel] of [[table, '.hud-voice > .voice-btn'], [components, '.hud-voice > button']]) {
      const r = ruleOf(css, sel);
      expect(r, sel).not.toMatch(/position:\s*static/);
      expect(r, sel).toMatch(/position:\s*relative/);
    }
  });

  it('the log\'s Send and the voice overlay\'s Mute buttons are at least the hit target tall', () => {
    expect(ruleOf(table, '#gameFeed .chat-send')).toContain('min-height: var(--hit-target)');
    expect(ruleOf(table, '.voice-row .kit-btn')).toContain('min-height: var(--hit-target)');
    // and no table rule sets a button's min-height below 44 px
    const small = [...table.matchAll(/\n([^{}\n]*(?:btn|button|send)[^{}\n]*)\{[^}]*min-height:\s*(\d+)px/g)]
      .filter((m) => Number(m[2]) < 44).map((m) => m[1].trim());
    expect(small).toEqual([]);
  });
});
