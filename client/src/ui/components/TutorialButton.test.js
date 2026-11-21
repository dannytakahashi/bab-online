/**
 * The game log's Tutorial button and its confirm (the DOM; GameScene's
 * wiring is GameScene.test.js "the Tutorial button", the real page
 * table/tutorialButton.test.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  syncTutorialButton, showTutorialConfirm, closeTutorialConfirm, tutorialConfirmOpen, resetTutorialButton, TUTORIAL_BUTTON_ID,
} from './TutorialButton.js';
import { createGameLog } from './GameLog.js';
import { openModalCount } from '../kit/index.js';

let log;
beforeEach(() => {
  document.body.innerHTML = '';
  log = createGameLog({ onChatSubmit: () => true });
  document.body.appendChild(log.container);
});
afterEach(() => {
  resetTutorialButton();
  log.destroy?.();
  document.body.innerHTML = '';
});

const btn = () => document.getElementById(TUTORIAL_BUTTON_ID);

describe('the Tutorial button', () => {
  it('sits in the game log\'s header, beside the title', () => {
    syncTutorialButton({ visible: true, on: false });
    const header = document.querySelector('#gameFeed .chat-header');
    expect(header.querySelector('.log-header__title').textContent).toBe('Game Log');
    expect(btn().parentElement).toBe(header.querySelector('.log-header__actions'));
  });

  it('off: "Tutorial:" "Off", aria-pressed false, a constant name, the hint as its tooltip', () => {
    syncTutorialButton({ visible: true, on: false });
    const b = btn();
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.textContent).toBe('Tutorial:Off');
    expect(b.querySelector('.log-tutorial-btn__label').textContent).toBe('Tutorial:');
    expect(b.querySelector('.log-tutorial-btn__state').textContent).toBe('Off');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('aria-label')).toBe('Tutorial');
    expect(b.title).toBe('Turns on tips and advice for every turn.');
    expect(b.dataset.state).toBe('off');
    // the icon is decoration
    expect(b.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
  });

  it('on: "On", aria-pressed true', () => {
    syncTutorialButton({ visible: true, on: true });
    expect(btn().querySelector('.log-tutorial-btn__state').textContent).toBe('On');
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(btn().dataset.state).toBe('on');
    expect(btn().title).toBe("Turns off the tutorial's tips and advice. /help still works any time.");
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

  it('hidden, and one node across syncs', () => {
    syncTutorialButton({ visible: true });
    const first = btn();
    syncTutorialButton({ visible: false });
    expect(first.hidden).toBe(true);
    syncTutorialButton({ visible: true, on: true });
    expect(btn()).toBe(first);
    expect(first.hidden).toBe(false);
    expect(document.querySelectorAll(`#${TUTORIAL_BUTTON_ID}`)).toHaveLength(1);
  });

  it('no game log: nothing drawn (it comes with the log)', () => {
    document.body.innerHTML = '';
    expect(syncTutorialButton({ visible: true })).toBeNull();
    expect(btn()).toBeNull();
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
