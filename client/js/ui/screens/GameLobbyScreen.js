/**
 * Game Lobby Screen
 * Pre-game lobby with player list, ready buttons, and chat
 */
import socketManager from '../../socket/SocketManager.js';
import appState from '../../state/AppState.js';
import uiManager from '../UIManager.js';

class GameLobbyScreen {
    constructor() {
        this.cleanupFunctions = [];
        this.container = null;
    }

    /**
     * Show the game lobby screen
     * @param {Object} lobbyData - Lobby data from server (lobbyId, players, messages)
     */
    show(lobbyData) {
        console.log('Showing game lobby...', lobbyData);

        // Clean up any existing instance
        this.cleanup();

        // Update app state
        appState.setScreen('lobby');
        appState.enterLobby(lobbyData.lobbyId, lobbyData.players || []);

        // Create container
        this.container = uiManager.createWithClass('gameLobbyContainer', 'div', 'game-lobby-container');
        this.container.innerHTML = this.getTemplate(lobbyData);
        document.body.appendChild(this.container);

        // Add existing messages
        if (lobbyData.messages && lobbyData.messages.length > 0) {
            const chatArea = document.getElementById('lobbyChatArea');
            lobbyData.messages.forEach(msg => {
                this.appendChatMessage(msg.username, msg.message);
            });
            setTimeout(() => { chatArea.scrollTop = chatArea.scrollHeight; }, 0);
        }

        // Setup event listeners
        this.setupEventListeners();

        // Setup socket handlers
        this.setupSocketHandlers();

        // Initial render of players list
        this.renderPlayersList(lobbyData.players || []);
    }

    /**
     * Get the HTML template for game lobby
     * @param {Object} lobbyData - Lobby data
     * @returns {string} HTML template
     */
    getTemplate(lobbyData) {
        const playerCount = lobbyData.players ? lobbyData.players.length : 0;
        const waitingFor = 4 - playerCount;

        return `
            <div class="game-lobby-header">Game Lobby</div>
            <div id="lobbyPlayersList" class="lobby-players-list"></div>
            <div id="lobbyChatArea" class="lobby-chat-area"></div>
            <div class="lobby-chat-input-row">
                <input type="text" id="lobbyChatInput" class="lobby-chat-input" placeholder="Type a message..." />
                <button id="lobbySendBtn" class="lobby-send-btn">Send</button>
            </div>
            <div class="lobby-button-row">
                <button id="lobbyReadyBtn" class="lobby-ready-btn ${playerCount < 4 ? 'disabled' : ''}" ${playerCount < 4 ? 'disabled' : ''}>
                    ${playerCount < 4 ? `Waiting for ${waitingFor} more...` : 'Ready'}
                </button>
                <button id="lobbyLeaveBtn" class="lobby-leave-btn">Leave</button>
            </div>
        `;
    }

    /**
     * Setup DOM event listeners
     */
    setupEventListeners() {
        const chatInput = document.getElementById('lobbyChatInput');
        const sendBtn = document.getElementById('lobbySendBtn');
        const readyBtn = document.getElementById('lobbyReadyBtn');
        const leaveBtn = document.getElementById('lobbyLeaveBtn');

        // Send chat on Enter
        const handleKeydown = (e) => {
            if (e.key === 'Enter' && chatInput.value.trim()) {
                socketManager.emit('lobbyChat', { message: chatInput.value.trim() });
                chatInput.value = '';
            }
        };
        chatInput.addEventListener('keydown', handleKeydown);
        this.cleanupFunctions.push(() => chatInput.removeEventListener('keydown', handleKeydown));

        // Send button click
        const handleSend = () => {
            if (chatInput.value.trim()) {
                socketManager.emit('lobbyChat', { message: chatInput.value.trim() });
                chatInput.value = '';
            }
        };
        sendBtn.addEventListener('click', handleSend);
        this.cleanupFunctions.push(() => sendBtn.removeEventListener('click', handleSend));

        // Ready button click
        const handleReady = () => {
            if (readyBtn.disabled) return;

            if (!appState.isPlayerReady) {
                socketManager.emit('playerReady');
                appState.setReady(true);
                readyBtn.innerText = 'Ready!';
                readyBtn.classList.add('ready');
            } else {
                socketManager.emit('playerUnready');
                appState.setReady(false);
                readyBtn.innerText = 'Ready';
                readyBtn.classList.remove('ready');
            }
        };
        readyBtn.addEventListener('click', handleReady);
        this.cleanupFunctions.push(() => readyBtn.removeEventListener('click', handleReady));

        // Leave button click
        const handleLeave = () => {
            socketManager.emit('leaveLobby');
        };
        leaveBtn.addEventListener('click', handleLeave);
        this.cleanupFunctions.push(() => leaveBtn.removeEventListener('click', handleLeave));
    }

