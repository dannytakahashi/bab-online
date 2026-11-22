#!/usr/bin/env node
/**
 * HSI scoring harness (server/game/hsi.js; owner 2026-11-21). Scores a Hand
 * Strength Index against how many tricks dealt hands actually took in bot
 * self-play records:
 *
 *   node server/game/bot/sim/simulate.js --exp baseline --games 2000 --seed 912 --records /tmp/hsi-test.jsonl
 *   node server/game/bot/sim/hsiEval.js server/game/hsi.js /tmp/hsi-test.jsonl --vs <old formula module>
 *
 * (A candidate module may export hsi / calculateHSI / default or be the
 * function itself.) The shipped formula was fitted on seed 911 (4,000 games)
 * and measured on seed 912 (2,000 games): Spearman average 0.7144 (the old
 * points count 0.6398), pooled mean 130.0, sd 48.8, 0 monotonicity decreases.
 * Refit when bot play changes a lot: fit card values to own tricks / hand size
 * on fresh records (non-negative least squares with the rank ladders as
 * cumulative non-negative steps keeps it monotone), re-centre BASE so every
 * hand size averages 130, and check it here on records from another seed.
 *
 * A candidate is a CommonJS module exporting hsi(hand, trump) (either
 * `module.exports = fn`, `module.exports.hsi = fn` or `.default`).
 *
 * CLI:
 *   node harness.js <candidate.js> [test|train|path.jsonl] [--mono N] [--seed S] [--json out.json] [--vs other.js] [--boot B] [--quiet]
 *
 *   data      defaults to "test"; "test" / "train" are the two fixed files
 *             next to this folder (../test.jsonl, ../train.jsonl)
 *   --mono N  hands for the monotonicity check (default 3000; 0 skips it)
 *   --seed S  seed for the monotonicity hands (default 20261121)
 *   --json F  also write the full result object as JSON to F
 *   --vs M    paired bootstrap of the candidate against module M (e.g. old.js):
 *             difference in the primary metric with a 95% interval (--boot B
 *             resamples of whole deals, default 300)
 *
 * Module:
 *   const H = require('./harness');
 *   const records = await H.load(H.TEST);
 *   const result  = H.evaluate(records, hsiFn);      // metrics + distribution
 *   const mono    = H.monotonicity(hsiFn, { n, seed });
 *   const safety  = H.safety(hsiFn);                 // synthetic edge hands
 *   const cmp     = H.compare(records, hsiA, hsiB);  // paired bootstrap, A minus B
 *   console.log(H.format(result), H.formatMono(mono), H.formatSafety(safety));
 *
 * Metrics (requirement 4 of the brief):
 *   - Spearman rank correlation (average ranks for ties) between HSI and own
 *     tricks WITHIN each hand size; summary = plain average over the 13 sizes
 *   - pooled Pearson r of HSI with own tricks / handSize and team tricks / handSize
 *   - pooled distribution: mean, sd, p5/p10/p25/p50/p75/p90/p95; mean (and sd)
 *     by hand size; share of hands in the red (<= 70) and green (>= 195) bands
 *   - crash / non-finite check on every record
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Default record files (give a path on the command line in the repo)
const TEST = process.env.HSI_TEST_RECORDS || path.join(require('os').tmpdir(), 'hsi-test.jsonl');
const TRAIN = process.env.HSI_TRAIN_RECORDS || path.join(require('os').tmpdir(), 'hsi-train.jsonl');

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const HAND_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const WEAK = 70;      // red band edge (web hue 0, iOS HSIScale.weak)
const STRONG = 195;   // green band edge (weak + span 125)

// ---------------------------------------------------------------- loading

/** Stream a JSONL file into an array of records. */
async function load(file) {
    const records = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line) continue;
        records.push(JSON.parse(line));
    }
    return records;
}

function resolveData(name) {
    if (!name || name === 'test') return TEST;
    if (name === 'train') return TRAIN;
    return path.resolve(name);
}

function loadCandidate(modulePath) {
    const m = require(path.resolve(modulePath));
    if (m && typeof m.calculateHSI === 'function') return m.calculateHSI;
    const fn = typeof m === 'function' ? m : (m.hsi || m.default || m.calculateHSI);
    if (typeof fn !== 'function') throw new Error(`${modulePath} does not export hsi(hand, trump)`);
    return fn;
}

