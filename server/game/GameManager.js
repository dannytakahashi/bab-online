/**
 * Manages the main room, lobbies, active game instances and tournaments
 * Singleton pattern for server-wide coordination
 */

const { v4: uuidv4 } = require('uuid');
const GameState = require('./GameState');
const TournamentState = require('./TournamentState');
const { getUsersCollection } = require('../database');
const { botController, BotPlayer, personalities } = require('./bot');
const { PERSONALITY_LIST } = personalities;
const { Phase } = require('./GamePhase');
const spectatorRoster = require('./spectatorRoster');
const { seesAmbientChat, seesAmbientGame } = require('../utils/ambientChatUsers');
const { safeTimeout } = require('../utils/safeTimer');

const MERGE_LOCKED = 'This account is being updated. Please try again in a minute.';
// Family lobbies (owner 2026-11-16): up to 8 people while every human in the
// lobby is capable (clientHello cap casualSpectators); the first 4 to tap
// Ready play and the rest watch the game (server/voice/gameVoice.js)
const LEGACY_LIMIT = 'This lobby is limited to 4 players because someone in it is on an older app version';
const TABLE_FULL = "The table is full — you'll watch this game";
const TABLE_SIZE = 4;
const WIDE_LOBBY = 8;

/** The voice room module, loaded lazily (it requires this one). */
const gameVoice = () => require('../voice/gameVoice');
/** Play again (after a lobby-born casual game), loaded lazily (it requires this one). */
const playAgain = () => require('../socket/playAgain');
/**
 * The live persist store (deploy survival; persist/liveStore.js), loaded
 * lazily. With LIVE_PERSIST off every call on it is a no-op.
 */
const liveStore = () => require('./persist/liveStore').getLiveStore();
// LIVE_PERSIST=on resolving (deploy survival PR 5/6): false off and in write mode
const persistOn = () => {
    try {
        return require('../socket/pointerResolve').active();
    } catch {
        return false;
    }
};

class GameManager {
    constructor() {
        // Main room (global chat + lobby browser)
        this.mainRoomMessages = [];       // Global chat history (capped at MAX_MAIN_ROOM_MESSAGES)
        // The ambient bots' main-room lines (server/demo/ambientBots.js), in
        // their own ring with the same cap, so bot chatter never pushes a
        // human line out of mainRoomMessages; only AMBIENT_CHAT_USERS see
        // them (server/utils/ambientChatUsers.js, mainRoomMessagesFor)
        this.ambientMainRoomMessages = [];
        this.mainRoomSocketIds = new Set(); // Players currently in main room
        // Called with the socket id after every joinMainRoom (all three join
        // points: joinMainRoom, leaveLobby, a tournament's sendToMainRoom).
        // server/demo/ambientBots.js starts its game on demand from here
        this.mainRoomJoinListeners = new Set();

        // Lobbies (pre-game waiting rooms)
        this.lobbies = new Map();      // lobbyId → { players: [], readyPlayers: Set, messages: [] }
        this.playerLobbies = new Map(); // socketId → lobbyId
        // Lobby seats whose socket dropped, held for LOBBY_SEAT_GRACE_MS
        // (suspendLobbySeat): old socketId → { lobbyId, username, timer }
        this.lobbyGrace = new Map();
        // Lobbies that just became a game with extras (members who did not
        // get a seat and now watch it): lobbyId -> { gameId, extras:
        // Set<username> }. An extra re-sending joinLobby for that lobby (a
        // reload during the start) is sent to the game as a spectator
        // instead of 'Lobby not found'. Cleared when the game retires
        this.startedLobbies = new Map();

        // Active games
        this.games = new Map();        // gameId → GameState
        this.playerGames = new Map();  // socketId → gameId (entrants, seat owners, seat bots)
        this.spectatorGames = new Map(); // socketId → gameId (pure spectators: one game each)

        // Current users (logged in)
        this.currentUsers = [];        // [{ username, socketId }, ...]

        // Tournaments
        this.tournaments = new Map();       // tournamentId → TournamentState
        this.playerTournaments = new Map();  // socketId → tournamentId
        this.tournamentGames = new Map();    // gameId → tournamentId

        // Usernames deleted this server lifetime — keeps an in-flight game
        // from re-inserting a deleted username into new gameRecords
        this.deletedUsernames = new Set();

        // Accounts a panel merge is retiring, a panel delete is removing or
        // a panel rename is moving right now (both names; adminHandlers):
        // they cannot sign in, restore, rejoin, open or join a lobby
        // or a tournament (and a rename's new name cannot be signed up)
        // until it is done
        this.mergeLocks = new Set();
    }

    // Constants
    static MAX_MAIN_ROOM_MESSAGES = 50;
    // A lobby's chat history (sent whole on every join): the newest lines,
    // as the tournament chat keeps 100
    static MAX_LOBBY_MESSAGES = 100;
    // A lobby seat outlives its socket by this long (a reload, a short
    // network drop): the player's next socket re-entering takes it back
    static LOBBY_SEAT_GRACE_MS = 30000;
    static LEGACY_LIMIT = LEGACY_LIMIT;
    static TABLE_FULL = TABLE_FULL;

    /**
     * Register a logged-in user. One entry per username AND one per socket:
     * a socket that was signed in as another account is that account no
     * longer (sessionIdentity.releaseIdentity tears the old identity down
     * first). Returns the socket id the name was registered on before, when
     * it was another socket (the caller tells that socket it was replaced).
     * @returns {string|null}
     */
    registerUser(socketId, username) {
        const previous = this.currentUsers.find(u => u.username === username);
        this.currentUsers = this.currentUsers.filter(u => u.username !== username && u.socketId !== socketId);
        this.currentUsers.push({ username, socketId });
        return previous && previous.socketId !== socketId ? previous.socketId : null;
    }

    /** Forget a (dead) socket's signed-in user entry. */
    removeUserSocket(socketId) {
        this.currentUsers = this.currentUsers.filter(u => u.socketId !== socketId);
    }

    /**
     * Get user by socket ID
     */
    getUserBySocketId(socketId) {
        return this.currentUsers.find(u => u.socketId === socketId);
    }

    // ==================== MERGE LOCK ====================

    isMergeLocked(username) {
        return username != null && this.mergeLocks.has(username);
    }

    lockForMerge(usernames) {
        for (const name of usernames) this.mergeLocks.add(name);
    }

    unlockMerge(usernames) {
        for (const name of usernames) this.mergeLocks.delete(name);
    }

    /** A locked name ignoring case (sign-up: a rename's new name is taken while it runs). */
    isNameLockedIgnoringCase(username) {
        if (username == null || this.mergeLocks.size === 0) return false;
        const key = String(username).trim().toLowerCase();
        for (const name of this.mergeLocks) if (name.toLowerCase() === key) return true;
        return false;
    }

    /** The signed-in user of `socketId` when a merge holds their name. */
    _mergeLockedUser(socketId) {
        const user = this.getUserBySocketId(socketId);
        return user && this.isMergeLocked(user.username) ? user : null;
    }

    /**
     * An admin rename or merge moved `oldName` to `newName`: re-point the
     * internal chat sender (`from`) of every live game's log
     * (GameState.renameChatSender). A spectator's chat stays in the log
     * after the account is signed out (findLiveActivity does not count
     * spectating), and the blockers' lists now name `newName`.
     * @returns {number} lines re-pointed
     */
    renameChatSender(oldName, newName) {
        let n = 0;
        for (const game of this.games.values()) {
            const k = game.renameChatSender?.(oldName, newName) || 0;
            // Lines changed in place: the saved log is written whole next time
            if (k > 0) liveStore().markFullLog(game);
            n += k;
        }
        return n;
    }

    /**
     * Where `username` plays right now, from memory (not the database's
     * activeGameId, which is written only once the draw is over): a live
     * game that has them as an entrant (draw phase), a seat owner (any
     * presence) or a player, or a tournament that is not complete.
     * @returns {{kind: 'game'|'tournament', id: string}|null}
     */
    findLiveActivity(username) {
        if (username == null) return null;
        for (const game of this.games.values()) {
            if (game.isTerminal?.()) continue;
            const isEntrant = game.entrants
                ? [...game.entrants.values()].some(e => !e.isBot && e.username === username)
                : false;
            const isPlayer = [...(game.players?.values?.() || [])].some(p => p && p.username === username);
            if (isEntrant || isPlayer || game.seatByUsername?.(username) != null) {
                return { kind: 'game', id: game.gameId };
            }
        }
        for (const t of this.tournaments.values()) {
            if (t.phase === 'complete') continue;
            for (const p of t.players.values()) {
                if (p.username === username) return { kind: 'tournament', id: t.tournamentId };
            }
        }
        return null;
    }

    /**
     * What `socketId` belongs to, from the membership maps: a lobby seat, a
     * game (entrant or seat owner) or a tournament that is not complete. A
     * tournament member's round table counts as the tournament (`gameId`
     * says which table). Spectating is not a membership. Every entry point
     * (create/join lobby, create/join tournament, rejoinGame and the owner
     * paths of joinAsSpectator) refuses a socket that already has another,
     * so one socket is never an entrant of two things (a hand-written client
     * or a double click used to make it one).
     * @returns {{kind: 'lobby'|'game'|'tournament', id: string, gameId?: string}|null}
     */
    activityOf(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (lobbyId != null) return { kind: 'lobby', id: lobbyId };
        const tournamentId = this.playerTournaments.get(socketId);
        const t = tournamentId != null ? this.tournaments.get(tournamentId) : null;
        const liveTournament = t && t.phase !== 'complete' ? tournamentId : null;
        const gameId = this.playerGames.get(socketId);
        if (gameId != null) {
            const tableOf = this.tournamentGames.get(gameId);
            if (tableOf != null && tableOf === liveTournament) return { kind: 'tournament', id: tableOf, gameId };
            return { kind: 'game', id: gameId };
        }
        if (liveTournament != null) return { kind: 'tournament', id: liveTournament };
        return null;
    }

    /**
     * The membership that keeps `socketId` out of a seat at `gameId`
     * (rejoinGame, joinAsSpectator's owner paths), or null: none, this game
     * itself, or the tournament this game is a table of.
     */
    activityBesides(socketId, gameId) {
        const activity = this.activityOf(socketId);
        if (!activity) return null;
        if (activity.kind === 'game' && activity.id === gameId) return null;
        if (activity.kind === 'tournament' && activity.id === this.tournamentGames.get(gameId) &&
            (activity.gameId == null || activity.gameId === gameId)) return null;
        return activity;
    }

