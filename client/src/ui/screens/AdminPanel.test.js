/**
 * The admin panel (ui/screens/AdminPanel.js) and its wire (admin/adminApi.js)
 * against a fake server: the menu entry follows the display flag, tabs are
 * keyboard reachable, destructive actions ask first, the reset link is
 * shown once with a Copy button, a merge needs the typed name and sends the
 * previewed plan's hash, and a 'forbidden' answer closes everything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showAdminPanel, removeAdminPanel } from './AdminPanel.js';
import { showMainRoom, removeMainRoom } from './MainRoom.js';
import { createAdminApi, setIsAdmin, isAdmin } from '../../admin/adminApi.js';
import { openModalCount } from '../kit/index.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fake api: answers by action from `handlers`, records every request. */
function fakeApi(handlers) {
  const calls = [];
  return {
    calls,
    disposed: false,
    request: vi.fn(async (action, args) => {
      calls.push([action, args]);
      const h = handlers[action];
      const out = typeof h === 'function' ? h(args) : h;
      return { requestId: 'x', action, ...(out || { ok: true }) };
    }),
    dispose() { this.disposed = true; },
  };
}

const PLAYERS = [
  { username: 'Bea', createdAt: '2026-01-02T00:00:00.000Z', lastSeenAt: '2026-11-10T00:00:00.000Z', online: false, gamesPlayed: 12, botGamesPlayed: 30, isAdmin: false, mergedInto: null },
  { username: 'Owner', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: null, online: true, gamesPlayed: 40, botGamesPlayed: 2, isAdmin: true, mergedInto: null },
  { username: 'Bea2', createdAt: null, lastSeenAt: null, online: false, gamesPlayed: 0, botGamesPlayed: 0, isAdmin: false, mergedInto: 'Bea' },
];

const PLAN = {
  target: 'Bea', sources: ['Bea2'], errors: [], warnings: ['heads up'],
  accounts: [
    { role: 'target', username: 'Bea', createdAt: null, stats: { gamesPlayed: 12, wins: 6, losses: 6, draws: 0, totalPoints: 900 }, botStats: { gamesPlayed: 30, wins: 10, losses: 20, draws: 0, totalPoints: 4000 }, note: null },
    { role: 'source', username: 'Bea2', createdAt: '2026-03-01T00:00:00.000Z', stats: { gamesPlayed: 2, wins: 1, losses: 1, draws: 0, totalPoints: 100 }, botStats: { gamesPlayed: 5, wins: 5, losses: 0, draws: 0, totalPoints: 900 }, note: 'stats will be added' },
    { role: 'result', username: 'Bea', createdAt: null, stats: { gamesPlayed: 14, wins: 7, losses: 7, draws: 0, totalPoints: 1000 }, botStats: { gamesPlayed: 35, wins: 15, losses: 20, draws: 0, totalPoints: 4900 }, note: null },
  ],
  statChanges: [{ key: 'gamesPlayed', before: 12, after: 14 }],
  botStatChanges: [{ key: 'gamesPlayed', before: 30, after: 35 }, { key: 'wins', before: 10, after: 15 }],
  profilePicFrom: null, targetBlockedUsers: null,
  gameRecords: [{ gameId: 'g1', completedAt: '2026-05-01T00:00:00.000Z', before: { team1: ['Bea2', 'x'], team2: ['y', 'z'] }, after: { team1: ['Bea', 'x'], team2: ['y', 'z'] } }],
  reports: [], otherUsersBlocks: [], chainedTombstones: [], retire: ['Bea2'], changeCount: 3,
};
const HASH = 'f'.repeat(64);

let api;
beforeEach(() => {
  document.body.replaceChildren();
  setIsAdmin(true);
  api = fakeApi({
    searchPlayers: { ok: true, players: PLAYERS },
    listPlayers: { ok: true, players: PLAYERS, total: PLAYERS.length, limit: 500 },
    createResetLink: (a) => ({ ok: true, username: a.username, token: 'T'.repeat(43), expiresAt: '2026-11-12T12:00:00.000Z' }),
    signOutEverywhere: (a) => ({ ok: true, username: a.username, revokedSessions: 2, disconnected: 1 }),
    setAdmin: (a) => ({ ok: true, username: a.username, isAdmin: a.isAdmin, changed: true }),
    planMerge: { ok: true, plan: PLAN, planHash: HASH },
    applyMerge: { ok: true, result: { target: 'Bea', statsMerged: ['Bea2'], retired: ['Bea2'], gameRecords: 1, reports: 0, otherUsersBlocks: 0, chainedTombstones: 0, profilePic: false, signedOut: 0 } },
    findDuplicates: { ok: true, groups: [[{ username: 'Bea', gamesPlayed: 12, botGamesPlayed: 3, createdAt: null }, { username: 'bea2', gamesPlayed: 1, botGamesPlayed: 0, createdAt: null }]] },
    listReports: { ok: true, reports: [{ id: 'a'.repeat(24), reporter: 'Bea', reported: 'Owner', reason: 'rude', context: 'chat line', createdAt: '2026-11-11T00:00:00.000Z', status: 'open', resolvedBy: null, resolvedAt: null, note: null }] },
    resolveReport: { ok: true, report: {} },
    listAdmins: { ok: true, admins: [{ username: 'Owner', adminSince: null }, { username: 'Bea', adminSince: null }] },
    listAudit: (a) => ({ ok: true, entries: [{ id: '1', at: '2026-11-11T00:00:00.000Z', actor: 'Owner', action: 'searchPlayers', target: null, result: 'ok', detail: a.before ? 'older' : 'newest' }], hasMore: !a.before }),
  });
});
afterEach(() => {
  removeAdminPanel();
  removeMainRoom();
  document.body.replaceChildren();
});

