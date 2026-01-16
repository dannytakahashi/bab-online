/**
 * Main Room Screen
 * Global chat + lobby browser
 */
import socketManager from '../../socket/SocketManager.js';
import appState from '../../state/AppState.js';
import uiManager from '../UIManager.js';

class MainRoomScreen {
    constructor() {
        this.cleanupFunctions = [];
        this.container = null;
    }

    /**
     * Show the main room screen
     * @param {Object} data - Initial data from server (onlineCount, messages, lobbies)
     */
    show(data = {}) {
        console.log('Showing main room...', data);

        // Clean up any existing instance
        this.cleanup();

        // Reset color assignments for new session
        appState.mainRoomUserColors = {};

        // Update app state
        appState.setScreen('mainRoom');
        appState.onlineCount = data.onlineCount || 0;
        appState.updateLobbies(data.lobbies || []);

        // Create main container
        this.container = uiManager.createWithClass('mainRoomContainer', 'div', 'main-room-container');
        this.container.innerHTML = this.getTemplate(data);
        document.body.appendChild(this.container);

        // Add existing messages
        if (data.messages && data.messages.length > 0) {
            const chatMessages = document.getElementById('mainRoomChatMessages');
            data.messages.forEach(msg => {
                this.appendChatMessage(msg.username, msg.message);
            });
            setTimeout(() => { chatMessages.scrollTop = chatMessages.scrollHeight; }, 0);
        }

        // Setup event listeners
        this.setupEventListeners();

        // Setup socket handlers
        this.setupSocketHandlers();
    }

    /**
     * Get the HTML template for main room
     * @param {Object} data - Initial data
     * @returns {string} HTML template
     */
    getTemplate(data) {
        return `
            <div class="main-room-header">
                <div class="main-room-title">BAB Online</div>
                <div id="mainRoomOnlineCount" class="main-room-online-count">${data.onlineCount || 0} players online</div>
            </div>
            <div class="main-room-content">
                <div class="main-room-chat-panel">
                    <div class="panel-header">Global Chat</div>
                    <div id="mainRoomChatMessages" class="chat-messages"></div>
                    <div class="chat-input-row">
                        <input type="text" id="mainRoomChatInput" class="chat-input" placeholder="Type a message..." />
                        <button id="mainRoomSendBtn" class="chat-send-btn">Send</button>
                    </div>
                </div>
                <div class="main-room-lobby-panel">
                    <div class="panel-header lobby-header">Game Lobbies</div>
                    <button id="createGameBtn" class="create-game-btn">+ Create Game</button>
                    <div id="mainRoomLobbyList" class="lobby-list"></div>
                </div>
            </div>
        `;
    }

    /**
     * Setup DOM event listeners
     */
    setupEventListeners() {
        const chatInput = document.getElementById('mainRoomChatInput');
        const sendBtn = document.getElementById('mainRoomSendBtn');
        const createGameBtn = document.getElementById('createGameBtn');

        // Send chat on Enter
        const handleKeydown = (e) => {
            if (e.key === 'Enter' && chatInput.value.trim()) {
                socketManager.emit('mainRoomChat', { message: chatInput.value.trim() });
                chatInput.value = '';
            }
        };
        chatInput.addEventListener('keydown', handleKeydown);
        this.cleanupFunctions.push(() => chatInput.removeEventListener('keydown', handleKeydown));

        // Send button click
        const handleSend = () => {
            if (chatInput.value.trim()) {
                socketManager.emit('mainRoomChat', { message: chatInput.value.trim() });
                chatInput.value = '';
            }
        };
        sendBtn.addEventListener('click', handleSend);
        this.cleanupFunctions.push(() => sendBtn.removeEventListener('click', handleSend));

        // Create game button
        const handleCreate = () => {
            socketManager.emit('createLobby', {});
        };
        createGameBtn.addEventListener('click', handleCreate);
        this.cleanupFunctions.push(() => createGameBtn.removeEventListener('click', handleCreate));

        // Initial lobby list render
        this.renderLobbyList(appState.availableLobbies);
    }

