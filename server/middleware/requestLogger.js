/**
 * HTTP Request logging middleware
 * Logs incoming requests and response status
 */

const { httpLogger } = require('../utils/logger');

function requestLogger(req, res, next) {
    const startTime = Date.now();

    // Log request (only for non-static files in development)
    const isStaticFile = req.url.match(/\.(js|css|png|jpg|ico|svg|woff|woff2)$/);

    if (!isStaticFile) {
        httpLogger.http('Request', {
            method: req.method,
            url: req.url,
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
            url: req.url,
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
