/**
 * One serial mutation queue per Cloudflare session (Cloudflare: serialize
 * mutations per session; a second tracks/new before the previous exchange
 * completes can answer 406). Keyed by a string (the session id, or
 * `member:<username>` for a member's session creation).
 *
 * `run(key, job)` queues `job()` behind everything already queued on `key`
 * and resolves to its result. A queue holds at most MAX_DEPTH client jobs
 * (running one included): past it `run` resolves at once to {dropped:
 * 'busy'}. A client job that has not STARTED within WAIT_MS (3 s) resolves
 * to {dropped: 'busy'} then and never runs, so a client's reply comes
 * within WAIT_MS + one Cloudflare call (8 s): an ask the client gave up on
 * never reaches Cloudflare later (docs/claude/voice.md, step 8).
 * `drop(key, reason)` empties a queue: every client job not started yet
 * resolves to {dropped: reason} without running (the spike's churn case: a
 * pull still queued on a session the member replaced, or one that answered
 * 410, must not hold the new session's work for ~5 s per call). The running
 * job finishes; its caller re-checks whether its session is still current.
 *
 * `run(key, job, {internal: true})`: the server's own work (closing what a
 * member may no longer hear: sfuRoom revoke / block enforcement). It has no
 * wait deadline, no depth limit, and `drop` keeps it queued.
 */

'use strict';

const { safeTimeout } = require('../../utils/safeTimer');

const MAX_DEPTH = 16;
const WAIT_MS = 3000;

function createSessionQueues({ maxDepth = MAX_DEPTH, waitMs = WAIT_MS } = {}) {
    // key -> {running: boolean, jobs: [{job, resolve, internal, timer}]}
    const queues = new Map();

    function pump(key) {
        const q = queues.get(key);
        if (!q || q.running) return;
        const next = q.jobs.shift();
        if (!next) {
            queues.delete(key);
            return;
        }
        if (next.timer) clearTimeout(next.timer);
        q.running = true;
        Promise.resolve()
            .then(() => next.job())
            .then((value) => next.resolve(value), (err) => next.resolve({ dropped: 'error', error: err }))
            .finally(() => {
                q.running = false;
                pump(key);
            });
    }

    function run(key, job, { internal = false } = {}) {
        let q = queues.get(key);
        if (!q) {
            q = { running: false, jobs: [] };
            queues.set(key, q);
        }
        if (!internal && q.jobs.filter((j) => !j.internal).length + (q.running ? 1 : 0) >= maxDepth) return Promise.resolve({ dropped: 'busy' });
        return new Promise((resolve) => {
            const entry = { job, resolve, internal, timer: null };
            if (!internal && waitMs > 0) {
                entry.timer = safeTimeout(() => {
                    const i = q.jobs.indexOf(entry);
                    if (i === -1) return;
                    q.jobs.splice(i, 1);
                    resolve({ dropped: 'busy', waited: true });
                    if (!q.running && q.jobs.length === 0 && queues.get(key) === q) queues.delete(key);
                }, waitMs, 'sfuQueueWait');
                if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
            }
            q.jobs.push(entry);
            pump(key);
        });
    }

    function drop(key, reason) {
        const q = queues.get(key);
        if (!q) return 0;
        const dropped = q.jobs.filter((j) => !j.internal);
        q.jobs = q.jobs.filter((j) => j.internal);
        for (const j of dropped) {
            if (j.timer) clearTimeout(j.timer);
            j.resolve({ dropped: reason });
        }
        if (!q.running && q.jobs.length === 0) queues.delete(key);
        return dropped.length;
    }

    /** Jobs queued or running on `key`. */
    const depth = (key) => {
        const q = queues.get(key);
        return q ? q.jobs.length + (q.running ? 1 : 0) : 0;
    };

    return { run, drop, depth, size: () => queues.size };
}

module.exports = { MAX_DEPTH, WAIT_MS, createSessionQueues };
