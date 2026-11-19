import { describe, it, expect, beforeEach } from 'vitest';
import {
  ASSIST_CAP, CONFIDENCE_LABEL, resetAssistUses, forgetAssistUses, noteAssistUses, assistUses, helpDescription,
  parseTurnKey, isAssistHint, hintIsLive, suggestedBid, suggestedCard, confidenceLabel, assistFooter, assistLogLine,
  assistAnnouncement, clientCardIndex, assistHintRoute,
} from './assistHint.js';

const NAME_LINT = /\bteam ?[12]\b|\bT[12]\b|your team|other team|opponents?/i;

/** A card hint as the server sends it (assistHandlers.hintPayload). */
const cardHint = (over = {}) => ({
  v: 1, source: 'help', kind: 'card', turnKey: '3|PLAYING|1|4|5', headline: 'Play 9♦',
  reasons: ['You and Bob bid 4 and have 1 so far.', 'The 9♦ is the lowest diamond that still follows.'],
  uses: 1, freeUses: 3, assisted: false, counted: true,
  details: ['Carol and Dan need 2 more.'], confidence: 'clear', suggest: { card: { suit: 'diamonds', rank: '9' } }, codes: ['F.low'],
  ...over,
});
const bidHint = (over = {}) => ({
  v: 1, source: 'help', kind: 'bid', turnKey: '3|BIDDING|1|2|0', headline: 'Bid 4',
  reasons: ['Your hand is worth about 4 tricks.'], uses: 2, freeUses: 3, assisted: false, counted: true,
  details: [], confidence: 'close', suggest: { bid: '4' }, codes: ['C.bid'],
  ...over,
});
const statusHint = (over = {}) => ({
  v: 1, source: 'help', kind: 'status', turnKey: '3|BIDDING|2|1|0', headline: 'Not your turn yet: Carol is bidding.',
  reasons: [], uses: 0, freeUses: 3, assisted: false, counted: false, ...over,
});

/** GameState-shaped: my seat 1. */
const seat = (over = {}) => ({
  position: 1, isSpectator: false, isLazy: false, currentTurn: 1, isBidding: false, hasPlayedCard: false,
  bids: { 1: '2', 2: '1', 3: '3', 4: '0' }, ...over,
});

beforeEach(() => forgetAssistUses());

describe('the cap and the words', () => {
  it('asks for assistHint with the cap assist', () => {
    expect(ASSIST_CAP).toBe('assist');
  });

  it('the confidence chip uses the server\'s labels', () => {
    expect(CONFIDENCE_LABEL).toEqual({
      only: 'Only legal card', certain: 'Sure thing', clear: 'Clear choice', close: 'Close call', any: 'Any card works', quick: 'Quick suggestion',
    });
    expect(confidenceLabel(cardHint())).toBe('Clear choice');
    expect(confidenceLabel(cardHint({ confidence: undefined }))).toBeNull();
  });
});

describe('/help in the autocomplete: this game\'s uses', () => {
  it('counts up to the free uses, then warns, then says the game is assisted', () => {
    resetAssistUses();
    expect(helpDescription()).toBe('Suggest a move (0 of 3 free used)');
    noteAssistUses(cardHint({ uses: 1 }));
    expect(helpDescription()).toBe('Suggest a move (1 of 3 free used)');
    noteAssistUses(cardHint({ uses: 2 }));
    expect(helpDescription()).toBe('Suggest a move (2 of 3 free used)');
    noteAssistUses(cardHint({ uses: 3 }));
    expect(helpDescription()).toBe('Suggest a move (the next one makes this game bot-assisted)');
    noteAssistUses(cardHint({ uses: 4, assisted: true }));
    expect(helpDescription()).toBe('Suggest a move (this game is bot-assisted for you)');
  });

  it('a status reply carries the counts too (off-turn asks are not counted)', () => {
    resetAssistUses();
    noteAssistUses(statusHint({ uses: 2 }));
    expect(helpDescription()).toBe('Suggest a move (2 of 3 free used)');
  });

  it('unknown after a reload or a rejoin (no createUI seen, no hint yet)', () => {
    expect(assistUses()).toBeNull();
    expect(helpDescription()).toBe('Suggest a move (after 3 free, this game counts as bot-assisted)');
  });

  it('a new game starts at 0; counts of another game are not this one\'s', () => {
    noteAssistUses(cardHint({ uses: 3 }), 'game-a');
    expect(assistUses('game-a')).toEqual({ uses: 3, freeUses: 3, assisted: false });
    expect(assistUses('game-b')).toBeNull();
    expect(helpDescription('game-b')).toBe('Suggest a move (after 3 free, this game counts as bot-assisted)');
    resetAssistUses();
    expect(helpDescription('game-b')).toBe('Suggest a move (0 of 3 free used)');
  });

  it('the server\'s freeUses wins over the default', () => {
    resetAssistUses();
    noteAssistUses(cardHint({ uses: 1, freeUses: 2 }));
    expect(helpDescription()).toBe('Suggest a move (1 of 2 free used)');
  });

  it('names no team, no "opponents"', () => {
    for (const u of [null, 0, 1, 3, 4]) {
      if (u === null) forgetAssistUses();
      else noteAssistUses(cardHint({ uses: u, assisted: u > 3 }));
      expect(helpDescription()).not.toMatch(NAME_LINT);
    }
  });
});

