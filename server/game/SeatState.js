/**
 * Seat state machine: who controls a seat and whether its owner is present.
 *
 * Every seated position has ONE record on GameState (`game.seats[pos]`):
 *
 *   controller  human | lazyBot | resignBot | bot
 *   presence    connected | grace | resignable | away | gone | none
 *
 * A human seat is played by its owner; a lazyBot / resignBot seat is played
 * by a bot on behalf of an owner who may be watching (connected), away, or
 * gone for good; a native 'bot' seat (lobby, tournament filler, ambient) has
 * no owner at all. A bot-controlled seat's SEAT socket (positions / players /
 * hands key) is the bot's 'bot:' socket; the owner's own socket is separate
 * (`ownerSocketId`).
 *
 * The record only changes through the GameState transition methods, each of
 * which checks its edge against EDGES below (an illegal edge is a reported
 * 'seat-illegal' violation: it throws under Jest / BAB_FSM_STRICT=1, logs and
 * fails closed in production). validateSeats() holds the cross-field
 * invariants, run from validateGameState and, under BAB_FSM_CHECK=1, after
 * every seat transition.
 *
 * Pure: no io, no handlers.
 */

const { Phase, PRE_SEATING } = require('./GamePhase');

// Timings (re-exported by socket/seatLifecycle.js)
const RECONNECT_GRACE_MS = 60000;   // per seat: disconnect -> resign offer
const ABANDON_MS = 60000;           // nobody connected -> abort
const DRAW_WATCHDOG_MS = 30000;     // DRAWING entry -> auto-draw stragglers
// AFK_MS is reserved for a future turn watchdog ('afk:<pos>' timer key)

const Controller = Object.freeze({
    HUMAN: 'human',
    LAZY_BOT: 'lazyBot',
    RESIGN_BOT: 'resignBot',
    BOT: 'bot'
});

const Presence = Object.freeze({
    CONNECTED: 'connected',   // the owner has one live socket attached
    GRACE: 'grace',           // human seat, owner dropped, reconnect window open
    RESIGNABLE: 'resignable', // human seat, grace over, others may forceResign
    AWAY: 'away',             // bot-controlled seat, owner not connected (may return)
    GONE: 'gone',             // bot-controlled seat, owner left for good (absorbing)
    NONE: 'none'              // native bot seat: no owner
});

const LEGAL = Object.freeze({
    human: Object.freeze(['connected', 'grace', 'resignable']),
    lazyBot: Object.freeze(['connected', 'away', 'gone']),
    resignBot: Object.freeze(['connected', 'away', 'gone']),
    bot: Object.freeze(['none'])
});

// Initial (controller/presence) a seat may be created in
const CREATE_LEGAL = Object.freeze(['human/connected', 'human/grace', 'bot/none', 'resignBot/gone']);

// event -> controller -> from presence -> to ('presence' keeps the
// controller, 'controller/presence' changes it). Anything missing is illegal.
const EDGES = Object.freeze({
    disconnect: {
        human: { connected: 'grace' },
        lazyBot: { connected: 'away' },
        resignBot: { connected: 'away' }
    },
    graceExpired: {
        human: { grace: 'resignable' }
    },
    reconnect: {
        // connected: only from a different socket (newest socket owns the seat)
        human: { grace: 'connected', resignable: 'connected', connected: 'connected' }
    },
    watch: {
        lazyBot: { connected: 'connected', away: 'connected' },
        resignBot: { connected: 'connected', away: 'connected' }
    },
    goLazy: {
        human: { connected: 'lazyBot/connected' }
    },
    goActive: {
        lazyBot: { connected: 'human/connected' },
        resignBot: { connected: 'human/connected' }
    },
    resign: {
        human: { resignable: 'resignBot/away' }
    },
    leave: {
        lazyBot: { connected: 'gone', away: 'gone' },
        resignBot: { connected: 'gone', away: 'gone' }
    }
});