// ---------------------------------------------------------------- statistics

function mean(a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return a.length ? s / a.length : NaN;
}

function sd(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / a.length); // population sd
}

function pearson(x, y) {
    const n = x.length;
    if (n < 2) return NaN;
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - mx, dy = y[i] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/** 1-based average ranks (ties share the mean rank). */
function ranks(a) {
    const n = a.length;
    const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i] - a[j]);
    const r = new Float64Array(n);
    let i = 0;
    while (i < n) {
        let j = i;
        while (j + 1 < n && a[idx[j + 1]] === a[idx[i]]) j++;
        const avg = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) r[idx[k]] = avg;
        i = j + 1;
    }
    return r;
}

function spearman(x, y) {
    return pearson(ranks(x), ranks(y));
}

/** Linear-interpolated percentile of an ascending-sorted array (p in 0..100). */
function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const pos = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function distribution(values) {
    const sorted = Float64Array.from(values).sort();
    const d = { n: values.length, mean: mean(values), sd: sd(values), min: sorted[0], max: sorted[sorted.length - 1] };
    for (const p of [5, 10, 25, 50, 75, 90, 95]) d['p' + p] = percentile(sorted, p);
    let weak = 0, strong = 0;
    for (const v of values) { if (v <= WEAK) weak++; if (v >= STRONG) strong++; }
    d.shareWeak = weak / values.length;      // <= 70 (full red)
    d.shareStrong = strong / values.length;  // >= 195 (full green)
    return d;
}

// ---------------------------------------------------------------- evaluation

/**
 * Score a candidate on records.
 * @returns {object} { n, errors, nonFinite, errorExamples, bySize: {hs: {...}},
 *   spearmanAvg, pearsonOwn, pearsonTeam, dist, split: {trump, noTrump} }
 */
function evaluate(records, hsiFn) {
    const n = records.length;
    const h = new Float64Array(n);
    const ok = new Uint8Array(n);
    let errors = 0, nonFinite = 0, sizeMismatch = 0;
    const errorExamples = [];
    for (let i = 0; i < n; i++) {
        const r = records[i];
        if (r.hand.length !== r.hs) sizeMismatch++;
        let v;
        try {
            v = hsiFn(r.hand, r.trump);
        } catch (e) {
            errors++;
            if (errorExamples.length < 5) errorExamples.push({ index: i, error: String(e && e.message || e), hand: r.hand, trump: r.trump });
            continue;
        }
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            nonFinite++;
            if (errorExamples.length < 5) errorExamples.push({ index: i, value: String(v), hand: r.hand, trump: r.trump });
            continue;
        }
        h[i] = v; ok[i] = 1;
    }

    const groups = new Map(); // hs -> {h:[], t:[]}
    const allH = [], ownRate = [], teamRate = [];
    const splitH = { trump: [], noTrump: [] }, splitOwn = { trump: [], noTrump: [] };
    for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        const r = records[i];
        let g = groups.get(r.hs);
        if (!g) { g = { h: [], t: [], tt: [] }; groups.set(r.hs, g); }
        g.h.push(h[i]); g.t.push(r.tricks); g.tt.push(r.tt);
        allH.push(h[i]); ownRate.push(r.tricks / r.hs); teamRate.push(r.tt / r.hs);
        const k = r.trump.suit === 'joker' ? 'noTrump' : 'trump';
        splitH[k].push(h[i]); splitOwn[k].push(r.tricks / r.hs);
    }

    const bySize = {};
    let sum = 0, count = 0;
    for (const hs of [...groups.keys()].sort((a, b) => a - b)) {
        const g = groups.get(hs);
        const d = distribution(g.h);
        const s = spearman(g.h, g.t);
        bySize[hs] = {
            n: g.h.length,
            spearman: s,
            pearson: pearson(g.h, g.t),
            spearmanTeam: spearman(g.h, g.tt),
            mean: d.mean, sd: d.sd, p10: d.p10, p50: d.p50, p90: d.p90,
            shareWeak: d.shareWeak, shareStrong: d.shareStrong,
            meanTricks: mean(g.t)
        };
        if (Number.isFinite(s)) { sum += s; count++; }
    }

    const split = {};
    for (const k of ['trump', 'noTrump']) {
        if (!splitH[k].length) { split[k] = { n: 0 }; continue; }
        // per-size Spearman inside this kind of deal only
        const per = new Map();
        for (let i = 0; i < n; i++) {
            if (!ok[i]) continue;
            const r = records[i];
            if ((r.trump.suit === 'joker' ? 'noTrump' : 'trump') !== k) continue;
            let g = per.get(r.hs);
            if (!g) { g = { h: [], t: [] }; per.set(r.hs, g); }
            g.h.push(h[i]); g.t.push(r.tricks);
        }
        let ss = 0, sc = 0;
        for (const g of per.values()) { const v = spearman(g.h, g.t); if (Number.isFinite(v)) { ss += v; sc++; } }
        const dd = distribution(splitH[k]);
        split[k] = {
            n: splitH[k].length, mean: dd.mean, sd: dd.sd, shareWeak: dd.shareWeak, shareStrong: dd.shareStrong,
            meanOwnRate: mean(splitOwn[k]), pearsonOwn: pearson(splitH[k], splitOwn[k]),
            spearmanAvg: sc ? ss / sc : NaN
        };
    }

    return {
        n, scored: allH.length, errors, nonFinite, sizeMismatch, errorExamples,
        bySize,
        spearmanAvg: count ? sum / count : NaN,
        sizesAveraged: count,
        pearsonOwn: pearson(allH, ownRate),
        pearsonTeam: pearson(allH, teamRate),
        dist: distribution(allH),
        split
    };
}

