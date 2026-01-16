/**
 * BAB Online - Main Entry Point
 * Orchestrates screen flow and initializes core modules
 */

import GameConfig from './config.js';
import socketManager from './socket/SocketManager.js';
import gameState from './game/GameState.js';
import appState from './state/AppState.js';
import uiManager from './ui/UIManager.js';
import mainRoomScreen from './ui/screens/MainRoomScreen.js';
import gameLobbyScreen from './ui/screens/GameLobbyScreen.js';
import drawPhaseScreen from './ui/screens/DrawPhaseScreen.js';
import GameScene from './scenes/GameScene.js';

// Store Phaser game reference
let game = null;

/**
 * Initialize the application
 */
async function init() {
    console.log('BAB Online initializing...');

    try {
        // Connect to socket server
        await socketManager.connect();
        console.log('Socket connected');

        // Setup all socket handlers
        setupAuthHandlers();
        setupMainRoomHandlers();
        setupLobbyHandlers();
        setupGameHandlers();
        setupReconnectionHandlers();

        // Show auth screen
        showAuthScreen();

    } catch (error) {
        console.error('Failed to initialize:', error);
        uiManager.showError('Failed to connect to server');
    }
}

// ========================================
// Socket Handlers Setup
// ========================================

/**
 * Setup socket handlers for authentication
 */
function setupAuthHandlers() {
    socketManager.on('signInSuccess', (data) => {
        console.log('Sign in successful:', data.username);
        handleAuthSuccess(data);
    });

    socketManager.on('signInFailed', (data) => {
        uiManager.showError(data.message || 'Sign in failed');
    });

    socketManager.on('signUpSuccess', (data) => {
        console.log('Sign up successful:', data.username);
        handleAuthSuccess(data);
    });

    socketManager.on('signUpFailed', (data) => {
        uiManager.showError(data.message || 'Sign up failed');
    });
}

/**
 * Setup socket handlers for main room
 */
function setupMainRoomHandlers() {
    socketManager.on('mainRoomJoined', (data) => {
        console.log('Joined main room:', data);
        hideAuthScreen();
        mainRoomScreen.show(data);
    });

    socketManager.on('lobbyCreated', (data) => {
        console.log('Lobby created:', data);
        mainRoomScreen.hide();
        gameLobbyScreen.show(data);
    });

    socketManager.on('lobbyJoined', (data) => {
        console.log('Joined lobby:', data);
        mainRoomScreen.hide();
        gameLobbyScreen.show(data);
    });
}

/**
 * Setup socket handlers for game lobby
 */
function setupLobbyHandlers() {
    socketManager.on('leftLobby', () => {
        console.log('Left lobby');
        gameLobbyScreen.hide();
        socketManager.emit('joinMainRoom');
    });

    socketManager.on('allPlayersReady', (data) => {
        console.log('All players ready, starting draw phase...');
        gameLobbyScreen.hide();
        startDrawPhase(data);
    });
}

/**
 * Setup socket handlers for game events
 */
function setupGameHandlers() {
    socketManager.on('gameStart', (data) => {
        console.log('Game starting:', data);
        if (data.gameId) {
            socketManager.setGameId(data.gameId);
        }
    });

    socketManager.on('gameEnd', (data) => {
        console.log('Game ended:', data);
        socketManager.clearGameId();
    });

    socketManager.on('positionUpdate', (data) => {
        console.log('Position update:', data);
        gameState.position = data.position;
        gameState.players = data.players;
    });

    socketManager.on('teamsAnnounced', (data) => {
        console.log('Teams announced:', data);
        // Draw phase screen handles this and transitions to game
    });
}

/**
 * Setup socket handlers for reconnection
 */
