/**
 * Encapsulates all state for a single tournament instance.
 * Manages tournament lifecycle: lobby → round_active → between_rounds → complete.
 */

const { v4: uuidv4 } = require('uuid');

class TournamentState {
    constructor(tournamentId, name, creatorSocketId, creatorUsername) {
        this.tournamentId = tournamentId;
        this.roomName = `tournament:${tournamentId}`;
        this.name = name || `${creatorUsername}'s Tournament`;
        this.createdBy = creatorSocketId;
        this.creatorUsername = creatorUsername;
        this.createdAt = Date.now();

        // Phase: 'lobby' | 'round_active' | 'between_rounds' | 'complete'
        this.phase = 'lobby';
        this.currentRound = 0; // 0 = not started, 1-4 = round number
        this.totalRounds = 4;

        // Players: socketId → { username, pic, ready }
        this.players = new Map();
        this.readyPlayers = new Set();

        // Chat messages (capped)
        this.messages = [];
        this.maxMessages = 100;

        // Spectators: socketId → { username, pic }
        this.spectators = new Map();

        // Rounds data
        this.rounds = [];

        // Scoreboard: username → { totalScore, roundScores: [r1..r4], roundDetails: [...] }
        this.scoreboard = {};

        this._debugMode = process.env.NODE_ENV !== 'production';
    }

    // ========================================
    // Player Management
    // ========================================

    addPlayer(socketId, username, pic) {
        this.players.set(socketId, { username, pic, ready: false });
        // Initialize scoreboard entry
        if (!this.scoreboard[username]) {
            this.scoreboard[username] = {
                totalScore: 0,
                roundScores: [],
                roundDetails: []
            };
        }
        this.logAction('addPlayer', { socketId, username });
    }

    removePlayer(socketId) {
        const player = this.players.get(socketId);
        if (!player) return null;

        this.players.delete(socketId);
        this.readyPlayers.delete(socketId);

        this.logAction('removePlayer', { socketId, username: player.username });
        return player;
    }

    getPlayerBySocketId(socketId) {
        return this.players.get(socketId) || null;
    }

    getPlayerByUsername(username) {
        for (const [socketId, player] of this.players.entries()) {
            if (player.username === username) {
                return { socketId, ...player };
            }
        }
        return null;
    }

    getHumanPlayerCount() {
        return this.players.size;
    }

    setReady(socketId) {
        const player = this.players.get(socketId);
        if (!player) return false;
        player.ready = true;
        this.readyPlayers.add(socketId);
        return true;
    }

    unsetReady(socketId) {
        const player = this.players.get(socketId);
        if (!player) return false;
        player.ready = false;
        this.readyPlayers.delete(socketId);
        return true;
    }

    allPlayersReady() {
        if (this.players.size === 0) return false;
        return this.readyPlayers.size === this.players.size;
    }

    resetAllReady() {
        this.readyPlayers.clear();
        for (const [, player] of this.players) {
            player.ready = false;
        }
    }

    /**
     * Transfer creator role to next human player.
     * @returns {{ socketId: string, username: string } | null} New creator, or null if no humans remain
     */
    transferCreator() {
        // Find first player that isn't the current creator
        for (const [socketId, player] of this.players.entries()) {
            if (socketId !== this.createdBy) {
                this.createdBy = socketId;
                this.creatorUsername = player.username;
                this.logAction('transferCreator', { newCreator: player.username });
                return { socketId, username: player.username };
            }
        }
        // Only one or zero players left
        if (this.players.size === 1) {
            const [socketId, player] = this.players.entries().next().value;
            this.createdBy = socketId;
            this.creatorUsername = player.username;
            return { socketId, username: player.username };
        }
        return null;
    }

    // ========================================
    // Round Management
    // ========================================

    startRound(roundNumber) {
        this.currentRound = roundNumber;
        this.phase = 'round_active';

        const roundData = {
            roundNumber,
            games: new Map(), // gameId → { humanPlayers: [], botCount, status }
            completedGames: new Set()
        };
        this.rounds.push(roundData);

        this.logAction('startRound', { roundNumber });
        return roundData;
    }

    getCurrentRound() {
        if (this.rounds.length === 0) return null;
        return this.rounds[this.rounds.length - 1];
    }

    addGameToRound(gameId, humanPlayers, botCount) {
        const round = this.getCurrentRound();
        if (!round) return;

        round.games.set(gameId, {
            humanPlayers,
            botCount,
            status: 'active'
        });
        this.logAction('addGameToRound', { gameId, humanCount: humanPlayers.length, botCount });
    }

    /**
     * Record a player's score for the current round.
     */
    recordPlayerRoundScore(username, details) {
        if (!this.scoreboard[username]) {
            this.scoreboard[username] = {
                totalScore: 0,
                roundScores: [],
                roundDetails: []
            };
        }

        const entry = this.scoreboard[username];
        const roundScore = details.teamScore;
        entry.roundScores.push(roundScore);
        entry.roundDetails.push(details);
        entry.totalScore += roundScore;

        this.logAction('recordPlayerRoundScore', { username, roundScore, totalScore: entry.totalScore });
    }

    markGameComplete(gameId) {
        const round = this.getCurrentRound();
        if (!round) return;

        const gameData = round.games.get(gameId);
        if (gameData) {
            gameData.status = 'complete';
        }
        round.completedGames.add(gameId);

        this.logAction('markGameComplete', {
            gameId,
            completedCount: round.completedGames.size,
            totalGames: round.games.size
        });
    }

    isRoundComplete() {
        const round = this.getCurrentRound();
        if (!round) return false;
        return round.completedGames.size === round.games.size;
    }

