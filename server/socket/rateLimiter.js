/**
 * Rate limiting for socket events
 * Prevents spam and abuse by limiting event frequency per socket, plus
 * token buckets for limits that must outlive a socket (sign-ups per client
 * IP and server-wide: a reconnect gets a new socket id and so a fresh
 * per-socket budget)
 */

const { socketLogger } = require('../utils/logger');
const { safeInterval } = require('../utils/safeTimer');

class RateLimiter {
    constructor() {
        // Define rate limits per event type
        // { max: number of requests, windowMs: time window in milliseconds }
        this.limits = {
            // Auth - strict limits to prevent brute force
            signIn: { max: 5, windowMs: 60000 },       // 5 per minute
            // signUp (the asyncHandler wrapper) counts every attempt,
            // including refusals by the name rules, profanity filter and
            // taken check, which cost no hash: 20 per 5 min. Only an attempt
            // that gets past them (bcrypt hash + insert) also spends
            // signUpAccount, checked in authHandlers.signUp: 3 per 5 min
            signUp: { max: 20, windowMs: 300000 },
            signUpAccount: { max: 3, windowMs: 300000 },

            // clientHello: one per connect; over the limit it is dropped
            // silently inside the handler (socket/clientInfo.js)
            clientHello: { max: 5, windowMs: 10000 },

            // Chat - moderate limits
            chatMessage: { max: 10, windowMs: 10000 }, // 10 per 10 seconds

            // Game actions - reasonable limits for gameplay
            // An over-limit play gets `serverError {code: rateLimit}` and no
            // actionRejected (web and iOS 1.2.0 then resync the table at once;
            // 1.0.0 lost the card): keep these far above real play.
            // The fastest trick (pacing.js) is about 2.4 s, so about 25 plays a
            // minute per seat; 90 leaves room for a one-socket Duo (about 50)
            playCard: { max: 90, windowMs: 60000 },
            playerBid: { max: 30, windowMs: 60000 },
            draw: { max: 10, windowMs: 60000 },        // 10 per minute

            // Snapshot v2 resync requests (clients debounce; README R5)
            requestSnapshot: { max: 10, windowMs: 10000 },

            // Profile pages. getLeaderboard/getRecords are checked inside
            // their handlers (safeHandler) and over the limit answer with the
            // cached page, never serverError. searchPlayers/getPlayerProfile go
            // through asyncHandler (serverError {code:'rateLimit'}, a web toast);
            // web debounces search at 300 ms (about 3/s while typing)
            getLeaderboard: { max: 10, windowMs: 10000 },
            getRecords: { max: 10, windowMs: 10000 },
            searchPlayers: { max: 30, windowMs: 10000 },
            getPlayerProfile: { max: 30, windowMs: 10000 },
            // Custom picture uploads (each one is decoded + re-encoded)
            uploadProfilePic: { max: 5, windowMs: 60000 },

            // Lobby creation
            createLobby: { max: 5, windowMs: 60000 },

            // Tournaments - create/join/leave cycles trigger room-wide
            // broadcasts, so keep them throttled. Create and cancel allow 10
            // a minute (owner 2026-11-13: two quick create/cancel rounds hit
            // the old 3 a minute)
            createTournament: { max: 10, windowMs: 60000 },
            joinTournament: { max: 10, windowMs: 60000 },
            leaveTournament: { max: 10, windowMs: 60000 },
            tournamentReady: { max: 10, windowMs: 10000 },
            tournamentUnready: { max: 10, windowMs: 10000 },
            beginTournament: { max: 5, windowMs: 60000 },
            beginNextRound: { max: 5, windowMs: 60000 },
            returnToTournament: { max: 10, windowMs: 30000 },
            spectateTournament: { max: 10, windowMs: 60000 },
            spectateTournamentGame: { max: 10, windowMs: 60000 },
            cancelTournament: { max: 10, windowMs: 60000 },

            // Account management. The password check also goes through
            // signInThrottle (per username / IP failures, across sockets)
            deleteAccount: { max: 3, windowMs: 300000 },  // 3 per 5 minutes

            // Session and table entry. Every reconnect is a new socket (web
            // and iOS both open a fresh one), so these per-socket limits
            // never meet a flaky network: they only stop one socket from
            // spamming. Web sends restoreSession and rejoinGame once per
            // socket (ClientSession.resume / rejoin); iOS sends
            // restoreSession on every .connect and rejoinGame after a
            // sign-in or restore that names a game. The iOS foreground
            // probe is requestSnapshot, not these. Over the limit: the
            // wrapper's serverError {code:'rateLimit'}, never a
            // restoreSessionResponse failure (iOS clears its saved token on
            // one)
            restoreSession: { max: 10, windowMs: 60000 },
            rejoinGame: { max: 10, windowMs: 60000 },
            // One per Join / Watch tap (web MainRoom, iOS LobbyListView) and
            // a lobby re-entry after a restore; each one broadcasts lobby
            // lists, so a bot clicking stops here
            joinLobby: { max: 20, windowMs: 30000 },
            joinAsSpectator: { max: 20, windowMs: 30000 },
            // Web only: the Profile button and the stats scope tabs (a DB
            // read each). Checked in profileHandlers.getProfile (it has no
            // schema), same serverError over the limit
            getProfile: { max: 20, windowMs: 10000 },
            // One per tap in the web picture grid (a DB write and cache
            // invalidation each)
            updateProfilePic: { max: 30, windowMs: 60000 },

            // Voice signaling (checked inside voiceHandlers: over the limit
            // the message is dropped silently, never serverError, which the
            // clients would show as a toast). Per socket, all peers together
            // (a full table is 3 peers). Measured 2026-11-11 in the desktop
            // app's Chromium with the clients' two Google STUN servers: 2
            // candidates per peer connection (mDNS host), gathered in ~20 ms;
            // more interfaces, IPv6 or iOS cellular add a few srflx/host
            // each, so 300 / 10 s is ~30x a 3-peer burst. Offers/answers:
            // one per peer plus renegotiation. (The old web PCM relay and
            // its voiceRelayAudio key are gone: V1_REMOVALS #20.)
            voiceOffer: { max: 30, windowMs: 10000 },
            voiceAnswer: { max: 30, windowMs: 10000 },
            voiceIceCandidate: { max: 300, windowMs: 10000 },
            // TURN credentials (wrapper limit: error rateLimit over it). Web
            // asks once per voice start and refreshes before expiry; the
            // credentials are cached per user (server/voice/turnCredentials.js)
            getVoiceIceServers: { max: 20, windowMs: 60000 },

            // Safety / moderation
            reportUser: { max: 5, windowMs: 300000 },     // 5 per 5 minutes
            blockUser: { max: 10, windowMs: 60000 },
            unblockUser: { max: 10, windowMs: 60000 },

            // Admin panel requests (all actions together, per socket): the
            // panel sends one per click, a few on opening a tab
            adminRequest: { max: 60, windowMs: 60000 }
        };

        // Wrapped events deliberately without a limit (check() allows them
        // without a warning). Any other unknown key warns once in
        // development and test, so a new event gets a limit or a line here
        this.unlimited = new Set([
            // Seat actions bounded by the game itself (a resign offer per
            // seat; a bot removal per bot in the lobby)
            'forceResign',
            'removeBot'
        ]);
        this.warnedUnknown = new Set();

        // Token buckets keyed by something other than the socket:
        // { burst: capacity, perHour: refill rate, maxKeys }. A missing key
        // is a full bucket, so a bucket that has refilled is dropped by the
        // sweep below and memory stays bounded by the keys active within
        // about an hour (and maxKeys, oldest dropped first).
        // - signUpIp: accounts created per client IP (IPv6 by its /64,
        //   clientIp.ipBucketKey), charged only for an attempt that will
        //   hash and insert (authHandlers.signUp). 5 at once covers a
        //   family installing together behind one router; then 5 an hour
        // - signUpGlobal: accounts created on the whole server, so rotating
        //   IPs cannot flood users or fill the hash pool either. Far above
        //   a family app's real rate; a warn line says when it bites
        this.buckets = {
            signUpIp: { burst: 5, perHour: 5, maxKeys: 10000 },
            signUpGlobal: { burst: 20, perHour: 60, maxKeys: 1 }
        };
        // bucket name -> Map<key, {tokens, at}>
        this.bucketState = new Map();

        // Track requests: Map<string, number[]> where key is "socketId:event"
        this.requests = new Map();

        // Cleanup old entries periodically (every 5 minutes)
        this.cleanupInterval = safeInterval(() => this.cleanup(), 300000, 'rateLimiterCleanup');
        // Housekeeping only: never keep a process (CLI, test worker) alive
        this.cleanupInterval.unref?.();
    }