function setupReconnectionHandlers() {
    // Active game found on sign in
    socketManager.on('activeGameFound', (data) => {
        console.log('Active game found:', data);
        showRejoinPrompt(data);
    });

    // Rejoin success
    socketManager.on('rejoinSuccess', (data) => {
        console.log('Rejoin successful:', data);
        hideAuthScreen();
        handleRejoinSuccess(data);
    });

    // Rejoin failed
    socketManager.on('rejoinFailed', (data) => {
        console.log('Rejoin failed:', data.reason);
        socketManager.clearGameId();
        // Continue to main room
        socketManager.emit('joinMainRoom');
    });

    // Player disconnected notification
    socketManager.on('playerDisconnected', (data) => {
        console.log('Player disconnected:', data);
        showDisconnectedMessage(data);
    });

    // Player reconnected notification
    socketManager.on('playerReconnected', (data) => {
        console.log('Player reconnected:', data);
        hideDisconnectedMessage(data);
    });
}

// ========================================
// Auth Screen
// ========================================

/**
 * Show authentication screen
 */
function showAuthScreen() {
    const container = uiManager.createWithClass('auth-screen', 'div', 'auth-container');

    container.innerHTML = `
        <div class="auth-form" id="auth-form">
            <h2>BAB Online</h2>
            <div id="auth-error" class="auth-error" style="display: none;"></div>
            <input type="text" id="username-input" class="auth-input" placeholder="Username" autocomplete="username">
            <input type="password" id="password-input" class="auth-input" placeholder="Password" autocomplete="current-password">
            <button id="signin-btn" class="auth-button">Sign In</button>
            <span class="auth-link" id="toggle-auth">Need an account? Sign Up</span>
        </div>
    `;

    let isSignUp = false;

    const signinBtn = document.getElementById('signin-btn');
    const toggleAuth = document.getElementById('toggle-auth');
    const usernameInput = document.getElementById('username-input');
    const passwordInput = document.getElementById('password-input');

    uiManager.addEventListener(signinBtn, 'click', () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        if (!username || !password) {
            uiManager.showError('Please enter username and password');
            return;
        }

        if (isSignUp) {
            socketManager.emit('signUp', { username, password, pic: 1 });
        } else {
            socketManager.emit('signIn', { username, password });
        }
    });

    uiManager.addEventListener(toggleAuth, 'click', () => {
        isSignUp = !isSignUp;
        signinBtn.textContent = isSignUp ? 'Sign Up' : 'Sign In';
        toggleAuth.textContent = isSignUp ? 'Have an account? Sign In' : 'Need an account? Sign Up';
    });

    // Enter key to submit
    const handleEnterKey = (e) => {
        if (e.key === 'Enter') {
            signinBtn.click();
        }
    };
    uiManager.addEventListener(usernameInput, 'keypress', handleEnterKey);
    uiManager.addEventListener(passwordInput, 'keypress', handleEnterKey);
}

/**
 * Hide authentication screen
 */
function hideAuthScreen() {
    uiManager.remove('auth-screen');
}

/**
 * Handle successful authentication
 */
function handleAuthSuccess(data) {
    // Update game state
    gameState.username = data.username;
    gameState.pic = data.pic || 1;

    // Update app state
    appState.setUser(data.username, data.pic || 1);

    // Join main room
    socketManager.emit('joinMainRoom');
}

// ========================================
// Draw Phase & Game
// ========================================

/**
 * Start the draw phase
 * @param {Object} data - Initial data
 */
function startDrawPhase(data) {
    console.log('Starting draw phase...');

    // Initialize Phaser if not already done
    if (!game) {
        initPhaserGame();
    }

    // Wait for Phaser scene to be ready, then start draw phase
    const checkScene = setInterval(() => {
        const scene = game.scene.getScene('GameScene');
        if (scene && scene.scene.isActive()) {
            clearInterval(checkScene);
            drawPhaseScreen.show(scene, () => {
                console.log('Draw phase complete, starting main game...');
                appState.setScreen('game');
            });
        }
    }, 100);
}

/**
 * Initialize Phaser game instance
 */
