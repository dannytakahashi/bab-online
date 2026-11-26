/**
 * Who a seat shows follows playerLazyMode / playerActiveMode / playerResigned
 * at once: my own plate (and its avatar's alt and tooltip), an opponent's
 * plate. The game log's score header names the TEAMS, so it keeps the
 * seat's owner while a lazy or resign bot plays for them (owner rule
 * 2026-11-25: teams by player names, never the bot persona). No later
 * event may be needed to correct either.
 *
 * The recorded live table events-bots-s12, seat 1, the real page and scene;
 * each sequence stops on MY open turn, where nothing else arrives until I act.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let log;
let seqGate;

const ME = 'ios_ann';

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  const rec = replay.loadRecording('events-bots-s12');
  log = rec.logs.seat1;
  page = await replay.realTablePage({ username: ME, socketId: 'ios-h1' });
  ({ getSeqGate: seqGate } = await import('../state/SeqGate.js'));
  // up to my first turn in the play of a hand (an updateTurn to seat 1 after doneBidding)
  const k = log.findIndex((e, i) => e.event === 'updateTurn' && e.data.currentTurn === 1 &&
    log.slice(0, i).some((p) => p.event === 'doneBidding'));
  expect(k).toBeGreaterThan(0);
  replay.replayLog(page, log, { to: k + 1 });
  replay.advance(3000);
});

afterAll(() => vi.useRealTimers());

const seq = () => seqGate().lastSeq + 1;
const header = () => document.querySelector('#teamScoreDisplay .log-score__names')?.textContent;
const oppHeader = () => document.querySelector('#oppScoreDisplay .log-score__names')?.textContent;
const myPlate = () => document.querySelector('#player-avatar-container .hud-plate');
const myImg = () => document.querySelector('#player-avatar-container img');
const oppPlate = (slot) => page.scene.opponentManager._avatarDoms[slot]?.querySelector('.hud-plate')?.textContent;

describe('seat display follows lazy / active / resign at once', () => {
  it('starts on my open turn with my name everywhere', () => {
    expect(page.gameState.currentTurn).toBe(1);
    expect(header()).toMatch(new RegExp(`^${ME}/`));
    expect(myPlate().textContent).toBe(ME);
  });

  it('/lazy then /active at my seat: plate, alt and tooltip, with no other event; the header keeps my name', () => {
    const partner = page.gameState.getPlayerNameByPosition(3);
    page.socket.fire('playerLazyMode', { position: 1, botUsername: '🤖 Zach', botPic: 7, originalUsername: ME, seq: seq() });
    expect(header()).toBe(`${ME}/${partner}`);
    expect(myPlate().textContent).toBe('🤖 Zach');
    expect(myPlate().title).toBe('🤖 Zach');
    expect(myImg().alt).toBe('🤖 Zach');

    page.socket.fire('playerActiveMode', { position: 1, username: ME, pic: 3, seq: seq() });
    expect(header()).toBe(`${ME}/${partner}`);
    expect(myPlate().textContent).toBe(ME);
    expect(myPlate().title).toBe(ME);
    expect(myImg().alt).toBe(ME);

    // a full re-render agrees
    page.scene.render();
    expect(header()).toBe(`${ME}/${partner}`);
    expect(myPlate().textContent).toBe(ME);
  });

  it('an AFK takeover (playerLazyMode + its log line) then /active', () => {
    const partner = page.gameState.getPlayerNameByPosition(3);
    page.socket.fire('playerLazyMode', { position: 1, botUsername: '🤖 Mike', botPic: 4, originalUsername: ME, seq: seq() });
    page.socket.fire('gameLogEntry', { message: `${ME} was idle and 🤖 Mike is playing for them. Type /active to return.`, type: 'system', seq: seq() });
    expect(header()).toBe(`${ME}/${partner}`);
    expect(myPlate().textContent).toBe('🤖 Mike');
    page.socket.fire('playerActiveMode', { position: 1, username: ME, pic: 3, seq: seq() });
    expect(header()).toBe(`${ME}/${partner}`);
    expect(myPlate().textContent).toBe(ME);
  });

  it('an opponent going lazy, resigning and coming back: the plates follow, the opponents\' side keeps its players\' names', () => {
    const owner = page.gameState.getPlayerNameByPosition(2);
    const other = page.gameState.getPlayerNameByPosition(4);
    page.socket.fire('playerLazyMode', { position: 2, botUsername: 'Lazy Bot', botPic: 7, originalUsername: owner, seq: seq() });
    expect(oppHeader()).toBe(`${owner}/${other}`);
    expect(oppPlate('opp1')).toBe('Lazy Bot');
    page.socket.fire('playerActiveMode', { position: 2, username: owner, pic: 3, seq: seq() });
    expect(oppHeader()).toBe(`${owner}/${other}`);
    expect(oppPlate('opp1')).toBe(owner);
    page.socket.fire('playerResigned', { position: 4, oldUsername: other, botUsername: 'Resign Bot', botPic: 5, seq: seq() });
    expect(oppHeader()).toBe(`${owner}/${other}`);
    expect(oppPlate('opp2')).toBe('Resign Bot');
  });

  it('game end with lazy seats: the score screen and the log name the owners, never the bots', () => {
    // the seats' owners (seat 4 was resigned to 'Resign Bot' above: its
    // owner still names it)
    const { 2: owner, 3: partner, 4: other } = page.gameState.seatOwners;
    expect(page.gameState.getPlayerNameByPosition(4)).toBe('Resign Bot');
    expect(other).not.toBe('Resign Bot');
    page.socket.fire('playerLazyMode', { position: 1, botUsername: '🤖 Zach', botPic: 7, originalUsername: ME, seq: seq() });
    page.socket.fire('playerLazyMode', { position: 2, botUsername: '🤖 Gina', botPic: 8, originalUsername: owner, seq: seq() });
    expect(myPlate().textContent).toBe('🤖 Zach');
    const stat = (username) => ({ username, totalBids: 3, totalTricks: 3, setsCaused: 0, totalHSI: 130, avgHSI: 130 });
    page.socket.fire('gameEnd', {
      score: { team1: 210, team2: 150 },
      // the server names a lazy seat's owner (gameHandlers.seatName)
      playerStats: { 1: stat(ME), 2: stat(owner), 3: stat(partner), 4: stat(other) },
      tournamentId: null,
      seq: seq(),
    });
    replay.advance(100);
    const score = document.querySelector('.result-score')?.textContent;
    expect(score).toBe(`${ME}/${partner}: 210  —  ${owner}/${other}: 150`);
    const rows = [...document.querySelectorAll('.result-stats__name')].map((n) => n.textContent);
    expect(rows).toEqual([ME, owner, partner, other]);
    expect(header()).toBe(`${ME}/${partner}`);
    expect(oppHeader()).toBe(`${owner}/${other}`);
    const logText = document.body.textContent;
    expect(logText).toContain(`${ME}/${partner}: 210`);
    expect(logText).not.toMatch(/(🤖 Zach|🤖 Gina|Resign Bot)\//);
    expect(logText).not.toMatch(/\/(🤖 Zach|🤖 Gina|Resign Bot)/);
  });
});
