/**
 * Express routes
 */

const express = require('express');
const path = require('path');
const { getDB } = require('../database');
const router = express.Router();

// Serve main page
router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'client', 'index.html'));
});

// Privacy policy
router.get('/privacy', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BAB Online - Privacy Policy</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #e0e0e0; background: #1a1a1a; line-height: 1.6; }
        h1 { color: #4dcc73; }
        h2 { color: #ccc; margin-top: 2em; }
        p { margin: 0.8em 0; }
        a { color: #4dcc73; }
    </style>
</head>
<body>
    <h1>BAB Online — Privacy Policy</h1>
    <p><strong>Last updated:</strong> February 22, 2026</p>

    <h2>What We Collect</h2>
    <p>When you create an account we store your <strong>username</strong> and a <strong>hashed password</strong> (bcrypt). We also store game statistics (wins, losses, scores) associated with your account.</p>
    <p>We do not collect your real name, email address, location, or any device identifiers.</p>

    <h2>How We Use Your Data</h2>
    <p>Your username and stats are used solely to operate the game: displaying your name to other players, tracking leaderboard rankings, and enabling reconnection to in-progress games.</p>

    <h2>Data Sharing</h2>
    <p>We do not sell, share, or transfer your data to any third parties. Your data stays on our server.</p>

    <h2>Data Storage</h2>
    <p>Data is stored in a MongoDB database hosted on Railway. Passwords are hashed with bcrypt and are never stored in plain text.</p>

    <h2>Data Deletion</h2>
    <p>To request deletion of your account and all associated data, contact us at the support link below.</p>

    <h2>Children's Privacy</h2>
    <p>BAB Online does not knowingly collect data from children under 13. The game contains no advertising, in-app purchases, or tracking.</p>

    <h2>Changes</h2>
    <p>If we update this policy, the changes will be posted on this page with an updated date.</p>

    <h2>Contact</h2>
    <p>Questions or deletion requests: <a href="https://github.com/dannytakahashi/bab-online/issues">github.com/dannytakahashi/bab-online/issues</a></p>
</body>
</html>`);
});

// Health check endpoint - is the server running?
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            unit: 'MB'
        }
    });
});

// Readiness check - is the server ready to accept traffic?
router.get('/ready', async (req, res) => {
    try {
        // Check database connection
        const db = getDB();
        if (!db) {
            throw new Error('Database not connected');
        }

        await db.admin().ping();

        res.json({
            status: 'ready',
            checks: {
                database: 'ok'
            }
        });
    } catch (error) {
        res.status(503).json({
            status: 'not ready',
            checks: {
                database: 'failed'
            },
            error: error.message
        });
    }
});

// Liveness check - is the server alive and not deadlocked?
router.get('/live', (req, res) => {
    res.json({ status: 'alive' });
});

module.exports = router;
