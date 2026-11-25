/**
 * Player search replies are tied to their query (later #17). Search as you
 * type sends one request per pause, each a DB query on the server, so the
 * reply to "a" can land after the reply to "ann". The server echoes the
 * query (searchPlayersResponse.query, additive 2026-11-15) and the page
 * shows only the reply to the latest one sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showPlayerSearchPage, updatePlayerSearchResults, removePlayerSearchPage } from './PlayerSearchPage.js';
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
