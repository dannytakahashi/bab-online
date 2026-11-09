/**
 * Static file mounts (moved verbatim out of server/index.js so tests can
 * mount them on their own app), plus the versioned avatar art.
 *
 * /assets/avatars/v1/*.webp (scripts/build-avatars.js): content never
 * changes under a version directory (new art goes to v2), so production
 * serves it immutable for a year, nosniff, and a missing file is a 404
 * here instead of falling through. It is mounted BEFORE the root static,
 * which would otherwise shadow it (the root static serves /assets/... too,
 * with its 1-day cache: that is today's effective cache for
 * /assets/profileN.png and frog.png, unchanged).
 */

'use strict';

const path = require('path');
const express = require('express');

const CLIENT = path.join(__dirname, '..', 'client');

function mountStatic(app, { isProduction }) {
    app.use('/assets/avatars', express.static(path.join(CLIENT, 'assets', 'avatars'), {
        immutable: isProduction,
        maxAge: isProduction ? '365d' : 0,
        fallthrough: false,
        setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff')
    }));

    // Static files with caching
    app.use(express.static(CLIENT, {
        maxAge: isProduction ? '1d' : 0, // Cache for 1 day in production
        etag: true,
        lastModified: true
    }));

    // Assets with longer cache (images don't change often)
    app.use('/assets', express.static(path.join(CLIENT, 'assets'), {
        maxAge: isProduction ? '7d' : 0, // Cache for 7 days in production
        etag: true,
        lastModified: true,
        setHeaders: (res, filePath) => {
            // Set immutable for sprite atlas files (they're versioned by content)
            if (filePath.includes('sprites/')) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            }
        }
    }));

    app.use('/assets-debug', express.static(path.join(CLIENT, 'assets')));
}

module.exports = { mountStatic };
