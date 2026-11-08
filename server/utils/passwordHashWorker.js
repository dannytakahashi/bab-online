/**
 * worker_threads side of server/utils/passwordHash.js: runs bcryptjs (pure
 * JS, same $2a$/$2b$ format as before) off the main event loop.
 * Message in: { id, op: 'compare'|'hash', a, b }.
 * Message out: { id, r } or { id, err } (the error message).
 */

const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, op, a, b }) => {
    try {
        let r;
        if (op === 'compare') r = bcrypt.compareSync(a, b);
        else if (op === 'hash') r = bcrypt.hashSync(a, b);
        else throw new Error(`Unknown op ${op}`);
        parentPort.postMessage({ id, r });
    } catch (error) {
        parentPort.postMessage({ id, err: error && error.message ? error.message : String(error) });
    }
});
