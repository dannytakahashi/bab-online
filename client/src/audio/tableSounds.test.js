/**
 * Event -> sound, through the real handlers (handlers/gameHandlers.js), the
 * seq gate and GameState, with a recording SoundManager: the card on every
 * cardPlayed, the over-trump accent, the turn reminder: on the edge into MY
 * turn only, and only if that turn is still open TURN_IDLE_MS later (a bid
 * turn counts from the trump flip),
 * trick-ours by seat parity, made / set from my team's bid, the game end
 * after the last made / set; spectators and lazy seats; nothing while the
 * gate replays or flushes buffered events, and a snapshot is the turn
 * baseline. The bid clock's tune: end-aligned, kept / sought / stopped by
 * the clock's state, ringing out on a timeout, started by a snapshot or by
 * sound coming back, heard by spectators and lazy watchers.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { SocketManager } from '../socket/SocketManager.js';
import { registerGameHandlers } from '../handlers/gameHandlers.js';
import { resetGameState, getGameState } from '../state/GameState.js';
import { resetSeqGate } from '../state/SeqGate.js';
import { resetMyAction } from '../state/MyAction.js';
import { resetTableDirector } from '../phaser/TableDirector.js';
import {
  resetTableSounds, installTableSoundSync, OVER_TRUMP_DELAY_S, OVER_TRUMP_GAIN, TURN_IDLE_MS, GAME_END_AFTER_HAND_S, SPECTATOR_HAND_END_GAIN,
  DRAW_GAIN, DRAW_SPACING_MS,
} from './tableSounds.js';
import { SERVER_EVENTS as E } from '../constants/events.js';
import { applyTableSnapshot } from '../state/tableSync.js';
import { setBidClockNow, BID_CLOCK_SOUND, TUNE_FADE_S } from '../state/bidClock.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The repo root (vitest's config root is client/)
const ROOT = existsSync(resolve(process.cwd(), 'contract')) ? process.cwd() : resolve(process.cwd(), '..');

function createMockSocket() {
  const listeners = new Map();
  return {
    on: vi.fn((event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
    }),
    off: vi.fn(),
    emit: vi.fn(),
    fire: (event, data) => listeners.get(event)?.forEach((cb) => cb(data)),
  };
}

let socket;
let gate;
let sounds;
let played;
let seq;
let clock;
let timers;
// the bid clock's tune: every start() and the decoded file's length
let tunes;
let decoded;
let refuse;

const c = (rank, suit) => ({ rank, suit });
const fire = (event, data = {}) => socket.fire(event, { ...data, seq: ++seq });
const names = () => played.map((p) => p.name);
/** TURN_IDLE_MS pass: every waiting turn reminder fires. */
const idle = () => {
  const due = timers.list;
  timers.list = [];
  for (const t of due) {
    expect(t.ms).toBe(TURN_IDLE_MS);
    t.fn();
  }
};

/** A 2-card deal at my seat (1), trump spades; `flipped`: its trump is face up (main.js onFlipped). */
function deal({ position = 1, gameId = 'g1', flipped = true } = {}) {
  fire(E.GAME_START, {
    position, gameId, dealer: 4, currentHand: 2, trump: c('5', 'spades'),
    hand: [c('A', 'hearts'), c('3', 'spades')],
  });
  if (flipped) sounds.trumpShown();
}

beforeEach(() => {
  sessionStorage.clear();
  resetGameState();
  resetMyAction();
  resetTableDirector();
  seq = 0;
  clock = 100000;
  played = [];
  timers = {
    list: [],
    set(fn, ms) { const t = { fn, ms }; this.list.push(t); return t; },
    clear(t) { this.list = this.list.filter((x) => x !== t); },
  };
  gate = resetSeqGate({ requestSnapshot: vi.fn(), setTimer: () => 1, clearTimer: () => {} });
  tunes = [];
  decoded = 30.02;
  refuse = false;
  setBidClockNow(() => clock);
  const fakeSound = {
    play: (name, opts) => (played.push({ name, opts }), true),
    duration: (name) => (name === BID_CLOCK_SOUND ? decoded : null),
    start: (name, { offset = 0 } = {}) => {
      if (refuse) return null;
      const startedAt = clock;
      const h = {
        name,
        offset,
        playing: true,
        stops: [],
        get position() { return offset + (clock - startedAt) / 1000; },
        stop(fade) {
          if (!h.playing) return;
          h.playing = false;
          h.stops.push(fade);
        },
      };
      tunes.push(h);
      return h;
    },
  };
  sounds = resetTableSounds({
    sound: () => fakeSound,
    now: () => clock,
    timers,
  });
  socket = createMockSocket();
  const manager = new SocketManager(socket);
  manager.setGate(gate);
  registerGameHandlers(manager, {});
});