    completeRound() {
        if (this.currentRound >= this.totalRounds) {
            this.phase = 'complete';
        } else {
            this.phase = 'between_rounds';
            this.resetAllReady();
        }
        this.logAction('completeRound', { round: this.currentRound, phase: this.phase });
    }

    isTournamentComplete() {
        return this.phase === 'complete';
    }

    /**
     * Get scoreboard sorted by totalScore descending.
     */
    getScoreboard() {
        const entries = Object.entries(this.scoreboard)
            .map(([username, data]) => ({
                username,
                ...data
            }))
            .sort((a, b) => b.totalScore - a.totalScore);

        return entries;
    }

    // ========================================
    // Spectator Methods
    // ========================================

    addSpectator(socketId, username, pic) {
        this.spectators.set(socketId, { username, pic });
    }

    removeSpectator(socketId) {
        this.spectators.delete(socketId);
    }

    isSpectator(socketId) {
        return this.spectators.has(socketId);
    }

    // ========================================
    // Chat Methods
    // ========================================

    addMessage(username, message, isSpectator = false) {
        const chatMessage = {
            username,
            message,
            isSpectator,
            timestamp: Date.now()
        };
        this.messages.push(chatMessage);
        if (this.messages.length > this.maxMessages) {
            this.messages.shift();
        }
        return chatMessage;
    }

    // ========================================
    // Room Management
    // ========================================

    broadcast(io, event, data) {
        io.to(this.roomName).emit(event, data);
    }

    joinToRoom(io, socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.join(this.roomName);
        }
    }

    leaveRoom(io, socketId) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
            socket.leave(this.roomName);
        }
    }

    // ========================================
    // Active Games (for spectating during rounds)
    // ========================================

    getActiveGames() {
        const round = this.getCurrentRound();
        if (!round) return [];

        const games = [];
        for (const [gameId, gameData] of round.games) {
            games.push({
                gameId,
                humanPlayers: gameData.humanPlayers,
                botCount: gameData.botCount,
                status: gameData.status
            });
        }
        return games;
    }

    // ========================================
    // Client State (for reconnection/joining)
    // ========================================

    getClientState() {
        const players = [];
        for (const [socketId, player] of this.players.entries()) {
            players.push({
                socketId,
                username: player.username,
                pic: player.pic,
                ready: player.ready,
                isCreator: socketId === this.createdBy
            });
        }

        return {
            tournamentId: this.tournamentId,
            name: this.name,
            phase: this.phase,
            currentRound: this.currentRound,
            totalRounds: this.totalRounds,
            players,
            messages: this.messages,
            scoreboard: this.getScoreboard(),
            activeGames: this.getActiveGames(),
            creatorUsername: this.creatorUsername,
            creatorSocketId: this.createdBy
        };
    }

    // ========================================
    // Player Distribution Algorithm
    // ========================================

    /**
     * Distribute players into games of 4, filling gaps with bots.
     * @param {string[]} shuffledUsernames - Shuffled array of usernames
     * @returns {Array<{ humans: string[], botCount: number }>}
     */
    static distributePlayersIntoGames(shuffledUsernames) {
        const n = shuffledUsernames.length;

        if (n === 0) return [];

        if (n < 4) {
            // 1-3 players: one game with bots filling
            return [{ humans: [...shuffledUsernames], botCount: 4 - n }];
        }

        const remainder = n % 4;
        const results = [];

        if (remainder === 0) {
            // Perfect division
            for (let i = 0; i < n; i += 4) {
                results.push({
                    humans: shuffledUsernames.slice(i, i + 4),
                    botCount: 0
                });
            }
        } else if (remainder === 1) {
            // Take 5 players → make 2 games (3+1bot, 2+2bots). Rest fill full games.
            const fullGameCount = Math.floor(n / 4) - 1;
            let idx = 0;

            for (let i = 0; i < fullGameCount; i++) {
                results.push({
                    humans: shuffledUsernames.slice(idx, idx + 4),
                    botCount: 0
                });
                idx += 4;
            }

            // Split remaining 5 into (3 + 1 bot) and (2 + 2 bots)
            results.push({
                humans: shuffledUsernames.slice(idx, idx + 3),
                botCount: 1
            });
            idx += 3;
            results.push({
                humans: shuffledUsernames.slice(idx, idx + 2),
                botCount: 2
            });
        } else if (remainder === 2) {
            // floor(n/4) full games + 1 game (2 humans + 2 bots)
            const fullGameCount = Math.floor(n / 4);
            let idx = 0;

            for (let i = 0; i < fullGameCount; i++) {
                results.push({
                    humans: shuffledUsernames.slice(idx, idx + 4),
                    botCount: 0
                });
                idx += 4;
            }

            results.push({
                humans: shuffledUsernames.slice(idx, idx + 2),
                botCount: 2
            });
        } else if (remainder === 3) {
            // floor(n/4) full games + 1 game (3 humans + 1 bot)
            const fullGameCount = Math.floor(n / 4);
            let idx = 0;

            for (let i = 0; i < fullGameCount; i++) {
                results.push({
                    humans: shuffledUsernames.slice(idx, idx + 4),
                    botCount: 0
                });
                idx += 4;
            }

            results.push({
                humans: shuffledUsernames.slice(idx, idx + 3),
                botCount: 1
            });
        }

        return results;
    }

    // ========================================
    // Debug Logging
    // ========================================

    logAction(action, details = {}) {
        if (this._debugMode) {
            console.log(`[Tournament ${this.tournamentId.slice(0, 8)}] ${action}`, details);
        }
    }
}

module.exports = TournamentState;
