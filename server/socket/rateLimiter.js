/**
 * Rate limiting for socket events
 * Prevents spam and abuse by limiting event frequency per socket
 */

class RateLimiter {
    constructor() {
        // Define rate limits per event type
        // { max: number of requests, windowMs: time window in milliseconds }
        this.limits = {
            // Auth - strict limits to prevent brute force
            signIn: { max: 5, windowMs: 60000 },       // 5 per minute
            signUp: { max: 3, windowMs: 300000 },      // 3 per 5 minutes

            // Chat - moderate limits
            chatMessage: { max: 10, windowMs: 10000 }, // 10 per 10 seconds

            // Game actions - reasonable limits for gameplay
            playCard: { max: 20, windowMs: 60000 },    // 20 per minute
            playerBid: { max: 10, windowMs: 60000 },   // 10 per minute
            draw: { max: 10, windowMs: 60000 },        // 10 per minute

            // Queue - prevent queue spam
            joinQueue: { max: 5, windowMs: 30000 },    // 5 per 30 seconds
            leaveQueue: { max: 5, windowMs: 30000 }    // 5 per 30 seconds
        };

        // Track requests: Map<string, number[]> where key is "socketId:event"
        this.requests = new Map();

        // Cleanup old entries periodically (every 5 minutes)
        this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
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
            console.warn(`Rate limit exceeded: ${socketId} for ${event} (${timestamps.length}/${limit.max})`);
            return false;
        }

        // Record this request
        timestamps.push(now);
        this.requests.set(key, timestamps);

        return true;
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

        if (cleaned > 0) {
            console.log(`Rate limiter cleanup: removed ${cleaned} stale entries`);
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