afterAll(() => setBidClockNow(null));

describe('the table\'s moments', () => {
  it('a deal sounds when its cards go down, once', () => {
    deal();
    expect(names()).toEqual([]);
    expect(sounds.dealShown()).toBe(true);
    expect(sounds.dealShown()).toBe(false);
    expect(names()).toEqual(['deal']);
  });

  it('every card played (mine, partner\'s, bots\') is a card sound', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 2 });
    fire(E.CARD_PLAYED, { position: 2, card: c('K', 'hearts') });
    fire(E.CARD_PLAYED, { position: 3, card: c('2', 'hearts') });
    fire(E.CARD_PLAYED, { position: 4, card: c('4', 'hearts') });
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    expect(names()).toEqual(['card', 'card', 'card', 'card']);
  });

  it('an over-trump adds the accent just after its card, quieter; an under-trump or a partner\'s does not', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 2 });
    fire(E.CARD_PLAYED, { position: 2, card: c('K', 'hearts') });
    fire(E.CARD_PLAYED, { position: 3, card: c('4', 'spades') }); // partner ruffs
    fire(E.CARD_PLAYED, { position: 4, card: c('9', 'spades') }); // over-trumps my partner
    expect(names()).toEqual(['card', 'card', 'card', 'overtrump']);
    expect(played.at(-1).opts).toEqual({ delay: OVER_TRUMP_DELAY_S, gain: OVER_TRUMP_GAIN });
    // my 3 of spades under it: no accent
    fire(E.CARD_PLAYED, { position: 1, card: c('3', 'spades') });
    expect(names().at(-1)).toBe('card');
    expect(names().filter((n) => n === 'overtrump')).toHaveLength(1);
  });

  it('the turn reminder: only on the edge into MY turn, to bid and to play, once TURN_IDLE_MS have passed', () => {
    expect(TURN_IDLE_MS).toBe(5000);
    deal();
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    idle();
    expect(names()).toEqual([]);
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(names()).toEqual([]);
    idle();
    expect(names()).toEqual(['turn']);
    // a repeated updateTurn (the /active resend) is not a new turn
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    idle();
    expect(names()).toEqual(['turn']);
    fire(E.BID_RECEIVED, { position: 1, bid: '1' });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    // I lead: doneBidding names me, then its updateTurn: one reminder
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    idle();
    expect(names()).toEqual(['turn', 'turn']);
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    idle();
    expect(names().filter((n) => n === 'turn')).toHaveLength(2);
  });

  it('no reminder when I act within TURN_IDLE_MS: my bid, my card, or the turn moving on cancels it (owner 2026-11-15: too noisy on every turn)', () => {
    deal();
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(sounds.turnReminderPending).toBe(true);
    fire(E.BID_RECEIVED, { position: 1, bid: '1' });
    expect(sounds.turnReminderPending).toBe(false);
    idle();
    expect(names()).toEqual([]);
    // my lead, played at once: the card sounds, the chime never does
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    idle();
    expect(names()).toEqual(['card']);
    // a turn that moves on without my action (a lazy takeover, a resync's updateTurn)
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    idle();
    expect(names()).toEqual(['card']);
    // the game end cancels a waiting one
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.GAME_END, { score: { team1: 0, team2: 0 } });
    idle();
    expect(names()).toEqual(['card', 'gameend']);
  });

  it('a reminder that fires after the turn changed hands and came back does not count the old wait', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    fire(E.CARD_PLAYED, { position: 2, card: c('2', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 3 });
    fire(E.CARD_PLAYED, { position: 3, card: c('3', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 4 });
    fire(E.CARD_PLAYED, { position: 4, card: c('4', 'hearts') });
    fire(E.TRICK_COMPLETE, { winner: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    // one timer, for the new turn only
    expect(timers.list).toHaveLength(1);
  });

  it('a snapshot or a new deal cancels a waiting reminder', () => {
    deal();
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    sounds.synced();
    idle();
    deal();
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    deal();
    idle();
    expect(names()).toEqual([]);
  });

  it('a bid turn that comes before the trump is face up (the next hand comes with handComplete) waits for it', () => {
    deal({ flipped: false });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(names()).toEqual([]);
    // the cards go down, then the trump flips and the bid panel opens
    sounds.dealShown();
    idle(); // nothing waits before the flip
    expect(sounds.trumpShown()).toBe(true);
    expect(names()).toEqual(['deal']);
    idle();
    expect(names()).toEqual(['deal', 'turn']);
    // once: the flip is not a new turn, nor a later updateTurn
    expect(sounds.trumpShown()).toBe(false);
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    idle();
    expect(names()).toEqual(['deal', 'turn']);
  });

  it('a bid turn that waited for the flip: none when it moved on or a snapshot replaced the table first', () => {
    deal({ flipped: false });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    expect(sounds.trumpShown()).toBe(false);
    deal({ flipped: false });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    sounds.synced();
    expect(sounds.trumpShown()).toBe(false);
    idle();
    expect(names()).toEqual([]);
    // after the flip a bid turn starts its reminder at once
    deal({ flipped: false });
    sounds.trumpShown();
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    idle();
    expect(played).toEqual([{ name: 'turn', opts: undefined }]);
  });

  it('winning a trick and leading the next one: a new turn after my own play', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    fire(E.CARD_PLAYED, { position: 2, card: c('2', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 3 });
    fire(E.CARD_PLAYED, { position: 3, card: c('3', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 4 });
    fire(E.CARD_PLAYED, { position: 4, card: c('4', 'hearts') });
    fire(E.TRICK_COMPLETE, { winner: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    idle();
    // my first lead was played at once (no reminder); the second waits
    expect(names().filter((n) => n === 'turn')).toHaveLength(1);
  });

  it('trick-ours when my team (seat parity) takes the trick, trick otherwise', () => {
    deal();
    fire(E.TRICK_COMPLETE, { winner: 3 });
    fire(E.TRICK_COMPLETE, { winner: 2 });
    fire(E.TRICK_COMPLETE, { winner: 1 });
    fire(E.TRICK_COMPLETE, { winner: 4 });
    expect(names()).toEqual(['trick-ours', 'trick', 'trick-ours', 'trick']);
  });

  it('seat 2 or 4: parity the other way', () => {
    deal({ position: 4 });
    fire(E.TRICK_COMPLETE, { winner: 2 });
    fire(E.TRICK_COMPLETE, { winner: 1 });
    expect(names()).toEqual(['trick-ours', 'trick']);
  });

  it('made / set from my team\'s tricks against its bid total', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.HAND_COMPLETE, { team1Tricks: 2, team2Tricks: 0, score: { team1: 20, team2: 0 }, team1OldScore: 0, team2OldScore: 0 });
    expect(names()).toEqual(['made']);
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.HAND_COMPLETE, { team1Tricks: 1, team2Tricks: 1, score: { team1: 0, team2: 1 }, team1OldScore: 20, team2OldScore: 0 });
    expect(names()).toEqual(['made', 'set']);
  });

  it('a bore counts the whole hand; seat 2\'s team reads team2Tricks', () => {
    deal({ position: 2 });
    fire(E.DONE_BIDDING, { bids: ['0', 'B', '1', '0'], lead: 2 });
    fire(E.HAND_COMPLETE, { team1Tricks: 0, team2Tricks: 2, score: { team1: 0, team2: 40 } });
    deal({ position: 2 });
    fire(E.DONE_BIDDING, { bids: ['0', 'B', '1', '0'], lead: 2 });
    fire(E.HAND_COMPLETE, { team1Tricks: 1, team2Tricks: 1, score: { team1: 0, team2: 0 } });
    expect(names()).toEqual(['made', 'set']);
  });

  it('game end: my team\'s win is the fanfare', () => {
    deal();
    fire(E.GAME_END, { score: { team1: 300, team2: 100 }, tournamentId: null });
    expect(played).toEqual([{ name: 'gameend-win', opts: undefined }]);
  });

  it('game end: the fanfare for a win, the sad trombone for a loss, the arpeggio for a tie (owner 2026-11-22)', () => {
    deal(); // seat 1: team 1
    fire(E.GAME_END, { score: { team1: 120, team2: 300 }, tournamentId: null });
    deal({ position: 2 }); // team 2 wins the same game
    fire(E.GAME_END, { score: { team1: 120, team2: 300 }, tournamentId: null });
    deal({ position: 4 }); // team 2 loses
    fire(E.GAME_END, { score: { team1: 310, team2: -40 } });
    deal({ position: 3 }); // a tie: no loser
    fire(E.GAME_END, { score: { team1: 200, team2: 200 } });
    deal(); // no score in the payload: never the trombone
    fire(E.GAME_END, { tournamentId: null });
    expect(names()).toEqual(['gameend-lose', 'gameend-win', 'gameend-lose', 'gameend', 'gameend']);
  });

  it('game end: a spectator hears the arpeggio whoever won; a lazy watcher keeps its team\'s verdict', () => {
    deal();
    getGameState().isSpectator = true;
    fire(E.GAME_END, { score: { team1: 0, team2: 500 } });
    deal({ position: 3 });
    getGameState().applyMyLazy(true);
    fire(E.GAME_END, { score: { team1: 0, team2: 500 } });
    expect(names()).toEqual(['gameend', 'gameend-lose']);
  });

  it('the trombone follows the last hand\'s set by GAME_END_AFTER_HAND_S, as the fanfare does', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.HAND_COMPLETE, { team1Tricks: 0, team2Tricks: 2, score: { team1: -20, team2: 40 } });
    clock += 3;
    fire(E.GAME_END, { score: { team1: -20, team2: 40 } });
    expect(names()).toEqual(['set', 'gameend-lose']);
    expect(played[1].opts.delay).toBeCloseTo(GAME_END_AFTER_HAND_S - 0.003, 6);
  });

  it('the last hand: made / set, then the game end GAME_END_AFTER_HAND_S later, not on top of it', () => {
    deal();
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    // the server sends both in one tick
    fire(E.HAND_COMPLETE, { team1Tricks: 2, team2Tricks: 0, score: { team1: 320, team2: 0 } });
    clock += 3;
    fire(E.GAME_END, { score: { team1: 320, team2: 0 } });
    expect(names()).toEqual(['made', 'gameend-win']);
    expect(played[1].opts.delay).toBeCloseTo(GAME_END_AFTER_HAND_S - 0.003, 6);
    // a hand end long before (an abort later) does not hold it
    deal();
    fire(E.HAND_COMPLETE, { team1Tricks: 2, team2Tricks: 0, score: { team1: 20, team2: 0 } });
    clock += 5000;
    fire(E.GAME_END, { score: { team1: 20, team2: 0 } });
    expect(played.at(-1)).toEqual({ name: 'gameend-win', opts: undefined });
  });
});

