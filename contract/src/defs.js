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

// A bot's personality never reaches the wire (V1_REMOVALS #16, 2026-11-11:
// the lobby shows "🤖 Bot"; it stays server-side until the game starts)
const lobbyMember = obj({
    socketId: str(),
    username: str(),
    ready: bool(),
    isBot: konst(true),
}, { optional: ['isBot'] });

const chatLine = obj({ username: str(), message: str(), timestamp: int() });

const defs = {
    card: obj({ suit: enm(...SUITS), rank: enm(...RANKS) }),
    // Client-sent card: Joi requires suit/rank and strips the rest
    cardIn: obj({ suit: enm(...SUITS), rank: enm(...RANKS) }, { open: true }),
    position: int({ minimum: 1, maximum: 4 }),
    bidString: enm(...BID_STRINGS),
    // playerBids after a JSON round-trip: holes are null, trailing holes absent
    bidArray: arr(orNull(ref('bidString')), { maxItems: 4 }),
    playedCards: arr(orNull(ref('card')), { maxItems: 4 }),
    // During bidding {position: bid}; from the end of bidding {team1, team2}
    legacyBids: anyOf(variant('teams', obj({ team1: int(), team2: int() })), variant('byPosition', byPosition(ref('bidString')))),
    hsiValues: byPosition(num()),
    // numeric avatar id (stock art), or null: a custom picture travels only
    // as its URL (avatarUrls / avatarUrl), a seat whose picture was never
    // resolved is null too. No data:image value since V1_REMOVALS #19 A
    // (2026-11-12; baseline narrowed from integer | string | null)
    pic: { type: ['integer', 'null'] },
    teamPair: obj({ team1: int(), team2: int() }),
    gameLogEntry: obj({
        message: str(),
        playerPosition: orNull(ref('position')),
        type: enm(...LOG_TYPES),
        timestamp: int(),
    }),
    // No socketId since V1_REMOVALS #14 (2026-11-12): web and iOS 1.2.0
    // map voice peers to seats by username (the seat socket id was only a
    // fallback)
    playerInfoV1: obj({ position: ref('position'), username: str(), pic: ref('pic') }),
    playerInfoGameStart: obj({ position: ref('position'), username: str(), pic: ref('pic') }),
    // playerCount / maxPlayers / players stay the frozen <= 4 a shipped
    // client shows (a lobby of 4 or more is Full there); memberCount /
    // capacity / memberUsernames (additive 2026-11-16, family lobbies of up
    // to 8) are for clients that sent casualSpectators
    lobby: obj({
        id: str(),
        name: str(),
        playerCount: int({ minimum: 0, maximum: 4 }),
        maxPlayers: konst(4),
        players: arr(ref('lobbyPlayer'), { maxItems: 4 }),
        createdAt: int(),
        memberCount: int({ minimum: 0, maximum: 8 }),
        capacity: int({ minimum: 4, maximum: 8 }),
        memberUsernames: arr(str(), { maxItems: 8 }),
        // additive (2026-11-24): a Get Your Bid lobby and its table size
        // (3); such an entry is only in the list of a getYourBid client
        mode: ref('gybMode'),
        seats: int({ minimum: 3, maximum: 4 }),
    }, { optional: ['memberCount', 'capacity', 'memberUsernames', 'mode', 'seats'] }),
    lobbyPlayer: obj({ username: str(), ready: bool() }),
    lobbyMember,
    // Every member of a lobby of up to 8 (additive `members`, 2026-11-16):
    // lobbyMember (closed, frozen) plus playing (seated now: Playing / Will
    // watch / Sitting out) and reconnecting (a seat held for its grace)
    lobbyMemberV2: obj({
        socketId: str(),
        username: str(),
        ready: bool(),
        isBot: konst(true),
        playing: bool(),
        reconnecting: konst(true),
        // Play again (additive 2026-11-16): a place held for someone not
        // back from the last game yet (a row with no socket: `away:` id)
        returning: konst(true),
        // Play again (additive 2026-11-16): a moved member, mapped and
        // connected, whose app still shows the last game's results (no
        // lobbyReturnSeen nor any act in the lobby yet): "Still on the results"
        onResults: konst(true),
    }, { optional: ['isBot', 'reconnecting', 'returning', 'onResults'] }),
    // The host's lobby settings (2026-11-16): "Spectators can talk", default on
    lobbySettings: obj({ spectatorsCanTalk: bool() }),
    // serverError.code (V1_REMOVALS #1 phase A): one list with the server
    serverErrorCode: enm(...require('../../server/socket/serverError').CODES),
    lobbyChatLine: chatLine,
    mainRoomChatLine: chatLine,
    inProgressGame: obj({
        gameId: str(),
        players: arr(obj({ position: ref('position'), username: str() }), { maxItems: 4 }),
        currentHand: int({ minimum: 1, maximum: 13 }),
        score: ref('teamPair'),
        spectatorCount: int({ minimum: 0 }),
        // additive (2026-11-24): a Get Your Bid table (only in the list of
        // a getYourBid client) and each seat's score
        mode: ref('gybMode'),
        scores: ref('gybBySeat'),
    }, { optional: ['mode', 'scores'] }),
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
    // system / type (additive 2026-11-15): a server notice
    // (tournamentHandlers systemLine), never on a player's line
    tournamentChatLine: obj({ username: str(), message: str(), isSpectator: bool(), timestamp: int(), system: konst(true), type: konst('system') }, { optional: ['system', 'type'] }),
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
        // additive 2026-11-15, between rounds only: Begin may start with the
        // ready members (tournamentReadyUpdate notes)
        readyDeadlinePassed: bool(),
    }, { optional: ['winners', 'readyDeadlinePassed'] }),
    // DB projections: closed at the top, nested rows open
    profile: obj({
        username: str(),
        profilePic: int(),
        // always null since V1_REMOVALS #19 B: the custom picture is the reply's avatarUrl
        customProfilePic: nul(),
        stats: obj({}, { open: true }),
    }),
    leaderboardRow: obj({ username: str(), gamesPlayed: num(), winRate: num() }, { open: true }),
    // getRecords: per period (allTime / thisYear / thisMonth) null when no
    // game is recorded, else these five, each null until it has data (the
    // bag records skip legacy games without bags). Rows open, core required.
    // superlatives (additive 2026-11-20, optional): the period's player
    // titles (server/utils/superlatives.js), in server order; a title
    // nobody qualifies for is left out, so the list may be empty. Clients
    // render every entry generically (title, names joined with ", ",
    // detail), whatever its id, so a new title needs no client release.
    recordsPeriod: orNull(obj({
        highestScore: orNull(obj({ score: num(), players: arr(str()) }, { open: true })),
        lowestScore: orNull(obj({ score: num(), players: arr(str()) }, { open: true })),
        biggestWin: orNull(obj({
            margin: num(), winnerScore: num(), loserScore: num(), winnerPlayers: arr(str()), loserPlayers: arr(str()),
        }, { open: true })),
        mostBags: orNull(obj({ bags: num(), players: arr(str()) }, { open: true })),
        leastBags: orNull(obj({ bags: num(), players: arr(str()) }, { open: true })),
        superlatives: arr(ref('recordsSuperlative')),
    }, { open: true, optional: ['superlatives'] })),
    // One Records title: id (bagBoy, luckyDuck, cursed, botFriends,
    // helpFromFriends, myQuantitative, delusionsOfGrandeur today; anchor
    // until 2026-11-20, renamed delusionsOfGrandeur; more may come, render
    // unknown ids the same way), the title shown, the winner(s) (human usernames, up to 3
    // tied, alphabetical) and the value line ("2.4 bags a game"; " (+N
    // more)" when more players tied).
    recordsSuperlative: obj({
        id: str({ minLength: 1 }),
        title: str({ minLength: 1 }),
        names: arr(str(), { minItems: 1, maxItems: 3 }),
        detail: str(),
    }),
    // customProfilePic always null since V1_REMOVALS #19 B (the reply's avatarUrls has the URL)
    playerSearchRow: obj({ username: str(), profilePic: int(), customProfilePic: nul(), gamesPlayed: int(), wins: int() }),
    voicePeer: obj({ socketId: str(), username: { type: ['string', 'null'] } }),
    // One RTCIceServer (voiceIceServers): stun: / turn: / turns: URLs;
    // username + credential only on a TURN entry
    iceServer: obj({
        urls: arr(str({ pattern: '^(stun|turn|turns):' }), { minItems: 1 }),
        username: str(),
        credential: str(),
    }, { optional: ['username', 'credential'] }),
    legacyClientState: obj(LEGACY_CLIENT_STATE_PROPS),
    spectatorStateV1: obj(SPECTATOR_STATE_V1_PROPS),
    seq: int({ minimum: 1, description: 'Per-game broadcast sequence number (contract/README.md R1-R5)' }),
    // clientHello caps the server acts on (contract/README.md "Client
    // capabilities"); unknown caps are ignored, so the list only grows
    clientCap: enm('avatarUrl'),
    // A second cap as its own const ($defs.clientCap's enum is frozen
    // byte for byte by the baselines): family lobbies of up to 8, the
    // "Spectators can talk" switch, voiceSettings, spectator voice
    // (contract/README.md "Client capabilities")
    clientCapCasualSpectators: konst('casualSpectators'),
    // A third, its own const for the same reason (2026-11-16, play again):
    // at the end of a lobby-born casual game the client is moved back into
    // that lobby (s2c lobbyReturn) (contract/README.md "Client capabilities")
    clientCapPlayAgain: konst('playAgain'),
    // A fourth, its own const for the same reason (2026-11-18, /help): the
    // client renders the private s2c assistHint; without it a /help answer
    // comes as private gameLogEntry lines (contract/README.md "Client
    // capabilities")
    clientCapAssist: konst('assist'),
    // A fifth, its own const for the same reason (2026-11-19, the tutorial):
    // the client renders the tutorial's tips (assistHint kind tip, tipId,
    // actions) and s2c assistState; only such a socket gets the tutorial's
    // auto-start in a new account's first game (contract/README.md "Client
    // capabilities")
    clientCapTutorial: konst('tutorial'),
    // A sixth, its own const for the same reason (2026-11-21, the
    // over-the-shoulder view): a pure spectator may watch one seat's hand
    // (c2s watchHand, s2c watchHandRefused, gameStart / snapshot shoulder,
    // assistHint watched, spectatorEntry shoulder); without it none of that
    // is ever sent (contract/README.md "Client capabilities",
    // docs/claude/spectators.md "Over-the-shoulder view")
    clientCapShoulderView: konst('shoulderView'),
    // A seventh, its own const for the same reason (2026-11-24, tournament
    // voice): the client starts voice on its tournament lobby screen and at
    // a tournament table, so it may be a peer of the tournament's voice room
    // (voicePeerList / voicePeerJoined / voicePeerLeft for tournament:<id>)
    // and is announced at its table's seating; without it a socket is never
    // listed in the tournament room (contract/README.md "Client
    // capabilities", docs/claude/voice.md "Tournament voice")
    clientCapTournamentVoice: konst('tournamentVoice'),
    // An eighth, its own const for the same reason (2026-11-24, Get Your
    // Bid): the client can show a Get Your Bid lobby and table (3 seats,
    // no teams; server/game/gameMode.js). Only such a socket is listed
    // one, may create, join, rejoin or watch one, so every `gyb` / `mode`
    // key below reaches only clients that know the mode (the web; no iOS
    // build) (contract/README.md "Client capabilities")
    clientCapGetYourBid: konst('getYourBid'),
    // A ninth, its own const for the same reason (2026-11-25, badges): the
    // client shows badges, so its profile replies carry the player's earned
    // ones (`badges`) and it gets the private s2c badgesAwarded after a
    // game that earned one; without it neither is ever sent (the web; no
    // iOS build) (contract/README.md "Client capabilities")
    clientCapBadges: konst('badges'),
    // One EARNED badge (server/game/badges.js publicBadge). The catalog is
    // never on the wire: a badge nobody told this client about stays a
    // surprise (owner 2026-11-25). id is also the art's file name
    // (client/assets/badges/<id>.svg); at (ISO) only on a profile
    earnedBadge: obj({ id: str({ minLength: 1, maxLength: 40 }), name: str(), description: str(), at: str() }, { optional: ['at'] }),
    // ---------- Get Your Bid (2026-11-24; server/game/gameMode.js) ----------
    // The one mode value on the wire (absent = the base game)
    gybMode: konst('gyb'),
    // One value per seat, by position - 1
    gybBySeat: arr(int(), { minItems: 3, maxItems: 3 }),
    // The last bidder's Forbidden Bid of this deal (rules.gybForbiddenBid)
    gybForbidden: obj({ position: int({ minimum: 1, maximum: 3 }), bid: int({ minimum: 0, maximum: 13 }) }),
    // Beside every snapshot of a Get Your Bid table (the carrier's own
    // `gyb`: $defs.snapshotV2 is frozen at four seats and its generated
    // Swift is not touched): scores and exact bids so far, the hands
    // counted, this deal's Forbidden Bid and won tricks (3 cards each)
    gybSnapshot: obj({
        scores: ref('gybBySeat'),
        made: ref('gybBySeat'),
        hands: int({ minimum: 0, maximum: 13 }),
        forbidden: orNull(ref('gybForbidden')),
        trickHistory: arr(obj({
            winner: int({ minimum: 1, maximum: 3 }),
            lead: int({ minimum: 1, maximum: 3 }),
            cards: arr(ref('card'), { minItems: 3, maxItems: 3 }),
        }), { maxItems: 13 }),
    }),
    // handComplete.gyb: the hand, seat by seat
    gybHand: obj({
        scores: ref('gybBySeat'),
        oldScores: ref('gybBySeat'),
        seats: arr(obj({
            position: int({ minimum: 1, maximum: 3 }),
            bid: int({ minimum: 0, maximum: 13 }),
            took: int({ minimum: 0, maximum: 13 }),
            points: int({ minimum: 0 }),
            forbiddenHit: bool(),
        }), { minItems: 3, maxItems: 3 }),
        forbidden: orNull(ref('gybForbidden')),
    }),
    // gameEnd.gyb (and lobbyReturn.lastGame.gyb): the result
    gybEnd: obj({
        scores: ref('gybBySeat'),
        winners: arr(int({ minimum: 1, maximum: 3 }), { minItems: 1, maxItems: 3 }),
        made: ref('gybBySeat'),
        hands: int({ minimum: 0, maximum: 13 }),
    }),
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
        // never 'customPics' since V1_REMOVALS #19 C; the value stays in the
        // enum, which the generated Swift PartialKey mirrors
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
        // additive (2026-11-11): who is watching, as spectatorsUpdated sends it
        watching: ref('spectatorList'),
        tournament: orNull(ref('tournamentV2')),
        // fault (additive 2026-11-19): only on a hand's fault line
        // ("Fault: <name> (bid N, took M)"; s2c gameLogEntry room)
        // help (additive 2026-11-23): only on the /help room notice
        log: arr(obj({ message: str(), type: enm(...LOG_TYPES), position: orNull(ref('position')), at: int(), fault: ref('logFault'), help: ref('logHelp'), tutorial: ref('logTutorial') }, { optional: ['fault', 'help', 'tutorial'] })),
        resume: orNull(obj({
            kind: enm('countdown', 'drawReveal', 'seating', 'teams', 'firstTurn', 'trick', 'hand'),
            inMs: int({ minimum: 0, description: 'ms the server still holds the table, from serverTime (relative: never compare with a client clock)' }),
        })),
        // additive (2026-11-18, the bid clock): present ONLY while a bid clock
        // runs (as bidClock running sent it), absent otherwise: an exception
        // to "every key always present" (contract/README.md, Snapshot v2)
        bidClock: obj({
            position: ref('position'),
            inMs: int({ minimum: 0, description: 'ms until the server bids 0 for the seat, from serverTime (relative: never compare with a client clock)' }),
            durationMs: int({ minimum: 1 }),
        }),
    }, { optional: ['bidClock'] }),
    viewerV2: obj({
        role: enm('seat', 'lazyWatcher', 'spectator', 'entrant', 'none'),
        position: orNull(ref('position')),
        ownerView: orNull(enm('seat', 'watch')),
        canAct: bool(),
        // additive (2026-11-19): the viewer's own /help count this game,
        // as s2c assistHint sends it; present only for a seat owner (role
        // seat or lazyWatcher), absent for everyone else. Read by the web
        // (tableSync) and iOS after 1.2.3 (17) (TableReducer+Snapshot: the
        // chat list's "(n of 3 free used)" after a rejoin); its additive
        // unlimited (2026-11-19) marks a game with a native bot seat (no
        // count shown, so clients know after a reload)
        assist: ref('viewerAssist'),
        // additive (2026-11-21, the over-the-shoulder view): the hand a pure
        // spectator watches (role spectator, position null as before),
        // present only for a socket with the clientHello cap shoulderView
        // while its watchHand stands
        shoulder: ref('shoulderHand'),
    }, { optional: ['assist', 'shoulder'] }),
    // The watched seat's private table (server/socket/shoulderView.js
    // shoulderPayload): that seat's hand now (cards it played are gone) and
    // that seat's HSI of this deal (null before one); never another seat's
    shoulderHand: obj({
        position: ref('position'),
        hand: arr(ref('card'), { maxItems: 13 }),
        hsi: orNull(num()),
    }),
    viewerAssist: obj({
        uses: int({ minimum: 0, description: 'counted /help uses of this player this game' }),
        freeUses: int({ minimum: 0, description: 'free uses per game (3); more makes the game bot-assisted for the player' }),
        assisted: bool({ description: 'this game counts as bot-assisted for the player' }),
        // additive (2026-11-19, owner): as s2c assistHint's unlimited
        unlimited: bool({ description: 'true only in a game with a native bot seat (assistState.isFreeHelpGame): /help has no limit there and clients show no count or free/limit words; absent otherwise' }),
        // additive (2026-11-19, the tutorial): present (true) only while the
        // player's tutorial is on, so a reload shows the 'Tutorial on' chip
        tutorial: bool({ description: 'the tutorial is on for this player (only present while on)' }),
        auto: bool({ description: 'the tutorial was turned on by the auto-start (only present while on)' }),
    }, { optional: ['unlimited', 'tutorial', 'auto'] }),
    // A hand's fault line (2026-11-19, owner): a player on a SET team (fewer
    // tricks than its combined bid) who took fewer tricks than they bid (a
    // bore counts as 0). Rule: server/game/rules.js handFaults (the
    // setsCaused stat). Clients draw the line red
    logFault: obj({
        position: ref('position'),
        bid: int({ minimum: 1, maximum: 13, description: 'the player\'s own bid (a bore never faults: it counts as 0)' }),
        took: int({ minimum: 0, maximum: 12, description: 'tricks the player took this hand (fewer than bid)' }),
    }),
    // The /help room notice (2026-11-23, owner: "in gray that's hard to
    // see"): "<name> used /help." and its bot-assisted variant
    // (server/socket/assistHandlers.js, a counted use). Clients draw the line
    // in the suggestion's gold
    logHelp: obj({
        position: ref('position'),
    }),
    // The tutorial's room lines (2026-11-23, owner: a graduation cap on the
    // avatar, and the lines drawn like the /help notice for parity): "<name>
    // turned on the tutorial." (and its variants, the auto-start's "<name> is
    // playing with the tutorial.", "This game now counts as bot-assisted for
    // <name>.") carry on: true, "<name> turned off the tutorial." on: false.
    // Live and stored (snapshot log items): a live tag also moves the
    // avatar's cap; a replayed one only styles its line (the snapshot's
    // seats[].tutorial carries the state)
    logTutorial: obj({
        position: ref('position'),
        on: bool(),
    }),
    seatV2: obj({
        position: ref('position'),
        username: orNull(str()),
        pic: orNull(int()),
        hasCustomPic: bool(),
        // always null since V1_REMOVALS #19 C (a custom picture is avatarUrl);
        // the type stays string | null: the generated Swift Seat (and iOS
        // 1.2.0) decode it as String?, and the generator has no null type
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
        // additive (2026-11-23, the avatar badges), present only when true:
        // the seat owner's tutorial is on (the graduation cap), and a counted
        // /help on this seat's open turn (the lightbulb; gone once it bids or
        // plays, as the turn moves on)
        tutorial: bool(),
        askedHelp: bool(),
    }, { optional: ['avatarUrl', 'tutorial', 'askedHelp'] }),
    // a spectator in the table's list (server/game/spectatorWire.js): a
    // stock pic (1-82) or null; a custom picture only as avatarUrl
    spectatorEntry: obj({
        username: str(),
        pic: orNull(int({ minimum: 1, maximum: 82 })),
        avatarUrl: ref('avatarUrl'),
        // additive (2026-11-21, the over-the-shoulder view): the seat whose
        // hand this person watches; only in the copies sent to a socket with
        // the clientHello cap shoulderView (the table sees who watches which
        // hand), absent otherwise
        shoulder: ref('position'),
    }, { optional: ['avatarUrl', 'shoulder'] }),
    // GameState.spectatorList() on the wire: at most 50 people, `count`
    // the true total (spectatorsUpdated, snapshot v2 `watching`)
    spectatorList: obj({
        spectators: arr(ref('spectatorEntry'), { maxItems: 50 }),
        count: int({ minimum: 0 }),
    }),
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
