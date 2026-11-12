/**
 * Modal (roadmap item 18a): one implementation for every dialog.
 *
 *   - role="dialog", aria-modal, labelled by its title;
 *   - focus moves in (initialFocus, else the first focusable, else the
 *     dialog) and is trapped: Tab / Shift+Tab cycle inside it;
 *   - Escape closes it when `dismissible` (where closing is safe: never a
 *     dialog whose only way out is an action, like the score modal);
 *   - on close, focus returns to what had it before;
 *   - modals stack (item 18b: the avatar picker over the profile, a report
 *     form over a player's profile): only the top one takes keys and keeps
 *     focus, so Escape closes the picker, not the profile under it;
 *   - `closable` puts a labelled close button next to the title (the
 *     screens' pages: profile, leaderboard, records, player search);
 *   - `pinned` keeps a modal on top while it is open (the "open in another
 *     tab" notice): a modal opened meanwhile goes in under it, inert, with
 *     no focus or keys, and becomes live (focused) once the pinned one
 *     closes. Otherwise a dialog the player cannot see would take focus
 *     and the Tab trap from behind the opaque notice.
 */
import { el } from './elements.js';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

let ids = 0;
/** Open modals, bottom first: only the last one handles keys and focus. */
const stack = [];

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>';

/** Focusable descendants in tab order (visible ones; jsdom has no layout, so hidden attr only). */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && !n.closest('[hidden]') && !n.closest('[inert]'));
}

/** Index of the lowest pinned modal, or -1. */
const pinnedAt = () => stack.findIndex((e) => e.pinned);

/** A modal whose backdrop was removed from the page by hand is closed (no focus restore). */
function prune() {
  let unpinned = false;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i].backdrop.isConnected) {
      unpinned = unpinned || stack[i].pinned;
      stack[i].release();
    }
  }
  if (unpinned) unpin();
}

/** No pinned modal is left: the ones under it are live again. */
function unpin() {
  if (pinnedAt() !== -1) return;
  for (const e of stack) e.backdrop.removeAttribute('inert');
}

/**
 * @param {Object} o
 * @param {string} [o.title]
 * @param {Node|Node[]} [o.body]
 * @param {Node[]} [o.actions] - buttons for the footer
 * @param {boolean|function(): boolean} [o.dismissible=true] - Escape and a backdrop click close it
 *   (a function is asked at each key / click: a dialog busy with a request says no)
 * @param {boolean} [o.closable=false] - a close button beside the title (reason 'button')
 * @param {string} [o.closeLabel='Close'] - its accessible name
 * @param {HTMLElement|'dialog'} [o.initialFocus] - 'dialog': the dialog itself, not a control
 * @param {Function} [o.onClose] - (reason: 'escape'|'backdrop'|'button'|'action'|'api')
 * @param {string} [o.id] - the backdrop's id
 * @param {string} [o.dialogId] - the dialog's id
 * @param {string} [o.className] - extra classes on the dialog
 * @param {HTMLElement} [o.parent=document.body]
 * @param {boolean} [o.pinned=false] - stays the top modal while open (see the header)
 * @returns {{backdrop: HTMLElement, dialog: HTMLElement, close: Function, isOpen: Function}}
 */
export function openModal({
  title = '', body = null, actions = [], dismissible = true, closable = false, closeLabel = 'Close',
  initialFocus = null, onClose = null, id = null, dialogId = null, className = '', parent = null,
  pinned = false,
} = {}) {
  prune();
  // Under a pinned modal: in below it, inert, focus left where it is; its
  // focus restore goes to what had focus before the pinned one
  const under = pinned ? -1 : pinnedAt();
  const previous = under !== -1
    ? stack[under].previous
    : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `kit-modal-title-${++ids}`;

  const dialog = el('div', {
    className: ['kit-modal', 'kit-panel', 'kit-elev-3', className].filter(Boolean).join(' '),
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null, tabindex: '-1', id: dialogId },
  });
  const titleEl = title ? el('h2', { className: 'kit-modal__title', attrs: { id: titleId }, text: title }) : null;
  let closeBtn = null;
  if (closable) {
    closeBtn = el('button', {
      className: 'kit-icon-btn kit-modal__close',
      attrs: { type: 'button', 'aria-label': closeLabel, title: closeLabel },
    });
    closeBtn.innerHTML = CLOSE_ICON; // a fixed icon, never user text
    dialog.appendChild(el('div', { className: 'kit-modal__header', children: [titleEl || el('span'), closeBtn] }));
  } else if (titleEl) {
    dialog.appendChild(titleEl);
  }
  const bodyNodes = Array.isArray(body) ? body : body ? [body] : [];
  if (bodyNodes.length) dialog.appendChild(el('div', { className: 'kit-modal__body', children: bodyNodes }));
  if (actions.length) dialog.appendChild(el('div', { className: 'kit-modal__actions', children: actions }));

  const backdrop = el('div', { className: 'kit-modal-backdrop', attrs: { id }, children: [dialog] });

  const canDismiss = () => (typeof dismissible === 'function' ? dismissible() === true : Boolean(dismissible));
  let open = true;
  const entry = { backdrop, release: null, pinned, previous, focusIn: null };
  const isTop = () => stack[stack.length - 1] === entry;

  // Take it off the stack and drop the key listener (no focus move)
  entry.release = () => {
    if (!open) return false;
    open = false;
    const at = stack.indexOf(entry);
    if (at !== -1) stack.splice(at, 1);
    document.removeEventListener('keydown', onKey, true);
    return true;
  };

  const close = (reason = 'api') => {
    const coveredByPin = pinnedAt() > stack.indexOf(entry);
    if (!entry.release()) return;
    backdrop.remove();
    if (coveredByPin) {
      // closed under a pinned modal: focus stays on the pinned one
    } else if (pinned && pinnedAt() === -1 && stack.length) {
      // the modals under it are live now: the top one takes focus
      unpin();
      stack[stack.length - 1].focusIn();
    } else if (previous && previous.isConnected && typeof previous.focus === 'function') {
      previous.focus();
    }
    onClose?.(reason);
  };

  function onKey(e) {
    prune();
    if (!open || !isTop()) return;
    if (e.key === 'Escape') {
      if (!canDismiss()) return;
      e.preventDefault();
      e.stopPropagation();
      close('escape');
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables(dialog);
    if (list.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = dialog.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  closeBtn?.addEventListener('click', () => close('button'));
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && canDismiss() && isTop()) close('backdrop');
  });
  // focus leaving the dialog (a click on the page behind) comes back; a
  // modal opened on top of this one keeps its own focus
  backdrop.addEventListener('focusout', (e) => {
    if (open && isTop() && e.relatedTarget && !dialog.contains(e.relatedTarget)) dialog.focus();
  });

  (parent || document.body).appendChild(backdrop);
  document.addEventListener('keydown', onKey, true);
  entry.focusIn = () => {
    const target = initialFocus === 'dialog' ? dialog
      : initialFocus || focusables(dialog).find((n) => n !== closeBtn) || closeBtn || dialog;
    target.focus();
  };
  if (under !== -1) {
    stack.splice(under, 0, entry);
    backdrop.setAttribute('inert', '');
  } else {
    // a pinned modal makes the ones already open inert until it closes
    if (pinned) for (const e of stack) e.backdrop.setAttribute('inert', '');
    stack.push(entry);
    entry.focusIn();
  }

  return { backdrop, dialog, close, isOpen: () => open };
}

/** Modals open now (tests). */
export function openModalCount() {
  prune();
  return stack.length;
}
