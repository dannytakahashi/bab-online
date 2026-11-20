/**
 * The DOM screens (item 18b): user text is always text (audit finding
 * ui-13: a username like <img src=x onerror=...> renders as those
 * characters, never as an element), every dialog is a kit Modal (focus
 * trap, Escape only where safe, stacking, focus restore), and nothing uses
 * window.alert / prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom } from './MainRoom.js';
import { showGameLobby, addLobbyChatMessage, removeGameLobby, updateLobbyPlayersList } from './GameLobby.js';
import { showTournamentLobby, addTournamentChatMessage, updateTournamentPlayers, updateTournamentActiveGames, removeTournamentLobby } from './TournamentLobby.js';
import { showProfilePage, showPlayerProfilePage, removeProfilePage, removePlayerProfilePage, handleFileUpload } from './ProfilePage.js';
import { showLeaderboardPage, removeLeaderboardPage } from './LeaderboardPage.js';
import { showRecordsPage, removeRecordsPage } from './RecordsPage.js';
import { showPlayerQueue, removePlayerQueue } from '../components/PlayerQueue.js';
import { showResignationDialog, dismissResignationDialog } from '../components/ResignationDialog.js';
import { openModalCount, clearToasts, createButton } from '../kit/index.js';

const EVIL = '<img src=x onerror="window.__xss=1">';
const key = (k, opts = {}) => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });

/** Elements an injected payload would have created. */
function injected() {
  return [...document.querySelectorAll('img')].filter((i) => i.getAttribute('src') === 'x' || i.hasAttribute('onerror'));
}

function fakeSocket() {
  const sent = [];
  return { sent, emit: vi.fn((event, data) => sent.push([event, data])), emitted: (e) => sent.filter(([n]) => n === e).map(([, d]) => d) };
}

let socket;
let alertSpy;
let promptSpy;
let confirmSpy;

beforeEach(() => {
  socket = fakeSocket();
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => 'typed in a prompt');
  confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => true);
  delete window.__xss;
});

