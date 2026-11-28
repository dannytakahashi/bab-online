/**
 * Player search replies are tied to their query (later #17). Search as you
 * type sends one request per pause, each a DB query on the server, so the
 * reply to "a" can land after the reply to "ann". The server echoes the
 * query (searchPlayersResponse.query, additive 2026-11-15) and the page
 * shows only the reply to the latest one sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showPlayerSearchPage, updatePlayerSearchResults, removePlayerSearchPage, refreshPlayerSearchOnline as refreshNow, updatePlayerCards, _resetPlayerCardsForTests, PLAYER_CARDS_MAX, PLAYER_CARDS_RETRY_MS, playerCardsRefused } from './PlayerSearchPage.js';
import { foldAvatarPayload } from '../../utils/avatar.js';
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
  _resetPlayerCardsForTests();
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

describe('the online list shows pictures (playerCards, 2026-11-27)', () => {
  let online;
  const cardCalls = () => socket.emit.mock.calls.filter(([e]) => e === 'playerCards').map(([, d]) => d.usernames);
  const rowOf = (u) => document.querySelector(`#playerSearchResults .search-result[data-username="${u}"]`);
  const pic = (u) => rowOf(u)?.firstElementChild;
  const card = (username, profilePic, customProfilePic = null) => ({ username, profilePic, customProfilePic, gamesPlayed: 3, wins: 1 });
  const open = () => {
    showPlayerSearchPage(socket, { getOnlineUsers: () => online, me: 'ivy' });
    input = document.getElementById('playerSearchInput');
  };

  beforeEach(() => {
    removePlayerSearchPage();
    document.body.replaceChildren();
    socket.emit.mockClear();
    online = ['ivy', 'kim', 'ora'];
    open();
  });

  it('opening asks at once for every listed name; each row shows its initial until its card comes', () => {
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora']]);
    for (const [u, letter] of [['ivy', 'I'], ['kim', 'K'], ['ora', 'O']]) {
      expect(pic(u).tagName).toBe('SPAN');
      expect(pic(u).className).toBe('search-result__initial');
      expect(pic(u).textContent).toBe(letter);
      expect(pic(u).getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('a card swaps the initial for the search results\' picture in place: same row, same label, focus kept', () => {
    const kim = rowOf('kim');
    kim.focus();
    const data = foldAvatarPayload('playerCardsResponse', { success: true, players: [card('kim', 12), card('ivy', 31), card('ora', 9, null)], avatarUrls: { ora: '/avatar/ora?v=00000000000000aa' } });
    updatePlayerCards(data.players);
    expect(rowOf('kim')).toBe(kim);
    expect(document.activeElement).toBe(kim);
    expect(kim.getAttribute('aria-label')).toBe('kim, online');
    expect(pic('kim').tagName).toBe('IMG');
    expect(pic('kim').getAttribute('src')).toBe('assets/avatars/v1/profile12.webp');
    expect(pic('kim').getAttribute('alt')).toBe('');
    expect(pic('ora').getAttribute('src')).toBe('/avatar/ora?v=00000000000000aa');
    // my own row too, still not a button and still "You"
    expect(pic('ivy').getAttribute('src')).toBe('assets/avatars/v1/profile31.webp');
    expect(rowOf('ivy').tagName).toBe('DIV');
    expect(rowOf('ivy').textContent).toContain('You');
    // the same markup as a result row: an <img> then the info
    expect([...kim.children].map((c) => c.className || c.tagName)).toEqual(['IMG', 'search-result__info']);
  });

  it('a join is asked for after the pause, only the new name; a redraw keeps the rows and pictures it had', () => {
    updatePlayerCards([card('kim', 12)]);
    const kimPic = pic('kim');
    online = ['ivy', 'kim', 'ora', 'pat'];
    refreshNow();
    expect(pic('kim')).toBe(kimPic);
    expect(pic('pat').tagName).toBe('SPAN');
    vi.advanceTimersByTime(299);
    expect(cardCalls()).toHaveLength(1);
    // a second change inside the pause: one request for both
    online = ['ivy', 'kim', 'ora', 'pat', 'quinn'];
    refreshNow();
    vi.advanceTimersByTime(300);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['pat', 'quinn']]);
    // a leave asks for nothing
    online = ['ivy', 'kim'];
    refreshNow();
    vi.advanceTimersByTime(1000);
    expect(cardCalls()).toHaveLength(2);
  });

  it('an old server that never answers: initials, no error, and every name asked once per opening', () => {
    for (let i = 0; i < 5; i++) {
      online = ['ivy', 'kim', 'ora', `p${i}`];
      refreshNow();
      vi.advanceTimersByTime(300);
    }
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['p0'], ['p1'], ['p2'], ['p3'], ['p4']]);
    vi.advanceTimersByTime(60000);
    expect(cardCalls()).toHaveLength(6);
    expect(pic('kim').tagName).toBe('SPAN');
    // a failure reply changes nothing either
    updatePlayerCards(undefined);
    updatePlayerCards([]);
    expect(pic('kim').tagName).toBe('SPAN');
  });

  it('cards are kept for the session: a reopened page draws them at once and asks again (a refresh)', () => {
    updatePlayerCards([card('kim', 12)]);
    removePlayerSearchPage();
    socket.emit.mockClear();
    open();
    expect(pic('kim').tagName).toBe('IMG');
    expect(pic('kim').getAttribute('src')).toBe('assets/avatars/v1/profile12.webp');
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora']]);
    // a changed picture replaces the old one in place
    updatePlayerCards([card('kim', 40)]);
    expect(pic('kim').getAttribute('src')).toBe('assets/avatars/v1/profile40.webp');
  });

  it('a search result is a card too; nothing is asked while a search shows, the list asks when it comes back', () => {
    type('ki');
    updatePlayerSearchResults([card('kim', 12)], 'ki');
    online = ['ivy', 'kim', 'ora', 'pat'];
    refreshNow();
    vi.advanceTimersByTime(1000);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora']]);
    type('');
    expect(pic('kim').getAttribute('src')).toBe('assets/avatars/v1/profile12.webp');
    vi.advanceTimersByTime(300);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['pat']]);
  });

  it('more than 100 names go in requests of 100', () => {
    removePlayerSearchPage();
    socket.emit.mockClear();
    online = Array.from({ length: 230 }, (_, i) => `p${i}`);
    open();
    expect(cardCalls().map((u) => u.length)).toEqual([PLAYER_CARDS_MAX, PLAYER_CARDS_MAX, 30]);
    expect(cardCalls().flat()).toEqual(online);
  });

  it('closing the page drops a pending request; an empty list asks nothing', () => {
    online = ['ivy', 'kim', 'ora', 'pat'];
    refreshNow();
    removePlayerSearchPage();
    vi.advanceTimersByTime(1000);
    expect(cardCalls()).toHaveLength(1);
    socket.emit.mockClear();
    online = [];
    open();
    expect(cardCalls()).toEqual([]);
  });

  it('a refused request (a burst past the rate limit): its unanswered names are asked once more after the window, with the joiners', () => {
    expect(PLAYER_CARDS_RETRY_MS).toBe(10000);
    online = ['ivy', 'kim', 'ora', 'pat'];
    refreshNow();
    vi.advanceTimersByTime(300);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['pat']]);
    updatePlayerCards([card('ivy', 31), card('kim', 12), card('ora', 9)]);
    playerCardsRefused();
    // joins inside the window wait for it
    online = ['ivy', 'kim', 'ora', 'pat', 'quinn'];
    refreshNow();
    vi.advanceTimersByTime(9000);
    expect(cardCalls()).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['pat'], ['pat', 'quinn']]);
    updatePlayerCards([card('pat', 7), card('quinn', 8)]);
    expect(pic('pat').getAttribute('src')).toBe('assets/avatars/v1/profile7.webp');
    expect(pic('quinn').getAttribute('src')).toBe('assets/avatars/v1/profile8.webp');
  });

  it('a request always refused is one retry, never a loop; a reopening starts over', () => {
    for (let i = 0; i < 5; i++) {
      playerCardsRefused();
      vi.advanceTimersByTime(PLAYER_CARDS_RETRY_MS);
    }
    vi.advanceTimersByTime(600000);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['ivy', 'kim', 'ora']]);
    expect(pic('kim').tagName).toBe('SPAN');
    removePlayerSearchPage();
    socket.emit.mockClear();
    open();
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora']]);
  });

  it('a retry never asks again for a name answered meanwhile', () => {
    online = ['ivy', 'kim', 'ora', 'pat'];
    refreshNow();
    vi.advanceTimersByTime(300);
    playerCardsRefused();
    updatePlayerCards([card('ivy', 31), card('kim', 12), card('ora', 9)]);
    vi.advanceTimersByTime(PLAYER_CARDS_RETRY_MS);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['pat'], ['pat']]);
  });

  it('a refusal after the page closed does nothing', () => {
    removePlayerSearchPage();
    socket.emit.mockClear();
    playerCardsRefused();
    vi.advanceTimersByTime(60000);
    expect(cardCalls()).toEqual([]);
  });

  it('a reconnect\'s mainRoomJoined asks again for the names never answered, with the same list, and ends a hold', () => {
    updatePlayerCards([card('ivy', 31), card('kim', 12)]);
    refreshNow({ rejoined: true });
    vi.advanceTimersByTime(300);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['ora']]);
    // a plain list change does not re-ask
    refreshNow();
    vi.advanceTimersByTime(300);
    expect(cardCalls()).toHaveLength(2);
    // a refusal's hold ends with the new socket (its own rate limit)
    playerCardsRefused();
    refreshNow({ rejoined: true });
    vi.advanceTimersByTime(300);
    expect(cardCalls()).toEqual([['ivy', 'kim', 'ora'], ['ora'], ['ora']]);
    vi.advanceTimersByTime(PLAYER_CARDS_RETRY_MS * 2);
    expect(cardCalls()).toHaveLength(3);
  });

  it('the handler passes a success\'s rows and drops a failure', () => {
    const handlers = new Map();
    const onPlayerCards = vi.fn();
    registerProfileHandlers({ on: (e, fn) => handlers.set(e, fn) }, { onPlayerCards });
    handlers.get('playerCardsResponse')({ success: true, players: [card('kim', 12)] });
    handlers.get('playerCardsResponse')({ success: false, message: 'Database error' });
    expect(onPlayerCards.mock.calls).toEqual([[[card('kim', 12)]]]);
  });
});
