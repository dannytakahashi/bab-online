/**
 * Table-driven cases for the tightened filter (2026-11-15): handles are
 * normalized (case, leetspeak, separators, digits, repeated letters) and
 * every term is matched inside them; chat catches inflections; ordinary
 * words and names (the allowlist and names with no term at all) pass; the
 * reserved names are refused at sign-up, case-insensitively. Review fixes
 * (same day): a term only counts inside one word, so real names and
 * name-plus-number handles pass ("Matt Watson", "Josh17", "Ishita").
 */

const {
    containsProfanity, containsProfanitySubstring, filterProfanity, EMBEDDED_TERMS, WORD_TERMS, ALLOWLIST, ALLOWED_NAMES,
} = require('../profanityFilter');
const { checkNewUsername, isReservedName, RESERVED_NAMES, RESERVED_PLURALS, MESSAGES } = require('../usernameRules');

// Every term, plain, as a handle
const EVERY_TERM = [...EMBEDDED_TERMS, ...Object.keys(WORD_TERMS)];

describe('usernames: blocked', () => {
    test.each(EVERY_TERM)('the term itself: %p', (term) => {
        expect(containsProfanitySubstring(term)).toBe(true);
        expect(containsProfanitySubstring(term.toUpperCase())).toBe(true);
    });

    test.each([
        // the sign-ups that used to pass (2026-11-15 report)
        'fuckyou', 'shithead', 'fuck_you', 'xXfuckXx', 'BigNazi88', 'rapist_joe',
        // separators and case
        'f.u.c.k', 'F-U-C-K', 'Shit Lord', 'sh_it', 'b.i.t.c.h', 'MrFag', 'Mr Fag', 'Big_Spic', 'TheRapist',
        // leetspeak: 0 o, 1 i/l, 3 e, 4 a, 5 s, 7 t, 8 b
        'sh1thead', '5hit', 'a55hole', 'assho1e', 'n1gg3r', 'f4ggot', 'h1tl3r', 'n4zi', 'b1tch', 'wh0re', 'sh17', 'r4pist', 'cun7', '8itch',
        // digits that are not leetspeak, and trailing numbers
        'fu2ck', 'nazi1488', 'pedo69', 'rape4u', 'kys2', 'shit5',
        // repeated letters
        'fuuuuck', 'shiiiit', 'niggggger', 'NAAAZI', 'biiitch',
        // embedded anywhere
        'xXmotherfucker99', 'bullshitter', 'superfucker', 'mrcunt', 'lilslut', 'kidpedophile', 'pedophiles', 'heilhitler',
        // plurals of the word-only terms
        'Spics Rule', 'fags', 'pricks4life',
        // random capitals are not a camelCase break; compounds count across one
        'FuCking', 'NiGger', 'ReTarded', 'nIGGER', 'ShItHead', 'sHiT', 'FUCKing', 'AssHole', 'DickHead', 'Dick_Head',
        'Ass Hole', 'MotherFucker', 'TwAt',
        // a trailing number that finishes a term begun at the word's start
        'BigSh17',
        // a name on ALLOWED_NAMES only as itself
        'shitall', 'Ishitaa', 'Trannies',
    ])('%p', (name) => {
        expect(containsProfanitySubstring(name)).toBe(true);
    });
});

