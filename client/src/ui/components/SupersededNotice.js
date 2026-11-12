/**
 * "Open in another tab" notice (live check 2026-11-11: a second tab of the
 * same saved session left the first one signed in but dead, every action
 * failing with "User not registered yet"). The server keeps one live
 * connection per user: when a newer tab (or window) of this browser takes
 * the session, this tab gets `sessionSuperseded` and shows this notice over
 * the whole page. "Use here" takes the session back (a fresh socket that
 * restores the session and re-enters the screen, which parks the other tab
 * with the same notice).
 *
 * A pinned kit modal (focus trap, focus restore; a modal opened while it is
 * up goes in under it, inert) that cannot be dismissed: the only way out is
 * Use here. role=alertdialog, labelled and described, focus
 * on the button; the backdrop is opaque (nothing stale behind it shows
 * through). Reduced motion: the kit's fade is off.
 */
import { el, createButton, openModal } from '../kit/index.js';

export const NOTICE_ID = 'supersededNotice';
export const NOTICE_TITLE = 'BAB Online is open in another tab';
export const NOTICE_TEXT = 'You are signed in to BAB Online in another tab or window, so this one is paused. '
  + 'Choose Use here to play in this tab instead; the other one will pause.';

let current = null;

/** @returns {boolean} whether the notice is on screen */
export function isSupersededNoticeShown() {
  return Boolean(current && current.isOpen());
}

/**
 * Show the notice (once; a repeat while it is up changes nothing).
 * @param {Object} o
 * @param {Function} o.onUseHere - the player takes the session back
 */
export function showSupersededNotice({ onUseHere } = {}) {
  if (isSupersededNoticeShown()) return current;
  const textId = `${NOTICE_ID}-text`;
  const useHere = createButton({ label: 'Use here', variant: 'primary', className: 'superseded-notice__use' });
  const modal = openModal({
    id: NOTICE_ID,
    title: NOTICE_TITLE,
    body: el('p', { className: 'superseded-notice__text', attrs: { id: textId }, text: NOTICE_TEXT }),
    actions: [useHere],
    dismissible: false,
    className: 'superseded-notice',
    initialFocus: useHere,
    // a dialog opened behind it (a game event still reaching this tab)
    // never takes focus from Use here
    pinned: true,
  });
  modal.backdrop.classList.add('superseded-notice-backdrop');
  modal.dialog.setAttribute('role', 'alertdialog');
  modal.dialog.setAttribute('aria-describedby', textId);
  useHere.addEventListener('click', () => {
    hideSupersededNotice();
    onUseHere?.();
  });
  current = modal;
  return modal;
}

/** Take the notice down (Use here, a sign-out, the session restored on this tab). */
export function hideSupersededNotice() {
  const modal = current;
  current = null;
  if (modal && modal.isOpen()) modal.close('api');
}
