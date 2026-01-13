# Error Handling and Logging

## Overview
The application has no structured logging and minimal error handling, making debugging and monitoring impossible.

## Current Problems

- 94 `console.log` statements with no structure
- No log levels (debug, info, warn, error)
- No error handling in game logic functions
- Errors in socket handlers can crash or hang
- No graceful shutdown
- No client-side error handling

---

## Task 1: Install Logging Library

```bash
npm install winston
```

---

## Task 2: Create Structured Logger

**Create:** `server/utils/logger.js`

```javascript
const winston = require('winston');
const path = require('path');

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
};

// Determine log level based on environment
const level = () => {
    const env = process.env.NODE_ENV || 'development';
    return env === 'development' ? 'debug' : 'info';
};

// Custom format for readability
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length
            ? `\n${JSON.stringify(meta, null, 2)}`
            : '';
        return `${timestamp} [${level}]: ${message}${metaStr}`;
    })
);

// JSON format for production (easier to parse)
const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Create logger instance
const logger = winston.createLogger({
    level: level(),
    levels,
    transports: [
        // Console output
        new winston.transports.Console({
            format: process.env.NODE_ENV === 'production'
                ? jsonFormat
                : consoleFormat
        }),

        // Error log file
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            format: jsonFormat,
            maxsize: 5242880,  // 5MB
            maxFiles: 5
        }),

        // Combined log file
        new winston.transports.File({
            filename: 'logs/combined.log',
            format: jsonFormat,
            maxsize: 5242880,
            maxFiles: 5
        })
    ]
});

// Create child loggers for different modules
const createModuleLogger = (moduleName) => {
    return logger.child({ module: moduleName });
};

// Convenience loggers
const gameLogger = createModuleLogger('game');
const socketLogger = createModuleLogger('socket');
const authLogger = createModuleLogger('auth');
const dbLogger = createModuleLogger('database');

module.exports = {
    logger,
    gameLogger,
    socketLogger,
    authLogger,
    dbLogger,
    createModuleLogger
};
```

---

## Task 3: Replace console.log Statements

**Before:**
```javascript
console.log("Player joined:", username);
console.log("Game started");
console.log("Error:", error);
```

**After:**
```javascript
const { socketLogger, gameLogger } = require('./utils/logger');

socketLogger.info('Player joined', { username, socketId: socket.id });
gameLogger.info('Game started', { gameId, players: playerCount });
socketLogger.error('Connection error', { error: error.message, stack: error.stack });
```

**Search and replace patterns:**

| Find | Replace with |
|------|-------------|
| `console.log("Player` | `socketLogger.info('Player` |
| `console.log("Game` | `gameLogger.info('Game` |
| `console.log("Error` | `logger.error('Error` |
| `console.log(` | `logger.debug(` |

---

## Task 4: Add Error Handling to Game Functions

**Current (server/server.js):**
```javascript
function determineWinner(trick, leadPosition, trump) {
    // No validation - can crash with invalid input
    let winnerPos = leadPosition;
    // ...
}
```

**Solution:** Add validation and error classes

```javascript
// server/utils/errors.js
class GameError extends Error {
    constructor(message, code, context = {}) {
        super(message);
        this.name = 'GameError';
        this.code = code;
        this.context = context;
        this.isOperational = true;  // Expected error, not a bug
    }
}

class ValidationError extends GameError {
    constructor(message, context = {}) {
        super(message, 'VALIDATION_ERROR', context);
        this.name = 'ValidationError';
    }
}

class GameStateError extends GameError {
    constructor(message, context = {}) {
        super(message, 'GAME_STATE_ERROR', context);
        this.name = 'GameStateError';
    }
}

class AuthError extends GameError {
    constructor(message, context = {}) {
        super(message, 'AUTH_ERROR', context);
        this.name = 'AuthError';
    }
}

module.exports = { GameError, ValidationError, GameStateError, AuthError };
```

