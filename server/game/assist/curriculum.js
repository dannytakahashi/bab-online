/**
 * The tutorial's curriculum (help plan 5.3-5.4, the LEAN scope of
 * 2026-11-19 with the fade-out): which rule tip to show when, and whether a
 * decision's advice is shown at all. Driven by server/socket/assistHandlers.js
 * (tutorTick, the hand end, the game end); the advice itself is the same
 * advise() + explain() answer /help gives (shared cache).
 *
 * Moments (per tutorial seat):
 *  - 'decision': the seat's own NON-FORCED bid or play turn (a forced move
 *    gets nothing: no tip, no advice). At most ONE rule tip, then the advice
 *  - 'between': any other turn of the table. At most ONE rule tip between
 *    two of the seat's own decisions (the handler keeps that window; a
 *    hand's end opens a new one)
 *  - the hand end: T.handScore after hands 1-3, T.graduate after the 2-card
 *    hand (hand 6); the game end: T.done
 * Each topic shows once per game (`tips`, game.assist[pos].tips, a
 * bitmask: TIP_BITS); a tip whose trigger no longer holds is not shown (it
 * may show later, once, if it holds again). T.welcome, T.graduate and
 * T.done are system tips, outside the rule-tip budget.
 *
 * The fade-out (owner 2026-11-19, "I do like the fade-out idea"): from
 * T.graduate on (the end of the 2-card hand, for a seat with the tutorial
 * on then), advice is shown only for a choice that is not obvious
 * (showAdvice): a card only when the confidence is clear or certain AND the
 * card is not the obvious one (not the only card of the suit led, not the
 * lowest legal card of its suit when the rule's answer is the plain "play
 * low"); a bid only when the suggestion is not the plain count of the
 * hand's expected tricks (BotStrategy.estimateOwnTricks, rounded, as the
 * bid trace's ownMean) or is a bore, and the confidence is not close.
 * Rule tips not yet shown still show after graduation (the 1-card hand is
 * hand 7).
 *
 * Copy (plan 3.3; copy.test.js-style lint in curriculum.test.js): names
 * only ("Bob (your partner)" on first mention, the other pair "Carol and
 * Dan"), never a team number, "your team" or "opponents"; every number
 * matches docs/RULES.md and rules.calculateScore (tested). Titles at most
 * TITLE_MAX characters, texts at most TIP_MAX.
 *
 * Pure: reads only a SeatView (seatView.js), advise()'s decision, the
 * explanation and plain facts the handler passes; no I/O, no Math.random,
 * no Date.
 */

'use strict';

const rules = require('../rules');
const { getCurrentWinner } = require('../bot/BotStrategy');
const C = require('./copy');

const TITLE_MAX = C.HEADLINE_MAX;
const TIP_MAX = C.DETAIL_MAX;

/** Bit of each topic in game.assist[pos].tips (once per game). */
const TIP_BITS = Object.freeze({
    'T.welcome': 0,
    'T.trump': 1,
    'T.noTrump': 2,
    'T.bid': 3,
    'T.set': 4,
    'T.bore': 5,
    'T.zero': 6,
    'T.lead': 7,
    'T.follow': 8,
    'T.void': 9,
    'T.partnerWins': 10,
    'T.hiJoker': 11,
    'T.broken': 12,
    'T.made': 13,
    // T.handScore once after each of hands 1-3
    'T.handScore1': 14,
    'T.handScore2': 15,
    'T.handScore3': 16,
    'T.rainbow': 17,
    'T.oneCard': 18,
    'T.graduate': 19,
    'T.done': 20
});

/** The hand (its size) whose end graduates the seat: the 2-card hand, hand 6. */
const GRADUATE_AFTER = 2;
/** Hands (1-based, in HAND_PROGRESSION order) that end with T.handScore. */
const HAND_SCORE_HANDS = 3;

