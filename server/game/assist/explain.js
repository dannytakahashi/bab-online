/**
 * Words for a /help suggestion (plan §3.2-3.4): explain(decision, view)
 * turns advise()'s decision trace into a headline, 1-2 reasons, a few
 * details and a confidence. Faithful by construction (plan Q1): every
 * reason comes from the path the bot actually took (the bid trace, the
 * terminal rule code and its facts, or the search's own per-card numbers),
 * never from an after-the-fact classifier.
 *
 * Pure and synchronous: reads only the decision and the SeatView; no I/O,
 * no Math.random, no Date.
 */

'use strict';

const rules = require('../rules');
const { estimateOwnTricks, teamTrickDistribution, getCurrentWinner } = require('../bot/BotStrategy');
const { TEAM_SD, TEAM_SD_NO_TRUMP } = require('../bot/bidModel');
const { SEARCH } = require('../bot/playSearch');
const C = require('./copy');
const R = require('./reasons');

const { cardText, suitWord, capital, cleanName, listText, rate, rateShort, pct5, tricksText, pointsText, clip } = C;

const BORES = ['B', '2B', '3B', '4B'];
const same = (a, b) => !!a && !!b && a.suit === b.suit && a.rank === b.rank;
const RANK = rules.RANK_VALUES;
const SUIT_RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];

// ------------------------------------------------------------ context

/**
 * The helpers templates use: names (partner tagged on first mention), card
 * and suit words, and what the seat has seen (its hand, the played cards).
 */
function makeContext(view, card) {
    const trump = view.trump;
    const noTrump = trump.suit === 'joker';
    const [o1, o2] = view.others;
    const raw = (p) => cleanName(view.names[p]);
    // The partner is written as a marker; finish() tags the first one read
    const nameOf = (p) => (p === view.partner ? PARTNER : raw(p));
    const isTrump = (c) => !!c && (c.suit === 'joker' || (!noTrump && c.suit === trump.suit));
    const following = view.stage === 'play' && view.playedCards.some((c) => c);
    const leadSuit = following && view.leadCard ? (view.leadCard.suit === 'joker' ? trump.suit : view.leadCard.suit) : null;
    const winner = following ? getCurrentWinner(view.playedCards, view.leadPosition, trump) : null;
    // Seats still to play this trick, after this one, in order
    const behindAll = [];
    if (following) {
        for (let p = rules.rotatePosition(view.position); p !== view.leadPosition; p = rules.rotatePosition(p)) {
            if (!view.playedCards[p - 1]) behindAll.push(p);
        }
    }
    const behind = behindAll.filter((p) => p !== view.partner);
    const played = view.memory ? view.memory.playedCards : [];
    const isPlayed = (c) => played.some((e) => e.suit === c.suit && e.rank === c.rank);
    const inHand = (c) => view.hand.some((h) => same(h, c));
    const flipped = (c) => same(c, trump);

    const x = {
        view,
        card,
        noTrump,
        leadSuit,
        winner,
        behind,
        behindAll: () => behindAll,
        nameOf,
        partnerName: () => PARTNER,
        /** "your partner Bob's" on first mention, then "Bob's". */
        partnerPoss: () => PARTNER_POSS,
        us: () => `you and ${PARTNER}`,
        /** The first variant that fits `max` once the partner is spelled out (tagged). */
        fit: (variants, max = C.REASON_MAX) => fitNamed(variants, max, raw(view.partner)),
        wide: (t) => widest(t, raw(view.partner)),
        them: () => `${nameOf(o1)} and ${nameOf(o2)}`,
        themPossessive: () => `${raw(o1)}'s and ${raw(o2)}'s`,
        namesOr: (list) => listText(list.map(nameOf)),
        behindText: () => (behind.length ? listText(behind.map(nameOf)) : 'nobody'),
        borer: () => listText(view.others.filter((p) => BORES.includes(String(view.playerBids[p - 1]))).map(nameOf)),
        trumpCard: isTrump,
        suitOrTrump: (c) => (isTrump(c) ? 'trump' : suitWord(c.suit, 1)),
        ownInSuit: (suit) => view.hand.filter((h) => h.suit === suit && !isTrump(h)).length,
        hasTrump: () => view.hand.some(isTrump),
        /**
         * " (A♠ is played)": the cards above `c` in its suit (or trump) that
         * are played, when that is why `c` is the highest left; "" when
         * there are none to name or more than two.
         */
        higherPlayed: (c) => {
            const above = [];
            if (isTrump(c)) {
                for (const r of ['HI', 'LO']) if (RANK[r] > RANK[c.rank]) above.push({ suit: 'joker', rank: r });
                if (!noTrump) for (const r of SUIT_RANKS) if (RANK[r] > RANK[c.rank]) above.push({ suit: trump.suit, rank: r });
            } else {
                for (const r of SUIT_RANKS) if (RANK[r] > RANK[c.rank]) above.push({ suit: c.suit, rank: r });
            }
            const out = above.filter((a) => !inHand(a) && !flipped(a));
            if (out.length === 0 || out.length > 2 || !out.every(isPlayed)) return '';
            return ` (${listText(out.map(cardText))} ${out.length === 1 ? 'is' : 'are'} played)`;
        },
        forcedText: () => forcedText(view, card, x)
    };
    return x;
}

/** "Lead", "Play", "Trump with" or "Throw" for `card` at this point of the trick. */
function verbFor(view, card) {
    if (!view.playedCards.some((c) => c)) return 'Lead';
    const trump = view.trump;
    const suitOf = (c) => (c.suit === 'joker' ? trump.suit : c.suit);
    if (suitOf(card) === suitOf(view.leadCard)) return 'Play';
    const isTrump = card.suit === 'joker' || (trump.suit !== 'joker' && card.suit === trump.suit);
    return isTrump ? 'Trump with' : 'Throw';
}

