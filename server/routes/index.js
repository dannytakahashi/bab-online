/**
 * Express routes
 */

const express = require('express');
const path = require('path');
const router = express.Router();

// Serve main page
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'client', 'index.html'));
});

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

module.exports = router;
