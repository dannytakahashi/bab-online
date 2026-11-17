/**
 * Play again on the web (owner 2026-11-16: an automatic return; the score
 * screen stays exactly as it was). At the end of a casual game a lobby
 * started the server moves this socket back into a copy of that lobby and
 * sends the private lobbyReturn right after gameEnd. The page only
 * remembers it: the score modal stays up, unchanged, with its "Return to
 * Lobby" button, for as long as the player likes, and the lobby's events
 * meanwhile are followed, not shown. The button then lands in that lobby
 * (not the main room), voice still running, and joinLobby asks the server
 * for it again (its own member: lobbyCreated with the lobby as it is now).
 * One page load; every test starts signed in, in the main room.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPage, tick, mainRoomPayload, clientState } from '../testing/fakePage.js';
import { REPO_ROOT } from '../testing/files.js';
import { clearToasts } from '../ui/kit/index.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let hello;
let socketCount = 1;
const nextSocketId = () => `sock-${++socketCount}`;

beforeAll(async () => {
  page = await loadPage({ connected: false });
  socket = page.socket;
  hello = socket.emitted('clientHello')[0];
});

async function signIn(name = 'me') {
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(nextSocketId());
  socket.clearEmits();
  socket.fire('signInResponse', { success: true, username: name, sessionToken: `tok-${name}`, blockedUsers: ['troll'] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  socket.clearEmits();
  page.voice.shutdown.mockClear();
  page.voice.initialize.mockClear();
  page.voice.setTalk.mockClear();
}

/** Seated at g1 through a rejoin, voice running. */
async function seated(gameId = 'g1') {
  socket.reconnect(nextSocketId());
  socket.fire('restoreSessionResponse', { success: true, username: 'me', activeGameId: gameId, blockedUsers: ['troll'] });
  socket.fire('rejoinSuccess', clientState({ gameId }));
  await vi.waitFor(() => expect(document.getElementById('gameFeed')).not.toBeNull());
  await vi.waitFor(() => expect(page.voice.active).toBe(true));
  socket.clearEmits();
  page.voice.shutdown.mockClear();
  page.voice.initialize.mockClear();
  page.voice.setTalk.mockClear();
}

const gameEnd = () => ({ score: { team1: 300, team2: 120 }, playerStats: { 1: { username: 'me', totalBids: 20, totalTricks: 22, setsCaused: 0, totalHSI: 100, avgHSI: 8 } }, tournamentId: null });

/** A capable member's lobby payload (members / host / settings / capacity). */
function lobby({ names = ['me', 'ann', 'bob', 'cat'], ready = [], returning = [], expected = null, lobbyId = 'R1' } = {}) {
  const members = names.map((username) => {
    const m = { socketId: username === 'me' ? socket.id : `s-${username}`, username, ready: ready.includes(username), playing: true };
    if (returning.includes(username)) Object.assign(m, { socketId: `away:${username}`, reconnecting: true, returning: true });
    return m;
  });
  const out = {
    lobbyId,
    players: members.slice(0, 4).map(({ socketId, username, ready: r }) => ({ socketId, username, ready: r })),
    members, host: 'me', settings: { spectatorsCanTalk: true }, capacity: 8,
  };
  if (returning.length) out.reconnecting = returning;
  if (expected) out.expected = expected;
  return out;
}

function lobbyReturn({ gameId = 'g1', position = 1, ...rest } = {}) {
  return {
    ...lobby(rest),
    name: 'Family',
    messages: [{ username: 'ann', message: 'gg', timestamp: 1 }, { username: 'troll', message: 'hidden', timestamp: 2 }],
    lastGame: { gameId, score: { team1: 300, team2: 120 }, playerStats: {}, position },
  };
}

const modal = () => document.getElementById('finalScoreOverlay');
const returnButton = () => document.querySelector('#finalScoreOverlay button');
const toasts = () => [...document.querySelectorAll('.kit-toast')].map((t) => t.textContent);
const rowOf = (name) => [...document.querySelectorAll('#lobbyPlayersList .seat-row')].find((r) => r.querySelector('.seat-row__name')?.title === name);
const chatLines = () => [...document.querySelectorAll('#lobbyChatArea .chat-line, #lobbyChatArea > *')].map((l) => l.textContent);

beforeEach(async () => {
  await signIn();
  // (one toast queue per page: an earlier test's error would hold an info back)
  clearToasts();
});

describe('the hello', () => {
  it('says playAgain (with casualSpectators)', () => {
    expect(hello.caps).toEqual(expect.arrayContaining(['casualSpectators', 'playAgain']));
  });
});

