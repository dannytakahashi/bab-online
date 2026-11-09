/**
 * Per-viewer event logs for the iOS reducer tests (dev/test only; item 23).
 *
 * Hooks every instrumented emit (contractCheck.onEmit), resolves its
 * recipients at emit time and appends what each watched socket received,
 * in its wire (JSON) form, to that viewer's log. c2s actions are appended
 * with recordC2S just before the handler runs. Checkpoints pair a viewer's
 * log position with the server's snapshot v2 for that socket at that
 * moment (snapshotFor with customPics:false, log:false: emits nothing and
 * draws no randomness), so a client that applies log[0, afterIndex) must
 * hold the checkpoint's table.
 *
 * Output shape (iosEventLogs.test.js writes it):
 *   {name, seed, gameId, viewers[{label, sid, role, position, username}],
 *    logs{label: [{i, dir, event, to, t, data}]},
 *    checkpoints[{viewer, afterIndex, snapshot}],
 *    final{label: {afterIndex, snapshot, gameEnd}}}
 */

'use strict';

const contractCheck = require('./contractCheck');
const { snapshotFor } = require('../socket/snapshotHandlers');

const START_EVENTS = {
    seat: ['allPlayersReady'],
    rejoin: ['rejoinSuccess'],
    spectator: ['spectatorJoined'],
};

function createEventRecorder(w, { t0 = Date.now(), getGame } = {}) {
    const viewers = new Map(); // label -> {label, sid, role, started, log, open}
    const checkpoints = [];
    const final = {};
    let gameId = null;
    let awaitingTurn = false; // a gameStart went out and its updateTurn did not yet
    let lastHandComplete = null; // label -> {afterIndex, snapshot} at the latest handComplete

    const bySid = (sid) => [...viewers.values()].filter((v) => v.sid === sid && v.open);

    function recipients(entry) {
        const to = String(entry.to);
        if (to === '*' || to === 'mainRoom' || to.startsWith('tournament:')) return [];
        if (to.startsWith('self:')) return [to.slice(5)];
        if (to.startsWith('game:')) {
            return [...(w.io.rooms.get(to) || [])].filter((m) => m !== entry.except);
        }
        return [to]; // io.to(<socketId>)
    }

    function append(v, item) {
        v.log.push({ i: v.log.length, ...item });
    }

    const off = contractCheck.onEmit((entry, wire) => {
        const { event } = entry;
        if (event === 'gameStart') awaitingTurn = true;
        if (event === 'updateTurn') awaitingTurn = false;
        const room = String(entry.to).startsWith('game:');
        if (room && !gameId) gameId = String(entry.to).slice(5);
        for (const sid of recipients(entry)) {
            for (const v of bySid(sid)) {
                if (!v.started) {
                    if (!START_EVENTS[v.role].includes(event)) continue;
                    // a spectator's own full state, not someone else's notice
                    if (event === 'spectatorJoined' && !(wire && wire.snapshot)) continue;
                    v.started = true;
                }
                append(v, { dir: 's2c', event, to: room ? 'room' : 'private', t: Date.now() - t0, data: wire === undefined ? null : wire });
            }
        }
        // handComplete goes out with the table final (HAND_RESOLVING, scores
        // in); the next deal or gameEnd follows in the same tick, so this is
        // the only moment to checkpoint it
        if (event === 'handComplete' && room && getGame) {
            const game = getGame();
            if (game) {
                lastHandComplete = snapshotAllOf(game);
                for (const [label, c] of lastHandComplete) checkpoints.push({ viewer: label, afterIndex: c.afterIndex, snapshot: c.snapshot });
            }
        }
    });

    function snapshotAllOf(game) {
        const out = new Map();
        for (const v of viewers.values()) {
            if (!v.open || !v.started) continue;
            out.set(v.label, { afterIndex: v.log.length, snapshot: JSON.parse(JSON.stringify(snapshotFor(game, v.sid, { customPics: false, log: false }))) });
        }
        return out;
    }

    return {
        /** Start a log for socket `sid`. role: seat | rejoin | spectator (which event opens the log). */
        watch(label, sid, role = 'seat') {
            if (viewers.has(label)) throw new Error(`recorder: viewer '${label}' already watched`);
            viewers.set(label, { label, sid, role, started: false, open: true, log: [] });
        },
        /** The socket is gone (killed): nothing more is recorded for it. */
        close(label) {
            viewers.get(label).open = false;
        },
        recordC2S(sid, event, data) {
            for (const v of bySid(sid)) {
                if (v.started) append(v, { dir: 'c2s', event, to: 'server', t: Date.now() - t0, data: JSON.parse(JSON.stringify(data)) });
            }
        },
        /** True when a checkpoint now would sit between a gameStart and its updateTurn. */
        get awaitingTurn() { return awaitingTurn; },
        /** Snapshot every open, started viewer of `game` (skips unchanged logs). */
        checkpoint(game) {
            if (awaitingTurn) return 0;
            let n = 0;
            for (const v of viewers.values()) {
                if (!v.open || !v.started) continue;
                const last = checkpoints.filter((c) => c.viewer === v.label).pop();
                if (last && last.afterIndex === v.log.length) continue;
                const snapshot = JSON.parse(JSON.stringify(snapshotFor(game, v.sid, { customPics: false, log: false })));
                checkpoints.push({ viewer: v.label, afterIndex: v.log.length, snapshot });
                n++;
            }
            return n;
        },
        /** The end state for every open viewer: the last-hand snapshot (taken before gameEnd) + the gameEnd it received. */
        finalize() {
            for (const v of viewers.values()) {
                if (!v.open || !v.started) continue;
                const end = v.log.find((e) => e.event === 'gameEnd');
                const snap = lastHandComplete && lastHandComplete.get(v.label);
                if (!end || !snap) throw new Error(`recorder: viewer '${v.label}' has no final hand snapshot or gameEnd`);
                final[v.label] = { afterIndex: snap.afterIndex, snapshot: snap.snapshot, gameEnd: end.data };
            }
        },
        viewer: (label) => viewers.get(label),
        toJSON(meta, game) {
            const list = [...viewers.values()].map((v) => {
                const seatPos = game ? [1, 2, 3, 4].find((p) => game.seat(p) && game.seat(p).ownerUsername === meta.usernames[v.sid]) : null;
                return { label: v.label, sid: v.sid, role: v.role, position: v.role === 'spectator' ? null : (seatPos ?? null), username: meta.usernames[v.sid] ?? null };
            });
            const logs = {};
            for (const v of viewers.values()) logs[v.label] = v.log;
            return { name: meta.name, seed: meta.seed, ...(meta.extra || {}), gameId, viewers: list, logs, checkpoints, final };
        },
        stop: off,
    };
}

