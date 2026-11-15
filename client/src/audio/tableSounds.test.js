/**
 * Event -> sound, through the real handlers (handlers/gameHandlers.js), the
 * seq gate and GameState, with a recording SoundManager: the card on every
 * cardPlayed, the over-trump accent, the turn cue on the edge into MY turn
 * only, trick-ours by seat parity, made / set from my team's bid, the game
 * end; spectators and lazy seats; nothing while the gate replays or flushes
 * buffered events, and a snapshot is the turn baseline.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SocketManager } from '../socket/SocketManager.js';
import { registerGameHandlers } from '../handlers/gameHandlers.js';
import { resetGameState, getGameState } from '../state/GameState.js';
import { resetSeqGate } from '../state/SeqGate.js';
import { resetMyAction } from '../state/MyAction.js';
import { resetTableDirector } from '../phaser/TableDirector.js';
import { resetTableSounds, OVER_TRUMP_DELAY_S, OVER_TRUMP_GAIN } from './tableSounds.js';
import { SERVER_EVENTS as E } from '../constants/events.js';
import { applyTableSnapshot } from '../state/tableSync.js';
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

const c = (rank, suit) => ({ rank, suit });
const fire = (event, data = {}) => socket.fire(event, { ...data, seq: ++seq });
const names = () => played.map((p) => p.name);

/** A 2-card deal at my seat (1), trump spades, the turn opening at `first`. */
function deal({ position = 1, gameId = 'g1' } = {}) {
  fire(E.GAME_START, {
    position, gameId, dealer: 4, currentHand: 2, trump: c('5', 'spades'),
    hand: [c('A', 'hearts'), c('3', 'spades')],
  });
}

beforeEach(() => {
  sessionStorage.clear();
  resetGameState();
  resetMyAction();
  resetTableDirector();
  seq = 0;
  played = [];
  gate = resetSeqGate({ requestSnapshot: vi.fn(), setTimer: () => 1, clearTimer: () => {} });
  sounds = resetTableSounds({
    sound: () => ({ play: (name, opts) => (played.push({ name, opts }), true) }),
  });
  socket = createMockSocket();
  const manager = new SocketManager(socket);
  manager.setGate(gate);
  registerGameHandlers(manager, {});
});

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

  it('the turn cue: only on the edge into MY turn, to bid and to play', () => {
    deal();
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    expect(names()).toEqual([]);
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(names()).toEqual(['turn']);
    // a repeated updateTurn (the /active resend) is not a new turn
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(names()).toEqual(['turn']);
    fire(E.BID_RECEIVED, { position: 1, bid: '1' });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    // I lead: doneBidding names me, then its updateTurn: one cue
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    expect(names()).toEqual(['turn', 'turn']);
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.UPDATE_TURN, { currentTurn: 2 });
    expect(names().filter((n) => n === 'turn')).toHaveLength(2);
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
    expect(names().filter((n) => n === 'turn')).toHaveLength(2);
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

  it('game end: the flourish', () => {
    deal();
    fire(E.GAME_END, { score: { team1: 300, team2: 100 }, tournamentId: null });
    expect(names()).toEqual(['gameend']);
  });
});

describe('who hears what', () => {
  it('a spectator: the table, no turn cue, no made / set, every trick the neutral one', () => {
    deal();
    const s = getGameState();
    s.isSpectator = true;
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.DONE_BIDDING, { bids: ['1', '0', '1', '0'], lead: 1 });
    fire(E.CARD_PLAYED, { position: 1, card: c('A', 'hearts') });
    fire(E.TRICK_COMPLETE, { winner: 1 });
    fire(E.HAND_COMPLETE, { team1Tricks: 1, team2Tricks: 0, score: { team1: 10, team2: 0 } });
    fire(E.GAME_END, { score: { team1: 10, team2: 0 } });
    expect(names()).toEqual(['card', 'trick', 'gameend']);
  });

  it('a lazy seat (the bot plays it): no turn cue; its team still hears trick-ours and made', () => {
    deal();
    getGameState().applyMyLazy(true);
    fire(E.UPDATE_TURN, { currentTurn: 1 });
    fire(E.TRICK_COMPLETE, { winner: 3 });
    fire(E.HAND_COMPLETE, { team1Tricks: 2, team2Tricks: 0, score: { team1: 0, team2: 0 } });
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
