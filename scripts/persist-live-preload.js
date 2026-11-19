// Preload for the deploy-survival live harness (scripts/persist-live-harness.sh), never for
// production: `node -r scripts/persist-live-preload.js server/index.js`.
//
// Wraps scripts/ios-live-resume-preload.js (port 3000 -> BAB_LIVE_PORT on 127.0.0.1, the
// 'babonline' database -> BAB_LIVE_DB, '[keeplog]' handshake / event lines), with:
//
// - '[keeplog]' lines never carry a hand: the wrapped preload prints a stateSnapshot's hand,
//   this one cuts it to its card count before the line is written.
// - '[persistlog]' lines: every write and read the live persist store makes on liveGames,
//   liveTournaments and serverInstances (MongoDB driver level, so it works with any store
//   version): op, collection, id, rev, stage, outcome and duration only. Never a document,
//   a hand, a log line or chat (no update document or filter is printed; a filter's id list
//   is printed as its length). Heartbeats are printed only when they fail. Plus this
//   process's boot, its signals and its exit code.
// - Triggers, armed by a file $BAB_PERSIST_CTL/arm-<BAB_PERSIST_TAG> (one word, optionally
//   followed by delay=<ms>; read every 200 ms, then removed) or BAB_PERSIST_ARM at boot:
//     kill-after-card-2        SIGKILL this process after the second cardPlayed broadcast
//                              from the moment it was armed (delay=<ms> after it, default 250,
//                              so the card's own write usually lands: "at most one action behind")
//     kill-after-gameEnd-fire  SIGKILL this process at its next gameRecords access (a game's
//                              stats write: after gameEnd and the ENDED tombstone claim, before
//                              insertGameRecord), so a successor must record the tombstone
//     throw-now                an uncaught exception now (the crash path: exit 1)
//   Each writes $BAB_PERSIST_CTL/arm-<tag>.fired (the trigger name) just before it fires.
'use strict';

// Worker threads inherit `-r`: everything here is for the main thread only (a trigger read
// by a worker would fire in the wrong place)
if (!require('worker_threads').isMainThread) return;

const fs = require('fs');
const path = require('path');

const tag = process.env.BAB_PERSIST_TAG || process.env.BAB_LIVE_PORT || String(process.pid);
const ctl = process.env.BAB_PERSIST_CTL || '';
const t = () => new Date().toISOString().slice(11, 23);

// ---- hands never reach the log ([keeplog] lines of the wrapped preload) ----
const origLog = console.log.bind(console);
const cutHand = (a) => (typeof a === 'string' ? a.replace(/hand\((\d+)\)=\[[^\]]*\]/g, 'hand($1)') : a);
console.log = (...args) => origLog(...(args[0] === '[keeplog]' ? args.map(cutHand) : args));
const plog = (...a) => origLog('[persistlog]', t(), `tag=${tag}`, ...a);

require('./ios-live-resume-preload.js');

// ---- [persistlog]: the store's MongoDB operations ----
const mongodb = require(require.resolve('mongodb', { paths: [process.cwd()] }));
const LIVE = new Set(['liveGames', 'liveTournaments', 'serverInstances']);
const short = (v) => (typeof v === 'string' ? v : v == null ? '-' : String(v));

/** id / rev / stage of an op, from its filter and update or document (never their contents). */
function describe(filter, update) {
    const f = filter && typeof filter === 'object' ? filter : {};
    const set = update && typeof update === 'object' ? (update.$set || update) : {};
    let id = '-';
    if (typeof f._id === 'string') id = f._id;
    else if (f._id && Array.isArray(f._id.$in)) id = `[${f._id.$in.length} ids]`;
    else if (typeof set._id === 'string') id = set._id;
    else if (f.owner !== undefined) id = 'owner';
    const rev = set.rev ?? f.rev;
    const stage = set.stage ?? set.phase;
    const parts = [`id=${id}`];
    if (rev !== undefined) parts.push(`rev=${short(rev)}`);
    if (stage !== undefined) parts.push(`stage=${short(stage)}`);
    if (typeof set.kind === 'string') parts.push(`kind=${set.kind}`);
    if (set.released === true) parts.push('release');
    if (set.shuttingDown === true) parts.push('shuttingDown');
    return parts.join(' ');
}

function outcome(op, res) {
    if (res == null) return op.startsWith('find') ? 'none' : 'null';
    if (op === 'findOne') return 'found';
    if (op === 'findOneAndUpdate') return res.value === null ? 'none' : (res.value !== undefined || res._id ? 'ok' : 'none');
    if (typeof res.matchedCount === 'number') return `matched=${res.matchedCount} modified=${res.modifiedCount}${res.upsertedCount ? ` upserted=${res.upsertedCount}` : ''}`;
    if (typeof res.deletedCount === 'number') return `deleted=${res.deletedCount}`;
    if (res.insertedId !== undefined) return 'inserted';
    return res.acknowledged === false ? 'unacknowledged' : 'ok';
}