describe('a seat at a lobby-born game: the score screen stays, Return lands in the reopened lobby', () => {
  it('lobbyReturn after gameEnd changes nothing on screen: the same modal and button, no lobby, nothing sent, voice untouched', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    const before = modal();
    const button = returnButton();
    button.focus();
    socket.fire('lobbyReturn', lobbyReturn());
    expect(page.session.screen).toBe('gameEnd');
    expect(modal()).toBe(before);
    expect(returnButton()).toBe(button);
    expect(button.textContent).toBe('Return to Lobby');
    expect(document.activeElement).toBe(button);
    expect(modal().textContent).toMatch(/VICTORY/);
    expect(document.getElementById('gameLobbyContainer')).toBeNull();
    expect(socket.emittedNames()).toEqual([]);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(true);
    expect(toasts().join(' ')).not.toMatch(/Back in/);

    // the lobby's events while the modal is up: followed, not shown
    socket.fire('playerReadyUpdate', lobby({ names: ['me', 'ann', 'bob', 'cat', 'dan'], ready: ['ann'] }));
    socket.fire('lobbyMessage', { username: 'bob', message: 'again?', timestamp: 3 });
    socket.fire('lobbyMessage', { username: 'troll', message: 'nope', timestamp: 4 });
    expect(page.session.screen).toBe('gameEnd');
    expect(document.getElementById('gameLobbyContainer')).toBeNull();
    expect(modal()).toBe(before);

    // Return to Lobby: the lobby as it is now, voice kept, joinLobby re-asks
    button.click();
    expect(page.session.screen).toBe('lobby');
    expect(modal()).toBeNull();
    expect(document.getElementById('gameLobbyContainer')).not.toBeNull();
    expect(rowOf('dan')).toBeDefined();
    expect(rowOf('ann').querySelector('.seat-row__status').textContent).toBe('✓ Ready');
    const chat = chatLines().join(' | ');
    expect(chat).toMatch(/gg/);
    expect(chat).toMatch(/again\?/);
    expect(chat).not.toMatch(/hidden|nope/);
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'R1' }]);
    expect(socket.emitted('joinMainRoom')).toEqual([]);
    // the server learns the score screen is left for the lobby (as iOS
    // 1.2.3 tells it), first: until then it counts this socket as still on
    // its results
    expect(socket.emitted('lobbyReturnSeen')).toEqual([{}]);
    expect(socket.emittedNames().filter((n) => n === 'lobbyReturnSeen' || n === 'joinLobby')).toEqual(['lobbyReturnSeen', 'joinLobby']);
    expect(sessionStorage.getItem('lobbyId')).toBe('R1');
    expect(sessionStorage.getItem('gameId')).toBeNull();
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(true);
    // the controls are drawn again, in the lobby's voice slot
    expect(document.querySelector('#lobbyVoiceSlot #voice-mute-btn')).not.toBeNull();
    expect(toasts().join(' ')).toMatch(/Back in “Family”\. Tap Ready to play again\./);
    // no table left behind
    expect(document.getElementById('gameFeed')).toBeNull();

    // the server's answer to the re-entry: the lobby again, voice not restarted
    socket.fire('lobbyCreated', { ...lobby({ names: ['me', 'ann', 'bob', 'cat', 'dan'], ready: ['ann', 'bob'] }), name: 'Family', messages: [] });
    expect(page.session.screen).toBe('lobby');
    expect(page.session.pendingLobbyRejoin).toBeNull();
    expect(rowOf('bob').querySelector('.seat-row__status').textContent).toBe('✓ Ready');
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(document.querySelector('#lobbyVoiceSlot #voice-mute-btn')).not.toBeNull();

    // Ready as ever
    document.getElementById('lobbyReadyBtn').click();
    expect(socket.emitted('playerReady')).toHaveLength(1);
  });

  it('lobbyReturn before gameEnd (gameEnd still on its way): the table stays, then the modal, then Return lands in the lobby', async () => {
    await seated();
    socket.fire('lobbyReturn', lobbyReturn());
    expect(page.session.screen).toBe('table');
    expect(document.getElementById('gameLobbyContainer')).toBeNull();
    socket.fire('gameEnd', gameEnd());
    expect(page.session.screen).toBe('gameEnd');
    // nothing told while the results are up
    expect(socket.emitted('lobbyReturnSeen')).toEqual([]);
    returnButton().click();
    expect(page.session.screen).toBe('lobby');
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'R1' }]);
    expect(socket.emitted('lobbyReturnSeen')).toEqual([{}]);
  });

  it('the forced mute of the table (spectators may not talk) ends at lobbyReturn, the modal still up: extras back in the lobby are heard', async () => {
    await seated();
    socket.fire('voiceSettings', { gameId: 'g1', host: 'me', spectatorsCanTalk: false, role: 'player', canTalk: true, canChange: true });
    expect(page.voice.forcedMute).not.toBeNull();
    socket.fire('gameEnd', gameEnd());
    const before = modal();
    socket.fire('lobbyReturn', lobbyReturn());
    // the results stay exactly as they were; only the voice rules went
    expect(page.voice.forcedMute).toBeNull();
    expect(page.session.screen).toBe('gameEnd');
    expect(modal()).toBe(before);
    expect(page.voice.active).toBe(true);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    expect(socket.emittedNames()).toEqual([]);
    returnButton().click();
    expect(page.voice.forcedMute).toBeNull();
    expect(page.voice.isTalking()).toBe(true);
  });

  it('Return puts the keyboard on Ready, kept across the server\'s lobbyCreated re-render (and a chat draft too)', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn());
    returnButton().focus();
    returnButton().click();
    expect(document.activeElement).toBe(document.getElementById('lobbyReadyBtn'));
    socket.fire('lobbyCreated', { ...lobby(), name: 'Family', messages: [] });
    expect(document.activeElement).toBe(document.getElementById('lobbyReadyBtn'));
    // in the chat with a draft: the re-render keeps both
    const input = document.getElementById('lobbyChatInput');
    input.focus();
    input.value = 'one more';
    socket.fire('lobbyCreated', { ...lobby(), name: 'Family', messages: [] });
    const after = document.getElementById('lobbyChatInput');
    expect(after).not.toBe(input);
    expect(document.activeElement).toBe(after);
    expect(after.value).toBe('one more');
  });

  it('Ready disabled on landing (fewer than 4): the chat takes the keyboard', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn({ names: ['me', 'ann', 'bob'] }));
    returnButton().click();
    expect(document.getElementById('lobbyReadyBtn').disabled).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('lobbyChatInput'));
  });

  it('the others filled the table while the modal was up: the toast says this one is watched', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn({ names: ['me', 'ann', 'bob', 'cat', 'dan'] }));
    // the four others readied (a family lobby of 5: they take the table)
    const full = lobby({ names: ['me', 'ann', 'bob', 'cat', 'dan'], ready: ['ann', 'bob', 'cat', 'dan'] });
    full.members = full.members.map((m) => ({ ...m, playing: m.username !== 'me' }));
    socket.fire('playerReadyUpdate', full);
    returnButton().click();
    expect(document.getElementById('lobbyReadyBtn').textContent).toMatch(/Table full/);
    const said = toasts().join(' ');
    expect(said).toMatch(/Back in “Family”\. The table is full; you'll watch this one\./);
    expect(said).not.toMatch(/Tap Ready/);
  });

  it('held rows say "Not back yet" in the reopened lobby; the host may stop waiting', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn({ returning: ['cat'], expected: ['grandma'] }));
    returnButton().click();
    expect(rowOf('cat').querySelector('.seat-row__status').textContent).toBe('Not back yet');
    expect(document.querySelectorAll('.seat-row--expected')).toHaveLength(1);
    rowOf('cat').querySelector('[data-release-hold]').click();
    expect(socket.emitted('releaseLobbyHold')).toEqual([{ username: 'cat' }]);
  });

  it('no lobbyReturn (a lobby nobody reopened, a legacy flow): Return goes to the main room as before', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    returnButton().click();
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(socket.emitted('joinLobby')).toEqual([]);
    expect(page.voice.shutdown).toHaveBeenCalled();
  });

  it('a lobbyReturn for another game is ignored', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn({ gameId: 'other' }));
    returnButton().click();
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinLobby')).toEqual([]);
    expect(socket.emitted('lobbyReturnSeen')).toEqual([]);
  });

  it('leftLobby while the modal is up (another tab took the seat): Return goes to the main room', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn());
    socket.fire('leftLobby', {});
    expect(page.session.screen).toBe('gameEnd');
    expect(modal()).not.toBeNull();
    returnButton().click();
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(socket.emitted('joinLobby')).toEqual([]);
    expect(socket.emitted('lobbyReturnSeen')).toEqual([]);
  });

  it('a reconnect on the modal keeps it (no joinMainRoom); Return then re-enters from the new socket', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn());
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(page.session.screen).toBe('gameEnd');
    expect(socket.emitted('joinMainRoom')).toEqual([]);
    expect(socket.emitted('rejoinGame')).toEqual([]);
    returnButton().click();
    expect(page.session.screen).toBe('lobby');
    // (from the new socket, which is no member yet: the server ignores it,
    // and the joinLobby after it takes the held seat over)
    expect(socket.emittedNames().filter((n) => n === 'lobbyReturnSeen' || n === 'joinLobby')).toEqual(['lobbyReturnSeen', 'joinLobby']);
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'R1' }]);
  });

  it('the re-entry refused (the lobby closed): a toast, the main room', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn());
    returnButton().click();
    socket.clearEmits();
    socket.fire('serverError', { code: 'rejected', message: 'Lobby not found', handler: 'joinLobby' });
    await vi.waitFor(() => expect(toasts().join(' ')).toMatch(/That lobby has closed/));
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(sessionStorage.getItem('lobbyId')).toBeNull();
    expect(page.voice.shutdown).toHaveBeenCalled();
  });

  it('a server restart while the modal is up: the modal stays; Return finds the lobby gone and says why, once', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn());
    socket.fire('serverShutdown', {});
    socket.reconnect(nextSocketId());
    socket.fire('restoreSessionResponse', { success: true, username: 'me', blockedUsers: [] });
    expect(page.session.screen).toBe('gameEnd');
    returnButton().click();
    socket.clearEmits();
    socket.fire('serverError', { code: 'rejected', message: 'Lobby not found', handler: 'joinLobby' });
    await vi.waitFor(() => expect(toasts().join(' ')).toMatch(/Your lobby closed because the server restarted/));
    expect(toasts().join(' ')).not.toMatch(/That lobby has closed/);
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
  });

  it('a lobbyReturn in the main room (the table was left just before the end) asks for the main room, which leaves that lobby', async () => {
    socket.fire('lobbyReturn', lobbyReturn());
    expect(page.session.screen).toBe('mainRoom');
    expect(document.getElementById('gameLobbyContainer')).toBeNull();
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    // it never shows that lobby: nothing to tell (its joinMainRoom leaves it)
    expect(socket.emitted('lobbyReturnSeen')).toEqual([]);
  });
});

