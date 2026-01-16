/**
 * Application state container for pre-game screens
 * Manages lobby, main room, and chat state
 * Separate from GameState which handles in-game state
 */
class AppState {
    constructor() {
        this.reset();
        this._listeners = new Map();
    }

    /**
     * Reset all state to initial values
     */
    reset() {
        // Screen tracking
        this.currentScreen = 'auth'; // auth, mainRoom, lobby, draw, game

        // User info (persisted to sessionStorage on auth)
        this.username = null;
        this.pic = 1;

        // Lobby state
        this.currentLobbyId = null;
        this.lobbyPlayers = []; // Array of { username, pic, ready, socketId }
        this.isPlayerReady = false;

        // Available lobbies (from server)
        this.availableLobbies = [];

        // Chat color assignments (per context)
        this.lobbyUserColors = {};
        this.mainRoomUserColors = {};

        // Main room state
        this.onlineCount = 0;
    }

    /**
     * Set current screen and emit event
     * @param {string} screen - Screen name
     */
    setScreen(screen) {
        const previous = this.currentScreen;
        this.currentScreen = screen;
        this._emit('screenChanged', { previous, current: screen });
    }

    /**
     * Set user info after authentication
     * @param {string} username
     * @param {number} pic
     */
    setUser(username, pic = 1) {
        this.username = username;
        this.pic = pic;
        // Persist for reconnection
        sessionStorage.setItem('username', username);
        sessionStorage.setItem('pic', pic.toString());
    }

    /**
     * Clear user info on logout
     */
    clearUser() {
        this.username = null;
        this.pic = 1;
        sessionStorage.removeItem('username');
        sessionStorage.removeItem('pic');
    }

    /**
     * Restore user from session storage
     * @returns {boolean} Whether user was restored
     */
    restoreUser() {
        const username = sessionStorage.getItem('username');
        const pic = sessionStorage.getItem('pic');
        if (username) {
            this.username = username;
            this.pic = pic ? parseInt(pic, 10) : 1;
            return true;
        }
        return false;
    }

    // ========================================
    // Lobby Management
    // ========================================

    /**
     * Enter a lobby
     * @param {string} lobbyId
     * @param {Array} players
     */
    enterLobby(lobbyId, players = []) {
        this.currentLobbyId = lobbyId;
        this.lobbyPlayers = players;
        this.isPlayerReady = false;
        this.lobbyUserColors = {};

        // Assign colors to players
        players.forEach(p => this.assignLobbyColor(p.username));

        this._emit('lobbyEntered', { lobbyId, players });
    }

    /**
     * Leave current lobby
     */
    leaveLobby() {
        const lobbyId = this.currentLobbyId;
        this.currentLobbyId = null;
        this.lobbyPlayers = [];
        this.isPlayerReady = false;
        this.lobbyUserColors = {};
        this._emit('lobbyLeft', { lobbyId });
    }

    /**
     * Update lobby players list
     * @param {Array} players
     */
    updateLobbyPlayers(players) {
        this.lobbyPlayers = players;
        // Assign colors to any new players
        players.forEach(p => {
            if (!this.lobbyUserColors[p.username]) {
                this.assignLobbyColor(p.username);
            }
        });
        this._emit('lobbyPlayersChanged', players);
    }

    /**
     * Set player ready state
     * @param {boolean} ready
     */
    setReady(ready) {
        this.isPlayerReady = ready;
        this._emit('readyChanged', ready);
    }

    /**
     * Update a player's ready state
     * @param {string} username
     * @param {boolean} ready
     */
    updatePlayerReady(username, ready) {
        const player = this.lobbyPlayers.find(p => p.username === username);
        if (player) {
            player.ready = ready;
            if (username === this.username) {
                this.isPlayerReady = ready;
            }
            this._emit('playerReadyChanged', { username, ready });
        }
    }

    /**
     * Update available lobbies list
     * @param {Array} lobbies
     */
    updateLobbies(lobbies) {
        this.availableLobbies = lobbies;
        this._emit('lobbiesUpdated', lobbies);
    }

