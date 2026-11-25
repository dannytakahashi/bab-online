/**
 * Cut for a buck (2026-11-25): the pure engine of a tournament's finale.
 * No io, no timers, no Mongo (the orchestration is
 * server/socket/cutForABuck.js).
 *
 * Every participant draws one card a round; the lowest rank is out (suits
 * never count; RANK_VALUES: 2..A, then LO, then HI), every player tied on
 * it with it. When every player still in ties, nobody is out: a redraw.
 * Round after round until one player is left.
 *
 * The deck: max(1, ceil(n / 54)) full decks, shuffled with Deck's shuffle
 * (crypto, or the seeded Math.random of a test run). A round opens with the
 * remaining deck laid out as `deck.length` slots (slot i = deck[i]); each
 * player picks a slot (a taken one goes to the nearest free one, i + d
 * before i - d; none, or one out of range, a random free one). Drawn cards
 * stay in the deck until the round resolves, then leave it for good, a
 * redraw's included, and go on the table (the cards revealed since the last
 * reshuffle, eliminated players' too). A round opens with a reshuffle of
 * the full deck(s) (the table cleared) only when fewer cards are left than
 * players still in.
 *
 * Fields (the codec's SAVED / DERIVED `cutEngine` lists, tournamentCodec):
 *   participants  fixed, in the tournament's member order
 *   alive         Set of usernames still in
 *   out           Map username -> {round, left?} (eliminated in that round,
 *                 or left the tournament then)
 *   round         0 before the first round, then the round open or last resolved
 *   open          a round is open for draws
 *   deck          the remaining cards (the slots while a round is open)
 *   openDeck      the deck as the open round laid it out
 *   table         Map username -> card[] revealed since the last reshuffle
 *   reshuffles    how many reshuffles so far
 *   decks         how many full decks
 *   pending       DERIVED: Map username -> {slot, card, auto} (never saved,
 *                 never on the wire before the reveal)
 *   shuffleFn     DERIVED: cards -> shuffled copy
 *   randomInt     DERIVED: n -> 0..n-1 (the random slot)
 *
 * toSaved() drops the pending draws: a restored cut redraws the open round
 * (fromSaved puts the round's cards back in a new order and the round
 * number back by one, so the next openRound reopens the same round).
 */

'use strict';

const crypto = require('crypto');
const Deck = require('./Deck');
const { RANK_VALUES } = require('./rules');

const DECK_SIZE = 54;

const cardKey = (c) => `${c.suit}:${c.rank}`;
const copyCard = (c) => ({ suit: c.suit, rank: c.rank });

/** n -> 0..n-1: the seeded Math.random in a test run (Deck.isSeeded), else crypto. */
function defaultRandomInt(n) {
    return Deck.isSeeded() ? Math.floor(Math.random() * n) : crypto.randomInt(n);
}

/** A shuffled copy (Deck's Fisher-Yates). */
function defaultShuffle(cards) {
    const d = new Deck();
    d.cards = cards.map(copyCard);
    d.shuffle();
    return d.cards;
}

/** `decks` full decks in Deck's order. */
function fullDecks(decks) {
    const out = [];
    for (let i = 0; i < decks; i++) out.push(...new Deck().cards);
    return out;
}

const decksFor = (n) => Math.max(1, Math.ceil(n / DECK_SIZE));

class CutEngine {
    /**
     * @param {string[]} participants - at least 2, distinct
     * @param {Object} [opts]
     * @param {Object[]} [opts.deck] - the first deck order (tests); else shuffled
     * @param {Function} [opts.shuffle] - cards -> shuffled copy (tests)
     * @param {Function} [opts.randomInt] - n -> 0..n-1 (tests)
     */
    constructor(participants, opts = {}) {
        const names = [...participants];
        if (names.length < 2 || new Set(names).size !== names.length || names.some((u) => typeof u !== 'string' || !u)) {
            throw new Error('CutEngine: at least two distinct participants');
        }
        this.participants = names;
        this.alive = new Set(names);
        this.out = new Map();
        this.round = 0;
        this.open = false;
        this.decks = decksFor(names.length);
        this.shuffleFn = opts.shuffle || defaultShuffle;
        this.randomInt = opts.randomInt || defaultRandomInt;
        this.deck = opts.deck ? opts.deck.map(copyCard) : this.shuffleFn(fullDecks(this.decks));
        this.openDeck = null;
        this.table = new Map();
        this.reshuffles = 0;
        this.pending = new Map();
    }

    /** The full deck(s) size. */
    get deckSize() {
        return this.decks * DECK_SIZE;
    }

    /** The one player left, or null. */
    get winner() {
        return this.alive.size === 1 ? [...this.alive][0] : null;
    }

    /** Alive in participant order. */
    aliveList() {
        return this.participants.filter((u) => this.alive.has(u));
    }

    /** Every alive player has drawn this round. */
    allDrawn() {
        return this.open && this.aliveList().every((u) => this.pending.has(u));
    }

    /** Alive players who have not drawn yet (participant order). */
    waitingFor() {
        return this.open ? this.aliveList().filter((u) => !this.pending.has(u)) : [];
    }

