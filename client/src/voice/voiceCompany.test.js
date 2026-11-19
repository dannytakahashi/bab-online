/**
 * No voice alone (owner 2026-11-19; voice/voiceCompany.js,
 * docs/claude/voice.md): who counts as another human (lobby members,
 * GameState.otherHumans at a table) and the gate that starts voice when
 * one is here and stops it VOICE_ALONE_GRACE_MS after the last one left.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceGate, lobbyOthers, VOICE_ALONE_GRACE_MS } from './voiceCompany.js';
import { GameState } from '../state/GameState.js';

describe('lobbyOthers', () => {
  it('counts the other human members: never a bot, never my own name', () => {
    const data = {
      members: [
        { socketId: 's1', username: 'me', ready: false, playing: true },
        { socketId: 'bot:1', username: '🤖 Mary', ready: true, playing: true, isBot: true },
        { socketId: 's2', username: 'ann', ready: false, playing: true },
      ],
      players: [{ socketId: 's1', username: 'me', ready: false }],
    };
    expect([...lobbyOthers(data, 'me')]).toEqual(['ann']);
  });

  it('a seat held for its grace and a play again place still count; a legacy payload reads players', () => {
    const data = {
      members: [
        { socketId: 's1', username: 'me', ready: false, playing: true },
        { socketId: 's2', username: 'ann', ready: false, playing: true, reconnecting: true },
        { socketId: 'away:bob', username: 'bob', ready: false, playing: true, reconnecting: true, returning: true },
      ],
    };
    expect([...lobbyOthers(data, 'me')].sort()).toEqual(['ann', 'bob']);
    expect([...lobbyOthers({ players: [{ username: 'me' }, { username: '🤖 Bot', isBot: true }] }, 'me')]).toEqual([]);
    expect([...lobbyOthers({ players: [{ username: 'me' }, { username: 'cat' }] }, 'me')]).toEqual(['cat']);
    expect(lobbyOthers(null, 'me').size).toBe(0);
  });
});

describe('createVoiceGate', () => {
  let company;
  let running;
  let calls;
  let gate;

  beforeEach(() => {
    vi.useFakeTimers();
    company = false;
    running = false;
    calls = [];
    gate = createVoiceGate({
      hasCompany: () => company,
      isRunning: () => running,
      start: () => { calls.push('start'); running = true; },
      suspend: () => { calls.push('suspend'); running = false; },
      stop: () => { calls.push('stop'); running = false; },
    });
  });

  afterEach(() => vi.useRealTimers());

  it('alone: wanting voice starts nothing, however long it waits', () => {
    gate.want();
    vi.advanceTimersByTime(10 * VOICE_ALONE_GRACE_MS);
    expect(calls).toEqual([]);
  });

  it('another human arriving starts it once; nothing is started while the screen does not want voice', () => {
    company = true;
    gate.update();
    expect(calls).toEqual([]);
    gate.want();
    gate.update();
    expect(calls).toEqual(['start']);
  });

  it('the last other human leaving stops it after the grace, not before', () => {
    company = true;
    gate.want();
    company = false;
    gate.update();
    expect(gate.graceRunning).toBe(true);
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS - 1);
    expect(calls).toEqual(['start']);
    // more updates during the grace do not restart its clock
    gate.update();
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['start', 'suspend']);
    expect(gate.wanted).toBe(true);
    // a new arrival starts it again
    company = true;
    gate.update();
    expect(calls).toEqual(['start', 'suspend', 'start']);
  });

  it('a return within the grace keeps voice running (no stop, no second start)', () => {
    company = true;
    gate.want();
    company = false;
    gate.update();
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS - 1000);
    company = true;
    gate.update();
    expect(gate.graceRunning).toBe(false);
    vi.advanceTimersByTime(5 * VOICE_ALONE_GRACE_MS);
    expect(calls).toEqual(['start']);
  });

  it('release stops at once and ends the grace; a late timer does nothing', () => {
    company = true;
    gate.want();
    company = false;
    gate.update();
    gate.release();
    expect(calls).toEqual(['start', 'stop']);
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS);
    expect(calls).toEqual(['start', 'stop']);
    company = true;
    gate.update();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('the grace running out with company back (not yet updated) keeps voice', () => {
    company = true;
    gate.want();
    company = false;
    gate.update();
    company = true;
    vi.advanceTimersByTime(VOICE_ALONE_GRACE_MS);
    expect(calls).toEqual(['start']);
  });

  it('the grace is about 30 s', () => {
    expect(VOICE_ALONE_GRACE_MS).toBe(30000);
  });
});

describe('GameState.otherHumans (who counts at a table)', () => {
  const seat = (position, o) => ({ position, username: o.username ?? o.ownerUsername ?? '🤖 Bot', ownerUsername: null, controller: 'human', presence: 'connected', isBot: false, lazy: false, offered: false, ...o });
  const bot = (position) => seat(position, { username: `🤖 Bot${position}`, controller: 'bot', presence: 'none', isBot: true });
  const snap = (seats, extra = {}) => ({ gameId: 'g1', stage: 'BIDDING', viewer: { role: 'seat', position: 1 }, seats, ...extra });
  const others = (s) => [...s.otherHumans().names].sort();

  it('positionUpdate: the seats isBot[] marks are no one; my own seat is not company', () => {
    const s = new GameState();
    s.username = 'me';
    expect(s.otherHumans()).toEqual({ known: false, names: new Set() });
    s.applyPositionUpdate({ positions: [1, 2, 3, 4], usernames: [{ username: 'me' }, { username: '🤖 Mary' }, { username: 'ann' }, { username: '🤖 Pat' }], isBot: [false, true, false, true], pics: [1, 1, 1, 1] });
    expect(s.otherHumans().known).toBe(true);
    expect(others(s)).toEqual(['ann']);
    // a solo game with bots
    s.applyPositionUpdate({ positions: [1, 2, 3, 4], usernames: [{ username: 'me' }, { username: '🤖 Mary' }, { username: '🤖 Ann' }, { username: '🤖 Pat' }], isBot: [false, true, true, true], pics: [1, 1, 1, 1] });
    expect(others(s)).toEqual([]);
  });

  it('a positionUpdate without isBot (an older server) reads the bot: prefix of the seat sockets', () => {
    const s = new GameState();
    s.username = 'me';
    s.applyPositionUpdate({ positions: [1, 2, 3, 4], usernames: ['me', 'a', 'b', 'c'].map((username) => ({ username })), sockets: ['s1', 'bot:2', 'bot:3', 's4'], pics: [1, 1, 1, 1] });
    expect(others(s)).toEqual(['c']);
  });

  it('a snapshot: lazy, resigned, disconnected and away owners count; native bots and gone owners do not', () => {
    const s = new GameState();
    s.username = 'me';
    s.applySnapshot(snap([
      seat(1, { ownerUsername: 'me' }),
      seat(2, { username: '🤖 Lazy', ownerUsername: 'ann', controller: 'lazyBot', presence: 'connected', isBot: true, lazy: true }),
      seat(3, { username: '🤖 Res', ownerUsername: 'bob', controller: 'resignBot', presence: 'away', isBot: true }),
      seat(4, { ownerUsername: 'cat', presence: 'grace' }),
    ]));
    expect(others(s)).toEqual(['ann', 'bob', 'cat']);
    s.applySnapshot(snap([
      seat(1, { ownerUsername: 'me' }),
      seat(2, { username: '🤖 Left', ownerUsername: 'ann', controller: 'lazyBot', presence: 'gone', isBot: true }),
      bot(3),
      bot(4),
    ]));
    expect(others(s)).toEqual([]);
  });

  it('before seating a snapshot\'s entrants: humans not left', () => {
    const s = new GameState();
    s.username = 'me';
    s.applySnapshot({ gameId: 'g1', stage: 'DRAWING', viewer: { role: 'entrant', position: null }, seats: [], entrants: [
      { username: 'me', isBot: false, presence: 'connected', hasDrawn: false },
      { username: 'ann', isBot: false, presence: 'disconnected', hasDrawn: false },
      { username: 'bob', isBot: false, presence: 'left', hasDrawn: true },
      { username: '🤖 Mary', isBot: true, presence: 'connected', hasDrawn: true },
    ] });
    expect(s.otherHumans().known).toBe(true);
    expect(others(s)).toEqual(['ann']);
  });

  it('spectators count, my own name does not (a spectator watching my solo game is company)', () => {
    const s = new GameState();
    s.username = 'me';
    s.applySnapshot(snap([seat(1, { ownerUsername: 'me' }), bot(2), bot(3), bot(4)]));
    expect(others(s)).toEqual([]);
    s.applySpectators({ gameId: 'g1', spectators: [{ username: 'ann', pic: 2 }], count: 1 });
    expect(others(s)).toEqual(['ann']);
    // a spectator's own view: the seat owners and the other watchers
    const v = new GameState();
    v.username = 'ann';
    v.applySnapshot({ ...snap([seat(1, { ownerUsername: 'me' }), bot(2), bot(3), bot(4)]), viewer: { role: 'spectator', position: null }, watching: { spectators: [{ username: 'ann', pic: 2 }], count: 1 } });
    expect([...v.otherHumans().names]).toEqual(['me']);
  });

  it('seatLeft: that owner no longer counts; another game\'s, another name\'s or a bot seat\'s is ignored', () => {
    const s = new GameState();
    s.username = 'me';
    s.applySnapshot(snap([
      seat(1, { ownerUsername: 'me' }),
      seat(2, { username: '🤖 Lazy', ownerUsername: 'ann', controller: 'lazyBot', presence: 'connected', isBot: true, lazy: true }),
      bot(3),
      bot(4),
    ]));
    expect(s.applySeatLeft({ gameId: 'g9', position: 2, username: 'ann' })).toBe(false);
    expect(s.applySeatLeft({ gameId: 'g1', position: 2, username: 'zed' })).toBe(false);
    expect(s.applySeatLeft({ gameId: 'g1', position: 3, username: '🤖 Bot3' })).toBe(false);
    expect(others(s)).toEqual(['ann']);
    expect(s.applySeatLeft({ gameId: 'g1', position: 2, username: 'ann' })).toBe(true);
    expect(others(s)).toEqual([]);
    expect(s.seats.find((x) => x.position === 2).presence).toBe('gone');
  });

  it('company observers hear every change and survive reset()', () => {
    const s = new GameState();
    const fn = vi.fn();
    s.onCompanyChange(fn);
    s.applySpectators({ gameId: null, spectators: [{ username: 'ann', pic: 2 }], count: 1 });
    s.applyPositionUpdate({ positions: [1], usernames: [{ username: 'a' }], isBot: [false], pics: [1] });
    s.applySnapshot(snap([bot(1), bot(2), bot(3), bot(4)]));
    s.reset();
    expect(fn).toHaveBeenCalledTimes(4);
    expect(s.otherHumans()).toEqual({ known: false, names: new Set() });
    s.applySpectators({ gameId: null, spectators: [], count: 0 });
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
