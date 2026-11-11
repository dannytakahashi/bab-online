/**
 * Static file mounts (moved verbatim out of server/index.js so tests can
 * mount them on their own app), plus the versioned avatar art and the built
 * web client.
 *
 * The page: `vite build` writes client/dist/index.html (the source page is
 * client/index.html, for the Vite dev server) referencing hashed files in
 * client/dist/assets. `/` and `/index.html` serve the built page with
 * `Cache-Control: no-cache` (always revalidated, so a deploy reaches every
 * browser on its next load); /dist/assets/* is content-hashed, so
 * production serves it immutable for a year. /dist/main.js (the entry of
 * pages from before hashed builds, and its legacy shim) is gone: those
 * pages were cached for at most a day and nothing else requests it, so it
 * is an ordinary 404 (webClient.test.js).
 *
 * /assets/avatars/v1/*.webp (scripts/build-avatars.js): content never
 * changes under a version directory (new art goes to v2), so production
 * serves it immutable for a year, nosniff, and a missing file is a 404
 * here instead of falling through. It is mounted BEFORE the root static,
 * which would otherwise shadow it (the root static serves /assets/... too,
 * with its 1-day cache: that is the cache for /assets/profileN.png,
 * frog.png and the card art).
 *
 * There used to be a later `/assets` static (7 days, sprites immutable) as
 * well. It was dead: it served the same directory as the root static's
 * /assets/..., so every file it could serve had already been served, and a
 * missing one fell through both.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const CLIENT = path.join(__dirname, '..', 'client');

const NO_CACHE = 'no-cache';

/**
 * @param {Object} app - express app
 * @param {Object} options
 * @param {boolean} options.isProduction
 * @param {string} [options.clientDir] - the client directory (tests)
 */
function mountStatic(app, { isProduction, clientDir = CLIENT }) {
    const dist = path.join(clientDir, 'dist');
    const index = path.join(dist, 'index.html');

    app.get(['/', '/index.html'], (req, res, next) => {
        fs.stat(index, (err) => {
            if (err) {
                res.status(503).type('text/plain')
                    .send('Web client not built: run `npm run build:client`.');
                return;
            }
            res.setHeader('Cache-Control', NO_CACHE);
            res.sendFile(index, { cacheControl: false }, (sendErr) => {
                if (sendErr && !res.headersSent) next(sendErr);
            });
        });
    });

    app.use('/dist/assets', express.static(path.join(dist, 'assets'), {
        immutable: isProduction,
        maxAge: isProduction ? '365d' : 0,
        index: false,
        fallthrough: false,
        setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
    }));

    app.use('/assets/avatars', express.static(path.join(clientDir, 'assets', 'avatars'), {
        immutable: isProduction,
        maxAge: isProduction ? '365d' : 0,
        fallthrough: false,
        setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
    }));

    // Static files with caching. No directory index: the page is served above
    app.use(express.static(clientDir, {
        maxAge: isProduction ? '1d' : 0, // Cache for 1 day in production
        etag: true,
        lastModified: true,
        index: false
    }));

    app.use('/assets-debug', express.static(path.join(clientDir, 'assets')));
}

module.exports = { mountStatic };
