/**
 * Player search replies are tied to their query (later #17). Search as you
 * type sends one request per pause, each a DB query on the server, so the
 * reply to "a" can land after the reply to "ann". The server echoes the
 * query (searchPlayersResponse.query, additive 2026-11-15) and the page
 * shows only the reply to the latest one sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showPlayerSearchPage, updatePlayerSearchResults, removePlayerSearchPage, refreshPlayerSearchOnline as refreshNow } from './PlayerSearchPage.js';
import { registerProfileHandlers } from '../../handlers/profileHandlers.js';

const row = (username) => ({ username, profilePic: 1, customProfilePic: null, gamesPlayed: 2, wins: 1 });
const names = () => [...document.querySelectorAll('#playerSearchResults .search-result__name')].map((n) => n.textContent);
const results = () => document.getElementById('playerSearchResults').textContent;

let socket;
let input;

function type(text) {
  input.value = text;
  input.dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(300);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  socket = { emit: vi.fn(() => socket) };
  showPlayerSearchPage(socket);
  input = document.getElementById('playerSearchInput');
});

afterEach(() => {
  removePlayerSearchPage();
  vi.useRealTimers();
});

describe('player search replies', () => {
  it('a reply to an older query that lands last is dropped', () => {
    type('a');
    type('ann');
    expect(socket.emit.mock.calls).toEqual([['searchPlayers', { query: 'a' }], ['searchPlayers', { query: 'ann' }]]);
    expect(updatePlayerSearchResults([row('ann')], 'ann')).toBe(true);
    expect(updatePlayerSearchResults([row('ann'), row('bea'), row('dan')], 'a')).toBe(false);
    expect(names()).toEqual(['ann']);
  });

  it('a failure for an older query does not wipe the current results', () => {
    type('a');
    type('ann');
    updatePlayerSearchResults([row('ann')], 'ann');
    expect(updatePlayerSearchResults([], 'a')).toBe(false);
    expect(names()).toEqual(['ann']);
  });

  it('a cleared input shows the hint, and a late reply for what was typed before stays out', () => {
    type('ann');
    type('');
    expect(results()).toMatch(/Search for a player/);
    expect(updatePlayerSearchResults([row('ann')], 'ann')).toBe(false);
    expect(results()).toMatch(/Search for a player/);
  });

  it('the reply to the latest query: shown, or "No players found"', () => {
    type('zzz');
    updatePlayerSearchResults([], 'zzz');
    expect(results()).toMatch(/No players found/);
  });

  it('a reply without the echo (an older server during a deploy) is shown as before', () => {
    type('ann');
    expect(updatePlayerSearchResults([row('ann')])).toBe(true);
    expect(names()).toEqual(['ann']);
  });

  it('the handler passes the echoed query through', () => {
    const handlers = new Map();
    const onSearchPlayersResult = vi.fn();
    registerProfileHandlers({ on: (e, fn) => handlers.set(e, fn) }, { onSearchPlayersResult });
    handlers.get('searchPlayersResponse')({ success: true, players: [row('ann')], query: 'ann' });
    handlers.get('searchPlayersResponse')({ success: false, message: 'Database error', query: 'a' });
    expect(onSearchPlayersResult.mock.calls).toEqual([[[row('ann')], 'ann'], [[], 'a']]);
  });
});

describe('the empty box lists who is online (2026-11-27)', () => {
  let online;
  const heading = () => document.getElementById('playerSearchOnlineHeading');
  const onlineButtons = () => [...document.querySelectorAll('#playerSearchResults button.search-result')];

  beforeEach(() => {
    removePlayerSearchPage();
    document.body.replaceChildren();
    online = ['ivy', 'kim', 'ora'];
    showPlayerSearchPage(socket, { getOnlineUsers: () => online, me: 'ivy' });
    input = document.getElementById('playerSearchInput');
  });

  it('opens on the online players under "Online now · N", my own name not a button', () => {
    expect(heading().textContent).toBe('Online now · 3');
    expect(heading().getAttribute('role')).toBe('heading');
    expect(names()).toEqual(['ivy', 'kim', 'ora']);
    expect(onlineButtons().map((b) => b.dataset.username)).toEqual(['kim', 'ora']);
    expect(onlineButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['kim, online', 'ora, online']);
    expect(document.querySelector('.search-result--me').tagName).toBe('DIV');
    expect(results()).not.toMatch(/Search for a player/);
  });

  it('a row opens that profile and closes the page', () => {
    onlineButtons()[1].click();
    expect(socket.emit).toHaveBeenCalledWith('getPlayerProfile', expect.objectContaining({ username: 'ora' }));
    expect(document.getElementById('playerSearchPageOverlay')).toBeNull();
  });

  it('typing searches as before; clearing the box brings the list back', () => {
    type('zz');
    expect(socket.emit).toHaveBeenCalledWith('searchPlayers', { query: 'zz' });
    updatePlayerSearchResults([], 'zz');
    expect(results()).toMatch(/No players found/);
    expect(heading()).toBeNull();
    type('');
    expect(heading().textContent).toBe('Online now · 3');
    expect(updatePlayerSearchResults([row('zz')], 'zz')).toBe(false);
    expect(heading()).not.toBeNull();
  });

  it('follows the main room list while the box is empty, keeping focus on a row still there', async () => {
    const { refreshPlayerSearchOnline } = await import('./PlayerSearchPage.js');
    onlineButtons()[1].focus();
    online = ['ivy', 'ora', 'pat', 'kim'];
    refreshPlayerSearchOnline();
    expect(heading().textContent).toBe('Online now · 4');
    expect(document.activeElement.dataset.username).toBe('ora');
    online = ['ivy'];
    refreshPlayerSearchOnline();
    expect(document.activeElement).toBe(input);
    // not while a search shows
    type('kim');
    updatePlayerSearchResults([row('kim')], 'kim');
    online = ['ivy', 'kim'];
    refreshPlayerSearchOnline();
    expect(names()).toEqual(['kim']);
  });

  it('only a search answer is announced: the list is no live region, the status line says what was found', () => {
    const status = document.getElementById('playerSearchStatus');
    const container = document.getElementById('playerSearchResults');
    expect(container.closest('[aria-live]')).toBeNull();
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.contains(container)).toBe(false);
    expect(status.textContent).toBe('');
    // a join while the box is empty redraws the list and announces nothing
    online = ['ivy', 'kim', 'ora', 'pat'];
    refreshNow();
    expect(heading().textContent).toBe('Online now · 4');
    expect(status.textContent).toBe('');
    type('k');
    updatePlayerSearchResults([row('kim'), row('kit')], 'k');
    expect(status.textContent).toBe('2 players found');
    type('kim');
    updatePlayerSearchResults([row('kim')], 'kim');
    expect(status.textContent).toBe('1 player found');
    type('kimz');
    updatePlayerSearchResults([], 'kimz');
    expect(status.textContent).toBe('No players found');
    type('');
    expect(status.textContent).toBe('');
  });

  it('nobody listed: the hint', () => {
    removePlayerSearchPage();
    showPlayerSearchPage(socket, { getOnlineUsers: () => [], me: 'ivy' });
    expect(results()).toMatch(/Search for a player by username/);
  });
});
