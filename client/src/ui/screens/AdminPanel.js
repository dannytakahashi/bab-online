/**
 * The admin panel (owner, 2026-11-11): a wide kit Modal from the main
 * room's Admin entry, shown only to admins (adminApi.isAdmin, display
 * only: the server re-checks the database on every request). Tabs:
 *
 *   Players  find a player (created, last seen, games, admin, merged);
 *            make a one-time reset link (shown once, Copy button), sign
 *            out everywhere, make / remove admin
 *   Merge    find look-alike names, preview a merge (formatPlan's content),
 *            type the kept name to confirm, apply (refused if the data
 *            changed since the preview)
 *   Reports  newest first, resolve / dismiss with a note, open the player
 *   Admins   who is an admin; remove (the last admin cannot remove themselves)
 *   Audit    every admin action, newest first
 *
 * Destructive actions (sign out everywhere, remove admin, merge) ask for
 * confirmation first. Tabs follow the WAI-ARIA tabs pattern with MANUAL
 * activation (arrow keys / Home / End move focus, Enter or Space opens a
 * tab: opening one loads it from the server, and requests are rate
 * limited). Results are announced by one status line (role=status) and
 * errors by one alert line (role=alert), both present from the start. After
 * an action redraws the list holding the focused button, focus goes back to
 * the same action in the new rows, else to the tab's panel. Kit classes and
 * tokens only (styles/screens.css "Admin panel"); every name and server
 * text goes in as text, never markup.
 */
import { el, createButton, openModal, toast } from '../kit/index.js';
import { createAdminApi, setIsAdmin } from '../../admin/adminApi.js';

const TABS = [
  ['players', 'Players'],
  ['merge', 'Merge'],
  ['reports', 'Reports'],
  ['admins', 'Admins'],
  ['audit', 'Audit'],
];

let current = null; // {modal, api}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

function chip(text, tone = 'neutral') {
  return el('span', { className: `kit-chip kit-chip--${tone} admin-chip`, text });
}

function heading(text, level = 3, { focusable = false } = {}) {
  return el(`h${level}`, { className: 'admin-heading', attrs: focusable ? { tabindex: '-1' } : {}, text });
}

function field({ id, label, type = 'text', value = '', describedBy = null, placeholder = '' }) {
  const input = el('input', {
    className: 'kit-input',
    attrs: { id, type, placeholder, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': describedBy },
  });
  input.value = value;
  return {
    input,
    wrap: el('div', { className: 'field admin-field', children: [el('label', { className: 'field__label', attrs: { for: id }, text: label }), input] }),
  };
}

function table(headers, rows, { caption }) {
  return el('table', {
    className: 'admin-table',
    children: [
      el('caption', { className: 'admin-sr-only', text: caption }),
      el('thead', { children: [el('tr', { children: headers.map((h) => el('th', { attrs: { scope: 'col' }, text: h })) })] }),
      el('tbody', { children: rows }),
    ],
  });
}

const td = (content, className = '') => {
  const cell = el('td', { className });
  if (content instanceof Node) cell.appendChild(content);
  else cell.textContent = content === null || content === undefined ? '' : String(content);
  return cell;
};

/**
 * Ask before a destructive action: a small modal over the panel.
 * @returns {Promise<boolean>}
 */
export function confirmAction({ title, text, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (yes) => {
      if (answered) return;
      answered = true;
      modal.close('action');
      resolve(yes);
    };
    const cancel = createButton({ label: 'Cancel', variant: 'secondary', onClick: () => done(false) });
    const ok = createButton({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => done(true), attrs: { 'data-confirm': 'yes' } });
    const modal = openModal({
      title,
      body: el('p', { className: 'admin-confirm__text', text }),
      actions: [cancel, ok],
      className: 'admin-confirm',
      dialogId: 'adminConfirmDialog',
      initialFocus: cancel,
      onClose: () => {
        if (!answered) {
          answered = true;
          resolve(false);
        }
      },
    });
  });
}