    /**
     * Open the next round (round + 1): a reshuffle of the full deck(s) first
     * when fewer cards are left than players still in.
     * @returns {{round, alive: string[], deckCount, reshuffled}}
     */
    openRound() {
        if (this.open) throw new Error('CutEngine: a round is already open');
        if (this.alive.size < 2) throw new Error('CutEngine: the cut is over');
        this.round++;
        let reshuffled = false;
        if (this.deck.length < this.alive.size) {
            this.deck = this.shuffleFn(fullDecks(this.decks));
            this.table = new Map();
            this.reshuffles++;
            reshuffled = true;
        }
        this.openDeck = this.deck.map(copyCard);
        this.pending = new Map();
        this.open = true;
        return { round: this.round, alive: this.aliveList(), deckCount: this.deck.length, reshuffled };
    }

    _taken() {
        return new Set([...this.pending.values()].map((p) => p.slot));
    }

    /**
     * `user` draws. A null or out-of-range slot draws a random free one, a
     * taken one the nearest free one (i + d before i - d).
     * @returns {{username, slot, allDrawn}|null} null: not alive, a repeat, or no open round
     */
    draw(user, slot = null, { auto = false } = {}) {
        if (!this.open || !this.alive.has(user) || this.pending.has(user)) return null;
        const n = this.deck.length;
        const taken = this._taken();
        if (taken.size >= n) return null;
        let pick = null;
        if (Number.isInteger(slot) && slot >= 0 && slot < n) {
            if (!taken.has(slot)) pick = slot;
            for (let d = 1; pick === null && d < n; d++) {
                if (slot + d < n && !taken.has(slot + d)) pick = slot + d;
                else if (slot - d >= 0 && !taken.has(slot - d)) pick = slot - d;
            }
        } else {
            const free = [];
            for (let i = 0; i < n; i++) if (!taken.has(i)) free.push(i);
            pick = free[this.randomInt(free.length)];
        }
        this.pending.set(user, { slot: pick, card: this.deck[pick], auto: !!auto });
        return { username: user, slot: pick, allDrawn: this.allDrawn() };
    }

    /** A leaver's unrevealed card goes back to its slot. @returns {number|null} the freed slot */
    undraw(user) {
        const p = this.pending.get(user);
        if (!p) return null;
        this.pending.delete(user);
        return p.slot;
    }

    /** `user` left the tournament: out (left), its draw undone. @returns {boolean} it was alive */
    remove(user) {
        if (!this.alive.has(user)) return false;
        this.undraw(user);
        this.alive.delete(user);
        this.out.set(user, { round: this.round, left: true });
        return true;
    }

    /**
     * Resolve the open round (every alive player has drawn).
     * @returns {{round, draws: [{username, slot, card}], eliminated: string[], redraw: boolean, alive: string[], winner: string|null}}
     */
    resolve() {
        if (!this.allDrawn()) throw new Error('CutEngine: not every player has drawn');
        const drawers = this.aliveList();
        const draws = drawers.map((u) => {
            const p = this.pending.get(u);
            return { username: u, slot: p.slot, card: copyCard(p.card) };
        });
        const low = Math.min(...draws.map((d) => RANK_VALUES[d.card.rank]));
        const lowest = draws.filter((d) => RANK_VALUES[d.card.rank] === low).map((d) => d.username);
        const redraw = lowest.length === drawers.length;
        const eliminated = redraw ? [] : lowest;
        for (const u of eliminated) {
            this.alive.delete(u);
            this.out.set(u, { round: this.round });
        }
        // Every drawn card leaves the deck for good and goes on the table
        const slots = new Set(draws.map((d) => d.slot));
        this.deck = this.deck.filter((_, i) => !slots.has(i));
        for (const d of draws) {
            if (!this.table.has(d.username)) this.table.set(d.username, []);
            this.table.get(d.username).push(copyCard(d.card));
        }
        this.pending = new Map();
        this.open = false;
        return { round: this.round, draws, eliminated, redraw, alive: this.aliveList(), winner: this.winner };
    }

    /** Close the open round with no reveal (the last opponent left): its draws go back. */
    cancelRound() {
        this.pending = new Map();
        this.open = false;
    }

    /**
     * The safety cap (orchestration's CUT_MAX_ROUNDS): one player still in,
     * picked uniformly at random, wins; the others are out in this round.
     * @returns {string} the winner
     */
    forceWinner() {
        const alive = this.aliveList();
        const winner = alive[this.randomInt(alive.length)];
        this.pending = new Map();
        this.open = false;
        for (const u of alive) {
            if (u === winner) continue;
            this.alive.delete(u);
            this.out.set(u, { round: this.round });
        }
        return winner;
    }

    /** Cards left in the deck (the slots of the open round). */
    get deckCount() {
        return this.deck.length;
    }

    /** {username, slot} of the draws this round (never a card). */
    drawnSlots() {
        return this.aliveList().filter((u) => this.pending.has(u)).map((u) => ({ username: u, slot: this.pending.get(u).slot }));
    }

