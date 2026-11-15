/**
 * Sound effects on the real page (events-bots-s12, real handlers, SeqGate,
 * GameState, director and GameScene): what the table asks the
 * SoundManager to play, counted against the recording itself.
 *
 *   - Live play: one card sound per cardPlayed, one deal per gameStart
 *     (when its cards go down), one turn cue per bid or play of mine, the
 *     tricks split by seat parity, one made / set per hand.
 *   - The socket dies mid-hand and the recorded rejoinSuccess lands: not a
 *     sound, and the turn it restores is no cue.
 *   - Play on to gameEnd: still one per event, one game end.
 *   - A spectator joining mid-hand: no sound for the join, no turn cue ever.
 *   - The table's toggle sits first in the HUD voice row and mutes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

let page;
let replay;
let rec;
let sound;
const played = [];

const count = (name) => played.filter((n) => n === name).length;
const s2c = (log, event, from = 0) => log.slice(from).filter((e) => e.dir === 's2c' && e.event === event);

/** What the log says the sounds must be, for my seat. */
function expected(log, pos, from = 0) {
  const tricks = s2c(log, 'trickComplete', from);
  const mine = (e) => e.data.position === pos;
  return {
    card: s2c(log, 'cardPlayed', from).length,
    deal: s2c(log, 'gameStart', from).length,
    // every turn of mine ends in my bid or my play (a human seat, never lazy here)
    turn: s2c(log, 'bidReceived', from).filter(mine).length + s2c(log, 'cardPlayed', from).filter(mine).length,
    'trick-ours': tricks.filter((e) => e.data.winner % 2 === pos % 2).length,
    trick: tricks.filter((e) => e.data.winner % 2 !== pos % 2).length,
    handEnd: s2c(log, 'handComplete', from).length,
    gameend: s2c(log, 'gameEnd', from).length,
  };
}

function actual() {
  return {
    card: count('card'),
    deal: count('deal'),
    turn: count('turn'),
    'trick-ours': count('trick-ours'),
    trick: count('trick'),
    handEnd: count('made') + count('set'),
    gameend: count('gameend'),
  };
}

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  rec = replay.loadRecording('events-bots-s12');
  page = await replay.realTablePage({ username: 'ios_ann', socketId: 'ios-h1' });
  const { getSoundManager } = await import('../audio/SoundManager.js');
  sound = getSoundManager();
  vi.spyOn(sound, 'play').mockImplementation((name) => {
    played.push(name);
    return true;
  });
});

afterAll(() => vi.useRealTimers());

describe('recorded game: one sound per moment, none for a rejoin', () => {
  it('live play to the disconnect', () => {
    const log = rec.logs.seat1;
    replay.replayLog(page, log);
    replay.advance(3000);
    const pos = page.gameState.position;
    expect(pos).toBeTruthy();
    const want = expected(log, pos);
    expect(want.card).toBeGreaterThan(20);
    expect(want.turn).toBeGreaterThan(5);
    expect(actual()).toEqual(want);
    expect(count('overtrump')).toBe(0);
  });

  it('the reconnect and the recorded rejoinSuccess make no sound', () => {
    const before = played.length;
    const rejoin = rec.logs['seat1-rejoin'][0];
    expect(rejoin.event).toBe('rejoinSuccess');
    page.socket.reconnect('ios-h1-r1');
    page.socket.fire('restoreSessionResponse', { success: true, username: 'ios_ann', activeGameId: rec.gameId, blockedUsers: [] });
    page.socket.fire('rejoinSuccess', JSON.parse(JSON.stringify(rejoin.data)));
    replay.advance(3000);
    expect(played.slice(before)).toEqual([]);
  });

  it('play on to gameEnd: still one sound per moment, a turn the rejoin restored is no cue', () => {
    played.length = 0;
    const log = rec.logs['seat1-rejoin'];
    const snap = log[0].data.snapshot;
    replay.replayLog(page, log, { from: 1 });
    replay.advance(3000);
    const pos = page.gameState.position;
    const want = expected(log, pos, 1);
    // the snapshot showed my turn: my next action answers it, no new cue
    if (snap.turn?.position === pos) want.turn -= 1;
    expect(actual()).toEqual(want);
    expect(want.gameend).toBe(1);
    expect(page.session.screen).toBe('gameEnd');
  });
});

describe('the table\'s toggle', () => {
  it('is first in the HUD voice row, a labelled toggle button, and mutes (persisting: SoundManager.test.js)', () => {
    const btn = document.getElementById('sound-toggle-btn');
    // the score modal keeps the table: its toggle is still there
    expect(btn).toBeTruthy();
    expect(btn.parentElement.classList.contains('hud-voice')).toBe(true);
    expect(btn.parentElement.firstElementChild).toBe(btn);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Mute sound effects');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Sound on');
    btn.click();
    expect(sound.muted).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Sound off');
    btn.click();
    expect(sound.muted).toBe(false);
  });
});