function cardHeadline(view, card) {
    return `${verbFor(view, card)} ${card.suit === 'joker' ? 'the ' : ''}${cardText(card)}`;
}

function forcedText(view, card, x) {
    if (view.hand.length === 1) return 'It\'s your last card.';
    if (!view.playedCards.some((c) => c)) return 'It\'s the only card you may lead (trump can\'t be led until it\'s broken).';
    const lead = view.leadCard;
    if (lead && lead.rank === 'HI' && (view.position % 2) !== (view.leadPosition % 2) && x.trumpCard(card)) {
        return `${x.nameOf(view.leadPosition)} led the HI joker, so you must play your highest trump.`;
    }
    if (x.leadSuit && (card.suit === 'joker' ? view.trump.suit : card.suit) === x.leadSuit) {
        return `Your only legal card: you must follow ${x.trumpCard(card) && !x.noTrump ? 'trump' : suitWord(x.leadSuit)}.`;
    }
    return 'Your only legal card.';
}

// ------------------------------------------------------------ assembly

// Partner markers in template output: finish() writes the first one read as
// "Bob (your partner)" / "your partner Bob's" and the rest as "Bob" / "Bob's"
const PARTNER = '\u0001';
const PARTNER_POSS = '\u0002';

/** `s` with every partner marker in its longest (tagged) form: for length checks. */
function widest(s, name) {
    return s.split(PARTNER).join(`${name} (your partner)`).split(PARTNER_POSS).join(`your partner ${name}'s`);
}

function fitNamed(variants, max, name) {
    const list = (Array.isArray(variants) ? variants : [variants]).filter(Boolean);
    for (const v of list) if (widest(v, name).length <= max) return v;
    return clip(widest(list[list.length - 1] || '', name), max);
}

/**
 * Spell out the partner markers over `texts` in reading order: the first
 * mention tagged, the others plain. A text that already carries the tag
 * (a clipped fallback) counts as the first mention.
 */
function spellNames(texts, name) {
    let tagged = false;
    return texts.map((t) => {
        if (!t) return t;
        if (t.includes(`${name} (your partner)`) || t.includes(`your partner ${name}'s`)) tagged = true;
        let out = '';
        for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            if (ch !== PARTNER && ch !== PARTNER_POSS) { out += ch; continue; }
            if (ch === PARTNER) out += tagged ? name : `${name} (your partner)`;
            else {
                const start = out.length === 0 || /[.:!?]\s$/.test(out);
                out += tagged ? `${name}'s` : `${start ? 'Your' : 'your'} partner ${name}'s`;
            }
            tagged = true;
        }
        return out;
    });
}

/** Render template `code` (string or variants) to fit `max`. */
function say(code, facts, x, max = C.REASON_MAX) {
    const t = R.TABLE[code];
    if (!t) return null;
    const v = t(facts || {}, x);
    return v == null ? null : x.fit(v, max);
}

function finish({ headline, reasons, details, confidence, suggest, codes, partnerName }, mode, glossed) {
    const rs0 = reasons.filter(Boolean).slice(0, C.MAX_REASONS);
    const ds0 = details.filter(Boolean).slice(0, C.MAX_DETAILS);
    const spelled = spellNames([...rs0, ...ds0], partnerName);
    const rs = spelled.slice(0, rs0.length).map((r) => clip(r, C.REASON_MAX));
    const ds = spelled.slice(rs0.length).map((d) => clip(d, C.DETAIL_MAX));
    const e = {
        headline: clip(headline, C.HEADLINE_MAX),
        reasons: rs,
        details: ds,
        confidence,
        suggest,
        codes
    };
    if (mode === 'tutorial') e.gloss = C.glossFor([e.headline, ...rs, ...ds], glossed);
    // For render's line style (not part of the payload)
    Object.defineProperty(e, 'partnerName', { value: partnerName, enumerable: false });
    return deepFreeze(e);
}

function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
}

// ------------------------------------------------------------ contract

/** The C.* code and facts for the contract line, or null. */
function contractLine(view, contract) {
    if (!contract || !view.playContext || !view.playContext.bids) return null;
    const team1 = view.position % 2 === 1;
    const b = view.playContext.bids;
    const t = view.playContext.tricks;
    const myBid = (team1 ? b.team1 : b.team2) || 0;
    const myTricks = (team1 ? t.team1 : t.team2) || 0;
    const left = contract.tricksRemaining;
    const f = { myBid, myTricks, needed: contract.needed, oppNeeded: contract.oppNeeded, left, toSet: contract.target };
    if (contract.teamBored) return { code: 'C.boreUs', facts: f };
    if (contract.oppBored) return { code: 'C.boreThem', facts: f };
    if (contract.effort === 'cheap') return { code: contract.needed === 0 ? 'C.made' : 'C.dead', facts: f };
    const makeTarget = contract.needed <= left ? contract.needed : 0;
    if (contract.target > makeTarget) return { code: 'C.setThem', facts: f };
    if (contract.target >= left) return { code: 'C.max', facts: f };
    return { code: 'C.normal', facts: f };
}

// ------------------------------------------------------------ rule plays

