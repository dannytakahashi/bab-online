import { describe, it, expect, beforeEach } from 'vitest';
import {
  ASSIST_CAP, CONFIDENCE_LABEL, resetAssistUses, forgetAssistUses, noteAssistUses, assistUses, helpDescription,
  parseTurnKey, isAssistHint, hintIsLive, suggestedBid, suggestedCard, confidenceLabel, assistFooter, assistLogLine,
  assistAnnouncement, clientCardIndex, assistHintRoute, helpIsUnlimited, HELP_LABEL, FOOTER_BOT,
} from './assistHint.js';

/** What a game with a native bot seat must never show (owner 2026-11-19: "say nothing"). */
const LIMIT_WORDS = /free|unlimited|bot-assisted|counted|\d/i;

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
    expect(helpDescription()).toBe('Ask a bot for advice (0 of 3 free used)');
    noteAssistUses(cardHint({ uses: 1 }));
    expect(helpDescription()).toBe('Ask a bot for advice (1 of 3 free used)');
    noteAssistUses(cardHint({ uses: 2 }));
    expect(helpDescription()).toBe('Ask a bot for advice (2 of 3 free used)');
    noteAssistUses(cardHint({ uses: 3 }));
    expect(helpDescription()).toBe('Ask a bot for advice (the next one makes this game bot-assisted)');
    noteAssistUses(cardHint({ uses: 4, assisted: true }));
    expect(helpDescription()).toBe('Ask a bot for advice (this game is bot-assisted for you)');
  });

  it('a status reply carries the counts too (off-turn asks are not counted)', () => {
    resetAssistUses();
    noteAssistUses(statusHint({ uses: 2 }));
    expect(helpDescription()).toBe('Ask a bot for advice (2 of 3 free used)');
  });

  it('unknown after a reload or a rejoin (no createUI seen, no hint yet)', () => {
    expect(assistUses()).toBeNull();
    expect(helpDescription()).toBe('Ask a bot for advice (after 3 free, this game counts as bot-assisted)');
  });

  it('a new game starts at 0; counts of another game are not this one\'s', () => {
    noteAssistUses(cardHint({ uses: 3 }), 'game-a');
    expect(assistUses('game-a')).toEqual({ uses: 3, freeUses: 3, assisted: false, unlimited: false });
    expect(assistUses('game-b')).toBeNull();
    expect(helpDescription('game-b')).toBe('Ask a bot for advice (after 3 free, this game counts as bot-assisted)');
    resetAssistUses();
    expect(helpDescription('game-b')).toBe('Ask a bot for advice (0 of 3 free used)');
  });

  it('the server\'s freeUses wins over the default', () => {
    resetAssistUses();
    noteAssistUses(cardHint({ uses: 1, freeUses: 2 }));
    expect(helpDescription()).toBe('Ask a bot for advice (1 of 2 free used)');
  });

  it('names no team, no "opponents"', () => {
    for (const u of [null, 0, 1, 3, 4]) {
      if (u === null) forgetAssistUses();
      else noteAssistUses(cardHint({ uses: u, assisted: u > 3 }));
      expect(helpDescription()).not.toMatch(NAME_LINT);
    }
  });
});

