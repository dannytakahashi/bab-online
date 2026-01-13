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

// Initialize Express
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Connect to database
connectDB();

// Middleware
app.use(cors());

// CSP Middleware
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy",
        "default-src 'self' https://bab-online-production.up.railway.app; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.socket.io; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' wss://bab-online-production.up.railway.app https://bab-online-production.up.railway.app; " +
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