const $ = (sel) => document.querySelector(sel);
const byText = (text, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
const typeInto = (input, value) => {
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

/** Open the panel: the Players tab loads the table. */
async function openPlayers() {
  showAdminPanel(null, { username: 'Owner', api });
  await flush();
}
const tableRows = () => [...document.querySelectorAll('#adminPlayerTable tbody tr')];
const rowOf = (name) => tableRows().find((r) => r.querySelector('.admin-name span')?.textContent === name);
const namesShown = () => tableRows().map((r) => r.querySelector('.admin-name span').textContent);
const menuButton = (name) => rowOf(name).querySelector('[aria-haspopup="menu"]');
const menuItems = (name) => [...rowOf(name).querySelectorAll('[role="menuitem"]')];
/** Open a row's More menu and pick an item by its text. */
async function menuPick(name, label) {
  const b = menuButton(name);
  b.focus();
  b.click();
  const item = menuItems(name).find((i) => i.textContent === label);
  expect(item, `menu item ${label}`).toBeTruthy();
  item.click();
  await flush();
}
const keyOn = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('the main room\'s Admin entry', () => {
  const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  it('shows for an admin, hides for anyone else, follows the flag', () => {
    setIsAdmin(false);
    showMainRoom({ onlineCount: 1 }, socket, 'Bea');
    expect($('#mainRoomAdminButton').hidden).toBe(true);
    setIsAdmin(true);
    expect($('#mainRoomAdminButton').hidden).toBe(false);
    removeMainRoom();
    showMainRoom({ onlineCount: 1 }, socket, 'Owner');
    expect($('#mainRoomAdminButton').hidden).toBe(false);
    setIsAdmin(false);
    expect($('#mainRoomAdminButton').hidden).toBe(true);
  });
});

describe('the panel', () => {
  it('a labelled modal with five keyboard tabs; the filter field has focus', () => {
    showAdminPanel(null, { username: 'Owner', api });
    const dialog = $('#adminPanelModal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Players', 'Merge', 'Reports', 'Admins', 'Audit']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement.id).toBe('adminPlayerFilter');
    expect($('label[for="adminPlayerFilter"]').textContent).toBe('Filter by name');
    tabs[0].focus();
    const key = (k) => $('[role="tablist"]').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    // Manual activation: arrows move focus only, Enter / Space (click) opens
    key('ArrowRight');
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect($('#adminPanel-players').hidden).toBe(false);
    tabs[1].click();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect($('#adminPanel-merge').hidden).toBe(false);
    expect($('#adminPanel-players').hidden).toBe(true);
    key('End');
    expect(document.activeElement).toBe(tabs[4]);
    expect(api.calls.map((c) => c[0])).not.toContain('listAudit');
    tabs[4].click();
    expect(api.calls.map((c) => c[0])).toContain('listAudit');
  });

  it('holding an arrow key on the tabs sends no requests (the server rate-limits them)', () => {
    showAdminPanel(null, { username: 'Owner', api });
    $('#adminTab-players').focus();
    for (let i = 0; i < 30; i++) {
      $('[role="tablist"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    }
    expect(api.calls).toEqual([['listPlayers', {}]]); // only the Players tab's own load on opening
    expect(document.activeElement.getAttribute('role')).toBe('tab');
  });

  it('the players table: every account newest first, created / last seen / games / admin / merged, actions per row', async () => {
    await openPlayers();
    expect(api.calls[0]).toEqual(['listPlayers', {}]);
    // newest first (an unknown creation date last)
    expect(namesShown()).toEqual(['Bea', 'Owner', 'Bea2']);
    const heads = [...document.querySelectorAll('#adminPlayerTable thead th')].map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
    expect(heads).toEqual(['Player', 'Created', 'Last seen', 'Games', 'Bot games', 'Admin', 'Merged', 'Actions']);
    expect($('#adminPlayerTable th[aria-sort]').textContent).toMatch(/Created/);
    expect($('#adminPlayerTable th[aria-sort]').getAttribute('aria-sort')).toBe('descending');
    expect(rowOf('Owner').textContent).toMatch(/Owner.*you.*online/);
    expect(rowOf('Owner').children[2].textContent).toBe('now');
    expect(rowOf('Owner').children[5].textContent).toBe('admin');
    expect(rowOf('Bea').children[3].textContent).toBe('12');
    // games with bots, a separate column (Games stays human games)
    expect(rowOf('Bea').children[4].textContent).toBe('30');
    expect(rowOf('Bea').children[6].textContent).toBe('—');
    // a tombstone: marked, no reset link and no account menu, only what applies
    const tomb = rowOf('Bea2');
    expect(tomb.children[6].textContent).toBe('into Bea');
    expect(tomb.children[3].textContent).toBe('—');
    expect(tomb.children[4].textContent).toBe('—');
    expect(byText('Reset link', tomb)).toBeUndefined();
    expect(tomb.querySelector('[aria-haspopup="menu"]')).toBeNull();
    // live accounts: a reset link and a More menu; destructive items last, after a separator, in the danger style
    expect(byText('Reset link', rowOf('Bea'))).toBeTruthy();
    expect(menuItems('Bea').map((i) => i.textContent)).toEqual(['Rename…', 'Make admin…', 'Sign out everywhere…', 'Delete account…']);
    expect(menuItems('Owner').map((i) => i.textContent)).toEqual(['Rename…', 'Sign out everywhere…', 'Remove admin…', 'Delete account…']);
    expect(menuItems('Bea').map((i) => i.classList.contains('admin-menu__item--danger'))).toEqual([false, false, true, true]);
    // a tombstone's own action: delete the old name (a quiet button, not a filled red one)
    expect(byText('Delete…', tomb)).toBeTruthy();
    expect(rowOf('Bea').querySelector('[role="menu"] [role="separator"]')).toBeTruthy();
    // no button in a row is the filled red one: the destructive actions are not the most prominent control
    expect(document.querySelectorAll('#adminPlayerTable .kit-btn--danger')).toHaveLength(0);
    expect($('#adminStatus').textContent).toBe(''); // opening is quiet: the count line says it
    expect($('#adminPlayersCount').textContent).toBe('3 accounts.');
    // the tombstone's one shortcut: show the kept account
    byText('Show Bea', tomb).click();
    expect($('#adminPlayerFilter').value).toBe('Bea');
    expect(namesShown()).toEqual(['Bea', 'Bea2']);
    expect(document.activeElement).toBe($('#adminPlayerFilter'));
  });

  it('sorting: a header button sorts by its column, again reverses it, aria-sort follows, focus stays on the header', async () => {
    await openPlayers();
    const sortBtn = (key) => $(`#adminPlayerTable [data-sort-key="${key}"]`);
    sortBtn('gamesPlayed').click();
    expect(namesShown()).toEqual(['Owner', 'Bea', 'Bea2']); // most games first; a tombstone (no games) last
    expect(sortBtn('gamesPlayed').closest('th').getAttribute('aria-sort')).toBe('descending');
    expect(document.activeElement).toBe(sortBtn('gamesPlayed'));
    expect(document.querySelectorAll('#adminPlayerTable th[aria-sort]')).toHaveLength(1);
    sortBtn('gamesPlayed').click();
    expect(namesShown()).toEqual(['Bea', 'Owner', 'Bea2']);
    expect(sortBtn('gamesPlayed').closest('th').getAttribute('aria-sort')).toBe('ascending');
    sortBtn('botGamesPlayed').click();
    expect(namesShown()).toEqual(['Bea', 'Owner', 'Bea2']); // most bot games first; a tombstone last
    expect(sortBtn('botGamesPlayed').closest('th').getAttribute('aria-sort')).toBe('descending');
    sortBtn('username').click();
    expect(namesShown()).toEqual(['Bea', 'Bea2', 'Owner']);
    sortBtn('isAdmin').click();
    expect(namesShown()[0]).toBe('Owner');
    sortBtn('mergedInto').click();
    expect(namesShown()[0]).toBe('Bea2');
    sortBtn('lastSeenAt').click();
    expect(namesShown()).toEqual(['Owner', 'Bea', 'Bea2']); // online now, then the latest seen
    // keyboard: the header is a real button
    expect(sortBtn('createdAt').tagName).toBe('BUTTON');
  });

  it('the filter narrows the table as you type (no Search button), names and merged-into both match; the count is announced once typing pauses', async () => {
    await openPlayers();
    expect(byText('Search')).toBeUndefined();
    typeInto($('#adminPlayerFilter'), 'own');
    expect(namesShown()).toEqual(['Owner']);
    expect($('#adminPlayersCount').textContent).toBe('1 of 3 accounts match "own".');
    expect($('#adminPlayerFilter').getAttribute('aria-describedby')).toBe('adminPlayersCount');
    expect(document.activeElement).toBe($('#adminPlayerFilter'));
    typeInto($('#adminPlayerFilter'), 'BEA');
    expect(namesShown()).toEqual(['Bea', 'Bea2']);
    typeInto($('#adminPlayerFilter'), 'zzz');
    expect(namesShown()).toEqual([]);
    expect($('#adminPlayerTable').textContent).toMatch(/No account matches the filter/);
    await new Promise((r) => setTimeout(r, 650));
    expect($('#adminStatus').textContent).toBe('0 of 3 accounts match "zzz".');
    typeInto($('#adminPlayerFilter'), '');
    expect(namesShown()).toHaveLength(3);
    expect(api.calls.filter((c) => c[0] !== 'listPlayers')).toEqual([]); // filtering asks the server nothing
  });

  it('a capped list says so above the table', async () => {
    api = fakeApi({ listPlayers: { ok: true, players: PLAYERS, total: 812, limit: 3 } });
    await openPlayers();
    expect($('#adminPlayersCap').hidden).toBe(false);
    expect($('#adminPlayersCap').textContent).toBe('Showing the newest 3 of 812 accounts. Sorting and the filter cover only these.');
    removeAdminPanel();
    api = fakeApi({ listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 } });
    await openPlayers();
    expect($('#adminPlayersCap').hidden).toBe(true);
  });

  it('the More menu: a menu button; arrows move, Escape closes it (not the panel) and refocuses the button, a click elsewhere closes it', async () => {
    await openPlayers();
    const b = menuButton('Bea');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-label')).toBe('More actions: Bea');
    const menu = document.getElementById(b.getAttribute('aria-controls'));
    expect(menu.getAttribute('role')).toBe('menu');
    expect(menu.hidden).toBe(true);
    b.focus();
    keyOn(b, 'ArrowDown');
    expect(menu.hidden).toBe(false);
    expect(b.getAttribute('aria-expanded')).toBe('true');
    const items = menuItems('Bea');
    const lastItem = items[items.length - 1];
    expect(items.length).toBe(4);
    expect(document.activeElement).toBe(items[0]);
    for (let i = 1; i < items.length; i++) {
      keyOn(items[i - 1], 'ArrowDown');
      expect(document.activeElement).toBe(items[i]);
    }
    keyOn(lastItem, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]); // wraps
    keyOn(items[0], 'ArrowUp');
    expect(document.activeElement).toBe(lastItem);
    keyOn(lastItem, 'Home');
    expect(document.activeElement).toBe(items[0]);
    keyOn(items[0], 'End');
    expect(document.activeElement).toBe(lastItem);
    keyOn(lastItem, 'Home');
    expect(document.activeElement).toBe(items[0]);
    // ArrowUp on the closed button opens it on the last item
    keyOn(items[0], 'Escape');
    keyOn(b, 'ArrowUp');
    expect(document.activeElement).toBe(lastItem);
    keyOn(items[0], 'Escape');
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(b);
    expect($('#adminPanelModal')).not.toBeNull(); // Escape closed the menu only
    // one menu at a time; a click outside closes it
    b.click();
    menuButton('Owner').click();
    expect(menu.hidden).toBe(true);
    expect(menuButton('Owner').getAttribute('aria-expanded')).toBe('true');
    $('#adminPlayersCount').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menuButton('Owner').getAttribute('aria-expanded')).toBe('false');
    // items are not in the tab order; the button is
    expect(items.every((i) => i.tabIndex === -1)).toBe(true);
  });

  it('delete account: a dialog that says what happens, the name typed exactly, then the request; the table reloads and focus lands on the filter', async () => {
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      deleteAccount: (a) => ({ ok: true, username: a.username, kind: 'account', mergedInto: null, gameRecords: 4, reports: 1, blockLists: 1, resetLinks: 0, tombstones: 1, signedOut: 2 }),
    });
    await openPlayers();
    await menuPick('Bea', 'Delete account…');
    const dialog = $('#adminConfirmDialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.textContent).toMatch(/Delete Bea\?/);
    expect(dialog.textContent).toMatch(/cannot be undone/);
    expect(dialog.textContent).toMatch(/\[deleted\] in past games/);
    expect(dialog.textContent).toMatch(/keeps reports by or about them, marked deleted/);
    expect(dialog.textContent).toMatch(/frees the name Bea/);
    const typed = $('#adminDialogConfirm');
    expect($('label[for="adminDialogConfirm"]').textContent).toBe('Type Bea to confirm');
    expect(document.activeElement).toBe(typed);
    const yes = $('#adminConfirmDialog [data-confirm="yes"]');
    expect(yes.textContent).toBe('Delete account');
    expect(yes.disabled).toBe(true);
    typeInto(typed, 'bea');
    expect(yes.disabled).toBe(true); // exactly, case included
    typeInto(typed, 'Bea');
    expect(yes.disabled).toBe(false);
    yes.click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'deleteAccount')).toEqual([['deleteAccount', { username: 'Bea', confirm: 'Bea' }]]);
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminStatus').textContent).toBe('Bea is deleted: 4 game record update(s) to [deleted], 1 report(s) marked, 2 live connection(s) closed.');
    expect(api.calls.filter((c) => c[0] === 'listPlayers')).toHaveLength(2);
    expect(document.activeElement).toBe($('#adminPlayerFilter'));
  });

  it('delete account: Cancel and Escape send nothing and give focus back; a refusal stays in the dialog', async () => {
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      deleteAccount: { ok: false, error: 'refused', message: '"Bea" is in a game right now. Wait until it finishes and delete again.' },
    });
    await openPlayers();
    await menuPick('Bea', 'Delete account…');
    byText('Cancel', $('#adminConfirmDialog')).click();
    await flush();
    expect($('#adminConfirmDialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton('Bea'));
    await menuPick('Bea', 'Delete account…');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminPanelModal')).not.toBeNull(); // only the dialog closed
    expect(api.calls.filter((c) => c[0] === 'deleteAccount')).toEqual([]);
    await menuPick('Bea', 'Delete account…');
    typeInto($('#adminDialogConfirm'), 'Bea');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminConfirmDialog')).not.toBeNull();
    expect($('#adminDialogAlert').textContent).toMatch(/is in a game right now/);
    expect($('#adminDialogAlert').getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe($('#adminDialogConfirm'));
  });

  it('delete account: an admin or yourself is explained without a dialog (the server refuses them too)', async () => {
    await openPlayers();
    await menuPick('Owner', 'Delete account…');
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminAlert').textContent).toMatch(/your own account, use Delete account on your profile/);
    api = fakeApi({ listPlayers: { ok: true, players: [{ ...PLAYERS[0], isAdmin: true }], total: 1, limit: 500 } });
    removeAdminPanel();
    await openPlayers();
    await menuPick('Bea', 'Delete account…');
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminAlert').textContent).toBe('Bea is an admin. Remove their admin first, then delete the account.');
    expect(api.calls.filter((c) => c[0] === 'deleteAccount')).toEqual([]);
  });

  it('rename: old → new shown as you type, the new name typed again to confirm, then the request; a refusal stays in the dialog', async () => {
    let answer = { ok: false, error: 'refused', message: 'That name is taken: "Bee" already exists, and capital letters don\'t make a different name.' };
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      renameAccount: () => answer,
    });
    await openPlayers();
    await menuPick('Bea', 'Rename…');
    const dialog = $('#adminConfirmDialog');
    expect(dialog.textContent).toMatch(/Rename Bea/);
    expect(dialog.textContent).toMatch(/signed out everywhere/);
    expect(dialog.textContent).toMatch(/same password/);
    expect(dialog.textContent).toMatch(/any open reset link is cancelled/);
    expect(dialog.textContent).toMatch(/Bea stays as a reserved old name\. Signing in with it and the account's password tells them the new name; nobody else is told it/);
    expect($('label[for="adminRenameNew"]').textContent).toBe('New name');
    expect($('#adminRenameNew').getAttribute('aria-describedby')).toBe('adminRenameRules');
    expect($('#adminRenameRules').textContent).toMatch(/3 to 20 letters/);
    expect(document.activeElement).toBe($('#adminRenameNew'));
    const yes = $('#adminConfirmDialog [data-confirm="yes"]');
    expect(yes.textContent).toBe('Rename');
    expect(yes.disabled).toBe(true);
    typeInto($('#adminRenameNew'), ' Bee ');
    expect($('#adminRenameSummary .admin-rename__old').textContent).toBe('Bea');
    expect($('#adminRenameSummary .admin-sr-only').textContent).toBe(' becomes '); // the arrow is aria-hidden
    expect($('#adminRenameSummary .admin-rename__new').textContent).toBe('Bee');
    expect(yes.disabled).toBe(true);
    typeInto($('#adminRenameConfirm'), 'bee');
    expect(yes.disabled).toBe(true);
    typeInto($('#adminRenameConfirm'), 'Bee');
    expect(yes.disabled).toBe(false);
    yes.click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'renameAccount')).toEqual([['renameAccount', { username: 'Bea', newName: 'Bee', confirm: 'Bee' }]]);
    expect($('#adminConfirmDialog')).not.toBeNull();
    expect($('#adminDialogAlert').textContent).toMatch(/That name is taken/);
    expect(document.activeElement).toBe($('#adminRenameNew'));
    // the same name is never sendable
    typeInto($('#adminRenameNew'), 'Bea');
    typeInto($('#adminRenameConfirm'), 'Bea');
    expect(yes.disabled).toBe(true);
    answer = { ok: true, username: 'Bea', newName: 'Beatrix', resumed: false, oldNameKept: true, gameRecords: 3, reports: 0, otherUsersBlocks: 1, chainedTombstones: 1, adminSetBy: 0, resetLinks: 0, revokedSessions: 2, signedOut: 1 };
    typeInto($('#adminRenameNew'), 'Beatrix');
    typeInto($('#adminRenameConfirm'), 'Beatrix');
    yes.click();
    await flush();
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminStatus').textContent).toBe('Bea is now called Beatrix: 1 live connection(s) signed out; they sign in again as Beatrix with the same password.');
  });

  it('a rename\'s old name is marked "renamed to X" (a merged one "into X")', async () => {
    api = fakeApi({ listPlayers: { ok: true, players: [PLAYERS[0], { ...PLAYERS[2], username: 'Bee', renamed: true }, PLAYERS[2]], total: 3, limit: 500 } });
    await openPlayers();
    expect(rowOf('Bee').children[6].textContent).toBe('renamed to Bea');
    expect(rowOf('Bea2').children[6].textContent).toBe('into Bea');
    expect(rowOf('Bee').querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(byText('Delete…', rowOf('Bee'))).toBeTruthy();
  });

  it('delete a tombstone: only the old name, the kept account named as unchanged', async () => {
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      deleteAccount: (a) => ({ ok: true, username: a.username, kind: 'tombstone', mergedInto: 'Bea', gameRecords: 0, reports: 0, blockLists: 0, resetLinks: 0, tombstones: 0, signedOut: 0 }),
    });
    await openPlayers();
    byText('Delete…', rowOf('Bea2')).click();
    await flush();
    expect($('#adminConfirmDialog').textContent).toMatch(/Delete the old name Bea2\?/);
    expect($('#adminConfirmDialog').textContent).toMatch(/Bea is not changed/);
    typeInto($('#adminDialogConfirm'), 'Bea2');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'deleteAccount')).toEqual([['deleteAccount', { username: 'Bea2', confirm: 'Bea2' }]]);
    expect($('#adminStatus').textContent).toBe('The old name Bea2 is deleted and free again. Bea is unchanged.');
  });

  it('reset link: shown once in a labelled field with Copy, the /reset#token URL', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openPlayers();
    byText('Reset link', rowOf('Bea')).click();
    await flush();
    const input = $('#adminResetLinkInput');
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(`${window.location.origin}/reset#${'T'.repeat(43)}`);
    expect($('label[for="adminResetLinkInput"]').textContent).toBe('Reset link for Bea');
    expect($('#adminResetLinkNote').textContent).toMatch(/Shown once/);
    byText('Copy', $('#adminResetLink')).click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(input.value);
    expect($('#adminStatus').textContent).toBe('Link copied. Text it to the player.');
    byText('Done', $('#adminResetLink')).click();
    expect($('#adminResetLink').hidden).toBe(true);
    expect($('#adminResetLinkInput')).toBeNull(); // gone, not just hidden
  });

  it('sign out everywhere asks first: Cancel sends nothing, confirm sends it', async () => {
    await openPlayers();
    await menuPick('Bea', 'Sign out everywhere…');
    expect($('#adminConfirmDialog').textContent).toMatch(/Sign Bea out everywhere\?/);
    expect(document.activeElement.textContent).toBe('Cancel'); // the safe choice has focus
    byText('Cancel', $('#adminConfirmDialog')).click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'signOutEverywhere')).toEqual([]);
    expect(document.activeElement).toBe(menuButton('Bea')); // back where it came from
    await menuPick('Bea', 'Sign out everywhere…');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'signOutEverywhere')).toEqual([['signOutEverywhere', { username: 'Bea' }]]);
    expect($('#adminStatus').textContent).toMatch(/Bea is signed out: 2 saved session\(s\) revoked, 1 live connection/);
  });

  it('remove admin asks first; removing yourself closes the panel and the entry', async () => {
    await openPlayers();
    await menuPick('Owner', 'Remove admin…');
    expect($('#adminConfirmDialog').textContent).toMatch(/lose access/);
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'setAdmin')).toEqual([['setAdmin', { username: 'Owner', isAdmin: false }]]);
    expect(isAdmin()).toBe(false);
    expect($('#adminPanelModal')).toBeNull();
    expect(openModalCount()).toBe(0);
  });

  it('merge: preview renders the plan, apply needs the exact typed name and sends the previewed hash', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Merge').click();
    typeInto($('#adminMergeKeep'), 'Bea');
    typeInto($('#adminMergeSources'), 'Bea2, Bea2 ,');
    byText('Preview merge').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.calls.pop()).toEqual(['planMerge', { target: 'Bea', sources: ['Bea2'] }]);
    const plan = $('#adminMergePlan');
    expect(plan.textContent).toMatch(/Merge Bea2 into Bea/);
    expect(plan.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(plan.textContent).toMatch(/gamesPlayed: 12 → 14/);
    // the bot-game bucket: a column per account and its own change list
    expect([...plan.querySelectorAll('thead th')].map((th) => th.textContent)).toContain('Bot games');
    expect([...plan.querySelectorAll('tbody tr')].map((tr) => tr.children[6].textContent)).toEqual(['30', '5', '35']);
    expect(plan.textContent).toMatch(/Bot-game stats that change/);
    expect(plan.textContent).toMatch(/wins: 10 → 15/);
    expect(plan.textContent).toMatch(/Game records to re-point: 1/);
    expect(plan.textContent).toMatch(/Accounts to retire .*: Bea2/);
    expect(plan.textContent).toMatch(/heads up/);
    expect(plan.textContent).toMatch(/3 change\(s\) planned\./);
    const confirm = $('#adminMergeConfirm');
    expect($('label[for="adminMergeConfirm"]').textContent).toBe('Type Bea to confirm');
    expect(confirm.getAttribute('aria-describedby')).toBe('adminMergeConfirmNote');
    const apply = byText('Merge accounts');
    expect(apply.disabled).toBe(true);
    typeInto(confirm, 'bea');
    expect(apply.disabled).toBe(true);
    typeInto(confirm, 'Bea');
    expect(apply.disabled).toBe(false);
    apply.closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.calls.pop()).toEqual(['applyMerge', { target: 'Bea', sources: ['Bea2'], planHash: HASH, confirm: 'Bea' }]);
    expect(plan.textContent).toMatch(/Retired: Bea2/);
  });

  it('merge: a stale preview is refused and cleared; editing the names drops the preview', async () => {
    api = fakeApi({
      planMerge: { ok: true, plan: PLAN, planHash: HASH },
      applyMerge: { ok: false, error: 'stale_plan', message: 'These accounts changed since the preview. Preview again before merging.' },
    });
    showAdminPanel(null, { username: 'Owner', api });
    byText('Merge').click();
    typeInto($('#adminMergeKeep'), 'Bea');
    typeInto($('#adminMergeSources'), 'Bea2');
    byText('Preview merge').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    typeInto($('#adminMergeConfirm'), 'Bea');
    byText('Merge accounts').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect($('#adminMergePlan').textContent).toMatch(/changed since the preview/);
    expect(byText('Merge accounts')).toBeUndefined();
    byText('Preview merge').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    typeInto($('#adminMergeSources'), 'Bea3');
    expect($('#adminMergePlan').textContent).toBe('The names changed: preview again.');
  });

  it('merge: look-alike groups fill the fields', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Merge').click();
    byText('Find look-alike names').click();
    await flush();
    expect($('#adminDuplicates li span').textContent).toBe('Bea (12 games, 3 bot), bea2 (1 games, 0 bot)');
    $('#adminDuplicates button').click();
    expect($('#adminMergeKeep').value).toBe('Bea');
    expect($('#adminMergeSources').value).toBe('bea2');
  });

  it('reports: open first, resolve with the note, the reported name opens the players table filtered to them', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Reports').click();
    await flush();
    const card = $('#adminReportList article');
    expect(card.textContent).toMatch(/Bea reported Owner.*open/);
    expect(card.textContent).not.toMatch(/deleted/);
    expect(card.textContent).toMatch(/rude/);
    const note = card.querySelector('textarea');
    expect($(`label[for="${note.id}"]`).textContent).toBe('Note (optional)');
    note.value = ' warned ';
    byText('Resolve', card).click();
    await flush();
    expect(api.calls.find((c) => c[0] === 'resolveReport')).toEqual(['resolveReport', { id: 'a'.repeat(24), status: 'resolved', note: 'warned' }]);
    byText('Owner', $('#adminReportList')).click();
    await flush();
    expect($('#adminTab-players').getAttribute('aria-selected')).toBe('true');
    expect(api.calls.pop()).toEqual(['listPlayers', {}]);
    expect($('#adminPlayerFilter').value).toBe('Owner');
    expect(namesShown()).toEqual(['Owner']);
  });

  it('audit: newest first, Load more pages back', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Audit').click();
    await flush();
    expect($('#adminPanel-audit tbody').textContent).toMatch(/newest/);
    byText('Load more').click();
    await flush();
    // the cursor is (at, id) of the last row, so same-millisecond entries are not skipped
    expect(api.calls.pop()).toEqual(['listAudit', { before: '2026-11-11T00:00:00.000Z', beforeId: '1', limit: 50 }]);
    expect($('#adminPanel-audit tbody').children).toHaveLength(2);
    expect(byText('Load more').hidden).toBe(true);
  });

  it('a forbidden answer (admin access gone) closes the panel and hides the entry', async () => {
    api = fakeApi({ listPlayers: { ok: false, error: 'forbidden', message: 'Not available.' } });
    await openPlayers();
    expect($('#adminPanelModal')).toBeNull();
    expect(isAdmin()).toBe(false);
    expect(api.disposed).toBe(true);
  });

  it('every name goes in as text, never markup', async () => {
    api = fakeApi({ listPlayers: { ok: true, players: [{ ...PLAYERS[0], username: '<img src=x onerror=alert(1)>' }, { ...PLAYERS[2], mergedInto: '<b>x</b>' }], total: 2, limit: 500 } });
    await openPlayers();
    expect(document.querySelector('#adminPlayerTable img, #adminPlayerTable b')).toBeNull();
    expect($('#adminPlayerTable').textContent).toContain('<img src=x onerror=alert(1)>');
    expect($('#adminPlayerTable').textContent).toContain('into <b>x</b>');
  });
});