/** Rule codes whose answer is the plain "play your lowest" (reasons.js). */
const PLAY_LOW_CODES = new Set(['F.partnerWinsLow', 'F.hoardDuck', 'F.cantWin', 'F.onlyTrumpLeft', 'F.underTrump', 'D.lowest']);

const MULT_WORDS = Object.freeze({ 2: ['Double', 'double'], 4: ['Four times', 'four times'], 8: ['Eight times', 'eight times'], 16: ['Sixteen times', 'sixteen times'] });

const has = (tips, id) => ((tips >>> TIP_BITS[id]) & 1) === 1;
const withTip = (tips, id) => (tips | (1 << TIP_BITS[id])) >>> 0;

/** Has the seat graduated (T.graduate shown)? */
const isGraduated = (tips) => has(tips, 'T.graduate');

// ------------------------------------------------------------ facts

/** What a tip may read about the seat's table, from the SeatView alone. */
function factsOf(view) {
    const trump = view.trump;
    const noTrump = trump.suit === 'joker';
    const isTrump = (c) => !!c && (c.suit === 'joker' || (!noTrump && c.suit === trump.suit));
    const eff = (c) => (isTrump(c) ? 'trump' : c.suit);
    let onTable = 0;
    for (let p = 1; p <= 4; p++) if (view.playedCards[p - 1]) onTable++;
    const play = view.stage === 'play';
    const mine = play ? view.playedCards[view.position - 1] : null;
    const following = play && onTable > 0 && !mine;
    const leading = play && onTable === 0;
    const leadSuit = following && view.leadCard ? eff(view.leadCard) : null;
    const name = (p) => C.cleanName(view.names[p]);
    const partner = name(view.partner);
    const [o1, o2] = view.others;
    const team1 = view.position % 2 === 1;
    const ctx = view.playContext || {};
    return {
        view,
        trump,
        noTrump,
        isTrump,
        eff,
        play,
        following,
        leading,
        leadSuit,
        name,
        partner,
        partnerTagged: `${partner} (your partner)`,
        them: `${name(o1)} and ${name(o2)}`,
        ourBid: ctx.bids ? (team1 ? ctx.bids.team1 : ctx.bids.team2) : null,
        ourTricks: ctx.tricks ? (team1 ? ctx.tricks.team1 : ctx.tricks.team2) : null,
        ourMult: team1 ? ctx.team1Mult : ctx.team2Mult,
        winner: following && view.leadPosition ? getCurrentWinner(view.playedCards, view.leadPosition, trump) : null
    };
}

const suitPlural = (s) => s;
const suitOne = (s) => C.suitWord(s, 1);

/** "A bore (B)" style words for a bore of multiplier `mult` (2, 4, 8, 16). */
function multWords(mult) {
    return MULT_WORDS[mult] || ['Double', 'double'];
}

// ------------------------------------------------------------ the catalog

/**
 * The rule tips in priority order (the first whose trigger holds and whose
 * topic was not shown wins). `moments`: where it may show. `text(f, d)`:
 * the words, or null when the trigger does not hold (f = factsOf(view),
 * d = advise()'s decision at a 'decision' moment, else null).
 */
