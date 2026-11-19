/**
 * No voice alone, on the page (owner 2026-11-19; voice/voiceCompany.js,
 * docs/claude/voice.md "No voice alone"): voice runs only while another
 * human shares my room. A lobby with only bots, or a game with only bots,
 * never starts it (no session, no microphone, no controls); a second human
 * joining the lobby or a spectator joining my solo game starts it (muted);
 * the last other human leaving stops it 30 s later, and a return within
 * those 30 s keeps it. Lazy, resigned and away owners count; an owner who
 * left for good (seatLeft) does not. One page load; every test signs in
 * afresh.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPage, tick, mainRoomPayload } from '../testing/fakePage.js';
import { REPO_ROOT } from '../testing/files.js';
import { VOICE_ALONE_GRACE_MS } from '../voice/voiceCompany.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let socket;
let socketCount = 1;
const nextSocketId = () => `sock-${++socketCount}`;

beforeAll(async () => {
  page = await loadPage({ connected: false });
  socket = page.socket;
});

async function signIn(name) {
  socket.fire('forceLogout');
  await tick();
  socket.reconnect(nextSocketId());
  socket.fire('signInResponse', { success: true, username: name, sessionToken: `tok-${name}`, blockedUsers: [] });
  socket.fire('mainRoomJoined', mainRoomPayload());
  expect(page.session.screen).toBe('mainRoom');
  socket.clearEmits();
  page.voice.shutdown.mockClear();
  page.voice.initialize.mockClear();
}

afterEach(() => {
  vi.useRealTimers();
});

const muteButton = () => document.getElementById('voice-mute-btn');
/** Let the async start (initialize) settle without real time passing. */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A capable member's lobby payload; names starting with 🤖 are bots. */
function lobby(names, { lobbyId = 'L1' } = {}) {
  const members = names.map((username) => {
    const bot = username.startsWith('🤖');
    const m = { socketId: username === 'me' ? socket.id : `${bot ? 'bot:' : 's-'}${username}`, username, ready: bot, playing: true };
    if (bot) m.isBot = true;
    return m;
  });
  return {
    lobbyId,
    name: 'Family',
    messages: [],
    players: members.slice(0, 4).map(({ socketId, username, ready, isBot }) => (isBot ? { socketId, username, ready, isBot } : { socketId, username, ready })),
    members, host: 'me', settings: { spectatorsCanTalk: true }, capacity: 8,
  };
}

describe('a lobby', () => {
  beforeEach(async () => {
    await signIn('me');
  });

  it('alone, then with bots: voice never starts (no session, no controls)', async () => {
    socket.fire('lobbyCreated', lobby(['me']));
    expect(page.session.screen).toBe('lobby');
    await settle();
    socket.fire('playerReadyUpdate', lobby(['me', '🤖 Mary', '🤖 Pat', '🤖 Ned']));
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
    expect(muteButton()).toBeNull();
    // the header is the ready count only
    expect(document.querySelector('#lobbyPlayersList .section-label').textContent).toBe('Ready 3/4');
  });

  it('a second human joining starts it, muted with no microphone asked; leaving the lobby stops it', async () => {
    socket.fire('lobbyCreated', lobby(['me', '🤖 Mary']));
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();
    socket.fire('lobbyPlayerJoined', { ...lobby(['me', '🤖 Mary', 'ann']), newPlayer: { socketId: 's-ann', username: 'ann' } });
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.initialize.mock.calls[0][1]).toEqual({});
    expect(page.voice.isMuted()).toBe(true);
    expect(page.voice.isTalking()).toBe(false);
    await vi.waitFor(() => expect(muteButton()).not.toBeNull());
    // leaving the lobby stops it at once (no grace)
    socket.fire('leftLobby');
    expect(page.voice.shutdown).toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
  });

  it('entering a lobby where another human is starts it at once', async () => {
    socket.fire('lobbyCreated', lobby(['ann', 'me']));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
  });

  it('the last other human leaving stops it after 30 s; a return within the grace keeps it', async () => {
    socket.fire('lobbyCreated', lobby(['me', 'ann']));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    socket.fire('lobbyPlayerLeft', { ...lobby(['me']), leftUsername: 'ann', needsMorePlayers: true });
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS - 1000);
    expect(page.voice.active).toBe(true);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    // ann is back within the grace: voice simply carries on
    socket.fire('lobbyPlayerJoined', { ...lobby(['me', 'ann']), newPlayer: { socketId: 's-ann', username: 'ann' } });
    vi.advanceTimersByTime(2 * VOICE_ALONE_GRACE_MS);
    await settle();
    expect(page.voice.active).toBe(true);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    // she leaves again and stays away: voice stops 30 s later, controls gone
    socket.fire('lobbyPlayerLeft', { ...lobby(['me', '🤖 Mary']), leftUsername: 'ann', needsMorePlayers: true });
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS - 1);
    expect(page.voice.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.voice.shutdown).toHaveBeenCalledTimes(1);
    expect(page.voice.active).toBe(false);
    expect(muteButton()).toBeNull();
    // still in the lobby; the next human starts it again (muted)
    expect(page.session.screen).toBe('lobby');
    socket.fire('lobbyPlayerJoined', { ...lobby(['me', '🤖 Mary', 'bob']), newPlayer: { socketId: 's-bob', username: 'bob' } });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(2);
    expect(page.voice.active).toBe(true);
    expect(page.voice.isMuted()).toBe(true);
  });

  it('a seat held for its reconnect grace still counts (voice keeps running)', async () => {
    socket.fire('lobbyCreated', lobby(['me', 'ann']));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = lobby(['me', 'ann']);
    held.members[1].reconnecting = true;
    socket.fire('playerReadyUpdate', { ...held, reconnecting: ['ann'] });
    vi.advanceTimersByTime(2 * VOICE_ALONE_GRACE_MS);
    expect(page.voice.active).toBe(true);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
  });
});