// ---------------------------------------------------------------- comparison

/**
 * Paired bootstrap of candidate A against candidate B on the same records:
 * difference in the primary metric (Spearman averaged over hand sizes) with a
 * 95% interval. Deals are resampled whole (the 4 seats of a deal are
 * consecutive records and are not independent), separately per hand size.
 */
function compare(records, fnA, fnB, opts = {}) {
    const boot = opts.boot == null ? 300 : opts.boot;
    const rand = rng(opts.seed == null ? 4242 : opts.seed);
    const per = new Map(); // hs -> { a, b, t, deals: [[start, end)] }
    let prev = null;
    for (const r of records) {
        let g = per.get(r.hs);
        if (!g) { g = { a: [], b: [], t: [], deals: [] }; per.set(r.hs, g); }
        const sameDeal = prev && prev.hs === r.hs && r.pos > prev.pos && prev.trump.suit === r.trump.suit && prev.trump.rank === r.trump.rank;
        if (sameDeal) g.deals[g.deals.length - 1][1]++;
        else g.deals.push([g.a.length, g.a.length + 1]);
        g.a.push(fnA(r.hand, r.trump)); g.b.push(fnB(r.hand, r.trump)); g.t.push(r.tricks);
        prev = r;
    }
    const sizes = [...per.keys()].sort((x, y) => x - y);
    const point = {};
    let pa = 0, pb = 0;
    for (const hs of sizes) {
        const g = per.get(hs);
        const a = spearman(g.a, g.t), b = spearman(g.b, g.t);
        point[hs] = { a, b, diff: a - b };
        pa += a; pb += b;
    }
    const diffs = [];
    const sizeDiffs = Object.fromEntries(sizes.map(hs => [hs, []]));
    for (let k = 0; k < boot; k++) {
        let da = 0, db = 0;
        for (const hs of sizes) {
            const g = per.get(hs);
            const a = [], b = [], t = [];
            for (let d = 0; d < g.deals.length; d++) {
                const [s0, s1] = g.deals[Math.floor(rand() * g.deals.length)];
                for (let i = s0; i < s1; i++) { a.push(g.a[i]); b.push(g.b[i]); t.push(g.t[i]); }
            }
            const tr = ranks(t);
            const sa = pearson(ranks(a), tr), sb = pearson(ranks(b), tr);
            da += sa; db += sb;
            sizeDiffs[hs].push(sa - sb);
        }
        diffs.push((da - db) / sizes.length);
    }
    const ci = (arr) => { const s = Float64Array.from(arr).sort(); return [percentile(s, 2.5), percentile(s, 97.5)]; };
    for (const hs of sizes) point[hs].ci = ci(sizeDiffs[hs]);
    return { avgA: pa / sizes.length, avgB: pb / sizes.length, diff: (pa - pb) / sizes.length, ci: ci(diffs), boot, bySize: point };
}

