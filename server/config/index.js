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

    // Avatar pipeline (server/avatar, docs/avatars.md). Kill switch, no
    // deploy needed:
    //   AVATAR_PIPELINE=off       no custom picture has a URL (/avatar
    //                             answers 404); since V1_REMOVALS #19 no
    //                             payload carries one inline either, so
    //                             custom pictures show as the clients'
    //                             neutral picture (AVATAR_LEGACY_INLINE went
    //                             with #19 D)
    // Off by default under tests (NODE_ENV=test or any Jest worker) so
    // every suite and fixture stays byte-identical; tests opt in with
    // avatarStore.configure({ enabled: true }).
    avatar: {
        pipeline: process.env.AVATAR_PIPELINE === 'on' || process.env.AVATAR_PIPELINE === 'off'
            ? process.env.AVATAR_PIPELINE
            : (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined ? 'off' : 'on'),
        cacheBytes: (Number(process.env.AVATAR_CACHE_MB) > 0 ? Number(process.env.AVATAR_CACHE_MB) : 32) * 1024 * 1024
    },

    // Game settings
    game: {
        startingHandSize: 12,
        minHandSize: 1,
        playersPerGame: 4
    }
};

module.exports = config;
