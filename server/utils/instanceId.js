/**
 * This process's identity (deploy survival): `bootId`, a uuid made when
 * the module first loads (server/index.js requires it first thing, so it
 * is the process's), and the Railway deployment it belongs to. The
 * 'Instance boot' log line, the serverInstances document and every live
 * game / tournament document's `owner` use the same bootId.
 * Dependency-free.
 */

'use strict';

const bootId = require('crypto').randomUUID();

/** RAILWAY_DEPLOYMENT_ID (Railway sets it per deployment), or null on a local run. */
function deploymentId(env = process.env) {
    return env.RAILWAY_DEPLOYMENT_ID || null;
}

module.exports = { bootId, deploymentId };