describe('a hint is my turn\'s', () => {
  it('parses the server\'s turnKey', () => {
    expect(parseTurnKey('3|PLAYING|1|4|5')).toEqual({ dealSeq: '3', stage: 'PLAYING', currentTurn: 1, bidCount: 4, cardIndex: 5 });
    expect(parseTurnKey('nope')).toBeNull();
    expect(parseTurnKey(null)).toBeNull();
  });

  it('knows a hint it can show', () => {
    expect(isAssistHint(cardHint())).toBe(true);
    expect(isAssistHint(statusHint())).toBe(true);
    expect(isAssistHint(cardHint({ v: 2 }))).toBe(false);
    expect(isAssistHint(cardHint({ kind: 'tip' }))).toBe(false);
    expect(isAssistHint(cardHint({ headline: '' }))).toBe(false);
    expect(isAssistHint(null)).toBe(false);
  });

  it('a card hint: live on my play turn, gone once I played or the turn moved', () => {
    expect(hintIsLive(cardHint(), seat())).toBe(true);
    expect(hintIsLive(cardHint(), seat({ currentTurn: 2 }))).toBe(false);
    expect(hintIsLive(cardHint(), seat({ hasPlayedCard: true }))).toBe(false);
    expect(hintIsLive(cardHint(), seat(), { pending: true })).toBe(false);
    expect(hintIsLive(cardHint(), seat({ isBidding: true }))).toBe(false);
    // the turnKey names another seat or stage: stale
    expect(hintIsLive(cardHint({ turnKey: '3|PLAYING|2|4|5' }), seat())).toBe(false);
    expect(hintIsLive(cardHint({ turnKey: '3|BIDDING|1|4|5' }), seat())).toBe(false);
  });

  it('a bid hint: live on my bid turn with the bids it was answered for', () => {
    const bidding = seat({ isBidding: true, bids: { 3: '2', 4: '1' } });
    expect(hintIsLive(bidHint(), bidding)).toBe(true);
    // one more bid since: another turn
    expect(hintIsLive(bidHint(), { ...bidding, bids: { 2: '0', 3: '2', 4: '1' } })).toBe(false);
    // my own bid is in
    expect(hintIsLive(bidHint({ turnKey: '3|BIDDING|1|3|0' }), { ...bidding, bids: { 1: '4', 3: '2', 4: '1' } })).toBe(false);
    expect(hintIsLive(bidHint(), { ...bidding, isBidding: false })).toBe(false);
  });

  it('never for a spectator or a seat a bot plays; a status reply always shows', () => {
    expect(hintIsLive(cardHint(), seat({ isSpectator: true }))).toBe(false);
    expect(hintIsLive(cardHint(), seat({ isLazy: true }))).toBe(false);
    expect(hintIsLive(statusHint(), seat({ isLazy: true, isSpectator: true }))).toBe(true);
    expect(hintIsLive(statusHint(), seat({ isSpectator: true, position: 1 }))).toBe(true);
  });

  it('a card hint for an earlier trick of mine (the scene lagging behind the state) is stale: cardIndex from the trick number and the cards in it', () => {
    // turnKey cardIndex 5: trick 2, one card down
    const trick2 = seat({ trickNo: 2, playedCards: [{ position: 4, card: { suit: 'clubs', rank: '2' } }] });
    expect(clientCardIndex(trick2)).toBe(5);
    expect(hintIsLive(cardHint(), trick2)).toBe(true);
    // my turn again on trick 3 (one card down): 9, not 5
    const trick3 = { ...trick2, trickNo: 3 };
    expect(clientCardIndex(trick3)).toBe(9);
    expect(hintIsLive(cardHint(), trick3)).toBe(false);
    // the trick is full and not yet cleared (I won it, I lead next): still 4 * t
    expect(clientCardIndex(seat({ trickNo: 1, playedCards: [1, 2, 3, 4] }))).toBe(4);
    expect(clientCardIndex(seat({ trickNo: 2, playedCards: [] }))).toBe(4);
    // no trick number yet: not compared
    expect(clientCardIndex(seat({ trickNo: 0 }))).toBeNull();
    expect(hintIsLive(cardHint(), seat({ trickNo: 0 }))).toBe(true);
  });

  it('where a hint goes: the scene at the table; on the game-end screen a status reply is a row; else nowhere', () => {
    expect(assistHintRoute({ isAtTable: true, hasTable: true }, cardHint())).toBe('scene');
    expect(assistHintRoute({ isAtTable: false, hasTable: true }, statusHint({ headline: 'Nothing to suggest right now.' }))).toBe('row');
    expect(assistHintRoute({ isAtTable: false, hasTable: true }, cardHint())).toBeNull();
    expect(assistHintRoute({ isAtTable: false, hasTable: false }, statusHint())).toBeNull();
    expect(assistHintRoute({ isAtTable: true, hasTable: true }, { v: 2 })).toBeNull();
  });

  it('a hint without a turnKey it can read still needs my turn', () => {
    expect(hintIsLive(cardHint({ turnKey: 'x' }), seat())).toBe(true);
    expect(hintIsLive(cardHint({ turnKey: 'x' }), seat({ currentTurn: 3 }))).toBe(false);
  });
});