function formatCompare(c, nameA, nameB) {
    const L = [`Paired comparison ${nameA} minus ${nameB} (Spearman avg over sizes): ${f4(c.avgA)} - ${f4(c.avgB)} = ${c.diff >= 0 ? '+' : ''}${f4(c.diff)}  95% bootstrap interval [${f4(c.ci[0])}, ${f4(c.ci[1])}] (${c.boot} resamples of whole deals)`];
    L.push('  by size: ' + Object.keys(c.bySize).map(Number).sort((a, b) => a - b).map(hs => `${hs}:${c.bySize[hs].diff >= 0 ? '+' : ''}${f3(c.bySize[hs].diff)}${c.bySize[hs].ci[0] > 0 ? '*' : c.bySize[hs].ci[1] < 0 ? '!' : ''}`).join('  ') + '   (* better, ! worse: interval excludes 0)');
    return L.join('\n');
}

// ---------------------------------------------------------------- monotonicity

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function fullDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
    deck.push({ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' });
    return deck;
}

const key = (c) => c.suit + ':' + c.rank;

/** A random legal deal: the turned trump card is out of play, the hand comes from the other 53. */
function randomDeal(rand, handSize) {
    const deck = fullDeck();
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return { trump: deck[0], hand: deck.slice(1, 1 + handSize) };
}

/**
 * Monotonicity check on N seeded random hands (hand sizes 1..13 in rotation).
 * For every card of every hand:
 *   higher   : replace it with each higher card of the same suit that is not
 *              in the hand and is not the turned trump card (LO joker -> HI
 *              joker included)
 *   toTrump  : replace a side-suit card with the trump-suit card of the same
 *              rank (trump deals only; skipped when that card is held or turned)
 *   toJoker  : replace a trump-suit card with a joker not in the hand / not
 *              turned (a joker outranks every trump-suit card)
 * A "decrease" is hsi(new) < hsi(old) - eps. These three make up `decreases`.
 *
 * Informational only (not in `decreases`), the literal reading of "a side card
 * with a trump": anyTrump replaces a side card with the LOWEST free trump-suit
 * card (e.g. a side ace for the trump 2).
 */
function monotonicity(hsiFn, opts = {}) {
    const n = opts.n == null ? 3000 : opts.n;
    const seed = opts.seed == null ? 20261121 : opts.seed;
    const eps = opts.eps == null ? 1e-9 : opts.eps;
    const maxExamples = opts.maxExamples == null ? 6 : opts.maxExamples;
    const rand = rng(seed);
    const kinds = {
        higher: { checks: 0, decreases: 0, worst: 0 },
        toTrump: { checks: 0, decreases: 0, worst: 0 },
        toJoker: { checks: 0, decreases: 0, worst: 0 },
        anyTrump: { checks: 0, decreases: 0, worst: 0 }
    };
    const examples = [], infoExamples = [];
    let errors = 0;

    const tryOne = (kind, hand, trump, i, replacement, base) => {
        const next = hand.slice();
        next[i] = replacement;
        let v;
        try { v = hsiFn(next, trump); } catch (e) { errors++; return; }
        const k = kinds[kind];
        k.checks++;
        if (!(v >= base - eps)) {
            k.decreases++;
            const drop = base - v;
            if (drop > k.worst || Number.isNaN(drop)) k.worst = drop;
            const ex = { kind, handSize: hand.length, trump, from: hand[i], to: replacement, before: base, after: v, hand };
            const list = kind === 'anyTrump' ? infoExamples : examples;
            if (list.length < maxExamples) list.push(ex);
        }
    };

    for (let h = 0; h < n; h++) {
        const handSize = HAND_SIZES[h % HAND_SIZES.length];
        const { hand, trump } = randomDeal(rand, handSize);
        const noTrump = trump.suit === 'joker';
        const taken = new Set(hand.map(key));
        taken.add(key(trump));
        let base;
        try { base = hsiFn(hand, trump); } catch (e) { errors++; continue; }
        for (let i = 0; i < hand.length; i++) {
            const c = hand[i];
            if (c.suit === 'joker') {
                if (c.rank === 'LO' && !taken.has('joker:HI')) tryOne('higher', hand, trump, i, { suit: 'joker', rank: 'HI' }, base);
                continue;
            }
            for (let r = RANK_INDEX[c.rank] + 1; r < RANKS.length; r++) {
                const cand = { suit: c.suit, rank: RANKS[r] };
                if (!taken.has(key(cand))) tryOne('higher', hand, trump, i, cand, base);
            }
            if (noTrump) continue;
            if (c.suit === trump.suit) {
                for (const jr of ['LO', 'HI']) {
                    if (!taken.has('joker:' + jr)) tryOne('toJoker', hand, trump, i, { suit: 'joker', rank: jr }, base);
                }
            } else {
                const same = { suit: trump.suit, rank: c.rank };
                if (!taken.has(key(same))) tryOne('toTrump', hand, trump, i, same, base);
                for (let r = 0; r < RANKS.length; r++) {
                    const low = { suit: trump.suit, rank: RANKS[r] };
                    if (!taken.has(key(low))) { tryOne('anyTrump', hand, trump, i, low, base); break; }
                }
            }
        }
    }
    const checks = kinds.higher.checks + kinds.toTrump.checks + kinds.toJoker.checks;
    const decreases = kinds.higher.decreases + kinds.toTrump.decreases + kinds.toJoker.decreases;
    return { hands: n, seed, checks, decreases, errors, kinds, examples, infoExamples };
}

// ---------------------------------------------------------------- safety

/**
 * Synthetic edge hands: every single card under every kind of turned card,
 * all-trump hands, joker hands, no-trump deals, voids; plus determinism,
 * hand-order independence and no mutation of the arguments.
 */
function safety(hsiFn) {
    const problems = [];
    let checks = 0;
    const call = (label, hand, trump) => {
        checks++;
        const before = JSON.stringify([hand, trump]);
        let v;
        try { v = hsiFn(hand, trump); } catch (e) { problems.push(`${label}: threw ${e && e.message}`); return NaN; }
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${label}: returned ${v}`);
        if (JSON.stringify([hand, trump]) !== before) problems.push(`${label}: mutated its arguments`);
        let v2;
        try { v2 = hsiFn(hand, trump); } catch (e) { v2 = NaN; }
        if (!(v2 === v)) problems.push(`${label}: not deterministic (${v} then ${v2})`);
        return v;
    };
    const deck = fullDeck();
    const trumps = [
        { suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: '2' }, { suit: 'clubs', rank: 'K' }, { suit: 'diamonds', rank: '7' },
        { suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }
    ];
    // 1-card hands: every card under every turned card
    for (const t of trumps) for (const c of deck) {
        if (key(c) === key(t)) continue;
        call(`1-card ${key(c)} / trump ${key(t)}`, [c], t);
    }
    // all-trump hands of every size (trump suit from the top, with and without jokers)
    for (let size = 1; size <= 13; size++) {
        const t = { suit: 'hearts', rank: '2' };
        const hearts = RANKS.slice().reverse().filter(r => r !== '2').map(rank => ({ suit: 'hearts', rank }));
        const withJokers = [{ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }, ...hearts].slice(0, size);
        call(`all-trump+jokers size ${size}`, withJokers, t);
        if (size <= 12) call(`all-trump size ${size}`, hearts.slice(0, size), t);
        // one side suit only (three voids), trump and no-trump
        const spades = RANKS.map(rank => ({ suit: 'spades', rank })).slice(0, size);
        call(`one side suit size ${size}`, spades, t);
        call(`one suit, no-trump deal, size ${size}`, spades, { suit: 'joker', rank: 'HI' });
        call(`one suit, LO turned, size ${size}`, spades, { suit: 'joker', rank: 'LO' });
    }
    // both jokers, and the free joker on a no-trump deal
    call('both jokers', [{ suit: 'joker', rank: 'HI' }, { suit: 'joker', rank: 'LO' }], { suit: 'clubs', rank: '5' });
    call('LO joker, HI turned', [{ suit: 'joker', rank: 'LO' }, { suit: 'clubs', rank: '5' }], { suit: 'joker', rank: 'HI' });
    call('HI joker, LO turned', [{ suit: 'joker', rank: 'HI' }, { suit: 'clubs', rank: '5' }], { suit: 'joker', rank: 'LO' });

    // hand-order independence on seeded random hands
    const rand = rng(7);
    let orderChecks = 0, orderFails = 0;
    for (let i = 0; i < 400; i++) {
        const { hand, trump } = randomDeal(rand, HAND_SIZES[i % 13]);
        let a, b;
        try {
            a = hsiFn(hand, trump);
            b = hsiFn(hand.slice().reverse(), trump);
        } catch (e) { problems.push(`order check threw ${e && e.message}`); continue; }
        orderChecks++;
        if (Math.abs(a - b) > 1e-9) { orderFails++; if (orderFails <= 2) problems.push(`depends on card order: ${a} vs ${b} (size ${hand.length})`); }
    }
    return { checks, orderChecks, orderFails, problems };
}

// ---------------------------------------------------------------- formatting

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));
const f4 = (v) => (Number.isFinite(v) ? v.toFixed(4) : String(v));
const pct = (v) => (Number.isFinite(v) ? (100 * v).toFixed(1) + '%' : String(v));
const pad = (s, w) => String(s).padStart(w);
const cardStr = (c) => (c.suit === 'joker' ? c.rank + '-joker' : c.rank + c.suit[0].toUpperCase());

function format(res, title) {
    const L = [];
    if (title) L.push(`== ${title} ==`);
    L.push(`records ${res.n}, scored ${res.scored}, threw ${res.errors}, non-finite ${res.nonFinite}, hand.length != hs ${res.sizeMismatch}`);
    for (const e of res.errorExamples) L.push('  problem: ' + JSON.stringify(e));
    L.push('');
    L.push('Per hand size (Spearman / Pearson of HSI vs own tricks within the size; distribution of HSI at that size)');
    L.push(' hs      n  spearman  pearson  sp.team    mean     sd    p10    p50    p90  <=70  >=195  avg tricks');
    for (const hs of Object.keys(res.bySize).map(Number).sort((a, b) => a - b)) {
        const s = res.bySize[hs];
        L.push(`${pad(hs, 3)} ${pad(s.n, 6)}  ${pad(f4(s.spearman), 8)}  ${pad(f4(s.pearson), 7)}  ${pad(f4(s.spearmanTeam), 7)}  ${pad(f1(s.mean), 6)} ${pad(f1(s.sd), 6)} ${pad(f1(s.p10), 6)} ${pad(f1(s.p50), 6)} ${pad(f1(s.p90), 6)} ${pad(pct(s.shareWeak), 5)} ${pad(pct(s.shareStrong), 6)}  ${pad(f3(s.meanTricks), 6)}`);
    }
    L.push('');
    L.push(`PRIMARY  Spearman avg over ${res.sizesAveraged} hand sizes (equal weight): ${f4(res.spearmanAvg)}`);
    L.push(`Pooled Pearson  HSI vs own tricks/handSize: ${f4(res.pearsonOwn)}   HSI vs team tricks/handSize: ${f4(res.pearsonTeam)}`);
    const d = res.dist;
    L.push('');
    L.push(`Pooled distribution (n ${d.n}): mean ${f1(d.mean)}  sd ${f1(d.sd)}  min ${f1(d.min)}  max ${f1(d.max)}`);
    L.push(`  p5 ${f1(d.p5)}  p10 ${f1(d.p10)}  p25 ${f1(d.p25)}  p50 ${f1(d.p50)}  p75 ${f1(d.p75)}  p90 ${f1(d.p90)}  p95 ${f1(d.p95)}`);
    L.push(`  share <= ${WEAK} (red): ${pct(d.shareWeak)}   share >= ${STRONG} (green): ${pct(d.shareStrong)}`);
    L.push('  mean by hand size: ' + Object.keys(res.bySize).map(Number).sort((a, b) => a - b).map(hs => `${hs}:${f1(res.bySize[hs].mean)}`).join('  '));
    for (const k of ['trump', 'noTrump']) {
        const s = res.split[k];
        if (!s.n) continue;
        L.push(`  ${k === 'trump' ? 'trump deals   ' : 'no-trump deals'} n ${s.n}: mean ${f1(s.mean)}  sd ${f1(s.sd)}  <=70 ${pct(s.shareWeak)}  >=195 ${pct(s.shareStrong)}  mean own tricks/handSize ${f3(s.meanOwnRate)}  pooled Pearson own ${f4(s.pearsonOwn)}  Spearman avg over sizes (these deals only) ${f4(s.spearmanAvg)}`);
    }
    return L.join('\n');
}

function formatMono(m) {
    const L = [];
    L.push(`Monotonicity: ${m.hands} seeded hands (seed ${m.seed}), ${m.checks} replacements, DECREASES ${m.decreases}, threw ${m.errors}`);
    for (const k of ['higher', 'toTrump', 'toJoker']) {
        const s = m.kinds[k];
        L.push(`  ${k.padEnd(8)} checks ${pad(s.checks, 7)}  decreases ${pad(s.decreases, 6)}  worst drop ${f1(s.worst)}`);
    }
    const a = m.kinds.anyTrump;
    L.push(`  (info, not counted) side card -> lowest free trump: checks ${a.checks}, decreases ${a.decreases}, worst drop ${f1(a.worst)}`);
    const show = (e) => `    [${e.kind}] hs ${e.handSize}, trump ${cardStr(e.trump)}: ${cardStr(e.from)} -> ${cardStr(e.to)}  ${f1(e.before)} -> ${f1(e.after)}   hand: ${e.hand.map(cardStr).join(' ')}`;
    if (m.examples.length) { L.push('  examples:'); for (const e of m.examples) L.push(show(e)); }
    if (m.infoExamples.length) { L.push('  info examples:'); for (const e of m.infoExamples.slice(0, 3)) L.push(show(e)); }
    return L.join('\n');
}

function formatSafety(s) {
    const L = [`Safety: ${s.checks} synthetic edge hands + ${s.orderChecks} order checks, problems ${s.problems.length}`];
    for (const p of s.problems.slice(0, 10)) L.push('  ' + p);
    return L.join('\n');
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
    const args = { pos: [], mono: 3000, seed: 20261121, json: null, quiet: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--mono') args.mono = +argv[++i];
        else if (a === '--seed') args.seed = +argv[++i];
        else if (a === '--json') args.json = argv[++i];
        else if (a === '--quiet') args.quiet = true;
        else if (a === '--vs') args.vs = argv[++i];
        else if (a === '--boot') args.boot = +argv[++i];
        else args.pos.push(a);
    }
    if (!args.pos.length) {
        console.error('usage: node harness.js <candidate.js> [test|train|file.jsonl] [--mono N] [--seed S] [--json out.json] [--vs other.js] [--boot B]');
        process.exit(2);
    }
    const hsiFn = loadCandidate(args.pos[0]);
    const file = resolveData(args.pos[1]);
    const records = await load(file);
    const t0 = Date.now();
    const result = evaluate(records, hsiFn);
    const ms = Date.now() - t0;
    const saf = safety(hsiFn);
    const mono = args.mono > 0 ? monotonicity(hsiFn, { n: args.mono, seed: args.seed }) : null;
    if (!args.quiet) {
        console.log(format(result, `${path.basename(args.pos[0])} on ${path.basename(file)}`));
        console.log(`(${(ms * 1000 / records.length).toFixed(2)} us per hand)`);
        console.log('');
        console.log(formatSafety(saf));
        if (mono) { console.log(''); console.log(formatMono(mono)); }
    }
    let cmp = null;
    if (args.vs) {
        cmp = compare(records, hsiFn, loadCandidate(args.vs), { boot: args.boot });
        console.log('');
        console.log(formatCompare(cmp, path.basename(args.pos[0]), path.basename(args.vs)));
    }
    if (args.json) fs.writeFileSync(args.json, JSON.stringify({ candidate: args.pos[0], data: file, result, safety: saf, monotonicity: mono, comparison: cmp }, null, 1));
    const bad = result.errors + result.nonFinite + saf.problems.length;
    process.exitCode = bad ? 1 : 0;
}

module.exports = {
    TEST, TRAIN, WEAK, STRONG, SUITS, RANKS, HAND_SIZES,
    load, loadCandidate, resolveData,
    evaluate, monotonicity, safety, compare,
    format, formatMono, formatSafety, formatCompare,
    mean, sd, pearson, spearman, ranks, percentile, distribution,
    rng, fullDeck, randomDeal
};

if (require.main === module) {
    main(process.argv).catch((e) => { console.error(e); process.exit(1); });
}
