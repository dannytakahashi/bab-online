#!/usr/bin/env node
// A scripted client for the deploy-survival live harness (scripts/persist-live-harness.sh):
// one player at a table of 3 bots, or one spectator of that table, over socket.io-client,
// reconnecting like the web client (restoreSession on every new socket, then rejoinGame or
// joinAsSpectator) and checking every restore against what it saw before it.
//
//   node scripts/persist-live-probe.js --url http://127.0.0.1:<proxy port> --role player|spectator
//       [--expect survive|end] [--ctl <dir>] [--game <gameId>] [--transports websocket|polling]
//       [--until gameEnd|restores=<n>] [--max-seconds <s>] [--think <ms>] [--chat]
//       [--signal-after-cards <n>]
//
// player     signs up a throwaway account (random name and password, kept in memory only),
//            makes a lobby, adds 3 bots, readies, draws, then bids (rules.safeBid) and plays
//            (rules.firstLegalCard) whenever the snapshot says it can act. Writes the game id
//            to <ctl>/probe-game for a spectator.
// spectator  signs up, waits for <ctl>/probe-game (or --game), watches that table.
//
// Its model of the table: its hand (gameStart, its own cardPlayed), the trick on the table
// (cardPlayed, trickComplete), the score (handComplete) and the seq of every room event;
// every snapshot it gets (rejoinSuccess, spectatorJoined, stateSnapshot) resets it. On a
// restore after a serverShutdown, the restore's snapshot must equal the model:
//   - the same hand (as a multiset; a seat), the same trick and the same score;
//   - a seq above every seq seen before the restart (the restore adds 1000), and the room
//     events after it continue from it;
//   - --expect survive (LIVE_PERSIST=on): no rejoinFailed, no 'not_in_game', no restore
//     without the game, the notice "The server is updating. This game will continue in a few
//     seconds." (or the UNKNOWN / crash variants) before it and "This game resumed after a
//     server update." in its log;
//   - --expect end (today's behaviour, off / write): the notice "This game was interrupted by
//     a server update. It won't count toward stats." before serverShutdown, then the restore
//     finds the game gone (no activeGameId, rejoinFailed / "Game not found").
// --chat: the player says "probe line <n>" after every 3rd card it plays; a restore reports how
// many of the lines echoed before the restart its log is missing (chatLost).
//
// Output: '[probe]' lines (events, checks; never a card, a hand or a password: counts only),
// <ctl>/probe-<role>.status (JSON, rewritten as it goes: phase, gameId, cardsSeen, restores,
// failures) and the final <ctl>/probe-<role>.result.json; the last stdout line is
// RESULT <json>. Exit 0: every check passed; 1: a check failed; 3: --max-seconds ran out.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { io } = require(require.resolve('socket.io-client', { paths: [ROOT] }));
const rules = require(path.join(ROOT, 'server/game/rules'));

// ---------- arguments ----------
function arg(name, def = null) {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = process.argv[i + 1];
    return v === undefined || v.startsWith('--') ? true : v;
}
const die = (msg) => {
    console.error(`persist-live-probe: ${msg}`);
    process.exit(2);
};
const URL_ARG = arg('url');
if (!URL_ARG || typeof URL_ARG !== 'string') die('--url http://127.0.0.1:<port> is required');
let parsed;
try {
    parsed = new URL(URL_ARG);
} catch {
    die('--url is not a URL');
}
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) die('--url must be a local address (127.0.0.1, localhost, [::1])');
if (Number(parsed.port) === 3000 || (!parsed.port && parsed.protocol === 'http:')) die('--url port 3000 (or no port) is the real server\'s: use the harness proxy port');
const ROLE = arg('role', 'player');
if (!['player', 'spectator'].includes(ROLE)) die('--role must be player or spectator');
const EXPECT = arg('expect', 'survive');
if (!['survive', 'end'].includes(EXPECT)) die('--expect must be survive or end');
const CTL = typeof arg('ctl') === 'string' ? arg('ctl') : null;
const UNTIL = String(arg('until', 'gameEnd'));
const UNTIL_RESTORES = /^restores=(\d+)$/.test(UNTIL) ? Number(UNTIL.split('=')[1]) : null;
const MAX_SECONDS = Number(arg('max-seconds', 1800));
const THINK_MS = Number(arg('think', 400));
const CHAT = arg('chat') === true;
const SIGNAL_AFTER = arg('signal-after-cards') ? Number(arg('signal-after-cards')) : null;
const TRANSPORTS = arg('transports') === 'polling' ? ['polling', 'websocket'] : ['websocket'];

