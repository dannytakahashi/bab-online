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
const { cspMiddleware } = require('./middleware/csp');
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
        logger.info('Server running on port 3000');
        logger.info(`Environment: ${config.env}`);
        console.log('Server started successfully on port 3000');
    });

    // Setup graceful shutdown
    setupGracefulShutdown(server, io);

    // Connect to database in background (fire and forget like original)
    connectDB()
        .then(() => logger.info('Database connected'))
        .catch(err => logger.error('Database connection error', { error: err.message }));
}

// Start the server
start();
