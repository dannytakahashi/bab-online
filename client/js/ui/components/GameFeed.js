/**
 * Game Feed Component
 * Right sidebar with game log, scores, and in-game chat
 */
import socketManager from '../../socket/SocketManager.js';
import gameState from '../../game/GameState.js';
import uiManager from '../UIManager.js';

class GameFeed {
    constructor() {
        this.container = null;
        this.cleanupFunctions = [];
        this.resizeHandler = null;
    }

    /**
     * Show the game feed
     * @param {Phaser.Game} game - Reference to Phaser game for resize handling
     */
    show(game = null) {
        if (this.container) {
            console.log('Game feed already exists');
            return;
        }

        console.log('Creating game feed...');

        // Create container
        this.container = uiManager.createWithClass('gameFeed', 'div', 'chat-container');
        this.container.innerHTML = this.getTemplate();
        document.body.appendChild(this.container);

        // Setup event listeners
        this.setupEventListeners();

        // Setup socket handlers
        this.setupSocketHandlers();

        // Add initial message
        this.addMessage('Game started!');

        // Restrict game container width to make room for game log
        const gameContainer = document.getElementById('game-container');
        if (gameContainer) {
            gameContainer.classList.add('in-game');
        }

        // Setup resize handling for Phaser
        if (game) {
            this.setupResizeHandler(game);
        }

        // Force initial resize
        this.triggerResize(game);
    }

    /**
     * Get the HTML template
     * @returns {string}
     */
    getTemplate() {
        return `
            <div class="chat-header">Game Log</div>
            <div id="gameLogScore" class="game-log-score">
                <div id="teamScoreDisplay" class="score-display team">
                    <div class="score-label">Your Team</div>
                    <div class="score-value">0</div>
                    <div class="score-tricks">Tricks: 0</div>
                </div>
                <div id="oppScoreDisplay" class="score-display opponent">
                    <div class="score-label">Opponents</div>
                    <div class="score-value">0</div>
                    <div class="score-tricks">Tricks: 0</div>
                </div>
            </div>
            <div id="gameFeedMessages" class="chat-messages"></div>
            <div class="chat-input-container">
                <input type="text" id="chatInput" class="chat-input" placeholder="Type a message..." />
                <button id="chatSendBtn" class="chat-send">Send</button>
            </div>
        `;
    }

    /**
     * Setup DOM event listeners
     */
    setupEventListeners() {
        const chatInput = document.getElementById('chatInput');
        const sendBtn = document.getElementById('chatSendBtn');

        const sendMessage = () => {
            const message = chatInput.value.trim();
            if (message !== '') {
                console.log('Sending message:', message);
                socketManager.emit('chatMessage', { message });
                chatInput.value = '';
            }
        };

        // Send on click
        const handleClick = () => sendMessage();
        sendBtn.addEventListener('click', handleClick);
        this.cleanupFunctions.push(() => sendBtn.removeEventListener('click', handleClick));

        // Send on Enter
        const handleKeydown = (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        };
        chatInput.addEventListener('keydown', handleKeydown);
        this.cleanupFunctions.push(() => chatInput.removeEventListener('keydown', handleKeydown));
    }

    /**
     * Setup socket event handlers
     */
    setupSocketHandlers() {
        // Chat messages from other players
        this.cleanupFunctions.push(
            socketManager.on('chatMessage', (data) => {
                const playerName = data.username || 'Player';
                this.addMessage(`${playerName}: ${data.message}`, data.position);
            })
        );
    }

    /**
     * Setup window resize handler for Phaser
     * @param {Phaser.Game} game
     */
    setupResizeHandler(game) {
        this.resizeHandler = () => {
            const container = document.getElementById('game-container');
            if (container && game && game.scale) {
                const newWidth = container.clientWidth;
                const newHeight = container.clientHeight;
                console.log(`Game feed resize: ${newWidth}x${newHeight}`);
                game.scale.resize(newWidth, newHeight);
            }
        };

        window.addEventListener('resize', this.resizeHandler);
        this.cleanupFunctions.push(() => {
            window.removeEventListener('resize', this.resizeHandler);
        });
    }

