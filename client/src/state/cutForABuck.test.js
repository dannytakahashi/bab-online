/**
 * Cut for a buck's web state (state/cutForABuck.js): the reducer over every
 * event of the contract fixture (contract/fixtures/cut/events.json, a real
 * seeded cut: 13 redraws, a reshuffle, a two-way tie, the winner), the
 * restore from tournamentJoined.cut at every stage, and the words.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from '../testing/files.js';
import {
  STAGE, cutReduce, cutFromWire, statusLines, verdictLines, revealAnnouncement, seatView, waitingFor, roundLine, deckLine, deckLeft,
  rankWithArticle, rankPlural, joinNames, winnerLine, tournamentWinnerLine, cutWonLine, ringPlayers, isInCut, RULES_LINE, RESHUFFLE_LINE, WATCHING_LINE, BRAGGING_LINE,
} from './cutForABuck.js';

const FIXTURE = JSON.parse(readFileSync(resolve(REPO_ROOT, 'contract/fixtures/cut/events.json'), 'utf8'));
const TYPE = { cutForABuckStart: 'start', cutForABuckRound: 'round', cutForABuckDrew: 'drew', cutForABuckLeft: 'left', cutForABuckReveal: 'reveal', cutForABuckWinner: 'winner' };
const roomEvents = FIXTURE.events.filter((e) => TYPE[e.event]);

describe('the reducer over the fixture', () => {
  it('replays every event to one winner, with the deck and table right at every step', () => {
    let s = null;
    let now = 1000;
    let redraws = 0;
    let reshuffles = 0;
    let ties = 0;
    for (const e of roomEvents) {
      now += 500;
      const before = s;
      s = cutReduce(s, TYPE[e.event], e.data, now);
      expect(s).not.toBeNull();
      if (e.event === 'cutForABuckRound') {
        expect(s.stage).toBe(STAGE.DRAWING);
        expect(s.drawn).toEqual({});
        expect(s.deckCount).toBe(e.data.deckCount);
        expect(s.endsAt).toBe(now + e.data.closesInMs);
        // the deck only shrinks by the cards drawn, until a reshuffle
        if (before?.lastReveal && !e.data.reshuffled) expect(e.data.deckCount).toBe(before.deckCount);
        if (e.data.reshuffled) {
          reshuffles++;
          expect(s.table).toEqual({});
          expect(s.last).toEqual({ type: 'round', reshuffled: true, round: e.data.round });
        }
      }
      if (e.event === 'cutForABuckDrew') {
        expect(s.drawn[e.data.username]).toEqual({ slot: e.data.slot, auto: e.data.auto });
        // never a card before the reveal
        expect(JSON.stringify(s.drawn)).not.toMatch(/suit/);
      }
      if (e.event === 'cutForABuckReveal') {
        expect(s.drawn).toEqual({});
        expect(s.deckCount).toBe(before.deckCount - e.data.draws.length);
        for (const d of e.data.draws) expect(s.table[d.username].at(-1)).toEqual(d.card);
        if (e.data.redraw) redraws++;
        if (e.data.eliminated.length >= 2) ties++;
        for (const u of e.data.eliminated) expect(s.out[u]).toEqual({ round: e.data.round });
      }
    }
    expect(redraws).toBe(13);
    expect(reshuffles).toBe(1);
    expect(ties).toBe(1);
    expect(s.stage).toBe(STAGE.WINNER);
    expect(s.winner).toBe('T8_u2');
    expect(s.alive).toEqual(['T8_u2']);
    expect(s.rounds).toBe(15);
    expect(Object.keys(s.out).sort()).toEqual(['T8_u1', 'T8_u3', 'T8_u4']);
  });

  it('ignores a draw of another round', () => {
    let s = cutReduce(null, 'start', { candidates: ['a', 'b'], startsInMs: 15000, deckCount: 54 }, 0);
    s = cutReduce(s, 'round', { round: 2, participants: ['a', 'b'], alive: ['a', 'b'], deckCount: 50, reshuffled: false, closesInMs: 15000 }, 0);
    expect(cutReduce(s, 'drew', { round: 1, username: 'a', slot: 3, auto: false }, 0)).toBe(s);
  });

  it('a leave takes the player out (left) and frees their draw', () => {
    let s = cutReduce(null, 'start', { candidates: ['a', 'b', 'c'], startsInMs: 15000, deckCount: 54 }, 0);
    s = cutReduce(s, 'round', { round: 1, participants: ['a', 'b', 'c'], alive: ['a', 'b', 'c'], deckCount: 54, reshuffled: false, closesInMs: 15000 }, 0);
    s = cutReduce(s, 'drew', { round: 1, username: 'b', slot: 9, auto: false }, 0);
    s = cutReduce(s, 'left', { round: 1, username: 'b', alive: ['a', 'c'], freedSlot: 9 }, 0);
    expect(s.alive).toEqual(['a', 'c']);
    expect(s.out.b).toEqual({ round: 1, left: true });
    expect(s.drawn.b).toBeUndefined();
    expect(seatView(s, 'b', { me: 'a' }).caption).toBe('Left');
  });

  it('the round cap\'s winner without a reveal: everyone else is out', () => {
    let s = cutReduce(null, 'round', { round: 100, participants: ['a', 'b', 'c'], alive: ['a', 'b', 'c'], deckCount: 20, reshuffled: false, closesInMs: 15000 }, 0);
    s = cutReduce(s, 'winner', { winner: 'c', participants: ['a', 'b', 'c'], rounds: 100 }, 0);
    expect(s.stage).toBe(STAGE.WINNER);
    expect(s.out).toEqual({ a: { round: 100 }, b: { round: 100 } });
  });
});

describe('restore from tournamentJoined.cut at every stage', () => {
  const joined = FIXTURE.events.find((e) => e.event === 'tournamentJoined' && e.data.phase === 'cut').data;

  it('the fixture\'s mid-round state: drawn slots only, the timer from inMs', () => {
    const s = cutFromWire(joined.cut, 5000);
    expect(s.stage).toBe(joined.cut.stage);
    expect(s.endsAt).toBe(5000 + joined.cut.inMs);
    expect(s.participants).toEqual(joined.cut.participants);
    for (const d of joined.cut.drawn) expect(s.drawn[d.username]).toEqual({ slot: d.slot, auto: false });
    expect(s.last).toEqual({ type: 'restore' });
  });

  const wire = (over) => ({ stage: 'drawing', inMs: 9000, round: 3, participants: ['me', 'al', 'bo'], alive: ['me', 'al'], out: [{ username: 'bo', round: 2 }], table: [{ username: 'me', cards: [{ suit: 'hearts', rank: '9' }] }, { username: 'bo', cards: [{ suit: 'spades', rank: '3' }] }], drawn: [{ username: 'al', slot: 4 }], deckCount: 50, ...over });

  it('gather: the candidates and the countdown', () => {
    const s = cutFromWire({ stage: 'gather', inMs: 12000, round: 0, candidates: ['me', 'al'], alive: [], out: [], table: [], drawn: [], deckCount: 54 }, 0);
    expect(s.stage).toBe(STAGE.GATHER);
    expect(ringPlayers(s)).toEqual(['me', 'al']);
    expect(isInCut(s, 'me')).toBe(true);
    expect(statusLines(s, { me: 'me', now: 0 })).toEqual({ main: 'Cut for a buck starts in 12', sub: RULES_LINE });
  });

  it('drawing: who is still to draw', () => {
    const s = cutFromWire(wire(), 0);
    expect(waitingFor(s)).toEqual(['me']);
    expect(statusLines(s, { me: 'me', now: 2000 })).toEqual({ main: 'Click the deck to draw', sub: 'Auto-draw in 7' });
    expect(statusLines(s, { me: 'al', now: 0 }).main).toBe('Waiting for me');
    expect(statusLines(s, { me: 'bo', now: 0 }).main).toBe("You're out. Watching the rest");
    expect(statusLines(s, { me: 'zed', spectator: true, now: 0 })).toEqual({ main: WATCHING_LINE, sub: 'Waiting for me' });
    expect(roundLine(s)).toBe('Round 3 · 2 of 3 left');
    expect(deckLeft(s)).toBe(49);
    expect(deckLine(s)).toBe('49 cards left');
  });

  it('reveal: the last reveal\'s verdict', () => {
    const s = cutFromWire(wire({ stage: 'reveal', drawn: [], lastReveal: { round: 2, draws: [{ username: 'me', slot: 1, card: { suit: 'hearts', rank: '9' } }, { username: 'al', slot: 2, card: { suit: 'clubs', rank: 'K' } }, { username: 'bo', slot: 3, card: { suit: 'spades', rank: '3' } }], eliminated: ['bo'], redraw: false } }), 0);
    expect(s.stage).toBe(STAGE.REVEAL);
    expect(s.drawn).toEqual({});
    expect(statusLines(s, { me: 'me' })).toEqual({ main: "You're safe with a 9", sub: 'bo is out with a 3' });
  });

  it('winner: the winner and the bragging line', () => {
    const s = cutFromWire(wire({ stage: 'winner', alive: ['al'], winner: 'al', drawn: [] }), 0);
    expect(s.stage).toBe(STAGE.WINNER);
    expect(statusLines(s, { me: 'me' })).toEqual({ main: 'al wins Cut for a buck!', sub: BRAGGING_LINE });
    expect(statusLines(s, { me: 'al' }).main).toBe('You win Cut for a buck!');
    expect(seatView(s, 'al', { me: 'me' }).state).toBe('winner');
  });

  it('no cut: null', () => {
    expect(cutFromWire(undefined)).toBeNull();
    expect(cutFromWire(null)).toBeNull();
  });
});

describe('the words', () => {
  const draws = (pairs) => pairs.map(([username, rank, suit = 'clubs']) => ({ username, slot: 0, card: { suit, rank } }));

  it('verdicts: me first, the others by name, ties in the plural', () => {
    expect(verdictLines({ round: 2, draws: draws([['me', '3'], ['bo', '3', 'spades'], ['al', '9']]), eliminated: ['me', 'bo'], redraw: false }, 'me'))
      .toEqual(["You're out with a 3", 'bo is out with a 3']);
    expect(verdictLines({ round: 2, draws: draws([['me', 'A'], ['bo', '8'], ['al', '8']]), eliminated: ['bo', 'al'], redraw: false }, 'me'))
      .toEqual(["You're safe with an ace", 'bo and al are out with 8s']);
    expect(verdictLines({ round: 4, draws: draws([['me', '7'], ['bo', '7']]), eliminated: [], redraw: true }, 'me'))
      .toEqual(['Everyone tied on 7s. Redraw!']);
    expect(verdictLines({ round: 1, draws: draws([['al', 'LO', 'joker'], ['bo', 'HI', 'joker']]), eliminated: ['al'], redraw: false }, 'zed'))
      .toEqual(['al is out with a LO joker']);
  });

  it('one combined reveal announcement', () => {
    const r = { round: 2, draws: draws([['me', '9', 'hearts'], ['kim', '3', 'clubs']]), eliminated: ['kim'], redraw: false };
    expect(revealAnnouncement(r, 'me')).toBe("Round 2: you 9 of hearts, kim 3 of clubs. You're safe with a 9. kim is out with a 3.");
  });

  it('a seat\'s accessible label and caption', () => {
    const s = cutFromWire({ stage: 'drawing', inMs: 1000, round: 3, participants: ['me', 'kim', 'al'], alive: ['me', 'al'], out: [{ username: 'kim', round: 2 }], table: [{ username: 'kim', cards: [{ suit: 'clubs', rank: '3' }] }], drawn: [], deckCount: 40 }, 0);
    expect(seatView(s, 'kim', { me: 'me', talking: true })).toMatchObject({ state: 'out', caption: 'Out · round 2', label: 'kim, out in round 2, 3 of clubs, talking' });
    expect(seatView(s, 'me', { me: 'me' })).toMatchObject({ state: 'waiting', label: 'you, still to draw' });
    expect(seatView(s, 'al', { me: 'me', connected: false })).toMatchObject({ caption: 'reconnecting…', disconnected: true });
    const auto = cutReduce(s, 'drew', { round: 3, username: 'al', slot: 2, auto: true }, 0);
    expect(seatView(auto, 'al', { me: 'me' })).toMatchObject({ state: 'auto', caption: 'auto' });
  });

  it('articles, plurals and lists', () => {
    expect(['2', '8', '10', 'J', 'A', 'HI', 'LO'].map(rankWithArticle)).toEqual(['a 2', 'an 8', 'a 10', 'a jack', 'an ace', 'a HI joker', 'a LO joker']);
    expect(['3', 'Q', 'A', 'LO'].map(rankPlural)).toEqual(['3s', 'queens', 'aces', 'LO jokers']);
    expect(joinNames(['al'])).toBe('al');
    expect(joinNames(['al', 'bo', 'cy'])).toBe('al, bo and cy');
    expect(winnerLine('dan', 'me')).toBe('dan wins Cut for a buck!');
    expect(tournamentWinnerLine(['kim'], 'me')).toBe('kim wins the tournament!');
    expect(tournamentWinnerLine(['me', 'kim'], 'me')).toBe('You and kim share the win!');
    expect(tournamentWinnerLine(['kim', 'me'], 'me')).toBe('You and kim share the win!');
    // a username keeps its case (seen live: "Cd3 and cd4")
    expect(tournamentWinnerLine(['cd3', 'cd4'], 'me')).toBe('cd3 and cd4 share the win!');
    expect(tournamentWinnerLine(['me'], 'me')).toBe('You win the tournament!');
    expect(cutWonLine({ winner: 'dan' }, 'me')).toBe('dan won Cut for a buck');
    expect(cutWonLine({ winner: 'me' }, 'me')).toBe('You won Cut for a buck');
    expect(cutWonLine(null, 'me')).toBe('');
    expect(RESHUFFLE_LINE).toBe('Not enough cards left. Shuffling them back in.');
  });
});
