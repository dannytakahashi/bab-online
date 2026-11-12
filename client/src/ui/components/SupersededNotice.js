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
 *
 * Texts (variants of `sessionSuperseded.reason`, plus one of the page's
 * own): 'newerConnection', the session is live in another tab;
 * 'otherClosed' (2026-11-11, the session-quirks follow-up), that tab was
 * closed and nothing holds the session now, so Use here continues here.
 * The server tells it ~2 s after the other tab's socket dropped and only
 * if no tab took the session back meanwhile (a reload of the other tab
 * does), and goes back to 'newerConnection' when one does. 'reconnected'
 * (the page's, review 2026-11-12): this tab's socket reconnected while
 * parked (a deploy, a network blip); a parked tab never restores, so the
 * server no longer knows the new socket as parked and tells it nothing:
 * the notice says only that the other tab may still be open. The text
 * changes in place: focus stays on Use here and the new text is announced
 * (the description is a polite live region, and it carries the reason
 * itself: the title is not announced again, review 2026-11-12). The
 * session is never taken back by itself: a reload of the other tab would
 * then flip-flop between the two.
 */
import { el, createButton, openModal } from '../kit/index.js';

export const NOTICE_ID = 'supersededNotice';
export const NOTICE_TITLE = 'BAB Online is open in another tab';
export const NOTICE_TEXT = 'You are signed in to BAB Online in another tab or window, so this one is paused. '
  + 'Choose Use here to play in this tab instead; the other one will pause.';
// The two texts below share a title, so a change between them is the
// live text alone, and each says why on its own
export const NOTICE_PAUSED_TITLE = 'BAB Online is paused in this tab';
export const NOTICE_CLOSED_TITLE = NOTICE_PAUSED_TITLE;
export const NOTICE_CLOSED_TEXT = 'The other BAB Online tab was closed. Use here to continue.';
export const NOTICE_RECONNECTED_TEXT = 'BAB Online may still be open in another tab or window. '
  + 'Choose Use here to play in this tab instead.';

export const NOTICE_VARIANT = Object.freeze({ NEWER: 'newerConnection', CLOSED: 'otherClosed', RECONNECTED: 'reconnected' });

const COPY = {
  [NOTICE_VARIANT.NEWER]: { title: NOTICE_TITLE, text: NOTICE_TEXT },
  [NOTICE_VARIANT.CLOSED]: { title: NOTICE_PAUSED_TITLE, text: NOTICE_CLOSED_TEXT },
  [NOTICE_VARIANT.RECONNECTED]: { title: NOTICE_PAUSED_TITLE, text: NOTICE_RECONNECTED_TEXT },
};

let current = null;
let currentVariant = null;

/** @returns {boolean} whether the notice is on screen */
export function isSupersededNoticeShown() {
  return Boolean(current && current.isOpen());
}

/** Which text the notice shows (null when it is not up). */
export function supersededNoticeVariant() {
  return isSupersededNoticeShown() ? currentVariant : null;
}

/**
 * Change the text of the notice on screen (nothing when it is not up, or
 * already shows that text). Focus is left where it is (Use here).
 * @param {string} variant - NOTICE_VARIANT.*
 * @returns {boolean} whether the text changed
 */
export function setSupersededNoticeVariant(variant) {
  const copy = COPY[variant];
  if (!copy || !isSupersededNoticeShown() || currentVariant === variant) return false;
  const titleId = current.dialog.getAttribute('aria-labelledby');
  const titleEl = titleId ? current.dialog.querySelector(`#${titleId}`) : null;
  const textEl = current.dialog.querySelector('.superseded-notice__text');
  if (titleEl) titleEl.textContent = copy.title;
  if (textEl) textEl.textContent = copy.text;
  current.dialog.dataset.variant = variant;
  currentVariant = variant;
  return true;
}

/**
 * Show the notice (once; a repeat while it is up changes nothing but the
 * text, see setSupersededNoticeVariant).
 * @param {Object} o
 * @param {Function} o.onUseHere - the player takes the session back
 * @param {string} [o.variant] - NOTICE_VARIANT.* (default: another tab has the session)
 */
export function showSupersededNotice({ onUseHere, variant = NOTICE_VARIANT.NEWER } = {}) {
  if (isSupersededNoticeShown()) {
    setSupersededNoticeVariant(variant);
    return current;
  }
  const chosen = COPY[variant] ? variant : NOTICE_VARIANT.NEWER;
  const copy = COPY[chosen];
  const textId = `${NOTICE_ID}-text`;
  const useHere = createButton({ label: 'Use here', variant: 'primary', className: 'superseded-notice__use' });
  const modal = openModal({
    id: NOTICE_ID,
    title: copy.title,
    // A polite live region: a text change while it is up is announced
    body: el('p', { className: 'superseded-notice__text', attrs: { id: textId, 'aria-live': 'polite' }, text: copy.text }),
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
  modal.dialog.dataset.variant = chosen;
  currentVariant = chosen;
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
  currentVariant = null;
  if (modal && modal.isOpen()) modal.close('api');
}
