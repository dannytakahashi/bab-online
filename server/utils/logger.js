/**
 * Structured logging using Winston
 * Provides consistent, level-based logging with module context
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Define log levels
const levels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
};

// Colors for console output
const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue'
};

winston.addColors(colors);

// Determine log level based on environment
const level = () => {
    const env = process.env.NODE_ENV || 'development';
    return env === 'development' ? 'debug' : 'info';
};

// Custom format for console (readable)
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ timestamp, level, message, module, ...meta }) => {
        const moduleStr = module ? `[${module}]` : '';
        const metaStr = Object.keys(meta).length
            ? ` ${JSON.stringify(meta)}`
            : '';
        return `${timestamp} ${level} ${moduleStr} ${message}${metaStr}`;
    })
);

// JSON format for file logs (easy to parse)
const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Create transports array
const transports = [
    // Console output
    new winston.transports.Console({
        format: consoleFormat
    })
];

// Add file transports only if not in test environment
if (process.env.NODE_ENV !== 'test') {
    transports.push(
        // Error log file
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 5242880,  // 5MB
            maxFiles: 5
        }),
        // Combined log file
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: fileFormat,
            maxsize: 5242880,
            maxFiles: 5
        })
    );
}

// Create main logger instance
const logger = winston.createLogger({
    level: level(),
    levels,
    transports
});

/**
 * Create a child logger for a specific module
 * @param {string} moduleName - Name of the module
 * @returns {winston.Logger} - Child logger with module context
 */
function createModuleLogger(moduleName) {
    return logger.child({ module: moduleName });
}

// Pre-configured module loggers
const gameLogger = createModuleLogger('game');
const socketLogger = createModuleLogger('socket');
const authLogger = createModuleLogger('auth');
const dbLogger = createModuleLogger('db');
const httpLogger = createModuleLogger('http');

module.exports = {
    logger,
    gameLogger,
    socketLogger,
    authLogger,
    dbLogger,
    httpLogger,
    createModuleLogger
};