describe('review fixes (batch 2 findings)', () => {
  /** An api whose `action` answers only when release(answer) is called. */
  function heldApi(action, extra = {}) {
    let release;
    const answered = new Promise((r) => { release = r; });
    const a = fakeApi({ listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 }, ...extra });
    const plain = a.request;
    a.request = vi.fn(async (act, args) => {
      if (act !== action) return plain(act, args);
      a.calls.push([act, args]);
      return { requestId: 'x', action: act, ...(await answered) };
    });
    return { api: a, release };
  }

  it('STALE-LINK: a reset link box goes away when that player is renamed, deleted or signed out everywhere (each cancels it)', async () => {
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      createResetLink: (a) => ({ ok: true, username: a.username, token: 'T'.repeat(43), expiresAt: '2026-11-12T12:00:00.000Z' }),
      renameAccount: (a) => ({ ok: true, username: a.username, newName: a.newName, resumed: false, oldNameKept: true, gameRecords: 0, reports: 0, otherUsersBlocks: 0, chainedTombstones: 0, adminSetBy: 0, resetLinks: 1, revokedSessions: 0, signedOut: 0 }),
      deleteAccount: (a) => ({ ok: true, username: a.username, kind: 'account', mergedInto: null, gameRecords: 0, reports: 0, blockLists: 0, resetLinks: 1, tombstones: 0, signedOut: 0 }),
      signOutEverywhere: (a) => ({ ok: true, username: a.username, revokedSessions: 0, disconnected: 0 }),
    });
    await openPlayers();
    const makeLink = async () => {
      byText('Reset link', rowOf('Bea')).click();
      await flush();
      expect($('#adminResetLink').hidden).toBe(false);
    };
    await makeLink();
    await menuPick('Bea', 'Rename…');
    typeInto($('#adminRenameNew'), 'Bee');
    typeInto($('#adminRenameConfirm'), 'Bee');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminResetLink').hidden).toBe(true);
    expect($('#adminResetLinkInput')).toBeNull();
    await makeLink();
    await menuPick('Bea', 'Delete account…');
    typeInto($('#adminDialogConfirm'), 'Bea');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminResetLink').hidden).toBe(true);
    await makeLink();
    await menuPick('Bea', 'Sign out everywhere…');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminResetLink').hidden).toBe(true);
  });

  it('INFLIGHT-CANCEL: while a delete is in flight the dialog cannot be dismissed; its answer still reaches the panel (message, reload)', async () => {
    const held = heldApi('deleteAccount');
    api = held.api;
    await openPlayers();
    await menuPick('Bea', 'Delete account…');
    typeInto($('#adminDialogConfirm'), 'Bea');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    const cancel = byText('Cancel', $('#adminConfirmDialog'));
    expect(cancel.disabled).toBe(true);
    cancel.click();
    keyOn(document.activeElement || document.body, 'Escape');
    const backdrop = $('#adminConfirmDialog').parentElement;
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flush();
    expect($('#adminConfirmDialog')).not.toBeNull();
    held.release({ ok: true, username: 'Bea', kind: 'account', mergedInto: null, gameRecords: 1, reports: 0, blockLists: 0, resetLinks: 0, tombstones: 0, signedOut: 1 });
    await flush();
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminStatus').textContent).toMatch(/^Bea is deleted/);
    expect(api.calls.filter((c) => c[0] === 'listPlayers')).toHaveLength(2);
    // after the answer the dialog is dismissible again
    await menuPick('Bea', 'Delete account…');
    keyOn(document.activeElement, 'Escape');
    await flush();
    expect($('#adminConfirmDialog')).toBeNull();
  });

  it('DOUBLE-ALERT: a refusal inside a dialog is announced once, in the dialog; nothing stale stays above the table', async () => {
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      renameAccount: { ok: false, error: 'refused', message: 'That name is taken.' },
      deleteAccount: { ok: false, error: 'refused', message: '"Bea" is in a game right now.' },
    });
    await openPlayers();
    await menuPick('Bea', 'Rename…');
    typeInto($('#adminRenameNew'), 'Bee');
    typeInto($('#adminRenameConfirm'), 'Bee');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminDialogAlert').textContent).toBe('That name is taken.');
    expect($('#adminAlert').textContent).toBe('');
    byText('Cancel', $('#adminConfirmDialog')).click();
    await menuPick('Bea', 'Delete account…');
    typeInto($('#adminDialogConfirm'), 'Bea');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminDialogAlert').textContent).toMatch(/in a game right now/);
    expect($('#adminAlert').textContent).toBe('');
  });

  it('RN-RESUME: an account whose rename stopped partway is marked and offers Finish rename, which sends the same rename again', async () => {
    const renamed = { ...PLAYERS[0], username: 'Bee', renameUnfinished: 'Bea' };
    api = fakeApi({
      listPlayers: { ok: true, players: [renamed, PLAYERS[1]], total: 2, limit: 500 },
      renameAccount: (a) => ({ ok: true, username: a.username, newName: a.newName, resumed: true, oldNameKept: true, gameRecords: 3, reports: 1, otherUsersBlocks: 1, chainedTombstones: 0, adminSetBy: 0, resetLinks: 0, revokedSessions: 0, signedOut: 0 }),
    });
    await openPlayers();
    expect(rowOf('Bee').textContent).toMatch(/rename unfinished/);
    expect(byText('Finish rename', rowOf('Owner'))).toBeUndefined();
    const finish = byText('Finish rename', rowOf('Bee'));
    expect(finish.getAttribute('aria-label')).toBe('Finish rename: Bea to Bee');
    finish.click();
    await flush();
    expect($('#adminConfirmDialog').textContent).toMatch(/Finish renaming Bea to Bee\?/);
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'renameAccount')).toEqual([['renameAccount', { username: 'Bea', newName: 'Bee', confirm: 'Bee' }]]);
    expect($('#adminStatus').textContent).toMatch(/^The rename of Bea to Bee is finished: 3 game record update/);
    expect(api.calls.filter((c) => c[0] === 'listPlayers')).toHaveLength(2);
  });

  it('RN-RESUME: a rename that stopped partway reloads the table when its dialog is cancelled (its row now offers Finish rename)', async () => {
    api = fakeApi({
      listPlayers: { ok: true, players: PLAYERS, total: 3, limit: 500 },
      renameAccount: { ok: false, error: 'server', message: '"Bea" is now called "Bee" (signed out everywhere), but updating its games, reports and block lists stopped partway. Rename Bea to Bee again to finish.' },
    });
    await openPlayers();
    await menuPick('Bea', 'Rename…');
    typeInto($('#adminRenameNew'), 'Bee');
    typeInto($('#adminRenameConfirm'), 'Bee');
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect($('#adminDialogAlert').textContent).toMatch(/again to finish/);
    byText('Cancel', $('#adminConfirmDialog')).click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'listPlayers')).toHaveLength(2);
  });

  it('REN-SELF: renaming your own account is explained without a dialog (the server refuses it too)', async () => {
    await openPlayers();
    await menuPick('Owner', 'Rename…');
    expect($('#adminConfirmDialog')).toBeNull();
    expect($('#adminAlert').textContent).toMatch(/cannot rename your own account here/);
    expect(api.calls.filter((c) => c[0] === 'renameAccount')).toEqual([]);
  });
});

