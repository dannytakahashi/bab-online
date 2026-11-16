'use strict';

/**
 * A deleted account's name hold (accountDelete.eraseAccount):
 * `{username, mergedInto: '[deleted]', deletedAt, nameHeldUntil}`. No
 * requires, so every admin tool can tell a hold from a merge tombstone
 * without a cycle (accountDelete -> setPassword).
 */

const DELETED_NAME = '[deleted]';

const isNameHold = (doc) => Boolean(doc && doc.mergedInto === DELETED_NAME && doc.deletedAt);

/**
 * The refusal for an admin action on a held name. Merge tombstones say
 * "act on <mergedInto> instead"; for a hold that would name "[deleted]".
 */
function heldNameRefusal(username, doc, what) {
    const until = doc.nameHeldUntil instanceof Date && !Number.isNaN(doc.nameHeldUntil.getTime())
        ? ` until ${doc.nameHeldUntil.toISOString().slice(0, 10)}` : '';
    return `"${username}" was deleted (its name is held${until}): there is no account to ${what}.`;
}

/** Projection fields heldNameRefusal needs, for reads that project. */
const HOLD_FIELDS = Object.freeze({ deletedAt: 1, nameHeldUntil: 1 });

module.exports = { DELETED_NAME, isNameHold, heldNameRefusal, HOLD_FIELDS };
