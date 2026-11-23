/**
 * The Tutorial button (owner 2026-11-21: "A button on the web client would
 * be nice too - the old people struggle with slash commands"; "The iOS
 * buttons are pretty"; "not in the game log area"): iOS build 29's round
 * TutorialCornerButton as one more round control in MY seat's row with the
 * sound toggle and the voice buttons (tableHud's .hud-voice under my HSI,
 * right after the sound one), since the tutorial is a personal control like
 * sound and voice. The layout reserves its slot (computeTableLayout
 * `tutorial`: my voice row 4 buttons wide, `L.voice.tutorial`) only while I
 * play my own seat; a spectator's and a lazy watcher's tables are as before,
 * and where the slot would cost a clean table (360 px phones, which the
 * phone gate sends to the app) there is no slot and no button. Words and
 * rules in state/tutorial.js; GameScene decides what it shows and sends.
 *
 *   button#tutorial-toggle-btn.kit-icon-btn.tutorial-btn   aria-label "Tutorial", aria-pressed,
 *                                                          title "Tutorial on|off" + iOS's hint
 *     svg   our own filled graduation cap (aria-hidden)
 *
 * As iOS: off, the row's subdued disc with the cap in the secondary text
 * colour; on, the same disc with the cap and a 2 px ring in the primary
 * green (never the kit's red pressed look). Drawn at the row's button size
 * (--voice-btn), its hit area 44 px (kit ::before). A real <button> (Tab,
 * Enter, Space) with the kit's focus ring. Disabled (aria-disabled, still
 * focusable; dimmed) during the draw and while a /tutorial line waits for
 * the server.
 *
 * The confirm (showTutorialConfirm) is a kit modal with iOS's words.
 */
import { el, createButton, openModal } from '../kit/index.js';
import { hudVoiceSlot, hudLayout } from '../tableHud.js';
import {
  BUTTON_LABEL, BUTTON_ON_TEXT, BUTTON_OFF_TEXT, BUTTON_ON_HINT, BUTTON_OFF_HINT,
  CONFIRM_TITLE, CONFIRM_MESSAGE, CONFIRM_BUTTON, CONFIRM_CANCEL,
} from '../../state/tutorial.js';
import { TABLE_SOUND_BUTTON_ID } from './SoundToggle.js';

export const TUTORIAL_BUTTON_ID = 'tutorial-toggle-btn';
export const TUTORIAL_CONFIRM_ID = 'tutorial-confirm';

// Our own filled graduation cap (currentColor), never Apple's SF Symbol artwork
// (also the avatar badge's: ui/seatPlates.js)
export const CAP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 3.5 1.5 8.75 12 14l10.5-5.25z"/><path fill="currentColor" d="M5.5 11.6v4.15c0 1.9 2.9 3.75 6.5 3.75s6.5-1.85 6.5-3.75V11.6L12 14.85z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M21 9.3v5.2"/><circle fill="currentColor" cx="21" cy="15.6" r="1.3"/></svg>';

/** The tooltip: the state, then what a press does (iOS's label and hint). */
export function tutorialButtonTitle(on) {
  return on ? `${BUTTON_ON_TEXT}\n${BUTTON_ON_HINT}` : `${BUTTON_OFF_TEXT}\n${BUTTON_OFF_HINT}`;
}

let btn = null;
let confirm = null;

/** My voice row, when the layout reserved the button's slot there (else null). */
function slot() {
  if (typeof document === 'undefined') return null;
  return hudLayout()?.voice?.tutorial ? hudVoiceSlot({ create: true }) : null;
}

function build() {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = TUTORIAL_BUTTON_ID;
  b.className = 'kit-icon-btn tutorial-btn';
  b.setAttribute('aria-label', BUTTON_LABEL);
  b.innerHTML = CAP_ICON; // a fixed icon, never user text
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    b._onToggle?.();
  });
  return b;
}

/** Right after the sound toggle (first while it is not there); the voice buttons follow. */
function place(host, b) {
  const sound = host.querySelector(`:scope > #${TABLE_SOUND_BUTTON_ID}`);
  if (sound ? b.previousElementSibling === sound : host.firstElementChild === b) return;
  host.insertBefore(b, sound ? sound.nextElementSibling : host.firstElementChild);
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
  if (btn && !btn.isConnected) btn = null;
  const host = visible ? slot() : null;
  if (!host) {
    // hidden, or no slot: out of the row, so the row is as without it
    btn?.remove();
    btn = null;
    return null;
  }
  if (!btn) btn = document.getElementById(TUTORIAL_BUTTON_ID) || build();
  place(host, btn);
  btn._onToggle = onToggle;
  btn.setAttribute('aria-pressed', String(!!on));
  btn.dataset.state = on ? 'on' : 'off';
  btn.title = tutorialButtonTitle(on);
  if (disabled) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
  return btn;
}

/**
 * "Turn on the tutorial?" (Cancel / Turn on): Escape, the backdrop and
 * Cancel send nothing. Focus starts on Cancel; when the player closes it
 * (Cancel, Turn on, Escape, the backdrop) focus goes to the Tutorial button
 * itself, not to what had it when it opened (a mouse click does not focus a
 * button in Safari: that would be the page's body). One at a time.
 * @param {Object} o
 * @param {Function} o.onConfirm - Turn on
 */
export function showTutorialConfirm({ onConfirm }) {
  closeTutorialConfirm();
  const cancel = createButton({ label: CONFIRM_CANCEL, variant: 'secondary', onClick: () => closeTutorialConfirm({ refocus: true }) });
  cancel.id = 'tutorial-confirm-cancel';
  const ok = createButton({
    label: CONFIRM_BUTTON,
    variant: 'primary',
    onClick: () => {
      closeTutorialConfirm({ refocus: true });
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
    onClose: (reason) => {
      if (confirm === modal) confirm = null;
      // after the kit's own focus restore
      if (reason === 'escape' || reason === 'backdrop') focusButton();
    },
  });
  confirm = modal;
  return modal;
}

/** Is the confirm up? */
export function tutorialConfirmOpen() {
  return !!confirm?.isOpen();
}

/** The Tutorial button takes focus (when it is on the page). */
function focusButton() {
  if (btn?.isConnected) btn.focus({ preventScroll: true });
}

/**
 * Take the confirm down (nothing sent).
 * @param {Object} [o]
 * @param {boolean} [o.refocus] - the player closed it: focus goes to the button
 */
export function closeTutorialConfirm({ refocus = false } = {}) {
  const m = confirm;
  confirm = null;
  m?.close('api');
  if (m && refocus) focusButton();
}

/** Tests: forget the nodes. */
export function resetTutorialButton() {
  closeTutorialConfirm();
  btn?.remove();
  btn = null;
}
