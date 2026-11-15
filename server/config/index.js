/**
 * Server configuration
 */

require('dotenv').config();

/**
 * Origins whose browser pages may use the Socket.IO HTTP transport
 * cross-origin (its `cors` option: Access-Control-Allow-Origin on polling
 * responses). It never refuses a connection: WebSockets have no CORS (the
 * web page connects over websocket only, to the Railway host from
 * babonline.io), native clients ignore it (iOS polls first, with no Origin
 * or its own), and Express routes have no CORS at all. ALLOWED_ORIGINS
 * (comma-separated, `*` for any) replaces the list.
 */
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
    'https://babonline.io',
    'https://www.babonline.io',
    'https://bab-online-production.up.railway.app',
    // npm run dev:client (5173) talks to the API on 3000
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
]);

function parseAllowedOrigins(raw) {
    const list = String(raw || '').split(',').map(o => o.trim()).filter(Boolean);
    if (list.length === 0) return [...DEFAULT_ALLOWED_ORIGINS];
    return list.includes('*') ? '*' : list;
}

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
    allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS),

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
module.exports.DEFAULT_ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS;
module.exports.parseAllowedOrigins = parseAllowedOrigins;
