/**
 * The copy rules of the /help explainer (plan §3.3) as a checker, used by
 * copy.test.js and assistCoverage.js. lintExplanation returns a list of
 * problems (empty = clean) for one explanation and its two renderings.
 */

'use strict';

const C = require('../copy');
const { WIN_CODE } = require('../explain');

const RATE_WORDS = ['almost always', 'usually', 'more often than not', 'about half the time', 'sometimes', 'rarely', 'almost never'];
const CARD_TOKEN = /(10|[2-9JQKA])([♠♥♦♣])|\b(HI|LO) joker/g;
const SYMBOL_SUIT = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };

/** Every card the seat can see: its hand, the played cards, the trump card. */
function visibleCards(view) {
    const set = new Set();
    const add = (c) => c && set.add(`${c.suit}:${c.rank}`);
    view.hand.forEach(add);
    add(view.trump);
    (view.memory ? view.memory.playedCards : []).forEach(add);
    view.playedCards.forEach(add);
    return set;
}

/** The cards named in `text`, as suit:rank keys. */
function namedCards(text) {
    const out = [];
    for (const m of text.matchAll(CARD_TOKEN)) {
        if (m[3]) out.push(`joker:${m[3]}`);
        else out.push(`${SYMBOL_SUIT[m[2]]}:${m[1]}`);
    }
    return out;
}

/**
 * @param {Object} e - explain()
 * @param {Object} view - the SeatView
 * @param {Object} [o] - {line: the 'line' rendering, rich: the 'rich' one}
 * @returns {string[]} problems
 */
function lintExplanation(e, view, { line, rich } = {}) {
    const bad = [];
    const texts = [e.headline, ...e.reasons, ...e.details, ...(line ? [line] : []), ...(rich ? [rich.footer || '', rich.label || ''] : [])];
    if (!e.headline || e.headline.length > C.HEADLINE_MAX) bad.push(`headline length ${e.headline && e.headline.length}`);
    if (e.reasons.length < 1 || e.reasons.length > C.MAX_REASONS) bad.push(`${e.reasons.length} reasons`);
    for (const r of e.reasons) if (r.length > C.REASON_MAX) bad.push(`reason length ${r.length}: ${r}`);
    if (e.details.length > C.MAX_DETAILS) bad.push(`${e.details.length} details`);
    for (const d of e.details) if (d.length > C.DETAIL_MAX) bad.push(`detail length ${d.length}`);
    if (line && line.length > C.LINE_MAX) bad.push(`line length ${line.length}`);
    if (!C.CONFIDENCE_LABEL[e.confidence]) bad.push(`confidence ${e.confidence}`);
    if (!Array.isArray(e.codes) || e.codes.length === 0) bad.push('no codes');
    for (const t of texts) {
        if (t.length > C.TEXT_MAX) bad.push(`text over ${C.TEXT_MAX}`);
        if (/undefined|NaN|\bnull\b|\[object|Infinity|\?\s|\s{2}/.test(t)) bad.push(`junk in: ${t}`);
        if (C.NAME_LINT.test(t)) bad.push(`team words in: ${t}`);
        if (/optimal/i.test(t)) bad.push(`"optimal" in: ${t}`);
        if (/\b(he|she|his|her|hers|him)\b/i.test(t)) bad.push(`gendered pronoun in: ${t}`);
        if (/\b(ruff|slough|boss|EV)\b/.test(t)) bad.push(`jargon in: ${t}`);
        // Rates: a multiple of 5, written "(about N%)", "(N%)" after a hedge word, or "about N% vs N%"
        for (const m of t.matchAll(/(\d+)%/g)) {
            const n = Number(m[1]);
            const before = t.slice(Math.max(0, m.index - 40), m.index);
            if (n % 5 !== 0) bad.push(`rate ${n}% not rounded to 5: ${t}`);
            if (!/(about |\(|vs )$/.test(before)) bad.push(`bare rate ${n}%: ${t}`);
            if (/\($/.test(before) && !RATE_WORDS.some((w) => before.endsWith(`${w} (`))) bad.push(`rate without a word: ${t}`);
        }
        if (/\b\d+\.\d{2,}/.test(t)) bad.push(`unrounded number: ${t}`);
        // Texts that contradict themselves or the play (H1 review)
        if (/\([^()]*\(/.test(t)) bad.push(`nested parentheses: ${t}`);
        const nb = /\(about (\d+)%\), just under what a bore needs \(about (\d+)%\)/.exec(t);
        if (nb && nb[1] === nb[2]) bad.push(`"N%, just under N%": ${t}`);
        if (view.trump && C.SUIT_SYMBOL[view.trump.suit] && t.includes(`no ${view.trump.suit} and no trump`)) bad.push(`the trump suit as a side suit: ${t}`);
        for (const m of t.matchAll(/(?:joker|[♠♥♦♣]) \(about (\d+\.\d)\)/g)) if (Number(m[1]) > 1) bad.push(`one card credited with ${m[1]} tricks: ${t}`);
        if (/\b1 trumps? support\b/.test(t)) bad.push(`"1 trump support": ${t}`);
        // Q2: only cards the seat can see
        const vis = visibleCards(view);
        for (const k of namedCards(t)) if (!vis.has(k)) bad.push(`names an unseen card ${k}: ${t}`);
    }
    // Q9: the partner tagged on first mention ("Bob (your partner)" or
    // "your partner Bob's"), once
    const pname = C.cleanName(view.names[view.partner]);
    const taggedAt = (t, i) => t.startsWith(`${pname} (your partner)`, i) ||
        (t.slice(Math.max(0, i - 8), i).toLowerCase() === 'partner ' && t.startsWith(`${pname}'s`, i));
    const all = [...e.reasons, ...e.details].join(' ');
    const tags = (all.match(/\(your partner\)|\bpartner \S+'s/gi) || []).length;
    if (tags > 1) bad.push(`partner tagged ${tags} times: ${all}`);
    const first = all.indexOf(pname);
    if (first >= 0 && !taggedAt(all, first)) bad.push(`partner's first mention untagged: ${all}`);
    if (line) {
        if (!/suggest/i.test(line)) bad.push('line without "suggested"');
        const lf = line.indexOf(pname);
        if (lf >= 0 && !taggedAt(line, lf)) bad.push(`line: partner's first mention untagged: ${line}`);
    }
    // "save strong cards" opening a play that spends one
    if (/save strong cards|Keep your good cards/.test(e.reasons.join(' ')) && (e.codes || []).some((c) => WIN_CODE.test(c))) {
        bad.push(`"save strong cards" before a winning play: ${e.reasons.join(' ')}`);
    }
    if (rich && e.confidence === 'only' && rich.footer != null) bad.push('a "guess" footer on a forced move');
    if (rich && e.confidence !== 'quick' && e.confidence !== 'only' && !/our strongest bot/.test(rich.footer || '')) bad.push('footer without "our strongest bot"');
    return bad;
}

module.exports = { lintExplanation, visibleCards, namedCards, RATE_WORDS };