// ---------- a table, from a rejoin's snapshot v2 ----------

const FIXTURE = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/v2/bidding-mid.json'), 'utf8')).snapshot;
const ME = FIXTURE.seats.find((s) => s.position === FIXTURE.viewer.position).ownerUsername;
const GAME = FIXTURE.gameId;

/** The fixture's table with my seat human and every other seat as given ('bot' = a native bot). */
function tableSnapshot(others = {}) {
  const snap = JSON.parse(JSON.stringify(FIXTURE));
  snap.seats = snap.seats.map((s) => {
    if (s.position === FIXTURE.viewer.position) return s;
    const o = others[s.position] || 'bot';
    if (o === 'bot') return { ...s, username: `🤖 Bot${s.position}`, ownerUsername: null, controller: 'bot', presence: 'none', isBot: true };
    return { ...s, ...o };
  });
  snap.watching = { spectators: [], count: 0 };
  return snap;
}

async function rejoinWith(snapshot) {
  socket.reconnect(nextSocketId());
  socket.fire('restoreSessionResponse', { success: true, username: ME, activeGameId: GAME, blockedUsers: [] });
  socket.fire('rejoinSuccess', { snapshot, tournamentId: null });
  await vi.waitFor(() => expect(page.session.screen).toBe('table'));
  await settle();
}

const spectators = (names) => ({ gameId: GAME, spectators: names.map((username) => ({ username, pic: 2 })), count: names.length });

describe('a table', () => {
  beforeEach(async () => {
    await signIn(ME);
  });

  it('a solo game with bots never starts voice; a spectator joining starts it for us both; their leaving stops it after 30 s', async () => {
    await rejoinWith(tableSnapshot());
    expect(page.voice.initialize).not.toHaveBeenCalled();
    expect(page.voice.active).toBe(false);
    expect(muteButton()).toBeNull();
    socket.fire('spectatorsUpdated', spectators(['ann']));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.initialize.mock.calls[0][1]).toEqual({});
    expect(page.voice.isMuted()).toBe(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    socket.fire('spectatorsUpdated', spectators([]));
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS - 1);
    expect(page.voice.active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(page.voice.active).toBe(false);
    expect(page.voice.shutdown).toHaveBeenCalledTimes(1);
    // still at the table, nothing else changed
    expect(page.session.screen).toBe('table');
  });

  it('my own name in the watchers (my other tab is not company) starts nothing', async () => {
    await rejoinWith(tableSnapshot());
    socket.fire('spectatorsUpdated', spectators([ME]));
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();
  });

  it('a lazy owner watching and a resigned owner away count as humans', async () => {
    await rejoinWith(tableSnapshot({ 2: { username: '🤖 Lazy', ownerUsername: 'kim', controller: 'lazyBot', presence: 'connected', isBot: true, lazy: true } }));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    await signIn(ME);
    await rejoinWith(tableSnapshot({ 3: { username: '🤖 Res', ownerUsername: 'lee', controller: 'resignBot', presence: 'away', isBot: true } }));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
  });

  it('a seat owner who left for good (seatLeft) no longer counts: voice stops 30 s later', async () => {
    await rejoinWith(tableSnapshot({ 2: { username: '🤖 Lazy', ownerUsername: 'kim', controller: 'lazyBot', presence: 'connected', isBot: true, lazy: true } }));
    await vi.waitFor(() => expect(page.voice.active).toBe(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // another game's, ignored
    socket.fire('seatLeft', { gameId: 'other-game', position: 2, username: 'kim' });
    vi.advanceTimersByTime(2 * VOICE_ALONE_GRACE_MS);
    expect(page.voice.active).toBe(true);
    socket.fire('seatLeft', { gameId: GAME, position: 2, username: 'kim' });
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS);
    expect(page.voice.active).toBe(false);
    expect(muteButton()).toBeNull();
  });

  it('a snapshot showing the only other owner gone starts nothing', async () => {
    await rejoinWith(tableSnapshot({ 2: { username: '🤖 Left', ownerUsername: 'kim', controller: 'lazyBot', presence: 'gone', isBot: true } }));
    expect(page.voice.initialize).not.toHaveBeenCalled();
  });
});
