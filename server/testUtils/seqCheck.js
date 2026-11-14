/**
 * seq invariants (contract/README.md R1) over every instrumented emit while
 * watching (test-only):
 *   - per game, room broadcasts carry strictly increasing seq, and the
 *     gameStarts of one deal all carry the same value;
 *   - per receiving socket, while it stays in the game room, the room
 *     broadcasts and gameStarts it receives go 1 by 1 with no gap and no
 *     repeat (a socket that missed a room emit starts over: it would
 *     resync from a snapshot);
 *   - a socket that gets a snapshot (to itself) continues from its seq
 *     (R5): its next room event is snapshot.seq + 1;
 *   - nothing reaches a game room after its gameEnd / abortGame.
 * The game room's members come from the log entry (`members`, as the chaos
 * and tournament stub io record them) or from io.rooms at emit time.
 */

'use strict';

const contractCheck = require('./contractCheck');

function watchSeq(io) {
    const failures = [];
    const games = new Map(); // gameId -> {lastRoom, lastEvent, lastSeq, perSocket: Map, ended}
    const g = (id) => {
        if (!games.has(id)) games.set(id, { lastSeq: 0, lastEvent: null, perSocket: new Map(), ended: false });
        return games.get(id);
    };
    const fail = (why, extra) => {
        if (failures.length < 20) failures.push({ why, ...extra });
    };
    const receive = (st, sid, seq, gameId, event) => {
        const prev = st.perSocket.get(sid);
        if (prev !== undefined && seq !== prev + 1) fail('gap or repeat for a receiver', { gameId, sid, event, prev, seq });
        st.perSocket.set(sid, seq);
    };

    const off = contractCheck.onEmit((entry, wire) => {
        const to = String(entry.to);
        if (to.startsWith('game:')) {
            const gameId = to.slice(5);
            const st = g(gameId);
            if (st.ended) fail('emit after terminal', { gameId, event: entry.event });
            const seq = wire && wire.seq;
            if (!Number.isInteger(seq)) return; // the contract guard reports it
            if (seq <= st.lastSeq) fail('room seq not increasing', { gameId, event: entry.event, seq, last: st.lastSeq });
            st.lastSeq = seq;
            st.lastEvent = entry.event;
            const all = entry.members || [...((io.rooms && io.rooms.get(to)) || [])];
            const members = all.filter((m) => m !== entry.except);
            // A socket left out with socket.to(room) is still in the room:
            // it keeps its place, so it sees the seq it missed as a gap
            // unless a snapshot sent to it afterwards covers it (below)
            const inRoom = new Set(all);
            for (const sid of [...st.perSocket.keys()]) if (!inRoom.has(sid)) st.perSocket.delete(sid);
            for (const sid of members) receive(st, sid, seq, gameId, entry.event);
            if (entry.event === 'gameEnd' || entry.event === 'abortGame') st.ended = true;
            return;
        }
        // A snapshot to one socket (rejoin / restore / spectator full state /
        // actionRejected / stateSnapshot): R5, the receiver's lastSeq is now
        // snapshot.seq, so its next room event must be snapshot.seq + 1
        const snap = wire && wire.snapshot;
        const one = to.startsWith('self:') ? to.slice(5) : (io.sockets && io.sockets.sockets && io.sockets.sockets.has(to) ? to : null);
        if (one && snap && snap.gameId && Number.isInteger(snap.seq)) {
            g(snap.gameId).perSocket.set(one, snap.seq);
            return;
        }
        if (entry.event === 'gameStart' && wire && wire.gameId) {
            const st = g(wire.gameId);
            const seq = wire.seq;
            if (!Number.isInteger(seq)) return;
            if (st.lastEvent === 'gameStart') {
                if (seq !== st.lastSeq) fail('gameStarts of one deal differ', { gameId: wire.gameId, seq, deal: st.lastSeq });
            } else if (seq <= st.lastSeq) {
                fail('gameStart seq not increasing', { gameId: wire.gameId, seq, last: st.lastSeq });
            }
            st.lastSeq = seq;
            st.lastEvent = 'gameStart';
            const sid = to.startsWith('self:') ? to.slice(5) : to;
            receive(st, sid, seq, wire.gameId, 'gameStart');
        }
    });
    return {
        stop() {
            off();
            return { failures, games: games.size };
        },
    };
}

module.exports = { watchSeq };
