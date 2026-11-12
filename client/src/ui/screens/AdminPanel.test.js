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
  { username: 'Bea', createdAt: '2026-01-02T00:00:00.000Z', lastSeenAt: '2026-11-10T00:00:00.000Z', online: false, gamesPlayed: 12, isAdmin: false, mergedInto: null },
  { username: 'Owner', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: null, online: true, gamesPlayed: 40, isAdmin: true, mergedInto: null },
  { username: 'Bea2', createdAt: null, lastSeenAt: null, online: false, gamesPlayed: 0, isAdmin: false, mergedInto: 'Bea' },
];

const PLAN = {
  target: 'Bea', sources: ['Bea2'], errors: [], warnings: ['heads up'],
  accounts: [
    { role: 'target', username: 'Bea', createdAt: null, stats: { gamesPlayed: 12, wins: 6, losses: 6, draws: 0, totalPoints: 900 }, note: null },
    { role: 'source', username: 'Bea2', createdAt: '2026-03-01T00:00:00.000Z', stats: { gamesPlayed: 2, wins: 1, losses: 1, draws: 0, totalPoints: 100 }, note: 'stats will be added' },
    { role: 'result', username: 'Bea', createdAt: null, stats: { gamesPlayed: 14, wins: 7, losses: 7, draws: 0, totalPoints: 1000 }, note: null },
  ],
  statChanges: [{ key: 'gamesPlayed', before: 12, after: 14 }],
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
    createResetLink: (a) => ({ ok: true, username: a.username, token: 'T'.repeat(43), expiresAt: '2026-11-12T12:00:00.000Z' }),
    signOutEverywhere: (a) => ({ ok: true, username: a.username, revokedSessions: 2, disconnected: 1 }),
    setAdmin: (a) => ({ ok: true, username: a.username, isAdmin: a.isAdmin, changed: true }),
    planMerge: { ok: true, plan: PLAN, planHash: HASH },
    applyMerge: { ok: true, result: { target: 'Bea', statsMerged: ['Bea2'], retired: ['Bea2'], gameRecords: 1, reports: 0, otherUsersBlocks: 0, chainedTombstones: 0, profilePic: false, signedOut: 0 } },
    findDuplicates: { ok: true, groups: [[{ username: 'Bea', gamesPlayed: 12, createdAt: null }, { username: 'bea2', gamesPlayed: 1, createdAt: null }]] },
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

async function openWithSearch() {
  showAdminPanel(null, { username: 'Owner', api });
  $('#adminSearchInput').value = 'Bea';
  $('#adminSearchInput').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
}

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
  it('a labelled modal with five keyboard tabs; the search field has focus', () => {
    showAdminPanel(null, { username: 'Owner', api });
    const dialog = $('#adminPanelModal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Players', 'Merge', 'Reports', 'Admins', 'Audit']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement.id).toBe('adminSearchInput');
    expect($('label[for="adminSearchInput"]').textContent).toBe('Find a player');
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
    expect(api.calls).toEqual([]);
    expect(document.activeElement.getAttribute('role')).toBe('tab');
  });

  it('search rows: created, last seen, games, admin / online / merged markers, actions per row', async () => {
    await openWithSearch();
    expect(api.calls[0]).toEqual(['searchPlayers', { query: 'Bea' }]);
    const rows = [...document.querySelectorAll('#adminSearchResults tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toMatch(/Owner.*admin.*online/);
    expect(rows[2].textContent).toMatch(/merged into Bea/);
    expect(byText('Reset link', rows[2])).toBeUndefined(); // a tombstone gets no actions
    expect(byText('Make admin', rows[0])).toBeTruthy();
    expect(byText('Remove admin', rows[1])).toBeTruthy();
    expect($('#adminStatus').textContent).toBe('3 players found for "Bea".');
  });

  it('reset link: shown once in a labelled field with Copy, the /reset#token URL', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await openWithSearch();
    byText('Reset link', document.querySelector('#adminSearchResults tbody tr')).click();
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
    await openWithSearch();
    const row = () => document.querySelector('#adminSearchResults tbody tr');
    byText('Sign out everywhere', row()).click();
    await flush();
    expect($('#adminConfirmDialog').textContent).toMatch(/Sign Bea out everywhere\?/);
    expect(document.activeElement.textContent).toBe('Cancel'); // the safe choice has focus
    byText('Cancel', $('#adminConfirmDialog')).click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'signOutEverywhere')).toEqual([]);
    byText('Sign out everywhere', row()).click();
    await flush();
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
    expect(api.calls.filter((c) => c[0] === 'signOutEverywhere')).toEqual([['signOutEverywhere', { username: 'Bea' }]]);
    expect($('#adminStatus').textContent).toMatch(/Bea is signed out: 2 saved session\(s\) revoked, 1 live connection/);
  });

  it('remove admin asks first; removing yourself closes the panel and the entry', async () => {
    await openWithSearch();
    const ownerRow = [...document.querySelectorAll('#adminSearchResults tbody tr')][1];
    byText('Remove admin', ownerRow).click();
    await flush();
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
    $('#adminDuplicates button').click();
    expect($('#adminMergeKeep').value).toBe('Bea');
    expect($('#adminMergeSources').value).toBe('bea2');
  });

  it('reports: open first, resolve with the note, the reported name opens the player search', async () => {
    showAdminPanel(null, { username: 'Owner', api });
    byText('Reports').click();
    await flush();
    const card = $('#adminReportList article');
    expect(card.textContent).toMatch(/Bea reported Owner.*open/);
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
    expect(api.calls.pop()).toEqual(['searchPlayers', { query: 'Owner' }]);
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
    api = fakeApi({ searchPlayers: { ok: false, error: 'forbidden', message: 'Not available.' } });
    await openWithSearch();
    expect($('#adminPanelModal')).toBeNull();
    expect(isAdmin()).toBe(false);
    expect(api.disposed).toBe(true);
  });

  it('every name goes in as text, never markup', async () => {
    api = fakeApi({ searchPlayers: { ok: true, players: [{ ...PLAYERS[0], username: '<img src=x onerror=alert(1)>' }] } });
    await openWithSearch();
    expect(document.querySelector('#adminSearchResults img')).toBeNull();
    expect($('#adminSearchResults').textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('focus after an action redraws its list', () => {
  const inDialog = () => Boolean(document.activeElement && $('#adminPanelModal')?.contains(document.activeElement));
  const confirmYes = async () => {
    $('#adminConfirmDialog [data-confirm="yes"]').click();
    await flush();
  };

  it('sign out everywhere: focus returns to that row\'s button in the new table', async () => {
    await openWithSearch();
    const before = byText('Sign out everywhere', document.querySelector('#adminSearchResults tbody tr'));
    before.focus();
    before.click();
    await flush();
    await confirmYes();
    expect(before.isConnected).toBe(false); // the table was redrawn
    expect(document.activeElement).not.toBe(document.body);
    expect(inDialog()).toBe(true);
    expect(document.activeElement.dataset.focusKey).toBe('signout:Bea');
    expect(document.activeElement.textContent).toBe('Sign out everywhere');
  });

  it('make admin from Players: focus lands on that player\'s admin toggle', async () => {
    await openWithSearch();
    const make = byText('Make admin', document.querySelector('#adminSearchResults tbody tr'));
    make.focus();
    make.click();
    await flush();
    await confirmYes();
    expect(document.activeElement.dataset.focusKey).toBe('admin:Bea');
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
    api = fakeApi({ searchPlayers: { ok: false, error: 'forbidden', message: 'Not available.' } });
    await openWithSearch();
    expect(entry.hidden).toBe(true);
    expect(document.activeElement).not.toBe(entry);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement.hidden).toBe(false);
    expect(document.activeElement.textContent).toBe('Profile');
  });
});

describe('names, live regions and headers for assistive tech', () => {
  it('every row action\'s accessible name starts with its visible text (WCAG 2.5.3)', async () => {
    await openWithSearch();
    byText('Admins').click();
    await flush();
    const buttons = [...document.querySelectorAll('#adminSearchResults button, #adminAdminList button')].filter((b) => b.getAttribute('aria-label'));
    expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) expect(b.getAttribute('aria-label').toLowerCase().startsWith(b.textContent.toLowerCase())).toBe(true);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(expect.arrayContaining([
      'Sign out everywhere: Bea', 'Make admin: Bea', 'Remove admin: Owner', 'Reset link: Bea',
    ]));
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
    $('#adminSearchInput').closest('form').dispatchEvent(new Event('submit', { cancelable: true })); // empty: an error
    await flush();
    expect(alert.textContent).toBe('Type part of a name to search.');
    expect(status.textContent).toBe('');
    expect(status.getAttribute('role')).toBe('status');
    $('#adminSearchInput').value = 'Bea';
    $('#adminSearchInput').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(status.textContent).toBe('3 players found for "Bea".');
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
    const ths = [...document.querySelectorAll('#adminAdminList th, #adminMergePlan th')];
    expect(ths.length).toBeGreaterThan(5);
    for (const th of ths) expect(th.textContent.trim()).not.toBe('');
  });

  it('a rate-limited request says so instead of blaming the connection', async () => {
    api = { request: vi.fn(async () => { throw new Error('rate_limited'); }), dispose() {} };
    await openWithSearch();
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
      listeners.error({ type: 'rateLimit', handler: 'joinMainRoom' }); // another event's limit: ignored
      listeners.error({ type: 'rateLimit', handler: 'adminRequest', message: 'Too many requests, please slow down' });
      const [, first] = socket.emit.mock.calls[0];
      listeners.adminResponse({ requestId: first.requestId, action: 'listAdmins', ok: true, admins: [] });
      await expect(accepted).resolves.toMatchObject({ ok: true });
      vi.advanceTimersByTime(3000);
      expect((await dropErr).message).toBe('rate_limited');
      a.dispose();
      expect(socket.off).toHaveBeenCalledWith('error', expect.any(Function));
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
