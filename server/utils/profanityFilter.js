/**
 * Basic profanity filter for user-generated text (chat messages, usernames,
 * lobby names). Required for App Store Guideline 1.2 (UGC apps must filter
 * objectionable content). The list is unambiguous slurs and profanity only.
 *
 * Two kinds of term:
 *   EMBEDDED_TERMS  never part of an ordinary word, so they count anywhere
 *                   inside one word: "xXfuckXx", "BigNazi88", and in chat
 *                   the whole word is masked ("fucking", "bullshit",
 *                   "shitty"). Ordinary words and names that do contain one
 *                   are allowlisted (the Scunthorpe problem): ALLOWLIST as a
 *                   part of a word ("Atwater"), ALLOWED_NAMES as the whole
 *                   word ("Ishita", "Kshitij").
 *   WORD_TERMS      short ones that sit inside common words ("spic" in
 *                   spice / hospice, "rape" in grape / scrape / therapeutic,
 *                   "pedo" in torpedo / speedo, "fag" in Fagan): only a whole
 *                   word counts, in its listed forms ("rapes", "raping").
 * Every letter of a term also matches a run of itself ("fuuuck").
 *
 * What a word is (review fix 2026-11-15: matching across words refused real
 * names like "Matt Watson", "James Luther", "Josh17"):
 *   - separators, spaces and punctuation end a word, and so does a camelCase
 *     break between two parts of 3+ letters ("MattWatson"; not the random
 *     capitals of "FuCking" or "NiGger")
 *   - the compound terms (COMPOUND_TERMS: asshole, dickhead, ...) are two
 *     words already, so they also count across that break ("AssHole")
 *   - in a handle, runs of 1-3 letter fragments are read as one word
 *     ("f.u.c.k", "sh_it", "fu2ck"); in chat only single letters with one
 *     separator between them ("f.u.c.k", "s h i t")
 *   - leetspeak (0 o, 1 i and l, 3 e, 4 a, 5 s, 7 t, 8 b, $ s, @ a, ! i)
 *     is read inside a word, but a trailing number of 2+ digits stays a
 *     number ("Josh17", "Ash17") unless it spells the end of a term that
 *     starts the word ("sh17")
 * Chat text is also folded first: zero-width characters and combining marks
 * dropped, fullwidth and accented letters read as plain ones, and the common
 * Cyrillic / Greek lookalikes as Latin ("fu​ck", "fuсk"). Masking
 * keeps the message's length and characters outside each match.
 *
 * Accepted false positives: a handle that runs a name into the next in
 * lower case ("mattwatson", "joshito"), two short name parts that join into
 * a term ("Ash It"), the surname Dyke as its own word ("Van Dyke"), and a
 * compound split across words ("Sweet Back"). Extend ALLOWED_NAMES or
 * ALLOWLIST when one is reported.
 */

const EMBEDDED_TERMS = [
    'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dickhead', 'cocksucker',
    'motherfucker', 'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
    'twat', 'wanker', 'pussy', 'wetback', 'tranny', 'trannie', 'rapist',
    // the stem, so pedophiles / pedophilia count too
    'pedophil',
    'nazi', 'hitler'
];

// Terms made of two ordinary words: they count across a camelCase break
// ("AssHole") and, in a handle, across separators ("Dick_Head")
const COMPOUND_TERMS = ['asshole', 'dickhead', 'cocksucker', 'motherfucker', 'wetback'];

// term -> its whole-word forms
const WORD_TERMS = {
    fag: ['fag', 'fags'],
    spic: ['spic', 'spics'],
    kike: ['kike', 'kikes'],
    chink: ['chink', 'chinks'],
    dyke: ['dyke', 'dykes'],
    rape: ['rape', 'rapes', 'raped', 'raping', 'rapey'],
    pedo: ['pedo', 'pedos'],
    prick: ['prick', 'pricks'],
    kys: ['kys'],
};

// Ordinary words and names with an EMBEDDED_TERM inside: a term wholly
// inside one of these, anywhere in a word, does not count. Kept to whole
// words (not fragments like "shita"), so "bullshitarmy" cannot hide behind one.
const ALLOWLIST = [
    'scunthorpe',                                  // cunt
    'therapist',                                   // rapist
    'twater',                                      // twat: Atwater, saltwater, meltwater
    'snigger', 'niggard',                          // nigger, nigga
    'retardant', 'retardation',                    // retard
    'shiitake', 'shitake', 'mishit',               // shit
    'yamashita', 'kinoshita', 'matsushita', 'morishita', 'yoshitaka', 'toshitaka',
    'ashkenazi', 'nazir', 'nazim', 'nazia',        // nazi: Arabic / Urdu names
    'pussyfoot', 'pussywillow', 'pussycat',        // pussy
];