function initPhaserGame() {
    // Create game container if it doesn't exist
    let container = document.getElementById('game-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'game-container';
        document.body.appendChild(container);
    }

    const config = {
        type: Phaser.AUTO,
        width: GameConfig.DESIGN_WIDTH,
        height: GameConfig.DESIGN_HEIGHT,
        parent: 'game-container',
        backgroundColor: '#1a472a',
        transparent: true,
        scale: {
            mode: Phaser.Scale.RESIZE,
            autoCenter: Phaser.Scale.CENTER_BOTH
        },
        scene: [GameScene]
    };

    game = new Phaser.Game(config);
    window.game = game; // Store for debugging

    console.log('Phaser game initialized');
}

// ========================================
// Reconnection
// ========================================

/**
 * Show rejoin prompt for active game
 * @param {Object} data - { gameId }
 */
function showRejoinPrompt(data) {
    const overlay = uiManager.createWithClass('rejoin-prompt', 'div', 'rejoin-prompt-overlay');

    overlay.innerHTML = `
        <div class="rejoin-prompt-content">
            <h2>Active Game Found</h2>
            <p>You have an active game in progress. Would you like to rejoin?</p>
            <div class="rejoin-prompt-buttons">
                <button id="rejoin-yes" class="rejoin-btn yes">Rejoin Game</button>
                <button id="rejoin-no" class="rejoin-btn no">Start Fresh</button>
            </div>
        </div>
    `;

    uiManager.addEventListener(document.getElementById('rejoin-yes'), 'click', () => {
        uiManager.remove('rejoin-prompt');
        socketManager.emit('rejoinGame', {
            gameId: data.gameId,
            username: appState.username
        });
    });

    uiManager.addEventListener(document.getElementById('rejoin-no'), 'click', () => {
        uiManager.remove('rejoin-prompt');
        socketManager.clearGameId();
        socketManager.emit('joinMainRoom');
    });
}

/**
 * Handle successful rejoin
 * @param {Object} data - Full game state from server
 */
function handleRejoinSuccess(data) {
    console.log('Handling rejoin with data:', data);

    // Update game state from server data
    gameState.position = data.position;
    gameState.myCards = data.hand || [];
    gameState.trump = data.trump;
    gameState.currentTurn = data.currentTurn;
    gameState.isBidding = data.bidding === 1;
    gameState.teamScore = data.teamScore || 0;
    gameState.oppScore = data.oppScore || 0;
    gameState.teamTricks = data.teamTricks || 0;
    gameState.oppTricks = data.oppTricks || 0;
    gameState.players = data.players;
    gameState.dealer = data.dealer;
    gameState.currentHand = data.currentHand;

    // Store game ID
    if (data.gameId) {
        socketManager.setGameId(data.gameId);
    }

    // Initialize Phaser and restore game
    appState.setScreen('game');
    initPhaserGame();

    // Wait for scene to be ready, then restore state
    const checkScene = setInterval(() => {
        const scene = game.scene.getScene('GameScene');
        if (scene && scene.scene.isActive()) {
            clearInterval(checkScene);
            scene.handleRejoin(data);
        }
    }, 100);
}

/**
 * Show player disconnected message
 * @param {Object} data - { position, username }
 */
function showDisconnectedMessage(data) {
    const msgId = `disconnected-${data.position}`;
    let msg = document.getElementById(msgId);

    if (!msg) {
        msg = uiManager.createWithClass(msgId, 'div', 'player-disconnected-message');
        msg.textContent = `${data.username} disconnected - waiting for reconnection...`;
    }
}

/**
 * Hide player disconnected message
 * @param {Object} data - { position, username }
 */
function hideDisconnectedMessage(data) {
    uiManager.remove(`disconnected-${data.position}`);
}

// ========================================
// Start Application
// ========================================

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for debugging
export { socketManager, gameState, appState, uiManager, game };
