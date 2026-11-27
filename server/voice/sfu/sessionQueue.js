/**
 * One serial mutation queue per Cloudflare session (Cloudflare: serialize
 * mutations per session; a second tracks/new before the previous exchange
 * completes can answer 406). Keyed by a string (the session id, or
 * `member:<username>` for a member's session creation).
 *
 * `run(key, job)` queues `job()` behind everything already queued on `key`
 * and resolves to its result. A queue holds at most MAX_DEPTH jobs (running
 * one included): past it `run` resolves at once to {dropped: 'busy'}.
 * `drop(key, reason)` empties a queue: every job not started yet resolves to
 * {dropped: reason} without running (the spike's churn case: a pull still
 * queued on a session the member replaced, or one that answered 410, must
 * not hold the new session's work for ~5 s per call). The running job
 * finishes; its caller re-checks whether its session is still current.
 */

'use strict';

const MAX_DEPTH = 16;

function createSessionQueues({ maxDepth = MAX_DEPTH } = {}) {
    // key -> {running: boolean, jobs: [{job, resolve}]}
    const queues = new Map();

    function pump(key) {
        const q = queues.get(key);
        if (!q || q.running) return;
        const next = q.jobs.shift();
        if (!next) {
            queues.delete(key);
            return;
        }
        q.running = true;
        Promise.resolve()
            .then(() => next.job())
            .then((value) => next.resolve(value), (err) => next.resolve({ dropped: 'error', error: err }))
            .finally(() => {
                q.running = false;
                pump(key);
            });
    }

    function run(key, job) {
        let q = queues.get(key);
        if (!q) {
            q = { running: false, jobs: [] };
            queues.set(key, q);
        }
        if (q.jobs.length + (q.running ? 1 : 0) >= maxDepth) return Promise.resolve({ dropped: 'busy' });
        return new Promise((resolve) => {
            q.jobs.push({ job, resolve });
            pump(key);
        });
    }

    function drop(key, reason) {
        const q = queues.get(key);
        if (!q) return 0;
        const jobs = q.jobs.splice(0);
        for (const j of jobs) j.resolve({ dropped: reason });
        if (!q.running) queues.delete(key);
        return jobs.length;
    }

    /** Jobs queued or running on `key`. */
    const depth = (key) => {
        const q = queues.get(key);
        return q ? q.jobs.length + (q.running ? 1 : 0) : 0;
    };

    return { run, drop, depth, size: () => queues.size };
}

module.exports = { MAX_DEPTH, createSessionQueues };