const triggers = { armed: null, cards: 0, delay: 250 };

function fire(name, how) {
    plog(`trigger=${name} firing`);
    if (ctl) {
        try { fs.writeFileSync(path.join(ctl, `arm-${tag}.fired`), `${name}\n`); } catch { /* best effort */ }
    }
    how();
}
const sigkill = () => process.kill(process.pid, 'SIGKILL');

const OPS = ['insertOne', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOne', 'findOneAndUpdate'];
for (const op of OPS) {
    const orig = mongodb.Collection.prototype[op];
    if (typeof orig !== 'function') continue;
    mongodb.Collection.prototype[op] = function (...args) {
        const coll = this.collectionName;
        if (coll === 'gameRecords' && triggers.armed === 'kill-after-gameEnd-fire' && (op === 'insertOne' || op === 'findOne')) {
            triggers.armed = null;
            fire('kill-after-gameEnd-fire', sigkill);
            // SIGKILL is synchronous for the process itself; nothing below runs
        }
        if (!LIVE.has(coll)) return orig.apply(this, args);
        const heartbeat = coll === 'serverInstances' && op === 'updateOne';
        const what = op === 'insertOne' ? describe(null, args[0]) : describe(args[0], args[1]);
        const start = Date.now();
        const done = (res) => {
            if (!heartbeat) plog(`op=${op} coll=${coll} ${what} outcome=${outcome(op, res)} ms=${Date.now() - start}`);
            return res;
        };
        const failed = (err) => {
            plog(`op=${op} coll=${coll} ${what} outcome=error:${err && (err.code || err.name)} ms=${Date.now() - start}`);
            throw err;
        };
        let p;
        try {
            p = orig.apply(this, args);
        } catch (err) {
            failed(err);
        }
        return p && typeof p.then === 'function' ? p.then(done, failed) : p;
    };
}

// ---- triggers ----
const sioDir = path.dirname(path.dirname(require.resolve('socket.io', { paths: [process.cwd()] })));
const { BroadcastOperator } = require(path.join(sioDir, 'dist/broadcast-operator.js'));
const origBroadcastEmit = BroadcastOperator.prototype.emit;
BroadcastOperator.prototype.emit = function (ev, ...args) {
    const out = origBroadcastEmit.call(this, ev, ...args);
    if (ev === 'cardPlayed' && triggers.armed === 'kill-after-card-2') {
        triggers.cards++;
        if (triggers.cards >= 2) {
            triggers.armed = null;
            const delay = triggers.delay;
            setTimeout(() => fire('kill-after-card-2', sigkill), delay);
        }
    }
    return out;
};

function arm(line) {
    const [name, ...opts] = String(line).trim().split(/\s+/);
    if (!name) return;
    const known = ['kill-after-card-2', 'kill-after-gameEnd-fire', 'throw-now'];
    if (!known.includes(name)) {
        plog(`trigger=${name} unknown (expected ${known.join(', ')})`);
        return;
    }
    const delayOpt = opts.find((o) => o.startsWith('delay='));
    triggers.delay = delayOpt ? Math.max(0, Number(delayOpt.slice(6)) || 0) : 250;
    triggers.cards = 0;
    plog(`trigger=${name} armed${name === 'kill-after-card-2' ? ` delay=${triggers.delay}` : ''}`);
    if (name === 'throw-now') {
        fire('throw-now', () => setImmediate(() => { throw new Error('persist-live-harness throw-now'); }));
        return;
    }
    triggers.armed = name;
}

if (process.env.BAB_PERSIST_ARM) arm(process.env.BAB_PERSIST_ARM);
if (ctl) {
    const armFile = path.join(ctl, `arm-${tag}`);
    const poll = setInterval(() => {
        let line;
        try {
            line = fs.readFileSync(armFile, 'utf8');
        } catch {
            return;
        }
        try { fs.unlinkSync(armFile); } catch { /* already gone */ }
        arm(line);
    }, 200);
    poll.unref();
}

// ---- lifecycle ----
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => plog(`signal=${sig}`));
process.on('exit', (code) => plog(`exit=${code}`));
plog(`boot pid=${process.pid} mode=${process.env.LIVE_PERSIST || 'off'} deployment=${(process.env.RAILWAY_DEPLOYMENT_ID || 'local').slice(0, 8)}`);