const RULE_TIPS = Object.freeze([
    {
        id: 'T.trump', title: 'Trump', moments: ['decision', 'between'],
        text: (f) => {
            if (f.noTrump) return null;
            const s = f.trump.suit;
            return `Trump this hand is ${suitPlural(s)} ${C.SUIT_SYMBOL[s]}. Any ${suitOne(s)} beats any card of another suit, and the two jokers are the highest trumps.`;
        }
    },
    {
        id: 'T.noTrump', title: 'No trump suit', moments: ['decision', 'between'],
        text: (f) => (f.noTrump ? 'A joker was flipped: no trump suit this hand. Only the other joker is trump.' : null)
    },
    {
        id: 'T.bid', title: 'Bidding', moments: ['decision'],
        text: (f, d) => (d && d.kind === 'bid'
            ? `Bid how many tricks you expect to win. Your bid adds to the bid of ${f.partnerTagged}: together you must win at least that many.`
            : null)
    },
    {
        id: 'T.oneCard', title: 'One card each', moments: ['decision'],
        text: (f, d) => (d && d.kind === 'bid' && f.view.handSize === 1 ? 'One card each: bid 1 only if your card is likely to win the trick.' : null)
    },
    {
        id: 'T.bore', title: 'Bore', moments: ['decision', 'between'],
        text: (f, d) => {
            if (f.view.stage !== 'bid' && f.view.stage !== 'play') return null;
            if (d && d.kind === 'bid' && rules.BORE_BIDS.includes(d.bid)) {
                const [Big, small] = multWords(rules.calculateMultiplier(d.bid));
                const label = d.bid === 'B' ? 'A bore (B)' : `A ${d.bid} bore`;
                return `${label} is a bet that you and ${f.partnerTagged} win every trick. ${Big} the points if made, minus ${small} if not.`;
            }
            // Someone at the table bid one this hand (the highest so far)
            let at = null;
            for (let p = 1; p <= 4; p++) {
                const b = f.view.playerBids[p - 1];
                if (b != null && rules.BORE_BIDS.includes(String(b)) && (!at || rules.BORE_BIDS.indexOf(String(b)) > rules.BORE_BIDS.indexOf(String(f.view.playerBids[at - 1])))) at = p;
            }
            if (!at) return null;
            const bid = String(f.view.playerBids[at - 1]);
            const [Big, small] = multWords(rules.calculateMultiplier(bid));
            const ours = at === f.view.position || at === f.view.partner;
            const who = at === f.view.position ? 'You' : at === f.view.partner ? f.partnerTagged : f.name(at);
            const pair = !ours ? f.them : at === f.view.position ? `you and ${f.partnerTagged}` : `you and ${f.partner}`;
            return `${who} bid ${bid}, a bore: a bet that ${pair} win every trick. ${Big} the points if made, minus ${small} if not.`;
        }
    },
    {
        id: 'T.zero', title: 'Bidding 0', moments: ['decision', 'between'],
        text: (f, d) => {
            if (f.view.stage !== 'bid') return null;
            const suggested = d && d.kind === 'bid' && d.bid === '0';
            const partnerZero = String(f.view.playerBids[f.view.partner - 1]) === '0';
            if (!suggested && !partnerZero) return null;
            return `If you and ${f.partnerTagged} both bid 0, you can't be set: each trick you win is worth 1 point.`;
        }
    },
    {
        id: 'T.hiJoker', title: 'HI joker', moments: ['decision'],
        text: (f, d) => {
            if (!d) return null;
            if (f.following && f.view.leadCard && f.view.leadCard.rank === 'HI') {
                const leader = f.view.leadPosition;
                if (leader === f.view.partner) {
                    return `${f.partnerTagged} led the HI joker: ${f.them} must play their highest trump. You may play any trump you hold, or any card if you have none.`;
                }
                return `${f.name(leader)} led the HI joker: you must play your highest trump, or any card if you have none.`;
            }
            if (f.view.hand.some((c) => c.suit === 'joker' && c.rank === 'HI')) {
                return `You hold the HI joker, the highest card. When you lead it, ${f.them} must each play their highest trump.`;
            }
            return null;
        }
    },
    {
        id: 'T.lead', title: 'Leading', moments: ['decision'],
        text: (f, d) => {
            if (!d || d.kind !== 'card' || !f.leading || f.view.isTrumpBroken) return null;
            return f.noTrump
                ? 'You lead this trick. A joker can\'t be led until a joker has been played, unless you hold only jokers.'
                : 'You lead this trick. Trump can\'t be led until a trump has been played (trump is then broken), unless you hold only trump.';
        }
    },
    {
        id: 'T.follow', title: 'Following suit', moments: ['decision'],
        text: (f, d) => {
            if (!d || d.kind !== 'card' || !f.leadSuit) return null;
            const holds = f.view.hand.some((c) => f.eff(c) === f.leadSuit);
            if (!holds || f.view.legal.length >= f.view.hand.length) return null;
            if (f.leadSuit === 'trump') {
                return f.noTrump
                    ? 'A joker was led: you must play the other joker if you have it.'
                    : 'Trump was led: you must play a trump if you have one (the jokers are trump too).';
            }
            return `${C.capital(suitPlural(f.leadSuit))} were led: you must play a ${suitOne(f.leadSuit)} if you have one.`;
        }
    },
    {
        id: 'T.void', title: 'None of the suit led', moments: ['decision'],
        text: (f, d) => {
            if (!d || d.kind !== 'card' || !f.leadSuit || f.leadSuit === 'trump') return null;
            if (f.view.hand.some((c) => f.eff(c) === f.leadSuit)) return null;
            const s = f.leadSuit;
            if (f.view.hand.some((c) => f.isTrump(c))) {
                return `You have no ${suitPlural(s)}, so you may play any card. A ${f.noTrump ? 'joker' : 'trump'} beats every ${suitOne(s)}; any other card can't win this trick.`;
            }
            return `You have no ${suitPlural(s)}, so you may play any card, but none of yours can win this trick.`;
        }
    },
    {
        id: 'T.partnerWins', title: 'Your partner is winning', moments: ['decision'],
        text: (f, d) => {
            if (!d || d.kind !== 'card' || !f.winner || f.winner.position !== f.view.partner) return null;
            // Only when the suggested card leaves the trick with the partner
            const cards = f.view.playedCards.slice();
            cards[f.view.position - 1] = d.card;
            if (getCurrentWinner(cards, f.view.leadPosition, f.trump).position !== f.view.partner) return null;
            return `${f.partnerTagged} is winning this trick. Save your strong cards for later tricks.`;
        }
    },
    {
        id: 'T.set', title: 'Scoring', moments: ['decision', 'between'],
        text: (f, d, tips) => (has(tips, 'T.bid')
            ? 'Win at least your combined bid and you score 10 points per trick bid, plus 1 for each extra trick. Fall short and you lose 10 per trick bid.'
            : null)
    },
    {
        id: 'T.rainbow', title: 'Rainbow', moments: ['decision', 'between'],
        text: (f) => (f.view.handSize === 4
            ? 'On the 4-card hand, holding one card of each suit is a rainbow: +10 points, even if the bid is missed.'
            : null)
    },
    {
        id: 'T.broken', title: 'Trump broken', moments: ['decision', 'between'],
        text: (f) => {
            if (!f.play || !f.view.isTrumpBroken) return null;
            return f.noTrump ? 'A joker has been played: anyone may now lead a joker.' : 'Trump is broken: anyone may now lead trump.';
        }
    },
    {
        id: 'T.made', title: 'Bid made', moments: ['decision', 'between'],
        text: (f) => {
            if (!f.play || f.ourBid == null || f.ourBid < 1 || f.ourTricks < f.ourBid || f.ourMult !== 1) return null;
            if (!f.view.hand.length) return null;
            return `You and ${f.partnerTagged} made your bid! Extra tricks are worth 1 point each.`;
        }
    }
]);

