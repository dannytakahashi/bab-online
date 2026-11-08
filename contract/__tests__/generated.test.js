/**
 * The generated files are up to date: what `npm run contract:gen` would write
 * (in memory) equals the committed events.schema.json, the web
 * events.js and the iOS SocketEvents.swift. Also checks the layout rules.
 */

const fs = require('fs');
const path = require('path');
const gen = require('../gen');
const { buildSchema } = require('../src');

const ROOT = path.join(__dirname, '..', '..');

test.each(Object.keys(gen.outputs()))('%s is up to date (run npm run contract:gen)', (rel) => {
    const expected = gen.outputs()[rel];
    const actual = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    expect(actual === expected).toBe(true);
});

describe('layout rules', () => {
    const layout = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'layout.json'), 'utf8'));
    const schema = buildSchema();

    test('the committed layout passes', () => {
        expect(gen.checkLayout(layout(), schema)).toEqual([]);
    });

    test('an unknown name, a missing active event and a new deprecated constant are refused', () => {
        const l = layout();
        l.web.CLIENT_EVENTS[0].events.push('notAnEvent');
        delete l.exclude.web.restoreSession;
        l.swift.Server[0].events.push('queueUpdate');
        const legacy = { web: [], swift: [] };
        const problems = gen.checkLayout(l, schema, legacy).join('\n');
        expect(problems).toMatch(/'notAnEvent' is not a c2s event/);
        expect(problems).toMatch(/active event 'restoreSession' is neither listed nor excluded/);
        expect(problems).toMatch(/'queueUpdate' is deprecated/);
    });

    test('the default web key covers CREATE_UI and the reconnect_* names', () => {
        expect(gen.defaultKey('createUI')).toBe('CREATE_UI');
        expect(gen.defaultKey('reconnect_attempt')).toBe('RECONNECT_ATTEMPT');
        expect(gen.defaultKey('signInResponse')).toBe('SIGN_IN_RESPONSE');
    });
});
