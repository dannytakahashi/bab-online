/**
 * The page's Content-Security-Policy header (every Express response; the
 * avatar route replaces it with its own sandbox policy).
 *
 * The built page (client/dist/index.html) carries a meta CSP as well, and a
 * browser enforces BOTH, so a source is allowed only when both allow it:
 * keep the two in step (server/__tests__/csp.test.js compares them).
 *
 * - script-src 'self': the page loads only its own bundled modules (Phaser
 *   and socket.io-client are bundled since #201; the CDN hosts that pages
 *   cached before that needed are gone, and no page has an inline script).
 *   No 'unsafe-eval': Phaser 3.55's one eval on the page path (webpack's
 *   `new Function("return this")` global lookup) is rewritten to globalThis
 *   at build time (client/vite.config.js phaserNoEval)
 * - style-src keeps 'unsafe-inline': the UI sets style attributes and the
 *   /privacy, /support and /terms pages have an inline <style>
 * - font-src 'self': no Google Fonts (the UI uses the system font stack,
 *   18b); the one web font is the cards' bundled index face, a hashed
 *   /dist/assets woff2 (client/src/phaser/cards/cardFont.js)
 * - connect-src: the production hosts, unchanged ('self' covers ws(s)
 *   to the serving host, a local server included)
 */

'use strict';

const PRODUCTION_HOSTS = 'https://bab-online-production.up.railway.app https://babonline.io';

const DIRECTIVES = [
    `default-src 'self' ${PRODUCTION_HOSTS}`,
    "script-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' wss://bab-online-production.up.railway.app https://bab-online-production.up.railway.app wss://babonline.io https://babonline.io",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "media-src 'self' blob:",
];

const CONTENT_SECURITY_POLICY = `${DIRECTIVES.join('; ')};`;

function cspMiddleware(req, res, next) {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
}

module.exports = { cspMiddleware, CONTENT_SECURITY_POLICY };
