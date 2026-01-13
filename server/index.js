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
const path = require('path');

const config = require('./config');
const { connectDB } = require('./database');
const { setupSocketHandlers } = require('./socket');
const routes = require('./routes');

// Initialize Express
const app = express();
const server = http.createServer(app);

// CSP Header (custom, matches original)
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
        "default-src 'self' https://bab-online-production.up.railway.app https://babonline.io; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.socket.io; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' wss://bab-online-production.up.railway.app https://bab-online-production.up.railway.app wss://babonline.io https://babonline.io; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    );
    next();
});

// Static files
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/assets-debug', express.static(path.join(__dirname, '..', 'client', 'assets')));

// Routes
app.use('/', routes);

// Socket.IO
const io = new Server(server, {
    cors: {
        origin: config.allowedOrigins,
        methods: ['GET', 'POST']
    }
});

// Setup socket event handlers
setupSocketHandlers(io);

// Start server
function start() {
    // Hardcode port 3000 - Railway expects this despite setting PORT env var
    server.listen(3000, () => {
        console.log('Server running on port 3000');
        console.log(`Environment: ${config.env}`);
    });

    // Connect to database in background (fire and forget like original)
    connectDB()
        .then(() => console.log('Database connected'))
        .catch(err => console.error('Database connection error:', err));
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// Start the server
start();