// The game-log lines a restart may bring (shutdown.js, the plan's owner answers)
const TEXT = {
    ended: "This game was interrupted by a server update. It won't count toward stats.",
    endedCrash: "This game was interrupted by a server restart. It won't count toward stats.",
    cont: 'The server is updating. This game will continue in a few seconds.',
    unknown: "This game was interrupted by a server update. If it isn't back in a few seconds, it won't count toward stats.",
    unknownCrash: "This game was interrupted by a server restart. If it isn't back in a moment, it won't count toward stats.",
    crashReleased: 'The server hit an error and is restarting. This game should continue in a moment, possibly a move earlier.',
    resumed: 'This game resumed after a server update.',
};
const SURVIVE_NOTICES = new Set([TEXT.cont, TEXT.unknown, TEXT.unknownCrash, TEXT.crashReleased]);
const END_NOTICES = new Set([TEXT.ended, TEXT.endedCrash]);

// ---------- output ----------
const t0 = Date.now();
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log('[probe]', ts(), ROLE, ...a);
const failures = [];
const fail = (what) => {
    failures.push(what);
    log(`FAIL ${what}`);
    writeStatus();
};
function ctlWrite(name, text) {
    if (!CTL) return;
    try {
        fs.writeFileSync(path.join(CTL, name), text);
    } catch (err) {
        log(`cannot write ${name}: ${err.code || err.message}`);
    }
}

// ---------- state ----------
const st = {
    phase: 'connecting',
    username: `probe${crypto.randomInt(100000, 999999)}`,
    token: null,
    gameId: typeof arg('game') === 'string' ? arg('game') : null,
    position: null,
    hand: null, // [{suit, rank}] (a seat)
    trick: [], // [{position, card}]
    score: null, // {team1, team2}
    lastSeq: null,
    maxSeqBeforeRestart: null,
    restartPending: false, // serverShutdown seen, no restore landed yet
    sockets: 0,
    restores: 0,
    cardsSeen: 0,
    myCards: 0,
    gaps: 0,
    notices: [], // system lines about a restart, in order
    chatSent: [],
    chatEchoed: [],
    chatLost: [],
    acting: false,
    atTable: false, // this socket is at the table (seated, watching or drawing)
    ended: false, // the game ended (gameEnd) or was lost (end mode)
    endOutcome: null,
};
const password = crypto.randomBytes(18).toString('base64url');

function writeStatus() {
    ctlWrite(`probe-${ROLE}.status`, `${JSON.stringify(summary())}\n`);
}
function summary() {
    return {
        role: ROLE, expect: EXPECT, phase: st.phase, gameId: st.gameId, position: st.position,
        sockets: st.sockets, restores: st.restores, cardsSeen: st.cardsSeen, myCards: st.myCards,
        gaps: st.gaps, notices: st.notices, chatLost: st.chatLost.length, endOutcome: st.endOutcome,
        failures, seconds: Math.round((Date.now() - t0) / 1000),
    };
}

// ---------- the socket ----------
const socket = io(URL_ARG, { transports: TRANSPORTS, reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 3000 });

// Every room event's seq, before its own handler runs (socket.io-client calls onAny first);
// a snapshot carrier sets its own baseline instead
const CARRIERS = new Set(['rejoinSuccess', 'spectatorJoined', 'stateSnapshot', 'actionRejected', 'restorePlayerState']);
socket.onAny((event, d) => {
    if (!CARRIERS.has(event)) seqOf(event, d);
});

