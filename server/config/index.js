/**
 * Server configuration
 */

require('dotenv').config();

const config = {
    // Environment
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',

    // Server
    port: parseInt(process.env.PORT, 10) || 3000,

    // Database
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/bab-online',

    // Security
    allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : ['*'],  // TODO: Restrict in production

    // Game settings
    game: {
        startingHandSize: 12,
        minHandSize: 1,
        playersPerGame: 4
    }
};

module.exports = config;
