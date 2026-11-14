/**
 * Fit the expected-value bidding tables (server/game/bot/bidModel.js) from
 * bot self-play records.
 *
 *   node server/game/bot/sim/simulate.js --exp baseline --games 4000 --seed 603 --records /tmp/bids.jsonl
 *   node server/game/bot/sim/fitBidModel.js /tmp/bids.jsonl --note "seed 603, 4000 games" > server/game/bot/bidModel.js
 *
 * Refit after any change to bidding or card play: the tables describe how the
 * CURRENT bots actually play out a hand, so they drift when play changes. Two
 * rounds (fit, install, re-record, refit) settle them; then confirm with a
 * --baseline head-to-head (sim/README.md).
 *
 * Only Mary's records are used (run pure Mary self-play). Hands of 1-2 cards,
 * bores on either team, and records where an opponent bored are skipped: the
 * EV bidder only decides 3+ card hands with no bore on the table.
 */
'use strict';
const fs = require('fs');
const { RANK_VALUES } = require('../../rules');

const BORES = ['B', '2B', '3B', '4B'];
const isBore = (b) => BORES.includes(String(b));
const GROUPS = ['S', 'M', 'L', 'XL'];
const group = (n) => (n <= 4 ? 'S' : n <= 7 ? 'M' : n <= 10 ? 'L' : 'XL');
const TRUMP_KEYS = ['HI', 'LO', 'tA', 'tK', 'tQ', 'tMid', 'tLow', 'sA', 'sKwA', 'sK', 'sQ', 'voids', 'single', 'tLen4p', 'oppBidSum', 'oppBidCount'];
const NT_KEYS = ['HI', 'LO', 'A', 'K', 'Q', 'oppBidSum', 'oppBidCount'];
// Must match BotStrategy.estimateOwnTricks
function features(hand, trump) {
    const F = {};
    if (trump.suit === 'joker') {
        for (const k of NT_KEYS) F[k] = 0;
        for (const c of hand) if (c.rank in F) F[c.rank]++;
        return F;
    }
    for (const k of TRUMP_KEYS) F[k] = 0;
    const side = { spades: [], hearts: [], diamonds: [], clubs: [] };
    let trumpCount = 0;
    for (const c of hand) {
        const isTrump = c.suit === 'joker' || c.suit === trump.suit;
        if (isTrump) trumpCount++;
        if (c.rank === 'HI') F.HI++;
        else if (c.rank === 'LO') F.LO++;
        else if (isTrump) {
            if (c.rank === 'A') F.tA++;
            else if (c.rank === 'K') F.tK++;
            else if (c.rank === 'Q') F.tQ++;
            else if (RANK_VALUES[c.rank] >= RANK_VALUES['7']) F.tMid++;
            else F.tLow++;
        } else side[c.suit].push(c.rank);
    }
    for (const [suit, ranks] of Object.entries(side)) {
        if (suit === trump.suit) continue;
        if (ranks.length === 0) F.voids++;
        if (ranks.length === 1) F.single++;
        if (ranks.includes('A')) F.sA++;
        if (ranks.includes('K')) { if (ranks.includes('A')) F.sKwA++; else F.sK++; }
        if (ranks.includes('Q')) F.sQ++;
    }
    F.tLen4p = Math.max(0, trumpCount - 3);
    return F;
}

/** Ridge-regularized least squares (intercept unpenalized). */
function fitLinear(rows, ridge) {
    const k = rows[0].x.length;
    const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
    for (const r of rows) {
        for (let i = 0; i < k; i++) {
            A[i][k] += r.x[i] * r.y;
            for (let j = 0; j < k; j++) A[i][j] += r.x[i] * r.x[j];
        }
    }
    for (let i = 1; i < k; i++) A[i][i] += ridge;
    for (let i = 0; i < k; i++) { // Gaussian elimination, partial pivoting
        let p = i;
        for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        [A[i], A[p]] = [A[p], A[i]];
        for (let r = i + 1; r < k; r++) {
            const f = A[r][i] / A[i][i];
            for (let j = i; j <= k; j++) A[r][j] -= f * A[i][j];
        }
    }
    const x = new Array(k).fill(0);
    for (let i = k - 1; i >= 0; i--) {
        let s = A[i][k];
        for (let j = i + 1; j < k; j++) s -= A[i][j] * x[j];
        x[i] = s / A[i][i];
    }
    return x;
}

