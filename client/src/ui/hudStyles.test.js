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
  'src/ui/components/SpectatorBadge.js', 'src/ui/drawHud.js', 'src/ui/components/SoundToggle.js', 'src/ui/handA11y.js',
  'src/phaser/managers/CardManager.js', 'src/ui/components/AssistCard.js', 'src/ui/components/TutorialButton.js',
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

describe('the tutorial tip in a card short of room', () => {
  const table = readClientFile('styles/table.css');

  it('keeps its title and its x pinned at the card\'s top on the card\'s own fill while the card scrolls to the advice', () => {
    const r = ruleOf(table, '.hud-assist.has-tip .assist-tip__top');
    expect(r).toContain('position: sticky');
    expect(r).toContain('top: calc(-1 * var(--space-2))');
    expect(r).toContain('background: rgb(var(--surface-1-rgb))');
    expect(r).not.toMatch(/z-index/);
    // the close is in that row (AssistCard tipSection)
    expect(readClientFile('src/ui/components/AssistCard.js')).toContain('top.append(title, close)');
  });
});

describe('the /help lightbulb', () => {
  const table = readClientFile('styles/table.css');

  it('is a gold bulb on a dark disc with a gold ring, all from tokens, with a 44 px hit area', () => {
    const r = ruleOf(table, '.hud-assist-ask');
    expect(r).toContain('color: var(--gold)');
    expect(r).toContain('border: 1px solid rgb(var(--gold-rgb) / 0.7)');
    expect(r).toContain('background: rgb(var(--surface-1-rgb) / 0.9)');
    expect(r).toContain('border-radius: var(--radius-pill)');
    expect(r).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // the ::before reaches the hit target round any button size
    expect(ruleOf(table, '.hud-assist-ask::before')).toContain('position: absolute');
    // (the layout's assistAskSpot: pad to the sides, up above, down below;
    // tableHud's --assist-ask-pad / -up / -down)
    const hit = [...table.matchAll(/\n\.hud-assist-ask::before \{([^}]*)\}/g)].map((m) => m[1]).join('');
    expect(hit).toContain('inset: calc(-1 * var(--ask-up)) calc(-1 * var(--assist-ask-pad, 6px)) calc(-1 * var(--ask-down));');
    expect(r).toContain('--ask-up: var(--assist-ask-up, 12px)');
    expect(r).toContain('--ask-down: var(--assist-ask-down, 0px)');
    expect(r).toContain('top: var(--ask-y)');
    // while the tutorial chip shows: the layout's chip spot
    const chip = ruleOf(table, '.has-tutorial-chip > .hud-assist-ask');
    expect(chip).toContain('--ask-y: var(--assist-ask-chip-y');
    expect(chip).toContain('--ask-up: var(--assist-ask-chip-up');
    expect(chip).toContain('--ask-down: var(--assist-ask-chip-down');
    expect(r).toContain('width: var(--assist-ask, 36px)');
    // its right and bottom edges are the spot's
    expect(r).toContain('transform: translate(-100%, -100%)');
    expect(ruleOf(table, '.hud-assist-ask:focus-visible')).toContain('outline: 2px solid');
  });

  it('its press dip is dropped with reduced motion', () => {
    const i = table.indexOf('@media (prefers-reduced-motion: reduce) {\n    .hud-assist-ask:active');
    expect(i).toBeGreaterThan(-1);
  });
});

describe('the spectator badge\'s bubble', () => {
  const table = readClientFile('styles/table.css');
  const components = readClientFile('styles/components.css');

  it('its ring is outside the box, where the tail covers it (an inset ring draws a line across the tail\'s base)', () => {
    const shadow = ruleOf(table, '.chat-bubble.is-spectator').match(/box-shadow:([^;]*);/)[1];
    expect(shadow).not.toMatch(/inset/);
    expect(shadow).toMatch(/0 0 0 1px rgb\(var\(--success-rgb\)/);
    // the tail is an absolute ::after just outside the box, so it paints over the bubble's own shadows
    expect(ruleOf(components, '.chat-bubble.tail-down::after')).toContain('bottom: -10px');
    expect(ruleOf(components, '.chat-bubble.tail-right::after')).toContain('right: -10px');
    expect(ruleOf(components, '.chat-bubble.tail-left::after')).toContain('left: -10px');
  });

  it('beside the badge (min-height for the tail) a short message is centred in the box, not at its top', () => {
    const side = ruleOf(table, '.hud-spectator-bubble .chat-bubble.tail-left, .hud-spectator-bubble .chat-bubble.tail-right');
    expect(side).toMatch(/display:\s*flex/);
    expect(side).toMatch(/flex-direction:\s*column/);
    expect(side).toMatch(/justify-content:\s*center/);
    // the min-height it centres in, and the clamp box it centres (still a -webkit-box)
    expect(ruleOf(table, '.hud-spectator-bubble .chat-bubble')).toContain('min-height: var(--specbub-min-h, 0px)');
    expect(ruleOf(components, '.chat-bubble-text')).toContain('display: -webkit-box');
  });
});
