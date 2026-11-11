/**
 * Schema-building helpers and the shared $defs of the socket contract.
 * Everything here is derived from the server code at cc865b4 (see
 * emittedFrom in s2c.js), not from the clients' guesses.
 */

'use strict';

// ---------- helpers ----------

const str = (o = {}) => ({ type: 'string', ...o });
const int = (o = {}) => ({ type: 'integer', ...o });
const num = (o = {}) => ({ type: 'number', ...o });
const bool = (o = {}) => ({ type: 'boolean', ...o });
const nul = () => ({ type: 'null' });
const konst = (v) => ({ const: v });
const enm = (...vals) => ({ enum: vals });
const arr = (items, o = {}) => ({ type: 'array', items, ...o });
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const anyOf = (...variants) => ({ anyOf: variants });
/** A schema or null. */
const orNull = (s) => (s.type && !s.anyOf && !s.$ref && !s.enum && !s.const
    ? { ...s, type: [].concat(s.type, 'null') }
    : anyOf(s, nul()));

/**
 * An object schema. Closed unless `open`. Every property is required
 * except those named in `optional` (or exactly `required` when given).
 */
function obj(props, { required, optional = [], open = false } = {}) {
    const keys = Object.keys(props);
    const req = required || keys.filter((k) => !optional.includes(k));
    const s = { type: 'object', properties: props };
    if (req.length) s.required = req;
    s.additionalProperties = !!open;
    return s;
}

/** A named anyOf variant (closed object). */
const variant = (name, schema, extra = {}) => ({ variant: name, ...schema, ...extra });

/** Open map keyed by seat position ('1'..'4'). */
const byPosition = (valueSchema) => ({
    type: 'object',
    patternProperties: { '^[1-4]$': valueSchema },
    additionalProperties: false,
});

const nonEmpty = str({ minLength: 1 });

// ---------- shared definitions ----------

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs', 'joker'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', 'HI', 'LO'];
const BID_STRINGS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', 'B', '2B', '3B', '4B'];
const LOG_TYPES = ['system', 'chat', 'bid', 'trick', 'score', 'rainbow'];
const STAGES = ['CREATED', 'DRAWING', 'DRAW_RESOLVING', 'TEAMS_ANNOUNCED', 'DEALING', 'BIDDING', 'REDEAL', 'PLAYING',
    'TRICK_RESOLVING', 'HAND_RESOLVING', 'ENDED', 'ABORTED'];

/** getClientState() at cc865b4: exactly these 22 keys (wireProjection LEGACY_CLIENT_STATE_KEYS). */
const LEGACY_CLIENT_STATE_PROPS = {
    gameId: str(),
    position: orNull(ref('position')),
    hand: arr(ref('card')),
    trump: orNull(ref('card')),
    currentHand: int({ minimum: 1, maximum: 13 }),
    dealer: ref('position'),
    phase: enm('waiting', 'drawing', 'bidding'),
    bidding: bool(),
    currentTurn: ref('position'),
    bids: ref('legacyBids'),
    playerBids: ref('bidArray'),
    tricks: ref('teamPair'),
    score: ref('teamPair'),
    playedCards: ref('playedCards'),
    leadPosition: ref('position'),
    isTrumpBroken: bool(),
    players: arr(ref('playerInfoV1'), { maxItems: 4 }),
    gameLog: arr(ref('gameLogEntry')),
    hsiValues: ref('hsiValues'),
    resignedPositions: arr(ref('position'), { maxItems: 4 }),
    lazyPositions: arr(ref('position'), { maxItems: 4 }),
    isLazy: bool(),
};

