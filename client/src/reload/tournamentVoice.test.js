/**
 * Tournament voice on the page (owner 2026-11-24: "in a tournament nobody
 * had voice, even with two humans at the same table"; main.js "Tournament
 * voice", docs/claude/voice.md "Tournament voice"):
 *   - the tournament lobby is a voice room: voice starts (muted, no prompt)
 *     once the server lists or announces another member there, its buttons
 *     sit in the lobby header and survive a re-render, and it stops 30 s
 *     after the last one left
 *   - a seat at a tournament table: voice is wanted from startDraw and
 *     starts once positionUpdate shows another human; the server's list
 *     (sent at seating) is connected; a table of bots starts nothing
 *   - every room change tears the session down first (lobby -> table ->
 *     score modal -> lobby -> next table), so no call or buffered peer of
 *     one room reaches the next
 * One page load; every test signs in afresh.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadPage, tick, mainRoomPayload, tournamentPayload, seatDeal } from '../testing/fakePage.js';
import { VOICE_ALONE_GRACE_MS } from '../voice/voiceCompany.js';
import { clientHello } from '../utils/avatar.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let socketCount = 1;
const nextSocketId = () => `sock-${++socketCount}`;
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const muteButton = () => document.getElementById('voice-mute-btn');
const lobbySlot = () => document.querySelector('#tournamentLobbyContainer #lobbyVoiceSlot');

beforeAll(async () => {
  page = await loadPage({ connected: false });
  socket = page.socket;
});

afterEach(() => {
  vi.useRealTimers();
});

async function signIn(name = 'me') {
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(nextSocketId());
  socket.fire('signInResponse', { success: true, username: name, sessionToken: `tok-${name}`, blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  socket.clearEmits();
  page.voice.shutdown.mockClear();
  page.voice.initialize.mockClear();
  page.voice.connectToPeer.mockClear();
  page.voice.removePeer.mockClear();
}

/** A tournament lobby payload with these members (me first). */
function joined(names = ['me', 'bob'], extra = {}) {
  const base = tournamentPayload({ creator: 'me', ...extra });
  return {
    ...base,
    players: names.map((username) => ({ socketId: username === 'me' ? socket.id : `s-${username}`, username, ready: false, connected: true, isCreator: username === 'me' })),
  };
}

/** positionUpdate for seats 1-4: names starting with 🤖 are bots. */
function seating(names, gameId = 'g7') {
  return {
    gameId,
    positions: [1, 2, 3, 4],
    sockets: names.map((n) => (n === 'me' ? socket.id : n.startsWith('🤖') ? `bot:${n}` : `s-${n}`)),
    usernames: names.map((username) => ({ username })),
    pics: [1, 2, 3, 4],
    isBot: names.map((n) => n.startsWith('🤖')),
  };
}

/** The round's table for me: assignment, then the draw, then seating with `names`. */
async function seatAt(names, { gameId = 'g7', list = [] } = {}) {
  socket.fire('tournamentGameAssignment', { gameId, tournamentId: 't1', roundNumber: 1 });
  socket.fire('allPlayersReady', { gameId });
  socket.fire('startDraw', { start: true });
  expect(page.session.screen).toBe('table');
  socket.fire('positionUpdate', seating(names, gameId));
  if (list.length) socket.fire('voicePeerList', { peers: list.map((n) => ({ socketId: `s-${n}`, username: n })) });
  socket.fire('createUI', {});
  socket.fire('gameStart', seatDeal({ gameId }));
  await settle();
}

describe('the tournament lobby', () => {
  beforeEach(async () => {
    await signIn('me');
  });

  it('this bundle says tournamentVoice in clientHello', () => {
    expect(clientHello('1.0.0', 'b').caps).toContain('tournamentVoice');
    expect(clientHello('1.0.0', 'b', false).caps).toContain('tournamentVoice');
  });

  it('alone (nobody listed): no voice; the server listing another member starts it muted, in the header, connected to the list', async () => {
    socket.fire('tournamentJoined', joined(['me']));
    await settle();
    expect(page.session.screen).toBe('tournamentLobby');
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(muteButton()).toBeNull();
    // the payload's members alone are no company: only who the server announced
    socket.fire('tournamentPlayerJoined', { username: 'ios-user', players: joined(['me', 'ios-user']).players, scoreboard: [] });
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();

    socket.fire('tournamentJoined', joined(['me', 'bob', 'cat']));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }, { socketId: 's-cat', username: 'cat' }] });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.selfMuted).toBe(true);
    expect(page.voice.connectToPeer.mock.calls).toEqual([['s-bob', 'bob'], ['s-cat', 'cat']]);
    expect(muteButton()).not.toBeNull();
    expect(lobbySlot().contains(muteButton())).toBe(true);
    expect(muteButton().getAttribute('aria-label')).toMatch(/Unmute/);
  });

  it('a member announced (voicePeerJoined) starts it; a re-render keeps the buttons; the last one leaving stops it after the grace', async () => {
    vi.useFakeTimers();
    socket.fire('tournamentJoined', joined(['me']));
    socket.fire('voicePeerJoined', { socketId: 's-bob', username: 'bob' });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.connectToPeer).not.toHaveBeenCalled();
    // another tournamentJoined (a return, a reattach) draws the lobby again and the server lists me again
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }] });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    expect(lobbySlot().contains(muteButton())).toBe(true);

    socket.fire('voicePeerLeft', { socketId: 's-bob' });
    await settle();
    expect(page.voice.removePeer).toHaveBeenCalledWith('s-bob');
    await vi.advanceTimersByTimeAsync(VOICE_ALONE_GRACE_MS - 1000);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(page.voice.shutdown).toHaveBeenCalledTimes(1);
    expect(muteButton()).toBeNull();
    // the next arrival starts it again
    socket.fire('voicePeerJoined', { socketId: 's-cat', username: 'cat' });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(2);
  });

  it('a tournament spectator gets no list and starts nothing', async () => {
    socket.fire('tournamentJoined', { ...joined(['bob', 'cat']), isSpectator: true });
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();
  });

  it('back to the main room: voice stops', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }] });
    await settle();
    expect(page.voice.active).toBe(true);
    socket.fire('tournamentLeft', {});
    socket.fire('mainRoomJoined', mainRoomPayload());
    await settle();
    expect(page.session.screen).toBe('mainRoom');
    expect(page.voice.shutdown).toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
    // a list there is no tournament company
    page.voice.initialize.mockClear();
    socket.fire('voicePeerJoined', { socketId: 's-bob', username: 'bob' });
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();
  });
});

