/**
 * An expected refusal from an admin action: `code` goes on the wire
 * (adminResponse.error), `message` is shown to the ADMIN as is. Only ever
 * sent to a socket that passed the admin check, so it may name accounts.
 *
 * Codes: not_found, refused, last_admin, stale_plan, invalid.
 */

'use strict';

class AdminError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AdminError';
        this.code = code;
    }
}

module.exports = { AdminError };