const isBotSocket = (sid) => typeof sid === 'string' && sid.startsWith('bot:');

/**
 * @param {Object|null} seat
 * @param {string} event - a key of EDGES
 * @returns {{ok: true, to: {controller, presence}} | {ok: false}}
 */
function checkEdge(seat, event) {
    if (!seat) return { ok: false };
    const target = EDGES[event]?.[seat.controller]?.[seat.presence];
    if (!target) return { ok: false };
    const [a, b] = target.split('/');
    return { ok: true, to: b ? { controller: a, presence: b } : { controller: seat.controller, presence: a } };
}

function isLegalCreate(controller, presence) {
    return CREATE_LEGAL.includes(`${controller}/${presence}`);
}

/** What clients see for the seat: the owner for a human seat, else the bot. */
function seatDisplay(seat) {
    if (seat.controller === Controller.HUMAN) return { username: seat.ownerUsername, pic: seat.ownerPic };
    return { username: seat.bot?.username ?? null, pic: seat.bot?.pic ?? null };
}

/**
 * Seat invariants. Each string is one broken invariant.
 * @param {GameState} game
 * @returns {string[]}
 */
function validateSeats(game) {
    const errors = [];
    if (!game.seats) return errors;
    const terminal = game.isTerminal();
    const seats = [];
    for (let pos = 1; pos <= 4; pos++) {
        if (game.seats[pos]) seats.push(game.seats[pos]);
    }
    const timerKeys = typeof game.timerKeys === 'function' ? game.timerKeys() : [];
    const hasTimer = (k) => game.hasTimer(k);

    for (const s of seats) {
        const pos = s.position;
        const tag = `Seat ${pos} (${s.controller}/${s.presence})`;
        // 1
        if (!LEGAL[s.controller] || !LEGAL[s.controller].includes(s.presence)) {
            errors.push(`${tag}: illegal controller/presence`);
            continue;
        }
        // 2
        if ((s.controller === Controller.BOT) !== (s.ownerUsername == null)) {
            errors.push(`${tag}: ownerUsername ${s.ownerUsername} does not match controller`);
        }
        // 3
        if ((s.bot != null) !== (s.controller !== Controller.HUMAN)) {
            errors.push(`${tag}: bot record does not match controller`);
        }
        if (s.bot && (s.seatSocketId !== s.bot.socketId || !isBotSocket(s.seatSocketId))) {
            errors.push(`${tag}: seat socket ${s.seatSocketId} is not its bot's`);
        }
        if (s.controller === Controller.HUMAN && isBotSocket(s.seatSocketId)) {
            errors.push(`${tag}: human seat keyed by a bot socket`);
        }
        // 4
        if (game.positions[pos] !== s.seatSocketId) {
            errors.push(`${tag}: positions[${pos}]=${game.positions[pos]}, seat socket ${s.seatSocketId}`);
        }
        const entry = game.players.get(s.seatSocketId);
        const d = seatDisplay(s);
        if (!entry || entry.position !== pos || entry.username !== d.username || entry.pic !== d.pic) {
            errors.push(`${tag}: players index ${JSON.stringify(entry)} != display ${JSON.stringify({ position: pos, ...d })}`);
        }
        // 5
        if ((s.presence === Presence.CONNECTED) !== (s.ownerSocketId != null)) {
            errors.push(`${tag}: ownerSocketId ${s.ownerSocketId}`);
        }
        if (s.presence === Presence.CONNECTED && s.controller === Controller.HUMAN &&
            (s.ownerSocketId !== s.seatSocketId || s.ownerView != null)) {
            errors.push(`${tag}: connected human owner ${s.ownerSocketId} / view ${s.ownerView} vs seat ${s.seatSocketId}`);
        }
        if (s.presence === Presence.CONNECTED && s.controller !== Controller.HUMAN &&
            (s.ownerSocketId === s.seatSocketId || !['seat', 'watch'].includes(s.ownerView))) {
            errors.push(`${tag}: connected bot-controlled owner ${s.ownerSocketId} / view ${s.ownerView}`);
        }
        if (s.presence !== Presence.CONNECTED && s.ownerView != null) {
            errors.push(`${tag}: ownerView ${s.ownerView} while not connected`);
        }
        // 6
        if (!terminal) {
            const graceTimer = hasTimer('grace:' + pos);
            if ((s.presence === Presence.GRACE) !== (graceTimer && s.graceDeadline != null)) {
                errors.push(`${tag}: grace timer ${graceTimer}, deadline ${s.graceDeadline}`);
            }
            if (s.presence === Presence.RESIGNABLE && (graceTimer || s.resignableAt == null)) {
                errors.push(`${tag}: resignable with grace timer ${graceTimer}, resignableAt ${s.resignableAt}`);
            }
        }
    }

    // 4 (index has nothing extra)
    if (game.players.size !== seats.length) {
        errors.push(`players index has ${game.players.size} entries for ${seats.length} seats`);
    }
    for (const [sid, p] of game.players) {
        const s = game.seats[p.position];
        if (!s || s.seatSocketId !== sid) errors.push(`players entry ${sid} has no seat`);
    }

    // 7
    const owners = new Map();
    for (const s of seats) {
        if (s.ownerSocketId == null) continue;
        if (owners.has(s.ownerSocketId)) errors.push(`socket ${s.ownerSocketId} owns seats ${owners.get(s.ownerSocketId)} and ${s.position}`);
        owners.set(s.ownerSocketId, s.position);
        if (game.spectators?.has(s.ownerSocketId)) errors.push(`owner socket ${s.ownerSocketId} of seat ${s.position} is a spectator`);
    }
    const botSeats = seats.filter(s => s.bot);
    for (let i = 0; i < botSeats.length; i++) {
        for (let j = i + 1; j < botSeats.length; j++) {
            const a = botSeats[i];
            const b = botSeats[j];
            // Native bots are deduped by their own start paths (and test
            // fixtures reuse one personality); a lazy/resign bot must never
            // clash with any bot at the table
            if (a.controller === Controller.BOT && b.controller === Controller.BOT) continue;
            if (a.bot.username === b.bot.username) errors.push(`seats ${a.position} and ${b.position} share bot name ${a.bot.username}`);
            if (a.bot.personality && a.bot.personality === b.bot.personality) {
                errors.push(`seats ${a.position} and ${b.position} share personality ${a.bot.personality}`);
            }
        }
    }

    // 8
    const present = seats.some(s => s.presence === Presence.CONNECTED);
    if (hasTimer('abandon') && present) errors.push('abandon timer armed while a human is present');

    // 9
    if (game.stage !== Phase.DRAWING && hasTimer('draw:watchdog')) errors.push(`draw watchdog armed in ${game.stage}`);

    // 10
    if (!terminal) {
        if (game.entrants != null && (seats.length === 4 || !PRE_SEATING.has(game.stage))) {
            errors.push(`entrants still set with ${seats.length} seats in ${game.stage}`);
        }
        if (game.entrants == null && seats.length < 4 && PRE_SEATING.has(game.stage) && seats.length > 0) {
            errors.push(`${seats.length} seats and no entrants in ${game.stage}`);
        }
    }

    // 11
    for (const k of timerKeys) {
        if (k === 'reconnectGrace' || k.startsWith('lazy:')) errors.push(`legacy timer key ${k}`);
    }
    return errors;
}

module.exports = {
    RECONNECT_GRACE_MS,
    ABANDON_MS,
    DRAW_WATCHDOG_MS,
    Controller,
    Presence,
    LEGAL,
    CREATE_LEGAL,
    EDGES,
    isBotSocket,
    checkEdge,
    isLegalCreate,
    seatDisplay,
    validateSeats
};