/** The server's spectatorJoined full state for an extra: a CREATED snapshot (contract fixture). */
function createdForSpectator(gameId) {
  const fx = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/created-countdown.json'), 'utf8'));
  const snapshot = { ...fx.snapshot, gameId, viewer: { role: 'spectator', position: null, ownerView: null, canAct: false } };
  return { gameId, players: [], trump: null, snapshot };
}

describe('a lobby extra who watched the game', () => {
  it('back in the lobby with its microphone (it was listen-only while spectators could not talk)', async () => {
    socket.fire('lobbyCreated', { ...lobby({ names: ['ann', 'bob', 'cat', 'dan', 'me'] }), lobbyId: 'L6', name: 'Family', messages: [] });
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    socket.fire('spectatorJoined', createdForSpectator('g9'));
    expect(page.session.role).toBe('spectator');
    socket.fire('voiceSettings', { gameId: 'g9', host: 'ann', spectatorsCanTalk: false, role: 'spectator', canTalk: false, canChange: false });
    await vi.waitFor(() => expect(page.voice.isListenOnly()).toBe(true));
    socket.fire('gameEnd', gameEnd());
    expect(modal().textContent).toMatch(/GAME OVER/);
    socket.fire('lobbyReturn', lobbyReturn({ gameId: 'g9', position: null, names: ['ann', 'bob', 'cat', 'dan', 'me'] }));
    expect(page.session.screen).toBe('gameEnd');
    expect(page.voice.isListenOnly()).toBe(true);
    socket.clearEmits();
    page.voice.setTalk.mockClear();
    returnButton().click();
    expect(page.session.screen).toBe('lobby');
    expect(page.voice.setTalk).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(page.voice.isTalking()).toBe(true));
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    const mute = document.querySelector('#lobbyVoiceSlot #voice-mute-btn');
    expect(mute).not.toBeNull();
    expect(mute.hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('the reopened lobby starts its next game while this player is still on the score modal', () => {
  it('the server leaves it out (leftLobby, its calls end; playAgain.leftOnResults): the modal stays as it is, Return goes to the main room', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn({ names: ['me', 'ann', 'bob', 'cat', 'dan'] }));
    const before = modal();
    const button = returnButton();
    button.focus();
    // the four others readied and started without me: leftLobby, then the
    // private voicePeerLeft for each of them
    socket.fire('leftLobby', {});
    for (const name of ['ann', 'bob', 'cat', 'dan']) socket.fire('voicePeerLeft', { socketId: `s-${name}` });
    expect(page.session.screen).toBe('gameEnd');
    expect(modal()).toBe(before);
    expect(returnButton()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(page.voice.removePeer).toHaveBeenCalledWith('s-ann');
    expect(socket.emittedNames()).toEqual([]);
    expect(page.session.lobbyReturn).toBeNull();

    button.click();
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(socket.emitted('joinLobby')).toEqual([]);
    expect(socket.emitted('lobbyReturnSeen')).toEqual([]);
    expect(page.voice.shutdown).toHaveBeenCalled();
  });

  it('a server that makes it an extra instead (spectatorJoined at the modal): the modal stays (this socket stops watching that game); Return asks for the lobby, answered with the game to watch', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn({ names: ['me', 'ann', 'bob', 'cat', 'dan'] }));
    const before = modal();
    // the four others readied: the server made me an extra of their game
    socket.fire('spectatorJoined', createdForSpectator('g10'));
    expect(page.session.screen).toBe('gameEnd');
    expect(modal()).toBe(before);
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
    expect(page.voice.shutdown).toHaveBeenCalled();
    // the stop is said, over the unchanged results
    await vi.waitFor(() => expect(toasts().join(' ')).toMatch(/Your lobby started its next game, so voice chat ended\. Return to Lobby to watch it\./));
    clearToasts();
    // that game's voice settings and its room's startDraw reach nothing
    page.voice.setTalk.mockClear();
    page.voice.initialize.mockClear();
    socket.fire('voiceSettings', { gameId: 'g10', host: 'ann', spectatorsCanTalk: true, role: 'spectator', canTalk: true, canChange: false });
    expect(page.voice.initialize).not.toHaveBeenCalled();
    socket.fire('startDraw', { start: true });
    expect(page.session.screen).toBe('gameEnd');
    expect(modal()).toBe(before);
    // the main room's answer at the modal is ignored
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.screen).toBe('gameEnd');
    socket.clearEmits();

    returnButton().click();
    expect(page.session.screen).toBe('mainRoom');
    // the main room is asked for first (nothing stands blank), then the lobby
    expect(socket.emittedNames().filter((n) => n === 'joinMainRoom' || n === 'joinLobby')).toEqual(['joinMainRoom', 'joinLobby']);
    expect(socket.emitted('joinLobby')).toEqual([{ lobbyId: 'R1' }]);
    // its joinMainRoom took the socket out of that lobby: nothing to tell
    expect(socket.emitted('lobbyReturnSeen')).toEqual([]);
    socket.fire('mainRoomJoined', mainRoomPayload());
    expect(page.session.screen).toBe('mainRoom');
    expect(document.getElementById('mainRoomContainer')).not.toBeNull();
    // the server's redirect for a started lobby's extra
    socket.fire('spectatorJoined', createdForSpectator('g10'));
    expect(page.session.screen).toBe('table');
    expect(page.session.role).toBe('spectator');
    expect(page.session.pendingLobbyRejoin).toBeNull();
    await vi.waitFor(() => expect(toasts().join(' ')).toMatch(/Your lobby started its next game\. You're watching it\./));
  });

  it('that game already over when Return is tapped: "That lobby has closed", the main room', async () => {
    await seated();
    socket.fire('gameEnd', gameEnd());
    socket.fire('lobbyReturn', lobbyReturn());
    socket.fire('spectatorJoined', createdForSpectator('g11'));
    // the answer to its joinMainRoom (ignored at the modal)
    socket.fire('mainRoomJoined', mainRoomPayload());
    socket.clearEmits();
    returnButton().click();
    socket.fire('serverError', { code: 'rejected', message: 'Lobby not found', handler: 'joinLobby' });
    await vi.waitFor(() => expect(toasts().join(' ')).toMatch(/That lobby has closed/));
    expect(page.session.screen).toBe('mainRoom');
    expect(socket.emitted('joinMainRoom')).toHaveLength(1);
  });
});

describe('a tournament table never has a lobby return', () => {
  it('Return to Tournament as before', async () => {
    await seated();
    page.gameState.tournamentId = 't1';
    socket.fire('gameEnd', { ...gameEnd(), tournamentId: 't1' });
    expect(returnButton().textContent).toBe('Return to Tournament');
    returnButton().click();
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(socket.emitted('joinLobby')).toEqual([]);
  });
});
