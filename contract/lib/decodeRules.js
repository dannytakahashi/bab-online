/**
 * The two named exceptions to the decode floors (contract/baselines/), shared
 * by additiveOnly.test.js and the release step (contract/baseline.js) so both
 * report the same thing. Paths are checkDecodes paths ('event.key[].key').
 * Keep both short.
 */

'use strict';

/**
 * Mismatches that cannot reach iOS, with why. One applies to every frozen
 * build that has the mismatch; additiveOnly.test.js fails a waiver that no
 * frozen build needs any more.
 */
const DECODE_WAIVED = {
    'stateSnapshot.requestId': 'the echo of the asking socket\'s own requestSnapshot.requestId (snapshotHandlers.js copies req.requestId; the reply goes to the asker only), and every iOS build sends a String (GameEmitter.requestSnapshot(requestId: String)); the integer branch is web\'s',
};

/**
 * Properties a build decodes as optional but needs once another key goes:
 * it reads them first and falls back to a key a V1_REMOVALS entry plans to
 * drop. They were added after the build was cut, so its schema baseline does
 * not hold them either. For the listed builds they must stay required and
 * non-null, as if the Swift property were not optional. Drop a build from
 * `builds` when it is retired; additiveOnly.test.js fails an entry with no
 * frozen build left.
 */
const DECODE_RELIED = {
    'positionUpdate.isBot': {
        builds: [6, 7, 8],
        why: 'bot or human per seat: isBot first, the bot: prefix of positionUpdate.sockets only as the fallback (TableReducer+Events.swift:252 at 83a3f8f); V1_REMOVALS #14 drops sockets next, after which isBot is the only signal. isBot reached main (b1304c1) after 6, 7 and 8 were cut',
    },
};

/** DECODE_RELIED for one build: {path: why}. */
const reliedFor = (build) => Object.fromEntries(Object.entries(DECODE_RELIED)
    .filter(([, r]) => r.builds.includes(build)).map(([where, r]) => [where, r.why]));

module.exports = { DECODE_WAIVED, DECODE_RELIED, reliedFor };
