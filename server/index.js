/**
 * BAB Online Server - Minimal version for debugging
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Initialize Express
const app = express();
const server = http.createServer(app);

// Minimal CSP
app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy',
        "default-src 'self' https://bab-online-production.up.railway.app; " +
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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Main route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// Socket.IO with minimal config
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Minimal socket handler - just log connections
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
    });
});

// Start server - hardcode 3000 to match old server behavior
// Railway appears to expect port 3000 despite setting PORT env var
server.listen(3000, () => {
    console.log('Server running on port 3000');
});

// Log any uncaught errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