function parseArgs(argv) {
    const a = { files: [], note: '' };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--note') a.note = argv[++i];
        else a.files.push(argv[i]);
    }
    if (!a.files.length) throw new Error('usage: fitBidModel.js records.jsonl [...] [--note text]');
    return a;
}

function loadRows(files) {
    const rows = [];
    for (const f of files) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!line) continue;
            const r = JSON.parse(line);
            const n = r.hs;
            if (r.spec !== 'mary' || n < 3) continue;
            const partner = ((r.pos + 1) % 4) + 1;
            const bid = r.bids[r.pos - 1], pb = r.bids[partner - 1];
            if (isBore(bid) || isBore(pb)) continue;
            const order = (p) => (p - r.fb + 4) % 4;
            let oppBidSum = 0, oppBidCount = 0, oppBore = false;
            for (const o of [1, 2, 3, 4]) {
                if (o === r.pos || o === partner) continue;
                if (isBore(r.bids[o - 1])) oppBore = true;
                if (order(o) < order(r.pos)) { oppBidCount++; oppBidSum += +r.bids[o - 1]; }
            }
            if (oppBore) continue;
            const F = features(r.hand, r.trump);
            F.oppBidSum = oppBidSum; F.oppBidCount = oppBidCount;
            rows.push({
                n, G: group(n), nt: r.trump.suit === 'joker', F,
                tricks: r.tricks, ptricks: r.ptricks, tt: r.tt, pb: +pb,
                weFirst: order(partner) > order(r.pos)
            });
        }
    }
    return rows;
}

function fit(rows) {
    const m = { trump: {}, noTrump: {}, partnerOver: {}, teamSd: {}, secondBidPmf: {} };
    for (const G of GROUPS) {
        m.trump[G] = fitLinear(rows.filter(r => r.G === G && !r.nt)
            .map(r => ({ x: [1, ...TRUMP_KEYS.map(k => r.F[k])], y: r.tricks })), 1);
        // No-trump hands are rare (~4%): regularize harder
        m.noTrump[G] = fitLinear(rows.filter(r => r.G === G && r.nt)
            .map(r => ({ x: [1, ...NT_KEYS.map(k => r.F[k])], y: r.tricks })), 5);
    }
    const own = (r) => {
        const b = r.nt ? m.noTrump[r.G] : m.trump[r.G];
        const keys = r.nt ? NT_KEYS : TRUMP_KEYS;
        return keys.reduce((y, k, i) => y + b[i + 1] * r.F[k], b[0]);
    };
    for (let n = 3; n <= 13; n++) {
        const rs = rows.filter(r => r.n === n);
        // Partner's mean (tricks - bid), by the PARTNER's place in the team order
        const over = (partnerFirst) => {
            const ps = rs.filter(r => r.weFirst !== partnerFirst);
            return ps.reduce((s, r) => s + r.ptricks - r.pb, 0) / ps.length;
        };
        m.partnerOver[n] = { first: over(true), second: over(false) };
        const sd = (weFirst) => {
            const ps = rs.filter(r => r.weFirst === weFirst);
            const po = m.partnerOver[n][weFirst ? 'second' : 'first'];
            const res = ps.map(r => r.tt - (own(r) + r.pb + po));
            const mean = res.reduce((a, b) => a + b, 0) / res.length;
            return Math.sqrt(res.reduce((a, b) => a + (b - mean) ** 2, 0) / res.length);
        };
        m.teamSd[n] = { first: sd(true), second: sd(false) };
        const sec = rs.filter(r => r.weFirst);
        const pmf = new Array(n + 1).fill(0);
        for (const r of sec) pmf[Math.min(r.pb, n)]++;
        m.secondBidPmf[n] = pmf.map(c => c / sec.length);
    }
    return m;
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
function table(betas, keys) {
    const o = { base: r2(betas[0]) };
    keys.forEach((k, i) => { o[k] = r2(betas[i + 1]); });
    return '{ ' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') + ' }';
}

