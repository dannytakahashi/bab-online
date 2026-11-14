/**
 * The stats scope on the Leaderboard, Records and Profile views: the main
 * room asks with the device's choice, the control re-asks with the new
 * scope (saved per device, shared by every view), the view waits
 * (aria-busy) and is updated in place by the reply (the modal stays,
 * focus stays on the control), an empty Bot games view says why.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showMainRoom, removeMainRoom } from './MainRoom.js';
import { showLeaderboardPage, updateLeaderboardPage, leaderboardRequestFailed, removeLeaderboardPage, LEADERBOARD_MIN_NOTE } from './LeaderboardPage.js';
import { showRecordsPage, updateRecordsPage, recordsRequestFailed, removeRecordsPage, periodCounts } from './RecordsPage.js';
import {
  showProfilePage, showPlayerProfilePage, updateProfileStats, updatePlayerProfileStats, profileStatsRequestFailed,
  removeProfilePage, removePlayerProfilePage,
} from './ProfilePage.js';
import { clearToasts } from '../kit/index.js';
import { STATS_SCOPE_KEY, BOT_STATS_EMPTY_NOTE, getStatsScope, _resetStatsScopeForTests } from '../../state/statsScope.js';

function fakeSocket() {
  const sent = [];
  return {
    sent,
    emit: vi.fn((event, data) => sent.push([event, data])),
    on: vi.fn(),
    off: vi.fn(),
    emitted: (e) => sent.filter(([n]) => n === e).map(([, d]) => d),
  };
}

const radio = (root, scope) => root.querySelector(`[role="radio"][data-scope="${scope}"]`);
const checkedIn = (root) => [...root.querySelectorAll('[role="radio"][aria-checked="true"]')].map((r) => r.dataset.scope);

const row = (username, gamesPlayed, extra = {}) => ({
  username, profilePic: 1, customProfilePic: null, gamesPlayed, winRate: 50, pointsPerGame: 100, bidsPerGame: 3,
  tricksPerBid: 1, setRate: 10, drag: -5, faultsPerGame: 0, avgHSI: 20, ...extra,
});

// Node 25+ ships its own global localStorage (unusable without
// --localstorage-file) that shadows jsdom's, so provide a plain one
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

let socket;

beforeEach(() => {
  socket = fakeSocket();
  _resetStatsScopeForTests();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  removeMainRoom();
  removeLeaderboardPage();
  removeRecordsPage();
  removeProfilePage();
  removePlayerProfilePage();
  clearToasts();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  _resetStatsScopeForTests();
});

describe('the main room asks with the device\'s scope', () => {
  const nav = (label) => [...document.querySelectorAll('nav.screen-nav button')].find((b) => b.textContent === label);

  it('human by default, the saved choice after a switch', () => {
    showMainRoom({ onlineCount: 1 }, socket, 'Bea');
    nav('Leaderboard').click();
    nav('Records').click();
    nav('Profile').click();
    expect(socket.sent).toEqual([['getLeaderboard', { scope: 'human' }], ['getRecords', { scope: 'human' }], ['getProfile', { scope: 'human' }]]);
    localStorage.setItem(STATS_SCOPE_KEY, 'bots');
    nav('Leaderboard').click();
    expect(socket.emitted('getLeaderboard').pop()).toEqual({ scope: 'bots' });
  });
});

describe('Leaderboard', () => {
  it('says under the table that players appear after 5 games (the server leaves out fewer)', () => {
    showLeaderboardPage([row('ann', 5), row('Population', 4, { isPopulation: true })], socket, 'human');
    const note = document.querySelector('#leaderboardPageModal .lb-min-note');
    expect(note?.textContent).toBe('Players appear in the standings after 5 games.');
    expect(LEADERBOARD_MIN_NOTE).toBe(note.textContent);
    // after the table, not inside the scope region a switch dims
    expect(document.getElementById('leaderboardRegion').contains(note)).toBe(false);
  });

  it('the control on top (Human games checked); a switch saves, waits, re-asks once and updates in place', () => {
    showLeaderboardPage([row('ann', 4), row('Population', 4, { isPopulation: true })], socket, 'human');
    const dialog = document.getElementById('leaderboardPageModal');
    const group = dialog.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(checkedIn(dialog)).toEqual(['human']);
    const region = document.getElementById('leaderboardRegion');
    expect(group.getAttribute('aria-controls')).toBe('leaderboardRegion');

    radio(dialog, 'bots').focus();
    radio(dialog, 'bots').click();
    expect(localStorage.getItem(STATS_SCOPE_KEY)).toBe('bots');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(socket.sent).toEqual([['getLeaderboard', { scope: 'bots' }]]);

    expect(updateLeaderboardPage([row('cat', 7)], 'bots')).toBe(true);
    expect(document.getElementById('leaderboardPageModal')).toBe(dialog);
    expect(region.hasAttribute('aria-busy')).toBe(false);
    expect([...dialog.querySelectorAll('.lb-player span')].map((s) => s.textContent)).toEqual(['cat']);
    expect(document.activeElement).toBe(radio(dialog, 'bots'));
  });

  it('an empty Bot games view says bot games count from now on; Human games keeps its message', () => {
    showLeaderboardPage([], socket, 'bots');
    expect(document.querySelector('.lb-empty').textContent).toBe(BOT_STATS_EMPTY_NOTE);
    radio(document, 'human').click();
    updateLeaderboardPage([], 'human');
    expect(document.querySelector('.lb-empty').textContent).toBe('No players have completed games yet.');
  });

  it('keeps the sort across a switch', () => {
    showLeaderboardPage([row('ann', 4), row('bob', 9)], socket, 'human');
    document.querySelector('.lb-col--gamesPlayed .lb-sort').click();
    updateLeaderboardPage([row('cat', 1), row('dan', 3)], 'all');
    expect([...document.querySelectorAll('.lb-player span')].map((s) => s.textContent)).toEqual(['dan', 'cat']);
    expect(checkedIn(document)).toEqual(['all']);
  });

  it('a failed request stops the wait; with no page open an update does nothing', () => {
    showLeaderboardPage([], socket, 'human');
    radio(document, 'all').click();
    const region = document.getElementById('leaderboardRegion');
    expect(region.getAttribute('aria-busy')).toBe('true');
    leaderboardRequestFailed();
    expect(region.hasAttribute('aria-busy')).toBe(false);
    removeLeaderboardPage();
    expect(updateLeaderboardPage([], 'all')).toBe(false);
    // a pending request is cancelled with the page
    vi.advanceTimersByTime(500);
    expect(socket.sent).toEqual([]);
  });

  it('arrow keys through the options send one request for the last one', () => {
    showLeaderboardPage([], socket, 'human');
    const first = radio(document, 'human');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(200);
    expect(socket.sent).toEqual([['getLeaderboard', { scope: 'all' }]]);
    expect(getStatsScope()).toBe('all');
  });
});

describe('Records', () => {
  const rec = { score: 900, players: ['Cat', '🤖 Mary'] };
  const period = { highestScore: rec, lowestScore: rec, biggestWin: null, mostBags: null, leastBags: null };

  it('the control on top; a switch re-asks and swaps the body in place; bot names show as text', () => {
    showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 3, socket, 'human');
    const dialog = document.getElementById('recordsPageModal');
    expect(checkedIn(dialog)).toEqual(['human']);
    radio(dialog, 'bots').click();
    vi.advanceTimersByTime(200);
    expect(socket.emitted('getRecords')).toEqual([{ scope: 'bots' }]);
    const region = document.getElementById('recordsRegion');
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(updateRecordsPage({ allTime: period, thisYear: period, thisMonth: period }, 2, 'bots')).toBe(true);
    expect(document.getElementById('recordsPageModal')).toBe(dialog);
    expect(region.hasAttribute('aria-busy')).toBe(false);
    expect(region.querySelector('.records-total').textContent).toBe('2 games played');
    expect(region.querySelector('.record__sub').textContent).toBe('Cat & 🤖 Mary');
    // one game: singular (owner 2026-11-13, "1 games played")
    updateRecordsPage({ allTime: period, thisYear: period, thisMonth: period }, 1, 'bots');
    expect(region.querySelector('.records-total').textContent).toBe('1 game played');
    expect(region.querySelector('.scope-note')).toBeNull();
  });

  it('an empty Bot games view says bot games count from now on', () => {
    showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0, socket, 'bots');
    expect(document.querySelector('#recordsRegion .scope-note').textContent).toBe(BOT_STATS_EMPTY_NOTE);
    radio(document, 'human').click();
    updateRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0, 'human');
    expect(document.querySelector('#recordsRegion .scope-note')).toBeNull();
  });

  // owner 2026-11-14: "the total number of games played doesn't change when selecting this year or this month"
  const counts = () => [...document.querySelectorAll('#recordsRegion .records-box')].map((box) => [
    box.querySelector('.records-box__title').textContent,
    box.querySelector('.records-box__count')?.textContent ?? null,
  ]);

  it('periodGames: each box says its own period\'s count; no overall line repeating All Time', () => {
    showRecordsPage({ allTime: period, thisYear: period, thisMonth: period }, 101, socket, 'human', { allTime: 101, thisYear: 40, thisMonth: 1 });
    expect(counts()).toEqual([['All Time', '101 games played'], ['This Year', '40 games played'], ['This Month', '1 game played']]);
    expect(document.querySelector('#recordsRegion .records-total')).toBeNull();
    // the count is the bold number, then the words
    expect(document.querySelector('#recordsRegion .records-box__count strong').textContent).toBe('101');
    // a scope switch swaps in that scope's counts
    radio(document, 'all').click();
    vi.advanceTimersByTime(200);
    updateRecordsPage({ allTime: period, thisYear: period, thisMonth: null }, 1234, 'all', { allTime: 1234, thisYear: 3, thisMonth: 0 });
    expect(counts()).toEqual([['All Time', `${(1234).toLocaleString()} games played`], ['This Year', '3 games played'], ['This Month', '0 games played']]);
    expect(document.querySelector('#recordsRegion .records-total')).toBeNull();
  });

  it('a reply without periodGames keeps the one all-time line and no box counts', () => {
    showRecordsPage({ allTime: period, thisYear: period, thisMonth: period }, 7, socket, 'human');
    expect(document.querySelector('#recordsRegion .records-total').textContent).toBe('7 games played');
    expect(counts().every(([, c]) => c === null)).toBe(true);
    // a malformed periodGames is treated as absent, a bad count alone is hidden
    updateRecordsPage({ allTime: period, thisYear: period, thisMonth: period }, 7, 'human', 'nope');
    expect(document.querySelector('#recordsRegion .records-total').textContent).toBe('7 games played');
    updateRecordsPage({ allTime: period, thisYear: period, thisMonth: period }, 7, 'human', { allTime: 7, thisYear: -1, thisMonth: '2' });
    expect(counts()).toEqual([['All Time', '7 games played'], ['This Year', null], ['This Month', null]]);
    expect(document.querySelector('#recordsRegion .records-total')).toBeNull();
  });

  it('periodCounts keeps only non-negative integers', () => {
    expect(periodCounts({ allTime: 3, thisYear: 2, thisMonth: 0 })).toEqual({ allTime: 3, thisYear: 2, thisMonth: 0 });
    expect(periodCounts(undefined)).toEqual({ allTime: null, thisYear: null, thisMonth: null });
    expect(periodCounts({ allTime: 1.5, thisYear: null, thisMonth: '4' })).toEqual({ allTime: null, thisYear: null, thisMonth: null });
  });

  it('the bot-games note reads the scope\'s all-time count (periodGames.allTime, else totalGames)', () => {
    showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0, socket, 'bots', { allTime: 0, thisYear: 0, thisMonth: 0 });
    expect(document.querySelector('#recordsRegion .scope-note').textContent).toBe(BOT_STATS_EMPTY_NOTE);
    updateRecordsPage({ allTime: period, thisYear: null, thisMonth: null }, 2, 'bots', { allTime: 2, thisYear: 0, thisMonth: 0 });
    expect(document.querySelector('#recordsRegion .scope-note')).toBeNull();
    updateRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, undefined, 'bots', { allTime: 0, thisYear: 0, thisMonth: 0 });
    expect(document.querySelector('#recordsRegion .scope-note').textContent).toBe(BOT_STATS_EMPTY_NOTE);
  });

  it('the choice is shared: switching in Records opens the Leaderboard on the same scope', () => {
    showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0, socket, 'human');
    radio(document, 'all').click();
    recordsRequestFailed();
    removeRecordsPage();
    showLeaderboardPage([], socket);
    expect(checkedIn(document)).toEqual(['all']);
  });
});

describe('Profile', () => {
  it('own profile: the control above the grid; a switch asks getProfile {scope} and replaces only the grid', () => {
    showProfilePage({ username: 'me', profilePic: 3, stats: { gamesPlayed: 2, wins: 1 } }, socket, 'human');
    const dialog = document.getElementById('profilePageModal');
    const hero = dialog.querySelector('.profile-hero');
    const signOut = dialog.querySelector('.profile-signout');
    expect(checkedIn(dialog)).toEqual(['human']);
    radio(dialog, 'bots').focus();
    radio(dialog, 'bots').click();
    vi.advanceTimersByTime(200);
    expect(socket.emitted('getProfile')).toEqual([{ scope: 'bots' }]);
    expect(updateProfileStats({ username: 'me', stats: { gamesPlayed: 0 } }, 'bots')).toBe(true);
    expect(document.getElementById('profilePageModal')).toBe(dialog);
    expect(dialog.querySelector('.profile-hero')).toBe(hero);
    expect(dialog.querySelector('.profile-signout')).toBe(signOut);
    expect(document.querySelector('#profileStatsRegion .scope-note').textContent).toBe(BOT_STATS_EMPTY_NOTE);
    expect(document.activeElement).toBe(radio(dialog, 'bots'));
    updateProfileStats({ username: 'me', stats: { gamesPlayed: 5, wins: 5 } }, 'bots');
    expect(document.querySelector('#profileStatsRegion .scope-note')).toBeNull();
    expect(document.querySelector('#profileStatsRegion .stat__value').textContent).toBe('5');
    // another account's profile is never written into this one
    expect(updateProfileStats({ username: 'other', stats: {} }, 'bots')).toBe(false);
  });

  it('another player: getPlayerProfile {username, scope}; the reply for that player updates in place', () => {
    showPlayerProfilePage({ username: 'ann', profilePic: 3, stats: { gamesPlayed: 4 } }, socket, { scope: 'human' });
    const dialog = document.getElementById('playerProfilePageModal');
    const block = document.getElementById('playerBlockButton');
    radio(dialog, 'all').click();
    vi.advanceTimersByTime(200);
    expect(socket.emitted('getPlayerProfile')).toEqual([{ username: 'ann', scope: 'all' }]);
    expect(document.getElementById('playerProfileStatsRegion').getAttribute('aria-busy')).toBe('true');
    expect(updatePlayerProfileStats({ username: 'bob', stats: {} }, 'all')).toBe(false);
    profileStatsRequestFailed();
    expect(document.getElementById('playerProfileStatsRegion').hasAttribute('aria-busy')).toBe(false);
    expect(updatePlayerProfileStats({ username: 'ann', stats: { gamesPlayed: 9 } }, 'all')).toBe(true);
    expect(document.getElementById('playerBlockButton')).toBe(block);
    expect(document.querySelector('#playerProfileStatsRegion .stat__value').textContent).toBe('9');
  });

  it('opens on the device\'s choice when no scope is given', () => {
    localStorage.setItem(STATS_SCOPE_KEY, 'bots');
    showPlayerProfilePage({ username: 'ann', profilePic: 3, stats: {} }, socket);
    expect(checkedIn(document)).toEqual(['bots']);
    expect(document.querySelector('#playerProfileStatsRegion .scope-note').textContent).toBe(BOT_STATS_EMPTY_NOTE);
  });
});