/** The lead-suit choice (L.suit context entry) in words, or null. */
function suitChoiceText(facts, x) {
    const S = facts.suit;
    const scores = facts.scores || {};
    if (facts.partnerVoid) return `${x.partnerName()} is out of ${suitWord(S)} and can trump ${suitWord(S, 1)} leads.`;
    // A suit that would have been led but for a shown void or an earlier lead
    for (const [T, s] of Object.entries(scores)) {
        if (T === S) continue;
        if (s.oppRuff && s.oppRuff.length && s.score + 5 * s.oppRuff.length > facts.score) {
            return `Not ${suitWord(T)}: ${x.namesOr(s.oppRuff)} ${s.oppRuff.length === 1 ? 'has' : 'have'} shown they're out of ${suitWord(T)} and can trump ${suitWord(T)}.`;
        }
    }
    for (const [T, s] of Object.entries(scores)) {
        if (T === S || !s.oppLed) continue;
        if (s.score + 12 > facts.score) {
            const led = x.view.others.filter((p) => x.view.memory.playedCards.some((e) => e.isLead && e.position === p && e.suit === T));
            const who = led.length ? x.namesOr(led) : x.them();
            return `Not ${suitWord(T)}: ${who} led ${suitWord(T)} earlier, so they're likely short or strong there.`;
        }
    }
    if (facts.hasAce) return null; // the ace says it (L.suitAce)
    const offLengths = Object.values(scores).map((s) => s.length);
    // "shortest" needs a second side suit to compare with
    if (x.hasTrump() && offLengths.length >= 2 && facts.length === Math.min(...offLengths)) {
        return `${capital(suitWord(S))} is your shortest suit: once it's gone you can trump ${suitWord(S, 1)} leads.`;
    }
    return null;
}

/**
 * The reason for a rule play from its trace path: {code, text, extra}.
 * `extra` is a second sentence that did not fit (it goes to the details).
 */
function rulePlayReason(path, x) {
    const term = path[path.length - 1];
    if (!term || !R.TABLE[term.code]) return { code: 'P.generic', text: say('P.generic', null, x), extra: null };
    const termText = say(term.code, term.facts, x);
    const ctx = path.length > 1 ? path[path.length - 2] : null;
    let pre = null;
    let ctxCode = null;
    if (ctx && ctx.code === 'L.suit') {
        pre = suitChoiceText(ctx.facts, x);
        if (pre) ctxCode = 'L.suit';
    } else if (ctx && R.THROW_CONTEXT[ctx.code]) {
        pre = say(ctx.code, ctx.facts, x);
        ctxCode = ctx.code;
    }
    if (!pre) return { code: term.code, text: termText, extra: null, ctx: null };
    const both = `${pre} ${termText}`;
    if (x.wide(both).length <= C.REASON_MAX) return { code: term.code, text: both, extra: null, ctx: ctxCode };
    return { code: term.code, text: pre, extra: termText, ctx: ctxCode };
}

function ruleConfidence(code) {
    if (R.CERTAIN_CODES.has(code)) return 'certain';
    if (R.SURE_CODES.has(code)) return 'clear';
    return 'close';
}

// ------------------------------------------------------------ search

/**
 * Is this trick already decided for the seat? From the seat view alone: it
 * plays last (the other three cards are on the table) and every legal card
 * leaves the same pair winning it (tricks count per pair: overtaking the
 * partner, or not, gives the trick to the same side).
 */
function trickDecided(view) {
    if (view.stage !== 'play' || view.playedCards[view.position - 1]) return false;
    let onTable = 0;
    for (let p = 1; p <= 4; p++) if (view.playedCards[p - 1]) onTable++;
    if (onTable !== 3 || !view.legal.length) return false;
    let who = null;
    for (const c of view.legal) {
        const cards = view.playedCards.slice();
        cards[view.position - 1] = c;
        // The winner's pair: seats 1 and 3, or 2 and 4
        const w = (getCurrentWinner(cards, view.leadPosition, view.trump).position - 1) % 2;
        if (who === null) who = w;
        else if (w !== who) return false;
    }
    return true;
}

/**
 * The search part of a played card: {code, main, detail, confidence} or null.
 * `calm` (the search agrees with a rule card on a decided trick, or with a
 * sure rule code): a tight margin only means the cards come out about the
 * same later in the hand, so it is not worded or labelled as a close call
 * ('clear'). `decided` words it as the same later, the trick decided either
 * way.
 */