describe('who hears what', () => {
  it('a spectator: the table, no turn cue, every trick the neutral one, the hand end a quieter made', () => {
    deal();
    const s = getGameState();
    s.isSpectator = true;
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.TRICK_COMPLETE, { winner: 1 });
    fire(E.HAND_COMPLETE, { team1Tricks: 1, team2Tricks: 0, score: { team1: 10, team2: 0 } });
    fire(E.GAME_END, { score: { team1: 10, team2: 0 } });
    idle();
    expect(names()).toEqual(['card', 'trick', 'made', 'gameend']);
    expect(played[2].opts).toEqual({ gain: SPECTATOR_HAND_END_GAIN });
  });

  it('a lazy seat (the bot plays it): no turn cue; its team still hears trick-ours and made', () => {
    deal();
    getGameState().applyMyLazy(true);
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.TRICK_COMPLETE, { winner: 3 });
    fire(E.HAND_COMPLETE, { team1Tricks: 2, team2Tricks: 0, score: { team1: 0, team2: 0 } });
    idle();
    expect(names()).toEqual(['trick-ours', 'made']);
  });
});

describe('never on catch-up', () => {
  it('events the gate buffered and replays after the snapshot are silent; the next live one sounds', () => {
    deal(); // seq 1
    // seq 2 is lost: 3 and 4 wait for the resync
    seq = 2;
    fire(E.UPDATE_TURN, { currentTurn: 1 }); // 3
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') }); // 4
    expect(gate.buffered).toBe(2);
    expect(names()).toEqual([]);
    gate.onSnapshot({ seq: 2, gameId: 'g1' });
    expect(gate.buffered).toBe(0);
    expect(getGameState().currentTrick).toHaveLength(1);
    expect(names()).toEqual([]);
    expect(gate.replaying).toBe(false);
    fire(E.CARD_PLAYED, { position: 2, card: c('2', 'hearts') }); // 5, live
    expect(names()).toEqual(['card']);
  });

  it('a buffer flushed after the gap timeout is silent too', () => {
    deal();
    seq = 2;
    fire(E.TRICK_COMPLETE, { winner: 1 });
    fire(E.GAME_END, { score: { team1: 1, team2: 0 } });
    gate.flushBuffer();
    expect(gate.stats.flushed).toBe(2);
    expect(names()).toEqual([]);
  });

  it('a deal replayed from the buffer leaves no deal sound for its cards', () => {
    fire(E.UPDATE_TURN, { currentTurn: 2 }); // 1: baseline
    seq = 2;
    deal(); // 3: buffered
    gate.onSnapshot({ seq: 2, gameId: 'g1' });
    expect(sounds.dealShown()).toBe(false);
    expect(names()).toEqual([]);
  });

  it('a snapshot that shows my turn is the baseline: its updateTurn is no cue', () => {
    deal();
    // rejoin / resync: the table comes back on my turn (tableSync calls synced())
    getGameState().currentTurn = 1;
    sounds.synced();
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(names()).toEqual([]);
    // the next real turn after my play does sound
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    idle();
    expect(names()).toEqual(['card', 'turn']);
  });

  it('through the real restore path (tableSync): a snapshot on my turn is silent, so is its replay, and its updateTurn is no cue', () => {
    // contract/fixtures/v2 bidding-mid: seat 4's own view, its turn to bid, seq 14
    const fixture = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/v2/bidding-mid.json'), 'utf8'));
    const gameId = fixture.snapshot.gameId;
    deal({ position: 4, gameId }); // seq 1: the baseline
    played.length = 0;
    // 2-14 lost; 15 waits for the resync
    seq = 14;
    fire(E.BID_RECEIVED, { position: 4, bid: '2' }); // 15: buffered
    seq = 14;
    expect(gate.buffered).toBe(1);
    const snap = applyTableSnapshot({ snapshot: fixture.snapshot }, { source: 'gap' });
    expect(snap?.seq).toBe(14);
    // the replayed bid (mine) applied without a sound
    expect(getGameState().bids[4]).toBe('2');
    expect(names()).toEqual([]);
    seq = 15;
    fire(E.UPDATE_TURN, { currentTurn: 1 }); // 16
    fire(E.UPDATE_TURN, { currentTurn: 4 }); // 17: a new turn of mine
    idle();
    expect(names()).toEqual(['turn']);
  });

  it('a rejoin snapshot on my turn: the updateTurn after it is no cue', () => {
    const fixture = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/v2/bidding-mid.json'), 'utf8'));
    applyTableSnapshot({ snapshot: fixture.snapshot }, { source: 'rejoin' });
    expect(getGameState().currentTurn).toBe(4);
    expect(getGameState().position).toBe(4);
    seq = 14;
    fire(E.UPDATE_TURN, { currentTurn: 4 });
    expect(names()).toEqual([]);
  });

  it('a snapshot between a deal and its cards drops the deal sound', () => {
    deal();
    sounds.synced();
    expect(sounds.dealShown()).toBe(false);
  });
});