// Given names that contain a term, allowed only as the whole word (so
// "shitall" is not "Shital"): Indian names with "shit", Persian / Urdu
// names with "nazi", the surname Slutsky
const ALLOWED_NAMES = [
    'ishita', 'nishita', 'ashita', 'akshit', 'akshita', 'harshit', 'harshita', 'rakshit', 'rakshita',
    'lakshita', 'darshit', 'darshita', 'kshitij', 'kshitiz', 'shital',
    'nazila', 'nazira', 'nazish', 'nazifa',
    'slutsky',
];

// Map common letter substitutions back to letters before matching
const SUBSTITUTIONS = {
    '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a',
    '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b'
};

// Lowercase Cyrillic / Greek letters drawn like Latin ones
const HOMOGLYPHS = {
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
    'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's',
    'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u',
};
const INVISIBLE = /^(?:[­᠎​-‏⁠-⁤﻿]|\p{M})$/u;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "fuck" -> f+u+c+k+ : a letter may repeat ("fuuuck"); a doubled letter in
// the term stays required ("nigger" is not "Niger")
const tolerant = (word) => word.split('').map(c => `${escapeRegex(c)}+`).join('');

const EMBEDDED_PATTERNS = EMBEDDED_TERMS.map(word => new RegExp(tolerant(word), 'g'));
const COMPOUND_PATTERNS = COMPOUND_TERMS.map(word => new RegExp(tolerant(word), 'g'));
// a term at the start of a word, for the trailing-number rule
const EMBEDDED_STARTS = EMBEDDED_TERMS.map(word => new RegExp(`^${tolerant(word)}`));
const ALLOW_PATTERNS = ALLOWLIST.map(word => new RegExp(tolerant(word), 'g'));
// spelled exactly: no repeated letters either ("shitall" is not "Shital")
const NAMES = new Set(ALLOWED_NAMES);
const WORD_FORMS = Object.values(WORD_TERMS).flat();
const WORD_PATTERN = new RegExp(`\\b(?:${WORD_FORMS.map(tolerant).join('|')})\\b`, 'g');
const WORD_EXACT = new RegExp(`^(?:${WORD_FORMS.map(tolerant).join('|')})$`);

const SHORT = 3;            // a fragment this short may join its neighbours
const CAMEL_PART = 3;       // both sides of a camelCase break need this many letters

const isLetter = (c) => c >= 'a' && c <= 'z';
const isDigit = (c) => c >= '0' && c <= '9';
const isAlnum = (c) => isLetter(c) || isDigit(c);
const isWordChar = (c) => isAlnum(c) || c in SUBSTITUTIONS;

/**
 * The text folded for matching, one unit per kept input unit: `s` is
 * lowercased (strictly 1:1, since full-string toLowerCase() can change
 * length, e.g. 'İ' → 'i̇') with fullwidth / accented letters and lookalikes
 * read as plain ones; invisible characters are dropped; `pos[k]` is the
 * input index of s[k] and `kase[k]` its case (1 upper, -1 lower, 0 none).
 */
function prepare(text) {
    let s = '';
    const pos = [];
    const kase = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (INVISIBLE.test(ch)) continue;
        let c = ch;
        if (ch > '\u007f') {
            const base = ch.normalize('NFKD').replace(/\p{M}+/gu, '');
            if (base.length === 1) c = base;
        }
        const lower = c.toLowerCase();
        kase.push(lower !== c ? 1 : (c.toUpperCase() !== c ? -1 : 0));
        c = lower.length === 1 ? lower : c;
        s += HOMOGLYPHS[c] || c;
        pos.push(i);
    }
    return { s, pos, kase };
}

/** camelCase break candidates in p.s: lower, Upper, lower ("tWa" in "MattWatson"). */
function camelCandidate(p, k) {
    return k > 0 && k + 1 < p.s.length && p.kase[k - 1] === -1 && p.kase[k] === 1 && p.kase[k + 1] === -1;
}

/**
 * Leetspeak undone (1 read as `one`), except a trailing number of 2+ digits
 * that does not finish a term begun at the start of its word or camel part.
 */
function leet(p, one) {
    const s = p.s;
    const sub = (c) => (c === '1' ? one : (SUBSTITUTIONS[c] || c));
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (!isWordChar(s[i])) { out += s[i++]; continue; }
        let j = i;
        while (j < s.length && isWordChar(s[j])) j++;
        let d = j;
        while (d > i && isDigit(s[d - 1])) d--;
        let numberFrom = j;
        if (d === i) {
            numberFrom = i;   // all digits: a number ("007", "1500")
        } else if (j - d >= 2) {
            let start = i;
            for (let k = i + 1; k < d; k++) if (camelCandidate(p, k)) start = k;
            const reading = Array.from(s.slice(start, j), sub).join('');
            const finishes = EMBEDDED_STARTS.some(re => {
                const m = re.exec(reading);
                return m && m[0].length > d - start;
            });
            if (!finishes) numberFrom = d;
        }
        for (let k = i; k < j; k++) out += k < numberFrom ? sub(s[k]) : s[k];
        i = j;
    }
    return out;
}