    /**
     * Trigger a resize event
     * @param {Phaser.Game} game
     */
    triggerResize(game) {
        requestAnimationFrame(() => {
            const container = document.getElementById('game-container');
            if (container && game && game.scale) {
                const newWidth = container.clientWidth;
                const newHeight = container.clientHeight;
                game.scale.resize(newWidth, newHeight);
                if (game.renderer && game.renderer.resize) {
                    game.renderer.resize(newWidth, newHeight);
                }
                game.scale.refresh();
            }
            window.dispatchEvent(new Event('resize'));
        });
    }

    /**
     * Add a message to the game feed
     * @param {string} message - Message text
     * @param {number|null} playerPosition - Position for color coding (null for system message)
     */
    addMessage(message, playerPosition = null) {
        const messagesArea = document.getElementById('gameFeedMessages');
        if (!messagesArea) return;

        // Get timestamp
        const now = new Date();
        const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Create message element
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message');
        if (playerPosition === null) {
            messageElement.classList.add('system');
        }

        // Add timestamp
        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-timestamp';
        timeSpan.innerText = `[${timestamp}] `;
        messageElement.appendChild(timeSpan);

        // Add message text with team color
        const msgSpan = document.createElement('span');
        msgSpan.className = 'chat-text';
        msgSpan.innerText = message;

        if (playerPosition !== null) {
            // Team 1 (positions 1, 3) = blue, Team 2 (positions 2, 4) = red
            if (playerPosition === 1 || playerPosition === 3) {
                msgSpan.classList.add('team-1');
            } else {
                msgSpan.classList.add('team-2');
            }
        }
        messageElement.appendChild(msgSpan);

        messagesArea.appendChild(messageElement);
        messagesArea.scrollTop = messagesArea.scrollHeight;
    }

    /**
     * Update the score display
     * @param {Object} scores - { teamScore, oppScore, teamTricks, oppTricks }
     */
    updateScore(scores = {}) {
        const teamScore = scores.teamScore ?? gameState.teamScore;
        const oppScore = scores.oppScore ?? gameState.oppScore;
        const teamTricks = scores.teamTricks ?? gameState.teamTricks;
        const oppTricks = scores.oppTricks ?? gameState.oppTricks;

        const teamDisplay = document.getElementById('teamScoreDisplay');
        const oppDisplay = document.getElementById('oppScoreDisplay');

        if (teamDisplay) {
            teamDisplay.querySelector('.score-value').innerText = teamScore;
            teamDisplay.querySelector('.score-tricks').innerText = `Tricks: ${teamTricks}`;
        }

        if (oppDisplay) {
            oppDisplay.querySelector('.score-value').innerText = oppScore;
            oppDisplay.querySelector('.score-tricks').innerText = `Tricks: ${oppTricks}`;
        }
    }

    /**
     * Add a system message (game events like bids, tricks, etc.)
     * @param {string} message
     */
    addSystemMessage(message) {
        this.addMessage(message, null);
    }

    /**
     * Add a bid message
     * @param {string} playerName
     * @param {*} bid
     * @param {number} position
     */
    addBidMessage(playerName, bid, position) {
        this.addMessage(`${playerName} bid ${bid}`, position);
    }

    /**
     * Add a trick won message
     * @param {string} playerName
     * @param {number} position
     */
    addTrickMessage(playerName, position) {
        this.addMessage(`${playerName} won the trick`, position);
    }

    /**
     * Hide the game feed
     */
    hide() {
        this.cleanup();
    }

    /**
     * Clean up all resources
     */
    cleanup() {
        // Run cleanup functions
        this.cleanupFunctions.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.error('Error in GameFeed cleanup:', e);
            }
        });
        this.cleanupFunctions = [];

        // Remove in-game class
        const gameContainer = document.getElementById('game-container');
        if (gameContainer) {
            gameContainer.classList.remove('in-game');
        }

        // Remove container
        uiManager.remove('gameFeed');
        this.container = null;
    }
}

export default GameFeed;