/** One log entry / checkpoint per line, so a diff of a re-record stays readable. */
function serialize(rec) {
    const lines = ['{'];
    const keys = Object.keys(rec);
    keys.forEach((k, ki) => {
        const comma = ki < keys.length - 1 ? ',' : '';
        const v = rec[k];
        if (k === 'logs') {
            lines.push('  "logs": {');
            const labels = Object.keys(v);
            labels.forEach((label, li) => {
                lines.push(`    ${JSON.stringify(label)}: [`);
                v[label].forEach((e, ei) => lines.push(`      ${JSON.stringify(e)}${ei < v[label].length - 1 ? ',' : ''}`));
                lines.push(`    ]${li < labels.length - 1 ? ',' : ''}`);
            });
            lines.push(`  }${comma}`);
        } else if (k === 'checkpoints' || k === 'viewers') {
            lines.push(`  ${JSON.stringify(k)}: [`);
            v.forEach((e, ei) => lines.push(`    ${JSON.stringify(e)}${ei < v.length - 1 ? ',' : ''}`));
            lines.push(`  ]${comma}`);
        } else if (k === 'final') {
            lines.push('  "final": {');
            const labels = Object.keys(v);
            labels.forEach((label, li) => lines.push(`    ${JSON.stringify(label)}: ${JSON.stringify(v[label])}${li < labels.length - 1 ? ',' : ''}`));
            lines.push(`  }${comma}`);
        } else {
            lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
        }
    });
    lines.push('}');
    return lines.join('\n') + '\n';
}

module.exports = { createEventRecorder, serialize };