function searchReason(decision, view, x, { calm = false, decided = false } = {}) {
    const t = decision.trace;
    const s = t.search;
    if (!s || !s.cands) return null;
    const card = decision.card;
    const idx = (c) => s.cands.findIndex((k) => same(k, c));
    const k = idx(card);
    if (k < 0) return null;
    if (s.onlyWinner) {
        return { code: 'S.onlyWinner', main: `You play last, and only your ${cardText(card)} wins the trick.`, detail: null, confidence: 'certain' };
    }
    if (!(s.samples >= SEARCH.minSamples)) return null;

    const n = s.samples;
    const totals = s.totals;
    const min = Math.min(...totals), max = Math.max(...totals);
    const checked = `Checked over ${n} likely ways the hidden cards could be split.`;
    const ruleIs = same(card, t.ruleCard);
    if (max - min <= 1e-9) {
        if (s.cands.length < view.legal.length) {
            // Last to play: the search only looked at the cards that win the
            // trick, so "any card" would include the ones that give it up.
            // Ties keep the rule card, else the cheapest winner is played.
            return {
                code: 'S.anyWinner',
                main: `You play last, and every card that wins this trick does as well: the ${cardText(card)} is the cheapest.`,
                detail: `Any card that wins this trick does as well in all ${n} likely deals checked.`,
                // The rule code says how sure (F.lastLowestWin, F.ruffLast: certain)
                confidence: ruleIs ? null : 'certain'
            };
        }
        return {
            code: 'S.any',
            main: null,
            detail: totals.length > 1 ? `Every card you can play here does as well in all ${n} likely deals checked.` : checked,
            confidence: 'any'
        };
    }

    // The card compared against: the rule card when the search overrode it,
    // else the runner-up
    let o = -1;
    if (!ruleIs && s.ruleIdx >= 0) o = s.ruleIdx;
    else {
        for (let i = 0; i < totals.length; i++) if (i !== k && (o < 0 || totals[i] > totals[o])) o = i;
    }
    const X = cardText(card);
    const Y = cardText(s.cands[o]);
    const c = s.contract;
    const left = view.hand.length;
    const myLive = c.myBid > 0 && c.myTricks < c.myBid && c.myBid - c.myTricks <= left;
    const theirLive = c.oppBid > 0 && c.oppTricks < c.oppBid && c.oppBid - c.oppTricks <= left;
    const mk = s.makes[k] / n, mo = s.makes[o] / n;
    const sk = s.sets[k] / n, so = s.sets[o] / n;
    const dp = (totals[k] - totals[o]) / n;
    // The search picks by average points, so the played card can make (or
    // set) less often than the other one: quote a rate only where it is the
    // played card's that is higher, else the points (dp >= 0 always holds)
    let metric = 'points';
    if (myLive && mk > mo && pct5(mk) !== pct5(mo)) metric = 'make';
    else if (theirLive && sk > so && pct5(sk) !== pct5(so)) metric = 'set';

    // The margin as it is shown (whole points), so the label agrees with it
    const pts = Math.round(Math.abs(dp));
    let confidence = 'close';
    if (pts >= 3 || mk - mo >= 0.10 || sk - so >= 0.10) confidence = 'clear';
    const tight = dp < 1 && Math.abs(mk - mo) < 0.05 && Math.abs(sk - so) < 0.05;

    const us = x.us();
    const them = x.them();
    const by = pts === 0 ? null : `about ${pts} point${pts === 1 ? '' : 's'} a hand`;
    const split = `Checked over ${n} likely ways the hidden cards could be split`;
    let detail;
    if (metric === 'make') detail = `${split}: with the ${X} ${us} make your bid ${rate(mk)}; with the ${Y}, ${rate(mo)}.`;
    else if (metric === 'set') detail = `${split}: with the ${X} you set ${them} ${rate(sk)}; with the ${Y}, ${rate(so)}.`;
    else if (by) detail = `${split}: the ${X} comes out ${by} better than the ${Y} on average.`;
    else if (dp <= 1e-9) detail = `${split}: the ${X} and the ${Y} come out the same on average.`;
    else detail = `${split}: the ${X} and the ${Y} come out within a fraction of a point of each other on average.`;

    if (tight && ruleIs && calm) {
        // Not a close call (explainCard): the numbers alone, and on a decided
        // trick that it is decided either way
        if (!decided) return { code: 'S.close', main: null, detail, confidence: 'clear' };
        const base = `${split}: the ${X} and the ${Y} come out about the same later in the hand`;
        const end = ', and this trick is decided either way.';
        const nums = metric === 'make' ? ` (your bid makes about ${pct5(mk)}% vs ${pct5(mo)}%)`
            : metric === 'set' ? ` (you set ${them} about ${pct5(sk)}% vs ${pct5(so)}%)` : '';
        const variants = nums ? [`${base}${nums}${end}`, `${base}${end}`] : [`${base}${end}`];
        return { code: 'S.close', main: null, detail: x.fit(variants, C.DETAIL_MAX), confidence: 'clear' };
    }
    if (tight) {
        const a = metric === 'make' ? [mk, mo] : metric === 'set' ? [sk, so] : null;
        const nums = a ? ` (about ${pct5(a[0])}% vs ${pct5(a[1])}%)` : '';
        const close = `Close call: the ${X} and the ${Y} do about equally well${nums}.`;
        return { code: 'S.close', main: ruleIs ? null : close, detail: ruleIs ? `${close} ${detail}` : detail, confidence: 'close' };
    }
    if (ruleIs) return { code: metric === 'set' ? 'S.setThem' : 'S.agrees', main: null, detail, confidence };

    // The search overrode the rule card (or the rule card was not a candidate)
    const R0 = cardText(t.ruleCard);
    const verb = verbFor(view, t.ruleCard).toLowerCase();
    let main;
    if (s.ruleIdx < 0) {
        main = metric === 'make'
            ? [`Of the cards that win this trick, the ${X} does best: ${us} make your bid ${rate(mk)}, against ${rate(mo)} with the ${Y}.`,
                `Of the cards that win this trick, the ${X} does best: your bid makes ${rateShort(mk)}, against ${rateShort(mo)}.`]
            : `Of the cards that win this trick, the ${X} does best here.`;
    } else if (metric === 'make') {
        main = [
            `Usually you'd ${verb} the ${R0} here, but the ${X} does better: ${us} make your bid ${rate(mk)} with it, against ${rate(mo)}.`,
            `Usually you'd ${verb} the ${R0}, but the ${X} does better here: your bid makes ${rateShort(mk)}, against ${rateShort(mo)}.`
        ];
    } else if (metric === 'set') {
        main = [
            `Usually you'd ${verb} the ${R0} here, but the ${X} does better: you set ${them} ${rate(sk)} with it, against ${rate(so)}.`,
            `Usually you'd ${verb} the ${R0}, but the ${X} sets ${them} ${rateShort(sk)} here, against ${rateShort(so)}.`,
            `Usually you'd ${verb} the ${R0}, but the ${X} sets them more often here (about ${pct5(sk)}% vs ${pct5(so)}%).`
        ];
    } else {
        main = by
            ? `Usually you'd ${verb} the ${R0}, but here the ${X} comes out ${by} better on average.`
            : `Usually you'd ${verb} the ${R0}, but here the ${X} comes out slightly better on average (by less than a point a hand).`;
    }
    return { code: s.ruleIdx < 0 ? 'S.best' : 'S.overrides', main: x.fit(main, C.REASON_MAX), detail: s.ruleIdx < 0 ? detail : checked, confidence };
}