describe('a tournament table', () => {
  beforeEach(async () => {
    await signIn('me');
  });

  it('another human at the table: the lobby session ends at startDraw, the table starts muted at seating and connects to the server list', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob', 'cat']));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }, { socketId: 's-cat', username: 'cat' }] });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    // seated: the server ends the room's calls first
    socket.fire('voicePeerLeft', { socketId: 's-bob' });
    socket.fire('voicePeerLeft', { socketId: 's-cat' });
    page.voice.connectToPeer.mockClear();
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    socket.fire('allPlayersReady', { gameId: 'g7' });
    socket.fire('startDraw', { start: true });
    await settle();
    expect(page.session.screen).toBe('table');
    // the room's session is gone with its buffers; nothing at the draw (company unknown)
    expect(page.voice.shutdown).toHaveBeenCalledTimes(1);
    expect(page.voice.active).toBe(false);
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    socket.fire('positionUpdate', seating(['me', 'bob', '🤖 Mary', '🤖 Pat']));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }] });
    socket.fire('createUI', {});
    socket.fire('gameStart', seatDeal({ gameId: 'g7' }));
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(2);
    expect(page.voice.selfMuted).toBe(true);
    expect(page.voice.connectToPeer.mock.calls).toEqual([['s-bob', 'bob']]);
    expect(muteButton()).not.toBeNull();
  });

  it('a table of bots starts nothing (no voice alone)', async () => {
    socket.fire('tournamentJoined', joined(['me']));
    await settle();
    await seatAt(['me', '🤖 Mary', '🤖 Pat', '🤖 Ned']);
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(muteButton()).toBeNull();
  });

  it('table -> score modal -> Return to Tournament -> the room -> the next table: each room its own session, nothing carried over', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob', 'cat']));
    await settle();
    await seatAt(['me', 'bob', 'cat', '🤖 Pat'], { list: ['bob', 'cat'] });
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.connectToPeer.mock.calls).toEqual([['s-bob', 'bob'], ['s-cat', 'cat']]);
    // (the lobby's exit at startDraw tore down a session that never ran)
    page.voice.shutdown.mockClear();
    // the game ends: the score modal keeps the table's calls
    socket.fire('gameEnd', { score: { team1: 300, team2: 120 }, playerStats: {}, tournamentId: 't1' });
    await settle();
    expect(page.session.screen).toBe('gameEnd');
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    socket.clearEmits();
    document.querySelector('#finalScoreOverlay .kit-modal__actions button').click();
    await settle();
    expect(socket.emitted('returnToTournament')).toHaveLength(1);
    expect(page.session.screen).toBe('tournamentLobby');
    expect(page.voice.shutdown).toHaveBeenCalledTimes(1);
    expect(page.voice.active).toBe(false);
    // the server's answer, then the room's list (a member who sat the round out)
    page.voice.connectToPeer.mockClear();
    socket.fire('tournamentJoined', joined(['me', 'bob', 'cat', 'dan'], { phase: 'round_active' }));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-dan', username: 'dan' }] });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(2);
    expect(page.voice.connectToPeer.mock.calls).toEqual([['s-dan', 'dan']]);
    expect(lobbySlot().contains(muteButton())).toBe(true);
    // round 2: seated again
    socket.fire('voicePeerLeft', { socketId: 's-dan' });
    page.voice.connectToPeer.mockClear();
    await seatAt(['me', 'dan', '🤖 Mary', '🤖 Pat'], { gameId: 'g8', list: ['dan'] });
    expect(page.voice.shutdown).toHaveBeenCalledTimes(2);
    expect(page.voice.initialize).toHaveBeenCalledTimes(3);
    expect(page.voice.connectToPeer.mock.calls).toEqual([['s-dan', 'dan']]);
  });

  it('the next round starts while the score modal is up: the old table\'s session ends, the new table starts at its seating', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    await settle();
    await seatAt(['me', 'bob', '🤖 Mary', '🤖 Pat'], { list: ['bob'] });
    page.voice.shutdown.mockClear();
    socket.fire('gameEnd', { score: { team1: 300, team2: 120 }, playerStats: {}, tournamentId: 't1' });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    page.voice.connectToPeer.mockClear();
    await seatAt(['me', 'cat', '🤖 Mary', '🤖 Pat'], { gameId: 'g9', list: ['cat'] });
    // torn down (the startDraw's exit and the new table's entry both run the teardown)
    expect(page.voice.shutdown).toHaveBeenCalled();
    expect(page.voice.active).toBe(true);
    expect(page.voice.initialize).toHaveBeenCalledTimes(2);
    expect(page.voice.connectToPeer.mock.calls).toEqual([['s-cat', 'cat']]);
  });
});