// requestSnapshot is rate-limited (10 per 10 s per socket): at most one per SNAPSHOT_GAP_MS,
// requests in between coalesce into one sent when the interval is up
const SNAPSHOT_GAP_MS = 1100;
let requestNo = 0;
let lastRequestAt = 0;
let deferredRequest = null;
function requestSnapshot(why) {
    // as the web's emit gate: nothing for the table before this socket is seated again (a
    // requestSnapshot ahead of the rejoin is answered not_in_game, truthfully)
    if (!st.atTable) return;
    const wait = lastRequestAt + SNAPSHOT_GAP_MS - Date.now();
    if (wait > 0) {
        if (!deferredRequest) deferredRequest = setTimeout(() => { deferredRequest = null; requestSnapshot(why); }, wait);
        return;
    }
    lastRequestAt = Date.now();
    socket.emit('requestSnapshot', { requestId: `${why}-${++requestNo}`, log: true });
}

socket.on('connect', () => {
    st.sockets++;
    log(`connected (socket ${st.sockets}, ${socket.io.engine.transport.name})`);
    if (!st.token) {
        socket.emit('signUp', { username: st.username, password });
        return;
    }
    socket.emit('restoreSession', { username: st.username, sessionToken: st.token });
});
socket.on('disconnect', (reason) => {
    log(`disconnected: ${reason}`);
    if (reason === 'io server disconnect') fail('the server disconnected the socket (io server disconnect: web treats it as terminal)');
    // a kill (no serverShutdown) or an engine close: what follows is checked like a restart
    st.atTable = false;
    if (!finished && reason !== 'io client disconnect') beginRestart('drop');
});
socket.on('connect_error', (err) => log(`connect error: ${err.message}`));

socket.on('signUpResponse', (d) => {
    if (!d || !d.success) {
        fail(`signUp refused: ${d && d.message}`);
        finish();
        return;
    }
    st.token = d.sessionToken;
    log(`signed up as ${st.username}`);
    socket.emit('joinMainRoom');
});

socket.on('restoreSessionResponse', (d) => {
    if (!d || !d.success) {
        fail(`restoreSession refused${d && d.retryable ? ' (retryable)' : ''}`);
        if (d && d.retryable) setTimeout(() => socket.emit('restoreSession', { username: st.username, sessionToken: st.token }), 1000);
        return;
    }
    const active = d.activeGameId || null;
    log(`session restored${active ? ' with its game' : ' (no active game)'}`);
    if (ROLE === 'player' && st.gameId && !st.ended) {
        if (!active || active !== st.gameId) {
            if (EXPECT === 'survive') fail('restoreSession came back without the game (pointer lost)');
        }
        // as the web does: rejoin the game it was at (its saved gameId when the server has none)
        socket.emit('rejoinGame', { gameId: active || st.gameId, username: st.username, sessionToken: st.token });
        return;
    }
    if (ROLE === 'spectator' && st.gameId && !st.ended) {
        socket.emit('joinAsSpectator', { gameId: st.gameId });
        return;
    }
    socket.emit('joinMainRoom');
});

socket.on('mainRoomJoined', () => {
    if (st.phase === 'connecting') {
        st.phase = 'mainRoom';
        if (ROLE === 'player') startLobby();
        else waitForGameThenWatch();
    }
    if (st.endOutcome && !st.ended) endedNow();
});

// ---------- player: lobby, draw ----------
function startLobby() {
    st.phase = 'lobby';
    socket.emit('createLobby', {});
}
socket.on('lobbyCreated', () => {
    if (ROLE !== 'player' || st.phase !== 'lobby') return;
    log('lobby made; adding 3 bots');
    let n = 0;
    const add = () => {
        if (n++ < 3) {
            socket.emit('addBot', {});
            setTimeout(add, 400);
        } else {
            socket.emit('playerReady');
        }
    };
    add();
});
socket.on('allPlayersReady', (d) => {
    st.atTable = true;
    st.gameId = d.gameId;
    st.phase = 'draw';
    log('table ready');
    ctlWrite('probe-game', `${st.gameId}\n`);
    writeStatus();
});
let drawTries = 0;
const tryDraw = () => {
    if (st.phase !== 'draw' || drawTries > 6) return;
    drawTries++;
    socket.emit('draw', { num: crypto.randomInt(0, 54) });
    setTimeout(() => { if (st.phase === 'draw' && !st.drew) tryDraw(); }, 2000);
};
socket.on('startDraw', () => { if (ROLE === 'player') setTimeout(tryDraw, 600); });
socket.on('youDrew', () => { st.drew = true; });

