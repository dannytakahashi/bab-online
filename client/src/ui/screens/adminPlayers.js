/**
 * The admin panel's Players tab pieces (ui/screens/AdminPanel.js wires
 * them): the table's sort and filter (pure), the row's "More" menu, and the
 * confirmation dialogs that ask the admin to type a name.
 *
 * Menu: the WAI-ARIA menu button pattern. The button carries
 * aria-haspopup / aria-expanded / aria-controls; opening it (click, Enter,
 * Space, ArrowDown, ArrowUp) focuses an item; ArrowUp / ArrowDown / Home /
 * End move between items, Escape closes it and puts focus back on the
 * button, Tab or a click elsewhere closes it. Escape is taken on the
 * window in the capture phase while a menu is open, so it closes the menu
 * and not the panel (the kit Modal listens on the document). Destructive
 * items come last, after a separator, in the danger text color: never the
 * first or the most prominent control (Apple HIG).
 *
 * Dialogs: kit Modals over the panel (dialogId adminConfirmDialog, so
 * removeAdminPanel closes them too). The confirm button stays disabled
 * until the typed text matches exactly; a refusal from the server is shown
 * in the dialog's own alert line and the dialog stays open; focus returns
 * to what opened it when it closes (the kit Modal).
 */
import { el, createButton, openModal } from '../kit/index.js';

/** Players table columns (the Actions column is not sortable). */
export const PLAYER_COLUMNS = [
  { key: 'username', label: 'Player', defaultAscending: true },
  { key: 'createdAt', label: 'Created', defaultAscending: false },
  { key: 'lastSeenAt', label: 'Last seen', defaultAscending: false },
  { key: 'gamesPlayed', label: 'Games', defaultAscending: false, numeric: true },
  { key: 'isAdmin', label: 'Admin', defaultAscending: false },
  { key: 'mergedInto', label: 'Merged', defaultAscending: true },
];

/** Newest account first (the server's order). */
export const DEFAULT_SORT = Object.freeze({ key: 'createdAt', ascending: false });

const time = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

/** A row's sort value; null sorts last in either direction. */
function sortValue(p, key) {
  switch (key) {
    case 'username': return p.username.toLowerCase();
    case 'createdAt': return time(p.createdAt);
    // online now is the most recent
    case 'lastSeenAt': return p.online ? Number.MAX_SAFE_INTEGER : time(p.lastSeenAt);
    case 'gamesPlayed': return p.mergedInto ? null : Number(p.gamesPlayed) || 0;
    case 'isAdmin': return p.isAdmin ? 1 : 0;
    case 'mergedInto': return p.mergedInto ? p.mergedInto.toLowerCase() : null;
    default: return null;
  }
}

/** A sorted copy (ties by name, so the order is stable and predictable). */
export function sortPlayers(list, { key, ascending }) {
  const dir = ascending ? 1 : -1;
  return [...list].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      if (x < y) return -dir;
      if (x > y) return dir;
    }
    return a.username.localeCompare(b.username);
  });
}

/** Rows whose name (or the account a tombstone points at) contains `text`, ignoring case. */
export function filterPlayers(list, text) {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) => p.username.toLowerCase().includes(q) || (p.mergedInto || '').toLowerCase().includes(q));
}

// ---------- the row menu ----------

let menuSeq = 0;
let openMenu = null; // the one open menu: {close}

/** Close whatever menu is open (a redraw, the panel closing). */
export function closeOpenMenu() {
  openMenu?.close({ focus: false });
}

/**
 * A "More" menu button.
 * @param {{label?: string, ariaLabel: string, focusKey?: string,
 *          items: Array<{label: string, onSelect: Function, danger?: boolean}|'separator'|null>}} o
 * @returns {HTMLElement} the wrapper (button + menu)
 */