describe('focus after an action redraws its list', () => {
  const inDialog = () => Boolean(document.activeElement && $('#adminPanelModal')?.contains(document.activeElement));
  const confirmYes = async () => {
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
  };

  it('sign out everywhere: focus returns to that row\'s More button in the new table', async () => {
    await openPlayers();
    const before = menuButton('Bea');
    await menuPick('Bea', 'Sign out everywhere…');
    await confirmYes();
    expect(before.isConnected).toBe(false); // the table was redrawn
    expect(document.activeElement).not.toBe(document.body);
    expect(inDialog()).toBe(true);
    expect(document.activeElement.dataset.focusKey).toBe('more:Bea');
    expect(document.activeElement).toBe(menuButton('Bea'));
  });

  it('make admin from Players: focus lands on that player\'s More button', async () => {
    await openPlayers();
    await menuPick('Bea', 'Make admin…');
    await confirmYes();
    expect(api.calls.filter((c) => c[0] === 'setAdmin')).toEqual([['setAdmin', { username: 'Bea', isAdmin: true }]]);
    expect(document.activeElement.dataset.focusKey).toBe('more:Bea');
  });

  it('remove admin in Admins: the same row if still listed, else the tab panel', async () => {
    let calls = 0;
    api = fakeApi({
      listAdmins: () => (++calls === 1
        ? { ok: true, admins: [{ username: 'Owner', adminSince: null }, { username: 'Bea', adminSince: null }] }
        : { ok: true, admins: [{ username: 'Owner', adminSince: null }] }),
      setAdmin: (a) => ({ ok: true, username: a.username, isAdmin: a.isAdmin, changed: true }),
    });
    showAdminPanel(null, { username: 'Owner', api });
    byText('Admins').click();
    await flush();
    const rows = [...document.querySelectorAll('#adminAdminList tbody tr')];
    byText('Remove admin', rows[1]).focus();
    byText('Remove admin', rows[1]).click();
    await flush();
    await confirmYes();
    expect(document.querySelectorAll('#adminAdminList tbody tr')).toHaveLength(1);
    expect(document.activeElement).toBe($('#adminPanel-admins'));
  });

  it('resolve a report: focus stays in the panel', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Reports').click();
    await flush();
    const resolve = byText('Resolve', $('#adminReportList'));
    resolve.focus();
    resolve.click();
    await flush();
    expect(resolve.isConnected).toBe(false);
    expect(inDialog()).toBe(true);
  });

  async function previewAndApply() {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Merge').click();
    typeInto($('#adminMergeKeep'), 'Bea');
    typeInto($('#adminMergeSources'), 'Bea2');
    byText('Preview merge').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    typeInto($('#adminMergeConfirm'), 'Bea');
    byText('Merge accounts').focus();
    byText('Merge accounts').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  }

  it('merge applied: focus moves to the Merged heading', async () => {
    await previewAndApply();
    expect(document.activeElement.tagName).toBe('H3');
    expect(document.activeElement.textContent).toBe('Merged');
  });

  it('merge refused as stale, or stopped partway: the preview is cleared and focus goes to Preview merge', async () => {
    for (const reply of [
      { ok: false, error: 'stale_plan', message: 'These accounts changed since the preview. Preview again before merging.' },
      { ok: false, error: 'server', message: 'The merge stopped partway and may be partly applied (Bea2 retired and signed out). Preview again to see what is left, then merge again.' },
    ]) {
      removeAdminPanel();
      api = fakeApi({ planMerge: { ok: true, plan: PLAN, planHash: HASH }, applyMerge: reply });
      await previewAndApply();
      expect(byText('Merge accounts')).toBeUndefined();
      expect($('#adminMergePlan').textContent).toBe(reply.message);
      expect($('#adminAlert').textContent).toBe(reply.message);
      expect(document.activeElement).toBe(byText('Preview merge'));
    }
  });

  it('forbidden from the main room: focus ends on a visible main-room control, not the hidden entry', async () => {
    showMainRoom({ onlineCount: 1 }, { emit: vi.fn(), on: vi.fn(), off: vi.fn() }, 'Owner');
    const entry = $('#mainRoomAdminButton');
    entry.focus();
    api = fakeApi({ listPlayers: { ok: false, error: 'forbidden', message: 'Not available.' } });
    await openPlayers();
    expect(entry.hidden).toBe(true);
    expect(document.activeElement).not.toBe(entry);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.hidden).toBe(false);
    expect(document.activeElement.textContent).toBe('Profile');
  });
});