// ---------- spectator ----------
function waitForGameThenWatch() {
    st.phase = 'waitingForGame';
    const look = () => {
        if (!st.gameId && CTL) {
            try {
                st.gameId = fs.readFileSync(path.join(CTL, 'probe-game'), 'utf8').trim() || null;
            } catch { /* not yet */ }
        }
        if (!st.gameId) {
            setTimeout(look, 500);
            return;
        }
        // watch once the table is dealt (a spectator of the draw gets the draw view)
        socket.emit('joinAsSpectator', { gameId: st.gameId });
    };
    look();
}
socket.on('spectatorJoined', (d) => {
    if (!d || !d.snapshot) return; // the notice of another spectator
    applySnapshot(d.snapshot, 'spectatorJoined');
    if (st.phase !== 'playing') st.phase = 'watching';
});
socket.on('serverError', (d) => {
    const msg = d && d.message;
    log(`serverError: ${msg}`);
    if (ROLE === 'spectator' && /Game not found/.test(String(msg))) {
        if (st.restartPending && EXPECT === 'end') {
            st.endOutcome = 'spectate refused: game gone';
            endedNow();
        } else if (st.gameId && st.lastSeq === null) {
            setTimeout(() => socket.emit('joinAsSpectator', { gameId: st.gameId }), 1000); // not dealt yet
        } else {
            fail(`re-spectate refused: ${msg}`);
        }
    }
});

// ---------- the table ----------
socket.on('gameStart', (d) => {
    if (!d) return;
    st.phase = 'playing';
    if (Array.isArray(d.hand)) {
        st.hand = d.hand.map((c) => ({ suit: c.suit, rank: c.rank }));
        st.position = d.position || st.position;
    }
    st.trick = [];
    if (typeof d.score1 === 'number') st.score = { team1: d.score1, team2: d.score2 };
    setTimeout(() => requestSnapshot('deal'), 300);
});
socket.on('cardPlayed', (d) => {
    st.cardsSeen++;
    st.trick.push({ position: d.position, card: { suit: d.card.suit, rank: d.card.rank } });
    if (d.position === st.position && st.hand) {
        const i = st.hand.findIndex((c) => c.suit === d.card.suit && c.rank === d.card.rank);
        if (i >= 0) st.hand.splice(i, 1);
        else fail('my own card was played but was not in my hand (model)');
    }
    if (SIGNAL_AFTER !== null && st.cardsSeen === SIGNAL_AFTER) ctlWrite(`probe-${ROLE}.cards`, `${st.cardsSeen}\n`);
    if (st.cardsSeen % 4 === 0) writeStatus();
});
socket.on('trickComplete', (d) => {
    st.trick = [];
});
socket.on('handComplete', (d) => {
    if (d && d.score) st.score = { team1: d.score.team1, team2: d.score.team2 };
    st.trick = [];
});
socket.on('updateTurn', (d) => {
    if (ROLE === 'player' && d && d.currentTurn === st.position) setTimeout(() => requestSnapshot('turn'), 150);
});
socket.on('gameLogEntry', (d) => {
    const m = d && d.message;
    if (typeof m !== 'string') return;
    if (SURVIVE_NOTICES.has(m) || END_NOTICES.has(m)) {
        st.notices.push(m);
        log(`notice: "${m}"`);
        if (END_NOTICES.has(m) && EXPECT === 'survive') fail(`told the game ended: "${m}"`);
        if (SURVIVE_NOTICES.has(m) && EXPECT === 'end') fail(`told the game continues: "${m}"`);
    }
});
socket.on('chatMessage', (d) => {
    const m = d && d.message;
    if (typeof m === 'string' && st.chatSent.includes(m)) st.chatEchoed.push(m);
});
socket.on('gameEnd', (d) => {
    if (d && d.score) st.score = d.score;
    st.ended = true;
    st.endOutcome = st.endOutcome || 'gameEnd';
    log('gameEnd');
    finish();
});
socket.on('abortGame', () => {
    st.ended = true;
    st.endOutcome = 'abortGame';
    if (EXPECT === 'survive') fail('the game was aborted');
    finish();
});