describe('what the card shows', () => {
  it('the suggestion', () => {
    expect(suggestedCard(cardHint())).toEqual({ suit: 'diamonds', rank: '9' });
    expect(suggestedBid(cardHint())).toBeNull();
    expect(suggestedBid(bidHint({ suggest: { bid: 'b' } }))).toBe('B');
    expect(suggestedCard(bidHint())).toBeNull();
    expect(suggestedCard(statusHint())).toBeNull();
  });

  it('the footer: our strongest bot and the use count', () => {
    expect(assistFooter(cardHint({ uses: 2 }))).toBe('What our strongest bot would play · Help 2 of 3 free');
    expect(assistFooter(cardHint({ uses: 4, assisted: true }))).toBe('What our strongest bot would play · Help 4: this game counts as bot-assisted for you');
    expect(assistFooter(cardHint({ counted: false }))).toBe('What our strongest bot would play · Asked again this turn: not counted');
    expect(assistFooter(cardHint({ confidence: 'only', counted: false }))).toBe('Not counted');
    expect(assistFooter(cardHint({ confidence: 'quick' }))).toBe('Quick suggestion: rules only, the server is busy. · Help 1 of 3 free');
    expect(assistFooter(statusHint())).toBeNull();
  });

  it('the dim local log row and the announcement', () => {
    expect(assistLogLine(cardHint())).toBe('Help: Play 9♦ (only you see this)');
    expect(assistLogLine(statusHint())).toBe('Help: Not your turn yet: Carol is bidding. (only you see this)');
    expect(assistLogLine({})).toBeNull();
    expect(assistAnnouncement(cardHint())).toBe('Suggestion: Play 9♦. The 9♦ is the lowest diamond that still follows.');
    expect(assistAnnouncement(bidHint({ note: 'This game now counts as bot-assisted for you.' })))
      .toBe('Suggestion: Bid 4. Your hand is worth about 4 tricks. This game now counts as bot-assisted for you.');
    expect(assistAnnouncement(statusHint())).toBe('Not your turn yet: Carol is bidding.');
  });

  it('names no team in any text it makes', () => {
    for (const h of [cardHint(), bidHint(), statusHint(), cardHint({ uses: 4 }), cardHint({ counted: false })]) {
      for (const t of [assistFooter(h), assistLogLine(h), assistAnnouncement(h)]) {
        if (t) expect(t).not.toMatch(NAME_LINT);
      }
    }
  });
});
