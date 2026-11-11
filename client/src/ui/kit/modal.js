/**
 * Modal (roadmap item 18a): one implementation for every dialog.
 *
 *   - role="dialog", aria-modal, labelled by its title;
 *   - focus moves in (initialFocus, else the first focusable, else the
 *     dialog) and is trapped: Tab / Shift+Tab cycle inside it;
 *   - Escape closes it when `dismissible` (where closing is safe: never a
 *     dialog whose only way out is an action, like the score modal);
 *   - on close, focus returns to what had it before.
 */
import { el } from './elements.js';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

let openCount = 0;
let ids = 0;

/** Focusable descendants in tab order (visible ones; jsdom has no layout, so hidden attr only). */
export function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && !n.closest('[hidden]') && !n.closest('[inert]'));
}

/**
 * @param {Object} o
 * @param {string} [o.title]
 * @param {Node|Node[]} [o.body]
 * @param {Node[]} [o.actions] - buttons for the footer
 * @param {boolean} [o.dismissible=true] - Escape and a backdrop click close it
 * @param {HTMLElement} [o.initialFocus]
 * @param {Function} [o.onClose] - (reason: 'escape'|'backdrop'|'action'|'api')
 * @param {string} [o.id] - the backdrop's id
 * @param {string} [o.className] - extra classes on the dialog
 * @param {HTMLElement} [o.parent=document.body]
 * @returns {{backdrop: HTMLElement, dialog: HTMLElement, close: Function, isOpen: Function}}
 */
export function openModal({
  title = '', body = null, actions = [], dismissible = true, initialFocus = null,
  onClose = null, id = null, className = '', parent = null,
} = {}) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `kit-modal-title-${++ids}`;

  const dialog = el('div', {
    className: ['kit-modal', 'kit-panel', 'kit-elev-3', className].filter(Boolean).join(' '),
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? titleId : null, tabindex: '-1' },
  });
  if (title) dialog.appendChild(el('h2', { className: 'kit-modal__title', attrs: { id: titleId }, text: title }));
  const bodyNodes = Array.isArray(body) ? body : body ? [body] : [];
  if (bodyNodes.length) dialog.appendChild(el('div', { className: 'kit-modal__body', children: bodyNodes }));
  if (actions.length) dialog.appendChild(el('div', { className: 'kit-modal__actions', children: actions }));

  const backdrop = el('div', { className: 'kit-modal-backdrop', attrs: { id }, children: [dialog] });

  let open = true;
  const close = (reason = 'api') => {
    if (!open) return;
    open = false;
    openCount = Math.max(0, openCount - 1);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    onClose?.(reason);
  };

  function onKey(e) {
    if (!open || !backdrop.isConnected) return;
    if (e.key === 'Escape') {
      if (!dismissible) return;
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

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) close('backdrop');
  });
  // focus leaving the dialog (a click on the page behind) comes back
  backdrop.addEventListener('focusout', (e) => {
    if (open && e.relatedTarget && !dialog.contains(e.relatedTarget)) dialog.focus();
  });

  (parent || document.body).appendChild(backdrop);
  openCount++;
  document.addEventListener('keydown', onKey, true);
  const target = initialFocus || focusables(dialog)[0] || dialog;
  target.focus();

  return { backdrop, dialog, close, isOpen: () => open };
}

/** Modals open now (tests). */
export function openModalCount() {
  return openCount;
}