// ------------------------------------------------------------ plays

/** Rule codes whose card is played to win the trick (or to cash a winner). */
const WIN_CODE = /^(F\.(overtake|erraticOvertake|flashyWin|win|lastLowestWin|ruff|flashyRuff)|L\.(max|hiJoker|bossTrump|cashBoss|suitAce|suitKing))/;

/**
 * Does the suggested play spend a strong card? The rule card: when its code
 * plays to win. A search override: when it is a trump or a J or higher.
 */
function spendsStrong(card, rule, ruleIs, x) {
    if (rule) return WIN_CODE.test(rule.code);
    if (ruleIs) return false;
    return x.trumpCard(card) || RANK[card.rank] >= RANK.J;
}

function explainCard(decision, view, mode, glossed) {
    const card = decision.card;
    const x = makeContext(view, card);
    const headline = cardHeadline(view, card);
    const suggest = { card: { suit: card.suit, rank: card.rank } };

    if (decision.forced) {
        return finish({ headline, reasons: [forcedText(view, card, x)], details: [], confidence: 'only', suggest, codes: ['P.forced'], partnerName: cleanName(view.names[view.partner]) }, mode, glossed);
    }

    const t = decision.trace;
    const codes = [];
    const reasons = [];
    const details = [];
    const ruleIs = same(card, t.ruleCard);
    const rule = ruleIs ? rulePlayReason(t.path || [], x) : null;
    // The rule card on a decided trick (or a sure rule code) is never a close
    // call: a tight search margin there means the choice matters little later
    // in the hand, not that it is hard (owner play-test 2026-11-19)
    const decided = !!rule && trickDecided(view);
    const calm = !!rule && (decided || R.SURE_CODES.has(rule.code) || R.CERTAIN_CODES.has(rule.code));
    const sr = decision.source === 'quick' ? null : searchReason(decision, view, x, { calm, decided });
    let confidence;

    const cl = contractLine(view, t.contract);
    if (cl) {
        // "save strong cards" must not open a play that spends one
        cl.facts.spends = spendsStrong(card, rule, ruleIs, x);
        codes.push(cl.code);
        reasons.push(say(cl.code, cl.facts, x));
    }

    if (sr && !ruleIs) {
        // The search chose a card the rules would not: say so with its numbers
        codes.push(sr.code);
        reasons.push(sr.main);
        if (sr.detail) details.push(sr.detail);
        confidence = sr.confidence;
    } else if (!rule) {
        // Not the rule card and no search numbers to say why (never seen in
        // the sim corpus; kept so an unexpected trace still gets an answer)
        codes.push('P.generic');
        reasons.push(say('P.generic', null, x));
        confidence = 'close';
    } else {
        if (rule.ctx) codes.push(rule.ctx);
        codes.push(rule.code);
        reasons.push(rule.text);
        if (rule.extra) details.push(rule.extra);
        if (sr) {
            // The search checked the rule card: its numbers set the confidence
            codes.push(sr.code);
            if (sr.detail) details.push(sr.detail);
            confidence = sr.confidence || ruleConfidence(rule.code);
        } else {
            confidence = ruleConfidence(rule.code);
        }
        // A decided trick (or a sure rule code) is never a close call, with or
        // without the search (a hand over SEARCH.maxCards has none)
        if (calm && confidence === 'close') confidence = 'clear';
    }
    if (decision.source === 'quick') {
        confidence = 'quick';
        codes.push('P.quick');
    }
    return finish({ headline, reasons, details, confidence, suggest, codes, partnerName: cleanName(view.names[view.partner]) }, mode, glossed);
}

// ------------------------------------------------------------ bids

function oppBidStats(view) {
    let sum = 0, count = 0;
    for (const p of view.others) {
        const b = view.playerBids[p - 1];
        if (b == null) continue;
        count++;
        if (!BORES.includes(String(b))) sum += rules.BID_RANKS[b] || 0;
    }
    return { sum, count };
}

/** Remove-one attribution: what each card adds to the trick estimate. */
function bidParts(view) {
    const { sum, count } = oppBidStats(view);
    const n = view.handSize;
    const all = estimateOwnTricks(view.hand, view.trump, n, sum, count);
    const parts = view.hand.map((c, i) => ({
        card: c,
        v: all - estimateOwnTricks(view.hand.filter((_, j) => j !== i), view.trump, n, sum, count)
    }));
    return parts.filter((p) => p.v >= 0.15).sort((a, b) => b.v - a.v).slice(0, 3);
}

/** The top trump run from the HI joker (countLockedWinners' cards). */
function lockedCards(view) {
    const trump = view.trump;
    const order = [{ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }];
    if (trump.suit !== 'joker') for (const r of SUIT_RANKS) order.push({ suit: trump.suit, rank: r });
    const out = [];
    for (const c of order) {
        if (same(c, trump)) continue;
        if (view.hand.some((h) => same(h, c))) out.push(c);
        else break;
    }
    return out;
}

