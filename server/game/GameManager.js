/**
 * Manages game queue and active game instances
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

const MERGE_LOCKED = 'This account is being updated. Please try again in a minute.';

class GameManager {
    constructor() {
        // Queue of players waiting for a game
        this.queue = [];
        this.queuedUsers = [];

        // Main room (global chat + lobby browser)
        this.mainRoomMessages = [];       // Global chat history (capped at MAX_MAIN_ROOM_MESSAGES)
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
        // they cannot sign in, restore, rejoin, queue, open or join a lobby
        // or a tournament (and a rename's new name cannot be signed up)
        // until it is done
        this.mergeLocks = new Set();
    }

    // Constants
    static MAX_MAIN_ROOM_MESSAGES = 50;
    // A lobby seat outlives its socket by this long (a reload, a short
    // network drop): the player's next socket re-entering takes it back
    static LOBBY_SEAT_GRACE_MS = 30000;

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
     * Add player to lobby (creates one immediately or joins existing)
     */
    joinQueue(socketId) {
        if (this._mergeLockedUser(socketId)) return { success: false, error: MERGE_LOCKED };
        // Check if already in lobby
        if (this.playerLobbies.has(socketId)) {
            return { success: false, error: 'Already in lobby' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        // Verify user is registered (prevents race condition with auth)
        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not registered yet' };
        }

        // Re-entry from a new socket (half-open reconnect): the user's seat
        // moves to this socket, full lobby or not
        const stale = this.findStaleLobbySeat(user.username, socketId);
        if (stale) {
            const takeover = this.takeOverLobbySeat(socketId, stale.lobby.id);
            return {
                success: true,
                lobbyCreated: false,
                joinedExisting: true,
                lobby: takeover.lobby,
                players: takeover.lobby.players.map(p => p.socketId),
                replacedSocketId: takeover.replacedSocketId
            };
        }

        // Find an existing open lobby (less than 4 players)
        let openLobby = null;
        for (const [lobbyId, lobby] of this.lobbies) {
            if (lobby.players.length < 4) {
                openLobby = lobby;
                break;
            }
        }

        if (openLobby) {
            // Join existing lobby
            const result = this.addPlayerToLobby(socketId, openLobby.id);
            return {
                success: true,
                lobbyCreated: false,
                joinedExisting: true,
                lobby: openLobby,
                players: openLobby.players.map(p => p.socketId)
            };
        } else {
            // Create new lobby with just this player
            const lobby = this.createLobby([socketId]);
            return {
                success: true,
                lobbyCreated: true,
                lobby,
                players: [socketId]
            };
        }
    }

    /**
     * Add a player to an existing lobby
     */
    addPlayerToLobby(socketId, lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };
        if (lobby.players.length >= 4) return { success: false, error: 'Lobby is full' };

        const user = this.getUserBySocketId(socketId);
        const newPlayer = {
            socketId,
            username: user?.username || 'Unknown',
            ready: false
        };

        lobby.players.push(newPlayer);
        this.playerLobbies.set(socketId, lobbyId);

        return { success: true, lobby, newPlayer };
    }

    /**
     * Remove player from queue
     */
    leaveQueue(socketId) {
        const index = this.queue.indexOf(socketId);
        if (index !== -1) {
            this.queue.splice(index, 1);
            this.queuedUsers = this.queuedUsers.filter(u => u.socketId !== socketId);
            return { success: true, queuedUsers: this.queuedUsers };
        }
        return { success: false };
    }

    // ==================== MAIN ROOM METHODS ====================

    /**
     * Add player to main room
     */
    joinMainRoom(socketId) {
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
            messages: this.mainRoomMessages,
            lobbies: this.getAllLobbies(),
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
     * Get all socket IDs in main room
     */
    getMainRoomSocketIds() {
        return Array.from(this.mainRoomSocketIds);
    }

    /**
     * Get all lobbies for display
     */
    getAllLobbies() {
        const lobbies = [];
        for (const [lobbyId, lobby] of this.lobbies) {
            lobbies.push({
                id: lobbyId,
                name: lobby.name || `${lobby.players[0]?.username || 'Unknown'}'s Game`,
                playerCount: lobby.players.length,
                maxPlayers: 4,
                players: lobby.players.map(p => ({
                    username: p.username,
                    ready: p.ready
                })),
                createdAt: lobby.createdAt
            });
        }
        return lobbies;
    }

    /**
     * Create a named lobby from main room
     */
    createNamedLobby(socketId, name = null) {
        if (this._mergeLockedUser(socketId)) return { success: false, error: MERGE_LOCKED };
        // Check if already in lobby
        if (this.playerLobbies.has(socketId)) {
            return { success: false, error: 'Already in lobby' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

        const user = this.getUserBySocketId(socketId);
        if (!user) {
            return { success: false, error: 'User not found' };
        }

        // One seat per user: a seat this user still holds from an older
        // socket (half-open reconnect) is given up
        const evicted = this.evictStaleLobbySeat(user.username, socketId);

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
            createdBy: user.username
        };

        this.lobbies.set(lobbyId, lobby);
        this.playerLobbies.set(socketId, lobbyId);

        return { success: true, lobby, evicted };
    }

    /**
     * Join a specific lobby by ID
     */
    joinSpecificLobby(socketId, lobbyId) {
        if (this._mergeLockedUser(socketId)) return { success: false, error: MERGE_LOCKED };
        // Check if already in a lobby
        if (this.playerLobbies.has(socketId)) {
            return { success: false, error: 'Already in a lobby' };
        }

        // Check if already in game
        if (this.playerGames.has(socketId)) {
            return { success: false, error: 'Already in game' };
        }

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
            return this.takeOverLobbySeat(socketId, lobbyId);
        }

        if (lobby.players.length >= 4) {
            return { success: false, error: 'Lobby is full' };
        }

        // One seat per user: a seat this user still holds in another lobby
        // from an older socket is given up
        const evicted = this.evictStaleLobbySeat(user.username, socketId);

        // Leave main room
        this.leaveMainRoom(socketId);

        const newPlayer = {
            socketId,
            username: user.username,
            ready: false
        };

        lobby.players.push(newPlayer);
        this.playerLobbies.set(socketId, lobbyId);

        return { success: true, lobby, newPlayer, evicted };
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
    takeOverLobbySeat(socketId, lobbyId) {
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
        const timer = setTimeout(() => {
            const result = this.expireLobbySeat(lobbyId, socketId);
            this.lobbyGrace.delete(socketId);
            if (result && onExpire) onExpire(result);
        }, GameManager.LOBBY_SEAT_GRACE_MS);
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
        const names = this.reconnectingIn(lobbyId);
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
     * Create a new lobby with 4 players
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

        const lobby = {
            id: lobbyId,
            players,
            readyPlayers: new Set(),
            messages: [],
            createdAt: Date.now()
        };

        this.lobbies.set(lobbyId, lobby);

        // Map each player to this lobby
        playerSocketIds.forEach(socketId => {
            this.playerLobbies.set(socketId, lobbyId);
        });

        // Clear queued users who are now in lobby
        this.queuedUsers = this.queuedUsers.filter(
            u => !playerSocketIds.includes(u.socketId)
        );

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

    /**
     * Mark player as ready in lobby
     * Returns { allReady, lobby } if successful
     */
    setPlayerReady(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Mark player as ready
        lobby.readyPlayers.add(socketId);
        const player = lobby.players.find(p => p.socketId === socketId);
        if (player) player.ready = true;

        // Check if all players are ready
        const allReady = lobby.readyPlayers.size === 4;

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

        return { success: true, lobby, chatMessage };
    }

    /**
     * Handle player leaving lobby
     * Returns remaining players or null if lobby should be dissolved
     */
    leaveLobby(socketId) {
        const lobbyId = this.playerLobbies.get(socketId);
        if (!lobbyId) return { success: false, error: 'Not in a lobby' };

        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        // Remove player from lobby
        lobby.players = lobby.players.filter(p => p.socketId !== socketId);
        lobby.readyPlayers.delete(socketId);
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
            this.lobbies.delete(lobbyId);
            return {
                success: true,
                lobby: null,
                lobbyDeleted: true,
                playerLeft: socketId
            };
        }

        // Reset all ready states when someone leaves
        lobby.readyPlayers.clear();
        lobby.players.forEach(p => p.ready = false);

        return {
            success: true,
            lobby,
            playerLeft: socketId,
            needsMorePlayers: lobby.players.length < 4
        };
    }

    /**
     * Try to fill an empty lobby slot from the queue
     */
    fillLobbyFromQueue(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby || lobby.players.length >= 4) return null;

        // Get next player from queue
        if (this.queue.length === 0) return null;

        const socketId = this.queue.shift();
        const user = this.getUserBySocketId(socketId);

        // Remove from queuedUsers
        this.queuedUsers = this.queuedUsers.filter(u => u.socketId !== socketId);

        // Add to lobby
        lobby.players.push({
            socketId,
            username: user?.username || 'Unknown',
            ready: false
        });
        this.playerLobbies.set(socketId, lobbyId);

        return { socketId, username: user?.username };
    }

    /**
     * Convert lobby to game when all players are ready
     */
    startGameFromLobby(lobbyId) {
        const lobby = this.lobbies.get(lobbyId);
        if (!lobby) return { success: false, error: 'Lobby not found' };

        if (lobby.readyPlayers.size !== 4) {
            return { success: false, error: 'Not all players ready' };
        }
        // A seat whose account a merge is retiring right now never starts
        // (the merge signs it out, which empties the seat)
        if (lobby.players.some(p => !p.isBot && this.isMergeLocked(p.username))) {
            return { success: false, error: MERGE_LOCKED };
        }

        // Get player socket IDs
        const playerSocketIds = lobby.players.map(p => p.socketId);

        // Remove lobby mappings
        playerSocketIds.forEach(socketId => {
            this.playerLobbies.delete(socketId);
        });
        this.lobbies.delete(lobbyId);

        // Create the actual game
        const game = this.createGame(playerSocketIds);

        return { success: true, game, players: playerSocketIds };
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

        if (lobby.players.length >= 4) {
            return { success: false, error: 'Lobby is full' };
        }

        // Pick a random personality not already in this lobby
        const usedPersonalities = lobby.players
            .filter(p => p.isBot && p.personality)
            .map(p => p.personality);
        const available = PERSONALITY_LIST.filter(p => !usedPersonalities.includes(p));
        const personality = available[Math.floor(Math.random() * available.length)];

        // Generic lobby name (hidden until game starts)
        const existingBots = lobby.players.filter(p => p.isBot);
        const botNumber = existingBots.length + 1;
        const lobbyName = botNumber > 1 ? `🤖 Bot ${botNumber}` : '🤖 Bot';

        // Create bot with generic lobby name
        const bot = botController.createBot(lobbyName, personality);

        // Add bot to lobby as a player (personality stored for name reveal at game start)
        const botPlayer = {
            socketId: bot.socketId,
            username: bot.username,
            ready: false,
            isBot: true,
            personality
        };

        lobby.players.push(botPlayer);
        // Don't add to playerLobbies since bots don't have real sockets

        return { success: true, botPlayer, lobby, bot };
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

        const botIndex = lobby.players.findIndex(p => p.socketId === botSocketId);
        if (botIndex === -1) {
            return { success: false, error: 'Bot not found in lobby' };
        }

        // Remove bot
        lobby.players.splice(botIndex, 1);
        lobby.readyPlayers.delete(botSocketId);

        // Reset all ready states when someone leaves
        lobby.readyPlayers.clear();
        lobby.players.forEach(p => p.ready = false);

        return { success: true, lobby };
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

        // Clear queued users who are now in game
        this.queuedUsers = this.queuedUsers.filter(
            u => !playerSocketIds.includes(u.socketId)
        );

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
        this.games.delete(id);
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
     * Get list of in-progress games for spectating
     * @returns {Array} - Array of { gameId, players, currentHand, score, spectatorCount }
     */
    getInProgressGames() {
        const games = [];
        for (const [gameId, game] of this.games) {
            if (game.phase === 'waiting' || game.phase === 'drawing') continue;
            if (this.tournamentGames.has(gameId)) continue;

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
     * Get queue status
     */
    getQueueStatus() {
        return {
            size: this.queue.length,
            queuedUsers: this.queuedUsers
        };
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

        // Check if already in a tournament
        if (this.playerTournaments.has(socketId)) {
            return { success: false, error: 'Already in a tournament' };
        }
        // One tournament per user: a membership an older socket of theirs
        // still holds (half-open reconnect, a parked tab)
        const stale = this.giveUpStaleTournament(user.username, socketId);
        if (stale.refused) return { success: false, error: 'Already in a tournament' };

        const tournamentId = uuidv4();
        const tournament = new TournamentState(tournamentId, name, socketId, user.username);
        tournament.addPlayer(socketId, user.username, null);

        this.tournaments.set(tournamentId, tournament);
        this.playerTournaments.set(socketId, tournamentId);

        // Leave main room
        this.leaveMainRoom(socketId);

        return { success: true, tournament, evicted: stale.evicted };
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

        tournament.addPlayer(socketId, user.username, null);
        this.playerTournaments.set(socketId, tournamentId);

        // Leave main room
        this.leaveMainRoom(socketId);

        return { success: true, tournament, evicted: stale.evicted };
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
     * Before `socketId` creates or joins another tournament: a membership
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
        if (tournament.players.size === 0 ||
            (tournament.getConnectedPlayerCount() === 0 && !hasRunningGames)) {
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
            return this.leaveTournament(socketId);
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
}

// Singleton instance
const gameManager = new GameManager();

module.exports = gameManager;
