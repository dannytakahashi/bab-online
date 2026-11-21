/**
 * The game log's Tutorial button (owner 2026-11-21: "A button on the web
 * client would be nice too - the old people struggle with slash commands";
 * iOS build 29's TutorialCornerButton). Words and rules in
 * state/tutorial.js; GameScene decides what it shows and sends.
 *
 * It sits in the game log's header, beside "Game Log" (GameLog.js
 * `.log-header__actions`): the log is its own column beside the canvas
 * (--log-w), so the button never covers the table, the cards, the bid
 * sheet, the /help card or the chat, at any window size; where the column
 * is narrow it wraps onto its own row under the title.
 *
 *   button#tutorial-toggle-btn.log-tutorial-btn   aria-label "Tutorial", aria-pressed on/off
 *     svg (graduation cap, aria-hidden)
 *     .log-tutorial-btn__label  "Tutorial:"
 *     .log-tutorial-btn__state  "On" / "Off" (aria-hidden: aria-pressed says it)
 *
 * A real <button> (Tab, Enter, Space), at least the 44 px hit target, a
 * visible text label and an obvious state (on: the tutorial's gold; off:
 * neutral). Disabled (aria-disabled, still focusable) during the draw and
 * while a /tutorial line waits for the server.
 *
 * The confirm (showTutorialConfirm) is a kit modal with iOS's words.
 */
import { el, createButton, openModal } from '../kit/index.js';
import {
  BUTTON_LABEL, BUTTON_STATE_ON, BUTTON_STATE_OFF, BUTTON_ON_HINT, BUTTON_OFF_HINT,
  CONFIRM_TITLE, CONFIRM_MESSAGE, CONFIRM_BUTTON, CONFIRM_CANCEL,
} from '../../state/tutorial.js';

export const TUTORIAL_BUTTON_ID = 'tutorial-toggle-btn';
export const TUTORIAL_CONFIRM_ID = 'tutorial-confirm';

// Our own graduation cap (currentColor), never Apple's SF Symbol artwork
const CAP_ICON = '<svg class="log-tutorial-btn__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 9l10-5 10 5-10 5z"></path><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"></path><path d="M22 9v6"></path></svg>';

let btn = null;
let confirm = null;

/** The log header's slot (none while there is no game log). */
function slot() {
  if (typeof document === 'undefined') return null;
  return document.querySelector('#gameFeed .log-header__actions');
}

function build() {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = TUTORIAL_BUTTON_ID;
  b.className = 'log-tutorial-btn';
  b.setAttribute('aria-label', BUTTON_LABEL);
  b.innerHTML = CAP_ICON; // a fixed icon, never user text
  b.append(
    el('span', { className: 'log-tutorial-btn__label', text: `${BUTTON_LABEL}:` }),
    el('span', { className: 'log-tutorial-btn__state', attrs: { 'aria-hidden': 'true' } }),
  );
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    b._onToggle?.();
  });
  return b;
}

/**
 * Show, update or hide the button.
 * @param {Object} o
 * @param {boolean} o.visible
 * @param {boolean} [o.on] - what it shows (the server's word, off while an off waits)
 * @param {boolean} [o.disabled]
 * @param {Function} [o.onToggle] - a click while enabled
 * @returns {HTMLButtonElement|null}
 */
export function syncTutorialButton({ visible = false, on = false, disabled = false, onToggle = null } = {}) {
  if (typeof document === 'undefined') return null;
  const host = slot();
  if (btn && !btn.isConnected) btn = null;
  if (!visible || !host) {
    if (btn) btn.hidden = true;
    return btn;
  }
  if (!btn) btn = document.getElementById(TUTORIAL_BUTTON_ID) || build();
  if (btn.parentElement !== host) host.appendChild(btn);
  btn._onToggle = onToggle;
  btn.hidden = false;
  btn.setAttribute('aria-pressed', String(!!on));
  btn.dataset.state = on ? 'on' : 'off';
  btn.title = on ? BUTTON_ON_HINT : BUTTON_OFF_HINT;
  btn.querySelector('.log-tutorial-btn__state').textContent = on ? BUTTON_STATE_ON : BUTTON_STATE_OFF;
  if (disabled) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
  return btn;
}

/**
 * "Turn on the tutorial?" (Cancel / Turn on): Escape, the backdrop and
 * Cancel send nothing. Focus starts on Cancel; on close it goes back to
 * the button. One at a time.
 * @param {Object} o
 * @param {Function} o.onConfirm - Turn on
 */
export function showTutorialConfirm({ onConfirm }) {
  closeTutorialConfirm();
  const cancel = createButton({ label: CONFIRM_CANCEL, variant: 'secondary', onClick: () => closeTutorialConfirm() });
  cancel.id = 'tutorial-confirm-cancel';
  const ok = createButton({
    label: CONFIRM_BUTTON,
    variant: 'primary',
    onClick: () => {
      closeTutorialConfirm();
      onConfirm?.();
    },
  });
  ok.id = 'tutorial-confirm-ok';
  const modal = openModal({
    title: CONFIRM_TITLE,
    id: TUTORIAL_CONFIRM_ID,
    className: 'page-modal tutorial-confirm',
    body: el('p', { className: 'dialog-copy', text: CONFIRM_MESSAGE }),
    actions: [cancel, ok],
    dismissible: true,
    initialFocus: cancel,
    onClose: () => {
      if (confirm === modal) confirm = null;
    },
  });
  confirm = modal;
  return modal;
}

/** Is the confirm up? */
export function tutorialConfirmOpen() {
  return !!confirm?.isOpen();
}

/** Take the confirm down (nothing sent). */
export function closeTutorialConfirm() {
  const m = confirm;
  confirm = null;
  m?.close('api');
}

/** Tests: forget the nodes. */
export function resetTutorialButton() {
  closeTutorialConfirm();
  btn?.remove();
  btn = null;
}
