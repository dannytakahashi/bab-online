/**
 * HTTP response compression (gzip / brotli) for the Express app.
 *
 * Only Express responses pass through here: Socket.IO's engine.io answers
 * /socket.io/ requests (and WebSocket upgrades) on the http.Server before
 * Express sees them, so the socket wire is untouched. compressible types
 * only (HTML, JS, CSS, JSON, SVG, text); images such as the /avatar WebP/PNG
 * and the card art are sent as before, and responses under 1 kB are not
 * compressed.
 *
 * Brotli quality 5 instead of the package default 4: on the 1.08 MB vendor
 * chunk (Phaser + socket.io-client) it is ~272 kB vs ~300 kB for ~17 ms of
 * CPU, about what jsdelivr served for Phaser alone (275 kB br). Hashed
 * assets are cached immutable, so a browser downloads each one once.
 */

'use strict';

const zlib = require('zlib');
const compression = require('compression');

function createCompression() {
    return compression({
        brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }
    });
}

module.exports = { createCompression };