/** spectatorJoined full state at cc865b4: exactly these 16 keys, in emit order. */
const SPECTATOR_STATE_V1_PROPS = {
    gameId: str(),
    players: arr(ref('playerInfoV1'), { maxItems: 4 }),
    trump: orNull(ref('card')),
    currentHand: int({ minimum: 1, maximum: 13 }),
    dealer: ref('position'),
    phase: enm('waiting', 'drawing', 'bidding'),
    bidding: bool(),
    currentTurn: ref('position'),
    bids: ref('legacyBids'),
    playerBids: ref('bidArray'),
    tricks: ref('teamPair'),
    score: ref('teamPair'),
    playedCards: ref('playedCards'),
    isTrumpBroken: bool(),
    gameLog: arr(ref('gameLogEntry')),
    spectatorCount: int({ minimum: 0 }),
};

const lobbyMember = obj({
    socketId: str(),
    username: str(),
    ready: bool(),
    isBot: konst(true),
    personality: str(),
}, { optional: ['isBot', 'personality'] });

const chatLine = obj({ username: str(), message: str(), timestamp: int() });

const defs = {
    card: obj({ suit: enm(...SUITS), rank: enm(...RANKS) }),
    // Client-sent card: Joi requires suit/rank and strips the rest
    cardIn: obj({ suit: enm(...SUITS), rank: enm(...RANKS) }, { open: true }),
    position: int({ minimum: 1, maximum: 4 }),
    bidString: enm(...BID_STRINGS),
    // bidReceived.bid echoes what the client sent (V1_REMOVALS #11): iOS sends an
    // Int for numeric bids, web a string; bot bids are strings
    bidWire: anyOf(int({ minimum: 0, maximum: 13 }), ref('bidString')),
    // playerBids after a JSON round-trip: holes are null, trailing holes absent
    bidArray: arr(orNull(ref('bidString')), { maxItems: 4 }),
    playedCards: arr(orNull(ref('card')), { maxItems: 4 }),
    // During bidding {position: bid}; from the end of bidding {team1, team2}
    legacyBids: anyOf(variant('teams', obj({ team1: int(), team2: int() })), variant('byPosition', byPosition(ref('bidString')))),
    hsiValues: byPosition(num()),
    // numeric avatar id, or a data:image URL (custom picture); null for a
    // seat whose picture was never resolved
    pic: { type: ['integer', 'string', 'null'] },
    teamPair: obj({ team1: int(), team2: int() }),
    gameLogEntry: obj({
        message: str(),
        playerPosition: orNull(ref('position')),
        type: enm(...LOG_TYPES),
        timestamp: int(),
    }),
    playerInfoV1: obj({ position: ref('position'), username: str(), pic: ref('pic'), socketId: str() }),
    playerInfoGameStart: obj({ position: ref('position'), username: str(), pic: ref('pic') }),
    lobby: obj({
        id: str(),
        name: str(),
        playerCount: int({ minimum: 0, maximum: 4 }),
        maxPlayers: konst(4),
        players: arr(ref('lobbyPlayer'), { maxItems: 4 }),
        createdAt: int(),
    }),
    lobbyPlayer: obj({ username: str(), ready: bool() }),
    lobbyMember,
    lobbyChatLine: chatLine,
    mainRoomChatLine: chatLine,
    inProgressGame: obj({
        gameId: str(),
        players: arr(obj({ position: ref('position'), username: str() }), { maxItems: 4 }),
        currentHand: int({ minimum: 1, maximum: 13 }),
        score: ref('teamPair'),
        spectatorCount: int({ minimum: 0 }),
    }),
    tournamentSummary: obj({
        id: str(),
        name: str(),
        playerCount: int({ minimum: 0 }),
        phase: str(),
        currentRound: int({ minimum: 0 }),
        totalRounds: int(),
        creatorUsername: orNull(str()),
    }),
    tournamentPlayer: obj({
        socketId: str(),
        username: str(),
        pic: ref('pic'),
        ready: bool(),
        connected: bool(),
        isCreator: bool(),
    }),
    scoreboardRow: obj({ username: str(), totalScore: num(), roundScores: arr(num()), roundDetails: arr(obj({}, { open: true })) }, { open: true }),
    tournamentActiveGame: obj({ gameId: str(), humanPlayers: arr(str()), botCount: int({ minimum: 0 }), status: str() }),
    tournamentChatLine: obj({ username: str(), message: str(), isSpectator: bool(), timestamp: int() }),
    tournamentClientState: obj({
        tournamentId: str(),
        name: str(),
        phase: str(),
        currentRound: int({ minimum: 0 }),
        totalRounds: int(),
        players: arr(ref('tournamentPlayer')),
        messages: arr(ref('tournamentChatLine')),
        scoreboard: arr(ref('scoreboardRow')),
        activeGames: arr(ref('tournamentActiveGame')),
        creatorUsername: orNull(str()),
        creatorSocketId: orNull(str()),
        winners: arr(str()),
    }, { optional: ['winners'] }),
    // DB projections: closed at the top, nested rows open
    profile: obj({
        username: str(),
        profilePic: int(),
        customProfilePic: orNull(str()),
        stats: obj({}, { open: true }),
    }),
    leaderboardRow: obj({ username: str(), gamesPlayed: num(), winRate: num() }, { open: true }),
    // getRecords: per period (allTime / thisYear / thisMonth) null when no
    // game is recorded, else these five, each null until it has data (the
    // bag records skip legacy games without bags). Rows open, core required.
    recordsPeriod: orNull(obj({
        highestScore: orNull(obj({ score: num(), players: arr(str()) }, { open: true })),
        lowestScore: orNull(obj({ score: num(), players: arr(str()) }, { open: true })),
        biggestWin: orNull(obj({
            margin: num(), winnerScore: num(), loserScore: num(), winnerPlayers: arr(str()), loserPlayers: arr(str()),
        }, { open: true })),
        mostBags: orNull(obj({ bags: num(), players: arr(str()) }, { open: true })),
        leastBags: orNull(obj({ bags: num(), players: arr(str()) }, { open: true })),
    }, { open: true })),
    playerSearchRow: obj({ username: str(), profilePic: int(), customProfilePic: orNull(str()), gamesPlayed: int(), wins: int() }),
    voicePeer: obj({ socketId: str(), username: { type: ['string', 'null'] } }),
    legacyClientState: obj(LEGACY_CLIENT_STATE_PROPS),
    spectatorStateV1: obj(SPECTATOR_STATE_V1_PROPS),
    seq: int({ minimum: 1, description: 'Per-game broadcast sequence number (contract/README.md R1-R5)' }),
    // clientHello caps the server acts on (contract/README.md "Client
    // capabilities"); unknown caps are ignored, so the list only grows
    clientCap: enm('avatarUrl'),
    // Avatars over HTTP (server/routes/avatar.js; contract/README.md "Client
    // capabilities"): a same-origin path, versioned. Additive fields only;
    // a pic slot never carries one (it stays number | data URL | null)
    avatarUrl: str({ minLength: 1, maxLength: 512, pattern: '^/avatar/[^/?#\\s]+\\?v=[0-9a-f]{16}$' }),
    avatarUrlsByPosition: byPosition(ref('avatarUrl')),
    avatarUrlsByUsername: { type: 'object', patternProperties: { '^.{1,50}$': ref('avatarUrl') }, additionalProperties: false },

    // ---------- snapshot v2 (server/game/snapshotV2.js; contract/README.md) ----------
    snapshotV2: obj({
        v: konst(2),
        gameId: str(),
        seq: int({ minimum: 0 }),
        serverTime: int(),
        stage: enm(...STAGES),
        partial: arr(enm('customPics', 'log'), { maxItems: 2 }),
        viewer: ref('viewerV2'),
        hand: orNull(arr(ref('card'), { maxItems: 13 })),
        deal: orNull(obj({
            handNo: int({ minimum: 1, maximum: 13 }),
            handSize: int({ minimum: 1, maximum: 13 }),
            dealer: ref('position'),
            bidder: ref('position'),
            dealSeq: orNull(int({ minimum: 1 })),
        })),
        trump: orNull(ref('card')),
        trumpBroken: bool(),
        turn: orNull(obj({ position: ref('position'), action: enm('bid', 'play') })),
        bids: obj({
            byPosition: arr(orNull(ref('bidString')), { minItems: 4, maxItems: 4 }),
            order: arr(ref('position'), { minItems: 4, maxItems: 4 }),
            teamBids: orNull(ref('teamPair')),
            mults: obj({ team1: int({ minimum: 1 }), team2: int({ minimum: 1 }) }),
        }),
        trick: obj({
            number: orNull(int({ minimum: 1, maximum: 13 })),
            leadPosition: orNull(ref('position')),
            cards: arr(obj({ position: ref('position'), card: ref('card') }), { maxItems: 4 }),
        }),
        tricks: ref('teamPair'),
        tricksByPosition: arr(int({ minimum: 0 }), { minItems: 4, maxItems: 4 }),
        trickHistory: arr(obj({
            winner: ref('position'),
            lead: ref('position'),
            cards: arr(ref('card'), { minItems: 4, maxItems: 4 }),
        }), { maxItems: 13 }),
        score: ref('teamPair'),
        rainbows: ref('teamPair'),
        hsi: orNull(arr(orNull(num()), { minItems: 4, maxItems: 4 })),
        seats: arr(ref('seatV2'), { maxItems: 4 }),
        entrants: orNull(arr(obj({
            username: orNull(str()),
            isBot: bool(),
            presence: enm('connected', 'disconnected', 'left'),
            hasDrawn: bool(),
        }), { maxItems: 4 })),
        draw: orNull(ref('drawV2')),
        spectatorCount: int({ minimum: 0 }),
        tournament: orNull(ref('tournamentV2')),
        log: arr(obj({ message: str(), type: enm(...LOG_TYPES), position: orNull(ref('position')), at: int() })),
        resume: orNull(obj({
            kind: enm('countdown', 'drawReveal', 'seating', 'teams', 'firstTurn', 'trick', 'hand'),
            inMs: int({ minimum: 0, description: 'ms the server still holds the table, from serverTime (relative: never compare with a client clock)' }),
        })),
    }),
    viewerV2: obj({
        role: enm('seat', 'lazyWatcher', 'spectator', 'entrant', 'none'),
        position: orNull(ref('position')),
        ownerView: orNull(enm('seat', 'watch')),
        canAct: bool(),
    }),
    seatV2: obj({
        position: ref('position'),
        username: orNull(str()),
        pic: orNull(int()),
        hasCustomPic: bool(),
        customPic: orNull(str()),
        ownerUsername: orNull(str()),
        controller: enm('human', 'lazyBot', 'resignBot', 'bot'),
        presence: enm('connected', 'grace', 'resignable', 'away', 'gone', 'none'),
        isBot: bool(),
        lazy: bool(),
        offered: bool(),
        graceDeadline: orNull(int()),
        resignableAt: orNull(int()),
        cardsInHand: int({ minimum: 0, maximum: 13 }),
        // additive: present only for a custom picture with a rendition
        avatarUrl: ref('avatarUrl'),
    }, { optional: ['avatarUrl'] }),
    drawV2: obj({
        deckRemaining: orNull(int({ minimum: 0, maximum: 54 })),
        drawn: arr(obj({
            drawOrder: int({ minimum: 1, maximum: 4 }),
            username: orNull(str()),
            isBot: bool(),
            card: ref('card'),
            position: orNull(ref('position')),
        }), { maxItems: 4 }),
        viewerDrawOrder: orNull(int({ minimum: 1, maximum: 4 })),
    }),
    tournamentV2: obj({
        tournamentId: str(),
        name: str(),
        roundNumber: orNull(int({ minimum: 1 })),
        totalRounds: int(),
    }),
};

module.exports = {
    str, int, num, bool, nul, konst, enm, arr, ref, anyOf, orNull, obj, variant, byPosition, nonEmpty,
    SUITS, RANKS, BID_STRINGS, LOG_TYPES, STAGES,
    LEGACY_CLIENT_STATE_PROPS, SPECTATOR_STATE_V1_PROPS,
    defs,
};