/** System tips (outside the rule-tip budget). `line`: the words for a client without the tip card. */
const SYSTEM_TIPS = Object.freeze({
    'T.welcome': {
        title: 'Tutorial on',
        text: 'Tips will appear above your cards. Only you see them. Close one with ×, or choose Turn off to stop them.',
        line: 'Tips will appear in the game log. Only you see them. Type /tutorial off to stop them.'
    },
    'T.graduate': {
        title: 'Tutorial',
        text: 'You\'ve got the basics. From now on tips show only for tricky choices. /help works any time.'
    },
    'T.done': {
        title: 'Tutorial complete',
        text: 'Tutorial complete. Type /help any time for a suggestion.'
    }
});

function tipOut(id, title, text) {
    return { id, title: C.clip(title, TITLE_MAX), text: C.clip(text, TIP_MAX) };
}

/** A system tip ({id, title, text}); `line` picks the plain-text words. */
function systemTip(id, { line = false } = {}) {
    const t = SYSTEM_TIPS[id];
    return tipOut(id, t.title, line && t.line ? t.line : t.text);
}

/**
 * The rule tip for this moment, or null.
 * @param {'decision'|'between'} moment
 * @param {Object} view - the seat's SeatView
 * @param {Object|null} decision - advise() at a 'decision' moment
 * @param {number} tips - game.assist[pos].tips
 * @returns {{id, title, text}|null}
 */
