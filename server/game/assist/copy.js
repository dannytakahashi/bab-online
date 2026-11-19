/**
 * Words for the /help explainer (plan §3.3): card and suit text, names,
 * hedged numbers, the glossary, length caps and the two render styles.
 *
 * The copy rules (copy.test.js holds every rendered string to them):
 *  - names only: "Bob (your partner)" on first mention, then "Bob"; the
 *    other pair is "Carol and Dan", our side "you and Bob". Never a team
 *    number, "your team", "other team" or "opponent(s)" (NAME_LINT)
 *  - "suggested", never "optimal"; the footer names "our strongest bot"
 *  - rates rounded to 5% and always with a word ("usually (about 80%)"),
 *    trick estimates "about 1.9" / "about 5", points "about +58"
 *  - plain words: "trump it", "the highest club left", "throw", "on average"
 *
 * Pure: no I/O, no Math.random, no Date.
 */

'use strict';

const SUIT_SYMBOL = Object.freeze({ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' });
const SUIT_ONE = Object.freeze({ spades: 'spade', hearts: 'heart', diamonds: 'diamond', clubs: 'club' });

const HEADLINE_MAX = 60;
const REASON_MAX = 140;
const DETAIL_MAX = 200;
// The plain-text line (shipped iOS, web until its card): the headline, BOTH reasons and the
// use count always fit (60 + 2 x 140 + the prefix and tail is under 440), so a game-log line,
// which wraps, is never cut short (owner 2026-11-19: some answers ended in "…" at 200).
const LINE_MAX = 440;
/** Every text the server sends in an assistHint stays under this (plan §7). */
const TEXT_MAX = 280;
const MAX_REASONS = 2;
const MAX_DETAILS = 4;

const FOOTER = 'What our strongest bot would play. A strong guess, not a guarantee.';
const QUICK_NOTE = 'Quick suggestion: rules only, the server is busy.';
const LINE_PREFIX = 'Suggested (only you see this): ';

const CONFIDENCE_LABEL = Object.freeze({
    only: 'Only legal card',
    certain: 'Sure thing',
    clear: 'Clear choice',
    close: 'Close call',
    any: 'Any card works',
    quick: 'Quick suggestion'
});

/** Rejected in every rendered string (plan Q9). */
const NAME_LINT = /\bteam ?[12]\b|\bT[12]\b|your team|other team|opponents?/i;

/** "A♣", "10♠", "HI joker". */
function cardText(card) {
    if (!card) return '?';
    if (card.suit === 'joker') return `${card.rank} joker`;
    return `${card.rank}${SUIT_SYMBOL[card.suit] || ''}`;
}

/** "the HI joker" / "the A♣". */
function theCard(card) {
    return `the ${cardText(card)}`;
}

/** "club" / "clubs" (n !== 1). Trump in no-trump is "trump". */
function suitWord(suit, n = 2) {
    if (!SUIT_ONE[suit]) return 'trump';
    return n === 1 ? SUIT_ONE[suit] : suit;
}

/** "Clubs". */
function capital(s) {
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The name shown in prose: the table name without a bot's robot prefix. */
function cleanName(name) {
    return String(name == null ? '' : name).replace(/^\u{1F916}\s*/u, '').trim() || 'a player';
}

/** "A, B and C". */
function listText(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Percent rounded to 5 (0..100). */
function pct5(p) {
    return Math.max(0, Math.min(100, Math.round(p * 20) * 5));
}

/** The hedge word for a rate (from its 5%-rounded value). */
function rateWord(p) {
    const v = pct5(p);
    if (v >= 95) return 'almost always';
    if (v >= 80) return 'usually';
    if (v >= 60) return 'more often than not';
    if (v >= 40) return 'about half the time';
    if (v >= 20) return 'sometimes';
    if (v >= 5) return 'rarely';
    return 'almost never';
}

/** "usually (about 80%)". */
function rate(p) {
    return `${rateWord(p)} (about ${pct5(p)}%)`;
}

/** "usually (80%)": the same hedge in less room. */
function rateShort(p) {
    return `${rateWord(p)} (${pct5(p)}%)`;
}

/** Trick estimate: "about 1.9" under 3, else "about 5" (2.96 is "about 3"). */
function tricksText(x) {
    const v = Math.round(Math.max(0, x) * 10) / 10;
    if (v < 3) return `about ${v.toFixed(1)}`;
    return `about ${Math.round(v)}`;
}

/** "about +58" / "about −10" / "about 0". */
function pointsText(x) {
    const v = Math.round(x);
    if (v === 0) return 'about 0';
    return v > 0 ? `about +${v}` : `about −${-v}`;
}

/** "1 trick" / "3 tricks". */
function tricksCount(n) {
    return `${n} trick${n === 1 ? '' : 's'}`;
}

/** Number words for small counts in prose ("Two more"). */
const NUM_WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen'];
function numWord(n) {
    return NUM_WORD[n] ?? String(n);
}

/** "Bid 4" / "Bore (B)" / "Bid 2B". */
function bidHeadline(bid) {
    const b = String(bid);
    if (b === 'B') return 'Bore (B)';
    return `Bid ${b}`;
}

/**
 * Cut `s` to `max` characters at a word boundary, with an ellipsis. A
 * parenthesis the cut would leave open ("almost never (about…") goes too.
 */
function clip(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    let out = sp > max * 0.6 ? cut.slice(0, sp) : cut;
    const open = out.lastIndexOf('(');
    if (open > out.lastIndexOf(')') && open > max * 0.5) out = out.slice(0, open);
    return `${out.replace(/[\s,;:.]+$/, '')}…`;
}

/** The first variant that fits `max`, else the last one clipped. */
function fit(variants, max) {
    const list = Array.isArray(variants) ? variants.filter(Boolean) : [variants];
    for (const v of list) if (v.length <= max) return v;
    return clip(list[list.length - 1] || '', max);
}

// Glossary for tutorial mode: the first use of a term in a game carries a
// short gloss (the tutorial handler remembers which were shown)
const GLOSSARY = Object.freeze([
    { term: 'trick', match: /\btricks?\b/i, text: 'One card from each player; the highest wins it.' },
    { term: 'trump', match: /\btrumps?\b/i, text: 'The trump suit beats every other suit. The two jokers are the highest trumps.' },
    { term: 'bore', match: /\bbore[ds]?\b|\b[234]?B\b/, text: 'A bet that you and your partner win every trick: double points if you do, minus double if not.' },
    { term: 'set', match: /\bsets?\b/i, text: 'A pair that wins fewer tricks than its combined bid is set: it loses 10 points for every trick it bid.' },
    { term: 'lead', match: /\blead(s|ing)?\b/i, text: 'Playing the first card of a trick. The others must follow its suit if they can.' },
    { term: 'throw', match: /\bthrow\b/i, text: 'Playing a card that can\'t win, from a suit that wasn\'t led.' },
    { term: 'broken', match: /\bbroken\b/i, text: 'Trump is broken once someone has played one. Before that, trump can\'t be led.' },
    { term: 'joker', match: /\bjokers?\b/i, text: 'The HI joker beats everything; the LO joker beats everything but the HI joker.' }
]);

/** Glossary entries for terms used in `texts`, minus those in `skip`. */
function glossFor(texts, skip = []) {
    const all = texts.join(' ');
    const out = [];
    for (const g of GLOSSARY) {
        if (skip.includes(g.term)) continue;
        if (g.match.test(all)) out.push({ term: g.term, text: g.text });
    }
    return out;
}

/** Index of `name` as a whole word in `s` ("Al" not in "All", "Ali" not in "Alice"), or -1. */
function nameAt(s, name) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'u').exec(s);
    return m ? m.index : -1;
}

/**
 * Render an explanation.
 *  - 'rich' (the assistHint card): {headline, label, reasons, details, footer}
 *    (footer null on a forced move: there is nothing to guess)
 *  - 'line' (a private game-log line for clients without the card, ≤ 200
 *    characters): "Suggested (only you see this): Play 4♦. <reasons>
 *    (Help 2 of 3 free)"
 * @param {Object} e - from explain()
 * @param {Object} [o]
 * @param {'rich'|'line'} [o.style]
 * @param {number} [o.uses] - counted /help uses so far, this one included
 * @param {number} [o.freeUses] - the free uses (3)
 * @param {boolean} [o.counted] - false: this answer is not counted
 */
function render(e, { style = 'rich', uses = null, freeUses = null, counted = true } = {}) {
    if (style === 'rich') {
        return {
            headline: e.headline,
            label: CONFIDENCE_LABEL[e.confidence] || null,
            reasons: e.reasons.slice(),
            details: e.details.slice(),
            footer: e.confidence === 'quick' ? QUICK_NOTE : e.confidence === 'only' ? null : FOOTER
        };
    }
    let tail = '';
    if (!counted) tail = ' (Not counted.)';
    else if (uses != null && freeUses != null) {
        tail = uses <= freeUses ? ` (Help ${uses} of ${freeUses} free)` : ` (Help ${uses}: this game counts as bot-assisted for you)`;
    }
    const lead = `${e.confidence === 'quick' ? 'Quick suggestion, rules only (only you see this): ' : LINE_PREFIX}${e.headline}.`;
    const room = LINE_MAX - lead.length - tail.length - 1;
    // The contract line and the main reason when both fit, else the main
    // reason (the last one) alone, clipped if need be
    const main = e.reasons[e.reasons.length - 1];
    const both = e.reasons.join(' ');
    let body = '';
    if (both && both.length <= room) body = ` ${both}`;
    else if (main) {
        // The partner's "(your partner)" tag went with the dropped line: move it
        const p = e.partnerName;
        let m = main;
        const tagged = (t) => t.includes(`${p} (your partner)`) || t.includes(`partner ${p}'s`);
        if (p && tagged(e.reasons[0]) && !tagged(m)) {
            const i = nameAt(m, p);
            if (i >= 0 && m.startsWith(`${p}'s`, i)) {
                const start = i === 0 || /[.:!?]\s$/.test(m.slice(0, i));
                m = `${m.slice(0, i)}${start ? 'Your' : 'your'} partner ${m.slice(i)}`;
            } else if (i >= 0) {
                m = `${m.slice(0, i + p.length)} (your partner)${m.slice(i + p.length)}`;
            }
        }
        body = ` ${m.length <= room ? m : clip(m, room)}`;
    }
    return `${lead}${body}${tail}`;
}

module.exports = {
    SUIT_SYMBOL,
    HEADLINE_MAX,
    REASON_MAX,
    DETAIL_MAX,
    LINE_MAX,
    TEXT_MAX,
    MAX_REASONS,
    MAX_DETAILS,
    FOOTER,
    QUICK_NOTE,
    LINE_PREFIX,
    CONFIDENCE_LABEL,
    NAME_LINT,
    GLOSSARY,
    cardText,
    theCard,
    suitWord,
    capital,
    cleanName,
    listText,
    pct5,
    rateWord,
    rate,
    rateShort,
    tricksText,
    pointsText,
    tricksCount,
    numWord,
    bidHeadline,
    clip,
    fit,
    glossFor,
    render
};
