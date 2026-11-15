/**
 * A reconnect in the main room re-enters it (mainRoomJoined rebuilds the
 * screen). The rebuild used to close the admin panel (losing a one-time
 * reset link, which the server never shows again) and the chat draft
 * (later #17). Now it rebuilds in place: the panel stays, the draft (its
 * caret and focus too) moves into the new input. Leaving the room still
 * closes the panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showMainRoom, removeMainRoom } from './MainRoom.js';
import { showAdminPanel, removeAdminPanel } from './AdminPanel.js';
import { setIsAdmin } from '../../admin/adminApi.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const socket = { emit: vi.fn(() => socket), on: vi.fn(), off: vi.fn() };
const room = (extra = {}) => ({ onlineCount: 2, onlineUsers: ['Owner', 'Bea'], messages: [], lobbies: [], ...extra });
const input = () => document.getElementById('mainRoomChatInput');
const $ = (sel) => document.querySelector(sel);
const byText = (text, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);

const PLAYERS = [
  { username: 'Bea', createdAt: null, lastSeenAt: null, online: true, gamesPlayed: 1, botGamesPlayed: 0, isAdmin: false, mergedInto: null },
];
function fakeApi() {
  return {
    request: vi.fn(async (action, args) => {
      if (action === 'listPlayers' || action === 'searchPlayers') return { ok: true, players: PLAYERS };
      if (action === 'createResetLink') return { ok: true, username: args.username, token: 'R'.repeat(43), expiresAt: '2026-11-16T12:00:00.000Z' };
      return { ok: true };
    }),
    dispose() {},
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  setIsAdmin(true);
});

afterEach(() => {
  removeMainRoom();
  setIsAdmin(false);
  document.body.replaceChildren();
});

describe('the main room rebuilt by a reconnect', () => {
  it('keeps the chat draft, its caret and focus', () => {
    showMainRoom(room(), socket, 'Owner');
    input().value = 'half a thought';
    input().focus();
    input().setSelectionRange(4, 6);
    const old = input();
    showMainRoom(room({ onlineCount: 3 }), socket, 'Owner');
    expect(input()).not.toBe(old); // a new screen
    expect(input().value).toBe('half a thought');
    expect(document.activeElement).toBe(input());
    expect([input().selectionStart, input().selectionEnd]).toEqual([4, 6]);
    expect($('#mainRoomOnlineCount').textContent).toBe('3 players online');
  });

  it('a draft without focus is kept and does not take focus', () => {
    showMainRoom(room(), socket, 'Owner');
    input().value = 'later';
    byText('Records').focus();
    showMainRoom(room(), socket, 'Owner');
    expect(input().value).toBe('later');
    expect(document.activeElement).not.toBe(input());
  });

  it('keeps the admin panel open with the reset link it shows', async () => {
    showMainRoom(room(), socket, 'Owner');
    showAdminPanel(socket, { username: 'Owner', api: fakeApi() });
    await flush();
    const row = [...document.querySelectorAll('#adminPlayerTable tbody tr')].find((r) => r.textContent.includes('Bea'));
    byText('Reset link', row).click();
    await flush();
    const link = $('#adminResetLinkInput').value;
    expect(link).toMatch(/\/reset#R{43}$/);
    showMainRoom(room(), socket, 'Owner');
    expect($('#adminPanelOverlay')).not.toBeNull();
    expect($('#adminResetLinkInput').value).toBe(link);
    expect($('#adminResetLink').hidden).toBe(false);
    // one main room, one Admin entry
    expect(document.querySelectorAll('#mainRoomContainer')).toHaveLength(1);
    expect(document.querySelectorAll('#mainRoomAdminButton')).toHaveLength(1);
  });

  it('leaving the room (removeMainRoom) still closes the panel', async () => {
    showMainRoom(room(), socket, 'Owner');
    showAdminPanel(socket, { username: 'Owner', api: fakeApi() });
    await flush();
    removeMainRoom();
    expect($('#adminPanelOverlay')).toBeNull();
    removeAdminPanel();
  });

  it('a first entry (no room on screen) starts with an empty draft', () => {
    showMainRoom(room(), socket, 'Owner');
    expect(input().value).toBe('');
  });
});