    /** The pending cards (tests: the secrecy guard). */
    pendingCards() {
        return [...this.pending.values()].map((p) => copyCard(p.card));
    }

    /** JSON for the tournament codec: the pending draws are dropped. */
    toSaved() {
        return {
            participants: [...this.participants],
            alive: this.aliveList(),
            out: [...this.out.entries()].map(([u, o]) => [u, { ...o }]),
            round: this.round,
            open: this.open,
            deck: this.deck.map(copyCard),
            openDeck: this.openDeck ? this.openDeck.map(copyCard) : null,
            table: [...this.table.entries()].map(([u, cards]) => [u, cards.map(copyCard)]),
            reshuffles: this.reshuffles,
            decks: this.decks
        };
    }

    /**
     * Rebuild from toSaved(): the remaining cards in a new order. An open
     * round's draws are gone: its cards go back, and the round number goes
     * back by one so the next openRound reopens the same round.
     */
    static fromSaved(saved, opts = {}) {
        const e = new CutEngine(saved.participants, { ...opts, deck: [] });
        e.alive = new Set(saved.alive);
        e.out = new Map((saved.out || []).map(([u, o]) => [u, { ...o }]));
        e.decks = saved.decks;
        e.reshuffles = saved.reshuffles;
        e.table = new Map((saved.table || []).map(([u, cards]) => [u, cards.map(copyCard)]));
        const remaining = saved.open && saved.openDeck ? saved.openDeck : saved.deck;
        e.deck = e.shuffleFn(remaining.map(copyCard));
        e.round = saved.open ? Math.max(0, saved.round - 1) : saved.round;
        e.openDeck = null;
        e.open = false;
        e.pending = new Map();
        return e;
    }

    /**
     * Why the engine is inconsistent, or null (tests, and the codec's
     * refusal for a saved one): deck + table is the full deck(s) as a
     * multiset (the pending cards are still in the deck), alive and out
     * are disjoint and together the participants, pending only alive.
     */
    invalid() {
        const names = new Set(this.participants);
        for (const u of this.alive) if (!names.has(u) || this.out.has(u)) return 'alive';
        for (const u of this.out.keys()) if (!names.has(u)) return 'out';
        if (this.alive.size + this.out.size !== this.participants.length) return 'members';
        for (const u of this.pending.keys()) if (!this.alive.has(u)) return 'pending';
        if (!Number.isInteger(this.decks) || this.decks < 1) return 'decks';
        const count = new Map();
        const add = (c, k) => count.set(cardKey(c), (count.get(cardKey(c)) || 0) + k);
        for (const c of fullDecks(this.decks)) add(c, 1);
        for (const c of this.deck) add(c, -1);
        for (const cards of this.table.values()) for (const c of cards) add(c, -1);
        for (const v of count.values()) if (v !== 0) return 'cards';
        const taken = this._taken();
        if (taken.size !== this.pending.size) return 'slots';
        for (const s of taken) if (!(s >= 0 && s < this.deck.length)) return 'slots';
        if (!Number.isInteger(this.round) || this.round < 0) return 'round';
        return null;
    }

    /** Throws on an inconsistent engine (tests). */
    assertValid() {
        const why = this.invalid();
        if (why) throw new Error(`CutEngine invalid: ${why}`);
    }
}

/**
 * tournamentJoined.cut ($defs.cutState) for a socket with the cap: the cut
 * as it stands. Never a pending card: `drawn` holds slots only.
 * @param {Object} cut - TournamentState.cut
 * @param {number} [now]
 */
function cutStateWire(cut, now = Date.now()) {
    const e = cut.engine || null;
    const stage = cut.stage;
    const state = {
        stage,
        inMs: Number.isFinite(cut.endsAt) ? Math.max(0, Math.round(cut.endsAt - now)) : 0,
        round: e ? e.round : 0
    };
    if (stage === 'gather' || !e) state.candidates = [...(cut.candidates || [])];
    if (e) state.participants = [...e.participants];
    state.alive = e ? e.aliveList() : [];
    state.out = e ? [...e.out.entries()].map(([username, o]) => ({ username, round: o.round, ...(o.left ? { left: true } : {}) })) : [];
    state.table = e ? e.participants.filter((u) => e.table.has(u)).map((username) => ({ username, cards: e.table.get(username).map(copyCard) })) : [];
    state.drawn = e ? e.drawnSlots() : [];
    state.deckCount = e ? e.deckCount : DECK_SIZE * decksFor((cut.candidates || []).length);
    if (cut.lastReveal) {
        const r = cut.lastReveal;
        state.lastReveal = { round: r.round, draws: r.draws.map((d) => ({ username: d.username, slot: d.slot, card: copyCard(d.card) })), eliminated: [...r.eliminated], redraw: !!r.redraw };
    }
    if (cut.result?.winner) state.winner = cut.result.winner;
    return state;
}

module.exports = { CutEngine, DECK_SIZE, decksFor, fullDecks, cardKey, copyCard, cutStateWire };
