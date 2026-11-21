/**
 * The Tutorial button and its confirm (the DOM; GameScene's wiring is
 * GameScene.tutorialButton.test.js, the real page table/tutorialButton*.test.js).
 * The button is iOS's round corner button in my seat's row (tableHud's
 * .hud-voice), right after the sound toggle, where the layout reserved it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  syncTutorialButton, showTutorialConfirm, closeTutorialConfirm, tutorialConfirmOpen, resetTutorialButton, TUTORIAL_BUTTON_ID,
  tutorialButtonTitle,
} from './TutorialButton.js';
import { applyHudLayout, clearHud, hudVoiceSlot } from '../tableHud.js';
import { layoutForViewport } from '../../phaser/layout/computeTableLayout.js';
import { openModalCount } from '../kit/index.js';
import { readClientFile } from '../../testing/files.js';

let container;
beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  container.id = 'game-container';
  document.body.appendChild(container);
  applyHudLayout(layoutForViewport({ vw: 1280, vh: 800, tutorial: true }));
});
afterEach(() => {
  resetTutorialButton();
  clearHud();
  document.body.innerHTML = '';
});

const btn = () => document.getElementById(TUTORIAL_BUTTON_ID);
const ON_TITLE = "Tutorial on\nTurns off the tutorial's tips and advice. /help still works any time.";
const OFF_TITLE = 'Tutorial off\nTurns on tips and advice for every turn.';

describe('the Tutorial button', () => {
  it('sits in my row of round controls, right after the sound toggle, before the voice buttons', () => {
    const slot = hudVoiceSlot();
    const sound = document.createElement('button');
    sound.id = 'sound-toggle-btn';
    const mic = document.createElement('button');
    mic.className = 'voice-btn';
    slot.append(sound, mic);
    syncTutorialButton({ visible: true });
    expect([...slot.children].map((b) => b.id || b.className)).toEqual(['sound-toggle-btn', TUTORIAL_BUTTON_ID, 'voice-btn']);
    // again: it stays put
    syncTutorialButton({ visible: true, on: true });
    expect(slot.children[1]).toBe(btn());
    expect(document.querySelectorAll(`#${TUTORIAL_BUTTON_ID}`)).toHaveLength(1);
  });

  it('a round kit icon button: the cap alone, aria-label "Tutorial", aria-pressed, iOS\'s label and hint as its tooltip', () => {
    syncTutorialButton({ visible: true, on: false });
    const b = btn();
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.classList.contains('kit-icon-btn')).toBe(true);
    expect(b.classList.contains('tutorial-btn')).toBe(true);
    expect(b.textContent).toBe('');
    expect(b.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe('Tutorial');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.title).toBe(OFF_TITLE);
    expect(b.dataset.state).toBe('off');
    syncTutorialButton({ visible: true, on: true });
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.title).toBe(ON_TITLE);
    expect(b.dataset.state).toBe('on');
    expect([tutorialButtonTitle(true), tutorialButtonTitle(false)]).toEqual([ON_TITLE, OFF_TITLE]);
  });

  it('a click (Enter / Space are a button\'s click) calls onToggle; disabled: aria-disabled, still focusable, nothing', () => {
    const onToggle = vi.fn();
    syncTutorialButton({ visible: true, on: false, onToggle });
    btn().click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    syncTutorialButton({ visible: true, on: false, disabled: true, onToggle });
    expect(btn().getAttribute('aria-disabled')).toBe('true');
    expect(btn().disabled).toBe(false);
    btn().click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    syncTutorialButton({ visible: true, on: false, onToggle });
    expect(btn().hasAttribute('aria-disabled')).toBe(false);
  });

  it('hidden: out of the row (it takes no room)', () => {
    syncTutorialButton({ visible: true });
    expect(btn()).not.toBeNull();
    syncTutorialButton({ visible: false });
    expect(btn()).toBeNull();
    syncTutorialButton({ visible: true, on: true });
    expect(btn().parentElement).toBe(hudVoiceSlot());
  });

  it('no slot in the layout (a spectator\'s or a lazy watcher\'s table, a 360 px phone) or no table: no button', () => {
    applyHudLayout(layoutForViewport({ vw: 1280, vh: 800 }));
    expect(syncTutorialButton({ visible: true })).toBeNull();
    expect(btn()).toBeNull();
    applyHudLayout(layoutForViewport({ vw: 1280, vh: 800, isSpectator: true, tutorial: true }));
    expect(syncTutorialButton({ visible: true })).toBeNull();
    clearHud();
    expect(syncTutorialButton({ visible: true })).toBeNull();
  });

  it('its look is tokens only: the row\'s size, the secondary cap off, the primary green cap and 2 px ring on, dimmed when disabled', () => {
    const table = readClientFile('styles/table.css');
    const rule = (sel) => {
      const i = table.indexOf(`\n${sel} {`);
      expect(i, sel).toBeGreaterThan(-1);
      return table.slice(i, table.indexOf('}', i));
    };
    expect(rule('.hud-voice > .tutorial-btn.kit-icon-btn')).toContain('--icon-btn-size: var(--voice-btn, 36px)');
    expect(rule('.hud-voice > .tutorial-btn.kit-icon-btn')).toContain('color: var(--text-secondary)');
    const on = rule('.hud-voice > .tutorial-btn.kit-icon-btn[aria-pressed="true"]');
    expect(on).toContain('border: 2px solid var(--primary-base)');
    expect(on).toContain('color: var(--primary-base)');
    expect(on).not.toContain('danger');
    expect(rule('.hud-voice > .tutorial-btn.kit-icon-btn[aria-disabled="true"]')).toContain('opacity');
    const all = table.slice(table.indexOf('/* the Tutorial button (ui/components/TutorialButton.js)'), table.indexOf('/* the main room\'s header'));
    expect(all.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
  });
});

describe('the confirm', () => {
  it('a kit modal with iOS\'s words; focus on Cancel; Cancel sends nothing', () => {
    const onConfirm = vi.fn();
    syncTutorialButton({ visible: true });
    btn().focus();
    showTutorialConfirm({ onConfirm });
    const dialog = document.querySelector('#tutorial-confirm [role="dialog"]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector('.kit-modal__title').textContent).toBe('Turn on the tutorial?');
    expect(dialog.querySelector('.kit-modal__body').textContent).toBe("You'll get tips and advice on every turn. This game will count as bot-assisted for you: it goes in your bot-game stats, not the human leaderboard.");
    expect([...dialog.querySelectorAll('.kit-modal__actions button')].map((b) => b.textContent)).toEqual(['Cancel', 'Turn on']);
    expect(document.activeElement.textContent).toBe('Cancel');
    document.activeElement.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(tutorialConfirmOpen()).toBe(false);
    expect(document.getElementById('tutorial-confirm')).toBeNull();
    // focus back on the button
    expect(document.activeElement).toBe(btn());
  });

  it('Turn on: closes, then onConfirm once', () => {
    const onConfirm = vi.fn(() => expect(tutorialConfirmOpen()).toBe(false));
    showTutorialConfirm({ onConfirm });
    document.getElementById('tutorial-confirm-ok').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(openModalCount()).toBe(0);
  });

  it('Escape is Cancel; closeTutorialConfirm takes it down without a word; one at a time', () => {
    const onConfirm = vi.fn();
    showTutorialConfirm({ onConfirm });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tutorialConfirmOpen()).toBe(false);
    showTutorialConfirm({ onConfirm });
    showTutorialConfirm({ onConfirm });
    expect(document.querySelectorAll('#tutorial-confirm')).toHaveLength(1);
    closeTutorialConfirm();
    expect(openModalCount()).toBe(0);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