function jokerWords(cards) {
    const hi = cards.some((c) => c.rank === 'HI'), lo = cards.some((c) => c.rank === 'LO');
    const rest = cards.filter((c) => c.suit !== 'joker').map(cardText);
    const j = hi && lo ? ['HI and LO jokers'] : hi ? ['HI joker'] : lo ? ['LO joker'] : [];
    return listText([...j, ...rest]);
}

function explainBid(decision, view, mode, glossed) {
    const tb = decision.trace.bid || {};
    const bid = decision.bid;
    const x = makeContext(view, null);
    const n = view.handSize;
    const headline = C.bidHeadline(bid);
    const suggest = { bid };
    const reasons = [];
    const details = [];
    const codes = [];
    let confidence = 'clear';
    const partnerBidRaw = view.playerBids[view.partner - 1];
    const p = x.partnerName;
    const trumpCount = view.hand.filter((c) => x.trumpCard(c)).length;
    const stakes = bid === 'B' ? 'A bore pays double.' : `${bid} doubles the stakes again.`;

    const noBore = () => {
        // Only when the rounded rates differ ("60%, just under 60%" reads wrong)
        if (tb.sweepP != null && tb.sweepP < tb.sweepThreshold && tb.sweepP >= tb.sweepThreshold - 0.15 &&
            pct5(tb.sweepP) < pct5(tb.sweepThreshold)) {
            codes.push('B.noBore');
            details.push(`Not a bore: ${x.us()} would win every trick ${rate(tb.sweepP)}, just under what a bore needs (about ${pct5(tb.sweepThreshold)}%).`);
        }
    };

    switch (tb.path) {
        case 'bore:lock':
            codes.push('B.lock');
            reasons.push(n === 1
                ? `Your only card, the ${cardText(view.hand[0])}, can't be beaten, so ${x.us()} win the trick whatever happens. ${stakes}`
                : `Every card you hold is a top trump, so ${x.us()} win every trick whatever happens. ${stakes}`);
            confidence = 'certain';
            break;
        case 'bore:sweep': {
            codes.push('B.sweep');
            const th = tb.sweepThreshold;
            reasons.push(`With ${n === 1 ? 'this one card' : `these ${n} cards`} ${x.us()} should win every trick ${rate(tb.sweepP)}. A bore is worth it above about ${pct5(th)}%.`);
            if (th > 0.6) details.push(`${x.them()} have bid a number already, so a bore needs to be close to certain.`);
            confidence = tb.sweepP - th >= 0.1 ? 'clear' : 'close';
            break;
        }
        case 'bore:escalate': {
            codes.push('B.escalate');
            const pb = String(partnerBidRaw);
            const lead = `${p()} bid ${pb}`;
            if (tb.escalate === 'oneCard') reasons.push(`${lead}, and on a one-card hand a bore almost always makes. ${stakes}`);
            else if (tb.escalate === 'oneCardTop') reasons.push(`${lead}, and your ${cardText(view.hand[0])} can't lose. ${stakes}`);
            else if (tb.escalate === 'trumps') reasons.push(`${lead}, and your ${trumpCount} trumps make winning every trick very likely. ${stakes}`);
            else if (tb.escalate === 'sideAce') {
                const ace = view.hand.find((c) => c.rank === 'A' && !x.trumpCard(c));
                reasons.push(`${lead}, and your ${cardText(ace)} is a sure trick once ${x.us()} have the lead. ${stakes}`);
            } else reasons.push(`${lead}. ${stakes}`);
            break;
        }
        case 'bore:big':
            codes.push('B.big');
            reasons.push(`Both jokers and ${trumpCount} trumps on a ${n}-card hand: ${x.us()} should win every trick. ${stakes}`);
            break;
        case 'ev':
            confidence = explainEvBid(tb, bid, view, x, reasons, details, codes);
            noBore();
            break;
        case 'rule':
            confidence = explainRuleBid(tb, bid, view, x, reasons, details, codes);
            noBore();
            break;
        default:
            codes.push('P.generic');
            reasons.push('This is the bid our strongest bot would make here.');
            confidence = 'close';
    }
    return finish({ headline, reasons, details, confidence, suggest, codes, partnerName: cleanName(view.names[view.partner]) }, mode, glossed);
}

