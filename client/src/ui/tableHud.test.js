import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyHudLayout, clearHud } from './tableHud.js';
import { layoutForViewport, assistAskSpot } from '../phaser/layout/computeTableLayout.js';

const px = (v) => `${Math.round(v * 100) / 100}px`;
const ASK_VARS = [
  '--assist-ask-x', '--assist-ask-y', '--assist-ask', '--assist-ask-pad', '--assist-ask-up', '--assist-ask-down',
];
// the in-hand "Tutorial on" chip's vars are gone with it (owner 2026-11-21: the log's Tutorial button)
const CHIP_VARS = ['--assist-ask-chip-y', '--assist-ask-chip-up', '--assist-ask-chip-down', '--tutorial-x', '--tutorial-y'];

describe('the HUD places the lightbulb from the layout', () => {
  let container;
  beforeEach(() => {
    // a fresh #table-hud each time: the vars are set, never removed
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  });
  afterEach(() => {
    clearHud();
    container.remove();
  });

  const vars = () => {
    const st = document.getElementById('table-hud').style;
    return Object.fromEntries(ASK_VARS.map((k) => [k, st.getPropertyValue(k)]));
  };

  for (const [vw, vh] of [[1280, 800], [1024, 768], [540, 800]]) {
    it(`sets every --assist-ask-* var from assistAskSpot, no chip var (${vw}x${vh})`, () => {
      const L = layoutForViewport({ vw, vh });
      applyHudLayout(L);
      const a = assistAskSpot(L);
      expect(vars()).toEqual({
        '--assist-ask-x': px(a.x),
        '--assist-ask-y': px(a.y),
        '--assist-ask': px(a.size),
        '--assist-ask-pad': px(a.pad),
        '--assist-ask-up': px(a.up),
        '--assist-ask-down': px(a.down),
      });
      const st = document.getElementById('table-hud').style;
      expect(CHIP_VARS.map((k) => st.getPropertyValue(k)).filter(Boolean)).toEqual([]);
    });
  }

  it('a spectator\'s layout (no hand) sets none of them', () => {
    applyHudLayout(layoutForViewport({ vw: 1280, vh: 800, isSpectator: true }));
    expect(Object.values(vars()).filter(Boolean)).toEqual([]);
  });
});