/** Substitution chars as separators (catches "rape5", "fag1", "rape4u"). */
function separate(p) {
    let out = '';
    for (const c of p.s) out += c in SUBSTITUTIONS ? ' ' : c;
    return out;
}

/**
 * The letters of `v` cut into fragments: letter runs split at camelCase
 * breaks (every candidate when `every`, else only where both parts have
 * CAMEL_PART letters). Each is {start, end, word} (word: index of its
 * letter run).
 */
function fragments(v, p, every) {
    const out = [];
    let word = 0;
    let i = 0;
    while (i < v.length) {
        if (!isLetter(v[i])) { i++; continue; }
        let j = i;
        while (j < v.length && isLetter(v[j])) j++;
        const points = [i];
        for (let k = i + 1; k < j; k++) if (camelCandidate(p, k)) points.push(k);
        points.push(j);
        let from = i;
        for (let n = 1; n < points.length - 1; n++) {
            const cut = every || (points[n] - points[n - 1] >= CAMEL_PART && points[n + 1] - points[n] >= CAMEL_PART);
            if (cut) { out.push({ start: from, end: points[n], word }); from = points[n]; }
        }
        out.push({ start: from, end: j, word });
        word++;
        i = j;
    }
    return out;
}

/**
 * A run of fragments as {str, idx, last}: its letters, with any run of one
 * letter cut to two (a term needs at most a double, and "f+u+c+k+" would
 * backtrack over a long run, quadratic in it), and per letter of str the
 * first and last index in v it stands for.
 */
function segmentOf(v, frags) {
    let str = '';
    const idx = [];
    const last = [];
    for (const f of frags) {
        for (let k = f.start; k < f.end; k++) {
            const n = str.length;
            if (n >= 2 && str[n - 1] === v[k] && str[n - 2] === v[k]) { last[n - 1] = k; continue; }
            str += v[k];
            idx.push(k);
            last.push(k);
        }
    }
    return { str, idx, last };
}

/**
 * Join neighbouring fragments into the segments terms are matched in. A
 * handle joins any run of SHORT fragments ("f.u.c.k", "fu2ck"); chat joins
 * single letters with one separator between them ("s h i t").
 */
function segments(v, p, frags, handle) {
    const joins = (a, b) => {
        const la = a.end - a.start;
        const lb = b.end - b.start;
        if (handle) return la <= SHORT && lb <= SHORT;
        return la === 1 && lb === 1 && b.start === a.end + 1 && ' ._-'.includes(p.s[a.end]);
    };
    const out = [];
    let run = [];
    for (const f of frags) {
        if (run.length && !joins(run[run.length - 1], f)) { out.push(segmentOf(v, run)); run = []; }
        run.push(f);
    }
    if (run.length) out.push(segmentOf(v, run));
    return out;
}

/** Per index of `str`: inside an allowlisted word. */
function allowedMask(str) {
    const allowed = new Array(str.length).fill(NAMES.has(str));
    for (const pattern of ALLOW_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(str)) !== null) {
            for (let i = m.index; i < m.index + m[0].length; i++) allowed[i] = true;
        }
    }
    return allowed;
}

/** Matches of `patterns` in a segment not wholly inside an allowlisted word, as [start, end) in v. */
function* termMatches(seg, patterns) {
    const allowed = allowedMask(seg.str);
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(seg.str)) !== null) {
            const end = m.index + m[0].length;
            let inside = true;
            for (let i = m.index; i < end && inside; i++) inside = allowed[i];
            if (!inside) yield { start: seg.idx[m.index], end: seg.last[end - 1] + 1 };
        }
    }
}

/** Embedded-term matches in the leet view `v` of p. */
function* embeddedMatches(v, p, handle) {
    const frags = fragments(v, p, false);
    for (const seg of segments(v, p, frags, handle)) yield* termMatches(seg, EMBEDDED_PATTERNS);
    // compounds: the whole letter run, camelCase breaks ignored ("AssHole")
    const byWord = [];
    for (const f of frags) (byWord[f.word] = byWord[f.word] || []).push(f);
    for (const run of byWord) yield* termMatches(segmentOf(v, run), COMPOUND_PATTERNS);
    // and in a handle, across separators too ("Dick_Head")
    if (handle) yield* termMatches(segmentOf(v, frags), COMPOUND_PATTERNS);
}