afterEach(() => {
  removeMainRoom();
  removeGameLobby();
  removeTournamentLobby();
  removeProfilePage();
  removePlayerProfilePage();
  removeLeaderboardPage();
  removeRecordsPage();
  removePlayerQueue();
  dismissResignationDialog();
  clearToasts();
  document.body.replaceChildren();
  expect(alertSpy).not.toHaveBeenCalled();
  expect(promptSpy).not.toHaveBeenCalled();
  expect(confirmSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  expect(openModalCount()).toBe(0);
});

describe('user text is text (ui-13)', () => {
  it('main room: chat, lobby names and seats, in-progress players, tournament names, online list', () => {
    showMainRoom({
      onlineCount: 2,
      onlineUsers: [EVIL],
      messages: [{ username: EVIL, message: EVIL, timestamp: 1700000000000 }],
      lobbies: [{ id: 'L1', name: EVIL, playerCount: 1, maxPlayers: 4, players: [{ username: EVIL, ready: false }], createdAt: 1 }],
      inProgressGames: [{
        gameId: 'g1', currentHand: 2, spectatorCount: 0, score: { team1: 10, team2: 20 },
        players: [1, 2, 3, 4].map((position) => ({ position, username: EVIL })),
      }],
      tournaments: [{ id: 't1', name: EVIL, phase: 'lobby', playerCount: 1 }],
    }, socket, 'me');
    addMainRoomChatMessage(EVIL, EVIL, Date.now());
    updateLobbyList([{ id: 'L2', name: EVIL, playerCount: 4, maxPlayers: 4, players: [{ username: EVIL, ready: true }], createdAt: 1 }], socket, [], []);

    const room = document.getElementById('mainRoomContainer');
    expect(injected()).toEqual([]);
    expect(room.querySelector('#mainRoomChatMessages').textContent).toContain(`${EVIL}: ${EVIL}`);
    expect(room.querySelector('#mainRoomLobbyList').textContent).toContain(EVIL);
    expect(document.getElementById('onlinePlayersTooltip').textContent).toBe(EVIL);
    expect(window.__xss).toBeUndefined();
  });

  it('main room: the in-progress score is in the team colors (team A blue, team B coral)', () => {
    showMainRoom({
      onlineCount: 1, messages: [], lobbies: [], tournaments: [],
      inProgressGames: [{
        gameId: 'g1', currentHand: 2, spectatorCount: 3, score: { team1: 10, team2: 20 },
        players: [{ position: 1, username: 'ann' }, { position: 2, username: 'bob' }, { position: 3, username: 'cat' }, { position: 4, username: 'dan' }],
      }],
    }, socket, 'me');
    const list = document.getElementById('mainRoomLobbyList');
    expect(list.querySelector('.team-a').textContent).toBe('ann/cat: 10');
    expect(list.querySelector('.team-b').textContent).toBe('bob/dan: 20');
    expect(list.textContent).toContain('3 watching');
  });

  it('game lobby: seats, chat, the remove-bot button name', () => {
    showGameLobby({
      lobbyId: 'L1',
      players: [{ username: EVIL, isBot: true, ready: false, socketId: 'bot:1' }, { username: 'me', ready: false }],
      messages: [{ username: EVIL, message: EVIL }],
    }, socket, 'me');
    addLobbyChatMessage(EVIL, EVIL);
    expect(injected()).toEqual([]);
    const lobby = document.getElementById('gameLobbyContainer');
    expect(lobby.querySelector('#lobbyPlayersList').textContent).toContain(EVIL);
    expect(lobby.querySelector('#lobbyChatArea').textContent).toBe(`${EVIL}: ${EVIL}${EVIL}: ${EVIL}`);
    const remove = lobby.querySelector('[data-bot-socket-id]');
    expect(remove.getAttribute('aria-label')).toBe(`Remove ${EVIL}`);
    remove.click();
    expect(socket.emitted('removeBot')).toEqual([{ botSocketId: 'bot:1' }]);
  });

  it('tournament lobby: name, players, chat, active games', () => {
    showTournamentLobby({
      tournamentId: 't1', name: EVIL, creatorUsername: 'me', phase: 'lobby', currentRound: 0, totalRounds: 4,
      players: [{ username: EVIL, isCreator: true, ready: true }], messages: [{ username: EVIL, message: EVIL }],
      scoreboard: [], activeGames: [],
    }, socket, 'me');
    addTournamentChatMessage(EVIL, EVIL, true);
    updateTournamentPlayers([{ username: EVIL, ready: false }], 'me');
    updateTournamentActiveGames([{ status: 'active', humanPlayers: [EVIL], botCount: 2, gameId: 'g9' }], socket);
    expect(injected()).toEqual([]);
    const t = document.getElementById('tournamentLobbyContainer');
    expect(t.querySelector('h1').textContent).toBe(EVIL);
    expect(t.querySelector('#tournamentChatArea').textContent).toContain(`${EVIL}: ${EVIL}`);
    expect(t.querySelector('#tournamentActiveGames').textContent).toContain(`${EVIL} +2 bots`);
    expect(t.querySelector('#tournamentActiveGames').hidden).toBe(false);
  });

  it('own and other profiles, leaderboard, records, queue, the resignation offer', () => {
    showProfilePage({ username: EVIL, profilePic: 3, stats: { gamesPlayed: 2, wins: 1 } }, socket);
    expect(document.querySelector('#profilePageModal .kit-modal__title').textContent).toBe(EVIL);
    removeProfilePage();
    showPlayerProfilePage({ username: EVIL, profilePic: 3, stats: {} }, socket);
    expect(document.querySelector('#playerProfilePageModal .profile-hero__name').textContent).toBe(EVIL);
    removePlayerProfilePage();
    showLeaderboardPage([{
      username: EVIL, gamesPlayed: 1, winRate: 100, pointsPerGame: 1, bidsPerGame: 1, tricksPerBid: 1, setRate: 0, drag: 0, avgHSI: 1,
    }], socket);
    expect(document.querySelector('#leaderboardPageModal .lb-player').textContent).toBe(EVIL);
    removeLeaderboardPage();
    const rec = { highestScore: { score: 1, players: [EVIL] }, lowestScore: null, biggestWin: { margin: 5, winnerScore: 9, loserScore: 4, winnerPlayers: [EVIL], loserPlayers: [EVIL] }, mostBags: null, leastBags: null };
    showRecordsPage({ allTime: rec, thisYear: null, thisMonth: rec }, 12);
    expect(document.getElementById('recordsPageModal').textContent).toContain(`W: ${EVIL}`);
    removeRecordsPage();
    showPlayerQueue([{ username: EVIL }]);
    expect(document.getElementById('queueContainer').textContent).toContain(`1. ${EVIL}`);
    showResignationDialog({ position: 2, username: EVIL, onConfirm: () => {} });
    expect(document.getElementById('resign-message').textContent).toBe(`${EVIL} did not reconnect. Replace with a bot?`);
    expect(injected()).toEqual([]);
    expect(window.__xss).toBeUndefined();
  });
});

describe('every dialog is a kit Modal', () => {
  let opener;
  beforeEach(() => {
    opener = createButton({ label: 'Profile' });
    document.body.appendChild(opener);
    opener.focus();
  });

  it('the profile is a labelled dialog; Escape closes it and focus goes back', () => {
    showProfilePage({ username: 'me', profilePic: 3, stats: {} }, socket);
    const dialog = document.getElementById('profilePageModal');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('me');
    expect(dialog.querySelector('.kit-modal__close').getAttribute('aria-label')).toBe('Close profile');
    expect(dialog.contains(document.activeElement)).toBe(true);
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('profilePageOverlay')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('the avatar picker stacks over the profile: Tab stays in it, Escape closes it alone, focus returns to Choose Avatar', () => {
    showProfilePage({ username: 'me', profilePic: 5, stats: {} }, socket);
    const choose = [...document.querySelectorAll('#profilePageModal button')].find((b) => b.textContent === 'Choose Avatar');
    choose.focus();
    choose.click();
    const picker = document.querySelector('#profilePicSelector [role="dialog"]');
    expect(picker).not.toBeNull();
    expect(openModalCount()).toBe(2);
    // focus starts on the current picture
    expect(document.activeElement.getAttribute('aria-label')).toBe('Avatar 5');
    expect(document.activeElement.getAttribute('aria-pressed')).toBe('true');
    // Tab from the last avatar wraps inside the picker, not into the profile
    const options = picker.querySelectorAll('.avatar-option');
    expect(options).toHaveLength(82);
    options[81].focus();
    document.dispatchEvent(key('Tab'));
    expect(picker.contains(document.activeElement)).toBe(true);
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('profilePicSelector')).toBeNull();
    expect(document.getElementById('profilePageOverlay')).not.toBeNull();
    expect(document.activeElement).toBe(choose);
    // a pick sends it and closes the picker
    choose.click();
    document.querySelector('#profilePicSelector [aria-label="Avatar 7"]').click();
    expect(socket.emitted('updateProfilePic')).toEqual([{ profilePic: 7 }]);
    expect(document.getElementById('profilePicSelector')).toBeNull();
    removeProfilePage();
  });

  it('a picture of the wrong type is refused with an error toast (no alert)', async () => {
    const input = { files: [{ type: 'text/plain' }], value: 'x.txt' };
    await handleFileUpload({ target: input }, socket);
    expect(document.querySelector('.kit-toast.toast-error').textContent).toBe('Invalid file type. Please use PNG, JPEG, GIF, or WebP.');
    expect(socket.emitted('uploadProfilePic')).toEqual([]);
    expect(input.value).toBe('');
  });

  it('report: a kit Modal with a labelled reason; Send needs a reason, sends it trimmed, focus returns', () => {
    showPlayerProfilePage({ username: 'bob', profilePic: 2, stats: {} }, socket);
    const report = [...document.querySelectorAll('#playerProfilePageModal button')].find((b) => b.textContent === 'Report');
    report.focus();
    report.click();
    const dialog = document.querySelector('#reportUserDialog [role="dialog"]');
    expect(dialog).not.toBeNull();
    const reason = dialog.querySelector('textarea');
    expect(document.activeElement).toBe(reason);
    expect(dialog.querySelector(`label[for="${reason.id}"]`).textContent).toBe('What did bob do?');
    const send = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Send Report');
    expect(send.disabled).toBe(true);
    reason.value = `  ${EVIL}  `;
    reason.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(false);
    send.click();
    expect(socket.emitted('reportUser')).toEqual([{ username: 'bob', reason: EVIL, context: '' }]);
    expect(document.getElementById('reportUserDialog')).toBeNull();
    expect(document.activeElement).toBe(report);
    expect(injected()).toEqual([]);
  });

  it('block asks first (kit Modal; Escape keeps them), unblock does not', () => {
    showPlayerProfilePage({ username: 'bob', profilePic: 2, stats: {} }, socket, { isBlocked: false });
    const block = document.getElementById('playerBlockButton');
    expect(block.textContent).toBe('Block');
    block.click();
    expect(document.querySelector('#blockUserDialog [role="dialog"]')).not.toBeNull();
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('blockUserDialog')).toBeNull();
    // the profile under it is still open
    expect(document.getElementById('playerProfilePageOverlay')).not.toBeNull();
    expect(socket.emitted('blockUser')).toEqual([]);
    block.click();
    [...document.querySelectorAll('#blockUserDialog button')].find((b) => b.textContent === 'Block').click();
    expect(socket.emitted('blockUser')).toEqual([{ username: 'bob' }]);
    expect(block.textContent).toBe('Unblock');
    expect(block.getAttribute('aria-pressed')).toBe('true');
    block.click();
    expect(socket.emitted('unblockUser')).toEqual([{ username: 'bob' }]);
    expect(document.getElementById('blockUserDialog')).toBeNull();
  });

  it('leaderboard and records are kit Modals with a named close button', () => {
    showLeaderboardPage([], socket);
    expect(document.querySelector('#leaderboardPageOverlay [role="dialog"]').id).toBe('leaderboardPageModal');
    document.querySelector('#leaderboardPageModal .kit-modal__close').click();
    expect(document.getElementById('leaderboardPageOverlay')).toBeNull();
    expect(document.activeElement).toBe(opener);

    showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0);
    expect(document.querySelector('#recordsPageModal .kit-modal__close').getAttribute('aria-label')).toBe('Close records');
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('recordsPageOverlay')).toBeNull();
  });

  it('the leaderboard sorts from the keyboard: the header is a button and the column carries aria-sort', () => {
    const rows = [
      { username: 'a', gamesPlayed: 5, winRate: 10, pointsPerGame: 1, bidsPerGame: 1, tricksPerBid: 1, setRate: 1, drag: 1, avgHSI: 1 },
      { username: 'b', gamesPlayed: 9, winRate: 50, pointsPerGame: 1, bidsPerGame: 1, tricksPerBid: 1, setRate: 1, drag: 1, avgHSI: 1 },
    ];
    showLeaderboardPage(rows, socket);
    const th = () => document.querySelector('#leaderboardPageModal th.lb-col--gamesPlayed');
    expect(document.querySelector('th.lb-col--winRate').getAttribute('aria-sort')).toBe('descending');
    th().querySelector('button').click();
    expect(th().getAttribute('aria-sort')).toBe('descending');
    expect(document.activeElement).toBe(th().querySelector('button'));
    th().querySelector('button').click();
    expect(th().getAttribute('aria-sort')).toBe('ascending');
    expect([...document.querySelectorAll('.lb-player span')].map((s) => s.textContent)).toEqual(['a', 'b']);
  });

  it('the resignation offer: Wait keeps waiting, Replace with Bot confirms, playerReconnected for that seat closes it', () => {
    const onConfirm = vi.fn();
    showResignationDialog({ position: 2, username: 'bob', onConfirm });
    const backdrop = document.getElementById('resignation-dialog');
    expect(backdrop.dataset.position).toBe('2');
    expect(backdrop.querySelector('[role="dialog"]')).not.toBeNull();
    document.getElementById('resign-cancel-btn').click();
    expect(document.getElementById('resignation-dialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    showResignationDialog({ position: 2, username: 'bob', onConfirm });
    dismissResignationDialog(3);
    expect(document.getElementById('resignation-dialog')).not.toBeNull();
    document.getElementById('resign-confirm-btn').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.getElementById('resignation-dialog')).toBeNull();

    showResignationDialog({ position: 4, username: 'dan', onConfirm });
    dismissResignationDialog(4);
    expect(document.getElementById('resignation-dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('an idle-seat offer (resignationAvailable idle: true) says idle, not disconnected, and confirms the same way', () => {
    const onConfirm = vi.fn();
    showResignationDialog({ position: 3, username: 'cat', onConfirm, idle: true });
    const backdrop = document.getElementById('resignation-dialog');
    expect(backdrop.querySelector('.kit-modal__title').textContent).toBe('Player Idle');
    expect(document.getElementById('resign-message').textContent).toBe('cat seems idle. Replace with a bot?');
    document.getElementById('resign-confirm-btn').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    showResignationDialog({ position: 3, username: 'cat', onConfirm: () => {} });
    expect(document.querySelector('#resignation-dialog .kit-modal__title').textContent).toBe('Player Disconnected');
    // the server withdraws an idle offer with playerReconnected for the seat
    dismissResignationDialog(3);
    expect(document.getElementById('resignation-dialog')).toBeNull();
  });

  it('the resignation offer is sent once, so only Wait or Replace closes it: no Escape, no backdrop click, no stolen keystroke', () => {
    // a player typing in the table chat when the offer arrives
    const chat = document.createElement('input');
    chat.id = 'chatInput';
    document.body.appendChild(chat);
    chat.focus();
    const onConfirm = vi.fn();
    showResignationDialog({ position: 2, username: 'bob', onConfirm });
    const backdrop = document.getElementById('resignation-dialog');
    const dialog = backdrop.querySelector('[role="dialog"]');
    // focus is on the dialog, not on Wait: a Space / Enter mid-sentence presses nothing
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement.id).not.toBe('resign-cancel-btn');
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('resignation-dialog')).not.toBeNull();
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(document.getElementById('resignation-dialog')).not.toBeNull();
    document.getElementById('resign-cancel-btn').click();
    expect(document.getElementById('resignation-dialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    // focus is back in the chat input
    expect(document.activeElement).toBe(chat);
  });

  it('the tournament lobby draws one scoreboard frame: the wrapper is not .tournament-scoreboard', () => {
    showTournamentLobby({
      tournamentId: 't1', name: 'T', creatorUsername: 'me', phase: 'lobby', currentRound: 0, totalRounds: 4,
      players: [{ username: 'me', ready: false }], messages: [], scoreboard: [], activeGames: [],
    }, socket, 'me');
    const wrap = document.getElementById('tournamentScoreboardContainer');
    expect(wrap.classList.contains('tournament-scoreboard')).toBe(false);
    expect(wrap.classList.contains('tournament-scoreboard-wrap')).toBe(true);
    const boards = document.querySelectorAll('#tournamentLobbyContainer .tournament-scoreboard');
    expect(boards).toHaveLength(1);
    expect(boards[0].parentElement).toBe(wrap);
  });

  it('long names: a lobby seat and a tournament scoreboard row carry the full name as a tooltip; the board truncates it', () => {
    const LONG = 'x'.repeat(50);
    showGameLobby({ lobbyId: 'L1', players: [{ username: LONG, ready: false }, { username: 'me', ready: false }], messages: [] }, socket, 'me');
    const seat = [...document.querySelectorAll('#lobbyPlayersList .seat-row__name')].find((n) => n.textContent === LONG);
    expect(seat.getAttribute('title')).toBe(LONG);
    removeGameLobby();
    showTournamentLobby({
      tournamentId: 't1', name: 'T', creatorUsername: 'me', phase: 'round_active', currentRound: 1, totalRounds: 4,
      players: [{ username: LONG, ready: true }], messages: [], activeGames: [],
      scoreboard: [{ username: LONG, totalScore: 120, roundScores: [120] }],
    }, socket, 'me');
    const cell = document.querySelector('#tournamentScoreboardContainer .tsb-name');
    expect(cell.getAttribute('title')).toBe(LONG);
    expect(cell.querySelector('.tsb-name__text').textContent).toBe(LONG);
  });

  it('the delete-account form: labelled, expands from its button, flags an empty password', () => {
    showProfilePage({ username: 'me', profilePic: 1, stats: {} }, socket);
    const del = [...document.querySelectorAll('#profilePageModal button')].find((b) => b.textContent === 'Delete Account');
    const area = document.getElementById('deleteAccountConfirm');
    expect(area.hidden).toBe(true);
    del.click();
    expect(area.hidden).toBe(false);
    expect(del.getAttribute('aria-expanded')).toBe('true');
    const pw = area.querySelector('input[type="password"]');
    expect(pw.getAttribute('aria-label')).toBe('Password');
    [...area.querySelectorAll('button')].find((b) => b.textContent === 'Permanently Delete').click();
    expect(pw.classList.contains('is-invalid')).toBe(true);
    expect(socket.emitted('deleteAccount')).toEqual([]);
  });
});

describe('lobby controls keep their behaviour on the kit', () => {
  it('Ready toggles ready / unready; Add Bot hides when full (hidden attribute, no inline style)', () => {
    const four = ['me', 'a', 'b', 'c'].map((username) => ({ username, ready: false }));
    showGameLobby({ lobbyId: 'L1', players: four.slice(0, 2), messages: [] }, socket, 'me');
    const ready = document.getElementById('lobbyReadyBtn');
    const addBot = document.getElementById('lobbyAddBotBtn');
    expect(ready.disabled).toBe(true);
    expect(ready.textContent).toBe('Waiting for 2 more...');
    expect(addBot.hidden).toBe(false);
    addBot.click();
    expect(socket.emitted('addBot')).toHaveLength(1);

    showGameLobby({ lobbyId: 'L1', players: four, messages: [] }, socket, 'me');
    const ready2 = document.getElementById('lobbyReadyBtn');
    expect(document.getElementById('lobbyAddBotBtn').hidden).toBe(true);
    expect(ready2.classList.contains('kit-btn--primary')).toBe(true);
    ready2.click();
    expect(socket.emitted('playerReady')).toHaveLength(1);
    expect(ready2.textContent).toBe('Ready!');
    expect(ready2.getAttribute('aria-pressed')).toBe('true');
    ready2.click();
    expect(socket.emitted('playerUnready')).toHaveLength(1);
    expect(ready2.textContent).toBe('Ready');
    for (const b of document.querySelectorAll('#gameLobbyContainer button')) expect(b.getAttribute('style'), b.textContent).toBeNull();
  });

  it('a legacy payload (players only, no members): the header "Ready r/4", empty slots, no voice section', () => {
    showGameLobby({ lobbyId: 'L1', players: [{ socketId: 's1', username: 'me', ready: false }, { socketId: 's2', username: 'ann', ready: true }], messages: [] }, socket, 'me');
    const list = document.getElementById('lobbyPlayersList');
    expect(list.querySelector('.section-label').textContent).toBe('Ready 1/4');
    expect(list.querySelectorAll('.seat-row--empty')).toHaveLength(2);
    expect(list.querySelector('.seat-row__role')).toBeNull();
    expect(list.textContent).not.toContain('(host)');
    expect(document.getElementById('lobbyVoiceSettings').hidden).toBe(true);
    expect(document.getElementById('lobbyReadyBtn').textContent).toBe('Waiting for 2 more...');
  });

  it('chat sends on Enter and on Send, trimmed, and clears the field', () => {
    showMainRoom({ onlineCount: 1, messages: [], lobbies: [] }, socket, 'me');
    const input = document.getElementById('mainRoomChatInput');
    expect(input.getAttribute('aria-label')).toBe('Message the main room');
    input.value = '  hi all ';
    input.dispatchEvent(key('Enter'));
    input.value = 'second';
    [...document.querySelectorAll('#mainRoomContainer button')].find((b) => b.textContent === 'Send').click();
    expect(socket.emitted('mainRoomChat')).toEqual([{ message: 'hi all' }, { message: 'second' }]);
    expect(input.value).toBe('');
  });

  it('a chat name carries its hue as the one per-user value (--name-hue)', () => {
    showMainRoom({ onlineCount: 1, messages: [{ username: 'ann', message: 'hi', timestamp: 1 }], lobbies: [] }, socket, 'me');
    const name = document.querySelector('#mainRoomChatMessages .chat-line__name');
    expect(name.style.getPropertyValue('--name-hue')).toMatch(/^\d{1,3}$/);
    expect(name.getAttribute('style')).toMatch(/^--name-hue: \d{1,3};?$/);
  });

  it('tournament host: Begin is disabled until all ready, then primary; phases hide Ready with the hidden attribute', async () => {
    const { setTournamentPhase } = await import('./TournamentLobby.js');
    showTournamentLobby({
      tournamentId: 't1', name: 'T', creatorUsername: 'me', phase: 'lobby', currentRound: 0, totalRounds: 4,
      players: [{ username: 'me', ready: false }], messages: [], scoreboard: [], activeGames: [],
    }, socket, 'me');
    const begin = document.getElementById('tournamentBeginBtn');
    expect(begin.disabled).toBe(true);
    updateTournamentPlayers([{ username: 'me', ready: true }, { username: 'x', ready: false, connected: false }], 'me');
    expect(begin.disabled).toBe(false);
    expect(begin.classList.contains('kit-btn--primary')).toBe(true);
    begin.click();
    expect(socket.emitted('beginTournament')).toHaveLength(1);
    expect(begin.disabled).toBe(true);
    setTournamentPhase('round_active');
    expect(document.getElementById('tournamentReadyBtn').hidden).toBe(true);
    expect(begin.hidden).toBe(true);
    setTournamentPhase('between_rounds');
    expect(document.getElementById('tournamentReadyBtn').hidden).toBe(false);
    expect(begin.textContent).toBe('Begin Next Round');
    document.getElementById('tournamentCancelBtn').click();
    expect(socket.emitted('cancelTournament')).toHaveLength(1);
  });
});

describe('family lobbies (up to 8; owner 2026-11-16)', () => {
  /** A capable socket's lobby payload: players (first 4) + members / host / settings / capacity. */
  function family(names, { ready = [], playing = null, bots = [], host = 'me', on = true, capacity = 8, held = [] } = {}) {
    const members = names.map((username) => {
      const m = { socketId: bots.includes(username) ? `bot:${username}` : `s-${username}`, username, ready: ready.includes(username), playing: playing ? playing.includes(username) : true };
      if (bots.includes(username)) m.isBot = true;
      if (held.includes(username)) m.reconnecting = true;
      return m;
    });
    return {
      lobbyId: 'L1',
      players: members.slice(0, 4).map(({ socketId, username, ready: r, isBot }) => (isBot ? { socketId, username, ready: r, isBot } : { socketId, username, ready: r })),
      members, host, settings: { spectatorsCanTalk: on }, capacity, messages: [],
    };
  }
  const rows = () => [...document.querySelectorAll('#lobbyPlayersList .seat-row:not(.seat-row--empty)')];
  const rowOf = (name) => rows().find((r) => r.querySelector('.seat-row__name').title === name);
  const roleOf = (name) => rowOf(name).querySelector('.seat-row__role')?.textContent ?? null;
  const update = (data) => updateLobbyPlayersList(null, data.players, 'me', { lobby: data });

  it('6 members: a row each, no empty slot, the header only "Ready r/4" (owner 2026-11-19: no "Players n/8"), the host marked', () => {
    showGameLobby(family(['me', 'ann', 'bob', 'cat', 'dan', 'eve'], { playing: [] }), socket, 'me');
    expect(rows()).toHaveLength(6);
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--empty')).toHaveLength(0);
    expect(document.querySelector('#lobbyPlayersList .section-label').textContent).toBe('Ready 0/4');
    expect(rowOf('me').querySelector('.seat-row__name').textContent).toBe('me (host)');
    expect(rowOf('me').querySelector('.seat-row__name').classList.contains('is-host')).toBe(true);
    expect(document.getElementById('lobbyAddBotBtn').hidden).toBe(true);
    const ready = document.getElementById('lobbyReadyBtn');
    expect(ready.disabled).toBe(false);
    expect(ready.textContent).toBe('Ready');
  });

  it('the table fills: Playing / Will watch; my Ready is disabled "Table full — you\'ll watch" unless I play', () => {
    showGameLobby(family(['ann', 'bob', 'cat', 'dan', 'eve', 'me'], { host: 'ann', playing: [] }), socket, 'me');
    update(family(['ann', 'bob', 'cat', 'dan', 'eve', 'me'], { host: 'ann', ready: ['ann', 'bob', 'cat', 'dan'], playing: ['ann', 'bob', 'cat', 'dan'] }));
    expect(['ann', 'bob', 'cat', 'dan', 'eve', 'me'].map(roleOf)).toEqual(['Playing', 'Playing', 'Playing', 'Playing', 'Will watch', 'Will watch']);
    expect(document.querySelector('#lobbyPlayersList .section-label').textContent).toBe('Ready 4/4');
    const ready = document.getElementById('lobbyReadyBtn');
    expect(ready.disabled).toBe(true);
    expect(ready.textContent).toBe('Table full — you\'ll watch');
    ready.click();
    expect(socket.emitted('playerReady')).toEqual([]);
    // before the table is full nobody is marked
    update(family(['ann', 'bob', 'cat', 'dan', 'eve', 'me'], { host: 'ann', ready: ['ann'], playing: ['ann'] }));
    expect(roleOf('ann')).toBeNull();
    expect(roleOf('me')).toBeNull();
    expect(ready.disabled).toBe(false);
    // I am one of the four: I can still unready
    update(family(['ann', 'bob', 'cat', 'dan', 'eve', 'me'], { host: 'ann', ready: ['ann', 'bob', 'cat', 'me'], playing: ['ann', 'bob', 'cat', 'me'] }));
    expect(ready.disabled).toBe(false);
    expect(ready.textContent).toBe('Ready!');
    ready.click();
    expect(socket.emitted('playerUnready')).toHaveLength(1);
  });

  it('bots that cannot play show "Sitting out" (four humans fill the table); a held seat says Reconnecting…', () => {
    showGameLobby(family(['me', 'b1', 'b2', 'b3', 'ann', 'bob', 'cat'], { bots: ['b1', 'b2', 'b3'], playing: [], held: ['cat'] }), socket, 'me');
    expect(roleOf('b1')).toBe('Sitting out');
    expect(rowOf('b1').querySelector('.seat-row__status')).toBeNull();
    expect(rowOf('b1').querySelector('[data-bot-socket-id]')).not.toBeNull(); // still removable
    expect(rowOf('cat').querySelector('.seat-row__status').textContent).toBe('Reconnecting…');
  });

  it('no "Spectators can talk" switch (owner 2026-11-18): one line says watchers can talk, for the host and the others alike', () => {
    for (const [host, view] of [['me', 'host'], ['ann', 'member']]) {
      showGameLobby(family(['me', 'ann', 'bob', 'cat', 'dan'], { host }), socket, 'me');
      const section = document.getElementById('lobbyVoiceSettings');
      expect(section.hidden, view).toBe(false);
      expect(section.querySelector('[role="switch"]'), view).toBeNull();
      expect(document.getElementById('lobbySpectatorsCanTalk'), view).toBeNull();
      expect(document.getElementById('lobbySpectatorsCanTalkValue'), view).toBeNull();
      expect(document.getElementById('lobbyVoiceHint').textContent, view).toBe('The first 4 to tap Ready play; everyone else watches and can talk.');
      expect(section.textContent, view).not.toContain('only listen');
      removeGameLobby();
    }
    // an old server's off value changes nothing on the page; nothing is ever sent
    showGameLobby(family(['me', 'ann', 'bob', 'cat', 'dan'], { on: false }), socket, 'me');
    expect(document.getElementById('lobbyVoiceHint').textContent).toBe('The first 4 to tap Ready play; everyone else watches and can talk.');
    expect(socket.emitted('setSpectatorsCanTalk')).toEqual([]);
  });

  it('a lobby of 4 with a member on an older app (capacity 4): the header is the ready count only', () => {
    showGameLobby(family(['me', 'ann', 'bob'], { capacity: 4 }), socket, 'me');
    expect(document.querySelector('#lobbyPlayersList .section-label').textContent).toBe('Ready 0/4');
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--empty')).toHaveLength(1);
  });

  it('main room: n/8 from memberCount / capacity; n/4 without them; Rejoin for member 6 by memberUsernames', () => {
    showMainRoom({ onlineCount: 1, messages: [], lobbies: [] }, socket, 'me');
    const players4 = ['ann', 'bob', 'cat', 'dan'].map((username) => ({ username, ready: false }));
    updateLobbyList([
      { id: 'W', name: 'Wide', playerCount: 4, maxPlayers: 4, players: players4, createdAt: 1, memberCount: 6, capacity: 8, memberUsernames: ['ann', 'bob', 'cat', 'dan', 'eve', 'me'] },
      { id: 'O', name: 'Open', playerCount: 2, maxPlayers: 4, players: players4.slice(0, 2), createdAt: 2, memberCount: 2, capacity: 8, memberUsernames: ['ann', 'bob'] },
      { id: 'F', name: 'Full8', playerCount: 4, maxPlayers: 4, players: players4, createdAt: 3, memberCount: 8, capacity: 8, memberUsernames: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      { id: 'M', name: 'Mine8', playerCount: 4, maxPlayers: 4, players: players4, createdAt: 6, memberCount: 8, capacity: 8, memberUsernames: ['a', 'b', 'c', 'd', 'e', 'me', 'g', 'h'] },
      { id: 'L', name: 'Legacy', playerCount: 4, maxPlayers: 4, players: players4, createdAt: 4, memberCount: 4, capacity: 4, memberUsernames: ['ann', 'bob', 'cat', 'dan'] },
      { id: 'X', name: 'Old', playerCount: 3, maxPlayers: 4, players: players4.slice(0, 3), createdAt: 5 },
    ], socket, [], []);
    const card = (id) => document.querySelector(`.room-card[data-lobby-id="${id}"]`);
    const countOf = (id) => card(id).querySelector('.room-card__count').textContent;
    const button = (id) => card(id).querySelector('button');
    expect(['W', 'O', 'F', 'L', 'X'].map(countOf)).toEqual(['6/8', '2/8', '8/8', '4/4', '3/4']);
    // a full family lobby where I am member 6 (past the frozen 4 players): Rejoin
    expect(['W', 'O', 'F', 'M', 'L', 'X'].map((id) => button(id).textContent)).toEqual(['Join', 'Join', 'Full', 'Rejoin', 'Full', 'Join']);
    expect(button('F').disabled).toBe(true);
    expect(button('M').dataset.rejoin).toBe('true');
    expect(card('W').querySelector('.room-card__meta').textContent).toBe('ann, bob, cat, dan, eve, me');
    button('M').click();
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'M' }]);
  });
});

