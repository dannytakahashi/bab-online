/**
 * Unit tests for the profanity filter applied to chat, usernames, and
 * lobby names.
 */

const { containsProfanity, containsProfanitySubstring, filterProfanity } = require('../profanityFilter');

describe('profanityFilter', () => {
    describe('containsProfanity', () => {
        test('detects banned words case-insensitively', () => {
            expect(containsProfanity('what the FUCK')).toBe(true);
            expect(containsProfanity('Shit happens')).toBe(true);
        });

        test('detects common leetspeak substitutions', () => {
            expect(containsProfanity('sh1t')).toBe(true);
            expect(containsProfanity('fuck')).toBe(true);
            expect(containsProfanity('b!tch')).toBe(true);
        });

        test('does not flag clean text', () => {
            expect(containsProfanity('nice hand, partner!')).toBe(false);
            expect(containsProfanity('')).toBe(false);
            expect(containsProfanity(null)).toBe(false);
        });

        test('avoids classic substring false positives', () => {
            expect(containsProfanity('the class assassin passed')).toBe(false);
            expect(containsProfanity('Scunthorpe United')).toBe(false);
        });

        test('catches banned words adjacent to substitution characters', () => {
            // '!' normalizes to 'i', merging into the word — the raw-text
            // pass must still catch it
            expect(containsProfanity('shit!')).toBe(true);
            expect(containsProfanity('what the fuck!')).toBe(true);
        });

        test('catches banned words with trailing/leading digits', () => {
            // digits are word characters AND leetspeak sources — the
            // separator pass must still catch these
            expect(containsProfanity('shit5')).toBe(true);
            expect(containsProfanity('fuck1')).toBe(true);
        });

        test('does not flag ordinary messages containing digits', () => {
            expect(containsProfanity('I bid 5')).toBe(false);
            expect(containsProfanity('I have 5 spades and $100')).toBe(false);
            expect(containsProfanity('Grape5')).toBe(false);
        });
    });

    describe('containsProfanitySubstring', () => {
        test('catches unambiguous slurs embedded in usernames', () => {
            expect(containsProfanitySubstring('xXmotherfucker99')).toBe(true);
        });

        test('catches word-boundary profanity in usernames', () => {
            expect(containsProfanitySubstring('shit.lord')).toBe(true);
            expect(containsProfanitySubstring('mr-fuck')).toBe(true);
            expect(containsProfanitySubstring('shit5')).toBe(true);
        });

        test('accepts real-world names containing banned substrings', () => {
            expect(containsProfanitySubstring('Torpedo')).toBe(false);
            expect(containsProfanitySubstring('Spice')).toBe(false);
            expect(containsProfanitySubstring('Therapist')).toBe(false);
            expect(containsProfanitySubstring('Grape123')).toBe(false);
            expect(containsProfanitySubstring('Atwater')).toBe(false);
            expect(containsProfanitySubstring('Scunthorpe')).toBe(false);
        });

        test('accepts normal usernames', () => {
            expect(containsProfanitySubstring('cardshark42')).toBe(false);
            expect(containsProfanitySubstring('alice')).toBe(false);
            expect(containsProfanitySubstring('')).toBe(false);
        });
    });

    describe('filterProfanity', () => {
        test('masks banned words but keeps the rest of the message', () => {
            expect(filterProfanity('what the fuck was that')).toBe('what the **** was that');
        });

        test('masks multiple occurrences', () => {
            const result = filterProfanity('shit shit');
            expect(result).toBe('**** ****');
        });

        test('masks leetspeak variants', () => {
            expect(filterProfanity('sh1t happens')).toBe('**** happens');
        });

        test('masks words adjacent to substitution characters', () => {
            expect(filterProfanity('shit!')).toBe('****!');
        });

        test('masks words with trailing digits', () => {
            expect(filterProfanity('shit5')).toBe('****5');
        });

        test('mask length always equals input length', () => {
            const inputs = ['shit!', 'sh1t', 'what the fuck was that', 'b!tch b!tch'];
            for (const input of inputs) {
                expect(filterProfanity(input)).toHaveLength(input.length);
            }
        });

        test('leaves clean messages untouched', () => {
            expect(filterProfanity('good game everyone')).toBe('good game everyone');
        });

        test('handles empty input', () => {
            expect(filterProfanity('')).toBe('');
            expect(filterProfanity(null)).toBe(null);
        });
    });
});
