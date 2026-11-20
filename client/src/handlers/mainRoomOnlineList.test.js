/**
 * The main room's online list follows both refreshes the server sends:
 * mainRoomPlayerJoined and mainRoomPlayerLeft (the second was unread until
 * 2026-11-20, so a player who went offline stayed listed until the next join).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerLobbyHandlers } from './lobbyHandlers.js';
import { SERVER_EVENTS } from '../constants/events.js';
import { showMainRoom, removeMainRoom, updateMainRoomOnlineCount } from '../ui/screens/MainRoom.js';

function fakeSocketManager() {
  const handlers = new Map();
  return {
    handlers,
    on(event, fn) { handlers.set(event, fn); },
    onGame(event, fn) { handlers.set(event, fn); },
    emit() {},
  };
}

describe('main room online list', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { removeMainRoom(); vi.restoreAllMocks(); });

  it('mainRoomPlayerLeft reaches its callback with the server list', () => {
    const sm = fakeSocketManager();
    const onMainRoomPlayerLeft = vi.fn();
    registerLobbyHandlers(sm, { onMainRoomPlayerLeft });
    const data = { username: 'bob', onlineCount: 1, onlineUsers: ['ann'] };
    sm.handlers.get(SERVER_EVENTS.MAIN_ROOM_PLAYER_LEFT)(data);
    expect(onMainRoomPlayerLeft).toHaveBeenCalledWith(data);
  });

  it('the count and list shrink when a player leaves, and grow again when they return', () => {
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn(), id: 's1' };
    showMainRoom({ messages: [], lobbies: [], onlineCount: 2, onlineUsers: ['ann', 'bob'], inProgressGames: [], tournaments: [] }, socket, 'ann');
    const count = () => document.getElementById('mainRoomOnlineCount').textContent;
    expect(count()).toBe('2 players online');

    const sm = fakeSocketManager();
    registerLobbyHandlers(sm, {
      onMainRoomPlayerLeft: (d) => updateMainRoomOnlineCount(d.onlineCount, d.onlineUsers),
      onMainRoomPlayerJoined: (d) => updateMainRoomOnlineCount(d.onlineCount, d.onlineUsers),
    });
    sm.handlers.get(SERVER_EVENTS.MAIN_ROOM_PLAYER_LEFT)({ username: 'bob', onlineCount: 1, onlineUsers: ['ann'] });
    expect(count()).toBe('1 players online');
    sm.handlers.get(SERVER_EVENTS.MAIN_ROOM_PLAYER_JOINED)({ username: 'bob', onlineCount: 2, onlineUsers: ['ann', 'bob'] });
    expect(count()).toBe('2 players online');
  });
});