function render(m, rowCount, note) {
    const lines = [];
    lines.push(`/**
 * Fitted tables for expected-value bidding (BotStrategy.calculateOptimalBid).
 *
 * GENERATED by server/game/bot/sim/fitBidModel.js from bot self-play; do not
 * hand-edit. Refit after any change to bidding or card play.
 * ${note ? note + ' ' : ''}(${rowCount} bot-hands)
 *
 * The model, for hands of 3+ cards with no bore on the table:
 *   own tricks   = base + sum of value x count (OWN_TRICKS, by hand-size
 *                  group; numeric opponent bids already made shift it)
 *   partner      = partner's bid + PARTNER_OVER (partner bid first), or a
 *                  bid drawn from SECOND_BID_PMF plus PARTNER_OVER (partner
 *                  bids after us)
 *   team tricks  ~ Normal(own + partner, TEAM_SD), discretized to 0..handSize
 * and the bot bids whatever maximizes the expected team score.
 */
'use strict';

// Groups: S = 3-4 cards, M = 5-7, L = 8-10, XL = 11-13.
// Trump-hand features (counts): HI / LO jokers; trump A / K / Q; tMid = trump
// 7-J; tLow = trump 2-6; side-suit sA = ace, sKwA = king with its ace, sK =
// king without it, sQ = queen; voids / single = side suits holding 0 / 1
// cards; tLen4p = trump cards beyond the third; oppBidSum / oppBidCount =
// numeric opponent bids already made and how many opponents have bid.
// Each value is the expected tricks that feature adds in actual play.
const OWN_TRICKS = {
    trump: {`);
    for (const G of GROUPS) lines.push(`        ${G}: ${table(m.trump[G], TRUMP_KEYS)},`);
    lines.push(`    },
    // No-trump (a joker was flipped): A / K / Q of any suit
    noTrump: {`);
    for (const G of GROUPS) lines.push(`        ${G}: ${table(m.noTrump[G], NT_KEYS)},`);
    lines.push(`    }
};

// Mean (tricks won - bid) of the partner, by hand size and the partner's
// place in the team's bidding order (first = the partner bid before us).
const PARTNER_OVER = {`);
    for (let n = 3; n <= 13; n++) lines.push(`    ${n}: { first: ${r2(m.partnerOver[n].first)}, second: ${r2(m.partnerOver[n].second)} },`);
    lines.push(`};

// Standard deviation of team tricks around the model's mean, by hand size and
// our own place in the team's bidding order.
const TEAM_SD = {`);
    for (let n = 3; n <= 13; n++) lines.push(`    ${n}: { first: ${r2(m.teamSd[n].first)}, second: ${r2(m.teamSd[n].second)} },`);
    lines.push(`};

// Distribution of the second-of-team bid (index = bid), by hand size: what a
// partner who bids after us tends to add.
const SECOND_BID_PMF = {`);
    for (let n = 3; n <= 13; n++) {
        const p = m.secondBidPmf[n].map(r3);
        while (p.length > 1 && p[p.length - 1] === 0) p.pop();
        lines.push(`    ${n}: [${p.join(', ')}],`);
    }
    lines.push(`};

module.exports = { OWN_TRICKS, PARTNER_OVER, TEAM_SD, SECOND_BID_PMF };
`);
    return lines.join('\n');
}

if (require.main === module) {
    const args = parseArgs(process.argv);
    const rows = loadRows(args.files);
    process.stdout.write(render(fit(rows), rows.length, args.note));
}

module.exports = { features, fitLinear, loadRows, fit, render, TRUMP_KEYS, NT_KEYS };