describe('names, live regions and headers for assistive tech', () => {
  it('every row action\'s accessible name starts with its visible text (WCAG 2.5.3)', async () => {
    await openPlayers();
    byText('Admins').click();
    await flush();
    const visible = (b) => b.textContent.replace('▾', '').trim().toLowerCase();
    const buttons = [...document.querySelectorAll('#adminPlayerTable button, #adminAdminList button')].filter((b) => b.getAttribute('aria-label'));
    expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) expect(b.getAttribute('aria-label').toLowerCase().startsWith(visible(b))).toBe(true);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(expect.arrayContaining([
      'More actions: Bea', 'Remove admin: Owner', 'Reset link: Bea',
    ]));
    // menu items are named by their text (the menu is named after its row)
    expect(menuItems('Bea').every((i) => !i.hasAttribute('aria-label'))).toBe(true);
    expect(rowOf('Bea').querySelector('[role="menu"]').getAttribute('aria-label')).toBe('More actions: Bea');
  });

  it('results are polite (role=status, no aria-live override), errors go to a role=alert line; the plan is not a live region', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    const status = $('#adminStatus');
    const alert = $('#adminAlert');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.hasAttribute('aria-live')).toBe(false);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.hasAttribute('aria-live')).toBe(false);
    expect($('#adminMergePlan').hasAttribute('aria-live')).toBe(false);
    await flush();
    expect(status.textContent).toBe('');
    api.request.mockImplementationOnce(async (action) => ({ requestId: 'x', action, ok: false, error: 'refused', message: 'Not now.' }));
    byText('Reset link', rowOf('Bea')).click();
    await flush();
    expect(alert.textContent).toBe('Not now.');
    expect(status.textContent).toBe('');
    expect(status.getAttribute('role')).toBe('status');
    byText('Refresh', $('#adminPanel-players')).click();
    await flush();
    expect(status.textContent).toBe('3 accounts listed.');
    expect(alert.textContent).toBe('');
  });

  it('no table has a blank column header', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Admins').click();
    await flush();
    byText('Merge').click();
    typeInto($('#adminMergeKeep'), 'Bea');
    typeInto($('#adminMergeSources'), 'Bea2');
    byText('Preview merge').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const ths = [...document.querySelectorAll('#adminPlayerTable th, #adminAdminList th, #adminMergePlan th')];
    expect(ths.length).toBeGreaterThan(5);
    for (const th of ths) expect(th.textContent.trim()).not.toBe('');
  });

  it('a rate-limited request says so instead of blaming the connection', async () => {
    api = { request: vi.fn(async () => { throw new Error('rate_limited'); }), dispose() {} };
    await openPlayers();
    expect($('#adminAlert').textContent).toBe('Too many admin requests in a minute. Wait a moment and try again.');
  });
});

