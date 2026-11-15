/**
 * Host handoff in the tournament lobby: when the creator leaves, the
 * promoted member gets Begin / Cancel in place (only the host's socket may
 * begin or cancel, so without them the tournament was stuck until a reload).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { showTournamentLobby, updateTournamentPlayers, setTournamentPhase, removeTournamentLobby } from './TournamentLobby.js';

function fakeSocket() {
  const sent = [];
  return { emit: vi.fn((event, data) => sent.push([event, data])), emitted: (e) => sent.filter(([n]) => n === e).map(([, d]) => d) };
}

const lobby = ({ phase = 'lobby', currentRound = 0, isSpectator = false } = {}) => ({
  tournamentId: 't1', name: 'T', creatorUsername: 'bob', phase, currentRound, totalRounds: 4, isSpectator,
  players: [
    { username: 'bob', ready: false, isCreator: true, connected: true },
    { username: 'me', ready: false, isCreator: false, connected: true },
    { username: 'cat', ready: false, isCreator: false, connected: true },
  ],
  messages: [], scoreboard: [], activeGames: [],
});

// tournamentPlayerLeft's players after bob left and the role passed to `host`
const afterBobLeft = (host, ready = {}) => ['me', 'cat'].map((username) => ({
  username, ready: !!ready[username], isCreator: username === host, connected: true,
}));

const begin = () => document.getElementById('tournamentBeginBtn');
const cancel = () => document.getElementById('tournamentCancelBtn');
const buttonLabels = () => [...document.querySelectorAll('#tournamentButtonRow button')].map((b) => b.textContent);

afterEach(() => {
  removeTournamentLobby();
  document.body.replaceChildren();
});

describe('tournament host handoff', () => {
  it('promoted in the lobby: Begin Tournament (disabled until all ready) and Cancel, beside Ready', () => {
    const socket = fakeSocket();
    showTournamentLobby(lobby(), socket, 'me');
    expect(begin()).toBeNull();
    expect(cancel()).toBeNull();

    updateTournamentPlayers(afterBobLeft('me'), 'me', 'me');
    expect(buttonLabels()).toEqual(['Ready', 'Begin Tournament', 'Cancel Tournament', 'Leave']);
    expect(begin().hidden).toBe(false);
    expect(begin().disabled).toBe(true);
    expect(document.getElementById('tournamentLobbyContainer').dataset.isCreator).toBe('true');
    expect(document.querySelector('#tournamentPlayersList .is-host').textContent).toBe('me (host)');

    // the ready gate keeps working on the new button
    updateTournamentPlayers(afterBobLeft('me', { me: true }), 'me');
    expect(begin().disabled).toBe(true);
    updateTournamentPlayers(afterBobLeft('me', { me: true, cat: true }), 'me');
    expect(begin().disabled).toBe(false);
    expect(begin().classList.contains('kit-btn--primary')).toBe(true);

    begin().click();
    expect(socket.emitted('beginTournament')).toHaveLength(1);
    expect(socket.emitted('beginNextRound')).toHaveLength(0);
    expect(begin().disabled).toBe(true);
    cancel().click();
    expect(socket.emitted('cancelTournament')).toHaveLength(1);
  });

  it('promoted from players[].isCreator alone (no newCreator), enabled at once when everyone is ready', () => {
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    updateTournamentPlayers(afterBobLeft('me', { me: true, cat: true }), 'me');
    expect(begin().disabled).toBe(false);
    expect(cancel()).not.toBeNull();
  });

  it('promoted between rounds: Begin Next Round, which sends beginNextRound', () => {
    const socket = fakeSocket();
    showTournamentLobby(lobby({ phase: 'between_rounds', currentRound: 1 }), socket, 'me');
    updateTournamentPlayers(afterBobLeft('me', { me: true, cat: true }), 'me', 'me');
    expect(begin().textContent).toBe('Begin Next Round');
    expect(begin().hidden).toBe(false);
    begin().click();
    expect(socket.emitted('beginNextRound')).toHaveLength(1);
    expect(socket.emitted('beginTournament')).toHaveLength(0);
  });

  it('promoted mid-round: Cancel now, Begin Next Round once the round ends', () => {
    const socket = fakeSocket();
    showTournamentLobby(lobby({ phase: 'round_active', currentRound: 1 }), socket, 'me');
    updateTournamentPlayers(afterBobLeft('me'), 'me', 'me');
    expect(begin().hidden).toBe(true);
    expect(cancel().hidden).toBe(false);
    setTournamentPhase('between_rounds');
    expect(begin().hidden).toBe(false);
    expect(begin().textContent).toBe('Begin Next Round');
    expect(begin().disabled).toBe(true);
    updateTournamentPlayers(afterBobLeft('me', { me: true, cat: true }), 'me');
    begin().click();
    expect(socket.emitted('beginNextRound')).toHaveLength(1);
  });

  it('a member who was not promoted still has no host controls', () => {
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    updateTournamentPlayers(afterBobLeft('cat'), 'me', 'cat');
    expect(begin()).toBeNull();
    expect(cancel()).toBeNull();
    expect(buttonLabels()).toEqual(['Ready', 'Leave']);
    expect(document.getElementById('tournamentLobbyContainer').dataset.isCreator).toBe('false');
  });

  it('a spectator of the same name gets no host controls', () => {
    showTournamentLobby(lobby({ isSpectator: true }), fakeSocket(), 'me');
    updateTournamentPlayers(afterBobLeft('me'), 'me', 'me');
    expect(begin()).toBeNull();
    expect(cancel()).toBeNull();
  });

  it('repeated updates never duplicate the controls', () => {
    const socket = fakeSocket();
    showTournamentLobby(lobby(), socket, 'me');
    updateTournamentPlayers(afterBobLeft('me'), 'me', 'me');
    updateTournamentPlayers(afterBobLeft('me', { me: true }), 'me');
    updateTournamentPlayers(afterBobLeft('me', { me: true, cat: true }), 'me', 'me');
    expect(document.querySelectorAll('#tournamentBeginBtn')).toHaveLength(1);
    expect(document.querySelectorAll('#tournamentCancelBtn')).toHaveLength(1);
    begin().click();
    expect(socket.emitted('beginTournament')).toHaveLength(1);
  });

  it('the first render gates Begin on the ready flags it arrives with', () => {
    const data = lobby();
    data.creatorUsername = 'me';
    data.players = afterBobLeft('me', { me: true, cat: true });
    showTournamentLobby(data, fakeSocket(), 'me');
    expect(begin().disabled).toBe(false);
    expect(document.querySelectorAll('#tournamentBeginBtn')).toHaveLength(1);
  });
});