/** Copy text: the async clipboard, else a selected field and execCommand. */
async function copyText(text, input) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back */ }
  try {
    input.focus();
    input.select();
    return document.execCommand?.('copy') === true;
  } catch {
    return false;
  }
}

/**
 * Open the panel.
 * @param {Object} socket - the page's socket
 * @param {{username?: string, api?: Object}} [options] - api: a fake for tests
 */
export function showAdminPanel(socket, { username = null, api = null } = {}) {
  removeAdminPanel();
  const adminApi = api || createAdminApi(socket);
  // Two live regions, both in the page from the start (one added or
  // re-roled later is often not announced): results politely, errors
  // assertively. say() writes one and clears the other.
  const status = el('p', { className: 'admin-status', attrs: { id: 'adminStatus', role: 'status' } });
  const alertLine = el('p', { className: 'admin-status admin-status--error', attrs: { id: 'adminAlert', role: 'alert' } });
  const statusBox = el('div', { className: 'admin-status-box', children: [status, alertLine] });

  const say = (text, kind = 'info') => {
    const error = kind === 'error';
    alertLine.textContent = error ? text : '';
    status.textContent = error ? '' : text;
    status.dataset.kind = kind;
  };

  let closed = false;
  /** One request; a 'forbidden' answer closes the panel (admin access is gone). */
  async function call(action, args) {
    let res;
    try {
      res = await adminApi.request(action, args);
    } catch (err) {
      if (!closed) {
        say(err?.message === 'rate_limited'
          ? 'Too many admin requests in a minute. Wait a moment and try again.'
          : 'No answer from the server. Check the connection and try again.', 'error');
      }
      return null;
    }
    if (closed) return null;
    if (!res.ok && res.error === 'forbidden') {
      // Close first (focus goes back to the Admin entry), then hide the
      // entry (the main room moves focus off it)
      removeAdminPanel();
      setIsAdmin(false);
      toast('Admin access is not available on this connection.', { type: 'error' });
      return null;
    }
    if (!res.ok) say(res.message, 'error');
    return res;
  }

  /**
   * After a redraw removed the focused button: focus the same action in the
   * new rows (data-focus-key), else `fallback`. Only when focus was lost
   * (it fell to <body>); a player who moved on keeps their place.
   */
  function refocus(root, key, fallback) {
    if (closed) return;
    const a = document.activeElement;
    const dialog = document.getElementById('adminPanelModal');
    if (a && a !== document.body && a.isConnected && dialog?.contains(a)) return;
    const again = key ? [...root.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === key) : null;
    (again || fallback)?.focus();
  }

  // ---------- tabs ----------
  const tablist = el('div', { className: 'admin-tabs', attrs: { role: 'tablist', 'aria-label': 'Admin sections' } });
  const panels = {};
  const tabs = {};
  for (const [key, label] of TABS) {
    tabs[key] = el('button', {
      className: 'admin-tab',
      attrs: { type: 'button', role: 'tab', id: `adminTab-${key}`, 'aria-controls': `adminPanel-${key}`, 'aria-selected': 'false', tabindex: '-1' },
      text: label,
    });
    panels[key] = el('section', {
      className: 'admin-section',
      attrs: { role: 'tabpanel', id: `adminPanel-${key}`, 'aria-labelledby': `adminTab-${key}`, tabindex: '0', hidden: true },
    });
    tablist.appendChild(tabs[key]);
  }
  const loaders = {};
  let active = null;
  function select(key, { focus = false } = {}) {
    if (active === key) return;
    active = key;
    for (const [k] of TABS) {
      const on = k === key;
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    }
    if (focus) tabs[key].focus();
    say(''); // the last message belonged to the other tab
    loaders[key]?.();
  }
  tablist.addEventListener('click', (e) => {
    const t = e.target.closest('[role="tab"]');
    if (t) select(t.id.replace('adminTab-', ''));
  });
  // Manual activation: the arrows only move focus; Enter / Space (the
  // button's click) opens the focused tab
  tablist.addEventListener('keydown', (e) => {
    const keys = TABS.map(([k]) => k);
    const focused = keys.findIndex((k) => tabs[k] === document.activeElement);
    const i = focused === -1 ? keys.indexOf(active) : focused;
    let next = null;
    if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length];
    else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length];
    else if (e.key === 'Home') next = keys[0];
    else if (e.key === 'End') next = keys[keys.length - 1];
    if (next) {
      e.preventDefault();
      tabs[next].focus();
    }
  });

  // ---------- Players ----------
  const players = panels.players;
  const search = field({ id: 'adminSearchInput', label: 'Find a player', type: 'search', placeholder: 'Part of a name' });
  const searchBtn = createButton({ label: 'Search', variant: 'primary', type: 'submit' });
  const searchForm = el('form', { className: 'admin-row', attrs: { role: 'search' }, children: [search.wrap, searchBtn] });
  const linkBox = el('div', { className: 'admin-link', attrs: { id: 'adminResetLink', hidden: true } });
  const results = el('div', { className: 'admin-results', attrs: { id: 'adminSearchResults' } });
  players.append(searchForm, linkBox, results);
  let lastQuery = '';

  /** quiet: a refresh after an action keeps that action's message */
  async function runSearch(query = search.input.value.trim(), { quiet = false } = {}) {
    if (!query) {
      say('Type part of a name to search.', 'error');
      search.input.focus();
      return;
    }
    lastQuery = query;
    const res = await call('searchPlayers', { query });
    if (!res || !res.ok) return;
    renderPlayers(res.players);
    if (!quiet) say(`${res.players.length} player${res.players.length === 1 ? '' : 's'} found for "${query}".`);
  }
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });

  function showLink(user, token, expiresAt) {
    const url = `${window.location.origin}/reset#${token}`;
    const id = 'adminResetLinkInput';
    const input = el('input', { className: 'kit-input admin-link__input', attrs: { id, type: 'text', readonly: true, 'aria-describedby': 'adminResetLinkNote' } });
    input.value = url;
    const copy = createButton({ label: 'Copy', variant: 'primary' });
    copy.addEventListener('click', async () => {
      const okCopy = await copyText(url, input);
      say(okCopy ? 'Link copied. Text it to the player.' : 'Copy failed: select the link and copy it by hand.', okCopy ? 'success' : 'error');
    });
    const hide = createButton({ label: 'Done', variant: 'ghost', onClick: () => { linkBox.hidden = true; linkBox.replaceChildren(); search.input.focus(); } });
    linkBox.replaceChildren(
      el('label', { className: 'field__label', attrs: { for: id }, text: `Reset link for ${user}` }),
      el('div', { className: 'admin-row', children: [input, copy, hide] }),
      el('p', { className: 'admin-note', attrs: { id: 'adminResetLinkNote' }, text: `Shown once: copy it now. It works once, until ${fmtDate(expiresAt)}. Making a new link cancels this one. Using it signs the player out everywhere.` }),
    );
    linkBox.hidden = false;
    copy.focus();
  }

  function renderPlayers(list) {
    if (!list.length) {
      results.replaceChildren(el('p', { className: 'muted-note', text: 'No players found.' }));
      return;
    }
    const rows = list.map((p) => {
      const name = el('div', { className: 'admin-name', children: [el('span', { text: p.username })] });
      if (p.isAdmin) name.appendChild(chip('admin', 'gold'));
      if (p.online) name.appendChild(chip('online', 'success'));
      if (p.mergedInto) name.appendChild(chip(`merged into ${p.mergedInto}`, 'neutral'));
      const actions = el('div', { className: 'admin-actions' });
      if (p.mergedInto) {
        actions.appendChild(createButton({ label: `Find ${p.mergedInto}`, variant: 'ghost', size: 'sm', onClick: () => { search.input.value = p.mergedInto; runSearch(p.mergedInto); } }));
      } else {
        actions.appendChild(createButton({
          label: 'Reset link', variant: 'secondary', size: 'sm', attrs: { 'aria-label': `Reset link: ${p.username}` },
          onClick: async () => {
            const res = await call('createResetLink', { username: p.username });
            if (res?.ok) {
              showLink(res.username, res.token, res.expiresAt);
              say(`Reset link made for ${res.username}.`, 'success');
            }
          },
        }));
        actions.appendChild(createButton({
          label: 'Sign out everywhere', variant: 'danger', size: 'sm', attrs: { 'aria-label': `Sign out everywhere: ${p.username}`, 'data-focus-key': `signout:${p.username}` },
          onClick: async () => {
            const yes = await confirmAction({
              title: `Sign ${p.username} out everywhere?`,
              text: `Every device ${p.username} is signed in on goes back to the sign-in screen, including a game in progress (it continues without them until they sign in again).`,
              confirmLabel: 'Sign out everywhere',
            });
            if (!yes) return;
            const res = await call('signOutEverywhere', { username: p.username });
            if (res?.ok) {
              say(`${res.username} is signed out: ${res.revokedSessions} saved session(s) revoked, ${res.disconnected} live connection(s) closed.`, 'success');
              await runSearch(lastQuery, { quiet: true });
              refocus(results, `signout:${p.username}`, players);
            }
          },
        }));
        actions.appendChild(p.isAdmin
          ? createButton({
            label: 'Remove admin', variant: 'danger', size: 'sm', attrs: { 'aria-label': `Remove admin: ${p.username}`, 'data-focus-key': `admin:${p.username}` },
            onClick: () => changeAdmin(p.username, false, refreshPlayersAt(`admin:${p.username}`)),
          })
          : createButton({
            label: 'Make admin', variant: 'secondary', size: 'sm', attrs: { 'aria-label': `Make admin: ${p.username}`, 'data-focus-key': `admin:${p.username}` },
            onClick: () => changeAdmin(p.username, true, refreshPlayersAt(`admin:${p.username}`)),
          }));
      }
      return el('tr', {
        children: [
          td(name), td(fmtDay(p.createdAt)), td(p.online ? 'now' : fmtDate(p.lastSeenAt)), td(p.mergedInto ? '—' : p.gamesPlayed, 'is-num'), td(actions),
        ],
      });
    });
    results.replaceChildren(table(['Player', 'Created', 'Last seen', 'Games', 'Actions'], rows, { caption: 'Players found' }));
  }

  /** Re-run the search, then focus the row's toggled button (same key). */
  const refreshPlayersAt = (key) => async () => {
    await runSearch(lastQuery, { quiet: true });
    refocus(results, key, players);
  };

  async function changeAdmin(user, on, after) {
    const self = user === username;
    const yes = await confirmAction(on
      ? { title: `Make ${user} an admin?`, text: `${user} will be able to do everything in this panel, including adding and removing admins.`, confirmLabel: 'Make admin', danger: false }
      : { title: `Remove ${user}'s admin?`, text: self ? 'You will lose access to this panel at once.' : `${user} loses access to this panel at once.`, confirmLabel: 'Remove admin' });
    if (!yes) return;
    const res = await call('setAdmin', { username: user, isAdmin: on });
    if (!res?.ok) return;
    say(on ? `${user} is now an admin.` : `${user} is no longer an admin.`, 'success');
    if (!on && self) {
      removeAdminPanel();
      setIsAdmin(false);
      toast('You are no longer an admin.', { type: 'info' });
      return;
    }
    await after?.();
  }

  // ---------- Merge ----------
  const merge = panels.merge;
  const keep = field({ id: 'adminMergeKeep', label: 'Keep this account', placeholder: 'e.g. Alan' });
  const sources = field({ id: 'adminMergeSources', label: 'Merge these accounts into it (comma separated)', placeholder: 'e.g. alan2, AlanB' });
  const previewBtn = createButton({ label: 'Preview merge', variant: 'primary', type: 'submit' });
  const dupBtn = createButton({ label: 'Find look-alike names', variant: 'secondary' });
  const mergeForm = el('form', { className: 'admin-merge-form', children: [keep.wrap, sources.wrap, el('div', { className: 'admin-row', children: [previewBtn, dupBtn] })] });
  const dupBox = el('div', { className: 'admin-dups', attrs: { id: 'adminDuplicates' } });
  // Not a live region: the status line announces a one-line summary
  const planBox = el('div', { className: 'admin-plan', attrs: { id: 'adminMergePlan' } });
  merge.append(mergeForm, dupBox, planBox);
  let preview = null; // {target, sources, planHash}

  const sourceList = () => [...new Set(sources.input.value.split(',').map((s) => s.trim()).filter(Boolean))];
  for (const f of [keep.input, sources.input]) {
    f.addEventListener('input', () => {
      if (preview) {
        preview = null;
        planBox.replaceChildren(el('p', { className: 'admin-note', text: 'The names changed: preview again.' }));
      }
    });
  }

  dupBtn.addEventListener('click', async () => {
    const res = await call('findDuplicates', {});
    if (!res?.ok) return;
    if (!res.groups.length) {
      dupBox.replaceChildren(el('p', { className: 'muted-note', text: 'No look-alike names found.' }));
      return;
    }
    dupBox.replaceChildren(heading('Look-alike names (most games first)'), el('ul', {
      className: 'admin-list',
      children: res.groups.map((g) => el('li', {
        className: 'admin-dup',
        children: [
          el('span', { text: g.map((u) => `${u.username} (${u.gamesPlayed} games)`).join(', ') }),
          createButton({
            label: 'Use', variant: 'ghost', size: 'sm', attrs: { 'aria-label': `Use ${g.map((u) => u.username).join(', ')}` },
            onClick: () => {
              keep.input.value = g[0].username;
              sources.input.value = g.slice(1).map((u) => u.username).join(', ');
              preview = null;
              planBox.replaceChildren();
              keep.input.focus();
            },
          }),
        ],
      })),
    }));
    say(`${res.groups.length} group(s) of look-alike names.`);
  });

  mergeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = keep.input.value.trim();
    const src = sourceList();
    if (!target || !src.length) {
      say('Name the account to keep and at least one account to merge into it.', 'error');
      (target ? sources.input : keep.input).focus();
      return;
    }
    const res = await call('planMerge', { target, sources: src });
    if (!res?.ok) return;
    preview = { target, sources: src, planHash: res.planHash };
    renderPlan(res.plan);
    say(res.plan.errors.length ? 'The merge cannot be done: see the errors.' : `Preview ready: ${res.plan.changeCount} change(s).`, res.plan.errors.length ? 'error' : 'info');
  });

  function renderPlan(plan) {
    const out = [heading(`Merge ${plan.sources.join(', ')} into ${plan.target}`)];
    if (plan.errors.length) {
      out.push(el('ul', { className: 'admin-list admin-errors', attrs: { role: 'alert' }, children: plan.errors.map((t) => el('li', { text: t })) }));
      planBox.replaceChildren(...out);
      return;
    }
    const roleLabel = { target: 'Keep', source: 'Merge', result: 'Result' };
    out.push(table(['Role', 'Account', 'Created', 'Games', 'W / L / D', 'Points', 'Note'], plan.accounts.map((a) => el('tr', {
      className: `admin-plan__${a.role}`,
      children: [td(roleLabel[a.role]), td(a.username), td(fmtDay(a.createdAt)), td(a.stats.gamesPlayed, 'is-num'),
        td(`${a.stats.wins} / ${a.stats.losses} / ${a.stats.draws}`, 'is-num'), td(a.stats.totalPoints, 'is-num'), td(a.note || '')],
    })), { caption: 'Accounts in this merge' }));
    if (plan.statChanges.length) {
      out.push(heading('Stats that change'), el('ul', { className: 'admin-list', children: plan.statChanges.map((c) => el('li', { text: `${c.key}: ${c.before} → ${c.after}` })) }));
    }
    const lines = [];
    if (plan.profilePicFrom) lines.push(`Profile photo: copy the custom photo from ${plan.profilePicFrom} (${plan.target} has none).`);
    if (plan.targetBlockedUsers) lines.push(`${plan.target}'s block list: [${plan.targetBlockedUsers.before.join(', ')}] → [${plan.targetBlockedUsers.after.join(', ')}]`);
    lines.push(`Game records to re-point: ${plan.gameRecords.length}`);
    lines.push(`Reports to re-point: ${plan.reports.length}`);
    lines.push(`Other players' block lists to update: ${plan.otherUsersBlocks.length}`);
    if (plan.chainedTombstones.length) lines.push(`Older merged accounts to re-point: ${plan.chainedTombstones.map((t) => `${t.username} (was → ${t.before})`).join(', ')}`);
    lines.push(`Accounts to retire (can't sign in, name stays reserved): ${plan.retire.length ? plan.retire.join(', ') : 'none (already retired)'}`);
    out.push(el('ul', { className: 'admin-list', children: lines.map((t) => el('li', { text: t })) }));
    if (plan.gameRecords.length) {
      const shown = plan.gameRecords.slice(0, 20);
      out.push(el('details', {
        className: 'admin-details',
        children: [
          el('summary', { text: `Game records (${plan.gameRecords.length})` }),
          el('ul', { className: 'admin-list', children: shown.map((r) => el('li', { text: `${fmtDay(r.completedAt)} ${r.gameId}: [${r.before.team1.join(', ')}] vs [${r.before.team2.join(', ')}] → [${r.after.team1.join(', ')}] vs [${r.after.team2.join(', ')}]` })) }),
          plan.gameRecords.length > shown.length ? el('p', { className: 'admin-note', text: `and ${plan.gameRecords.length - shown.length} more` }) : null,
        ],
      }));
    }
    if (plan.reports.length || plan.otherUsersBlocks.length) {
      out.push(el('details', {
        className: 'admin-details',
        children: [
          el('summary', { text: 'Reports and block lists' }),
          el('ul', {
            className: 'admin-list',
            children: [
              ...plan.reports.map((r) => el('li', { text: `Report: reporter ${r.reporter}${r.newReporter ? ` → ${r.newReporter}` : ''}, reported ${r.reported}${r.newReported ? ` → ${r.newReported}` : ''}` })),
              ...plan.otherUsersBlocks.map((u) => el('li', { text: `${u.username} blocks: [${u.before.join(', ')}] → [${u.after.join(', ')}]` })),
            ],
          }),
        ],
      }));
    }
    if (plan.warnings.length) {
      out.push(heading('Warnings'), el('ul', { className: 'admin-list admin-warnings', children: plan.warnings.map((t) => el('li', { text: t })) }));
    }
    out.push(el('p', { className: 'admin-count', text: plan.changeCount === 0 ? 'Nothing to do. This merge is already complete.' : `${plan.changeCount} change(s) planned.` }));

    if (plan.changeCount > 0) {
      const confirmField = field({ id: 'adminMergeConfirm', label: `Type ${plan.target} to confirm`, describedBy: 'adminMergeConfirmNote' });
      const apply = createButton({ label: 'Merge accounts', variant: 'danger', type: 'submit', attrs: { disabled: true } });
      const confirmForm = el('form', {
        className: 'admin-confirm-form',
        children: [
          el('p', { className: 'admin-note', attrs: { id: 'adminMergeConfirmNote' }, text: `This cannot be undone from the panel. The retired accounts are signed out and can no longer sign in; signing in as one of them names ${plan.target}.` }),
          confirmField.wrap, apply,
        ],
      });
      confirmField.input.addEventListener('input', () => {
        apply.disabled = confirmField.input.value !== plan.target;
      });
      confirmForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!preview || confirmField.input.value !== plan.target) return;
        const res = await call('applyMerge', { ...preview, confirm: confirmField.input.value });
        if (!res) return;
        if (!res.ok) {
          // stale_plan: the data changed; server: it may have stopped
          // partway. Either way the preview is spent: preview again (the
          // alert line has announced the message; focus goes to that button)
          if (res.error === 'stale_plan' || res.error === 'server') {
            preview = null;
            planBox.replaceChildren(el('p', { className: 'admin-note', text: res.message }));
            previewBtn.focus();
          }
          return;
        }
        const r = res.result;
        preview = null;
        dupBox.replaceChildren(); // its groups predate the merge
        const merged = heading('Merged', 3, { focusable: true });
        planBox.replaceChildren(merged, el('ul', {
          className: 'admin-list',
          children: [
            `Kept: ${r.target}`,
            `Stats merged from: ${r.statsMerged.join(', ') || '(none)'}`,
            `Retired: ${r.retired.join(', ') || '(none)'}`,
            `Game records: ${r.gameRecords}, reports: ${r.reports}, other block lists: ${r.otherUsersBlocks}`,
            `Signed out: ${r.signedOut} live connection(s)`,
          ].map((t) => el('li', { text: t })),
        }));
        say(`Merged into ${r.target}.`, 'success');
        merged.focus(); // the form that had focus is gone
      });
      out.push(confirmForm);
    }
    planBox.replaceChildren(...out);
  }

  // ---------- Reports ----------
  const reportsPanel = panels.reports;
  const filter = el('select', { className: 'kit-input admin-select', attrs: { id: 'adminReportFilter' }, children: [el('option', { attrs: { value: 'open' }, text: 'Open' }), el('option', { attrs: { value: 'all' }, text: 'All' })] });
  const refresh = createButton({ label: 'Refresh', variant: 'secondary' });
  const reportList = el('div', { className: 'admin-reports', attrs: { id: 'adminReportList' } });
  reportsPanel.append(
    el('div', { className: 'admin-row', children: [el('div', { className: 'field admin-field', children: [el('label', { className: 'field__label', attrs: { for: 'adminReportFilter' }, text: 'Show' }), filter] }), refresh] }),
    reportList,
  );
  async function loadReports() {
    const res = await call('listReports', { status: filter.value });
    if (!res?.ok) return;
    if (!res.reports.length) {
      reportList.replaceChildren(el('p', { className: 'muted-note', text: filter.value === 'open' ? 'No open reports.' : 'No reports.' }));
      return;
    }
    reportList.replaceChildren(...res.reports.map(renderReport));
  }
  function renderReport(r) {
    const card = el('article', { className: 'admin-report kit-panel kit-elev-1', attrs: { 'aria-label': `Report against ${r.reported}` } });
    const who = el('div', { className: 'admin-report__who' });
    who.append(el('span', { text: `${r.reporter} reported ` }));
    who.append(createButton({
      label: r.reported, variant: 'ghost', size: 'sm', attrs: { 'aria-label': `Find ${r.reported}` },
      onClick: () => { select('players', { focus: true }); search.input.value = r.reported; runSearch(r.reported); },
    }));
    who.append(chip(r.status, r.status === 'open' ? 'gold' : 'neutral'));
    card.append(
      el('div', { className: 'admin-report__head', children: [who, el('span', { className: 'admin-note', text: fmtDate(r.createdAt) })] }),
      el('p', { className: 'admin-report__reason', text: r.reason }),
    );
    if (r.context) card.append(el('p', { className: 'admin-report__context', text: r.context }));
    if (r.status !== 'open') {
      card.append(el('p', { className: 'admin-note', text: `${r.status === 'resolved' ? 'Resolved' : 'Dismissed'} by ${r.resolvedBy || '?'} ${fmtDate(r.resolvedAt)}${r.note ? `: ${r.note}` : ''}` }));
      return card;
    }
    const noteId = `adminReportNote-${r.id}`;
    const note = el('textarea', { className: 'kit-input kit-textarea admin-note-input', attrs: { id: noteId, maxlength: '500', rows: '2' } });
    const close = (status) => async () => {
      const res = await call('resolveReport', { id: r.id, status, note: note.value.trim() });
      if (res?.ok) {
        say(`Report ${status}.`, 'success');
        await loadReports();
        refocus(reportList, null, reportsPanel); // the card is gone (or has no buttons now)
      }
    };
    card.append(
      el('div', { className: 'field admin-field', children: [el('label', { className: 'field__label', attrs: { for: noteId }, text: 'Note (optional)' }), note] }),
      el('div', { className: 'admin-row', children: [
        createButton({ label: 'Resolve', variant: 'primary', size: 'sm', onClick: close('resolved') }),
        createButton({ label: 'Dismiss', variant: 'secondary', size: 'sm', onClick: close('dismissed') }),
      ] }),
    );
    return card;
  }
  filter.addEventListener('change', loadReports);
  refresh.addEventListener('click', loadReports);
  loaders.reports = loadReports;

  // ---------- Admins ----------
  const adminsPanel = panels.admins;
  const adminList = el('div', { attrs: { id: 'adminAdminList' } });
  adminsPanel.append(el('p', { className: 'admin-note', text: 'To make someone an admin, find them under Players.' }), adminList);
  async function loadAdmins() {
    const res = await call('listAdmins', {});
    if (!res?.ok) return;
    adminList.replaceChildren(table(['Admin', 'Since', 'Actions'], res.admins.map((a) => el('tr', {
      children: [
        td(a.username + (a.username === username ? ' (you)' : '')),
        td(fmtDay(a.adminSince)),
        td(createButton({
          label: 'Remove admin', variant: 'danger', size: 'sm', attrs: { 'aria-label': `Remove admin: ${a.username}`, 'data-focus-key': `remove:${a.username}` },
          onClick: () => changeAdmin(a.username, false, async () => {
            await loadAdmins();
            refocus(adminList, `remove:${a.username}`, adminsPanel);
          }),
        })),
      ],
    })), { caption: 'Current admins' }));
  }
  loaders.admins = loadAdmins;

  // ---------- Audit ----------
  const auditPanel = panels.audit;
  const auditBody = el('tbody');
  const more = createButton({ label: 'Load more', variant: 'secondary', attrs: { hidden: true } });
  const auditRefresh = createButton({ label: 'Refresh', variant: 'secondary' });
  const auditTable = el('table', {
    className: 'admin-table',
    children: [
      el('caption', { className: 'admin-sr-only', text: 'Admin actions, newest first' }),
      el('thead', { children: [el('tr', { children: ['When', 'Who', 'Action', 'Target', 'Result', 'Detail'].map((h) => el('th', { attrs: { scope: 'col' }, text: h })) })] }),
      auditBody,
    ],
  });
  auditPanel.append(el('div', { className: 'admin-row', children: [auditRefresh] }), auditTable, more);
  let oldest = null; // {at, id} of the last row shown: the page cursor
  async function loadAudit({ append = false } = {}) {
    const res = await call('listAudit', append && oldest ? { before: oldest.at, beforeId: oldest.id, limit: 50 } : { limit: 50 });
    if (!res?.ok) return;
    if (!append) auditBody.replaceChildren();
    for (const e of res.entries) {
      auditBody.appendChild(el('tr', {
        className: `admin-audit--${e.result}`,
        children: [td(fmtDate(e.at)), td(e.actor || '—'), td(e.action), td(e.target || ''), td(e.result), td(e.detail || '')],
      }));
    }
    const lastRow = res.entries[res.entries.length - 1];
    oldest = lastRow ? { at: lastRow.at, id: lastRow.id } : oldest;
    more.hidden = !res.hasMore;
  }
  more.addEventListener('click', () => loadAudit({ append: true }));
  auditRefresh.addEventListener('click', () => loadAudit());
  loaders.audit = () => loadAudit();

  const modal = openModal({
    title: 'Admin',
    closable: true,
    closeLabel: 'Close admin panel',
    id: 'adminPanelOverlay',
    dialogId: 'adminPanelModal',
    className: 'page-modal page-modal--wide admin-modal',
    body: [tablist, statusBox, ...TABS.map(([k]) => panels[k])],
    initialFocus: search.input,
    onClose: () => {
      closed = true;
      adminApi.dispose?.();
      if (current?.modal === modal) current = null;
    },
  });
  current = { modal, api: adminApi };
  select('players');
  search.input.focus();
  return { modal, select, runSearch };
}

/** Close the panel (sign-out, admin removed, leaving the main room). */
export function removeAdminPanel() {
  current?.modal.close('api');
  current = null;
  document.getElementById('adminPanelOverlay')?.remove();
  document.getElementById('adminConfirmDialog')?.closest('.kit-modal-backdrop')?.remove();
}