    /**
     * Setup socket event handlers
     */
    setupSocketHandlers() {
        // Chat message received
        this.cleanupFunctions.push(
            socketManager.on('mainRoomMessage', (data) => {
                this.appendChatMessage(data.username, data.message);
            })
        );

        // Lobbies updated
        this.cleanupFunctions.push(
            socketManager.on('lobbiesUpdated', (data) => {
                appState.updateLobbies(data.lobbies || data);
                this.renderLobbyList(appState.availableLobbies);
            })
        );

        // Online count updated
        this.cleanupFunctions.push(
            socketManager.on('mainRoomPlayerJoined', (data) => {
                this.updateOnlineCount(data.onlineCount);
            })
        );

        // Player left main room
        this.cleanupFunctions.push(
            socketManager.on('mainRoomPlayerLeft', (data) => {
                if (data.onlineCount !== undefined) {
                    this.updateOnlineCount(data.onlineCount);
                }
            })
        );
    }

    /**
     * Append a chat message to the chat area
     * @param {string} username
     * @param {string} message
     */
    appendChatMessage(username, message) {
        const chatMessages = document.getElementById('mainRoomChatMessages');
        if (!chatMessages) return;

        // Assign color if new user
        const color = appState.assignMainRoomColor(username);

        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'chat-username';
        nameSpan.innerText = username + ': ';
        nameSpan.style.color = color;
        msgDiv.appendChild(nameSpan);

        const textSpan = document.createElement('span');
        textSpan.className = 'chat-text';
        textSpan.innerText = message;
        msgDiv.appendChild(textSpan);

        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    /**
     * Render the lobby list
     * @param {Array} lobbies
     */
    renderLobbyList(lobbies) {
        const lobbyList = document.getElementById('mainRoomLobbyList');
        if (!lobbyList) return;

        lobbyList.innerHTML = '';

        if (!lobbies || lobbies.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'lobby-empty-message';
            emptyMsg.innerText = 'No active lobbies. Create one!';
            lobbyList.appendChild(emptyMsg);
            return;
        }

        lobbies.forEach(lobby => {
            const card = this.createLobbyCard(lobby);
            lobbyList.appendChild(card);
        });
    }

    /**
     * Create a lobby card element
     * @param {Object} lobby
     * @returns {HTMLElement}
     */
    createLobbyCard(lobby) {
        const card = document.createElement('div');
        card.className = 'lobby-card';

        // Info row
        const infoRow = document.createElement('div');
        infoRow.className = 'lobby-card-info';

        const lobbyName = document.createElement('span');
        lobbyName.className = 'lobby-card-name';
        lobbyName.innerText = lobby.name || `Lobby ${lobby.id.slice(0, 6)}`;
        infoRow.appendChild(lobbyName);

        const playerCount = document.createElement('span');
        playerCount.className = 'lobby-card-count';
        playerCount.innerText = `${lobby.playerCount}/4`;
        if (lobby.playerCount >= 4) {
            playerCount.classList.add('full');
        }
        infoRow.appendChild(playerCount);

        card.appendChild(infoRow);

        // Player names
        const playerNames = document.createElement('div');
        playerNames.className = 'lobby-card-players';
        playerNames.innerText = lobby.players.map(p => p.username).join(', ');
        card.appendChild(playerNames);

        // Join button
        const joinBtn = document.createElement('button');
        joinBtn.className = 'lobby-join-btn';

        if (lobby.playerCount >= 4) {
            joinBtn.innerText = 'Full';
            joinBtn.disabled = true;
            joinBtn.classList.add('disabled');
        } else {
            joinBtn.innerText = 'Join';
            joinBtn.addEventListener('click', () => {
                socketManager.emit('joinLobby', { lobbyId: lobby.id });
            });
        }
        card.appendChild(joinBtn);

        return card;
    }

    /**
     * Update online count display
     * @param {number} count
     */
    updateOnlineCount(count) {
        appState.onlineCount = count;
        const countEl = document.getElementById('mainRoomOnlineCount');
        if (countEl) {
            countEl.innerText = `${count} players online`;
        }
    }

    /**
     * Hide the main room screen
     */
    hide() {
        this.cleanup();
    }

    /**
     * Clean up all resources
     */
    cleanup() {
        // Run all cleanup functions (event listeners and socket handlers)
        this.cleanupFunctions.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.error('Error in MainRoomScreen cleanup:', e);
            }
        });
        this.cleanupFunctions = [];

        // Remove container
        uiManager.remove('mainRoomContainer');
        this.container = null;
    }
}

// Export singleton
const mainRoomScreen = new MainRoomScreen();
export default mainRoomScreen;
