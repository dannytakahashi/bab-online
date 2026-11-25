/**
 * Host handoff in the tournament lobby: when the creator leaves, the
 * promoted member gets Begin / Cancel in place (only the host's socket may
 * begin or cancel, so without them the tournament was stuck until a reload).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { showTournamentLobby, updateTournamentPlayers, setTournamentPhase, removeTournamentLobby, addTournamentChatMessage, setReadyDeadlinePassed, updateTournamentPairings, setTournamentTotalRounds, updateTournamentRoundIndicator, updateTournamentScoreboardUI, getTournamentTotalRounds, setTournamentVoiceFull } from './TournamentLobby.js';

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

describe('tournament chat: server notices by the system flag (2026-11-15)', () => {
  const lines = () => [...document.querySelectorAll('#tournamentChatArea .chat-line')];

  it('a notice (system: true) is the message alone, styled as a notice; a player named "System" is a player line', () => {
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    addTournamentChatMessage('System', 'cat is now spectating', false, true);
    addTournamentChatMessage('System', 'cat is now spectating', false);
    const [notice, impostor] = lines();
    expect(notice.classList.contains('is-system')).toBe(true);
    expect(notice.querySelector('.chat-line__name')).toBeNull();
    expect(notice.textContent).toBe('cat is now spectating');
    expect(impostor.classList.contains('is-system')).toBe(false);
    expect(impostor.querySelector('.chat-line__name').textContent).toBe('System: ');
  });

  it('the joiner\'s history renders by the same flag', () => {
    const data = lobby();
    data.messages = [
      { username: 'System', message: 'notice', isSpectator: false, timestamp: 1, system: true },
      { username: 'System', message: 'player', isSpectator: false, timestamp: 2 },
    ];
    showTournamentLobby(data, fakeSocket(), 'me');
    expect(lines().map((l) => l.classList.contains('is-system'))).toEqual([true, false]);
  });
});

describe('between rounds: the ready deadline and the idle-host hand-off (2026-11-15)', () => {
  // I am the host between rounds 1 and 2
  const hosting = (ready = {}, extra = {}) => ({
    ...lobby({ phase: 'between_rounds', currentRound: 1 }),
    creatorUsername: 'me',
    players: ['me', 'cat', 'dan'].map((username) => ({ username, ready: !!ready[username], isCreator: username === 'me', connected: true })),
    ...extra,
  });
  const statuses = () => [...document.querySelectorAll('#tournamentPlayersList .seat-row__status')].map((s) => s.textContent);

  it('before the deadline Begin waits for everyone; after it, the ready host may start with the ready players', () => {
    const socket = fakeSocket();
    showTournamentLobby(hosting({ me: true, cat: true }), socket, 'me');
    expect(begin().textContent).toBe('Begin Next Round');
    expect(begin().disabled).toBe(true);
    expect(statuses()).toEqual(['Ready', 'Ready', 'Waiting']);

    setReadyDeadlinePassed(true);
    expect(begin().disabled).toBe(false);
    expect(begin().textContent).toBe('Start with ready players');
    expect(statuses()).toEqual(['Ready', 'Ready', 'Sitting out']);
    begin().click();
    expect(socket.emitted('beginNextRound')).toHaveLength(1);
  });

  it('past the deadline the host may start without readying (Begin puts the host in) and is never listed sitting out; everyone ready is the plain Begin Next Round', () => {
    showTournamentLobby(hosting({ cat: true }, { readyDeadlinePassed: true }), fakeSocket(), 'me');
    expect(begin().disabled).toBe(false);
    expect(begin().textContent).toBe('Start with ready players');
    expect(statuses()).toEqual(['Waiting', 'Ready', 'Sitting out']);
    updateTournamentPlayers(hosting({ me: true, cat: true, dan: true }).players, 'me');
    expect(begin().disabled).toBe(false);
    expect(begin().textContent).toBe('Begin Next Round');
  });

  it('a new between-rounds wait starts without the deadline', () => {
    showTournamentLobby(hosting({ me: true }, { readyDeadlinePassed: true }), fakeSocket(), 'me');
    setTournamentPhase('round_active');
    setTournamentPhase('between_rounds');
    updateTournamentPlayers(hosting({ me: true }).players, 'me');
    expect(begin().disabled).toBe(true);
    expect(begin().textContent).toBe('Begin Next Round');
  });

  it('the hand-off takes the controls from me while I am still here, and gives them back once', () => {
    showTournamentLobby(hosting({ cat: true, dan: true }), fakeSocket(), 'me');
    expect(cancel()).not.toBeNull();
    const players = hosting({ cat: true, dan: true }).players.map((p) => ({ ...p, isCreator: p.username === 'cat' }));
    updateTournamentPlayers(players, 'me', 'cat');
    expect(begin()).toBeNull();
    expect(cancel()).toBeNull();
    expect(buttonLabels()).toEqual(['Ready', 'Leave']);
    expect(document.getElementById('tournamentLobbyContainer').dataset.isCreator).toBe('false');
    updateTournamentPlayers(players.map((p) => ({ ...p, isCreator: p.username === 'me' })), 'me', 'me');
    expect(document.querySelectorAll('#tournamentBeginBtn')).toHaveLength(1);
    expect(document.querySelectorAll('#tournamentCancelBtn')).toHaveLength(1);
  });

  it('a ready update naming me as host never removes the controls', () => {
    showTournamentLobby(hosting(), fakeSocket(), 'me');
    updateTournamentPlayers(hosting({ cat: true }).players, 'me');
    expect(cancel()).not.toBeNull();
  });
});

describe('tournament voice: the over-cap notice (2026-11-25, s2c tournamentVoiceStatus)', () => {
  const note = () => document.getElementById('tournamentVoiceFull');

  it('"Voice is full (N people)" beside the voice slot while waiting in line, cleared when let in', () => {
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    expect(note()).toBeNull();
    setTournamentVoiceFull(12);
    expect(note().textContent).toBe('Voice is full (12 people)');
    expect(note().getAttribute('role')).toBe('status');
    // in the header, just before the voice slot
    expect(note().nextElementSibling.id).toBe('lobbyVoiceSlot');
    setTournamentVoiceFull(20);
    expect(document.querySelectorAll('#tournamentVoiceFull')).toHaveLength(1);
    expect(note().textContent).toBe('Voice is full (20 people)');
    setTournamentVoiceFull(null);
    expect(note()).toBeNull();
  });

  it('kept across a redraw of the lobby (every tournamentJoined), gone with the screen', () => {
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    setTournamentVoiceFull(8);
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    expect(note().textContent).toBe('Voice is full (8 people)');
    removeTournamentLobby();
    expect(note()).toBeNull();
    // no lobby on screen: nothing drawn
    setTournamentVoiceFull(8);
    expect(note()).toBeNull();
  });

  it('a cap that is not a whole number still says the room is full', () => {
    showTournamentLobby(lobby(), fakeSocket(), 'me');
    setTournamentVoiceFull('x');
    expect(note().textContent).toBe('Voice is full');
  });
});

describe('the round pairings and Partners so far (2026-11-25)', () => {
  const PAIRINGS = [
    { roundNumber: 1, tables: [{ gameId: 'g1', teams: [['me', 'cat'], ['bob', null]] }] },
  ];
  const section = () => document.getElementById('tournamentPairings');

  it('hidden in the lobby phase (no pairings key), shown from tournamentJoined and updated by the events', () => {
    const socket = fakeSocket();
    showTournamentLobby(lobby(), socket, 'me');
    expect(section().hidden).toBe(true);
    updateTournamentPairings([{ roundNumber: 1, tables: [{ gameId: null, teams: [['me', 'cat'], ['bob', null]] }] }]);
    expect(section().hidden).toBe(false);
    expect(section().querySelector('h3').textContent).toBe('Round 1 pairings');
    expect(section().querySelector('.tournament-pairings__row').textContent).toBe('You & cat vs bob & a bot');
    // a payload without pairings changes nothing
    updateTournamentPairings(undefined);
    expect(section().hidden).toBe(false);
  });

  it('a returning member: the state\'s pairings with Partners so far', () => {
    showTournamentLobby({ ...lobby({ phase: 'between_rounds', currentRound: 1 }), pairings: PAIRINGS }, fakeSocket(), 'me');
    expect([...section().querySelectorAll('.tournament-pairings__partner')].map((r) => r.textContent)).toEqual(['Round 1 · cat']);
  });

  it('a spectator: the tables, no Partners so far', () => {
    showTournamentLobby({ ...lobby({ phase: 'round_active', currentRound: 1, isSpectator: true }), pairings: PAIRINGS }, fakeSocket(), 'zed');
    expect(section().querySelector('.tournament-pairings__row').textContent).toBe('me & cat vs bob & a bot');
    expect(section().querySelector('.tournament-pairings__partners')).toBeNull();
  });
});

describe('the host picks the number of rounds (2026-11-25)', () => {
  const picker = () => document.getElementById('tournamentRoundsPicker');
  const checked = () => picker()?.querySelector('[aria-checked="true"]')?.textContent;
  const option = (n) => picker().querySelector(`[data-rounds="${n}"]`);
  const indicator = () => document.getElementById('tournamentRoundIndicator').textContent;
  const columns = () => [...document.querySelectorAll('#tournamentScoreboardContainer th')].map((th) => th.textContent);
  const SCORES = [{ username: 'bob', totalScore: 0, roundScores: [] }, { username: 'me', totalScore: 0, roundScores: [] }];

  it('the host: a Rounds radio group 1 to 5 above Begin, 4 by default; a pick is sent and shown at once', () => {
    const socket = fakeSocket();
    showTournamentLobby({ ...lobby(), scoreboard: SCORES }, socket, 'bob');
    expect(picker()).not.toBeNull();
    expect(picker().nextElementSibling.id).toBe('tournamentButtonRow');
    expect(picker().querySelector('[role="radiogroup"]').getAttribute('aria-labelledby')).toBe('tournamentRoundsLabel');
    expect([...picker().querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['1', '2', '3', '4', '5']);
    expect(checked()).toBe('4');
    expect(indicator()).toBe('Waiting to start · 4 rounds');
    expect(columns()).toEqual(['#', 'Player', 'R1', 'R2', 'R3', 'R4', 'Total']);

    option(2).click();
    expect(socket.emitted('setTournamentRounds')).toEqual([{ totalRounds: 2 }]);
    expect(checked()).toBe('2');
    expect(indicator()).toBe('Waiting to start · 2 rounds');
    expect(columns()).toEqual(['#', 'Player', 'R1', 'R2', 'Total']);
    expect(getTournamentTotalRounds()).toBe(2);
    // the same count again sends nothing
    option(2).click();
    expect(socket.emitted('setTournamentRounds')).toHaveLength(1);
  });

  it('keyboard: one tab stop, the arrows move and select, Home / End', () => {
    const socket = fakeSocket();
    showTournamentLobby(lobby(), socket, 'bob');
    expect([...picker().querySelectorAll('[role="radio"]')].map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
    const group = picker().querySelector('[role="radiogroup"]');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(checked()).toBe('5');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(checked()).toBe('1');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(checked()).toBe('5');
    expect(document.activeElement).toBe(option(5));
    expect(socket.emitted('setTournamentRounds').map((d) => d.totalRounds)).toEqual([5, 1, 5]);
  });

  it('members and spectators: no picker; the round line, columns and a host\'s picker follow tournamentSettingsUpdated', () => {
    showTournamentLobby({ ...lobby(), scoreboard: SCORES }, fakeSocket(), 'me');
    expect(picker()).toBeNull();
    setTournamentTotalRounds(1);
    expect(indicator()).toBe('Waiting to start · 1 round');
    expect(columns()).toEqual(['#', 'Player', 'R1', 'Total']);
    setTournamentTotalRounds(6); // never a count the server refuses
    expect(indicator()).toBe('Waiting to start · 1 round');
    removeTournamentLobby();

    showTournamentLobby({ ...lobby({ isSpectator: true }), totalRounds: 3 }, fakeSocket(), 'zed');
    expect(picker()).toBeNull();
    expect(indicator()).toBe('Waiting to start · 3 rounds');
    removeTournamentLobby();

    showTournamentLobby(lobby(), fakeSocket(), 'bob');
    setTournamentTotalRounds(3);
    expect(checked()).toBe('3');
  });

  it('gone once the tournament begins: "Round x of N" and N columns from there on', () => {
    showTournamentLobby({ ...lobby(), totalRounds: 2, scoreboard: SCORES }, fakeSocket(), 'bob');
    expect(checked()).toBe('2');
    updateTournamentRoundIndicator(1, 2);
    setTournamentPhase('round_active');
    expect(picker()).toBeNull();
    expect(indicator()).toBe('Round 1 of 2');
    updateTournamentScoreboardUI([{ username: 'bob', totalScore: 120, roundScores: [120] }], 1, 2);
    expect(columns()).toEqual(['#', 'Player', 'R1', 'R2', 'Total']);
    setTournamentPhase('between_rounds');
    expect(picker()).toBeNull();
  });

  it('a returning host between rounds gets no picker; a hand-off in the lobby moves it', () => {
    showTournamentLobby({ ...lobby({ phase: 'between_rounds', currentRound: 1 }), totalRounds: 2 }, fakeSocket(), 'bob');
    expect(picker()).toBeNull();
    expect(indicator()).toBe('Round 1 of 2');
    removeTournamentLobby();

    const socket = fakeSocket();
    showTournamentLobby({ ...lobby(), totalRounds: 5 }, socket, 'me');
    expect(picker()).toBeNull();
    updateTournamentPlayers(afterBobLeft('me'), 'me', 'me');
    expect(checked()).toBe('5');
    option(3).click();
    expect(socket.emitted('setTournamentRounds')).toEqual([{ totalRounds: 3 }]);
    // the role moves on again: the picker goes with Begin and Cancel
    updateTournamentPlayers(afterBobLeft('cat'), 'me', 'cat');
    expect(picker()).toBeNull();
    expect(begin()).toBeNull();
  });
});
