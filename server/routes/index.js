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
