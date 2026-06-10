/**
 * Basic profanity filter for user-generated text (chat messages, usernames,
 * lobby names). Required for App Store Guideline 1.2 (UGC apps must filter
 * objectionable content).
 *
 * Matching runs against three views of the input so common evasions are
 * caught while indices stay aligned for masking:
 *   raw        — catches plain words and words touching punctuation ("shit!")
 *   normalized — leetspeak undone ("sh1t" → "shit")
 *   separated  — substitution chars as spaces ("shit5" → "shit ", since a
 *                trailing digit is a word character and defeats \b otherwise)
 *
 * Word-boundary matching avoids the classic false positives ("class",
 * "assassin", "Scunthorpe") in chat. Usernames additionally use
 * containsProfanitySubstring, which embeds-matches only unambiguous slurs so
 * real names like "Torpedo" or "Spice" aren't rejected.
 */

const BANNED_WORDS = [
    'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dickhead', 'cocksucker',
    'motherfucker', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'whore',
    'slut', 'twat', 'wanker', 'prick', 'pussy', 'kike', 'spic', 'chink',
    'wetback', 'tranny', 'dyke', 'rape', 'rapist', 'pedo', 'pedophile',
    'nazi', 'hitler', 'kys'
];

// Long/unambiguous terms that should be rejected in usernames even when
// embedded in a longer handle. Deliberately excludes short words that appear
// inside ordinary English ("pedo" in Torpedo, "spic" in Spice, "rape" in
// Grape, "twat" in Atwater, ...).
const EMBEDDED_BLOCKLIST = [
    'nigger', 'nigga', 'faggot', 'motherfucker', 'cocksucker', 'pedophile'
];

// Map common letter substitutions back to letters before matching
const SUBSTITUTIONS = {
    '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a',
    '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b'
};

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
function normalize(text) {
    const lower = alignedLowercase(text);
    let result = '';
    for (let i = 0; i < lower.length; i++) {
        result += SUBSTITUTIONS[lower[i]] || lower[i];
    }
    return result;
}

/** Substitution chars treated as separators (catches "shit5", "fuck1"). */
function separate(text) {
    const lower = alignedLowercase(text);
    let result = '';
    for (let i = 0; i < lower.length; i++) {
        result += SUBSTITUTIONS[lower[i]] ? ' ' : lower[i];
    }
    return result;
}

const WORD_PATTERNS = BANNED_WORDS.map(word => new RegExp(`\\b${word}\\b`, 'i'));

/**
 * Check whether text contains banned words (word-boundary matching, suited
 * to prose like chat messages).
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanity(text) {
    if (!text) return false;
    const variants = [text, normalize(text), separate(text)];
    return WORD_PATTERNS.some(pattern => variants.some(v => pattern.test(v)));
}

/**
 * Stricter check for usernames/handles: unambiguous slurs count even when
 * embedded in a longer string, everything else at word boundaries.
 * @param {string} text
 * @returns {boolean}
 */
function containsProfanitySubstring(text) {
    if (!text) return false;
    const normalized = normalize(text);
    if (EMBEDDED_BLOCKLIST.some(word => normalized.includes(word))) {
        return true;
    }
    return containsProfanity(text);
}

/**
 * Replace banned words with asterisks, preserving the rest of the message.
 * Masking uses a char array so cost stays O(length), even for inputs packed
 * with matches.
 * @param {string} text
 * @returns {string}
 */
function filterProfanity(text) {
    if (!text) return text;

    // All three variants are 1:1 with the input, so match indices align
    const variants = [text, normalize(text), separate(text)];
    const chars = text.split('');

    for (const word of BANNED_WORDS) {
        const pattern = new RegExp(`\\b${word}\\b`, 'gi');
        for (const variant of variants) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(variant)) !== null) {
                for (let i = match.index; i < match.index + match[0].length; i++) {
                    chars[i] = '*';
                }
            }
        }
    }

    return chars.join('');
}

module.exports = { containsProfanity, containsProfanitySubstring, filterProfanity };