describe('createAdminApi', () => {
  it('a rate-limit error for adminRequest fails the unanswered requests fast with rate_limited', async () => {
    vi.useFakeTimers();
    try {
      const listeners = {};
      const socket = { on: (ev, fn) => { listeners[ev] = fn; }, off: vi.fn((ev) => { delete listeners[ev]; }), emit: vi.fn() };
      const a = createAdminApi(socket, { timeoutMs: 15000, rateLimitGraceMs: 3000 });
      const accepted = a.request('listAdmins', {});
      const dropped = a.request('listAudit', {});
      const dropErr = dropped.catch((e) => e);
      listeners.serverError({ code: 'rateLimit', handler: 'joinMainRoom' }); // another event's limit: ignored
      listeners.serverError({ code: 'rateLimit', handler: 'adminRequest', message: 'Too many requests, please slow down' });
      const [, first] = socket.emit.mock.calls[0];
      listeners.adminResponse({ requestId: first.requestId, action: 'listAdmins', ok: true, admins: [] });
      await expect(accepted).resolves.toMatchObject({ ok: true });
      vi.advanceTimersByTime(3000);
      expect((await dropErr).message).toBe('rate_limited');
      a.dispose();
      expect(socket.off).toHaveBeenCalledWith('serverError', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches replies by requestId, times out, and stops listening on dispose', async () => {
    vi.useFakeTimers();
    const listeners = {};
    const socket = {
      on: (ev, fn) => { listeners[ev] = fn; },
      off: vi.fn((ev) => { delete listeners[ev]; }),
      emit: vi.fn(),
    };
    const a = createAdminApi(socket, { timeoutMs: 1000 });
    const p1 = a.request('listAdmins', {});
    const p2 = a.request('searchPlayers', { query: 'x' });
    const [, first] = socket.emit.mock.calls[0];
    const [, second] = socket.emit.mock.calls[1];
    expect(socket.emit.mock.calls[0][0]).toBe('adminRequest');
    expect(first).toMatchObject({ action: 'listAdmins', args: {} });
    listeners.adminResponse({ requestId: second.requestId, action: 'searchPlayers', ok: true, players: [] });
    listeners.adminResponse({ requestId: 'someone-else', ok: true });
    await expect(p2).resolves.toMatchObject({ ok: true, players: [] });
    vi.advanceTimersByTime(1000);
    await expect(p1).rejects.toThrow('timeout');
    const p3 = a.request('listAudit', {});
    a.dispose();
    await expect(p3).rejects.toThrow('closed');
    expect(socket.off).toHaveBeenCalledWith('adminResponse', expect.any(Function));
    vi.useRealTimers();
  });
});