export function createActionMenu({ label = 'More', ariaLabel, focusKey = null, items }) {
  const menuId = `adminMenu-${++menuSeq}`;
  const button = createButton({
    label, variant: 'ghost', size: 'sm', className: 'admin-menu__button',
    attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': ariaLabel, 'data-focus-key': focusKey },
  });
  button.appendChild(el('span', { className: 'admin-menu__caret', attrs: { 'aria-hidden': 'true' }, text: '▾' }));
  const menu = el('div', { className: 'admin-menu kit-panel kit-elev-2', attrs: { id: menuId, role: 'menu', 'aria-label': ariaLabel, hidden: true } });
  const entries = [];
  for (const item of items.filter(Boolean)) {
    if (item === 'separator') {
      if (entries.length) menu.appendChild(el('div', { className: 'admin-menu__sep', attrs: { role: 'separator' } }));
      continue;
    }
    const b = el('button', {
      className: `admin-menu__item${item.danger ? ' admin-menu__item--danger' : ''}`,
      attrs: { type: 'button', role: 'menuitem', tabindex: '-1' },
      text: item.label,
    });
    b.addEventListener('click', () => {
      close({ focus: true });
      item.onSelect();
    });
    menu.appendChild(b);
    entries.push(b);
  }
  const wrap = el('div', { className: 'admin-menu-wrap', children: [button, menu] });

  const isOpen = () => !menu.hidden;
  const focusItem = (i) => entries[(i + entries.length) % entries.length]?.focus();

  function onWindowKey(e) {
    if (!isOpen()) return;
    const at = entries.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close({ focus: true });
    } else if (e.key === 'Tab') {
      close({ focus: false });
    } else if (at !== -1 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowDown') focusItem(at + 1);
      else if (e.key === 'ArrowUp') focusItem(at - 1);
      else if (e.key === 'Home') focusItem(0);
      else focusItem(entries.length - 1);
    }
  }
  function onOutside(e) {
    if (isOpen() && !wrap.contains(e.target)) close({ focus: false });
  }

  function open(index = 0) {
    if (!entries.length) return;
    if (openMenu && openMenu.close !== close) openMenu.close({ focus: false });
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    openMenu = { close };
    window.addEventListener('keydown', onWindowKey, true);
    document.addEventListener('mousedown', onOutside, true);
    menu.scrollIntoView?.({ block: 'nearest' });
    focusItem(index);
  }
  function close({ focus = false } = {}) {
    if (!isOpen()) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (openMenu?.close === close) openMenu = null;
    window.removeEventListener('keydown', onWindowKey, true);
    document.removeEventListener('mousedown', onOutside, true);
    if (focus && button.isConnected) button.focus();
  }

  button.addEventListener('click', () => (isOpen() ? close({ focus: true }) : open(0)));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open(e.key === 'ArrowDown' ? 0 : entries.length - 1);
    }
  });
  return wrap;
}

// ---------- dialogs ----------

function inputField({ id, label, describedBy = null, value = '' }) {
  const input = el('input', {
    className: 'kit-input',
    attrs: { id, type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': describedBy },
  });
  input.value = value;
  return { input, wrap: el('div', { className: 'field admin-field', children: [el('label', { className: 'field__label', attrs: { for: id }, text: label }), input] }) };
}

/**
 * The shared shell: a form in a kit Modal with Cancel and a confirm button
 * that `ready()` enables. submit(values) answers {ok, message?} or null (no
 * answer, or the panel closed): ok or null closes, a refusal stays open
 * with its message in the dialog's alert line.
 */
function formDialog({ title, body, fields, ready, values, confirmLabel, danger, submit, initialFocus }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const alertLine = el('p', { className: 'admin-dialog__alert', attrs: { role: 'alert', id: 'adminDialogAlert' } });
    const cancel = createButton({ label: 'Cancel', variant: 'secondary', onClick: () => { modal.close('action'); finish(null); } });
    const ok = createButton({ label: confirmLabel, variant: danger ? 'danger' : 'primary', type: 'submit', attrs: { disabled: true, 'data-confirm': 'yes', form: 'adminDialogForm' } });
    const form = el('form', { className: 'admin-dialog__form', attrs: { id: 'adminDialogForm', novalidate: true }, children: [...body, ...fields.map((f) => f.wrap), alertLine] });
    // the footer button submits the form (it sits outside it, in the modal's actions)
    ok.addEventListener('click', (e) => {
      e.preventDefault();
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
    const update = () => { ok.disabled = !ready(); };
    for (const f of fields) f.input.addEventListener('input', () => { alertLine.textContent = ''; update(); });
    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy || !ready()) return;
      busy = true;
      ok.disabled = true;
      const res = await submit(values());
      busy = false;
      if (!modal.isOpen()) return finish(res);
      if (!res || res.ok) {
        modal.close('action');
        finish(res);
        return;
      }
      alertLine.textContent = res.message || 'Refused.';
      update();
      (fields[0]?.input)?.focus();
    });
    const modal = openModal({
      title,
      body: form,
      actions: [cancel, ok],
      className: 'admin-confirm admin-dialog',
      dialogId: 'adminConfirmDialog',
      initialFocus: initialFocus ? initialFocus(fields) : fields[0]?.input,
      onClose: () => finish(null),
    });
  });
}

