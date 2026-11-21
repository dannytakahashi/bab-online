/**
 * Live emit scan for the over-the-shoulder view (server/socket/shoulderView.js,
 * docs/claude/spectators.md "Over-the-shoulder view"). Hooks every
 * contract-checked emit (contractCheck.onEmit: called before the emit is
 * logged, so the server state it reads is the state at that emit) and
 * checks, for every receiving socket:
 *
 *   - shoulder data (gameStart.shoulder, a snapshot's viewer.shoulder,
 *     `shoulder` on spectator entries, assistHint.watched, a stateSnapshot
 *     with reason watchHand) never goes to a room and only to a socket
 *     with the clientHello cap shoulderView;
 *   - a watched hand ({position, hand, hsi}) goes only to a pure spectator
 *     of that game whose watch is that position (game.shoulders), never at a
 *     tournament table, never against the own-seat rule, and is exactly
 *     that seat's hand and HSI;
 *   - a seat gameStart / a snapshot hand goes only to that seat's owner
 *     socket and is that seat's hand; a spectator's gameStart hand is []
 *     and a non-owner gets no HSI at all (no hsiValues, snapshot hsi null);
 *     with `ownerHsi: 'own'` an owner's HSI holds only its own seat;
 *   - a mirrored assistHint (watched) goes only to a watcher of that seat,
 *     without note / actions, never kind status; any other non-status
 *     assistHint goes to a seat owner socket;
 *   - the `shoulder` on spectator entries is who watches which hand now,
 *     and every snapshot to a capable socket carries it (a snapshot path
 *     that forgets the receiving socket drops it);
 *   - nothing about a hand (shoulder, mirrored hint) ever comes from a
 *     tournament table (the game's own tournamentId or the map), nor from
 *     a table that is suspended, frozen or over: checked here on its own,
 *     not through shoulderView's rules.
 *
 * watchShoulders(getIo, opts) -> {failures, counts, stop()}.
 */

'use strict';

const contractCheck = require('./contractCheck');