function pickTip(moment, view, decision, tips) {
    if (!view) return null;
    const f = factsOf(view);
    for (const t of RULE_TIPS) {
        if (!t.moments.includes(moment) || has(tips, t.id)) continue;
        const text = t.text(f, moment === 'decision' ? decision : null, tips);
        if (text) return tipOut(t.id, t.title, text);
    }
    return null;
}

/**
 * A 'decision' moment: the seat's own turn. Returns the rule tip (at most
 * one), whether the advice is shown, and the tips bitmask after it.
 * Nothing at all for a forced move.
 */
function decisionStep({ view, decision, e, tips }) {
    if (!view || !decision || decision.forced) return { tip: null, advice: false, tips };
    const tip = pickTip('decision', view, decision, tips);
    return { tip, advice: showAdvice(view, decision, e, isGraduated(tips)), tips: tip ? withTip(tips, tip.id) : tips };
}

/**
 * A 'between' moment: someone else's turn. At most one rule tip per window
 * (`windowUsed`: a tip already shown since the seat's last own decision).
 */
function betweenStep({ view, tips, windowUsed }) {
    if (windowUsed || !view) return { tip: null, tips, windowUsed };
    const tip = pickTip('between', view, null, tips);
    return tip ? { tip, tips: withTip(tips, tip.id), windowUsed: true } : { tip: null, tips, windowUsed };
}

// ------------------------------------------------------------ hand end

/**
 * "5 × 10 + 1 = +51" / "3 × 10 = +30" / "−3 × 10 = −30" / "12 × 10 × 2 =
 * +240" / "2 × 1 = +2" (a bid of 0): the hand's points of one pair, as
 * rules.calculateScore counts them (no rainbow: hands 1-3 never have one).
 */
function pointsFormula(bid, won, mult) {
    const m = mult > 1 ? ` × ${mult}` : '';
    if (won >= bid) {
        if (bid === 0) return `${won} × 1 = +${won}`;
        const extra = won - bid;
        return `${bid} × 10${m}${extra ? ` + ${extra}` : ''} = +${bid * 10 * mult + extra}`;
    }
    return `−${bid} × 10${m} = −${bid * 10 * mult}`;
}

/**
 * T.handScore after hands 1-3 (real numbers), or null.
 * @param {Object} facts - {handIndex (1-13), position, names {1-4},
 *   bids {team1, team2}, tricks {team1, team2}, mults {team1, team2}}
 */
function handScoreTip(facts, tips) {
    const k = facts.handIndex;
    if (!(k >= 1 && k <= HAND_SCORE_HANDS)) return null;
    const id = `T.handScore${k}`;
    if (has(tips, id)) return null;
    const team1 = facts.position % 2 === 1;
    const our = team1 ? 'team1' : 'team2';
    const their = team1 ? 'team2' : 'team1';
    const name = (p) => C.cleanName(facts.names[p]);
    const partner = rules.getPartnerPosition(facts.position);
    const o1 = rules.rotatePosition(facts.position);
    const o2 = rules.getPartnerPosition(o1);
    const side = (t) => `bid ${facts.bids[t]} and won ${facts.tricks[t]}: ${pointsFormula(facts.bids[t], facts.tricks[t], facts.mults[t] || 1)}`;
    const text = `This hand, you and ${name(partner)} (your partner) ${side(our)}. ${name(o1)} and ${name(o2)} ${side(their)}.`;
    return { ...tipOut('T.handScore', 'Hand score', text), bitId: id };
}

