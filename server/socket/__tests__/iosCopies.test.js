/**
 * Server reply texts the iOS client compares against (iOS 1.2.2). The replies carry no
 * code, so the app matches the words: changing one here without the Swift copy turns a
 * bot's "No Profile" into a generic failure, or stops the as-typed password resend.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const swiftString = (source, name) => {
    const m = source.match(new RegExp(`static let ${name} = "([^"]*)"`));
    return m ? m[1] : null;
};

describe('reply texts iOS matches on', () => {
    const auth = read('server/socket/authHandlers.js');
    const profile = read('server/socket/profileHandlers.js');
    const rules = read('iOSClient/BABOnline/State/AccountRules.swift');
    const profileState = read('iOSClient/BABOnline/State/ProfileState.swift');

    test('signInResponse: wrong name or password', () => {
        const text = swiftString(rules, 'signInRefused');
        expect(text).toBe('Invalid username or password!');
        expect(auth).toContain(`message: '${text}'`);
    });

    test('changePasswordResponse: wrong current password', () => {
        const text = swiftString(rules, 'wrongCurrentPassword');
        expect(text).toBeTruthy();
        expect(auth).toContain(`const WRONG_CURRENT_PASSWORD_MESSAGE = '${text}';`);
    });

    test('playerProfileResponse: no such player', () => {
        const text = swiftString(profileState, 'playerNotFound');
        expect(text).toBe('Player not found');
        expect(profile).toContain(`message: '${text}'`);
    });
});