    /**
     * Setup socket event handlers
     */
    setupSocketHandlers() {
        // Player ready update
        this.cleanupFunctions.push(
            socketManager.on('playerReadyUpdate', (data) => {
                appState.updatePlayerReady(data.username, data.ready);
                this.renderPlayersList(appState.lobbyPlayers);
            })
        );

        // Chat message received
        this.cleanupFunctions.push(
            socketManager.on('lobbyMessage', (data) => {
                this.appendChatMessage(data.username, data.message);
            })
        );

        // Player joined lobby
        this.cleanupFunctions.push(
            socketManager.on('lobbyPlayerJoined', (data) => {
                appState.updateLobbyPlayers(data.players);
                this.renderPlayersList(data.players);
            })
        );

        // Player left lobby
        this.cleanupFunctions.push(
            socketManager.on('lobbyPlayerLeft', (data) => {
                appState.updateLobbyPlayers(data.players);
                this.renderPlayersList(data.players);
            })
        );

        // Left lobby (self)
        this.cleanupFunctions.push(
            socketManager.on('leftLobby', () => {
                appState.leaveLobby();
                // Main.js will handle showing main room
            })
        );

        // All players ready
        this.cleanupFunctions.push(
            socketManager.on('allPlayersReady', () => {
                console.log('All players ready! Transitioning to draw phase...');
                // Main.js will handle transition to draw phase
            })
        );
    }

    /**
     * Append a chat message to the chat area
     * @param {string} username
     * @param {string} message
     */
    appendChatMessage(username, message) {
        const chatArea = document.getElementById('lobbyChatArea');
        if (!chatArea) return;

        // Assign color if new user
        const color = appState.assignLobbyColor(username);

        const msgDiv = document.createElement('div');
        msgDiv.className = 'lobby-chat-message';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'lobby-chat-username';
        nameSpan.innerText = username + ': ';
        nameSpan.style.color = color;
        msgDiv.appendChild(nameSpan);

        const textSpan = document.createElement('span');
        textSpan.className = 'lobby-chat-text';
        textSpan.innerText = message;
        msgDiv.appendChild(textSpan);

        chatArea.appendChild(msgDiv);
        chatArea.scrollTop = chatArea.scrollHeight;
    }

    /**
     * Render the players list
     * @param {Array} players
     */
    renderPlayersList(players) {
        const container = document.getElementById('lobbyPlayersList');
        if (!container) return;

        container.innerHTML = '';

        // Assign colors to players
        players.forEach(player => {
            appState.assignLobbyColor(player.username);
        });

        // Header with player count
        const header = document.createElement('div');
        header.className = 'lobby-players-header';
        header.innerText = `Players (${players.length}/4):`;
        container.appendChild(header);

        // Show existing players
        players.forEach(player => {
            const playerRow = document.createElement('div');
            playerRow.className = 'lobby-player-row';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'lobby-player-name';
            nameSpan.innerText = player.username;
            playerRow.appendChild(nameSpan);

            const statusSpan = document.createElement('span');
            statusSpan.className = 'lobby-player-status';
            if (player.ready) {
                statusSpan.innerText = '✓ Ready';
                statusSpan.classList.add('ready');
            } else {
                statusSpan.innerText = 'Waiting...';
            }
            playerRow.appendChild(statusSpan);

            container.appendChild(playerRow);
        });

        // Show empty slots
        for (let i = players.length; i < 4; i++) {
            const emptyRow = document.createElement('div');
            emptyRow.className = 'lobby-player-row empty';

            const emptySpan = document.createElement('span');
            emptySpan.className = 'lobby-player-name empty';
            emptySpan.innerText = '— Empty Slot —';
            emptyRow.appendChild(emptySpan);

            container.appendChild(emptyRow);
        }

        // Sync local ready state with server data
        const myPlayer = players.find(p => p.username === appState.username);
        if (myPlayer) {
            appState.isPlayerReady = myPlayer.ready;
        }

        // Update Ready button state
        this.updateReadyButtonState(players.length);
    }

    /**
     * Update ready button state based on player count
     * @param {number} playerCount
     */
    updateReadyButtonState(playerCount) {
        const readyBtn = document.getElementById('lobbyReadyBtn');
        if (!readyBtn) return;

        if (playerCount < 4) {
            // Not enough players - disable button
            readyBtn.disabled = true;
            readyBtn.classList.add('disabled');
            readyBtn.classList.remove('ready');
            readyBtn.innerText = `Waiting for ${4 - playerCount} more...`;
        } else if (appState.isPlayerReady) {
            // Player is ready
            readyBtn.disabled = false;
            readyBtn.classList.remove('disabled');
            readyBtn.classList.add('ready');
            readyBtn.innerText = 'Ready!';
        } else {
            // Player is not ready
            readyBtn.disabled = false;
            readyBtn.classList.remove('disabled');
            readyBtn.classList.remove('ready');
            readyBtn.innerText = 'Ready';
        }
    }

    /**
     * Hide the game lobby screen
     */
    hide() {
        this.cleanup();
    }

    /**
     * Clean up all resources
     */
    cleanup() {
        // Run all cleanup functions
        this.cleanupFunctions.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.error('Error in GameLobbyScreen cleanup:', e);
            }
        });
        this.cleanupFunctions = [];

        // Remove container
        uiManager.remove('gameLobbyContainer');
        this.container = null;
    }
}

// Export singleton
const gameLobbyScreen = new GameLobbyScreen();
export default gameLobbyScreen;
