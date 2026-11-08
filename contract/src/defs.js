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
    // bidReceived.bid echoes what the client sent (ctr-22): iOS sends an
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
    playerSearchRow: obj({ username: str(), profilePic: int(), customProfilePic: orNull(str()), gamesPlayed: int(), wins: int() }),
    voicePeer: obj({ socketId: str(), username: { type: ['string', 'null'] } }),
    legacyClientState: obj(LEGACY_CLIENT_STATE_PROPS),
    spectatorStateV1: obj(SPECTATOR_STATE_V1_PROPS),
    seq: int({ minimum: 1, description: 'Per-game broadcast sequence number (contract/README.md R1-R5)' }),
};

module.exports = {
    str, int, num, bool, nul, konst, enm, arr, ref, anyOf, orNull, obj, variant, byPosition, nonEmpty,
    SUITS, RANKS, BID_STRINGS, LOG_TYPES,
    LEGACY_CLIENT_STATE_PROPS, SPECTATOR_STATE_V1_PROPS,
    defs,
};