**Updated game functions:**
```javascript
const { ValidationError, GameStateError } = require('../utils/errors');
const { gameLogger } = require('../utils/logger');

function determineWinner(trick, leadPosition, trump) {
    // Validate inputs
    if (!Array.isArray(trick)) {
        throw new ValidationError('Trick must be an array', { trick });
    }

    if (trick.length !== 4) {
        throw new ValidationError('Trick must have 4 cards', {
            actualLength: trick.length
        });
    }

    if (leadPosition < 1 || leadPosition > 4) {
        throw new ValidationError('Lead position must be 1-4', { leadPosition });
    }

    // Validate all cards present
    for (let i = 0; i < 4; i++) {
        if (!trick[i] || !trick[i].suit || !trick[i].rank) {
            throw new ValidationError('Invalid card in trick', {
                position: i + 1,
                card: trick[i]
            });
        }
    }

    if (!trump || !trump.suit) {
        throw new ValidationError('Invalid trump card', { trump });
    }

    try {
        // Game logic here...
        let winnerPos = leadPosition;
        // ...
        return winnerPos;
    } catch (error) {
        gameLogger.error('Error determining winner', {
            trick,
            leadPosition,
            trump,
            error: error.message
        });
        throw new GameStateError('Failed to determine winner');
    }
}
```

---

## Task 5: Create Socket Handler Error Wrapper

**Create:** `server/socket/errorHandler.js`

```javascript
const { socketLogger } = require('../utils/logger');
const { GameError } = require('../utils/errors');

/**
 * Wrap async socket handler with error handling
 */
function asyncHandler(handlerName, handler) {
    return async (socket, io, data) => {
        const startTime = Date.now();

        try {
            await handler(socket, io, data);

            socketLogger.debug(`Handler completed: ${handlerName}`, {
                socketId: socket.id,
                duration: Date.now() - startTime
            });
        } catch (error) {
            handleSocketError(socket, handlerName, error);
        }
    };
}

/**
 * Wrap sync socket handler
 */
function syncHandler(handlerName, handler) {
    return (socket, io, data) => {
        try {
            handler(socket, io, data);
        } catch (error) {
            handleSocketError(socket, handlerName, error);
        }
    };
}

function handleSocketError(socket, handlerName, error) {
    // Log based on error type
    if (error.isOperational) {
        // Expected error (validation, game state, etc.)
        socketLogger.warn(`Handler error: ${handlerName}`, {
            socketId: socket.id,
            errorCode: error.code,
            message: error.message,
            context: error.context
        });

        socket.emit('error', {
            code: error.code,
            message: error.message
        });
    } else {
        // Unexpected error (bug)
        socketLogger.error(`Unexpected error in ${handlerName}`, {
            socketId: socket.id,
            error: error.message,
            stack: error.stack
        });

        socket.emit('error', {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred'
        });
    }
}

module.exports = { asyncHandler, syncHandler };
```

**Usage:**
```javascript
const { asyncHandler, syncHandler } = require('./errorHandler');

io.on('connection', (socket) => {
    socket.on('signIn', asyncHandler('signIn', async (socket, io, data) => {
        // Handler code - errors automatically caught
    }));

    socket.on('playCard', syncHandler('playCard', (socket, io, data) => {
        // Handler code
    }));
});
```

---

## Task 6: Add Graceful Shutdown

**Create:** `server/utils/shutdown.js`

```javascript
const { logger } = require('./logger');

let isShuttingDown = false;

function setupGracefulShutdown(server, io, db) {
    const shutdown = async (signal) => {
        if (isShuttingDown) {
            logger.warn('Shutdown already in progress, forcing exit');
            process.exit(1);
        }

        isShuttingDown = true;
        logger.info(`Received ${signal}, starting graceful shutdown`);

        // Stop accepting new connections
        server.close(() => {
            logger.info('HTTP server closed');
        });

        // Notify connected clients
        io.emit('serverShutdown', {
            message: 'Server is restarting, please reconnect shortly'
        });

        // Give clients time to receive the message
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Close socket connections
        io.close(() => {
            logger.info('Socket.IO server closed');
        });

        // Close database connection
        try {
            await db.close();
            logger.info('Database connection closed');
        } catch (error) {
            logger.error('Error closing database', { error: error.message });
        }

        logger.info('Graceful shutdown complete');
        process.exit(0);
    };

    // Handle termination signals
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception', {
            error: error.message,
            stack: error.stack
        });
        shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled rejection', {
            reason: reason?.message || reason,
            stack: reason?.stack
        });
        // Don't shutdown, but log
    });
}

module.exports = { setupGracefulShutdown };
```

**Apply in index.js:**
```javascript
const { setupGracefulShutdown } = require('./utils/shutdown');

// After server starts
setupGracefulShutdown(httpServer, io, db);
```

---

## Task 7: Add Client-Side Error Handling

**Create:** `client/js/utils/errorHandler.js`