describe('usernames: allowed', () => {
    test.each(ALLOWLIST)('allowlisted word: %p', (word) => {
        expect(containsProfanitySubstring(word)).toBe(false);
    });

    test.each(ALLOWED_NAMES)('allowed name: %p', (name) => {
        expect(containsProfanitySubstring(name)).toBe(false);
        expect(containsProfanitySubstring(name[0].toUpperCase() + name.slice(1) + '22')).toBe(false);
    });

    test.each([
        // a term across two words of a real name (review 2026-11-15: these were refused)
        'Matt Watson', 'Brett Watkins', 'Scott Watts', 'Kurt Watanabe', 'James Luther', 'Wes Luther', 'Charles Lutz',
        'Russ Lutz', 'Hanna Ziegler', 'Anna Zinn', 'Dana Zito', 'Tina Zimmerman', 'Josh Ito', 'Marc Unterberg',
        'Bob Itch', 'Stewart Watt', 'MattWatson', 'JoshIto', 'AnnaZito',
        // a name and a number: the number is not leetspeak
        'Josh17', 'Ash17', 'Krish17', 'Manish17', 'Ashish17', 'Satish17', 'Harshit99',
        // names with a term inside (ALLOWED_NAMES) and ordinary words
        'Ishita', 'Nishita', 'Kshitij', 'Shital', 'Nazila', 'Pussycat', 'Retardation', 'Niggardly',
        // the Scunthorpe problem: a term inside an ordinary word or name
        'Scunthorpe', 'Therapist', 'Therapists', 'Atwater', 'Saltwater', 'Shiitake', 'Shitake', 'Mishit', 'Yamashita',
        'Kinoshita', 'Ashkenazi', 'Nazir', 'Snigger', 'Retardant',
        // word-only terms inside longer words
        'Grape', 'Grape123', 'Drape', 'Scraper', 'Therapeutic', 'Torpedo', 'Speedo', 'Pedometer', 'Spice', 'SpicyTaco',
        'Hospice', 'Auspicious', 'Fagan', 'Prickly', 'Luckystar', 'Skys the limit',
        // no term at all, however rude the shape looks
        'Dickens', 'Hancock', 'Sussex', 'Cocktail', 'Assassin', 'Class', 'Classic', 'Bassist', 'Cockpit', 'Peacock',
        'Shuttlecock', 'Matsuda', 'Penistone', 'Nigeria', 'Niger', 'Pass', 'Assume', 'Scrap',
        // fixture and production-style names
        'test1', 'alan', 'Alan T', 'Alan B', 'JoAnn Jameson', 'Danny', 'Bob', 'bob', 'cardshark42', 'alice', 'mary_2',
        'Jo-Ann', 'J.R. Smith', '007', 'abc', 'Acct One', 'Fresh Name', 'Mary', 'Sharon', 'Mike', 'Zach', 'user1',
    ])('%p', (name) => {
        expect(containsProfanitySubstring(name)).toBe(false);
    });
});

describe('chat: inflections caught', () => {
    test.each([
        ['fucking hell', '******* hell'],
        ['what a fucker', 'what a ******'],
        ['shitty hand', '****** hand'],
        ['bullshit', '********'],
        ['motherfucking bots', '************* bots'],
        ['fucked it up', '****** it up'],
        ['shits and giggles', '***** and giggles'],
        ['such a bitchy bid', 'such a ****** bid'],
        ['retarded play', '******** play'],
        ['sluts', '*****'],
        ['nazis', '*****'],
        ['pedophilia', '**********'],
        ['he raped me', 'he ***** me'],
        ['raping', '******'],
        ['rapes', '*****'],
        ['fags', '****'],
        ['pricks', '******'],
        ['dykes', '*****'],
        // evasions
        ['fuuuuck', '*******'],
        ['sh1tty', '******'],
        ['fuck1ng', '*******'],
        ['$hit', '****'],
        ['a$$hole', '*******'],
        ['assho1e', '*******'],
        ['h1tler', '******'],
        // the word only, never the punctuation or numbers around it
        ['shit!', '****!'],
        ['shit5', '****5'],
        ['fuck!yeah', '****!yeah'],
        ['(fucking)', '(*******)'],
        ['FUCKING', '*******'],
        ['fuckfuckfuck', '************'],
        // random capitals and compounds
        ['FuCking hell', '******* hell'],
        ['AssHole', '*******'],
        ['MotherFucker', '************'],
        ['fucker99', '******99'],
        // spelled out
        ['f.u.c.k off', '******* off'],
        ['s h i t', '*******'],
        ['f-u-c-k', '*******'],
        // invisible characters, accents, fullwidth letters and lookalikes
        ['fu\u200Bck', '*****'],
        ['fu\u0301ck', '*****'],
        ['f\u00FCck', '****'],
        ['\uFF46\uFF55\uFF43\uFF4B you', '**** you'],
        ['fu\u0441k', '****'],
        ['\u0455hit', '****'],
        ['Trannies', '********'],
    ])('%p -> %p', (input, masked) => {
        expect(filterProfanity(input)).toBe(masked);
        expect(containsProfanity(input)).toBe(true);
    });
});