describe('play again: a lobby reopened after its game (owner 2026-11-16)', () => {
  /** A reopened lobby's payload: held rows (returning + reconnecting) and expected names. */
  function reopened(names, { host = 'me', returning = [], expected = null, bots = [], ready = [], capacity = 8, onResults = [] } = {}) {
    const members = names.map((username) => {
      const m = { socketId: bots.includes(username) ? `bot:${username}` : returning.includes(username) ? `away:${username}` : `s-${username}`, username, ready: ready.includes(username), playing: true };
      if (bots.includes(username)) m.isBot = true;
      if (onResults.includes(username)) m.onResults = true;
      if (returning.includes(username)) {
        m.reconnecting = true;
        m.returning = true;
      }
      return m;
    });
    const out = {
      lobbyId: 'R1',
      players: members.slice(0, 4).map(({ socketId, username, ready: r }) => ({ socketId, username, ready: r })),
      members, host, settings: { spectatorsCanTalk: true }, capacity, messages: [],
    };
    if (returning.length) out.reconnecting = returning;
    if (expected) out.expected = expected;
    return out;
  }
  const rows = () => [...document.querySelectorAll('#lobbyPlayersList .seat-row')];
  const rowOf = (name) => rows().find((r) => r.querySelector('.seat-row__name')?.title === name);
  const update = (data, me = 'me') => updateLobbyPlayersList(null, data.players, me, { lobby: data });
  const releaseButtons = () => [...document.querySelectorAll('#lobbyPlayersList [data-release-hold]')];

  it('a member still on the last game\'s results says "Still on the results" in the "Not back yet" style, never on one\'s own row, with no "Don\'t wait"', () => {
    showGameLobby(reopened(['me', 'ann', 'bob', 'cat'], { onResults: ['me', 'cat', 'bob'], ready: ['bob'] }), socket, 'me');
    const status = rowOf('cat').querySelector('.seat-row__status');
    expect(status.textContent).toBe('Still on the results');
    expect(status.classList.contains('is-reconnecting')).toBe(true);
    expect(status.classList.contains('is-returning')).toBe(true);
    expect(rowOf('cat').dataset.onResults).toBe('true');
    expect(rowOf('cat').dataset.returning).toBeUndefined();
    // one's own row (this client is on the lobby screen) and a ready row read as usual
    expect(rowOf('me').querySelector('.seat-row__status').textContent).toBe('Waiting...');
    expect(rowOf('me').dataset.onResults).toBeUndefined();
    expect(rowOf('bob').querySelector('.seat-row__status').textContent).toBe('✓ Ready');
    expect(rowOf('ann').querySelector('.seat-row__status').textContent).toBe('Waiting...');
    // they are present: the host gets no "Don't wait" for them
    expect(releaseButtons()).toHaveLength(0);
    // they tapped Return to Lobby (the server's update drops the flag)
    update(reopened(['me', 'ann', 'bob', 'cat'], { ready: ['bob'] }));
    expect(rowOf('cat').querySelector('.seat-row__status').textContent).toBe('Waiting...');
    expect(rowOf('cat').querySelector('.seat-row__status').classList.contains('is-returning')).toBe(false);
    expect(rowOf('cat').dataset.onResults).toBeUndefined();
  });

  it('a payload without members (an older server) never shows "Still on the results"', () => {
    const data = reopened(['me', 'ann', 'bob', 'cat'], { onResults: ['cat'] });
    showGameLobby({ lobbyId: data.lobbyId, players: data.players.map((p) => ({ ...p, onResults: true })), messages: [] }, socket, 'me');
    expect(rowOf('cat').querySelector('.seat-row__status').textContent).toBe('Waiting...');
  });

  it('a held row says "Not back yet" (not Reconnecting…); the host gets "Don\'t wait", which sends releaseLobbyHold once', () => {
    showGameLobby(reopened(['me', 'ann', 'bob', 'cat'], { returning: ['cat'] }), socket, 'me');
    const status = rowOf('cat').querySelector('.seat-row__status');
    expect(status.textContent).toBe('Not back yet');
    expect(status.classList.contains('is-returning')).toBe(true);
    expect(rowOf('cat').dataset.returning).toBe('true');
    expect(rowOf('ann').querySelector('.seat-row__status').textContent).toBe('Waiting...');
    const btn = rowOf('cat').querySelector('[data-release-hold]');
    expect(btn.textContent).toBe('Don\'t wait');
    expect(btn.getAttribute('aria-label')).toBe('Don\'t wait for cat');
    expect(releaseButtons()).toHaveLength(1);
    btn.click();
    btn.click();
    expect(socket.emitted('releaseLobbyHold')).toEqual([{ username: 'cat' }]);
    // the server's update: the hold went, the row with it
    update(reopened(['me', 'ann', 'bob']));
    expect(rowOf('cat')).toBeUndefined();
    expect(releaseButtons()).toHaveLength(0);
  });

  it('a member who is not the host sees "Not back yet" but no "Don\'t wait"; while the host is the one away, anyone may', () => {
    showGameLobby(reopened(['ann', 'me', 'bob', 'cat'], { host: 'ann', returning: ['cat'] }), socket, 'me');
    expect(rowOf('cat').querySelector('.seat-row__status').textContent).toBe('Not back yet');
    expect(releaseButtons()).toHaveLength(0);
    update(reopened(['ann', 'me', 'bob', 'cat'], { host: 'ann', returning: ['ann', 'cat'] }));
    expect(releaseButtons().map((b) => b.dataset.releaseHold)).toEqual(['ann', 'cat']);
  });

  it('older-app players with a saved place are listed under "Expected" (no empty slot for them); Add Bot stays hidden while members + expected fill the table', () => {
    showGameLobby(reopened(['me', 'ann'], { expected: ['grandma', 'grandpa'] }), socket, 'me');
    const label = [...document.querySelectorAll('#lobbyPlayersList .section-label')].map((l) => l.textContent);
    expect(label).toContain('Expected');
    const expectedRows = [...document.querySelectorAll('#lobbyPlayersList .seat-row--expected')];
    expect(expectedRows.map((r) => r.querySelector('.seat-row__name').textContent)).toEqual(['grandma', 'grandpa']);
    expect(expectedRows.map((r) => r.querySelector('.seat-row__status').textContent)).toEqual(['Not back yet', 'Not back yet']);
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--empty')).toHaveLength(0);
    expect(document.getElementById('lobbyAddBotBtn').hidden).toBe(true);
    expect(document.getElementById('lobbyReadyBtn').textContent).toBe('Waiting for 2 more...');
    // the host may stop waiting for one
    expectedRows[1].querySelector('[data-release-hold]').click();
    expect(socket.emitted('releaseLobbyHold')).toEqual([{ username: 'grandpa' }]);
    // the reservation ended (no `expected` key: none stands): an empty slot, Add Bot back
    update(reopened(['me', 'ann'], { expected: ['grandma'] }));
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--expected')).toHaveLength(1);
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--empty')).toHaveLength(1);
    expect(document.getElementById('lobbyAddBotBtn').hidden).toBe(false);
    update(reopened(['me', 'ann']));
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--expected')).toHaveLength(0);
    expect(document.querySelectorAll('#lobbyPlayersList .section-label')).toHaveLength(1);
  });

  it('a non-host sees the expected names without a button; an expected player who joined shows once, as a member', () => {
    showGameLobby(reopened(['ann', 'me'], { host: 'ann', expected: ['grandma'] }), socket, 'me');
    expect(document.querySelector('.seat-row--expected [data-release-hold]')).toBeNull();
    update(reopened(['ann', 'me', 'grandma'], { host: 'ann', expected: ['grandma'] }));
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--expected')).toHaveLength(0);
    expect(rows().filter((r) => r.querySelector('.seat-row__name')?.title === 'grandma')).toHaveLength(1);
  });

  it('a lobby without the play-again keys renders as before (no Expected, Reconnecting… for a reload-held seat)', () => {
    showGameLobby(reopened(['me', 'ann', 'bob']), socket, 'me');
    expect(document.querySelectorAll('#lobbyPlayersList .seat-row--expected')).toHaveLength(0);
    const held = reopened(['me', 'ann', 'bob']);
    held.members[2].reconnecting = true;
    update(held);
    expect(rowOf('bob').querySelector('.seat-row__status').textContent).toBe('Reconnecting…');
    expect(releaseButtons()).toHaveLength(0);
  });
});