describe('a game with a native bot seat: no limit, and nothing said about one', () => {
  it('the ask is called "Ask a bot for advice"', () => {
    expect(HELP_LABEL).toBe('Ask a bot for advice');
  });

  it('from the hint: the chat line is just the label, whatever the count', () => {
    resetAssistUses('g');
    for (const n of [1, 3, 4, 9]) {
      noteAssistUses(cardHint({ uses: n, unlimited: true }), 'g');
      expect(helpDescription('g')).toBe('Ask a bot for advice');
      expect(assistUses('g').unlimited).toBe(true);
    }
    // a hint without the flag in the same game (a status reply) keeps it
    noteAssistUses(statusHint({ uses: 9 }), 'g');
    expect(helpDescription('g')).toBe('Ask a bot for advice');
    // another game does not inherit it
    noteAssistUses(cardHint({ uses: 1 }), 'h');
    expect(helpDescription('h')).toBe('Ask a bot for advice (1 of 3 free used)');
    resetAssistUses('g');
    expect(helpDescription('g')).toBe('Ask a bot for advice (0 of 3 free used)');
  });

  it('from a snapshot\'s viewer.assist (after a reload)', () => {
    noteAssistUses({ uses: 5, freeUses: 3, assisted: false, unlimited: true }, 'g');
    expect(helpDescription('g')).toBe('Ask a bot for advice');
    expect(helpIsUnlimited({ gameId: 'g' })).toBe(true);
    expect(helpIsUnlimited({ gameId: 'other' })).toBe(false);
  });

  it('from the table before any hint or snapshot: a native bot seat, never a lazy one', () => {
    expect(assistUses()).toBeNull();
    const botTable = { gameId: 'g', nativeBotSeat: true };
    expect(helpIsUnlimited(botTable)).toBe(true);
    expect(helpDescription('g', { unlimited: helpIsUnlimited(botTable) })).toBe('Ask a bot for advice');
    // a lazy seat is the GameState's isLazy, not nativeBotSeat: the limit stays
    const lazyTable = { gameId: 'g', nativeBotSeat: false, isLazy: true };
    expect(helpIsUnlimited(lazyTable)).toBe(false);
    expect(helpDescription('g', { unlimited: helpIsUnlimited(lazyTable) }))
      .toBe('Ask a bot for advice (after 3 free, this game counts as bot-assisted)');
    expect(helpIsUnlimited(null, cardHint({ unlimited: true }))).toBe(true);
    expect(helpIsUnlimited(null, cardHint())).toBe(false);
  });

  it('once the server has said, its word wins over the table (as on iOS)', () => {
    const botTable = { gameId: 'g', nativeBotSeat: true };
    // createUI's zero count: the table decides
    resetAssistUses('g');
    expect(helpIsUnlimited(botTable)).toBe(true);
    // a hint without unlimited (the server's verdict: the limit) wins over the table
    noteAssistUses(cardHint({ uses: 3 }), 'g');
    expect(helpIsUnlimited(botTable)).toBe(false);
    expect(helpDescription('g', { unlimited: helpIsUnlimited(botTable) }))
      .toBe('Ask a bot for advice (the next one makes this game bot-assisted)');
    // and for that hint's own footer
    expect(helpIsUnlimited(botTable, cardHint({ uses: 3 }))).toBe(false);
    expect(assistFooter(cardHint({ uses: 3 }), { unlimited: helpIsUnlimited(botTable, cardHint({ uses: 3 })) }))
      .toBe('What our strongest bot would play · Help 3 of 3 free');
    // a hint with it: no limit, whatever the table
    expect(helpIsUnlimited({ gameId: 'g', nativeBotSeat: false }, cardHint({ unlimited: true }))).toBe(true);
  });

  it('the footer is just our strongest bot: a count, a re-ask and a forced move alike', () => {
    for (const h of [
      cardHint({ uses: 2, unlimited: true }), cardHint({ uses: 7, unlimited: true }),
      cardHint({ counted: false, unlimited: true }), cardHint({ confidence: 'only', counted: false, unlimited: true }),
      bidHint({ uses: 4, unlimited: true }),
    ]) {
      expect(assistFooter(h)).toBe(FOOTER_BOT);
      expect(assistFooter(h)).toBe('What our strongest bot would play');
    }
    // the table says so before the hint does
    expect(assistFooter(cardHint({ uses: 4 }), { unlimited: true })).toBe('What our strongest bot would play');
    expect(assistFooter(cardHint({ confidence: 'only' }), { unlimited: true })).toBe('What our strongest bot would play');
    // the Quick note names no count either
    expect(assistFooter(cardHint({ confidence: 'quick', unlimited: true }))).toBe('Quick suggestion: rules only, the server is busy.');
  });

  it('no count, "free" or "bot-assisted" in any text it makes there', () => {
    noteAssistUses(cardHint({ uses: 6, unlimited: true }), 'g');
    expect(helpDescription('g')).not.toMatch(LIMIT_WORDS);
    for (const h of [cardHint({ uses: 4, unlimited: true }), bidHint({ uses: 9, unlimited: true }), cardHint({ confidence: 'only', unlimited: true })]) {
      expect(assistFooter(h)).not.toMatch(LIMIT_WORDS);
      expect(assistAnnouncement(h)).not.toMatch(/free|unlimited|bot-assisted/i);
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

describe('the tutorial (source tutorial, 2026-11-19)', () => {
  const tipHint = (over = {}) => ({
    v: 1, source: 'tutorial', kind: 'tip', turnKey: '3|BIDDING|1|2|0', headline: 'Bidding',
    reasons: ['Bid how many tricks you expect to win.'], uses: 0, freeUses: 3, assisted: false, counted: false, tipId: 'T.bid', ...over,
  });

  it('its advice: the footer is just our strongest bot (never counted), the Quick note alone when quick; no "Help:" row', () => {
    expect(assistFooter(cardHint({ source: 'tutorial', counted: false }))).toBe(FOOTER_BOT);
    expect(assistFooter(bidHint({ source: 'tutorial', counted: false, uses: 2 }))).toBe(FOOTER_BOT);
    expect(assistFooter(cardHint({ source: 'tutorial', counted: false, confidence: 'quick' }))).toBe('Quick suggestion: rules only, the server is busy.');
    expect(assistLogLine(cardHint({ source: 'tutorial', counted: false }))).toBeNull();
    // its status replies keep their row (the game-end screen)
    expect(assistLogLine(statusHint({ source: 'tutorial', headline: 'Tips off. /help still works any time.' }))).toBe('Help: Tips off. /help still works any time. (only you see this)');
  });

  it('/help while the tutorial is on is never counted: no count in its footer or chat line', () => {
    expect(assistFooter(cardHint({ counted: false, uses: 1 }), { tutorial: true })).toBe(FOOTER_BOT);
    // a counted one (the server's word) keeps it
    expect(assistFooter(cardHint({ counted: true, uses: 1 }), { tutorial: true })).toBe(`${FOOTER_BOT} · Help 1 of 3 free`);
    resetAssistUses('g');
    noteAssistUses({ uses: 1, freeUses: 3, assisted: false }, 'g');
    expect(helpDescription('g', { tutorial: true })).toBe(HELP_LABEL);
    noteAssistUses({ uses: 0, freeUses: 3, assisted: true }, 'g');
    expect(helpDescription('g', { tutorial: true })).toBe(`${HELP_LABEL} (this game is bot-assisted for you)`);
    // a game with a native bot seat: nothing about it
    noteAssistUses({ uses: 0, freeUses: 3, assisted: false, unlimited: true }, 'g');
    expect(helpDescription('g', { tutorial: true })).toBe(HELP_LABEL);
    forgetAssistUses();
    expect(helpDescription(null, { tutorial: true })).toBe(HELP_LABEL);
  });

  it('a tip is not a /help card (its own section); it goes to the scene at the table, else its "Tip:" row', () => {
    expect(isAssistHint(tipHint())).toBe(false);
    expect(assistHintRoute({ isAtTable: true, hasTable: true }, tipHint())).toBe('scene');
    expect(assistHintRoute({ isAtTable: false, hasTable: true }, tipHint())).toBe('row');
    expect(assistHintRoute({ isAtTable: false, hasTable: false }, tipHint())).toBeNull();
    expect(assistLogLine(tipHint())).toBe('Tip: Bid how many tricks you expect to win.');
    // a tutorial bid or card answer goes to the scene like /help's; off the table nowhere
    expect(assistHintRoute({ isAtTable: true, hasTable: true }, cardHint({ source: 'tutorial' }))).toBe('scene');
    expect(assistHintRoute({ isAtTable: false, hasTable: true }, cardHint({ source: 'tutorial' }))).toBeNull();
  });

  it('its advice is live exactly as /help\'s is', () => {
    const s = seat({ isBidding: true, bids: { 4: '1' }, currentTurn: 1 });
    expect(hintIsLive(bidHint({ source: 'tutorial', turnKey: '3|BIDDING|1|1|0' }), s)).toBe(true);
    expect(hintIsLive(bidHint({ source: 'tutorial', turnKey: '3|BIDDING|1|1|0' }), { ...s, currentTurn: 2 })).toBe(false);
  });
});