```javascript
class ClientErrorHandler {
    constructor() {
        this.setupGlobalHandlers();
    }

    setupGlobalHandlers() {
        // Catch unhandled errors
        window.onerror = (message, source, line, col, error) => {
            this.handleError(error || new Error(message), {
                source, line, col, type: 'window.onerror'
            });
            return true;
        };

        // Catch unhandled promise rejections
        window.onunhandledrejection = (event) => {
            this.handleError(event.reason, {
                type: 'unhandledRejection'
            });
        };
    }

    handleError(error, context = {}) {
        console.error('Application error:', error, context);

        // Log to server (optional)
        this.reportToServer(error, context);

        // Show user-friendly message
        if (this.shouldShowToUser(error)) {
            this.showErrorToast(this.getUserMessage(error));
        }
    }

    handleSocketError(error) {
        console.error('Socket error:', error);

        switch (error.code) {
            case 'VALIDATION_ERROR':
                this.showErrorToast(error.message);
                break;
            case 'AUTH_ERROR':
                this.showErrorToast('Please sign in again');
                this.redirectToLogin();
                break;
            case 'GAME_STATE_ERROR':
                this.showErrorToast('Game error: ' + error.message);
                break;
            default:
                this.showErrorToast('Something went wrong');
        }
    }

    shouldShowToUser(error) {
        // Don't show certain internal errors
        const silentErrors = ['ResizeObserver', 'Script error'];
        return !silentErrors.some(e => error.message?.includes(e));
    }

    getUserMessage(error) {
        // Map technical errors to user-friendly messages
        if (error.message?.includes('network')) {
            return 'Connection lost. Please check your internet.';
        }
        if (error.message?.includes('timeout')) {
            return 'Request timed out. Please try again.';
        }
        return 'Something went wrong. Please refresh if issues persist.';
    }

    showErrorToast(message, duration = 5000) {
        // Remove existing toast
        const existing = document.querySelector('.error-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'error-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    async reportToServer(error, context) {
        try {
            // Only report in production
            if (window.location.hostname === 'localhost') return;

            await fetch('/api/client-error', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: error.message,
                    stack: error.stack,
                    context,
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    timestamp: new Date().toISOString()
                })
            });
        } catch (e) {
            // Silently fail - don't cause more errors
        }
    }

    redirectToLogin() {
        sessionStorage.clear();
        window.location.reload();
    }
}

export const errorHandler = new ClientErrorHandler();
```

**CSS:**
```css
.error-toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #dc2626;
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    z-index: 10000;
    animation: slideUp 0.3s ease;
}

.error-toast.fade-out {
    animation: fadeOut 0.3s ease forwards;
}

@keyframes slideUp {
    from { transform: translate(-50%, 100%); opacity: 0; }
    to { transform: translate(-50%, 0); opacity: 1; }
}

@keyframes fadeOut {
    to { opacity: 0; }
}
```

---

## Task 8: Add Request Logging Middleware

**Create:** `server/middleware/requestLogger.js`

```javascript
const { logger } = require('../utils/logger');

function requestLogger(req, res, next) {
    const startTime = Date.now();

    // Log request
    logger.http('Incoming request', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('user-agent')
    });

    // Log response when finished
    res.on('finish', () => {
        const duration = Date.now() - startTime;

        const logData = {
            method: req.method,
            url: req.url,
            status: res.statusCode,
            duration: `${duration}ms`
        };

        if (res.statusCode >= 400) {
            logger.warn('Request completed with error', logData);
        } else {
            logger.http('Request completed', logData);
        }
    });

    next();
}

module.exports = requestLogger;
```

**Apply:**
```javascript
const requestLogger = require('./middleware/requestLogger');
app.use(requestLogger);
```

---

## Task 9: Create Log Directory

Add to package.json scripts:
```json
{
    "scripts": {
        "prestart": "mkdir -p logs"
    }
}
```

Or in code:
```javascript
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}
```

---

## Verification

1. [ ] Winston logger configured with appropriate levels
2. [ ] All console.log replaced with structured logging
3. [ ] Game functions have input validation and error handling
4. [ ] Socket handlers wrapped with error handling
5. [ ] Graceful shutdown implemented
6. [ ] Client-side error handler shows user-friendly messages
7. [ ] Request logging middleware active
8. [ ] Log files created in logs/ directory
9. [ ] Error stack traces captured in production
10. [ ] Shutdown doesn't lose data or leave connections hanging
