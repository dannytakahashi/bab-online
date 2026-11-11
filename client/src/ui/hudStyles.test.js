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
    for (const css of ['styles/table.css', 'styles/kit.css', 'styles/components.css', 'styles.css']) {
      const text = readClientFile(css);
      const infinite = [...text.matchAll(/animation:\s*([\w-]+)[^;]*infinite/g)].map((m) => m[1]);
      expect(infinite.every((n) => n === 'kit-turn-glow'), `${css}: ${infinite}`).toBe(true);
    }
  });
});