    // ========================================
    // Color Assignment
    // ========================================

    /**
     * Generate a hash-based hue from username
     * @param {string} username
     * @returns {number} Hue value 0-360
     */
    hashToHue(username) {
        let hash = 5381;
        for (let i = 0; i < username.length; i++) {
            hash = ((hash << 5) + hash) ^ username.charCodeAt(i);
        }
        return Math.abs(hash) % 360;
    }

    /**
     * Generate a color distinct from existing colors
     * @param {string} username
     * @param {Object} existingColors - Map of username -> color
     * @returns {string} HSL color string
     */
    generateDistinctColor(username, existingColors) {
        let hue = this.hashToHue(username);

        // Extract hues from existing colors
        const existingHues = Object.values(existingColors)
            .map(color => {
                const match = color.match(/hsl\((\d+)/);
                return match ? parseInt(match[1]) : null;
            })
            .filter(h => h !== null);

        // Adjust hue if too close to existing ones (within 50 degrees)
        const minDistance = 50;
        let attempts = 0;
        while (attempts < 360 && existingHues.length > 0) {
            const tooClose = existingHues.some(existingHue => {
                const diff = Math.abs(hue - existingHue);
                return Math.min(diff, 360 - diff) < minDistance;
            });
            if (!tooClose) break;
            hue = (hue + 67) % 360; // Prime number for better distribution
            attempts++;
        }

        return `hsl(${hue}, 70%, 60%)`;
    }

    /**
     * Assign a color for a lobby user
     * @param {string} username
     * @returns {string} HSL color string
     */
    assignLobbyColor(username) {
        if (!this.lobbyUserColors[username]) {
            this.lobbyUserColors[username] = this.generateDistinctColor(username, this.lobbyUserColors);
        }
        return this.lobbyUserColors[username];
    }

    /**
     * Assign a color for a main room user
     * @param {string} username
     * @returns {string} HSL color string
     */
    assignMainRoomColor(username) {
        if (!this.mainRoomUserColors[username]) {
            this.mainRoomUserColors[username] = this.generateDistinctColor(username, this.mainRoomUserColors);
        }
        return this.mainRoomUserColors[username];
    }

    /**
     * Get color for a username (checks both contexts)
     * @param {string} username
     * @returns {string} HSL color string
     */
    getUsernameColor(username) {
        if (this.lobbyUserColors[username]) {
            return this.lobbyUserColors[username];
        }
        if (this.mainRoomUserColors[username]) {
            return this.mainRoomUserColors[username];
        }
        // Fallback for system messages or other contexts
        return `hsl(${this.hashToHue(username)}, 70%, 60%)`;
    }

    // ========================================
    // Event System
    // ========================================

    /**
     * Subscribe to state changes
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {Function} Unsubscribe function
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);

        return () => this.off(event, callback);
    }

    /**
     * Unsubscribe from state changes
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    off(event, callback) {
        const callbacks = this._listeners.get(event);
        if (callbacks) {
            callbacks.delete(callback);
        }
    }

    /**
     * Emit a state change event
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    _emit(event, data) {
        const callbacks = this._listeners.get(event);
        if (callbacks) {
            callbacks.forEach(cb => {
                try {
                    cb(data);
                } catch (err) {
                    console.error(`Error in AppState ${event} listener:`, err);
                }
            });
        }
    }

    // ========================================
    // Debug
    // ========================================

    /**
     * Serialize state for debugging
     * @returns {Object}
     */
    toJSON() {
        return {
            currentScreen: this.currentScreen,
            username: this.username,
            currentLobbyId: this.currentLobbyId,
            lobbyPlayerCount: this.lobbyPlayers.length,
            isPlayerReady: this.isPlayerReady,
            onlineCount: this.onlineCount
        };
    }

    /**
     * Log current state
     */
    logState() {
        console.log('[AppState]', this.toJSON());
    }
}

// Singleton instance
const appState = new AppState();
export default appState;
