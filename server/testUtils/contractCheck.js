/**
 * Socket-contract checking for Jest (test-only; production code never
 * requires contract/).
 *
 * instrument(log) wraps the push of a gameDriver emit log so every entry is,
 * synchronously (payloads hold live references to game state):
 *   - turned into its wire form (a JSON round-trip, as socket.io does),
 *   - validated against contract/events.schema.json (validateS2C),
 *   - recorded in `observed`.
 * Entries addressed to `bot:` sockets are skipped (lobby emits to bot
 * members never reach a wire), and so are test markers whose event starts
 * with '__'. A violation (bad payload, unknown event, a
 * clientOnly event the server must never send) is collected here and
 * contractGuard.js fails the test that produced it.
 *
 * Escape hatches: contractGuard.skip(reason) for one test (synthetic
 * forcePhase states only; every use is listed in contract/README.md), and
 * BAB_CONTRACT=0 for a whole run.
 */

'use strict';

const contract = require('../../contract');

const state = {
    violations: [],
    observed: new Map(),       // event -> count
    unknownEvents: new Set(),
    context: null,             // e.g. 'chaos seed 17'
    listeners: [],             // fn(entry, wire) hooks (seq / snapshot invariants)
};

// Memo of payload shapes already validated: (event, structural key) -> ok.
// A structural key that differs in any value-bearing way is re-validated,
// so the memo only skips exact repeats.
const memo = new Map();
const MEMO_MAX = 50000;

function enabled() {
    return process.env.BAB_CONTRACT !== '0';
}

/** The schema `to` kind of a logged emit target. */
function targetKind(to) {
    const t = String(to);
    if (t.startsWith('self:')) return 'self';
    if (t.startsWith('game:')) return 'room';
    if (t.startsWith('tournament:')) return 'tournament';
    if (t === 'mainRoom') return 'mainRoom';
    if (t === '*') return 'all';
    return 'socket';
}

/** Problems with `entry` reaching a kind of target its schema entry does not list. */
function routeErrors(event, to) {
    const entry = contract.schema.s2c[event];
    if (!entry || entry.to === undefined) return [];
    // self (socket.emit) and socket (io.to(socketId)) both reach exactly one
    // client: the same thing on the wire
    const norm = (k) => (k === 'self' || k === 'socket' ? 'private' : k);
    const allowed = [].concat(entry.to);
    const kind = targetKind(to);
    return allowed.map(norm).includes(norm(kind)) ? []
        : [{ path: '$', message: `'${event}' sent to ${kind} (${to}); the schema allows ${allowed.join(' | ')}` }];
}

function check(entry) {
    if (typeof entry.to === 'string' && entry.to.startsWith('bot:')) return;
    const { event, data } = entry;
    // Test markers pushed into the same log (e.g. '__recordGameStats')
    if (event.startsWith('__')) return;
    const wire = data === undefined ? undefined : JSON.parse(JSON.stringify(data));
    state.observed.set(event, (state.observed.get(event) || 0) + 1);
    for (const fn of state.listeners) fn(entry, wire);
    if (!enabled()) return;

    let key = null;
    const json = wire === undefined ? 'u' : JSON.stringify(wire);
    if (json.length < 2000) {
        key = event + '\u0000' + targetKind(entry.to) + '\u0000' + json;
        if (memo.has(key)) return;
    }
    const r = contract.validateS2C(event, wire);
    let errors = r.errors;
    if (r.unknownEvent) state.unknownEvents.add(event);
    else if (r.status === 'clientOnly') errors = [{ path: '$', message: `'${event}' is clientOnly: the server must never emit it` }];
    else if (errors.length === 0) errors = routeErrors(event, entry.to);
    if (!r.unknownEvent && r.status !== 'clientOnly' && errors.length === 0) {
        // seq routing (variants alone cannot tell a room form from a private
        // one): every room broadcast and every gameStart carries seq, nothing
        // else carries a top-level seq
        const roomOrDeal = String(entry.to).startsWith('game:') || event === 'gameStart';
        const hasSeq = wire && typeof wire === 'object' && 'seq' in wire;
        if (roomOrDeal && !(hasSeq && Number.isInteger(wire.seq) && wire.seq >= 1)) {
            errors = [{ path: '$.seq', message: `room broadcast / gameStart '${event}' without an integer seq` }];
        } else if (!roomOrDeal && hasSeq && event !== 'gameStart') {
            errors = [{ path: '$.seq', message: `private '${event}' to ${entry.to} must not carry a top-level seq` }];
        }
    }
    if (errors.length === 0) {
        if (key) {
            if (memo.size > MEMO_MAX) memo.clear();
            memo.set(key, true);
        }
        return;
    }
    state.violations.push({
        event,
        to: entry.to,
        context: state.context,
        errors: errors.slice(0, 5),
        sample: json.length > 600 ? json.slice(0, 600) + '...' : json,
    });
}

/** Idempotent: wrap `log.push` so every pushed emit is contract-checked. */
function instrument(log) {
    if (!log || log.__contract) return log;
    const push = Array.prototype.push;
    Object.defineProperty(log, '__contract', { value: true, enumerable: false });
    Object.defineProperty(log, 'push', {
        enumerable: false,
        configurable: true,
        writable: true,
        value(...items) {
            for (const item of items) {
                if (item && typeof item === 'object' && typeof item.event === 'string') check(item);
            }
            return push.apply(this, items);
        },
    });
    return log;
}

/** Hook every instrumented emit: fn(entry, wire). Returns an unsubscribe. */
function onEmit(fn) {
    state.listeners.push(fn);
    return () => {
        state.listeners = state.listeners.filter((f) => f !== fn);
    };
}

module.exports = {
    instrument,
    onEmit,
    setContext: (label) => { state.context = label; },
    takeViolations() {
        const v = state.violations;
        state.violations = [];
        return v;
    },
    observed: () => new Map(state.observed),
    unknownEvents: () => new Set(state.unknownEvents),
    resetObserved() {
        state.observed.clear();
        state.unknownEvents.clear();
    },
    enabled,
};
