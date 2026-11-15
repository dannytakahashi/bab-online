/**
 * Basic profanity filter for user-generated text (chat messages, usernames,
 * lobby names). Required for App Store Guideline 1.2 (UGC apps must filter
 * objectionable content). The list is unambiguous slurs and profanity only.
 *
 * Two kinds of term:
 *   EMBEDDED_TERMS  never part of an ordinary word, so they count anywhere:
 *                   inside a handle ("xXfuckXx", "BigNazi88") and inside a
 *                   chat word, which masks the whole word ("fucking",
 *                   "bullshit", "shitty"). Ordinary words and names that do
 *                   contain one are in ALLOWLIST (the Scunthorpe problem).
 *   WORD_TERMS      short ones that sit inside common words ("spic" in
 *                   spice / hospice, "rape" in grape / scrape / therapeutic,
 *                   "pedo" in torpedo / speedo, "fag" in Fagan): only a whole
 *                   word counts, in its listed forms ("rapes", "raping").
 * Every letter of a term also matches a run of itself ("fuuuck").
 *
 * Chat matching runs against three views of the input so common evasions
 * are caught while indices stay aligned for masking:
 *   raw        — catches plain words and words touching punctuation ("shit!")
 *   normalized — leetspeak undone ("sh1t" → "shit")
 *   separated  — substitution chars as spaces ("rape5" → "rape ", since a
 *                trailing digit is a word character and defeats \b otherwise)
 *
 * Usernames (containsProfanitySubstring) are normalized harder, since a
 * handle has no spaces to lean on: lowercased, leetspeak undone (1 read as
 * both i and l), separators and other digits dropped for the embedded terms,
 * and split into words at separators, digits and capitals ("BigNazi88" →
 * big / nazi) for the word terms. Names that contain no term at all pass
 * untouched: Dickens, Hancock, Sussex, Cocktail, Assassin, Class.
 */

const EMBEDDED_TERMS = [
    'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dickhead', 'cocksucker',
    'motherfucker', 'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
    'twat', 'wanker', 'pussy', 'wetback', 'tranny', 'rapist',
    // the stem, so pedophiles / pedophilia count too
    'pedophil',
    'nazi', 'hitler'
];

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
// inside one of these does not count. Kept to whole words (not fragments
// like "shita"), so "bullshitarmy" cannot hide behind one.
const ALLOWLIST = [
    'scunthorpe',                                  // cunt
    'therapist',                                   // rapist
    'twater',                                      // twat: Atwater, saltwater, meltwater
    'snigger',                                     // nigger
    'retardant',                                   // retard
    'shiitake', 'shitake', 'mishit',               // shit
    'yamashita', 'kinoshita', 'matsushita', 'morishita', 'yoshitaka', 'toshitaka',
    'ashkenazi', 'nazir', 'nazim', 'nazia',        // nazi: Arabic / Urdu names
    'pussyfoot', 'pussywillow',                    // pussy
];