socket.on('serverShutdown', () => {
    log(`serverShutdown (lastSeq ${st.lastSeq}${st.hand ? `, ${st.hand.length} cards in hand` : ''}, ${st.trick.length} on the table)`);
    if (st.gameId && !st.ended && EXPECT === 'end' && !st.notices.some((n) => END_NOTICES.has(n))) {
        fail('serverShutdown came before the "interrupted" line (shutdown.js sends the notice first)');
    }
    beginRestart('shutdown');
});

/**
 * A restart begins (serverShutdown, or the socket dropped with none: a kill, an engine
 * close). The model as it stands is what the restore must bring back. The game-log line
 * that tells the outcome comes after serverShutdown (the flush), so it is read at the restore.
 */
function beginRestart(kind) {
    if (!st.gameId || st.ended) return;
    if (!st.restartPending) {
        st.restartPending = true;
        st.restartKind = kind;
        st.noticesAtRestart = st.notices.length;
        st.maxSeqBeforeRestart = st.lastSeq;
        st.chatAtRestart = [...st.chatEchoed];
        st.lastMyCard = st.lastPlayed || null;
    } else if (kind === 'shutdown') {
        st.restartKind = 'shutdown';
    }
    writeStatus();
}

socket.on('rejoinSuccess', (d) => {
    if (!d || !d.snapshot) {
        fail('rejoinSuccess without a snapshot');
        return;
    }
    if (EXPECT === 'end' && st.restartPending) fail('the game came back (expected it to end)');
    applySnapshot(d.snapshot, 'rejoinSuccess');
});
socket.on('rejoinFailed', (d) => {
    const reason = d && d.reason;
    log(`rejoinFailed: ${reason}`);
    if (reason === 'Already connected') return;
    if (EXPECT === 'survive') {
        fail(`rejoinFailed: ${reason}`);
        return;
    }
    st.endOutcome = `rejoinFailed: ${reason}`;
    endedNow();
});
socket.on('stateSnapshot', (d) => {
    if (!d) return;
    if (!d.snapshot) {
        if (d.reason === 'not_in_game' && st.gameId && !st.ended && EXPECT === 'survive') fail('stateSnapshot not_in_game');
        return;
    }
    applySnapshot(d.snapshot, `stateSnapshot ${d.requestId || ''}`.trim());
});
socket.on('actionRejected', (d) => {
    log(`actionRejected ${d && d.action}: ${d && d.reason}`);
    st.acting = false;
    if (d && d.snapshot) applySnapshot(d.snapshot, 'actionRejected');
});

/** The seq of a room event: next, stale or a gap (a gap asks for a snapshot, as the web does). */
function seqOf(event, d) {
    if (!d || !Number.isInteger(d.seq)) return;
    if (st.lastSeq === null || d.seq === st.lastSeq + 1) {
        st.lastSeq = d.seq;
        return;
    }
    if (d.seq <= st.lastSeq) {
        log(`stale ${event} seq ${d.seq} <= ${st.lastSeq}`);
        return;
    }
    st.gaps++;
    log(`seq gap at ${event}: ${st.lastSeq} -> ${d.seq}; asking for a snapshot`);
    st.lastSeq = d.seq;
    requestSnapshot('gap');
}

const sameCards = (a, b) => {
    const key = (c) => `${c.suit}:${c.rank}`;
    const x = (a || []).map(key).sort();
    const y = (b || []).map(key).sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
};
const sameTrick = (model, snap) => {
    const s = (snap.trick && snap.trick.cards) || [];
    return model.length === s.length && model.every((m, i) => m.position === s[i].position && m.card.suit === s[i].card.suit && m.card.rank === s[i].card.rank);
};

