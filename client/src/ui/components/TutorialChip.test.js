import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncTutorialChip, resetTutorialChip } from './TutorialChip.js';

const q = (sel) => document.querySelector(sel);

beforeEach(() => {
  resetTutorialChip();
  document.body.innerHTML = '<div id="game-container"><div id="table-hud"></div></div>';
});

describe('the "Tutorial on" chip', () => {
  it('only while visible; in the HUD; "Tutorial on" with a switch that turns it off', () => {
    expect(syncTutorialChip({ visible: false })).toBeNull();
    expect(q('.hud-tutorial')).toBeNull();
    const onOff = vi.fn();
    const chip = syncTutorialChip({ visible: true, onOff });
    expect(chip.parentElement.id).toBe('table-hud');
    expect(chip.getAttribute('role')).toBe('group');
    expect(chip.getAttribute('aria-label')).toBe('Tutorial');
    expect(q('.hud-tutorial__label').textContent).toBe('Tutorial on');
    const sw = q('.hud-tutorial__switch');
    expect(sw.tagName).toBe('BUTTON');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-label')).toBe('Turn off the tutorial');
    sw.click();
    expect(onOff).toHaveBeenCalledTimes(1);
    // the card above my hand makes room for it
    expect(document.getElementById('table-hud').classList.contains('has-tutorial-chip')).toBe(true);
    syncTutorialChip({ visible: false, onOff });
    expect(chip.hidden).toBe(true);
    expect(document.getElementById('table-hud').classList.contains('has-tutorial-chip')).toBe(false);
  });

  it('busy: the switch waits (no second off)', () => {
    const onOff = vi.fn();
    syncTutorialChip({ visible: true, onOff, busy: true });
    const sw = q('.hud-tutorial__switch');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    sw.click();
    expect(onOff).not.toHaveBeenCalled();
    syncTutorialChip({ visible: true, onOff, busy: false });
    expect(sw.hasAttribute('aria-disabled')).toBe(false);
    sw.click();
    expect(onOff).toHaveBeenCalledTimes(1);
  });

  it('one chip, the newest callback; a HUD cleared under it gets a new one', () => {
    const a = vi.fn();
    const b = vi.fn();
    syncTutorialChip({ visible: true, onOff: a });
    syncTutorialChip({ visible: true, onOff: b });
    expect(document.querySelectorAll('.hud-tutorial')).toHaveLength(1);
    q('.hud-tutorial__switch').click();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    document.getElementById('table-hud').replaceChildren();
    expect(syncTutorialChip({ visible: true }).isConnected).toBe(true);
  });
});
