/**
 * BAB Online - Main Entry Point
 * Initializes Phaser game and socket connection
 */

import GameConfig from './config.js';
import socketManager from './socket/SocketManager.js';
import gameState from './game/GameState.js';
import uiManager from './ui/UIManager.js';
import GameScene from './scenes/GameScene.js';

/**
 * Initialize the application
 */
async function init() {
    console.log('BAB Online initializing...');

    try {
        // Connect to socket server
        await socketManager.connect();
        console.log('Socket connected');

        // Setup auth handlers
        setupAuthHandlers();

        // Show auth screen
        showAuthScreen();

    } catch (error) {
        console.error('Failed to initialize:', error);
        uiManager.showError('Failed to connect to server');
    }
}

/**
 * Setup socket handlers for authentication
 */
function setupAuthHandlers() {
    socketManager.on('signInSuccess', (data) => {
        console.log('Sign in successful:', data.username);
        gameState.username = data.username;
        gameState.pic = data.pic || 1;
        hideAuthScreen();
        showLobby();
    });

    socketManager.on('signInFailed', (data) => {
        uiManager.showError(data.message || 'Sign in failed');
    });

    socketManager.on('signUpSuccess', (data) => {
        console.log('Sign up successful:', data.username);
        gameState.username = data.username;
        gameState.pic = data.pic || 1;
        hideAuthScreen();
        showLobby();
    });

    socketManager.on('signUpFailed', (data) => {
        uiManager.showError(data.message || 'Sign up failed');
    });

    socketManager.on('queueUpdate', (data) => {
        updateQueueStatus(data);
    });

    socketManager.on('gameStart', (data) => {
        console.log('Game starting:', data);
        handleGameStart(data);
    });
}

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

    // Enter key to submit (on both username and password fields)
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
 * Show lobby/queue screen
 */
function showLobby() {
    const container = uiManager.createWithClass('lobby', 'div', 'lobby-container');

    container.innerHTML = `
        <h2 class="lobby-title">Welcome, ${gameState.username}!</h2>
        <button id="join-queue-btn" class="queue-button">Find Game</button>
        <div id="queue-status" class="queue-status" style="display: none;">
            <p>Waiting for players... <span id="queue-count" class="queue-count">0</span>/4</p>
            <button id="leave-queue-btn" class="auth-button" style="margin-top: 10px; background: #dc2626;">Leave Queue</button>
        </div>
    `;

    const joinBtn = document.getElementById('join-queue-btn');
    const leaveBtn = document.getElementById('leave-queue-btn');
    const queueStatus = document.getElementById('queue-status');

    uiManager.addEventListener(joinBtn, 'click', () => {
        socketManager.emit('joinQueue');
        joinBtn.style.display = 'none';
        queueStatus.style.display = 'block';
    });

    uiManager.addEventListener(leaveBtn, 'click', () => {
        socketManager.emit('leaveQueue');
        joinBtn.style.display = 'block';
        queueStatus.style.display = 'none';
    });
}

/**
 * Update queue status display
 */
function updateQueueStatus(data) {
    const queueCount = document.getElementById('queue-count');
    if (queueCount) {
        queueCount.textContent = data.count || data.queueSize || 0;
    }
}

/**
 * Handle game start
 */
function handleGameStart(data) {
    console.log('Starting game with data:', data);

    // Hide lobby
    uiManager.remove('lobby');

    // Update game state with initial data
    if (data.position) gameState.position = data.position;
    if (data.players) gameState.players = data.players;

    // Initialize Phaser game
    initPhaserGame();
}

/**
 * Initialize Phaser game instance
 */
function initPhaserGame() {
    const config = {
        type: Phaser.AUTO,
        width: GameConfig.DESIGN_WIDTH,
        height: GameConfig.DESIGN_HEIGHT,
        parent: 'game-container',
        backgroundColor: '#1a472a',
        scale: {
            mode: Phaser.Scale.FIT,
            autoCenter: Phaser.Scale.CENTER_BOTH
        },
        scene: [GameScene]
    };

    // Store game instance globally for debugging
    window.game = new Phaser.Game(config);

    console.log('Phaser game initialized');
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for debugging
export { socketManager, gameState, uiManager };