describe('the draw for deal', () => {
  const drew = (drawOrder, username, card = c('7', 'clubs')) => fire(E.PLAYER_DREW, { username, card, drawOrder, socketId: `s-${drawOrder}` });
  /** DRAW_SPACING_MS pass: the waiting draw timer fires. */
  const spacing = () => {
    const due = timers.list;
    timers.list = [];
    for (const t of due) {
      expect(t.ms).toBe(DRAW_SPACING_MS);
      t.fn();
    }
  };
  const startDraw = () => {
    gate.reset();
    seq = 0;
    fire(E.START_DRAW, { start: true });
  };

  it('each card drawn (mine and the bots\') is a quieter card take; my private youDrew, a re-sent draw and the teams are not', () => {
    startDraw();
    socket.fire(E.YOU_DREW, { card: c('Q', 'spades'), drawOrder: 1 });
    expect(names()).toEqual([]);
    drew(1, 'me', c('Q', 'spades'));
    spacing();
    drew(2, 'B1');
    spacing();
    drew(3, 'B2');
    spacing();
    drew(4, 'B3');
    spacing();
    expect(names()).toEqual(['draw', 'draw', 'draw', 'draw']);
    for (const p of played) expect(p.opts).toEqual({ gain: DRAW_GAIN });
    expect(getGameState().draw.drawn).toHaveLength(4);
    // the same draw order again: state, not a new card
    drew(4, 'B3');
    fire(E.TEAMS_ANNOUNCED, { team1: ['me', 'B2'], team2: ['B1', 'B3'], resumeInMs: 3000 });
    spacing();
    expect(names()).toHaveLength(4);
  });

  it('draws that arrive together (the 30 s auto-draws) are heard one by one, DRAW_SPACING_MS apart', () => {
    startDraw();
    drew(1, 'me');
    drew(2, 'B1');
    drew(3, 'B2');
    expect(names()).toEqual(['draw']);
    expect(sounds.drawsWaiting).toBe(2);
    spacing();
    expect(names()).toEqual(['draw', 'draw']);
    spacing();
    expect(names()).toEqual(['draw', 'draw', 'draw']);
    spacing(); // the last one's spacing runs out: nothing waits
    expect(timers.list).toEqual([]);
    drew(4, 'B3');
    expect(names()).toHaveLength(4);
  });

  it('a snapshot drops the draws still waiting', () => {
    startDraw();
    drew(1, 'me');
    drew(2, 'B1');
    drew(3, 'B2');
    sounds.synced();
    expect(sounds.drawsWaiting).toBe(0);
    expect(timers.list).toEqual([]);
    expect(names()).toEqual(['draw']);
  });

  it('draws the gate buffered and flushed are silent', () => {
    startDraw(); // seq 1
    seq = 2; // seq 2 is lost
    drew(2, 'B1'); // 3: buffered
    drew(3, 'B2'); // 4: buffered
    expect(gate.buffered).toBe(2);
    gate.flushBuffer();
    expect(getGameState().draw.drawn).toHaveLength(2);
    expect(names()).toEqual([]);
    drew(4, 'B3'); // 5, live
    expect(names()).toEqual(['draw']);
  });

  it('through the real restore path: a rejoin mid-draw shows the cards drawn without a sound; the next live draw sounds', () => {
    // contract/fixtures/v2 draw-in-progress: two drawn, seq 3
    const fixture = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/v2/draw-in-progress.json'), 'utf8'));
    applyTableSnapshot({ snapshot: fixture.snapshot }, { source: 'rejoin' });
    expect(getGameState().draw.drawn).toHaveLength(2);
    expect(names()).toEqual([]);
    seq = fixture.snapshot.seq;
    drew(3, 'B2');
    expect(names()).toEqual(['draw']);
  });
});

