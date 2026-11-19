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
            // /help and ?help (checked inside assistHandlers.help, after the
            // chatMessage limit): over it the private line "One moment: try
            // /help again in a few seconds.", never counted
            assist: { max: 4, windowMs: 10000 },

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
            // "Don't wait for <name>" in a play-again lobby (host): one per tap
            releaseLobbyHold: { max: 10, windowMs: 30000 },
            // Play again: Return to Lobby off the results (one per return)
            lobbyReturnSeen: { max: 10, windowMs: 30000 },
            spectateTournament: { max: 10, windowMs: 60000 },
            spectateTournamentGame: { max: 10, windowMs: 60000 },
            cancelTournament: { max: 10, windowMs: 60000 },

            // Account management. The password check also goes through
            // signInThrottle (per username / IP failures, across sockets)
            deleteAccount: { max: 3, windowMs: 300000 },  // 3 per 5 minutes
            changePassword: { max: 5, windowMs: 300000 }, // 5 per 5 minutes

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
            // No-payload table events (safeHandler's `limit`, checked at the
            // socket event only: joinMainRoom also leaves a lobby through
            // leaveLobby internally). Ready / Unready / Add Bot / Leave are
            // one per tap (web GameLobby, iOS LobbyEmitter), and each
            // broadcasts lobby state. joinMainRoom: web on entering the
            // main room; iOS on MainRoomView appear and after a sign-in,
            // restore, game end or tournament exit, so a few at once
            joinMainRoom: { max: 30, windowMs: 60000 },
            playerReady: { max: 20, windowMs: 10000 },
            playerUnready: { max: 20, windowMs: 10000 },
            leaveLobby: { max: 20, windowMs: 30000 },
            addBot: { max: 20, windowMs: 30000 },
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
            // (a family lobby or a casual game with spectators is up to 8
            // people: 7 peers each, 2026-11-16; a table alone was 3).
            // Measured 2026-11-11 in the desktop app's Chromium with the
            // clients' two Google STUN servers: 2 candidates per peer
            // connection (mDNS host), gathered in ~20 ms; more interfaces,
            // IPv6, iOS cellular and several Cloudflare relay URLs
            // (turnCredentials.js) add a few srflx/host/relay each, so
            // 600 / 10 s leaves room for a 7-peer burst plus a restart.
            // Offers/answers: one per peer plus renegotiation and restarts
            // (estimates: not yet measured with TURN).
            // (The old web PCM relay and its voiceRelayAudio key are gone:
            // V1_REMOVALS #20.)
            voiceOffer: { max: 60, windowMs: 10000 },
            voiceAnswer: { max: 60, windowMs: 10000 },
            voiceIceCandidate: { max: 600, windowMs: 10000 },
            // "Spectators can talk" (lobby host / in-game controller): one per
            // tap; the game coalesces changes to one per 3 s anyway
            setSpectatorsCanTalk: { max: 4, windowMs: 30000 },
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
            // seat; a bot removal per bot in the lobby, and addBot is limited)
            'forceResign',
            'removeBot'
        ]);
        this.warnedUnknown = new Set();

        // Token buckets keyed by something other than the socket:
        // { burst: capacity, perHour: refill rate, maxKeys }. A missing key
        // is a full bucket, so a bucket that has refilled is dropped by the
        // sweep below and memory stays bounded by the keys active within
        // about an hour. maxKeys is a backstop: only refilled keys are ever
        // dropped to make room, and a map full of spent keys refuses new
        // keys (fails closed, like signInThrottle), so rotating addresses
        // can never push a spent key out and reset it.
        // - signUpIp: accounts created per client IP (IPv6 by its /64,
        //   clientIp.ipBucketKey), charged only for an attempt that will
        //   hash and insert (authHandlers.signUp). 5 at once covers a
        //   family installing together behind one router; then 5 an hour
        // - signUpNet48: the same per IPv6 /48 (clientIp.ipNet48Key; IPv4
        //   has no such tier). One VPS or customer allocation is 256 to
        //   65,536 /64s, so without it a single host could drain
        //   signUpGlobal alone. 10 at once, then 10 an hour
        // - signUpGlobal: accounts created on the whole server, so rotating
        //   IPs cannot flood users or fill the hash pool either. Far above
        //   a family app's real rate; a warn line says when it bites. The
        //   known trade-off: about 12 IPv4 addresses (or /48s) keeping it
        //   empty refuse every new account until they stop (existing
        //   accounts are unaffected); the warn line is the one to alert on
        this.buckets = {
            signUpIp: { burst: 5, perHour: 5, maxKeys: 10000 },
            signUpNet48: { burst: 10, perHour: 10, maxKeys: 10000 },
            signUpGlobal: { burst: 20, perHour: 60, maxKeys: 1 },
            // - clientErrorIp / clientErrorGlobal: client error reports
            //   (clientErrorHandlers.js) per client IP (IPv6 by its /64) and
            //   server-wide, on top of 5 a minute / 50 a day per socket. A
            //   client sends one per kind per session, so these only bite on
            //   a bug every player hits at once (the first reports are
            //   enough) or on a flood; over them a report is dropped silently
            clientErrorIp: { burst: 20, perHour: 30, maxKeys: 10000 },
            clientErrorGlobal: { burst: 200, perHour: 1200, maxKeys: 1 }
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

    /** The bucket `name` / `key` (or the stored entry `stored`) refilled to now (not stored). */
    refill(name, key, now, stored = this.bucketState.get(name)?.get(key)) {
        const cfg = this.buckets[name];
        const b = stored;
        if (!b) return { tokens: cfg.burst, at: now };
        const tokens = Math.min(cfg.burst, b.tokens + ((now - b.at) / 3600000) * cfg.perHour);
        return { tokens, at: now };
    }

    /**
     * Whether a token could be taken now, without taking it (so several
     * buckets can be checked before any is charged).
     * @returns {{ok: boolean, retryAfterMs: number}} retryAfterMs: until a
     *   token is back (0 when ok)
     */
    peek(name, key, now = Date.now()) {
        const cfg = this.buckets[name];
        const map = this.bucketState.get(name);
        if (map && !map.has(key) && !this.makeRoom(name, map, now)) {
            // Full of spent keys: refuse a new one until the oldest refills
            const [, oldest] = map.entries().next().value;
            const deficit = cfg.burst - this.refill(name, null, now, oldest).tokens;
            return { ok: false, retryAfterMs: Math.ceil((deficit / cfg.perHour) * 3600000) };
        }
        const b = this.refill(name, key, now);
        if (b.tokens < 1) {
            return { ok: false, retryAfterMs: Math.ceil(((1 - b.tokens) / cfg.perHour) * 3600000) };
        }
        return { ok: true, retryAfterMs: 0 };
    }

    /**
     * Room for one more key in a bucket map: drop refilled keys (the same
     * as no entry). Never drops a key that still owes tokens.
     * @returns {boolean} whether a new key fits
     */
    makeRoom(name, map, now) {
        const cfg = this.buckets[name];
        if (map.size < cfg.maxKeys) return true;
        for (const key of Array.from(map.keys())) {
            if (this.refill(name, key, now).tokens >= cfg.burst) map.delete(key);
        }
        return map.size < cfg.maxKeys;
    }

    /**
     * Take one token from bucket `name` for `key`.
     * @returns {{ok: boolean, retryAfterMs: number}} as peek()
     */
    take(name, key, now = Date.now()) {
        const seen = this.peek(name, key, now);
        if (!seen.ok) return seen;
        let map = this.bucketState.get(name);
        if (!map) {
            map = new Map();
            this.bucketState.set(name, map);
        }
        const b = this.refill(name, key, now);
        b.tokens -= 1;
        map.delete(key); // re-insert: insertion order = least recently used first
        map.set(key, b);
        return seen;
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
