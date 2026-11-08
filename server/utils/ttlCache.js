/**
 * A one-value cache with a TTL and single-flight fills, for the leaderboard
 * and records pages (profileHandlers.js). No timers: freshness is checked
 * against Date.now() on read.
 *
 * - get(fill): the cached value while fresh; otherwise joins the fill already
 *   in flight, or starts one. A fill result is stored only if no invalidate()
 *   happened while it ran (the generation check), so a write that lands
 *   during a fill is never hidden behind a stale value. Errors are never
 *   cached (the next get retries).
 * - peek(): the last value even if expired (undefined after invalidate()).
 * - inflightPromise(): the fill currently running, or null.
 * - invalidate(): drop the value and detach any running fill, so the next
 *   get() starts a fresh read that sees every write so far.
 *
 * Callers must treat values as immutable: the same object is handed to
 * every reader.
 */
function createCache({ ttlMs }) {
    let value;
    let at = 0;
    let gen = 0;
    let inflight = null;

    return {
        get(fill) {
            if (value !== undefined && Date.now() - at < ttlMs) return Promise.resolve(value);
            if (inflight) return inflight;
            const startedGen = gen;
            const p = Promise.resolve()
                .then(fill)
                .then((v) => {
                    if (startedGen === gen) {
                        value = v;
                        at = Date.now();
                    }
                    return v;
                })
                .finally(() => {
                    if (inflight === p) inflight = null;
                });
            inflight = p;
            return p;
        },
        peek() {
            return value;
        },
        inflightPromise() {
            return inflight;
        },
        invalidate() {
            gen++;
            value = undefined;
            inflight = null;
        }
    };
}

module.exports = { createCache };