function explainEvBid(tb, bid, view, x, reasons, details, codes) {
    const n = view.handSize;
    const final = Number(bid);
    const evs = tb.evs;
    const p = x.partnerName;
    const partnerBid = tb.partnerBid; // null: partner bids after us
    // Runner-up by EV
    let ru = -1;
    for (let b = 0; b < evs.length; b++) if (b !== final && (ru < 0 || evs[b] > evs[ru])) ru = b;
    const gap = evs[final] - evs[ru];

    const parts = bidParts(view);
    const strength = parts.length
        // One card wins at most one trick: what it adds to the estimate can be
        // more (a joker also guards the other trumps), but is shown as 1
        ? `Your hand should win ${tricksText(tb.ownMean)} tricks: ${parts.map((q) => `${cardText(q.card)} (${tricksText(Math.min(1, q.v))})`).join(', ')}.`
        : `Your hand should win ${tricksText(tb.ownMean)} tricks.`;

    let confidence = gap >= 2 ? 'clear' : 'close';
    let main = null;
    if (tb.floored) {
        const locked = lockedCards(view);
        codes.push('B.floor');
        main = `Your ${jokerWords(locked)} ${locked.length === 1 ? 'is a sure trick' : 'are sure tricks'}, so bid at least ${final}.`;
        confidence = 'clear';
    } else if (tb.capped) {
        codes.push('B.cap');
        main = `With ${x.partnerPoss()} ${partnerBid} on a ${n}-card hand, ${x.us()} can't bid more than ${n} together.`;
        confidence = 'clear';
    } else if (tb.zeroRedeals && final >= 1) {
        codes.push('B.zeroRedeal');
        main = 'Everyone else bid 0. If you bid 0 too, the hand is redealt.';
    }

    const evLine = (b) => `bid ${b} ${pointsText(evs[b])}`;
    // The floor raised the bid over one the averages score higher: quoting
    // those numbers as the case for it would argue against it, so say why
    // the floor wins instead (the fitted per-card values undercount locks)
    let top = 0;
    for (let b = 1; b < evs.length; b++) if (evs[b] > evs[top]) top = b;
    const floorOverEv = tb.floored && top !== final && Math.round(evs[top]) > Math.round(evs[final]);
    const floorLine = `The averages lean to bid ${top} (${pointsText(evs[top])} against ${pointsText(evs[final])}), but they undercount cards that can't lose: never bid below your sure tricks.`;
    if (partnerBid !== null) {
        const sd = view.trump.suit === 'joker' ? TEAM_SD_NO_TRUMP[n] : TEAM_SD[n].second;
        const pmf = teamTrickDistribution(tb.ownMean + partnerBid + tb.partnerOver, sd, n);
        const makeP = (b) => {
            const comb = Math.min(b + partnerBid, n);
            let pr = 0;
            for (let t = comb; t <= n; t++) pr += pmf[t];
            return { comb, pr };
        };
        const m = makeP(final);
        codes.push(final === 0 && tb.best === 0 ? 'B.zero' : 'B.ev');
        const pLine = m.comb === 0
            ? `${p()} bid ${partnerBid}, and a combined 0 can't be set: each trick is worth 1 point.`
            : [
                `${p()} bid ${partnerBid}. Bid ${final} makes your combined ${m.comb} ${rate(m.pr)}, worth ${pointsText(evs[final])}; bid ${ru} is worth ${pointsText(evs[ru])}.`,
                `${p()} bid ${partnerBid}. Bid ${final} makes your combined ${m.comb} ${rateShort(m.pr)}, worth ${pointsText(evs[final])}; bid ${ru}, ${pointsText(evs[ru])}.`,
                `${p()} bid ${partnerBid}: bid ${final} makes your combined ${m.comb} ${rateShort(m.pr)}, worth ${pointsText(evs[final])}.`
            ];
        if (main) reasons.push(main, strength);
        else reasons.push(strength, x.fit(pLine, C.REASON_MAX));
        if (floorOverEv) {
            if (m.comb > 0) details.push(`${p()} bid ${partnerBid}. Bid ${final} makes your combined ${m.comb} ${rate(m.pr)}.`);
        } else if (main) details.push(x.fit(pLine, C.DETAIL_MAX));
        if (tb.partnerOver >= 0.05) details.push(`Partners usually take a little more than they bid (${tricksText(tb.partnerOver)} tricks on average).`);
    } else {
        codes.push(final === 0 && tb.best === 0 ? 'B.zero' : 'B.evFirst');
        const first = `${p()} bids after you and adds their own tricks. Bid ${final} is worth ${pointsText(evs[final])} on average, ${evLine(ru)}.`;
        if (final === 0 && tb.best === 0) {
            reasons.push(main || `You should win ${tricksText(tb.ownMean)} tricks. Any bid risks −10 a trick for little gain.`, x.fit(first, C.REASON_MAX));
        } else if (main) {
            reasons.push(main, strength);
            if (!floorOverEv) details.push(first);
        } else {
            reasons.push(strength, x.fit(first, C.REASON_MAX));
        }
    }
    // The curve, best first
    const order = evs.map((v, b) => b).sort((a, b) => evs[b] - evs[a]).slice(0, 3);
    details.push(floorOverEv ? floorLine : `On average: ${order.map(evLine).join(', ')}.`);
    if (tb.riskAdjustment && tb.picked !== tb.best) {
        // The score moved the pick: that is the main reason now
        codes.push('B.risk');
        const d = Math.abs(view.score.mine - view.score.theirs);
        const risk = tb.riskAdjustment > 0
            ? `You're ${d} behind late in the game, so take the bolder of two close bids.`
            : `You're ${d} ahead late in the game, so take the safer of two close bids.`;
        if (reasons.length >= 2) details.unshift(reasons.pop());
        reasons.push(risk);
        confidence = 'close';
    }
    if (!tb.floored && !tb.capped && Math.abs(gap) < 1) {
        codes.push('B.close');
        details.unshift(`Close call: ${final} and ${ru} are worth about the same.`);
        confidence = 'close';
    }
    return confidence;
}

