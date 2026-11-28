/**
 * The main room's Players page (2026-11-27): with the search box empty it
 * lists the room's online players (the list the header's count already has),
 * my own name not a button, and follows the room's joins and leaves while
 * it is open; a row opens that player's profile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showMainRoom, removeMainRoom, updateMainRoomOnlineCount } from './MainRoom.js';
import { removePlayerSearchPage } from './PlayerSearchPage.js';

const socket = { emit: vi.fn(() => socket), on: vi.fn(), off: vi.fn() };
const byText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const listed = () => [...document.querySelectorAll('#playerSearchResults .search-result__name')].map((n) => n.textContent);
const heading = () => document.getElementById('playerSearchOnlineHeading')?.textContent;

beforeEach(() => {
  document.body.replaceChildren();
  socket.emit.mockClear();
  showMainRoom({ onlineCount: 3, onlineUsers: ['Owner', 'Bea', 'Cy'], messages: [], lobbies: [] }, socket, 'Owner');
});

afterEach(() => {
  removePlayerSearchPage();
  removeMainRoom();
  document.body.replaceChildren();
});

describe('the Players page from the main room', () => {
  it('opens on who is online, my own name not a button', () => {
    byText('Players').click();
    expect(heading()).toBe('Online now · 3');
    expect(listed()).toEqual(['Owner', 'Bea', 'Cy']);
    const buttons = [...document.querySelectorAll('#playerSearchResults button.search-result')].map((b) => b.dataset.username);
    expect(buttons).toEqual(['Bea', 'Cy']);
    expect(document.activeElement.id).toBe('playerSearchInput'); // the kit's focus: the box
  });

  it('follows a join and a leave while open', () => {
    byText('Players').click();
    updateMainRoomOnlineCount(4, ['Owner', 'Bea', 'Cy', 'Dee']);
    expect(heading()).toBe('Online now · 4');
    updateMainRoomOnlineCount(2, ['Owner', 'Dee']);
    expect(listed()).toEqual(['Owner', 'Dee']);
  });

  it('a rebuild in place (a reconnect) keeps the open page and its list follows the fresh one', () => {
    byText('Players').click();
    expect(heading()).toBe('Online now · 3');
    showMainRoom({ onlineCount: 2, onlineUsers: ['Owner', 'Bea'], messages: [], lobbies: [] }, socket, 'Owner');
    expect(document.getElementById('playerSearchPageOverlay')).not.toBeNull();
    expect(heading()).toBe('Online now · 2');
    expect(listed()).toEqual(['Owner', 'Bea']);
  });

  it('a row opens the profile with the stats scope, as a search result does', () => {
    byText('Players').click();
    document.querySelector('#playerSearchResults button.search-result[data-username="Cy"]').click();
    const call = socket.emit.mock.calls.find(([e]) => e === 'getPlayerProfile');
    expect(call[1]).toMatchObject({ username: 'Cy' });
    expect(document.getElementById('playerSearchPageOverlay')).toBeNull();
  });
});