    /** The refusal for an entry point that finds `activity` (activityOf). */
    membershipError(activity) {
        return {
            lobby: 'Already in a lobby',
            game: 'Already in game',
            tournament: 'Already in a tournament'
        }[activity.kind];
    }

    // ==================== MAIN ROOM METHODS ====================

    /**
     * Add player to main room
     */
    joinMainRoom(socketId, { wide = false } = {}) {
        // Validate user is registered
        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not registered yet' };
        }

        // Remove from lobby if in one
        if (this.playerLobbies.has(socketId)) {
            this.leaveLobby(socketId);
        }

        // Returning from a finished tournament's results screen releases that
        // membership (active tournaments are left alone)
        this.releaseCompletedTournamentMembership(socketId);

        this.mainRoomSocketIds.add(socketId);
        for (const listener of this.mainRoomJoinListeners) listener(socketId);

        return {
            success: true,
            messages: this.mainRoomMessagesFor(user.username),
            lobbies: this.getAllLobbies({ wide }),
            onlineCount: this.mainRoomSocketIds.size,
            username: user.username
        };
    }

    /**
     * Call `fn(socketId)` after every successful joinMainRoom.
     * @returns {Function} unsubscribe
     */
    onMainRoomJoin(fn) {
        this.mainRoomJoinListeners.add(fn);
        return () => this.mainRoomJoinListeners.delete(fn);
    }

    /**
     * Remove player from main room
     */
    leaveMainRoom(socketId) {
        this.mainRoomSocketIds.delete(socketId);
        return { success: true };
    }

    /**
     * Get usernames of all online users (registered in currentUsers)
     */
    getOnlineUsernames() {
        return this.currentUsers.map(u => u.username);
    }

    /**
     * Check if player is in main room
     */
    isInMainRoom(socketId) {
        return this.mainRoomSocketIds.has(socketId);
    }

    /**
     * Add message to main room chat
     */
    addMainRoomMessage(socketId, message) {
        const user = this.getUserBySocketId(socketId);
        if (!user) return { success: false, error: 'User not found' };

        const chatMessage = {
            username: user.username,
            message,
            timestamp: Date.now()
        };

        this.mainRoomMessages.push(chatMessage);

        // Cap message history
        if (this.mainRoomMessages.length > GameManager.MAX_MAIN_ROOM_MESSAGES) {
            this.mainRoomMessages.shift();
        }

        return { success: true, chatMessage };
    }

    /**
     * Store an ambient bot's main-room line in its own ring (capped like the
     * human history). The caller sends it live to those who see it.
     */
    addAmbientMainRoomMessage(chatMessage) {
        this.ambientMainRoomMessages.push(chatMessage);
        if (this.ambientMainRoomMessages.length > GameManager.MAX_MAIN_ROOM_MESSAGES) {
            this.ambientMainRoomMessages.shift();
        }
        return chatMessage;
    }

    /**
     * The main-room chat replay for `username`: the human history, plus the
     * ambient bots' lines for an AMBIENT_CHAT_USERS account (merged by time,
     * the newest MAX_MAIN_ROOM_MESSAGES, as one shared ring kept before).
     * Everyone else gets exactly the human history, all of it.
     */
    mainRoomMessagesFor(username) {
        if (this.ambientMainRoomMessages.length === 0 || !seesAmbientChat(username)) {
            return this.mainRoomMessages;
        }
        const humans = this.mainRoomMessages;
        const bots = this.ambientMainRoomMessages;
        const merged = [];
        let h = 0;
        let b = 0;
        while (h < humans.length || b < bots.length) {
            // Ties: the bot line first (it was stored first in practice:
            // seeded lines are back-dated)
            if (h >= humans.length || (b < bots.length && bots[b].timestamp <= humans[h].timestamp)) {
                merged.push(bots[b++]);
            } else {
                merged.push(humans[h++]);
            }
        }
        return merged.slice(-GameManager.MAX_MAIN_ROOM_MESSAGES);
    }

    /**
     * Get all socket IDs in main room
     */
    getMainRoomSocketIds() {
        return Array.from(this.mainRoomSocketIds);
    }

    /**
     * Get all lobbies for display
     */
    getAllLobbies({ wide = false } = {}) {
        const lobbies = [];
        for (const [lobbyId, lobby] of this.lobbies) {
            // A shipped client reads playerCount / maxPlayers / players and
            // shows a lobby of 4 or more as Full: they stay at most 4 (the
            // frozen $defs.lobby). memberCount / capacity / memberUsernames
            // are additive, only in the list a capable client gets (`wide`:
            // n/8, Rejoin for member 6), so the wire without the cap is
            // byte-identical (wireGolden)
            const entry = {
                id: lobbyId,
                name: lobby.name || `${lobby.players[0]?.username || 'Unknown'}'s Game`,
                playerCount: Math.min(lobby.players.length, TABLE_SIZE),
                maxPlayers: 4,
                players: lobby.players.slice(0, TABLE_SIZE).map(p => ({
                    username: p.username,
                    ready: p.ready
                })),
                createdAt: lobby.createdAt
            };
            if (wide) {
                entry.memberCount = lobby.players.length;
                entry.capacity = this.lobbyCapacity(lobby);
                entry.memberUsernames = lobby.players.map(p => p.username);
            }
            lobbies.push(entry);
        }
        return lobbies;
    }

    /**
     * Create a named lobby from main room
     */
    createNamedLobby(socketId, name = null, { capable = false, io = null } = {}) {
        if (this._mergeLockedUser(socketId)) return { success: false, error: MERGE_LOCKED };
        // One membership per socket (a finished tournament's results window
        // does not count)
        this.releaseCompletedTournamentMembership(socketId);
        const activity = this.activityOf(socketId);
        if (activity) {
            return { success: false, error: activity.kind === 'lobby' ? 'Already in lobby' : this.membershipError(activity) };
        }

        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not found' };
        }
        // Nor a tournament an older socket of theirs still holds: given up
        // in its lobby, refused once it has begun (giveUpStaleTournament)
        const staleTournament = this.giveUpStaleTournament(user.username, socketId);
        if (staleTournament.refused) return { success: false, error: 'Already in a tournament' };

        // One seat per user: a seat this user still holds from an older
        // socket (half-open reconnect) is given up
        const evicted = this.evictStaleLobbySeat(user.username, socketId);

        // Spectating is not a membership, but a lobby member watches nothing
        // (and leaves the game's voice room)
        this.leaveSpectating(io, socketId);

        // Leave main room
        this.leaveMainRoom(socketId);

        const lobbyId = uuidv4();
        const lobby = {
            id: lobbyId,
            name: name || `${user.username}'s Game`,
            players: [{
                socketId,
                username: user.username,
                ready: false
            }],
            readyPlayers: new Set(),
            messages: [],
            createdAt: Date.now(),
            createdBy: user.username,
            // The host (owner 2026-11-16; play again's "Don't wait"); the
            // role moves on when they leave (_reassignHost). settings is
            // fixed: spectators always may talk (owner 2026-11-18), the
            // field stays for the clients that read it
            host: user.username,
            settings: { spectatorsCanTalk: true },
            // Sockets that announced casualSpectators (lobbyCapacity)
            capable: new Set(capable ? [socketId] : [])
        };

        this.lobbies.set(lobbyId, lobby);
        this.playerLobbies.set(socketId, lobbyId);
        // A place reserved for them after a game elsewhere is given up
        playAgain().dropReservations(user.username);

        return { success: true, lobby, evicted, evictedTournament: staleTournament.evicted };
    }

    /**
     * Join a specific lobby by ID
     */
    joinSpecificLobby(socketId, lobbyId, { capable = false, io = null } = {}) {
        if (this._mergeLockedUser(socketId)) return { success: false, error: MERGE_LOCKED };
        // Already seated in THIS lobby (a socket that took its held seat
        // back in place, sessionIdentity.clearSuperseded, then re-sends the
        // join as clients do after a restore): the lobby again, no change
        const seatedIn = this.playerLobbies.get(socketId);
        if (seatedIn != null && seatedIn === lobbyId) {
            const lobby = this.lobbies.get(lobbyId);
            const seat = lobby?.players.find(p => !p.isBot && p.socketId === socketId);
            if (seat) return { success: true, lobby, newPlayer: seat, alreadySeated: true };
        }
        // One membership per socket (activityOf)
        this.releaseCompletedTournamentMembership(socketId);
        const activity = this.activityOf(socketId);
        if (activity) return { success: false, error: this.membershipError(activity) };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) {
            return { success: false, error: 'Lobby not found' };
        }

        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not found' };
        }

        // Re-entry from a new socket (half-open reconnect: the server keeps
        // the old socket for up to pingInterval + pingTimeout, ~45 s). The
        // seat moves to this socket in place, so a full lobby still lets its
        // own player back in.
        const stale = this.findStaleLobbySeat(user.username, socketId);
        if (stale && stale.lobby.id === lobbyId) {
            // An older app taking back a seat in a lobby of more than 4
            // would get a list it cannot show: refused, and the held seat
            // expires as usual
            if (!capable && lobby.players.length > TABLE_SIZE) {
                return { success: false, error: 'Lobby is full' };
            }
            this.leaveSpectating(io, socketId);
            return this.takeOverLobbySeat(socketId, lobbyId, { capable });
        }
        // 8 while every human (the joiner too) is capable, else 4: an older
        // app never sees more than 4, and a lobby with one in stays at 4
        const capacity = this.lobbyCapacity(lobby, capable);
        if (lobby.players.length >= capacity) {
            const legacyLimited = capable && capacity === TABLE_SIZE && lobby.players.length < WIDE_LOBBY;
            return { success: false, error: legacyLimited ? LEGACY_LIMIT : 'Lobby is full' };
        }
        // Places saved for the last game's players who are not back yet
        // (play again: a legacy seat owner's reservation): while one stands
        // members + reservations may not pass 4 for anyone else
        if (playAgain().reservationBlocks(lobby, user.username)) {
            return { success: false, error: capable ? playAgain().RESERVED_MESSAGE : 'Lobby is full' };
        }
        // Nor a tournament an older socket still holds (createNamedLobby)
        const staleTournament = this.giveUpStaleTournament(user.username, socketId);
        if (staleTournament.refused) return { success: false, error: 'Already in a tournament' };

        // One seat per user: a seat this user still holds in another lobby
        // from an older socket is given up
        const evicted = this.evictStaleLobbySeat(user.username, socketId);

        // A lobby member watches nothing (createNamedLobby)
        this.leaveSpectating(io, socketId);

        // Leave main room
        this.leaveMainRoom(socketId);

        const newPlayer = {
            socketId,
            username: user.username,
            ready: false
        };

        lobby.players.push(newPlayer);
        this.playerLobbies.set(socketId, lobbyId);
        if (capable) this._capableSet(lobby).add(socketId);
        // Their reservation here is used; one elsewhere is given up
        playAgain().dropReservations(user.username, { joinedLobbyId: lobbyId });

        return { success: true, lobby, newPlayer, evicted, evictedTournament: staleTournament.evicted };
    }

    /**
     * A pre-game lobby seat held by `username` from a socket other than
     * `socketId` (bots never match: their usernames are lobby labels).
     * @returns {{lobby: Object, player: Object}|null}
     */
    findStaleLobbySeat(username, socketId) {
        if (!username) return null;
        for (const lobby of this.lobbies.values()) {
            const player = lobby.players.find(p =>
                !p.isBot && p.username === username && p.socketId !== socketId);
            if (player) return { lobby, player };
        }
        return null;
    }

    /**
     * Move this user's seat in `lobbyId` from its older socket to `socketId`,
     * in place: same position in lobby.players, so nobody else's seat or
     * ready flag changes. Only this player's ready flag resets: both clients
     * build a freshly entered lobby screen as not ready (iOS GameLobbyView
     * keeps a local isReady = false), and a player who was away should
     * confirm again before the game can start without them.
     *
     * The old socket loses its lobby mapping, so its eventual disconnect
     * (handleDisconnect -> leaveLobby) finds no lobby and changes nothing.
     * @returns {{success, lobby, newPlayer, replacedSocketId}|{success:false,error}}
     */
    takeOverLobbySeat(socketId, lobbyId, { capable = false } = {}) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };
        const user = this.getUserBySocketId(socketId);
        if (!user) return { success: false, error: 'User not found' };
        const seat = lobby.players.find(p =>
            !p.isBot && p.username === user.username && p.socketId !== socketId);
        if (!seat) return { success: false, error: 'Seat not found' };

        const replacedSocketId = seat.socketId;
        this._clearLobbyGrace(replacedSocketId);
        lobby.readyPlayers.delete(replacedSocketId);
        if (this.playerLobbies.get(replacedSocketId) === lobbyId) {
            this.playerLobbies.delete(replacedSocketId);
        }

        seat.socketId = socketId;
        seat.ready = false;
        this.playerLobbies.set(socketId, lobbyId);
        this.leaveMainRoom(socketId);
        const caps = this._capableSet(lobby);
        caps.delete(replacedSocketId);
        if (capable) caps.add(socketId);
        // A host chosen only because nobody was connected is chosen again
        this._reassignHost(lobby);

        return { success: true, lobby, newPlayer: seat, replacedSocketId };
    }

    /**
     * Remove the seat `username` holds in a pre-game lobby from an older
     * socket, exactly as if that socket had left (leaveLobby: its lobby's
     * ready flags reset, an empty / bots-only lobby is deleted).
     * @returns {{oldSocketId, leaveResult}|null} for the caller's notifications
     */
    evictStaleLobbySeat(username, socketId) {
        const stale = this.findStaleLobbySeat(username, socketId);
        if (!stale) return null;
        const oldSocketId = stale.player.socketId;
        // leaveLobby goes by the mapping; a seat without one (should not
        // happen) is mapped first so it leaves the same way
        this.playerLobbies.set(oldSocketId, stale.lobby.id);
        return { oldSocketId, leaveResult: this.leaveLobby(oldSocketId) };
    }

    /**
     * The socket holding a human lobby seat dropped (a reload, a network
     * drop) or was replaced by a newer socket of the same player: the seat
     * stays for LOBBY_SEAT_GRACE_MS (`reconnectingIn` lists it: the lobby's
     * playerReadyUpdate / lobbyCreated carry the names, additive). Its ready flag resets (the others keep theirs, as
     * on a takeover) and the socket loses its mapping, so it can no longer
     * act on the seat. A re-entry from the player's next socket
     * (findStaleLobbySeat -> takeOverLobbySeat) takes it back in place;
     * otherwise it is removed exactly as a leave (expireLobbySeat) and
     * `onExpire(result)` lets the socket layer tell the others.
     * @returns {{lobby, player}|null} null when the socket holds no human seat
     */
    suspendLobbySeat(socketId, onExpire = null) {
        const lobbyId = this.playerLobbies.get(socketId);
        const lobby = lobbyId ? this.lobbies.get(lobbyId) : null;
        const player = lobby?.players.find(p => !p.isBot && p.socketId === socketId);
        if (!player) return null;
        player.ready = false;
        lobby.readyPlayers.delete(socketId);
        this.playerLobbies.delete(socketId);
        this._clearLobbyGrace(socketId);
        // Play again: a moved member still on its score screen (it has not
        // acted in the lobby) keeps its place as a hold, PLAY_AGAIN_HOLD_MS
        const afterGameHold = playAgain().holdOnDrop(lobby, socketId, player.username);
        if (afterGameHold) {
            this.lobbyGrace.set(socketId, afterGameHold);
            return { lobby, player };
        }
        const timer = safeTimeout(() => {
            let result;
            try {
                result = this.expireLobbySeat(lobbyId, socketId);
            } finally {
                // expireLobbySeat reads the entry; a throw must not leave it behind
                this.lobbyGrace.delete(socketId);
            }
            if (result && onExpire) onExpire(result);
        }, GameManager.LOBBY_SEAT_GRACE_MS, 'lobbySeatGrace');
        timer.unref?.();
        this.lobbyGrace.set(socketId, { lobbyId, username: player.username, timer });
        return { lobby, player };
    }

    /**
     * The grace of a suspended seat ran out: the seat leaves as with
     * leaveLobby (ready flags reset, a lobby with no human left is deleted).
     * @returns {{lobbyId, oldSocketId, username, leaveResult}|null}
     */
    expireLobbySeat(lobbyId, socketId) {
        const lobby = this.lobbies.get(lobbyId);
        const player = this.lobbyGrace.get(socketId)?.lobbyId === lobbyId
            ? lobby?.players.find(p => p.socketId === socketId) : null;
        if (!player) return null;
        this.playerLobbies.set(socketId, lobbyId);
        return { lobbyId, oldSocketId: socketId, username: player.username, leaveResult: this.leaveLobby(socketId) };
    }

    /**
     * The socket whose seat is held is live again as the same player (a
     * parked socket took the session back: sessionIdentity.clearSuperseded).
     * The re-entry machinery only moves a seat between DIFFERENT sockets
     * (findStaleLobbySeat skips this one), so the seat comes back in place:
     * mapping restored, grace over. Without this a later join pushed a
     * second seat for the same socket, and the grace expiry removed both.
     * @returns {{lobby, player}|null}
     */
    resumeHeldLobbySeat(socketId, username) {
        const held = this.lobbyGrace.get(socketId);
        if (!held || held.username !== username) return null;
        const lobby = this.lobbies.get(held.lobbyId);
        const player = lobby?.players.find(p => !p.isBot && p.socketId === socketId);
        if (!player || this.playerLobbies.has(socketId)) return null;
        this._clearLobbyGrace(socketId);
        this.playerLobbies.set(socketId, held.lobbyId);
        this.leaveMainRoom(socketId);
        this._reassignHost(lobby);
        return { lobby, player };
    }

    /**
     * Give up at once the seat held for this socket (it switches accounts:
     * sessionIdentity.releaseIdentity), as expireLobbySeat would after the
     * grace, timer cancelled.
     * @returns {{lobbyId, oldSocketId, username, leaveResult}|null}
     */
    releaseHeldLobbySeat(socketId) {
        const held = this.lobbyGrace.get(socketId);
        if (!held) return null;
        const result = this.expireLobbySeat(held.lobbyId, socketId);
        this._clearLobbyGrace(socketId);
        return result;
    }

    /** Usernames whose seat in `lobbyId` is held for its grace, in seat order. */
    reconnectingIn(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby || this.lobbyGrace.size === 0) return [];
        return lobby.players
            .filter(p => this.lobbyGrace.get(p.socketId)?.lobbyId === lobbyId)
            .map(p => p.username);
    }

    /** `{reconnecting: [...]}` for a lobby event while a seat is held, else {} (the wire as before). */
    reconnectingField(lobbyId) {
        // At most 4 names (the frozen schema; a lobby of more than 4 has
        // only capable members, who read members[].reconnecting)
        const names = this.reconnectingIn(lobbyId).slice(0, TABLE_SIZE);
        return names.length ? { reconnecting: names } : {};
    }

    _clearLobbyGrace(socketId) {
        const held = this.lobbyGrace.get(socketId);
        if (!held) return;
        clearTimeout(held.timer);
        this.lobbyGrace.delete(socketId);
    }

    // ==================== LOBBY METHODS ====================

    /**
     * Create an unnamed lobby holding `playerSocketIds` (no checks). Tests
     * and harnesses build lobbies with it; players open one with
     * createNamedLobby (the matchmaking queue that also used it is gone:
     * V1_REMOVALS #2).
     */
    createLobby(playerSocketIds) {
        const lobbyId = uuidv4();
        const players = playerSocketIds.map(socketId => {
            const user = this.getUserBySocketId(socketId);
            return {
                socketId,
                username: user?.username || 'Unknown',
                ready: false
            };
        });

        // No createdBy and no host: lobbyHost falls back to the first human
        const lobby = {
            id: lobbyId,
            players,
            readyPlayers: new Set(),
            messages: [],
            createdAt: Date.now(),
            settings: { spectatorsCanTalk: true },
            capable: new Set()
        };

        this.lobbies.set(lobbyId, lobby);

        // Map each player to this lobby
        playerSocketIds.forEach(socketId => {
            this.playerLobbies.set(socketId, lobbyId);
        });

        return lobby;
    }

    /**
     * Get lobby a player is in
     */
    getPlayerLobby(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        return lobbyId ? this.lobbies.get(lobbyId) : null;
    }

    /**
     * Get lobby by ID
     */
    getLobbyById(lobbyId) {
        return this.lobbies.get(lobbyId);
    }

    // ---------- family lobbies (owner 2026-11-16: up to 8 people) ----------

    _capableSet(lobby) {
        if (!(lobby.capable instanceof Set)) lobby.capable = new Set();
        return lobby.capable;
    }

    /**
     * How many people the lobby may hold: 8 while every human member is in
     * `lobby.capable` (announced casualSpectators when they entered), else
     * 4, so an older app never sees a lobby of more than 4. Bots count
     * toward either. `joinerCapable` (true / false) also counts a joiner.
     */
    lobbyCapacity(lobby, joinerCapable = null) {
        if (!lobby) return TABLE_SIZE;
        if (joinerCapable === false) return TABLE_SIZE;
        const caps = lobby.capable instanceof Set ? lobby.capable : new Set();
        const allCapable = lobby.players.every(p => p.isBot || caps.has(p.socketId));
        return allCapable ? WIDE_LOBBY : TABLE_SIZE;
    }

    /** Is lobby member `p` a seat held for its reconnect grace? */
    isHeldLobbySeat(lobby, p) {
        return !p.isBot && this.lobbyGrace.get(p.socketId)?.lobbyId === lobby.id;
    }

    /**
     * The lobby's host (a username): who created it, then whoever the role
     * passed to. A lobby built by createLobby (tests, harnesses) has none
     * and falls back to its first human member.
     */
    lobbyHost(lobby) {
        if (!lobby) return null;
        const humans = lobby.players.filter(p => !p.isBot);
        if (lobby.host != null && humans.some(p => p.username === lobby.host)) return lobby.host;
        return humans[0]?.username ?? null;
    }

    /**
     * Pass the host role on when its holder is no longer a member: to the
     * first connected human by join order (held seats skipped). A held host
     * stays host while held. With only held humans left, the first of them
     * holds it provisionally and the choice is made again on every
     * reconnect (takeOverLobbySeat / resumeHeldLobbySeat). The pattern of
     * TournamentState's creator hand-off.
     */
    _reassignHost(lobby) {
        if (!lobby) return;
        const humans = lobby.players.filter(p => !p.isBot);
        const stays = lobby.host != null && humans.some(p => p.username === lobby.host);
        if (stays && !lobby.hostProvisional) return;
        const connected = humans.filter(p => !this.isHeldLobbySeat(lobby, p));
        if (connected.length > 0) {
            lobby.host = connected[0].username;
            lobby.hostProvisional = false;
        } else if (humans.length > 0) {
            lobby.host = stays ? lobby.host : humans[0].username;
            lobby.hostProvisional = true;
        } else {
            lobby.host = null;
            lobby.hostProvisional = false;
        }
    }

    /**
     * The bots that play: a bot only fills a seat no human member can,
     * so the first min(bots, max(0, 4 - humans)) bots in join order. The
     * others sit out (never readied, released at the start). In a lobby of
     * 4 or fewer that is every bot.
     */
    tableBots(lobby) {
        const bots = lobby.players.filter(p => p.isBot);
        const humans = lobby.players.length - bots.length;
        return bots.slice(0, Math.max(0, TABLE_SIZE - humans));
    }

    /**
     * Who would sit at the table now: the table bots, then the humans in
     * the order they tapped Ready (readyPlayers is a Set: first-ready order)
     * who are still seated here and ready, at most 4 in all. In a lobby of
     * 4 or fewer, 4 entries means every member and every human ready.
     */
    lobbyTable(lobby) {
        const table = this.tableBots(lobby);
        for (const sid of lobby.readyPlayers) {
            if (table.length >= TABLE_SIZE) break;
            const p = lobby.players.find(x => x.socketId === sid && !x.isBot);
            if (p && p.ready && this.playerLobbies.get(sid) === lobby.id) table.push(p);
        }
        return table;
    }

    /**
     * The table is full and every seat on it is ready (its bots readied):
     * the lobby starts. For a lobby of 4 this is exactly the old
     * readyPlayers.size === 4.
     */
    lobbyTableReady(lobby) {
        const table = this.lobbyTable(lobby);
        return table.length === TABLE_SIZE && table.every(p => lobby.readyPlayers.has(p.socketId));
    }

    /**
     * A human readied: ready the bots that play. A lobby of exactly 4
     * readies all its bots (unchanged); a lobby of more readies its table
     * bots only once the table is full.
     */
    readyBotsAfterHumanReady(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return;
        if (lobby.players.length === TABLE_SIZE) {
            this.setBotsReady(lobbyId);
            return;
        }
        if (lobby.players.length > TABLE_SIZE && this.lobbyTable(lobby).length === TABLE_SIZE) {
            for (const bot of this.tableBots(lobby)) {
                bot.ready = true;
                lobby.readyPlayers.add(bot.socketId);
            }
        }
    }

    /**
     * A removal changed who sits at the table of a lobby of more than 4 (a
     * human leaving, an expired or evicted held seat, a sign-out, a removed
     * bot): tableBots can grow, and a bot that just came onto the table was
     * never readied (bots are readied only from a human's Ready or Add Bot).
     * Same rule as readyBotsAfterHumanReady: once the ready humans and the
     * table bots fill the table, the table bots are readied, so the lobby
     * starts instead of sitting with every human ready. A held seat is never
     * on the table (suspendLobbySeat unreadies and unmaps it).
     * @returns {boolean} true when a bot was readied (the caller sends the
     *   list and starts the lobby)
     */
    readyTableBotsIfFull(lobby) {
        if (!lobby || this.lobbyTable(lobby).length !== TABLE_SIZE) return false;
        let readied = false;
        for (const bot of this.tableBots(lobby)) {
            if (lobby.readyPlayers.has(bot.socketId)) continue;
            bot.ready = true;
            lobby.readyPlayers.add(bot.socketId);
            readied = true;
        }
        return readied;
    }

    /** One member as the frozen $defs.lobbyMember (the keys a lobby seat has always carried). */
    _memberWire(p) {
        const m = { socketId: p.socketId, username: p.username, ready: p.ready };
        if (p.isBot) m.isBot = true;
        return m;
    }

    /**
     * `players` for every lobby event: the first 4 members, as the shipped
     * clients read them (schema maxItems 4). A lobby of more than 4 has only
     * capable members, who read `members`.
     */
    lobbyPlayersWire(lobby) {
        return lobby.players.slice(0, TABLE_SIZE).map(p => this._memberWire(p));
    }

    /**
     * The additive keys of every lobby event (2026-11-16): `members` (all,
     * at most 8, with `playing` and `reconnecting`), `host`, `settings`,
     * `capacity`. `playing`: every member of a lobby of 4 or fewer; in a
     * bigger one, the members lobbyTable seats now (Playing / Will watch /
     * Sitting out).
     */
    lobbyExtrasWire(lobby) {
        const wide = lobby.players.length > TABLE_SIZE;
        const seated = new Set(this.lobbyTable(lobby).map(p => p.socketId));
        const members = lobby.players.map(p => {
            const m = { ...this._memberWire(p), playing: wide ? seated.has(p.socketId) : true };
            if (this.isHeldLobbySeat(lobby, p)) m.reconnecting = true;
            // Play again: a place held for someone not back from the last game
            if (this.lobbyGrace.get(p.socketId)?.kind === 'afterGame') m.returning = true;
            // Play again: back in the lobby but the app still shows the last
            // game's results (afterGame.unsettled: no lobbyReturnSeen nor
            // any act in the lobby yet). Only while mapped: a dropped one
            // is a hold (returning) or a reload-held seat (reconnecting)
            if (lobby.afterGame?.unsettled?.has(p.socketId) && this.playerLobbies.get(p.socketId) === lobby.id &&
                !this.lobbyGrace.has(p.socketId)) m.onResults = true;
            return m;
        });
        const out = { members };
        const host = this.lobbyHost(lobby);
        if (host != null) out.host = host;
        // Always on (owner 2026-11-18: no switch); kept on the wire for
        // shipped iOS 12-15 and cached web tabs
        out.settings = { spectatorsCanTalk: true };
        out.capacity = this.lobbyCapacity(lobby);
        // Play again: older-app players of the last game whose place is
        // saved (a reservation, no row)
        const expected = [...(lobby.afterGame?.reserved?.keys() || [])];
        if (expected.length > 0) out.expected = expected.slice(0, TABLE_SIZE);
        return out;
    }

    /**
     * A lobby event's payload for member socket `to`: lobbyId, players
     * (first 4), the event's own keys, reconnecting (first 4 held) when
     * `withReconnecting`, then the additive keys, only when `to` entered
     * with the casualSpectators cap (lobby.capable): a legacy member gets
     * exactly the old payload. Key order as before, new keys last.
     */
    lobbyWire(lobby, own = {}, { withReconnecting = true, to = null } = {}) {
        const wire = {
            lobbyId: lobby.id,
            players: this.lobbyPlayersWire(lobby),
            ...own,
            ...(withReconnecting ? this.reconnectingField(lobby.id) : {})
        };
        return to != null && lobby.capable instanceof Set && lobby.capable.has(to)
            ? { ...wire, ...this.lobbyExtrasWire(lobby) }
            : wire;
    }

    /**
     * The game a started lobby became, for one of its extras re-sending
     * joinLobby (a reload during the start): its gameId while the game is
     * live and `username` was an extra, else null. A table member (an
     * entrant) is never redirected: it gets 'Lobby not found' as before.
     */
    startedLobbyRedirect(lobbyId, username) {
        const rec = this.startedLobbies.get(lobbyId);
        if (!rec || !rec.extras.has(username)) return null;
        const game = this.games.get(rec.gameId);
        return game && !game.isTerminal() ? rec.gameId : null;
    }

    /**
     * Mark player as ready in lobby
     * Returns { allReady, lobby } if successful
     */
    setPlayerReady(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // A lobby of more than 4 whose table is already full: this member
        // watches the game (never in a lobby of 4 or fewer: the table can
        // only be full with every member in it)
        if (!lobby.readyPlayers.has(socketId)) {
            const table = this.lobbyTable(lobby);
            if (table.length >= TABLE_SIZE && !table.some(p => p.socketId === socketId)) {
                return { success: false, error: TABLE_FULL, tableFull: true, lobby };
            }
        }

        // Mark player as ready
        lobby.readyPlayers.add(socketId);
        const player = lobby.players.find(p => p.socketId === socketId);
        if (player) player.ready = true;

        // Check if the table is ready (a lobby of 4: all 4 ready)
        const allReady = this.lobbyTableReady(lobby);

        return { success: true, allReady, lobby };
    }

    /**
     * Unset player ready status in their current lobby
     */
    unsetPlayerReady(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Mark player as not ready
        lobby.readyPlayers.delete(socketId);
        const player = lobby.players.find(p => p.socketId === socketId);
        if (player) player.ready = false;

        return { success: true, lobby };
    }

    /**
     * Add chat message to lobby
     */
    addLobbyMessage(socketId, message) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        const user = this.getUserBySocketId(socketId);
        const chatMessage = {
            username: user?.username || 'Unknown',
            message,
            timestamp: Date.now()
        };

        lobby.messages.push(chatMessage);
        if (lobby.messages.length > GameManager.MAX_LOBBY_MESSAGES) {
            lobby.messages.splice(0, lobby.messages.length - GameManager.MAX_LOBBY_MESSAGES);
        }

        return { success: true, lobby, chatMessage };
    }

    /**
     * Handle player leaving lobby
     * Returns remaining players or null if lobby should be dissolved
     */
    leaveLobby(socketId, { keepReady = false } = {}) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // A lobby open to 8 never resets the others' ready flags on a leave
        // (the first 4 to tap Ready keep their seats); a lobby of 4 does
        const wide = this.lobbyCapacity(lobby) > TABLE_SIZE;
        // Nor does a play-again hold going (expiry, "Don't wait", sign-out,
        // eviction): that person was never ready, and a reset would put
        // iOS's local isReady out of step (removeBotFromLobby, 2026-11-13)
        const keep = keepReady || this.lobbyGrace.get(socketId)?.kind === 'afterGame';

        // Remove player from lobby
        lobby.players = lobby.players.filter(p => p.socketId !== socketId);
        lobby.readyPlayers.delete(socketId);
        lobby.capable?.delete(socketId);
        // (play again: a socket that left is no longer on the results here,
        // also if it joins this lobby again later)
        lobby.afterGame?.unsettled?.delete(socketId);
        this.playerLobbies.delete(socketId);
        this._clearLobbyGrace(socketId);

        // If lobby is now empty, or only bots remain, delete it
        const onlyBotsRemain = lobby.players.length > 0 &&
            lobby.players.every(p => p.socketId?.startsWith('bot:'));

        if (lobby.players.length === 0 || onlyBotsRemain) {
            // Clean up bot player-lobby mappings
            if (onlyBotsRemain) {
                for (const bot of lobby.players) {
                    this.playerLobbies.delete(bot.socketId);
                }
            }
            // Play again: reservations, holds and lingering calls go with it
            playAgain().onLobbyGone(lobby);
            this.lobbies.delete(lobbyId);
            return {
                success: true,
                lobby: null,
                lobbyDeleted: true,
                playerLeft: socketId
            };
        }

        // Reset all ready states when someone leaves
        if (!wide && !keep) {
            lobby.readyPlayers.clear();
            lobby.players.forEach(p => p.ready = false);
        }
        this._reassignHost(lobby);
        // A lobby of more than 4: a bot the leave brought onto the table is
        // readied when the table is now full (the caller starts the lobby)
        const botsReadied = wide && this.readyTableBotsIfFull(lobby);

        return {
            success: true,
            lobby,
            playerLeft: socketId,
            needsMorePlayers: lobby.players.length < 4,
            ...(botsReadied ? { botsReadied: true } : {})
        };
    }

    /**
     * Convert lobby to game when all players are ready
     */
    startGameFromLobby(lobbyId, io = null) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Re-validate the table (a seat that unreadied, left or dropped
        // during LOBBY_START_MS stops the start; the next Ready takes it)
        if (!this.lobbyTableReady(lobby)) {
            return { success: false, error: 'Not all players ready' };
        }
        const table = this.lobbyTable(lobby);
        // A seat whose account a merge is retiring right now never starts
        // (the merge signs it out, which empties the seat)
        if (table.some(p => !p.isBot && this.isMergeLocked(p.username))) {
            return { success: false, error: MERGE_LOCKED };
        }

        // The table's sockets (only they become entrants), and the extras:
        // human members who did not get a seat and have a live socket. A
        // held seat off the table becomes nothing (its grace timer no-ops
        // once the lobby is gone); the bots sitting out were never
        // registered with the bot controller (lobby bots are only at start)
        // In lobby (join) order, as before: a lobby of 4 starts exactly as
        // it always did (entrant order, draw, golden wire)
        const onTable = new Set(table.map(p => p.socketId));
        const playerSocketIds = lobby.players.filter(p => onTable.has(p.socketId)).map(p => p.socketId);
        // Play again: a member moved back at the last game's end whose
        // client still shows that game's results (afterGame.unsettled: it
        // has not entered the lobby yet, c2s lobbyReturnSeen, nor acted in
        // it) never becomes an extra. A spectatorJoined would replace the
        // results it is reading (owner 2026-11-16: they stay until the
        // person taps Return to Lobby); it is told leftLobby instead
        // (lobbyHandlers.startLobbyIfAllReady), so its Return goes to the
        // main room, where the new game is listed
        const unsettled = lobby.afterGame?.unsettled || new Set();
        const offTable = lobby.players
            .filter(p => !p.isBot && !onTable.has(p.socketId) && this.playerLobbies.get(p.socketId) === lobbyId &&
                (!io || io.sockets?.sockets?.has(p.socketId)))
            .map(p => ({ socketId: p.socketId, username: p.username }));
        const extras = offTable.filter(p => !unsettled.has(p.socketId));
        const onResults = offTable.filter(p => unsettled.has(p.socketId));

        // Play again: what the lobby was, for its return when the game
        // ends (never on the wire); then its own after-game state ends
        // (lingering calls, reservations, holds off the table)
        const lobbyOrigin = playAgain().originOf(lobby, io, extras.map(e => e.username), onTable);
        playAgain().onLobbyStart(lobby);

        // Remove lobby mappings (every member)
        for (const p of lobby.players) {
            if (this.playerLobbies.get(p.socketId) === lobbyId) this.playerLobbies.delete(p.socketId);
        }
        this.lobbies.delete(lobbyId);

        // Create the actual game
        const game = this.createGame(playerSocketIds);
        game.lobbyOrigin = lobbyOrigin;

        // A casual game's voice room (players + spectators; never a
        // tournament table or the ambient demo: they never come through here)
        gameVoice().initCasualVoice(game, {
            host: this.lobbyHost(lobby),
            io,
            lobbyExtras: extras.map(e => e.username)
        });
        if (extras.length > 0) {
            this.startedLobbies.set(lobbyId, { gameId: game.gameId, extras: new Set(extras.map(e => e.username)) });
        }

        return { success: true, game, players: playerSocketIds, extras, onResults, lobby };
    }

    // ==================== BOT METHODS ====================

    /**
     * Check if a socketId belongs to a bot
     * @param {string} socketId
     * @returns {boolean}
     */
    isBot(socketId) {
        return BotPlayer.isBot(socketId);
    }

    /**
     * Add a bot to a lobby
     * @param {string} lobbyId - Lobby to add bot to
     * @param {string} botName - Bot username (default: "Mary")
     * @returns {Object} - { success, botPlayer, lobby, error? }
     */
    addBotToLobby(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) {
            return { success: false, error: 'Lobby not found' };
        }

        // (a place saved for the last game's player counts: play again)
        if (lobby.players.length >= 4 || playAgain().reservationBlocks(lobby)) {
            return { success: false, error: 'Lobby is full' };
        }

        // Pick a random personality not already in this lobby. It stays
        // server-side (lobby.botPersonalities, by bot socket id): the lobby
        // shows "🤖 Bot" and lobby payloads never carry it (V1_REMOVALS #16)
        if (!lobby.botPersonalities) lobby.botPersonalities = new Map();
        const usedPersonalities = lobby.players
            .filter(p => p.isBot)
            .map(p => lobby.botPersonalities.get(p.socketId))
            .filter(Boolean);
        const available = PERSONALITY_LIST.filter(p => !usedPersonalities.includes(p));
        const personality = available[Math.floor(Math.random() * available.length)];

        // Generic lobby name (hidden until game starts): the lowest free
        // number, so removing "Bot" and adding again never gives two "Bot 2"
        const botLobbyName = (n) => (n > 1 ? `🤖 Bot ${n}` : '🤖 Bot');
        const takenNames = new Set(lobby.players.filter(p => p.isBot).map(p => p.username));
        let botNumber = 1;
        while (takenNames.has(botLobbyName(botNumber))) botNumber++;
        const lobbyName = botLobbyName(botNumber);

        // Create bot with generic lobby name
        const bot = botController.createBot(lobbyName, personality);

        // Add bot to lobby as a player (personality kept for the name
        // reveal at game start: lobbyBotPersonality)
        const botPlayer = {
            socketId: bot.socketId,
            username: bot.username,
            ready: false,
            isBot: true
        };
        lobby.botPersonalities.set(bot.socketId, personality);

        lobby.players.push(botPlayer);
        // Don't add to playerLobbies since bots don't have real sockets

        return { success: true, botPlayer, lobby, bot };
    }

    /** The personality of a lobby bot (server-side only; 'mary' if unknown). */
    lobbyBotPersonality(lobby, botSocketId) {
        return lobby?.botPersonalities?.get(botSocketId) || 'mary';
    }

    /**
     * Remove a bot from a lobby
     * @param {string} lobbyId - Lobby ID
     * @param {string} botSocketId - Bot's socket ID
     * @returns {Object} - { success, lobby, error? }
     */
    removeBotFromLobby(lobbyId, botSocketId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) {
            return { success: false, error: 'Lobby not found' };
        }

        // Bots only: a lobby payload lists every member's socket id
        const botIndex = lobby.players.findIndex(p => p.socketId === botSocketId && p.isBot);
        if (botIndex === -1) {
            return { success: false, error: 'Bot not found in lobby' };
        }

        // Remove bot
        lobby.players.splice(botIndex, 1);
        lobby.readyPlayers.delete(botSocketId);
        lobby.botPersonalities?.delete(botSocketId);

        // The lobby is no longer full: the remaining bots wait again (they
        // are readied when it fills up with every human ready). The humans
        // keep their ready flags: iOS (1.1.0 / 1.2.0) keeps its own
        // isReady and never reads it back from the list, so resetting them
        // here left an iOS player showing "Unready" while the server had
        // them unready, and Ready, remove a bot, add a bot sat at a full
        // lobby until they unreadied and readied again (2026-11-13)
        for (const p of lobby.players) {
            if (p.isBot) {
                p.ready = false;
                lobby.readyPlayers.delete(p.socketId);
            }
        }
        // A lobby of more than 4 whose table is still full (another bot took
        // the removed one's place): its table bots are ready again, as the
        // ready path would have them (the caller starts the lobby). A lobby
        // of 4 or fewer has at most 3 members now: nothing to ready.
        const botsReadied = this.readyTableBotsIfFull(lobby);

        return { success: true, lobby, ...(botsReadied ? { botsReadied: true } : {}) };
    }

    /**
     * Set all bots in a lobby as ready
     * @param {string} lobbyId - Lobby ID
     */
    setBotsReady(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return;

        for (const player of lobby.players) {
            if (player.isBot && !player.ready) {
                player.ready = true;
                lobby.readyPlayers.add(player.socketId);
            }
        }
    }

    /**
     * A lobby that just filled up with bots while its humans were already
     * ready (Ready, then Add Bot until 4: owner report 2026-11-13, the bots
     * sat unready until a human unreadied and readied again). When the lobby
     * has 4 players and every human in it is ready, its bots are readied as
     * a human's playerReady would. A seat held for its reconnect grace is
     * never ready (suspendLobbySeat resets it), so a held seat blocks this,
     * as it blocks the start on the ready path.
     * @returns {boolean} true when every seat is now ready
     */
    readyBotsIfHumansReady(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby || lobby.players.length !== 4) return false;
        const humans = lobby.players.filter(p => !p.isBot);
        if (!humans.every(p => p.ready && lobby.readyPlayers.has(p.socketId))) return false;
        if (this.reconnectingIn(lobbyId).length > 0) return false;
        this.setBotsReady(lobbyId);
        return lobby.readyPlayers.size === 4;
    }

    // ==================== END BOT METHODS ====================

    // ==================== END LOBBY METHODS ====================

    /**
     * Create new game with players
     */
    createGame(playerSocketIds) {
        const gameId = uuidv4();
        const game = new GameState(gameId);

        playerSocketIds.forEach((socketId) => {
            this.playerGames.set(socketId, gameId);
        });

        // Pre-seating participants, with usernames captured now (a socket
        // that drops before seating is no longer resolvable later)
        game.initEntrants(playerSocketIds.map((socketId) => {
            const isBot = this.isBot(socketId);
            return {
                socketId,
                isBot,
                username: isBot ? null : (this.getUserBySocketId(socketId)?.username ?? null)
            };
        }));

        this.games.set(gameId, game);
        // Saved while it runs once it is dealt (LIVE_PERSIST write; no-op off)
        liveStore().track(game);

        return game;
    }

    /**
     * Get game by ID
     */
    getGame(gameId) {
        return this.games.get(gameId);
    }

    /**
     * Get game that player is in
     */
    getPlayerGame(socketId) {
        const gameId = this.playerGames.get(socketId);
        return gameId ? this.games.get(gameId) : null;
    }

    /**
     * Get game ID for a player
     */
    getPlayerGameId(socketId) {
        return this.playerGames.get(socketId);
    }

    /**
     * Update player-game mapping when a player reconnects with new socket
     * @param {string} oldSocketId - Previous socket ID
     * @param {string} newSocketId - New socket ID
     * @param {string} gameId - Game ID
     */
    updatePlayerGameMapping(oldSocketId, newSocketId, gameId) {
        this.playerGames.delete(oldSocketId);
        this.playerGames.set(newSocketId, gameId);
    }

    /**
     * Make `socketId` a pure spectator of `game`: it first stops spectating
     * any other game, then joins this game's room. Refused (false) for a
     * socket mapped to a game (an entrant, a seat owner or a bot).
     * @returns {boolean}
     */
    addSpectator(io, game, socketId, username, pic = null) {
        if (this.playerGames.has(socketId)) return false;
        const current = this.spectatorGames.get(socketId);
        if (current && current !== game.gameId) this.leaveSpectating(io, socketId);
        game.addSpectator(socketId, username, pic);
        if (io) game.joinToRoom(io, socketId);
        this.spectatorGames.set(socketId, game.gameId);
        // the table's spectator list (spectatorsUpdated) and its picture
        spectatorRoster.spectatorsChanged(io, game);
        if (pic == null && io) spectatorRoster.lookupPic(io, game, socketId, username);
        return true;
    }

    /**
     * Stop `socketId` spectating its game (spectator entry, spectatorGames
     * entry and — with io — the room).
     * @returns {GameState|null} the game it was spectating
     */
    leaveSpectating(io, socketId) {
        const gameId = this.spectatorGames.get(socketId);
        if (gameId === undefined) return null;
        this.spectatorGames.delete(socketId);
        const game = this.games.get(gameId) || null;
        if (game) {
            // Out of the game's voice room too: its voice peers get a private
            // voicePeerLeft (without io: the io the voice room last saw)
            gameVoice().removeVoiceSpectator(io, game, socketId);
            game.removeSpectator(socketId);
            if (io) game.leaveRoom(io, socketId);
            // (without io: the io the game's list was last scheduled with)
            spectatorRoster.spectatorsChanged(io, game);
        }
        return game;
    }

    /**
     * Find game by ID (for reconnection)
     * @param {string} gameId - Game ID to find
     * @returns {GameState|null}
     */
    getGameById(gameId) {
        return this.games.get(gameId) || null;
    }

    /**
     * Socket-level disconnect bookkeeping: main room, lobby, tournament and
     * spectating. Seat state is not touched here: the caller
     * (queueHandlers.handleDisconnect) routes an in-game socket to its
     * entrant / seat-owner transition.
     */
    handleDisconnect(socketId, { lobbyGrace = false, onLobbyGraceExpire = null } = {}) {
        // Remove from main room (if in main room)
        const wasInMainRoom = this.mainRoomSocketIds.has(socketId);
        this.leaveMainRoom(socketId);

        // A lobby seat: held for its grace (a transport disconnect), else
        // left at once (a sign-out, an account switch)
        const lobbySuspended = lobbyGrace ? this.suspendLobbySeat(socketId, onLobbyGraceExpire) : null;
        const lobbyResult = lobbySuspended ? { success: false } : this.leaveLobby(socketId);
        const wasInLobby = lobbyResult.success;

        // A pure spectator watches at most one game
        const spectatorGame = this.leaveSpectating(null, socketId);

        // Mark disconnected in tournament (keeps membership/scores so the
        // player can reattach with a new socket)
        let wasInTournament = false;
        let tournamentResult = null;
        const tournamentId = this.playerTournaments.get(socketId);
        if (tournamentId) {
            const tournament = this.tournaments.get(tournamentId);
            if (tournament) {
                tournamentResult = this.handleTournamentDisconnect(socketId, tournament);
                wasInTournament = true;
            }
        }

        const gameId = this.playerGames.get(socketId);
        if (gameId) {
            return {
                wasInLobby,
                wasInMainRoom,
                wasInGame: true,
                wasInTournament,
                tournamentResult,
                lobbySuspended,
                game: this.games.get(gameId) || null,
                gameId,
                spectatorGame,
                // The seat keeps its grace period: never an immediate abort
                shouldAbort: false
            };
        }

        // Handle tournament spectator disconnect
        for (const [, tournament] of this.tournaments) {
            if (tournament.isSpectator(socketId)) {
                tournament.removeSpectator(socketId);
                break;
            }
        }

        // Only remove from currentUsers if not in a game
        this.currentUsers = this.currentUsers.filter(u => u.socketId !== socketId);

        return {
            wasInLobby, wasInMainRoom, wasInGame: false,
            wasInTournament, tournamentResult,
            lobby: lobbyResult.lobby,
            ...(lobbyResult.botsReadied ? { lobbyBotsReadied: true } : {}),
            lobbySuspended,
            spectatorGame
        };
    }

    /**
     * Release everything the server holds for a (terminal) game: bots and
     * their timers, the socket room, every playerGames entry pointing at it
     * (seats, pending draw-phase sockets, bots, resign bots, lazy shadows and
     * spectator-/active mappings) and the spectator list.
     * @param {GameState} game
     * @param {Object|null} io - when given, sockets also leave the game room
     */
    _retire(game, io) {
        const id = game.gameId;

        // Release bots and cancel their pending timers — otherwise the bot
        // registry leaks and stale timers fire into the dead game
        botController.cleanupGame(id);

        const mapped = [];
        for (const [sid, gid] of this.playerGames) {
            if (gid === id) mapped.push(sid);
        }

        if (io) {
            const ids = new Set([...game.players.keys(), ...game.spectators.keys(), ...mapped]);
            for (const sid of ids) {
                if (this.isBot(sid)) continue;
                io.sockets.sockets.get(sid)?.leave(game.roomName);
            }
        }

        // Backstop for currentUsers: drop every entry of a dead socket that
        // belonged to this game (a live socket, e.g. an owner who watched
        // to the end, keeps its entry)
        if (io) {
            const ids = new Set([...game.players.keys(), ...game.spectators.keys(), ...mapped]);
            for (const s of game.seatList()) {
                if (s.ownerSocketId) ids.add(s.ownerSocketId);
            }
            if (game.entrants) for (const sid of game.entrants.keys()) ids.add(sid);
            this.currentUsers = this.currentUsers.filter(u => !ids.has(u.socketId) || io.sockets.sockets.has(u.socketId));
        }

        for (const sid of mapped) this.playerGames.delete(sid);
        for (const [sid, gid] of this.spectatorGames) {
            if (gid === id) this.spectatorGames.delete(sid);
        }
        game.spectators.clear();
        game.shoulders.clear();
        // Socket-keyed voice state and the started-lobby redirect (both end
        // and abort come through here)
        gameVoice().retire(game);
        for (const [lobbyId, rec] of this.startedLobbies) {
            if (rec.gameId === id) this.startedLobbies.delete(lobbyId);
        }
        this.games.delete(id);
        // No more live writes; the terminal claim (gameEnd / abortGame) ends its doc
        liveStore().remove(game);
    }

    /**
     * End and cleanup a game. A live game is terminated first (ENDED when
     * legal, otherwise ABORTED).
     * @param {string} gameId
     * @param {Object|null} [io]
     */
    endGame(gameId, io = null) {
        const game = this.games.get(gameId);
        if (!game) return;

        if (!game.isTerminal()) {
            game.terminate(null, game.canTransition(Phase.ENDED) ? Phase.ENDED : Phase.ABORTED);
        }
        this._retire(game, io);
    }

    /**
     * Abort a game: terminate it (no broadcast — see socket/gameLifecycle
     * abortGame for the client-facing path) and retire it.
     * @param {string} gameId
     * @param {Object|null} [io]
     * @returns {string[]} the seat socket ids ([] before seats exist)
     */
    abortGame(gameId, io = null) {
        const game = this.games.get(gameId);
        if (!game) return [];

        const socketIds = game.getSocketIds();
        if (!game.isTerminal()) {
            game.terminate(null, Phase.ABORTED);
        }
        this._retire(game, io);

        return socketIds;
    }

    /**
     * `getGameById` for a request from `username` naming a game by id
     * (joinAsSpectator, spectateTournamentGame, rejoinGame): the ambient demo
     * game is null, exactly like an unknown or ended game, for anyone outside
     * the AMBIENT_CHAT_USERS audience (no hint that it exists).
     * @returns {GameState|null}
     */
    getGameVisibleTo(gameId, username) {
        const game = this.getGameById(gameId);
        if (game && game.isDemo && !seesAmbientGame(username)) return null;
        return game;
    }

    /**
     * Get list of in-progress games for spectating, as `viewer` (a username)
     * sees it: the ambient demo game (game.isDemo, server/demo/ambientBots.js)
     * is listed only for the AMBIENT_CHAT_USERS audience (owner, 2026-11-14;
     * server/utils/ambientChatUsers.js seesAmbientGame; with `*` for anyone,
     * a missing viewer included). `includeDemo` overrides the audience check
     * (gameLifecycle.emitLobbiesUpdated builds both lists with it).
     * @param {string} [viewer]
     * @param {{includeDemo?: boolean}} [opts]
     * @returns {Array} - Array of { gameId, players, currentHand, score, spectatorCount }
     */
    getInProgressGames(viewer, { includeDemo } = {}) {
        const showDemo = includeDemo ?? seesAmbientGame(viewer);
        const games = [];
        for (const [gameId, game] of this.games) {
            if (game.phase === 'waiting' || game.phase === 'drawing') continue;
            if (this.tournamentGames.has(gameId)) continue;
            if (game.isDemo && !showDemo) continue;

            const players = [];
            for (let pos = 1; pos <= 4; pos++) {
                const player = game.getPlayerByPosition(pos);
                if (player) {
                    players.push({ position: pos, username: player.username });
                }
            }

            games.push({
                gameId,
                players,
                currentHand: game.currentHand,
                score: game.score,
                spectatorCount: game.getSpectators().length
            });
        }
        return games;
    }

    /**
     * What a deploy would interrupt, for GET /health (routes/health.js):
     * counts only. `games`: live games with at least one human behind a
     * seat (any seat `ownerUsername`, lazy/resigned/left owners included)
     * or, before seating, a human entrant; the ambient demo and other
     * bot-only tables are left out. `tournaments`: not yet complete
     * (a finished one lingering for its results window is left out).
     * `lobbies`: every open lobby.
     * @returns {{games: number, tournaments: number, lobbies: number}}
     */
    getHealthCounts() {
        let games = 0;
        for (const game of this.games.values()) {
            if (game.isDemo || game.isTerminal?.()) continue;
            const seated = (game.seatList?.() || []).some(s => s.ownerUsername);
            const entrant = game.entrants
                ? [...game.entrants.values()].some(e => !e.isBot)
                : false;
            if (seated || entrant) games++;
        }
        let tournaments = 0;
        for (const t of this.tournaments.values()) {
            if (t.phase !== 'complete') tournaments++;
        }
        return { games, tournaments, lobbies: this.lobbies.size };
    }

    // ==================== ACTIVE GAME TRACKING ====================

    /**
     * Set active game for a user in the database
     * Called when a game starts
     */
    async setActiveGame(username, gameId) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return;

            await usersCollection.updateOne(
                { username },
                { $set: { activeGameId: gameId, activeGameStartedAt: new Date() } }
            );
        } catch (error) {
            console.error('Failed to set active game:', error);
        }
    }

    /**
     * Clear active game for a user in the database
     * Called when a game ends or is aborted
     * @param {string} username
     * @param {string} [gameId] - only clear if the user's activeGameId is
     *   still this game (they may have moved on to another one since)
     */
    async clearActiveGame(username, gameId) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return;

            const filter = gameId ? { username, activeGameId: gameId } : { username };
            await usersCollection.updateOne(
                filter,
                { $unset: { activeGameId: '', activeGameStartedAt: '' } }
            );
        } catch (error) {
            console.error('Failed to clear active game:', error);
        }
    }

    /**
     * Clear active game for all players in a game
     * @param {string} gameId
     * @param {GameState} [game] - pass it when the game was already retired
     *   from the map (end/abort teardown runs the DB clears afterwards)
     */
    async clearActiveGameForAll(gameId, game = this.games.get(gameId)) {
        if (!game) return;

        // The human behind every owned seat (human, lazy, resigned or gone);
        // native bots have no user document. Scoped to this game: a leaver
        // may already be in another game.
        const usernames = new Set();
        for (const seat of game.seatList()) {
            if (seat.ownerUsername) usernames.add(seat.ownerUsername);
        }
        // Before seating (a tournament table aborted in its countdown) the
        // humans are still entrants; the tournament start already wrote
        // their activeGameId
        if (game.entrants) {
            for (const e of game.entrants.values()) {
                if (!e.isBot && e.username) usernames.add(e.username);
            }
        }
        // In parallel (one round trip); each clear swallows its own error
        await Promise.all([...usernames].map(u => this.clearActiveGame(u, gameId)));
    }

    // ==================== TOURNAMENT METHODS ====================

    /**
     * Create a new tournament
     */
    createTournament(socketId, name) {
        const user = this.getUserBySocketId(socketId);
        if (!user) return { success: false, error: 'User not found' };
        if (this.isMergeLocked(user.username)) return { success: false, error: MERGE_LOCKED };

        // A finished tournament lingering for its results window must not
        // block new ones
        this.releaseCompletedTournamentMembership(socketId);

        // One membership per socket: a lobby seat, a game or a tournament
        const activity = this.activityOf(socketId);
        if (activity || this.playerTournaments.has(socketId)) {
            return { success: false, error: activity ? this.membershipError(activity) : 'Already in a tournament' };
        }
        // One tournament per user: a membership an older socket of theirs
        // still holds (half-open reconnect, a parked tab)
        const stale = this.giveUpStaleTournament(user.username, socketId);
        if (stale.refused) return { success: false, error: 'Already in a tournament' };
        // Nor a lobby seat: one an older socket still holds is given up
        const evictedLobby = this.evictStaleLobbySeat(user.username, socketId);

        const tournamentId = uuidv4();
        const tournament = new TournamentState(tournamentId, name, socketId, user.username);
        tournament.addPlayer(socketId, user.username, null);

        this.tournaments.set(tournamentId, tournament);
        this.playerTournaments.set(socketId, tournamentId);
        // Saved from creation on, the lobby included (LIVE_PERSIST write; no-op off)
        liveStore().trackTournament(tournament);

        // Leave main room
        this.leaveMainRoom(socketId);
        // A place reserved for them after a game is given up (play again)
        playAgain().dropReservations(user.username);

        return { success: true, tournament, evicted: stale.evicted, evictedLobby };
    }

    /**
     * Join an existing tournament
     */
    joinTournament(socketId, tournamentId) {
        const user = this.getUserBySocketId(socketId);
        if (!user) return { success: false, error: 'User not found' };
        if (this.isMergeLocked(user.username)) return { success: false, error: MERGE_LOCKED };

        // A finished tournament lingering for its results window must not
        // block joining a new one (unless they're rejoining that same one)
        if (this.playerTournaments.get(socketId) !== tournamentId) {
            this.releaseCompletedTournamentMembership(socketId);
        }

        if (this.playerTournaments.has(socketId)) {
            return { success: false, error: 'Already in a tournament' };
        }
        // Nor from a lobby seat or another game (a member back at this
        // tournament's own table still reattaches)
        const activity = this.activityOf(socketId);
        if (activity && !(activity.kind === 'game' && this.tournamentGames.get(activity.id) === tournamentId)) {
            return { success: false, error: this.membershipError(activity) };
        }

        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return { success: false, error: 'Tournament not found' };

        // Returning member (e.g. reconnecting with a new socket): reattach in
        // any phase so a dropped connection doesn't forfeit the tournament.
        const reattach = tournament.reattachPlayerByUsername(user.username, socketId);
        if (reattach) {
            if (reattach.oldSocketId !== socketId) {
                this.playerTournaments.delete(reattach.oldSocketId);
            }
            this.playerTournaments.set(socketId, tournamentId);
            this.leaveMainRoom(socketId);
            return { success: true, tournament, reattached: true };
        }

        // New entrants can only join before the tournament starts — joining
        // mid-tournament would let anyone block the next round by never
        // readying, and their scoreboard would be missing earlier rounds.
        if (tournament.phase !== 'lobby') {
            return { success: false, error: 'Tournament is not accepting players' };
        }
        // One tournament per user (another one an older socket still holds)
        const stale = this.giveUpStaleTournament(user.username, socketId);
        if (stale.refused) return { success: false, error: 'Already in a tournament' };
        // Nor a lobby seat (an older socket's) alongside it
        const evictedLobby = this.evictStaleLobbySeat(user.username, socketId);

        tournament.addPlayer(socketId, user.username, null);
        this.playerTournaments.set(socketId, tournamentId);

        // Leave main room
        this.leaveMainRoom(socketId);
        // A place reserved for them after a game is given up (play again)
        playAgain().dropReservations(user.username);

        return { success: true, tournament, evicted: stale.evicted, evictedLobby };
    }

    /**
     * A live tournament `username` belongs to from a socket other than
     * `socketId` (the same tournament reattaches by username in
     * joinTournament; this is for creating or joining ANOTHER one).
     * @returns {{tournament, oldSocketId}|null}
     */
    findStaleTournamentMembership(username, socketId) {
        if (!username) return null;
        for (const tournament of this.tournaments.values()) {
            if (tournament.phase === 'complete') continue;
            for (const [sid, player] of tournament.players) {
                if (player.username === username && sid !== socketId) return { tournament, oldSocketId: sid };
            }
        }
        return null;
    }

    /**
     * Before `socketId` creates or joins another tournament or a lobby: a membership
     * the user holds from an older socket is given up as a leave while that
     * tournament is still in its lobby (as a lobby seat is,
     * evictStaleLobbySeat); once it has begun, the new one is refused (the
     * player belongs at that table: sign-in and restore route them back).
     * @returns {{refused: boolean, evicted: ({oldSocketId, tournament, leaveResult}|null)}}
     */
    giveUpStaleTournament(username, socketId) {
        const stale = this.findStaleTournamentMembership(username, socketId);
        if (!stale) return { refused: false, evicted: null };
        if (stale.tournament.phase !== 'lobby') return { refused: true, evicted: null };
        this.playerTournaments.set(stale.oldSocketId, stale.tournament.tournamentId);
        // A lobby-phase removal clears the pointer, scoped (LIVE_PERSIST=on:
        // the handoff writes lobby members' pointers; the plan's 2.6)
        if (persistOn()) this.clearActiveTournament(username, stale.tournament.tournamentId);
        return {
            refused: false,
            evicted: { oldSocketId: stale.oldSocketId, tournament: stale.tournament, leaveResult: this.leaveTournament(stale.oldSocketId) },
        };
    }

    /**
     * Remove player from tournament
     * @returns {{ success: boolean, tournament?: TournamentState, deleted?: boolean, newCreator?: Object }}
     */
    leaveTournament(socketId) {
        const tournamentId = this.playerTournaments.get(socketId);
        if (!tournamentId) return { success: false, error: 'Not in a tournament' };

        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) {
            this.playerTournaments.delete(socketId);
            return { success: false, error: 'Tournament not found' };
        }

        const wasCreator = tournament.createdBy === socketId;
        tournament.removePlayer(socketId);
        this.playerTournaments.delete(socketId);

        // Delete when empty — or when only disconnected ghosts remain, so a
        // tournament can't sit in everyone's lobby list forever. The last
        // member leaving mid-start can leave tables behind (bots plus
        // departed entrants): the caller aborts these orphans.
        const live = this.getTournamentLiveGames(tournamentId);
        if (this.deleteTournamentIfAbandoned(tournament)) {
            return { success: true, deleted: true, tournament, orphanedGames: live };
        }

        // Transfer creator if needed
        let newCreator = null;
        if (wasCreator) {
            newCreator = tournament.transferCreator();
        }

        return { success: true, tournament, newCreator };
    }

    /**
     * Delete a tournament that has nobody left to play it: no players at all,
     * or only disconnected ghosts with no round game still running (running
     * games carry their own 60s reconnect grace).
     * @returns {boolean} - true if deleted
     */
    deleteTournamentIfAbandoned(tournament) {
        const round = tournament.getCurrentRound();
        const hasRunningGames = round && round.completedGames.size < round.games.size;
        // A restored tournament's ghosts count as present while its restored
        // abandon holds it (deploy survival PR 6; never set otherwise)
        const held = tournament.restored ? require('./persist/restoreTournament').restoreHolds(tournament) : false;
        if (tournament.players.size === 0 ||
            (tournament.getConnectedPlayerCount() === 0 && !hasRunningGames && !held)) {
            this.deleteTournament(tournament.tournamentId);
            return true;
        }
        return false;
    }

    /**
     * Drop a socket's membership in a tournament that is already complete (or
     * gone). Completed tournaments linger briefly so players can view results;
     * that lingering membership must not block creating/joining new ones.
     */
    releaseCompletedTournamentMembership(socketId) {
        const tournamentId = this.playerTournaments.get(socketId);
        if (!tournamentId) return;

        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) {
            this.playerTournaments.delete(socketId);
            return;
        }
        if (tournament.phase === 'complete') {
            tournament.removePlayer(socketId);
            this.playerTournaments.delete(socketId);
            this.deleteTournamentIfAbandoned(tournament);
        }
    }

    /**
     * Handle a tournament member's socket disconnecting.
     * In the lobby phase this is a plain leave (nothing to preserve). Once the
     * tournament has started, the player is only marked disconnected so their
     * scores survive and they can reattach with a new socket.
     * @returns {{ success: boolean, tournament?: TournamentState, deleted?: boolean, newCreator?: Object, disconnected?: boolean }}
     */
    handleTournamentDisconnect(socketId, tournament) {
        if (tournament.phase === 'lobby') {
            // LIVE_PERSIST=on: a lobby-phase removal clears the pointer, scoped
            // (the handoff writes lobby members' pointers; the plan's 2.6)
            const username = persistOn() ? tournament.players.get(socketId)?.username : null;
            const result = this.leaveTournament(socketId);
            if (username && result.success) this.clearActiveTournament(username, tournament.tournamentId);
            return result;
        }

        const wasCreator = tournament.createdBy === socketId;
        tournament.markPlayerDisconnected(socketId);
        this.playerTournaments.delete(socketId);

        if (this.deleteTournamentIfAbandoned(tournament)) {
            return { success: true, deleted: true, tournament, disconnected: true };
        }

        let newCreator = null;
        if (wasCreator && tournament.getConnectedPlayerCount() > 0) {
            newCreator = tournament.transferCreator();
        }

        return { success: true, tournament, newCreator, disconnected: true };
    }

    /**
     * Reattach a reconnecting user (new socket) to the tournament that still
     * holds a player entry for their username, in any phase.
     * @param {string} [preferredTournamentId] - When known (e.g. resolved from
     *   the game being rejoined), reattach only within that tournament — the
     *   same username can linger as a ghost in an older tournament.
     * @returns {TournamentState|null}
     */
    reattachTournamentPlayer(socketId, username, preferredTournamentId = null) {
        const candidates = preferredTournamentId
            ? [[preferredTournamentId, this.tournaments.get(preferredTournamentId)]]
            : this.tournaments;

        for (const [tournamentId, tournament] of candidates) {
            if (!tournament) continue;
            const result = tournament.reattachPlayerByUsername(username, socketId);
            if (result) {
                if (result.oldSocketId !== socketId) {
                    this.playerTournaments.delete(result.oldSocketId);
                }
                this.playerTournaments.set(socketId, tournamentId);
                return tournament;
            }
        }
        return null;
    }

    /**
     * Delete a completed tournament and clean up all references
     */
    deleteTournament(tournamentId) {
        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return [];

        // Stale every captured epoch first: an in-flight round start stops
        // at its next check
        tournament.retire();
        for (const [socketId] of tournament.players) {
            if (this.playerTournaments.get(socketId) === tournamentId) {
                this.playerTournaments.delete(socketId);
            }
        }
        // Unmapped first, so the abort follow-up of any table still running
        // (handleAbortedTournamentGame) has nothing to resolve
        const orphaned = this.getTournamentLiveGames(tournamentId);
        for (const [gameId, tId] of this.tournamentGames) {
            if (tId === tournamentId) {
                this.tournamentGames.delete(gameId);
            }
        }
        this.tournaments.delete(tournamentId);
        // Its saved doc is deleted (LIVE_PERSIST write; no-op off)
        liveStore().remove(tournament);
        return orphaned;
    }

    /**
     * The live (non-terminal, still registered) games mapped to a tournament.
     * @returns {GameState[]}
     */
    getTournamentLiveGames(tournamentId) {
        const games = [];
        for (const [gameId, tId] of this.tournamentGames) {
            if (tId !== tournamentId) continue;
            const game = this.games.get(gameId);
            if (game && !game.isTerminal()) games.push(game);
        }
        return games;
    }

    /**
     * Get the tournament a player is in
     */
    getPlayerTournament(socketId) {
        const tournamentId = this.playerTournaments.get(socketId);
        return tournamentId ? this.tournaments.get(tournamentId) : null;
    }

    /**
     * Get tournament by ID
     */
    getTournamentById(tournamentId) {
        return this.tournaments.get(tournamentId) || null;
    }

    /**
     * Get all tournaments for main room display
     */
    getAllTournaments() {
        const result = [];
        for (const [tournamentId, t] of this.tournaments) {
            result.push({
                id: tournamentId,
                name: t.name,
                playerCount: t.players.size,
                phase: t.phase,
                currentRound: t.currentRound,
                totalRounds: t.totalRounds,
                creatorUsername: t.creatorUsername
            });
        }
        return result;
    }

    /**
     * Handle tournament game end — record scores, check round completion
     * @returns {{ roundComplete: boolean, tournament: TournamentState } | null}
     */
    handleTournamentGameEnd(gameId) {
        const tournamentId = this.tournamentGames.get(gameId);
        if (!tournamentId) return null;

        // Resolved at most once: the mapping goes now, whatever follows
        this.tournamentGames.delete(gameId);

        const tournament = this.tournaments.get(tournamentId);
        if (!tournament) return null;

        tournament.markGameComplete(gameId);

        const roundComplete = tournament.isRoundComplete();
        if (roundComplete) {
            tournament.completeRound();
        }

        return { roundComplete, tournament };
    }

    /**
     * Set active tournament for a user in the database
     */
    async setActiveTournament(username, tournamentId) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return;

            await usersCollection.updateOne(
                { username },
                { $set: { activeTournamentId: tournamentId } }
            );
        } catch (error) {
            console.error('Failed to set active tournament:', error);
        }
    }

    /**
     * Clear active tournament for a user in the database
     */
    async clearActiveTournament(username, tournamentId) {
        try {
            const usersCollection = getUsersCollection();
            if (!usersCollection) return;

            // Scoped when given: the user may already be in another tournament
            await usersCollection.updateOne(
                tournamentId ? { username, activeTournamentId: tournamentId } : { username },
                { $unset: { activeTournamentId: '' } }
            );
        } catch (error) {
            console.error('Failed to clear active tournament:', error);
        }
    }

    /**
     * Clear active tournament for all players in a tournament
     */
    async clearActiveTournamentForAll(tournamentId, tournament = this.tournaments.get(tournamentId)) {
        if (!tournament) return;

        // Usernames snapshotted now, written in parallel
        const usernames = [];
        for (const [, player] of tournament.players) {
            if (player.username) usernames.push(player.username);
        }
        await Promise.all(usernames.map(u => this.clearActiveTournament(u, tournamentId)));
    }

    /**
     * Tests only: forget everything, as a process that was killed and
     * started again would (testUtils/persistHarness.js restart). Every
     * game and tournament goes stale first, with no emit, no terminate and
     * no DB write: its epoch is bumped (so an awaited continuation's
     * aliveCheck / isLive fails) and its timers cancelled (pauses resolve
     * false); lobby-grace timers (play-again holds included) and play-again
     * reservation timers are cancelled. Then every field is what
     * the constructor makes (main-room listeners included). Jest spies
     * installed on the singleton (own mock-function properties) stay
     * installed, so a test's spy keeps recording and mocking after a
     * harness restart.
     * What still runs after this (module state elsewhere, an async chain
     * that never checks an epoch) is persistHarness.killInstance's to cut.
     * Bots live in BotController: reset it too (BotController._resetForTests).
     * Jest only (JEST_WORKER_ID, not NODE_ENV: the contract suites also run
     * with NODE_ENV=production).
     */
    _resetForTests() {
        if (process.env.JEST_WORKER_ID === undefined) throw new Error('_resetForTests is for Jest only');
        for (const game of this.games.values()) {
            game.epoch++;
            game._cancelAllTimers();
        }
        for (const tournament of this.tournaments.values()) {
            tournament.retired = true;
            tournament.epoch++;
            tournament.clearTimers();
        }
        // Lobby-grace timers, play-again holds among them (kind 'afterGame')
        for (const held of this.lobbyGrace.values()) clearTimeout(held.timer);
        // Play-again reservations (socket/playAgain.js) time out on the
        // lobby, not in lobbyGrace; ended here with no emit (no teardown:
        // its lingering-call voicePeerLeft would reach the dead io)
        for (const lobby of this.lobbies.values()) {
            for (const rec of lobby.afterGame?.reserved?.values() || []) clearTimeout(rec.timer);
        }
        for (const key of Object.keys(this)) {
            const value = this[key];
            if (typeof value === 'function' && value._isMockFunction === true) continue;
            delete this[key];
        }
        Object.assign(this, new GameManager());
    }
}

// Singleton instance
const gameManager = new GameManager();

module.exports = gameManager;