/**
 * Replace banned words with asterisks, preserving the rest of the message
 * (and its length). An embedded term masks the whole word around it
 * ("fucking" → "*******"), minus punctuation and digits at the word's ends
 * ("shit!" → "****!"). Masking uses a char array so cost stays O(length) per
 * term, even for inputs packed with matches.
 * @param {string} text
 * @returns {string}
 */
function filterProfanity(text) {
    if (!text) return text;

    const p = prepare(text);
    const raw = p.s;
    const chars = text.split('');
    // [from, to) in p.s, so also the invisible characters inside it
    const mask = (from, to) => { for (let i = p.pos[from]; i <= p.pos[to - 1]; i++) chars[i] = '*'; };

    // Embedded terms: the leetspeak views hold every letter the raw text
    // has, so they find everything it would (1 read as i, then as l)
    for (const one of ['i', 'l']) {
        const variant = leet(p, one);
        const done = new Array(raw.length).fill(false);
        for (const { start, end } of embeddedMatches(variant, p, false)) {
            // already inside a word masked from this view ("fuckfuck..."): keeps this O(length)
            if (done[start]) continue;
            let from = start;
            let to = end;
            // the rest of the word, never across punctuation ("fuck!yeah" keeps "yeah")
            const inWord = (i) => isLetter(variant[i]) && isAlnum(raw[i]);
            while (from > 0 && inWord(from - 1)) from--;
            while (to < variant.length && inWord(to)) to++;
            for (let i = from; i < to; i++) done[i] = true;
            // the word's ends only where the text itself has letters ("shit5")
            while (from < start && !isLetter(raw[from])) from++;
            while (to > end && !isLetter(raw[to - 1])) to--;
            mask(from, to);
        }
    }

    // Word terms: whole words only, in all three views
    for (const variant of [raw, leet(p, 'i'), separate(p)]) {
        WORD_PATTERN.lastIndex = 0;
        let m;
        while ((m = WORD_PATTERN.exec(variant)) !== null) mask(m.index, m.index + m[0].length);
    }

    return chars.join('');
}

/**
 * Check whether chat-style text contains banned words: exactly when
 * filterProfanity would mask something.
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanity(text) {
    if (!text) return false;
    return filterProfanity(text) !== text;
}

/** A word term as a whole fragment of `v`, or of a run of short ones ("MrFag", "f.a.g"). */
function hasWordTerm(v, p) {
    const frags = fragments(v, p, true);
    for (let a = 0; a < frags.length; a++) {
        for (let b = a; b < frags.length; b++) {
            if (b > a && frags[b].end - frags[b].start > SHORT) break;
            if (WORD_EXACT.test(segmentOf(v, frags.slice(a, b + 1)).str)) return true;
            if (frags[a].end - frags[a].start > SHORT) break;
        }
    }
    return false;
}

/**
 * Stricter check for usernames/handles: an embedded term counts inside any
 * word of the handle (outside an allowlisted word), a word term as a whole
 * word of it.
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanitySubstring(text) {
    if (!text) return false;
    const p = prepare(String(text));
    for (const one of ['i', 'l']) {
        const v = leet(p, one);
        if (!embeddedMatches(v, p, true).next().done) return true;
        if (hasWordTerm(v, p)) return true;
    }
    return hasWordTerm(separate(p), p);
}

/** Leetspeak undone in a name (usernameRules' reserved names). */
function normalizeName(text, one) {
    let result = '';
    for (const c of String(text).toLowerCase()) result += c === '1' ? one : (SUBSTITUTIONS[c] || c);
    return result;
}

/**
 * The spellings usernameRules checks a handle against the reserved names
 * in: `joined` = letters only, `words` = split at separators, digits and
 * capitals. Leetspeak is undone with 1 as i and as l, plus a view with
 * every digit dropped ("Bot 3" is "bot", not "bote").
 * @param {string} name
 * @returns {{joined: string[], words: string[]}}
 */
function handleSpellings(name) {
    const split = String(name)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    const dropped = split.toLowerCase().replace(/[0-9$@!+]/g, ' ');
    const views = [normalizeName(split, 'i'), normalizeName(split, 'l'), dropped]
        .map(v => v.replace(/[^a-z]+/g, ' ').trim());
    const joined = [...new Set(views.map(v => v.replace(/ /g, '')))];
    const words = [...new Set(views.flatMap(v => v.split(' ')).filter(Boolean))];
    return { joined, words };
}

module.exports = {
    containsProfanity,
    containsProfanitySubstring,
    filterProfanity,
    handleSpellings,
    EMBEDDED_TERMS,
    COMPOUND_TERMS,
    WORD_TERMS,
    ALLOWLIST,
    ALLOWED_NAMES,
};
