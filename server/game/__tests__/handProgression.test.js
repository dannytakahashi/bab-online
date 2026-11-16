/**
 * rules.HAND_PROGRESSION / nextHandSize: the one server copy of the deal
 * sizes, and the web / iOS copies held to it.
 */

const fs = require('fs');
const path = require('path');
const { HAND_PROGRESSION, nextHandSize, MAX_HAND_SIZE } = require('../rules');
const { HAND_SEQUENCE } = require('../snapshotV2');

const ROOT = path.join(__dirname, '..', '..', '..');

// The branch handleHandComplete used before nextHandSize (pure refactor)
function legacyNext(h) {
    if (h === 2) return 1;
    if (h === 1) return 3;
    if (h === 13) return 0;
    return h % 2 === 0 ? h - 2 : h + 2;
}

const parseList = (text) => text.split(',').map((n) => Number(n.trim()));

describe('HAND_PROGRESSION and nextHandSize', () => {
    test('the 13 deals of docs/RULES.md, each size once, ending on the largest', () => {
        expect(HAND_PROGRESSION).toEqual([12, 10, 8, 6, 4, 2, 1, 3, 5, 7, 9, 11, 13]);
        expect(new Set(HAND_PROGRESSION).size).toBe(13);
        expect(HAND_PROGRESSION[HAND_PROGRESSION.length - 1]).toBe(MAX_HAND_SIZE);
        expect(Object.isFrozen(HAND_PROGRESSION)).toBe(true);
        expect(HAND_SEQUENCE).toBe(HAND_PROGRESSION);
    });

    test('walks the progression and ends after 13, as the old branch did', () => {
        for (let h = 1; h <= 13; h++) expect(nextHandSize(h)).toBe(legacyNext(h));
        const walked = [12];
        while (nextHandSize(walked[walked.length - 1]) !== 0) walked.push(nextHandSize(walked[walked.length - 1]));
        expect(walked).toEqual([...HAND_PROGRESSION]);
    });

    test('a size no deal has ends the game (0) instead of inventing one', () => {
        for (const h of [0, -1, 14, 2.5, '12', null, undefined]) expect(nextHandSize(h)).toBe(0);
    });

    test('the web and iOS copies are the same list', () => {
        const web = fs.readFileSync(path.join(ROOT, 'client/src/constants/ranks.js'), 'utf8');
        const webList = /export const HAND_PROGRESSION = \[([^\]]+)\]/.exec(web);
        expect(webList).not.toBeNull();
        expect(parseList(webList[1])).toEqual([...HAND_PROGRESSION]);

        const swift = fs.readFileSync(path.join(ROOT, 'iOSClient/BABOnline/Constants/CardConstants.swift'), 'utf8');
        const swiftList = /static let handProgression = \[([^\]]+)\]/.exec(swift);
        expect(swiftList).not.toBeNull();
        expect(parseList(swiftList[1])).toEqual([...HAND_PROGRESSION]);

        const table = fs.readFileSync(path.join(ROOT, 'iOSClient/BABOnline/State/Table/TableTypes.swift'), 'utf8');
        const handSequence = /enum HandSequence \{\s*static let sizes = \[([^\]]+)\]/.exec(table);
        expect(handSequence).not.toBeNull();
        expect(parseList(handSequence[1])).toEqual([...HAND_PROGRESSION]);
    });
});
