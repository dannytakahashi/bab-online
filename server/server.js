/**
 * BAB Online Server - Modular Architecture
 *
 * This is the main entry point that sets up Express, Socket.IO,
 * and delegates socket handling to the modular handlers.
 */

require("dotenv").config();
const path = require('path');
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const helmet = require("helmet");
const cors = require("cors");

const { connectDB } = require("./database");
const { setupSocketHandlers } = require("./socket");

// Allowed origins for CORS (production + local development)
const ALLOWED_ORIGINS = [
    'https://bab-online-production.up.railway.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
];

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with restricted CORS
const io = socketIo(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Connect to database
connectDB();

// Security Middleware
app.use(helmet({
    contentSecurityPolicy: false  // We set CSP manually below for Phaser compatibility
}));

// CORS Middleware with whitelist
app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true
}));

// CSP Middleware (Phaser requires unsafe-eval for WebGL, unsafe-inline for styles)
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy",
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.socket.io; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' ws://localhost:3000 wss://bab-online-production.up.railway.app https://bab-online-production.up.railway.app; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    );
    next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/assets-debug', express.static(path.join(__dirname, '../client/assets')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Setup socket handlers (modular)
setupSocketHandlers(io);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Using modular socket handlers');
});
