/**
 * BAB Online Server - Entry Point
 *
 * Refactored architecture with modular components:
 * - config/: Server configuration
 * - game/: Game logic (Deck, GameState, GameManager, rules)
 * - socket/: Socket.IO event handlers
 * - routes/: Express routes
 * - utils/: Utility functions
 */

require('dotenv').config();

// Deploy measurement (docs/claude/server-infra.md, Deploys): one id per
// process and the time it started, before anything else loads. Paired with
// 'Instance listening', 'Instance DB ready', 'Ready: first 200' (/ready),
// 'First socket connection' and the old instance's SIGTERM line, it gives
// the gap between a new deployment serving and the old one being stopped.
// Only the first 8 characters of RAILWAY_DEPLOYMENT_ID (enough to tell
// deployments apart in the log)
// (utils/instanceId.js: the same bootId owns this process's live docs)
const { bootId } = require('./utils/instanceId');
const bootLog = { deployment: (process.env.RAILWAY_DEPLOYMENT_ID || 'local').slice(0, 8), bootId };
require('./utils/logger').logger.info('Instance boot', { ...bootLog, at: new Date().toISOString() });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const { connectDB, getUsersCollection } = require('./database');
const { setupSocketHandlers } = require('./socket');
const routes = require('./routes');
const { logger } = require('./utils/logger');
const { setupGracefulShutdown } = require('./utils/shutdown');
const requestLogger = require('./middleware/requestLogger');
const { createAvatarRouter } = require('./routes/avatar');
const avatarStore = require('./avatar/avatarStore');
const { mountStatic } = require('./staticAssets');
const { createCompression } = require('./middleware/compression');
const { cspMiddleware, createHstsMiddleware } = require('./middleware/csp');
const { createPasswordResetRouter } = require('./routes/passwordReset');
const database = require('./database');
const { signOutUser } = require('./socket/authHandlers');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Request logging middleware
app.use(requestLogger);

// gzip/brotli for Express responses (never the Socket.IO wire: engine.io
// answers /socket.io/ before Express; server/middleware/compression.js)
app.use(createCompression());

// Content-Security-Policy on every response (server/middleware/csp.js;
// kept in step with the page's meta CSP)
app.use(cspMiddleware);
// HSTS on https responses in production (server/middleware/csp.js)
app.use(createHstsMiddleware());

// Custom avatars over HTTP (GET /avatar/:username?v=): before the static
// handlers; sets its own CSP/CORP/nosniff and cache headers
app.use(createAvatarRouter({ getUsersCollection, avatarStore }));

// One-time password reset links: GET /reset (the standalone page) and
// POST /api/password-reset (routes/passwordReset.js). The Socket.IO server
// is created below; the route reads it when a reset signs a player out
let ioServer = null;
app.use(createPasswordResetRouter({
    getDb: () => ({
        users: database.getUsersCollection(),
        passwordResets: database.getPasswordResetsCollection(),
        adminAudit: database.getAdminAuditCollection()
    }),
    getIo: () => ioServer,
    signOutUser
}));

// Static files: the page (no-cache), hashed bundles and versioned avatar
// art (immutable), the client (server/staticAssets.js)
mountStatic(app, config);

// Routes
app.use('/', routes);

// Socket.IO
// cors + connectTimeout (server/socket/serverOptions.js)
const io = new Server(server, require('./socket/serverOptions').socketServerOptions(config));

ioServer = io;
// GET /health's live socket count (routes/health.js)
require('./routes/health').setHealthIo(io);

// Setup socket event handlers
setupSocketHandlers(io);

// Ambient bot activity (spectatable bot games + seeded main-room chat) so
// the app is never an empty room — on by default in production
const { startAmbientActivity, shouldEnable } = require('./demo/ambientBots');
if (shouldEnable()) {
    startAmbientActivity(io);
}

// Start server
function start() {
    // Hardcode port 3000 - Railway requires this (using PORT env var causes 502)
    server.listen(3000, () => {
        logger.info('Instance listening', { ...bootLog, at: new Date().toISOString() });
        logger.info('Server running on port 3000');
        logger.info(`Environment: ${config.env}`);
        console.log('Server started successfully on port 3000');
        // The deploy healthcheck probes PORT (the service sets PORT=3000,
        // .railway/railway.ts); if they ever differ, every deploy fails it
        if (process.env.PORT && process.env.PORT !== '3000') {
            logger.info(`PORT is ${process.env.PORT} but the server listens on 3000; the Railway healthcheck probes PORT`);
        }
    });

    // Live persist (LIVE_PERSIST, read once here; deploy survival,
    // server/game/persist/liveStore.js). Off: none of it runs
    const liveStore = require('./game/persist/liveStore').getLiveStore();
    const persisting = liveStore.mode !== 'off';

    // Setup graceful shutdown
    // Live tables hear about the update in their game log before serverShutdown
    // (write mode: then this process deletes its saved games and tournaments)
    setupGracefulShutdown(server, io, {
        games: () => require('./game/GameManager').games.values(),
        ...(persisting && { persist: liveStore })
    });

    // Connect to database in background (fire and forget like original)
    connectDB()
        .then(() => {
            logger.info('Database connected');
            logger.info('Instance DB ready', { ...bootLog, at: new Date().toISOString() });
            // Write mode: this process's serverInstances doc and heartbeat
            // (no sweep, no adoption), in parallel with the stats sweep
            if (persisting) {
                liveStore.start({ io }).catch(err => logger.error('Live persist start failed', { error: err.message }));
            }
            // End-of-game stats a previous process left half-applied
            return require('./socket/profileHandlers').resumePendingGameStats();
        })
        .catch(err => logger.error('Database connection error', { error: err.message }));
}

// Start the server
start();