    /**
     * Check if a request is allowed
     * @param {string} socketId - Socket ID making the request
     * @param {string} event - Event name
     * @returns {boolean} - true if allowed, false if rate limited
     */
    check(socketId, event) {
        const limit = this.limits[event];

        // No limit defined for this event - allow
        if (!limit) {
            this.noteUnknown(event);
            return true;
        }

        const key = `${socketId}:${event}`;
        const now = Date.now();
        const windowStart = now - limit.windowMs;

        // Get existing timestamps or create new array
        let timestamps = this.requests.get(key) || [];

        // Filter out old timestamps outside the window
        timestamps = timestamps.filter(t => t > windowStart);

        // Check if limit exceeded
        if (timestamps.length >= limit.max) {
            socketLogger.warn('Rate limit exceeded', { socketId, event, count: timestamps.length, max: limit.max });
            return false;
        }

        // Record this request
        timestamps.push(now);
        this.requests.set(key, timestamps);

        return true;
    }

    /**
     * An event with no limit and not in `unlimited`: warn once per key
     * outside production, so a new event does not ship unlimited by
     * accident. Production behaviour is unchanged (allowed, no log).
     */
    noteUnknown(event) {
        if (process.env.NODE_ENV === 'production' || this.unlimited.has(event)) return;
        if (this.warnedUnknown.has(event)) return;
        this.warnedUnknown.add(event);
        socketLogger.warn('Rate limiter: event has no limit (add one to rateLimiter.limits, or to unlimited)', { event });
    }

