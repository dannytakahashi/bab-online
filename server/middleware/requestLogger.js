/**
 * HTTP Request logging middleware
 * Logs incoming requests and response status
 */

const { httpLogger } = require('../utils/logger');

/**
 * The URL as logged. The reset page and its API never put the token in
 * the URL (it travels in the fragment and the POST body:
 * routes/passwordReset.js), but should anyone open /reset?<something>,
 * the query is still never written to a log.
 */
function loggedUrl(req) {
    const p = req.path || '';
    if (p === '/reset' || p.startsWith('/reset/') || p.startsWith('/api/password-reset')) return p;
    return req.url;
}

function requestLogger(req, res, next) {
    const startTime = Date.now();

    // Log request (only for non-static files in development). Decided on
    // req.path (no query string: /avatar/x?v=... and /dist/assets/x.js?v= are
    // static too); avatars and everything under /assets/ log only errors
    const p = req.path || '';
    const isStaticFile = /\.(js|css|png|jpg|webp|ico|svg|woff|woff2)$/.test(p) ||
        p.startsWith('/avatar/') || p.startsWith('/assets/');

    if (!isStaticFile) {
        httpLogger.http('Request', {
            method: req.method,
            url: loggedUrl(req),
            ip: req.ip || req.connection.remoteAddress
        });
    }

    // Log response when finished
    res.on('finish', () => {
        const duration = Date.now() - startTime;

        // Skip logging static files unless they error
        if (isStaticFile && res.statusCode < 400) {
            return;
        }

        const logData = {
            method: req.method,
            url: loggedUrl(req),
            status: res.statusCode,
            duration: `${duration}ms`
        };

        if (res.statusCode >= 400) {
            httpLogger.warn('Request error', logData);
        } else if (!isStaticFile) {
            httpLogger.http('Response', logData);
        }
    });

    next();
}

module.exports = requestLogger;
module.exports.loggedUrl = loggedUrl;
