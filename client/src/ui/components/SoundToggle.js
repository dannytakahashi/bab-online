/**
 * The sound effects toggle (audio/SoundManager.js): a kit icon button with
 * a speaker, at the table in the HUD's voice slot (first, left of the voice
 * buttons; under my box, or the corner for a spectator) and in the main
 * room's header. Every copy follows the one per-device setting.
 *
 * Like the microphone button, aria-pressed is the MUTED state (the kit draws
 * a pressed icon button red) and the name says what pressing does; the
 * tooltip says the state ("Sound on" / "Sound off").
 */

import { getSoundManager } from '../../audio/SoundManager.js';
import { createIconButton } from '../kit/index.js';
import { hudVoiceSlot, hudLayout } from '../tableHud.js';
import { getClientSession, SCREEN } from '../../state/ClientSession.js';

export const TABLE_SOUND_BUTTON_ID = 'sound-toggle-btn';

function speakerIcon(muted) {
  const cone = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>';
  const rest = muted
    ? '<line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>'
    : '<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>';
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${cone}${rest}</svg>`;
}

/** Show a muted state on one button. */
function show(btn, muted) {
  btn.innerHTML = speakerIcon(muted);
  btn.setAttribute('aria-pressed', String(!!muted));
  btn.setAttribute('aria-label', 'Mute sound effects');
  btn.title = muted ? 'Sound off' : 'Sound on';
  btn.dataset.state = muted ? 'off' : 'on';
}

/**
 * A toggle button bound to the sound setting; insert it at once (it stops
 * listening once it has left the page).
 * @param {Object} [opts]
 * @param {string} [opts.id]
 * @param {string} [opts.className]
 * @param {Object} [opts.sound] - the SoundManager (tests)
 * @returns {HTMLButtonElement}
 */
export function createSoundToggle({ id = null, className = '', sound = getSoundManager() } = {}) {
  const btn = createIconButton({ icon: speakerIcon(sound.muted), label: 'Mute sound effects', className: ['sound-btn', className].filter(Boolean).join(' '), pressed: sound.muted });
  if (id) btn.id = id;
  show(btn, sound.muted);
  btn.addEventListener('click', () => {
    sound.toggleMuted();
  });
  // A change comes from a click or another tab, never while the button is
  // being placed: one that has left the page stops listening
  const off = sound.onChange(({ muted }) => {
    if (!btn.isConnected) {
      off();
      return;
    }
    show(btn, muted);
  });
  return btn;
}

/** At a table (or its score modal), as VoiceChatUI's atTable. */
function atTable() {
  const screen = getClientSession().screen;
  return screen === SCREEN.TABLE || screen === SCREEN.GAME_END;
}

/**
 * Put the table's toggle in the HUD voice slot (made on first use), first
 * in the row. Called with every voice-button reattach (GameScene relayout,
 * render, my box); a no-op off the table.
 * @returns {HTMLButtonElement|null}
 */
export function placeSoundToggle() {
  try {
    const slot = atTable() && hudLayout() ? hudVoiceSlot({ create: true }) : null;
    let btn = document.getElementById(TABLE_SOUND_BUTTON_ID);
    if (!slot) {
      // off the table (a teardown already emptied the HUD)
      btn?.remove();
      return null;
    }
    if (!btn) btn = createSoundToggle({ id: TABLE_SOUND_BUTTON_ID });
    if (slot.firstElementChild !== btn) slot.insertBefore(btn, slot.firstElementChild);
    return btn;
  } catch (err) {
    console.warn('[Sound] toggle placement failed:', err?.message || err);
    return null;
  }
}