/**
 * The tips at the end of a hand, in order: T.handScore (hands 1-3), then
 * T.graduate at the end of the 2-card hand. The game's last hand gets none
 * (T.done comes at the game end).
 */
function handEndTips(facts, tips) {
    const out = [];
    const hs = handScoreTip(facts, tips);
    if (hs) out.push(hs);
    if (facts.handSize === GRADUATE_AFTER && !has(tips, 'T.graduate')) out.push({ ...systemTip('T.graduate'), bitId: 'T.graduate' });
    return out;
}

// ------------------------------------------------------------ the fade-out

/** Is `card` the obvious play here (the only one of the suit led, or the plain "play low")? */
function obviousCard(view, card, codes) {
    const f = factsOf(view);
    if (!f.following || !f.leadSuit) return false;
    const ofLead = view.hand.filter((c) => f.eff(c) === f.leadSuit);
    if (f.eff(card) === f.leadSuit && ofLead.length === 1) return true;
    if ((codes || []).some((c) => PLAY_LOW_CODES.has(c))) {
        const same = view.legal.filter((c) => f.eff(c) === f.eff(card));
        if (same.every((c) => rules.RANK_VALUES[c.rank] >= rules.RANK_VALUES[card.rank])) return true;
    }
    return false;
}

/**
 * The plain count for a bid: the hand's expected tricks rounded
 * (the bid trace's ownMean, BotStrategy.estimateOwnTricks), or null when
 * the bid's path had none (a bore path).
 */
function plainCount(decision) {
    const m = decision && decision.trace && decision.trace.bid ? decision.trace.bid.ownMean : null;
    return typeof m === 'number' && Number.isFinite(m) ? Math.round(m) : null;
}

/**
 * After graduation, is this bid suggestion worth showing? A bore always
 * (it is never the plain count); otherwise only when it differs from the
 * plain count of expected tricks and the confidence is not a close call.
 */
function trickyBid(decision, e) {
    if (rules.BORE_BIDS.includes(decision.bid)) return true;
    if (e.confidence === 'close' || e.confidence === 'any' || e.confidence === 'quick') return false;
    const n = plainCount(decision);
    if (n == null) return true;
    return Number(decision.bid) !== n;
}

/**
 * Is this decision's advice shown? Never for a forced move; every other
 * decision before graduation; after it only the tricky ones (the fade-out).
 * @param {Object} view - SeatView
 * @param {Object} decision - advise()
 * @param {Object} e - explain()
 * @param {boolean} graduated - isGraduated(tips)
 */
function showAdvice(view, decision, e, graduated) {
    if (!decision || decision.forced) return false;
    if (!graduated) return true;
    if (decision.kind === 'bid') return trickyBid(decision, e);
    if (e.confidence !== 'clear' && e.confidence !== 'certain') return false;
    return !obviousCard(view, decision.card, e.codes);
}

module.exports = {
    TIP_BITS,
    TITLE_MAX,
    TIP_MAX,
    GRADUATE_AFTER,
    HAND_SCORE_HANDS,
    PLAY_LOW_CODES,
    RULE_TIPS,
    SYSTEM_TIPS,
    has,
    withTip,
    isGraduated,
    pickTip,
    decisionStep,
    betweenStep,
    systemTip,
    handScoreTip,
    handEndTips,
    pointsFormula,
    obviousCard,
    plainCount,
    trickyBid,
    showAdvice,
    factsOf
};
