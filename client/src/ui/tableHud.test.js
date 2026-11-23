import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyHudLayout, clearHud } from './tableHud.js';
import { layoutForViewport, assistAskSpot } from '../phaser/layout/computeTableLayout.js';

const px = (v) => `${Math.round(v * 100) / 100}px`;
const ASK_VARS = [
  '--assist-ask-x', '--assist-ask-y', '--assist-ask', '--assist-ask-pad', '--assist-ask-up', '--assist-ask-down',
];
// the in-hand "Tutorial on" chip's vars are gone with it (owner 2026-11-21: the Tutorial button in my seat's row)
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

describe('the HUD places the avatar badge from the layout (seatBadge: the ring\'s corner)', () => {
  let container;
  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  });
  afterEach(() => {
    clearHud();
    container.remove();
  });

  for (const [vw, vh, isSpectator] of [[1920, 1080, false], [1024, 668, true], [844, 390, false]]) {
    it(`--seat-badge, --ring-corner-left / -top from the ring's top left, --seat-badge-left / -top from the corner (${vw}x${vh}${isSpectator ? ', a spectator' : ''})`, () => {
      const L = layoutForViewport({ vw, vh, isSpectator });
      applyHudLayout(L);
      const st = document.getElementById('table-hud').style;
      const { seatBadge: b, avatar } = L.seats.opp1;
      expect([st.getPropertyValue('--seat-badge'), st.getPropertyValue('--ring-corner-left'), st.getPropertyValue('--ring-corner-top'),
        st.getPropertyValue('--seat-badge-left'), st.getPropertyValue('--seat-badge-top')])
        .toEqual([px(b.size), px(b.eye.dx + avatar.size / 2), px(b.eye.dy + avatar.size / 2), px(b.dx - b.eye.dx), px(b.dy - b.eye.dy)]);
      // the same corner on every seat
      for (const k of ['self', 'partner', 'opp2']) expect([L.seats[k].seatBadge.dx, L.seats[k].seatBadge.dy]).toEqual([b.dx, b.dy]);
    });
  }
});