const lazy = {
    get gm() { return require('../game/GameManager'); },
    get clientInfo() { return require('../socket/clientInfo'); },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cards = (hand) => (hand || []).map((c) => ({ suit: c.suit, rank: c.rank }));

function recipientsOf(io, entry) {
    const to = String(entry.to);
    if (to.startsWith('self:')) return [to.slice(5)];
    if (to === '*') return [...io.sockets.sockets.keys()];
    if (to.startsWith('game:') || to.startsWith('tournament:') || to === 'mainRoom') {
        const members = entry.members || [...(io.rooms?.get(to) || [])];
        return members.filter((sid) => sid !== entry.except);
    }
    return [to];
}

const isRoom = (entry) => /^(game:|tournament:|mainRoom$|\*$)/.test(String(entry.to));

function gameOf(entry, sid) {
    const gm = lazy.gm;
    const id = entry.data?.gameId || entry.data?.snapshot?.gameId;
    if (id) return gm.getGameById(id);
    return gm.getPlayerGame(sid) || gm.getGameById(gm.spectatorGames.get(sid));
}

/** Why no hand may come out of `game` right now (independent of shoulderView.js), or null. */
function closedTable(game) {
    if (game.tournamentId || lazy.gm.tournamentGames.has(game.gameId)) return 'a tournament table';
    if (game.isSuspended) return 'a suspended table';
    if (game.frozen) return 'a frozen table';
    if (game.isTerminal()) return 'an ended table';
    return null;
}

function isPureSpectator(game, sid) {
    const gm = lazy.gm;
    return !!game && game.isSpectator(sid) && gm.spectatorGames.get(sid) === game.gameId && !gm.playerGames.has(sid);
}

function ownSeat(game, sid) {
    const gm = lazy.gm;
    return game.seatByUsername(game.spectators.get(sid)?.username) || game.seatByUsername(gm.getUserBySocketId(sid)?.username) || null;
}

const seatHand = (game, pos) => cards(game.hands[game.positions[pos]]);

/** The shoulder bits of one payload. */
function bitsOf(entry) {
    const d = entry.data;
    if (!d || typeof d !== 'object') return { any: false, hands: [], entries: [], watched: null, reply: false };
    const hands = [];
    if (entry.event === 'gameStart' && d.shoulder) hands.push({ where: 'gameStart.shoulder', ...d.shoulder });
    if (d.snapshot && d.snapshot.viewer && d.snapshot.viewer.shoulder) hands.push({ where: `${entry.event}.snapshot.viewer.shoulder`, ...d.snapshot.viewer.shoulder });
    const entries = [];
    if (entry.event === 'spectatorsUpdated') entries.push(...(d.spectators || []).filter((e) => 'shoulder' in e));
    if (d.snapshot && d.snapshot.watching) entries.push(...d.snapshot.watching.spectators.filter((e) => 'shoulder' in e));
    const watched = entry.event === 'assistHint' && 'watched' in d ? d.watched : null;
    const reply = entry.event === 'stateSnapshot' && d.reason === 'watchHand';
    return { any: hands.length > 0 || entries.length > 0 || watched !== null || reply, hands, entries, watched, reply };
}

function watchShoulders(getIo, { ownerHsi = 'any' } = {}) {
    const failures = [];
    const counts = { shoulderHands: 0, gameStartShoulders: 0, snapshotShoulders: 0, mirrored: 0, wideEntries: 0, seatStarts: 0, refusals: {} };
    const fail = (why, entry, sid, extra = {}) => {
        if (failures.length < 50) failures.push({ why, event: entry.event, to: entry.to, sid, ...extra });
    };

    const stop = contractCheck.onEmit((entry) => {
        const io = getIo();
        if (!io || !entry || typeof entry.event !== 'string') return;
        const d = entry.data;
        if (entry.event === 'watchHandRefused') counts.refusals[d.reason] = (counts.refusals[d.reason] || 0) + 1;
        const bits = bitsOf(entry);
        if (bits.any && isRoom(entry)) fail('shoulder data in a room emit', entry, null);
        for (const sid of recipientsOf(io, entry)) {
            if (typeof sid !== 'string' || sid.startsWith('bot:')) continue;
            const socket = io.sockets.sockets.get(sid);
            const game = gameOf(entry, sid);
            if (bits.any && !lazy.clientInfo.hasCap(socket, 'shoulderView')) fail('shoulder data to a socket without the cap', entry, sid);

            // ---- watched hands
            for (const h of bits.hands) {
                counts.shoulderHands++;
                if (h.where === 'gameStart.shoulder') counts.gameStartShoulders++;
                else counts.snapshotShoulders++;
                if (!game) { fail('shoulder for no game', entry, sid); continue; }
                if (!isPureSpectator(game, sid)) fail('shoulder to a socket that is not a pure spectator', entry, sid, { where: h.where });
                if (game.shoulders.get(sid) !== h.position) fail('shoulder of a seat the socket does not watch', entry, sid, { where: h.where, position: h.position, watching: game.shoulders.get(sid) ?? null });
                const closed = closedTable(game);
                if (closed) fail(`shoulder from ${closed}`, entry, sid);
                const own = ownSeat(game, sid);
                if (own && own !== h.position) fail('shoulder against the own-seat rule', entry, sid, { own, position: h.position });
                if (!same(cards(h.hand), seatHand(game, h.position))) fail('shoulder hand is not the seat\'s hand', entry, sid, { where: h.where, position: h.position });
                const hsi = game.hsiValues?.[h.position];
                if (h.hsi !== (typeof hsi === 'number' ? hsi : null)) fail('shoulder hsi is not the seat\'s hsi', entry, sid, { where: h.where });
            }

            // ---- seat hands and HSI
            if (game && entry.event === 'gameStart') {
                if (d.position !== undefined) {
                    counts.seatStarts++;
                    if (game.seat(d.position)?.ownerSocketId !== sid) fail('seat gameStart to a socket that does not own the seat', entry, sid, { position: d.position });
                    if (!same(cards(d.hand), seatHand(game, d.position))) fail('seat gameStart hand is not the seat\'s', entry, sid);
                    if (ownerHsi === 'own' && d.hsiValues && !same(Object.keys(d.hsiValues).map(Number), [d.position])) fail('owner gets another seat\'s HSI', entry, sid, { keys: Object.keys(d.hsiValues) });
                } else {
                    if (!Array.isArray(d.hand) || d.hand.length !== 0) fail('spectator gameStart with a hand', entry, sid);
                    if (d.hsiValues) fail('spectator gameStart with hsiValues', entry, sid);
                }
            }
            const snap = d && d.snapshot;
            if (game && snap && snap.viewer) {
                const ownerPos = game.seatByOwnerSocket(sid);
                if (snap.hand) {
                    if (!ownerPos || snap.viewer.position !== ownerPos) fail('snapshot hand to a non-owner', entry, sid);
                    else if (!same(cards(snap.hand), seatHand(game, ownerPos))) fail('snapshot hand is not the owner\'s seat', entry, sid);
                }
                if (snap.hsi) {
                    if (!ownerPos) fail('snapshot hsi to a non-owner', entry, sid);
                    else if (ownerHsi === 'own' && snap.hsi.some((v, i) => v !== null && i + 1 !== ownerPos)) fail('owner snapshot carries another seat\'s HSI', entry, sid);
                }
            }

            // ---- assistHint
            if (game && entry.event === 'assistHint') {
                if (bits.watched !== null) {
                    counts.mirrored++;
                    if (!isPureSpectator(game, sid) || game.shoulders.get(sid) !== bits.watched) fail('mirrored hint to a socket not watching that seat', entry, sid, { watched: bits.watched });
                    if ('note' in d || 'actions' in d) fail('mirrored hint carries the asker\'s note / actions', entry, sid);
                    const closed = closedTable(game);
                    if (closed) fail(`mirrored hint from ${closed}`, entry, sid);
                    if (d.kind === 'status') fail('mirrored status hint', entry, sid);
                } else if (d.kind !== 'status' && !game.seatByOwnerSocket(sid)) {
                    fail('a non-status hint to a socket that owns no seat', entry, sid);
                }
            }

            // ---- who watches which hand
            if (game) {
                const now = game.shoulderByUsername();
                for (const e of bits.entries) {
                    counts.wideEntries++;
                    if (now.get(e.username) !== e.shoulder) fail('spectator entry shoulder is not who watches which hand', entry, sid, { username: e.username, shoulder: e.shoulder });
                }
                // a capable socket's snapshot carries the whole picture
                if (snap && snap.watching && lazy.clientInfo.hasCap(socket, 'shoulderView')) {
                    for (const e of snap.watching.spectators) {
                        if (now.has(e.username) && e.shoulder !== now.get(e.username)) {
                            counts.wideMissed = (counts.wideMissed || 0) + 1;
                            fail('a capable socket\'s snapshot lacks who watches which hand', entry, sid, { username: e.username });
                        }
                    }
                }
            }
        }
    });
    return { failures, counts, stop };
}

/** Every game.shoulders entry is a pure spectator of its game whose socket has the cap. */
function shouldersInvariant(io, game) {
    const out = [];
    if (!game || !game.shoulders) return out;
    for (const [sid, pos] of game.shoulders) {
        if (!isPureSpectator(game, sid)) out.push({ why: 'stale shoulder (not a pure spectator)', sid, pos });
        else if (!lazy.clientInfo.hasCap(io.sockets.sockets.get(sid), 'shoulderView')) out.push({ why: 'stale shoulder (no cap)', sid, pos });
    }
    return out;
}

module.exports = { watchShoulders, shouldersInvariant };