function applySnapshot(snap, source) {
    st.atTable = true;
    const restore = st.restartPending && (source === 'rejoinSuccess' || source === 'spectatorJoined');
    if (restore) checkRestore(snap, source);
    else if (st.lastSeq !== null && snap.seq < st.lastSeq && snap.gameId === st.gameId) {
        fail(`${source}: snapshot seq ${snap.seq} below the seq already seen (${st.lastSeq})`);
    }
    st.gameId = snap.gameId || st.gameId;
    st.lastSeq = snap.seq;
    st.position = snap.viewer && snap.viewer.position ? snap.viewer.position : st.position;
    st.hand = Array.isArray(snap.hand) ? snap.hand.map((c) => ({ suit: c.suit, rank: c.rank })) : st.hand;
    st.trick = ((snap.trick && snap.trick.cards) || []).map((c) => ({ position: c.position, card: { suit: c.card.suit, rank: c.card.rank } }));
    st.score = snap.score ? { team1: snap.score.team1, team2: snap.score.team2 } : st.score;
    if (['BIDDING', 'PLAYING', 'TRICK_RESOLVING', 'HAND_RESOLVING'].includes(snap.stage)) st.phase = ROLE === 'player' ? 'playing' : 'watching';
    if (ROLE === 'player') maybeAct(snap);
}

function checkRestore(snap, source) {
    st.restartPending = false;
    const jump = st.maxSeqBeforeRestart === null ? null : snap.seq - st.maxSeqBeforeRestart;
    // hydrate restarts eventSeq at the saved seq + 1000: a smaller jump is a reconnect to the
    // instance that still holds the game (a network drop, an engine close without a restart)
    const restored = jump === null || jump > 500;
    if (restored) st.restores++;
    const label = restored ? `restore ${st.restores} (${source}, after ${st.restartKind})` : `reconnect (${source}, same instance)`;
    const notices = st.notices.slice(st.noticesAtRestart || 0);
    // A restore is compared with the model: a handoff flush saves the last state exactly; a
    // crash, a kill or an UNKNOWN outcome may come back up to one action earlier ("possibly a
    // move earlier"). A reconnect to the instance still running the game is not: the table
    // played on while this socket was away, so only the seq and the role are checked
    const exact = restored && st.restartKind === 'shutdown' && notices.includes(TEXT.cont);
    const problems = [];
    const behind = [];
    if (jump !== null && !(jump > 0)) problems.push(`seq ${snap.seq} not above ${st.maxSeqBeforeRestart}`);
    if (ROLE === 'player') {
        if (!snap.viewer || !['seat', 'lazyWatcher'].includes(snap.viewer.role)) problems.push(`viewer role ${snap.viewer && snap.viewer.role}`);
    } else if (!snap.viewer || snap.viewer.role !== 'spectator') {
        problems.push(`viewer role ${snap.viewer && snap.viewer.role}`);
    }
    if (restored) {
        if (ROLE === 'player' && st.hand && !sameCards(st.hand, snap.hand)) {
            const allowed = st.lastMyCard ? [...st.hand, st.lastMyCard] : st.hand;
            const extra = (snap.hand || []).filter((c) => !allowed.some((a) => a.suit === c.suit && a.rank === c.rank));
            const diff = `hand differs (${st.hand.length} cards before, ${(snap.hand || []).length} after)`;
            if (exact || extra.length || (snap.hand || []).length < st.hand.length) problems.push(diff);
            else behind.push(diff);
        }
        if (!sameTrick(st.trick, snap)) (exact ? problems : behind).push(`trick differs (${st.trick.length} cards before, ${((snap.trick && snap.trick.cards) || []).length} after)`);
        if (st.score && snap.score && (st.score.team1 !== snap.score.team1 || st.score.team2 !== snap.score.team2)) (exact ? problems : behind).push('score differs');
    }
    const logText = (snap.log || []).map((e) => e.message);
    if (restored) {
        const resumed = logText.filter((m) => m === TEXT.resumed).length;
        if (resumed < st.restores) problems.push(`${resumed} "resumed" lines in the log after ${st.restores} restores`);
        if (st.restartKind === 'shutdown' && !notices.some((n) => SURVIVE_NOTICES.has(n))) problems.push('no "continue" / "interrupted ... if it isn\'t back" line before the restart');
    }
    st.chatLost = (st.chatAtRestart || []).filter((m) => !logText.some((l) => typeof l === 'string' && l.includes(m)));
    if (problems.length) fail(`${label}: ${problems.join('; ')}`);
    else log(`${label}: ${!restored ? 'seated again' : behind.length ? `behind by up to one action (${behind.join('; ')})` : 'same hand, trick and score'}; seq ${st.maxSeqBeforeRestart} -> ${snap.seq}; chat lines lost ${st.chatLost.length}`);
    if (restored && st.chatLost.length > (exact ? 0 : 1)) fail(`${label}: ${st.chatLost.length} chat lines lost`);
    writeStatus();
    if (UNTIL_RESTORES !== null && st.restores >= UNTIL_RESTORES) setTimeout(finish, 3000);
}