    /** The bucket `name` / `key` refilled to now (not stored). */
    refill(name, key, now) {
        const cfg = this.buckets[name];
        const b = this.bucketState.get(name)?.get(key);
        if (!b) return { tokens: cfg.burst, at: now };
        const tokens = Math.min(cfg.burst, b.tokens + ((now - b.at) / 3600000) * cfg.perHour);
        return { tokens, at: now };
    }

    /**
     * Take one token from bucket `name` for `key`.
     * @returns {{ok: boolean, retryAfterMs: number}} retryAfterMs: until a
     *   token is back (0 when ok)
     */
    take(name, key, now = Date.now()) {
        const cfg = this.buckets[name];
        let map = this.bucketState.get(name);
        if (!map) {
            map = new Map();
            this.bucketState.set(name, map);
        }
        const b = this.refill(name, key, now);
        if (b.tokens < 1) {
            return { ok: false, retryAfterMs: Math.ceil(((1 - b.tokens) / cfg.perHour) * 3600000) };
        }
        b.tokens -= 1;
        map.delete(key); // re-insert: insertion order = least recently used first
        map.set(key, b);
        while (map.size > cfg.maxKeys) map.delete(map.keys().next().value);
        return { ok: true, retryAfterMs: 0 };
    }

    /** Give back a token taken for an attempt that did no work (a busy hash pool). */
    refund(name, key, now = Date.now()) {
        const map = this.bucketState.get(name);
        if (!map || !map.has(key)) return;
        const b = this.refill(name, key, now);
        b.tokens = Math.min(this.buckets[name].burst, b.tokens + 1);
        map.set(key, b);
    }

    /** Test helper: every bucket full again. */
    _resetBuckets() {
        this.bucketState.clear();
    }

    /**
     * Get remaining requests for a socket/event
     * @param {string} socketId - Socket ID
     * @param {string} event - Event name
     * @returns {number} - Remaining requests allowed
     */
    getRemaining(socketId, event) {
        const limit = this.limits[event];
        if (!limit) return Infinity;

        const key = `${socketId}:${event}`;
        const now = Date.now();
        const windowStart = now - limit.windowMs;

        const timestamps = this.requests.get(key) || [];
        const validTimestamps = timestamps.filter(t => t > windowStart);

        return Math.max(0, limit.max - validTimestamps.length);
    }

    /**
     * Clear all rate limit data for a socket (call on disconnect)
     * @param {string} socketId - Socket ID to clear
     */
    clearSocket(socketId) {
        const prefix = `${socketId}:`;
        for (const key of this.requests.keys()) {
            if (key.startsWith(prefix)) {
                this.requests.delete(key);
            }
        }
    }

    /**
     * Cleanup old entries to prevent memory leaks
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, timestamps] of this.requests.entries()) {
            // Find the event type from the key
            const event = key.split(':')[1];
            const limit = this.limits[event];

            if (!limit) {
                this.requests.delete(key);
                cleaned++;
                continue;
            }

            // Filter out old timestamps
            const windowStart = now - limit.windowMs;
            const validTimestamps = timestamps.filter(t => t > windowStart);

            if (validTimestamps.length === 0) {
                this.requests.delete(key);
                cleaned++;
            } else if (validTimestamps.length !== timestamps.length) {
                this.requests.set(key, validTimestamps);
            }
        }

        // Buckets that have refilled are the same as no entry
        for (const [name, map] of this.bucketState) {
            for (const key of Array.from(map.keys())) {
                if (this.refill(name, key, now).tokens >= this.buckets[name].burst) {
                    map.delete(key);
                    cleaned++;
                }
            }
        }

        if (cleaned > 0) {
            socketLogger.debug('Rate limiter cleanup', { removed: cleaned });
        }
    }

    /**
     * Shutdown the rate limiter (clear interval)
     */
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }
}

// Singleton instance
const rateLimiter = new RateLimiter();

module.exports = rateLimiter;
