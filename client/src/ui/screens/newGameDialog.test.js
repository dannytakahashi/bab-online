/**
 * The main room's one "New Game" button (owner 2026-11-26, as iOS's spade
 * menu): its dialog lists Back Alley Bridge, Get Your Bid and Tournament,
 * each with a blurb; one click creates; Escape, the backdrop and Cancel
 * create nothing. "+ Create Tournament" is gone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { showMainRoom, removeMainRoom, showCreateGameDialog, TOURNAMENT_NAME, TOURNAMENT_BLURB } from './MainRoom.js';
import { GYB_NAME, GYB_BLURB } from '../../state/gyb.js';

function fakeSocket() {
  const sent = [];
  return { sent, emit: (event, data) => sent.push(data === undefined ? [event] : [event, data]) };
}

const room = (socket) => showMainRoom({ lobbies: [], inProgressGames: [], tournaments: [], messages: [], onlineUsers: [] }, socket, 'ann');
const $ = (id) => document.getElementById(id);
const dialog = () => $('createGameDialog');

afterEach(() => {
  removeMainRoom();
  document.body.replaceChildren();
});

describe('New Game', () => {
  it('is the only create button: "New Game", no "+ Create Tournament"', () => {
    room(fakeSocket());
    const buttons = [...document.querySelectorAll('#mainRoomContainer .room-create button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['New Game']);
    expect(buttons[0].id).toBe('createGameBtn');
    expect(document.getElementById('mainRoomContainer').textContent).not.toMatch(/Create Tournament|Create Game/);
  });

  it('the dialog: titled "New Game", three choices with their names and blurbs, focus on the first', () => {
    const socket = fakeSocket();
    room(socket);
    $('createGameBtn').click();
    expect(socket.sent).toEqual([]);
    expect(dialog().querySelector('.kit-modal__title').textContent).toBe('New Game');
    const choices = [...dialog().querySelectorAll('.mode-pick__option')].map((b) => ({
      id: b.id,
      name: b.querySelector('.mode-pick__name').textContent,
      blurb: b.querySelector('.mode-pick__blurb').textContent,
    }));
    expect(choices).toEqual([
      { id: 'createGameClassic', name: 'Back Alley Bridge', blurb: '4 players in two teams.' },
      { id: 'createGameGyb', name: GYB_NAME, blurb: GYB_BLURB },
      { id: 'createGameTournament', name: 'Tournament', blurb: 'Several rounds, a new partner each round. The top score wins.' },
    ]);
    expect(TOURNAMENT_NAME).toBe('Tournament');
    expect(TOURNAMENT_BLURB).toBe('Several rounds, a new partner each round. The top score wins.');
    expect(document.activeElement).toBe($('createGameClassic'));
  });

  it.each([
    ['createGameClassic', ['createLobby', {}]],
    ['createGameGyb', ['createLobby', { mode: 'gyb' }]],
    // what "+ Create Tournament" sent (the server answers with tournamentJoined)
    ['createGameTournament', ['createTournament']],
  ])('%s creates at once, once, and closes the dialog (focus back on New Game)', (id, expected) => {
    const socket = fakeSocket();
    room(socket);
    $('createGameBtn').focus();
    $('createGameBtn').click();
    $(id).click();
    expect(socket.sent).toEqual([expected]);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe($('createGameBtn'));
  });

  it('Escape, the backdrop and Cancel create nothing', () => {
    const socket = fakeSocket();
    room(socket);
    $('createGameBtn').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    $('createGameBtn').click();
    dialog().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(dialog()).toBeNull();
    showCreateGameDialog(socket);
    [...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);
  });

  it('leaving the main room closes it', () => {
    const socket = fakeSocket();
    room(socket);
    $('createGameBtn').click();
    removeMainRoom();
    expect(dialog()).toBeNull();
    expect(socket.sent).toEqual([]);
  });
});
