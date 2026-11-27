/**
 * The tournament lobby's voice room as a Cloudflare SFU room, on the page
 * (main.js "Tournament voice"; docs/claude/voice.md "SFU voice, web"; the
 * transport itself is voice/sfu/SfuTransport.test.js):
 *   - the bundle sends the cap sfuVoice
 *   - every lobby entry undecides the mode; the next voice event decides:
 *     an sfuRoster = SFU (company = another member listed), a voicePeerList
 *     = the mesh exactly as before (flag off)
 *   - no voice alone; the last member leaving stops it after the grace
 *   - waiting in line: "Voice is full (N people)", no voice
 *   - leaving the screen (the main room, a table) ends the SFU room
 * One page load; every test signs in afresh. The voice manager is the
 * page's fake (testing/fakePage.js: createFakeSfu for its SFU room).
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
const fullNote = () => document.querySelector('#tournamentLobbyContainer .tournament-voice-full')?.textContent || null;

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
  for (const fn of ['shutdown', 'initialize', 'connectToPeer']) page.voice[fn].mockClear();
  for (const fn of ['enterRoom', 'exitRoom', 'onMeshEvent', 'onRoster']) page.voice.sfu[fn].mockClear();
}

function joined(names = ['me', 'bob']) {
  const base = tournamentPayload({ creator: 'me' });
  return {
    ...base,
    players: names.map((username) => ({ socketId: username === 'me' ? socket.id : `s-${username}`, username, ready: false, connected: true, isCreator: username === 'me' })),
  };
}

const roster = (names, { status = 'admitted', cap = 100 } = {}) => ({
  tournamentId: 't1', bootId: 'boot1', rev: 1, status, cap, graceMs: 38000,
  self: status === 'admitted' ? { sessionId: null, trackName: null, state: 'live' } : null,
  members: names.map((username) => ({ username, sessionId: null, trackName: null, state: 'live' })),
});

describe('the tournament lobby as an SFU room', () => {
  beforeEach(async () => {
    await signIn('me');
  });

  it('this bundle says sfuVoice (with tournamentVoice) in clientHello', () => {
    const caps = clientHello('1.0.0', 'b').caps;
    expect(caps).toContain('sfuVoice');
    expect(caps).toContain('tournamentVoice');
    expect(clientHello('1.0.0', 'b', false).caps).toContain('sfuVoice');
  });

  it('the entry undecides the mode; an sfuRoster with another member starts voice muted, in the header', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    await settle();
    expect(page.voice.sfu.enterRoom).toHaveBeenCalledTimes(1);
    expect(page.voice.initialize).not.toHaveBeenCalled();
    socket.fire('sfuRoster', roster(['bob']));
    await settle();
    expect(page.voice.sfu.mode).toBe('sfu');
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.selfMuted).toBe(true);
    expect(muteButton()).not.toBeNull();
    expect(page.voice.connectToPeer).not.toHaveBeenCalled();
  });

  it('alone in the SFU room: no voice; a member joining starts it; the last leaving stops it after the grace', async () => {
    vi.useFakeTimers();
    socket.fire('tournamentJoined', joined(['me']));
    socket.fire('sfuRoster', roster([]));
    await settle();
    expect(page.voice.initialize).not.toHaveBeenCalled();
    socket.fire('sfuMember', { tournamentId: 't1', bootId: 'boot1', rev: 2, event: 'joined', member: { username: 'bob', sessionId: null, trackName: null, state: 'live' } });
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    // a redraw of the lobby (another tournamentJoined, then its roster): no restart
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('sfuRoster', roster(['bob']));
    await settle();
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    socket.fire('sfuMember', { tournamentId: 't1', bootId: 'boot1', rev: 3, event: 'left', member: { username: 'bob', sessionId: null, trackName: null, state: 'live' } });
    await settle();
    await vi.advanceTimersByTimeAsync(VOICE_ALONE_GRACE_MS - 1000);
    expect(page.voice.shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(page.voice.shutdown).toHaveBeenCalledTimes(1);
    expect(muteButton()).toBeNull();
  });

  it('waiting in line: "Voice is full (N people)" and no voice; admitted: the note goes', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob', 'cat']));
    socket.fire('sfuRoster', roster([], { status: 'waiting', cap: 2 }));
    await settle();
    expect(fullNote()).toBe('Voice is full (2 people)');
    expect(page.voice.initialize).not.toHaveBeenCalled();
    socket.fire('sfuRoster', roster(['bob', 'cat'], { cap: 2 }));
    await settle();
    expect(fullNote()).toBe(null);
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
  });

  it('back to the main room: voice stops and the SFU room is forgotten', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('sfuRoster', roster(['bob']));
    await settle();
    expect(page.voice.active).toBe(true);
    socket.fire('tournamentLeft', {});
    socket.fire('mainRoomJoined', mainRoomPayload());
    await settle();
    expect(page.voice.shutdown).toHaveBeenCalled();
    expect(page.voice.sfu.exitRoom).toHaveBeenCalled();
    expect(page.voice.sfu.mode).toBe(null);
  });

  it('seated at a round\'s table: the room\'s voice ends (the table is the mesh)', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('sfuRoster', roster(['bob']));
    await settle();
    socket.fire('tournamentGameAssignment', { gameId: 'g7', tournamentId: 't1', roundNumber: 1 });
    socket.fire('allPlayersReady', { gameId: 'g7' });
    socket.fire('startDraw', { start: true });
    await settle();
    expect(page.session.screen).toBe('table');
    expect(page.voice.shutdown).toHaveBeenCalled();
    expect(page.voice.sfu.exitRoom).toHaveBeenCalled();
    socket.fire('positionUpdate', {
      gameId: 'g7', positions: [1, 2, 3, 4], sockets: [socket.id, 's-bob', 'bot:x', 'bot:y'],
      usernames: [{ username: 'me' }, { username: 'bob' }, { username: '🤖x' }, { username: '🤖y' }], pics: [1, 2, 3, 4], isBot: [false, false, true, true],
    });
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }] });
    socket.fire('createUI', {});
    socket.fire('gameStart', seatDeal({ gameId: 'g7' }));
    await settle();
    expect(page.voice.connectToPeer).toHaveBeenCalledWith('s-bob', 'bob');
  });
});

describe('the flag off: the same lobby is today\'s mesh', () => {
  beforeEach(async () => {
    await signIn('me');
  });

  it('a voicePeerList decides the mesh: calls as before, no sfu* emit from the page', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('voicePeerList', { peers: [{ socketId: 's-bob', username: 'bob' }] });
    await settle();
    expect(page.voice.sfu.onMeshEvent).toHaveBeenCalled();
    expect(page.voice.sfu.mode).toBe('mesh');
    expect(page.voice.initialize).toHaveBeenCalledTimes(1);
    expect(page.voice.connectToPeer).toHaveBeenCalledWith('s-bob', 'bob');
    expect(socket.emittedNames().filter((e) => e.startsWith('sfu'))).toEqual([]);
  });

  it('tournamentVoiceStatus (the mesh\'s line) is a mesh event too', async () => {
    socket.fire('tournamentJoined', joined(['me', 'bob']));
    socket.fire('tournamentVoiceStatus', { admitted: false, cap: 8 });
    await settle();
    expect(page.voice.sfu.onMeshEvent).toHaveBeenCalled();
    expect(fullNote()).toBe('Voice is full (8 people)');
    expect(page.voice.initialize).not.toHaveBeenCalled();
  });
});