// ---------- acting ----------
function maybeAct(snap) {
    if (!snap.viewer || !snap.viewer.canAct || st.acting) return;
    const pos = snap.viewer.position;
    st.acting = true;
    setTimeout(() => {
        st.acting = false;
        if (snap.turn && snap.turn.action === 'bid') {
            const bid = rules.safeBid(snap.bids.byPosition.map((b) => (b == null ? null : b)));
            socket.emit('playerBid', { bid, position: pos });
        } else if (snap.turn && snap.turn.action === 'play') {
            const cards = snap.trick.cards || [];
            const lead = cards[0] ? cards[0].card : null;
            const card = rules.firstLegalCard(snap.hand || [], {
                leadCard: lead, isLeading: cards.length === 0, trump: snap.trump, trumpBroken: snap.trumpBroken,
                position: pos, leadPosition: snap.trick.leadPosition,
            });
            if (!card) {
                fail('no legal card in a hand the snapshot says can act');
                return;
            }
            st.myCards++;
            st.lastPlayed = { suit: card.suit, rank: card.rank };
            socket.emit('playCard', { card: { suit: card.suit, rank: card.rank }, position: pos });
            if (CHAT && st.myCards % 3 === 0) {
                const line = `probe line ${st.myCards / 3}`;
                st.chatSent.push(line);
                socket.emit('chatMessage', { message: line });
            }
        }
    }, THINK_MS);
}
// A snapshot now and then: a turn whose updateTurn was missed (a bid) is still taken
setInterval(() => {
    if (ROLE === 'player' && st.phase === 'playing' && !st.ended && socket.connected && !st.restartPending) requestSnapshot('poll');
}, 3000).unref();

// ---------- the end ----------
function endedNow() {
    st.ended = true;
    // (a kill tells nobody anything: only a shutdown sends the line)
    if (EXPECT === 'end' && st.restartKind === 'shutdown' && !st.notices.some((n) => END_NOTICES.has(n))) fail('the game ended without the "interrupted" line');
    log(`the game is gone (${st.endOutcome}), as expected`);
    finish();
}

let finished = false;
function finish(code = null) {
    if (finished) return;
    finished = true;
    st.phase = 'done';
    if (EXPECT === 'survive' && st.endOutcome === 'gameEnd' && st.restores === 0 && UNTIL_RESTORES !== null) fail('the game ended before any restore');
    if (EXPECT === 'end' && st.gameId && !st.endOutcome) fail('no end outcome');
    const result = { ...summary(), pass: failures.length === 0 && code === null };
    ctlWrite(`probe-${ROLE}.result.json`, `${JSON.stringify(result, null, 2)}\n`);
    writeStatus();
    console.log(`RESULT ${JSON.stringify(result)}`);
    setTimeout(() => process.exit(code ?? (failures.length ? 1 : 0)), 200);
    socket.close();
}

setTimeout(() => {
    fail(`timed out after ${MAX_SECONDS} s (phase ${st.phase})`);
    finish(3);
}, MAX_SECONDS * 1000).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { fail(`stopped by ${sig}`); finish(1); });
writeStatus();