describe('the bid clock\'s tune', () => {
  const G = 'g1';
  const running = (position, inMs, durationMs = 30000) => socket.fire(E.BID_CLOCK, { gameId: G, position, running: true, inMs, durationMs });
  const stopped = (position, reason) => socket.fire(E.BID_CLOCK, { gameId: G, position, running: false, reason });
  /** A deal, then seat `pos`'s bid turn. */
  const turnOf = (pos) => {
    deal();
    fire(E.UPDATE_TURN, { currentTurn: pos });
  };
  const last = () => tunes.at(-1);

  it('starts END-aligned with the clock (the decoded file\'s length minus the time left), for every seat\'s clock', () => {
    turnOf(2);
    running(2, 30000);
    expect(tunes).toHaveLength(1);
    expect(last().name).toBe('bidclock');
    expect(last().offset).toBeCloseTo(0.02, 5);
    expect(sounds.tunePlaying).toBe(true);
    // a resent running for the same deadline keeps it (no restart)
    clock += 400;
    running(2, 29600);
    expect(tunes).toHaveLength(1);
    // a shortened clock (tests, a resume) starts part-way
    stopped(2, 'controller');
    running(2, 12000);
    expect(tunes).toHaveLength(2);
    expect(last().offset).toBeCloseTo(18.02, 5);
    // the countdown's scale is never assumed: no decoded file yet uses durationMs
    decoded = null;
    stopped(2, 'controller');
    running(2, 5000, 20000);
    expect(last().offset).toBeCloseTo(15, 5);
  });

  it('less than a second left: nothing starts', () => {
    turnOf(2);
    running(2, 900);
    expect(tunes).toEqual([]);
    expect(getGameState().bidClock).toBeTruthy();
  });

  const clears = {
    'bid (the seat\'s bidReceived)': () => fire(E.BID_RECEIVED, { position: 2, bid: '1' }),
    'stopped bid': () => stopped(2, 'bid'),
    'stopped controller (a bot took the seat)': () => stopped(2, 'controller'),
    'stopped turn': () => stopped(2, 'turn'),
    'the turn moving to another seat': () => fire(E.UPDATE_TURN, { currentTurn: 3 }),
    'doneBidding': () => fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 }),
    'a deal (gameStart)': () => deal(),
    'destroyHands (the all-zero redeal)': () => fire(E.DESTROY_HANDS, {}),
    'gameEnd': () => fire(E.GAME_END, { score: { team1: 0, team2: 0 } }),
    'abortGame': () => fire(E.ABORT_GAME, {}),
    'leftGame': () => fire(E.LEFT_GAME, {}),
    'my socket dropping': () => sounds.disconnected(),
    'reset (the table torn down)': () => sounds.reset(),
  };
  for (const [what, act] of Object.entries(clears)) {
    it(`stops (a short fade) on ${what}`, () => {
      turnOf(2);
      running(2, 30000);
      clock += 5000;
      const h = last();
      act();
      expect(h.playing).toBe(false);
      expect(h.stops).toEqual([TUNE_FADE_S]);
      expect(sounds.tunePlaying).toBe(false);
    });
  }

  it('another seat\'s bid or a repeated updateTurn to the bidder does not stop it', () => {
    turnOf(2);
    running(2, 30000);
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    fire(E.BID_RECEIVED, { position: 1, bid: '1' });
    stopped(3, 'bid');
    expect(last().playing).toBe(true);
  });

  it('a timeout lets its end ring: the bid 0 and the updateTurn after it do not cut it; gameEnd does', () => {
    turnOf(2);
    running(2, 30000);
    clock += 29600;
    const h = last();
    stopped(2, 'timeout');
    fire(E.GAME_LOG_ENTRY, { message: 'kai ran out of time.', type: 'system' });
    fire(E.BID_RECEIVED, { position: 2, bid: '0' });
    fire(E.UPDATE_TURN, { currentTurn: 3 });
    expect(h.playing).toBe(true);
    expect(getGameState().bidClock).toBe(null);
    fire(E.GAME_END, { score: { team1: 0, team2: 0 } });
    expect(h.playing).toBe(false);
  });

  it('a ringing end is cut by a new clock, and by a timeout still far from its end locally', () => {
    turnOf(2);
    running(2, 30000);
    clock += 29500;
    const ringing = last();
    stopped(2, 'timeout');
    fire(E.BID_RECEIVED, { position: 2, bid: '0' });
    fire(E.UPDATE_TURN, { currentTurn: 3 });
    running(3, 30000);
    expect(ringing.playing).toBe(false);
    expect(last().playing).toBe(true);
    // this page's clock thinks 5 s are left: no ringing, a stop
    clock += 25000;
    const early = last();
    stopped(3, 'timeout');
    expect(early.playing).toBe(false);
  });

  it('a spectator and a lazy watcher hear it too (the countdown is the bidder\'s only)', () => {
    turnOf(2);
    getGameState().isSpectator = true;
    running(2, 30000);
    expect(tunes).toHaveLength(1);
    stopped(2, 'bid');
    getGameState().isSpectator = false;
    getGameState().applyMyLazy(true);
    running(2, 20000);
    expect(tunes).toHaveLength(2);
    expect(last().playing).toBe(true);
  });

  it('a clearing event replayed from the gap buffer still stops it (before any live gate)', () => {
    turnOf(2);
    running(2, 30000);
    const h = last();
    const at = seq;
    seq = at + 1; // one lost
    fire(E.BID_RECEIVED, { position: 2, bid: '3' }); // buffered
    expect(h.playing).toBe(true);
    gate.onSnapshot({ seq: at + 1, gameId: G });
    expect(getGameState().bids[2]).toBe('3');
    expect(h.playing).toBe(false);
  });

  it('a snapshot is state: it starts the tune at its offset, keeps it within 750 ms, seeks beyond, and stops it when absent', () => {
    // contract/fixtures/v2 bid-clock-running: seat 1 watches seat 2's clock, 15 s left
    const fixture = JSON.parse(readFileSync(resolve(ROOT, 'contract/fixtures/v2/bid-clock-running.json'), 'utf8'));
    const snap = fixture.snapshot;
    expect(snap.bidClock).toEqual({ position: 2, inMs: 15000, durationMs: 30000 });
    applyTableSnapshot({ snapshot: snap }, { source: 'rejoin' });
    expect(getGameState().bidClock).toEqual({ position: 2, deadline: clock + 15000, durationMs: 30000 });
    expect(tunes).toHaveLength(1);
    expect(last().offset).toBeCloseTo(15.02, 5);
    // a resync 300 ms later that says 14.6 s left: within 750 ms, no restart
    clock += 300;
    applyTableSnapshot({ snapshot: { ...snap, bidClock: { ...snap.bidClock, inMs: 14600 } } }, { source: 'gap' });
    expect(tunes).toHaveLength(1);
    // one that says 10 s: it seeks
    applyTableSnapshot({ snapshot: { ...snap, bidClock: { ...snap.bidClock, inMs: 10000 } } }, { source: 'gap' });
    expect(tunes).toHaveLength(2);
    expect(tunes[0].playing).toBe(false);
    expect(last().offset).toBeCloseTo(20.02, 5);
    // the pre-wait or a stopped clock: the key is absent
    const { bidClock: _gone, ...without } = snap;
    applyTableSnapshot({ snapshot: without }, { source: 'gap' });
    expect(last().playing).toBe(false);
    expect(getGameState().bidClock).toBe(null);
  });

  it('a tune that fell behind (a suspended context) is sought on the next sync', () => {
    turnOf(2);
    running(2, 30000);
    const h = last();
    // the handle's own clock stood still for 2 s while this page's moved on
    Object.defineProperty(h, 'position', { get: () => 0.02 });
    clock += 2000;
    sounds.syncTune();
    expect(h.playing).toBe(false);
    expect(last().offset).toBeCloseTo(2.02, 5);
  });

  it('refused at first (muted, a hidden tab, files not decoded): sound coming back starts it at the current offset', () => {
    const listeners = { ready: new Set(), change: new Set() };
    const fakeManager = {
      onReady: (fn) => (listeners.ready.add(fn), () => listeners.ready.delete(fn)),
      onChange: (fn) => (listeners.change.add(fn), () => listeners.change.delete(fn)),
    };
    const doc = new EventTarget();
    doc.hidden = true;
    const uninstall = installTableSoundSync({ sound: fakeManager, doc, sounds: () => sounds });
    refuse = true;
    turnOf(2);
    running(2, 30000);
    expect(tunes).toEqual([]);
    refuse = false;
    clock += 4000;
    // unmute (onChange)
    listeners.change.forEach((fn) => fn({ muted: false, volume: 0.35 }));
    expect(tunes).toHaveLength(1);
    expect(last().offset).toBeCloseTo(4.02, 5);
    stopped(2, 'bid');
    // the files decoded / the context running (onReady)
    refuse = true;
    fire(E.UPDATE_TURN, { currentTurn: 3 });
    running(3, 30000);
    refuse = false;
    clock += 1000;
    listeners.ready.forEach((fn) => fn());
    expect(last().offset).toBeCloseTo(1.02, 5);
    stopped(3, 'bid');
    // the tab coming back (visibilitychange; a hidden one does nothing)
    refuse = true;
    fire(E.UPDATE_TURN, { currentTurn: 4 });
    running(4, 30000);
    refuse = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(tunes).toHaveLength(2);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(tunes).toHaveLength(3);
    uninstall();
    stopped(4, 'bid');
    refuse = true;
    running(4, 30000);
    refuse = false;
    listeners.change.forEach((fn) => fn({}));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(tunes).toHaveLength(3);
  });

  it('another game\'s clock, or a malformed one, is ignored', () => {
    turnOf(2);
    socket.fire(E.BID_CLOCK, { gameId: 'other', position: 2, running: true, inMs: 30000, durationMs: 30000 });
    socket.fire(E.BID_CLOCK, { gameId: G, position: 7, running: true, inMs: 30000, durationMs: 30000 });
    socket.fire(E.BID_CLOCK, { gameId: G, position: 2, running: true, inMs: -1, durationMs: 30000 });
    expect(tunes).toEqual([]);
    expect(getGameState().bidClock).toBe(null);
  });
});
