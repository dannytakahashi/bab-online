/**
 * The DOM screens (item 18b): user text is always text (audit finding
 * ui-13: a username like <img src=x onerror=...> renders as those
 * characters, never as an element), every dialog is a kit Modal (focus
 * trap, Escape only where safe, stacking, focus restore), and nothing uses
 * window.alert / prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom } from './MainRoom.js';
import { showGameLobby, addLobbyChatMessage, removeGameLobby } from './GameLobby.js';
import { showTournamentLobby, addTournamentChatMessage, updateTournamentPlayers, updateTournamentActiveGames, removeTournamentLobby } from './TournamentLobby.js';
import { showPlayerSearchPage, updatePlayerSearchResults, removePlayerSearchPage } from './PlayerSearchPage.js';
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
  removePlayerSearchPage();
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

  it('player search: a result is a button with the name as text that opens the profile', () => {
    const opener = createButton({ label: 'Players' });
    document.body.appendChild(opener);
    opener.focus();
    showPlayerSearchPage(socket);
    updatePlayerSearchResults([{ username: EVIL, gamesPlayed: 4, wins: 1 }]);
    expect(injected()).toEqual([]);
    const row = document.querySelector('#playerSearchResults .search-result');
    expect(row.tagName).toBe('BUTTON');
    expect(row.textContent).toBe(`${EVIL}4 games | 25% win rate`);
    row.click();
    expect(socket.emitted('getPlayerProfile')).toEqual([{ username: EVIL }]);
    expect(document.getElementById('playerSearchPageOverlay')).toBeNull();
    expect(document.activeElement).toBe(opener);
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

  it('leaderboard, records and player search are kit Modals with a named close button', () => {
    showLeaderboardPage([], socket);
    expect(document.querySelector('#leaderboardPageOverlay [role="dialog"]').id).toBe('leaderboardPageModal');
    document.querySelector('#leaderboardPageModal .kit-modal__close').click();
    expect(document.getElementById('leaderboardPageOverlay')).toBeNull();
    expect(document.activeElement).toBe(opener);

    showRecordsPage({ allTime: null, thisYear: null, thisMonth: null }, 0);
    expect(document.querySelector('#recordsPageModal .kit-modal__close').getAttribute('aria-label')).toBe('Close records');
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('recordsPageOverlay')).toBeNull();

    showPlayerSearchPage(socket);
    expect(document.activeElement.id).toBe('playerSearchInput');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Search players by username');
    document.dispatchEvent(key('Escape'));
    expect(document.getElementById('playerSearchPageOverlay')).toBeNull();
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