/**
 * Ask for a destructive action with the account's name typed to confirm.
 * @param {{title: string, lines: string[], expected: string, confirmLabel: string,
 *          submit: (typed: string) => Promise<{ok: boolean, message?: string}|null>}} o
 * @returns {Promise<Object|null>} the submit answer that closed it, or null (cancelled)
 */
export function openTypedConfirm({ title, intro = null, lines, expected, confirmLabel, submit }) {
  const typed = inputField({ id: 'adminDialogConfirm', label: `Type ${expected} to confirm`, describedBy: 'adminDialogWhat' });
  const body = [
    intro ? el('p', { className: 'admin-confirm__text', text: intro }) : null,
    el('ul', { className: 'admin-list admin-dialog__what', attrs: { id: 'adminDialogWhat' }, children: lines.map((t) => el('li', { text: t })) }),
  ].filter(Boolean);
  return formDialog({
    title, body, fields: [typed], confirmLabel, danger: true,
    ready: () => typed.input.value === expected,
    values: () => typed.input.value,
    submit,
  });
}

/**
 * Rename: the new name, old → new shown as it is typed, and the new name
 * typed again to confirm.
 * @param {{oldName: string, rules: string, lines: string[],
 *          submit: ({newName, confirm}) => Promise<{ok, message?}|null>}} o
 */
export function openRenameDialog({ oldName, rules, lines, submit }) {
  const next = inputField({ id: 'adminRenameNew', label: 'New name', describedBy: 'adminRenameRules' });
  const again = inputField({ id: 'adminRenameConfirm', label: 'Type the new name again to confirm', describedBy: 'adminRenameSummary' });
  const summary = el('p', { className: 'admin-rename__summary', attrs: { id: 'adminRenameSummary' } });
  const newName = () => next.input.value.trim();
  const showSummary = () => {
    summary.replaceChildren(
      el('span', { className: 'admin-rename__old', text: oldName }),
      el('span', { className: 'admin-rename__arrow', attrs: { 'aria-hidden': 'true' }, text: ' → ' }),
      el('span', { className: 'admin-sr-only', text: ' becomes ' }),
      el('span', { className: 'admin-rename__new', text: newName() || '…' }),
    );
  };
  showSummary();
  next.input.addEventListener('input', showSummary);
  const body = [
    summary,
    el('ul', { className: 'admin-list admin-dialog__what', children: lines.map((t) => el('li', { text: t })) }),
    el('p', { className: 'admin-note', attrs: { id: 'adminRenameRules' }, text: rules }),
  ];
  return formDialog({
    title: `Rename ${oldName}`, body, fields: [next, again], confirmLabel: 'Rename', danger: false,
    ready: () => newName() !== '' && newName() !== oldName && again.input.value === newName(),
    values: () => ({ newName: newName(), confirm: again.input.value }),
    submit,
  });
}