// Map common letter substitutions back to letters before matching
const SUBSTITUTIONS = {
    '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a',
    '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b'
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "fuck" -> f+u+c+k+ : a letter may repeat ("fuuuck"); a doubled letter in
// the term stays required ("nigger" is not "Niger")
const tolerant = (word) => word.split('').map(c => `${escapeRegex(c)}+`).join('');

const EMBEDDED_PATTERNS = EMBEDDED_TERMS.map(word => new RegExp(tolerant(word), 'g'));
const ALLOW_PATTERNS = ALLOWLIST.map(word => new RegExp(tolerant(word), 'g'));
const WORD_FORMS = Object.values(WORD_TERMS).flat();
const WORD_PATTERN = new RegExp(`\\b(?:${WORD_FORMS.map(tolerant).join('|')})\\b`, 'g');
const WORD_EXACT = new RegExp(`^(?:${WORD_FORMS.map(tolerant).join('|')})$`);
const EMBEDDED_EXACT = new RegExp(`^(?:${EMBEDDED_TERMS.map(tolerant).join('|')})s?$`);

const isLetter = (c) => c >= 'a' && c <= 'z';
const isAlnum = (c) => isLetter(c) || (c >= '0' && c <= '9');

/**
 * Lowercase the text strictly one output unit per input unit so match
 * indices stay aligned with the original string. (Full-string toLowerCase()
 * can change length for some Unicode, e.g. 'İ' → 'i̇'.)
 */
function alignedLowercase(text) {
    let result = '';
    for (let i = 0; i < text.length; i++) {
        const lower = text[i].toLowerCase();
        result += lower.length === 1 ? lower : text[i];
    }
    return result;
}

/** Leetspeak undone: substitution chars become their letter. */
function normalize(text, one = 'i') {
    const lower = alignedLowercase(text);
    let result = '';
    for (let i = 0; i < lower.length; i++) {
        result += lower[i] === '1' ? one : (SUBSTITUTIONS[lower[i]] || lower[i]);
    }
    return result;
}

/** Substitution chars treated as separators (catches "rape5", "fag1"). */
function separate(text) {
    const lower = alignedLowercase(text);
    let result = '';
    for (let i = 0; i < lower.length; i++) {
        result += SUBSTITUTIONS[lower[i]] ? ' ' : lower[i];
    }
    return result;
}

/** Per index of `text`: inside an allowlisted word. */
function allowedMask(text) {
    const allowed = new Array(text.length).fill(false);
    for (const pattern of ALLOW_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            for (let i = m.index; i < m.index + m[0].length; i++) allowed[i] = true;
        }
    }
    return allowed;
}

/** Embedded-term matches in `text` not wholly inside an allowlisted word. */
function* embeddedMatches(text) {
    const allowed = allowedMask(text);
    for (const pattern of EMBEDDED_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            const end = m.index + m[0].length;
            let inside = true;
            for (let i = m.index; i < end && inside; i++) inside = allowed[i];
            if (!inside) yield { start: m.index, end };
        }
    }
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

    // Every variant is 1:1 with the input, so match indices align
    const raw = alignedLowercase(text);
    const chars = text.split('');
    const mask = (from, to) => { for (let i = from; i < to; i++) chars[i] = '*'; };

    // Embedded terms: the leetspeak views hold every letter the raw text
    // has, so they find everything it would (1 read as i, then as l)
    for (const one of ['i', 'l']) {
        const variant = normalize(text, one);
        const done = new Array(text.length).fill(false);
        for (const { start, end } of embeddedMatches(variant)) {
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
    const normalized = normalize(text);
    for (const variant of [raw, normalized, separate(text)]) {
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

/**
 * The spellings a handle is checked under (usernameRules' reserved names
 * use them too): `joined` = letters only, `words` = split at separators,
 * digits and capitals. Leetspeak is undone with 1 as i and as l, plus a
 * view with every digit dropped ("Bot 3" is "bot", not "bote").
 * @param {string} name
 * @returns {{joined: string[], words: string[]}}
 */
function handleSpellings(name) {
    const split = String(name)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    const views = [normalize(split, 'i'), normalize(split, 'l'), separate(split)]
        .map(v => v.replace(/[^a-z]+/g, ' ').trim());
    const joined = [...new Set(views.map(v => v.replace(/ /g, '')))];
    const words = [...new Set(views.flatMap(v => v.split(' ')).filter(Boolean))];
    return { joined, words };
}

/**
 * Stricter check for usernames/handles: an embedded term counts anywhere
 * in the handle (outside an allowlisted word), a word term as a whole word
 * of it.
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanitySubstring(text) {
    if (!text) return false;
    const { joined, words } = handleSpellings(text);
    for (const spelling of joined) {
        if (!embeddedMatches(spelling).next().done) return true;
    }
    // a whole word of the handle may also be an embedded term that an
    // allowlisted word hid when joined ("TheRapist" is the + rapist)
    return words.some(word => WORD_EXACT.test(word) || EMBEDDED_EXACT.test(word));
}

module.exports = {
    containsProfanity,
    containsProfanitySubstring,
    filterProfanity,
    handleSpellings,
    EMBEDDED_TERMS,
    WORD_TERMS,
    ALLOWLIST,
};