function explainRuleBid(tb, bid, view, x, reasons, details, codes) {
    const n = view.handSize;
    const tags = tb.rule || [];
    const p = x.partnerName;
    const partnerBidRaw = view.playerBids[view.partner - 1];
    const card = view.hand[0];
    const texts = [];
    let confidence = 'clear';
    const add = (code, text) => { codes.push(code); texts.push(text); };

    if (tags.includes('oppBored')) {
        add('B.oppBored', Number(bid) >= 1
            ? `${x.borer()} bored. One trick sets the bore, and your hand should take one: bid 1.`
            : `${x.borer()} bored. Your job is to win one trick and set the bore, not to score a bid.`);
    }
    if (tags.includes('partnerCap')) {
        if (BORES.includes(String(partnerBidRaw))) add('B.cap', `${p()} bid ${partnerBidRaw}, so ${x.us()} already bid every trick.`);
        else add('B.cap', `With ${x.partnerPoss()} ${partnerBidRaw} on a ${n}-card hand, ${x.us()} can't bid more than ${n} together.`);
    }
    if (tags.includes('partnerBig')) add('B.rule.partnerBig', `${p()} bid ${partnerBidRaw} of ${n}, so leave room: bid at most ${bid}.`);
    if (tags.includes('oppHeavy')) add('B.rule.oppHeavy', `${x.them()} bid ${tb.oppBidTotal} of ${n} tricks between them, so bid one less than your cards suggest.`);
    if (tags.includes('oneCard.top')) {
        let t;
        if (card.rank === 'HI') { t = 'One card each, and the HI joker always wins.'; confidence = 'certain'; }
        else if (card.rank === 'LO' && view.trump.rank === 'HI') { t = 'One card each, and with the HI joker turned up your LO joker can\'t lose.'; confidence = 'certain'; }
        else if (card.rank === 'LO') t = 'One card each, and only one card in the deck beats the LO joker.';
        else t = `One card each, and only the two jokers beat your ${cardText(card)}.`;
        add('B.oneCard.top', t);
    }
    if (tags.includes('oneCard.noTrumpHigh')) add('B.oneCard.noTrumpHigh', `No trump suit this hand, so your ${cardText(card)} can only lose to a joker or a higher ${suitWord(card.suit, 1)}.`);
    if (tags.includes('oneCard.highTrump')) add('B.oneCard.highTrump', `A high trump like your ${cardText(card)} usually wins a one-card hand.`);
    if (tags.includes('oneCard.low')) {
        add('B.oneCard.low', x.trumpCard(card)
            ? `Any higher trump or a joker beats your ${cardText(card)}: too risky to bid.`
            : `${x.noTrump ? 'A joker' : 'Any trump'} or a higher ${suitWord(card.suit, 1)} beats your ${cardText(card)}: too risky to bid.`);
    }
    if (tags.includes('twoCard')) {
        const w = tb.winners || 0;
        const likely = view.hand.filter((c) => c.rank === 'HI' || c.rank === 'LO' ||
            (x.noTrump ? c.rank === 'A' : x.trumpCard(c) && RANK[c.rank] >= RANK.Q));
        if (likely.length) add('B.rule.twoCard', `On a two-card hand count your likely winners: your ${listText(likely.map(cardText))}.`);
        else if (w === 1) add('B.rule.twoCard', 'Two trumps: the higher one usually takes a trick.');
        else add('B.rule.twoCard', 'Two cards and neither is a likely winner.');
    }
    if (tags.includes('smallCap')) {
        const tc = trumpCount(view, x);
        add('B.rule.smallCap', `On a small hand trump decides it: ${tc} trump${tc === 1 ? ' supports' : 's support'} about ${tb.trumpBidCap} trick${tb.trumpBidCap === 1 ? '' : 's'}.`);
    }
    if (tags.includes('late')) {
        const d = Math.abs(view.score.mine - view.score.theirs);
        add('B.rule.late', tb.riskAdjustment > 0
            ? `You're ${d} behind late in the game, so bid one more.`
            : `You're ${d} ahead late in the game, so bid one less.`);
    }
    if (texts.length === 0) {
        codes.push('B.rule');
        texts.push(`Your cards are worth ${tricksText(tb.points || 0)} tricks.`);
        confidence = 'close';
    }
    reasons.push(...texts.slice(0, 2));
    details.push(...texts.slice(2));
    return confidence;
}

function trumpCount(view, x) {
    return view.hand.filter((c) => x.trumpCard(c)).length;
}

// ------------------------------------------------------------ public

/**
 * @param {Object} decision - advise()
 * @param {Object} view - the seatView() advise was given
 * @param {Object} [o]
 * @param {'help'|'tutorial'} [o.mode] - tutorial adds `gloss`
 * @param {string[]} [o.glossed] - glossary terms already shown this game
 * @returns {Object} Explanation {headline, reasons, details, confidence,
 *   suggest, codes, gloss?} (frozen)
 */
function explain(decision, view, { mode = 'help', glossed = [] } = {}) {
    if (decision.kind === 'bid') return explainBid(decision, view, mode, glossed);
    return explainCard(decision, view, mode, glossed);
}

/**
 * P.status: the line for a seat that asks off its turn (not counted).
 * "Not your turn yet: Carol is bidding. You and Bob bid 4 and have 1 trick so far."
 */
function status(view) {
    const x = makeContext(view, null);
    const who = x.nameOf(view.currentTurn);
    const first = `Not your turn yet: ${who} is ${view.stage === 'bid' ? 'bidding' : 'playing'}.`;
    let second = '';
    if (view.stage === 'play' && view.playContext && view.playContext.bids) {
        const team1 = view.position % 2 === 1;
        const myBid = team1 ? view.playContext.bids.team1 : view.playContext.bids.team2;
        const mine = team1 ? view.playContext.tricks.team1 : view.playContext.tricks.team2;
        second = ` ${capital(x.us())} bid ${myBid} and have ${C.tricksCount(mine)} so far.`;
    } else if (view.stage === 'bid' && view.playerBids[view.partner - 1] != null) {
        second = ` ${x.partnerName()} bid ${view.playerBids[view.partner - 1]}.`;
    }
    return clip(spellNames([`${first}${second}`], cleanName(view.names[view.partner]))[0], C.LINE_MAX);
}

module.exports = { explain, status, contractLine, bidParts, verbFor, WIN_CODE, trickDecided };