describe('chat: ordinary words untouched', () => {
    test.each([
        'the class assassin passed',
        'I assume you pass',
        'scrap that',
        'grape scrape drape',
        'my therapist says bid 3',
        'therapeutic',
        'shiitake soup',
        'Scunthorpe United',
        'cocktail',
        'Dickens, Hancock, Sussex',
        'spicy hospice torpedo speedo',
        'prickly pear',
        'saltwater Atwater',
        'Ashkenazi',
        'Grape5',
        'I bid 5',
        'I have 5 spades and $100',
        'good game everyone',
        'nice hand, partner!',
        'Mississippi bass classic',
        'a mishit',
        'push it',
        'this hit',
        'Niger and Nigeria',
        'skys the limit, lucky star',
        // names in chat, and names with a number (review 2026-11-15: these were masked)
        'Ishita played well',
        'Kshitij is here',
        'gg Josh17 and Manish17',
        'MattWatson bid 4',
        'Harshit says hi',
        'pussycat dolls',
        'growth retardation',
        'I a m here, a b c',
        'café naïve',
        'привет всем',
    ])('%p', (input) => {
        expect(filterProfanity(input)).toBe(input);
        expect(containsProfanity(input)).toBe(false);
    });

    test('masking keeps the length and is linear on a long packed message', () => {
        const packed = 'fuck'.repeat(5000) + ' ' + 'shit!'.repeat(2000);
        const t0 = Date.now();
        const out = filterProfanity(packed);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(out).toHaveLength(packed.length);
        expect(out).not.toMatch(/fuck|shit/);
    });

    test('a long run of one letter stays linear too (the f+u+c+k+ patterns would backtrack over it)', () => {
        const t0 = Date.now();
        expect(filterProfanity('f'.repeat(30000))).toBe('f'.repeat(30000));
        expect(filterProfanity('n'.repeat(30000) + 'igger')).toBe('*'.repeat(30005));
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

describe('reserved names', () => {
    test.each([...RESERVED_NAMES, ...RESERVED_PLURALS])('%p is refused in any case', (name) => {
        for (const spelled of [name, name.toUpperCase(), name[0].toUpperCase() + name.slice(1)]) {
            expect(isReservedName(spelled)).toBe(true);
            expect(checkNewUsername(spelled)).toMatchObject({ ok: false, reason: 'reserved', message: MESSAGES.reserved });
        }
    });

    test.each([
        'sYsTeM', 'Sys tem', 'Syyystem', '5ystem', 'System1', 'Adm1n', 'admin2', 'ADMIN', 'Admin_', 'Bot 2', 'B0T',
        'bot99', 'Mod5', 'M0derator', 'Official_Support', 'BabOnline Staff', 'Bab Online', 'BAB_ONLINE', 'bab.online',
        'nu11', 'Null', 'UNDEFINED', 'Support Staff', 'SystemAdmin', 'ServerBot', 'Population',
        // staff plurals, official-sounding words around one, lookalikes (review 2026-11-15)
        'Admins', 'Mods', 'Bots', 'Moderators', 'Admin Team', 'Mod Squad', 'System Notice', 'The System', 'Real Admin',
        'Help Desk Bot', 'Admln', 'Systern', 'B a b 0nline',
    ])('%p (normalized, or several run together)', (name) => {
        expect(checkNewUsername(name)).toMatchObject({ ok: false, reason: 'reserved' });
    });

    test.each([
        // only the whole name counts, never a part of it
        'Bobcat', 'Model', 'Modern', 'Babs', 'Babe Ruth', 'Systems Guy', 'Admiral', 'Support Bob', 'Botany', 'Abbot',
        'Serverus', 'Nullify', 'Staffy', 'Officially Al',
        // the qualifier words alone, or with an ordinary name
        'Help Desk', 'The Team', 'Theo', 'Theodore', 'Teamster', 'Modest', 'Real Bob', 'Alert', 'Abbots', 'Notice Me',
        'Bobs', 'Liam', 'Ella', 'Delia', 'Molly',
        // the Apple review account and other fixture names
        'test1', 'Bob', '007', 'abc', 'Mary', 'Danny', 'Alan T',
    ])('%p is not reserved', (name) => {
        expect(isReservedName(name)).toBe(false);
        expect(checkNewUsername(name)).toEqual({ ok: true });
    });
});
