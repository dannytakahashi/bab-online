import GameConfig from '../config.js';
import socketManager from '../socket/SocketManager.js';
import gameState from '../game/GameState.js';
import CardManager from '../game/CardManager.js';
import uiManager from '../ui/UIManager.js';

/**
 * Main game scene handling card play and game flow
 * Properly manages Phaser lifecycle and socket listeners
 */
export default class GameScene extends Phaser.Scene {
    constructor() {
        super({ key: 'GameScene' });

        // Component managers
        this.cardManager = null;

        // Cleanup functions for socket listeners
        this.cleanupFunctions = [];

        // UI elements created in this scene
        this.turnIndicator = null;
        this.trumpDisplay = null;
    }

    preload() {
        // Show loading progress
        this.createLoadingBar();

        // Load card images
        this.loadCardAssets();
    }

    createLoadingBar() {
        const { width, height } = this.scale;

        const progressBox = this.add.graphics();
        progressBox.fillStyle(0x222222, 0.8);
        progressBox.fillRect(width / 2 - 160, height / 2 - 25, 320, 50);

        const progressBar = this.add.graphics();

        const loadingText = this.add.text(width / 2, height / 2 - 50, 'Loading...', {
            fontSize: '20px',
            color: '#ffffff'
        }).setOrigin(0.5);

        this.load.on('progress', (value) => {
            progressBar.clear();
            progressBar.fillStyle(0x4a90d9, 1);
            progressBar.fillRect(width / 2 - 150, height / 2 - 15, 300 * value, 30);
        });

        this.load.on('complete', () => {
            progressBar.destroy();
            progressBox.destroy();
            loadingText.destroy();
        });
    }

    loadCardAssets() {
        // Load background
        this.load.image('background', 'assets/background.png');
        this.load.image('cardBack', 'assets/card_back.png');

        // Load all card images
        const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
        const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

        suits.forEach(suit => {
            ranks.forEach(rank => {
                const key = `${rank}_of_${suit}`;
                this.load.image(key, `assets/${rank}_of_${suit}.png`);
            });
        });

        // Load jokers
        this.load.image('joker_red', 'assets/joker_red.png');
        this.load.image('joker_black', 'assets/joker_black.png');
    }

    create() {
        const { width, height } = this.scale;

        // Setup background
        this.add.image(width / 2, height / 2, 'background')
            .setDisplaySize(width, height);

        // Initialize card manager
        this.cardManager = new CardManager(this);

        // Setup socket event listeners
        this.setupSocketListeners();

        // Setup scene event listeners
        this.setupSceneEvents();

        // Create static UI elements
        this.createScoreDisplay();

        console.log('GameScene created');
    }

    setupSocketListeners() {
        // Track all listeners for cleanup
        this.cleanupFunctions.push(
            socketManager.on('yourHand', this.handleYourHand.bind(this)),
            socketManager.on('trumpCard', this.handleTrumpCard.bind(this)),
            socketManager.on('cardPlayed', this.handleCardPlayed.bind(this)),
            socketManager.on('updateTurn', this.handleUpdateTurn.bind(this)),
            socketManager.on('bidReceived', this.handleBidReceived.bind(this)),
            socketManager.on('doneBidding', this.handleDoneBidding.bind(this)),
            socketManager.on('trickComplete', this.handleTrickComplete.bind(this)),
            socketManager.on('handComplete', this.handleHandComplete.bind(this)),
            socketManager.on('gameEnd', this.handleGameEnd.bind(this)),
            socketManager.on('rainbow', this.handleRainbow.bind(this))
        );
    }

    setupSceneEvents() {
        // Listen for card clicks from CardManager
        this.events.on('cardClicked', this.onCardClicked, this);
    }

    createScoreDisplay() {
        const scoreContainer = uiManager.createWithClass('score-display', 'div', 'score-container');

        const myTeamLabel = gameState.isTeam1() ? 'Your Team' : 'Your Team';
        const oppTeamLabel = gameState.isTeam1() ? 'Opponents' : 'Opponents';

        scoreContainer.innerHTML = `
            <div class="score-team my-team">
                <div class="score-label">${myTeamLabel}</div>
                <div class="score-value" id="my-team-score">0</div>
                <div class="score-tricks" id="my-team-tricks">Tricks: 0</div>
            </div>
            <div class="score-team opp-team">
                <div class="score-label">${oppTeamLabel}</div>
                <div class="score-value" id="opp-team-score">0</div>
                <div class="score-tricks" id="opp-team-tricks">Tricks: 0</div>
            </div>
        `;
    }

    updateScoreDisplay() {
        const myScore = document.getElementById('my-team-score');
        const oppScore = document.getElementById('opp-team-score');
        const myTricks = document.getElementById('my-team-tricks');
        const oppTricks = document.getElementById('opp-team-tricks');

        if (myScore) myScore.textContent = gameState.teamScore;
        if (oppScore) oppScore.textContent = gameState.oppScore;
        if (myTricks) myTricks.textContent = `Tricks: ${gameState.teamTricks}`;
        if (oppTricks) oppTricks.textContent = `Tricks: ${gameState.oppTricks}`;
    }

    // Socket Event Handlers

    handleYourHand(data) {
        console.log('Received hand:', data.hand.length, 'cards');
        gameState.myCards = [...data.hand];
        this.cardManager.displayHand(gameState.myCards);

        // Enable interaction if it's our turn and not bidding
        if (gameState.isMyTurn() && !gameState.isBidding) {
            this.cardManager.enableInteraction();
        }
    }

    handleTrumpCard(data) {
        console.log('Trump card:', data.trump);
        gameState.trump = data.trump;
        this.displayTrumpCard(data.trump);
    }

    displayTrumpCard(trump) {
        // Create trump display in DOM
        let container = uiManager.get('trump-display');
        if (!container) {
            container = uiManager.createWithClass('trump-display', 'div', 'trump-display');
        }

        const key = this.cardManager.getCardTextureKey(trump);
        container.innerHTML = `
            <div class="trump-label">Trump</div>
            <img class="trump-card" src="assets/${key}.png" alt="Trump">
        `;
    }

    handleCardPlayed(data) {
        const { position, card } = data;
        console.log(`Position ${position} played:`, card);

        // Store in game state
        gameState.playedCards[position - 1] = card;
        gameState.cardsPlayedThisTrick++;

        // Check if trump is broken
        if (card.suit === gameState.trump?.suit || card.suit === 'joker') {
            gameState.trumpBroken = true;
        }

        // Get relative position for animation
        const relativePos = gameState.getRelativePosition(position);

        if (relativePos !== 'self') {
            // Animate opponent card
            this.cardManager.animateOpponentCard(relativePos, card);
        }
    }

    handleUpdateTurn(data) {
        gameState.currentTurn = data.turn;
        console.log('Turn updated to position:', data.turn);

        // Update turn indicator
        this.updateTurnIndicator(data.turn);

        // Enable/disable card interaction
        if (gameState.isMyTurn() && !gameState.isBidding) {
            this.cardManager.enableInteraction();
            this.cardManager.highlightLegalMoves();
        } else {
            this.cardManager.disableInteraction();
        }
    }

    updateTurnIndicator(position) {
        // Remove existing indicator
        uiManager.remove('turn-indicator');

        // Create new indicator at correct position
        const relativePos = gameState.getRelativePosition(position);
        const indicator = uiManager.createWithClass('turn-indicator', 'div', `turn-indicator ${relativePos}`);
    }

    handleBidReceived(data) {
        const { position, bid } = data;
        console.log(`Position ${position} bid:`, bid);

        gameState.recordBid(position, bid);
        this.showBidBubble(position, bid);
    }

    showBidBubble(position, bid) {
        const relativePos = gameState.getRelativePosition(position);
        const { width, height } = this.scale;

        // Calculate bubble position based on relative position
        const positions = {
            self: { x: width / 2, y: height - 250 },
            partner: { x: width / 2, y: 180 },
            left: { x: 180, y: height / 2 },
            right: { x: width - 180, y: height / 2 }
        };

        const pos = positions[relativePos];
        const bubbleId = `bid-bubble-${position}`;

        const bubble = uiManager.createWithClass(bubbleId, 'div', 'bid-bubble');
        bubble.textContent = bid;
        bubble.style.left = `${pos.x}px`;
        bubble.style.top = `${pos.y}px`;
        bubble.style.transform = 'translate(-50%, -50%)';

        // Remove after delay
        setTimeout(() => {
            uiManager.remove(bubbleId);
        }, GameConfig.TIMING.BID_BUBBLE_DURATION);
    }

    handleDoneBidding(data) {
        console.log('Bidding complete:', data);
        gameState.isBidding = false;
        gameState.phase = 'playing';
        gameState.team1Mult = data.team1Mult || 1;
        gameState.team2Mult = data.team2Mult || 1;

        // Hide bid UI
        uiManager.remove('bid-container');

        // Enable card interaction if it's our turn
        if (gameState.isMyTurn()) {
            this.cardManager.enableInteraction();
        }
    }

    handleTrickComplete(data) {
        const { winner, team1Tricks, team2Tricks } = data;
        console.log('Trick complete, winner:', winner);

        // Update game state
        if (gameState.isTeam1()) {
            gameState.teamTricks = team1Tricks;
            gameState.oppTricks = team2Tricks;
        } else {
            gameState.teamTricks = team2Tricks;
            gameState.oppTricks = team1Tricks;
        }

        // Update score display
        this.updateScoreDisplay();

        // Animate trick collection
        this.cardManager.collectTrick(winner);
    }

    handleHandComplete(data) {
        console.log('Hand complete:', data);

        // Update scores
        if (gameState.isTeam1()) {
            gameState.teamScore = data.team1Score;
            gameState.oppScore = data.team2Score;
        } else {
            gameState.teamScore = data.team2Score;
            gameState.oppScore = data.team1Score;
        }

        // Update display
        this.updateScoreDisplay();

        // Show hand summary modal
        this.showHandSummary(data);
    }

    showHandSummary(data) {
        const content = `
            <h2>Hand Complete</h2>
            <p>Your Team: ${gameState.isTeam1() ? data.team1Points : data.team2Points} points</p>
            <p>Opponents: ${gameState.isTeam1() ? data.team2Points : data.team1Points} points</p>
            <p>Total Score: ${gameState.teamScore} - ${gameState.oppScore}</p>
        `;

        uiManager.showModal('hand-summary', content, { className: 'hand-summary-modal' });

        // Auto-close after delay
        setTimeout(() => {
            uiManager.closeModal('hand-summary');
        }, 3000);
    }

    handleGameEnd(data) {
        console.log('Game ended:', data);

        const won = (gameState.isTeam1() && data.winner === 1) ||
                    (!gameState.isTeam1() && data.winner === 2);

        const container = uiManager.createWithClass('game-end', 'div', 'game-end-container');
        container.innerHTML = `
            <div class="game-end-content">
                <h1 class="game-end-title ${won ? 'win' : 'lose'}">
                    ${won ? 'Victory!' : 'Defeat'}
                </h1>
                <div class="game-end-scores">
                    Final Score: ${gameState.teamScore} - ${gameState.oppScore}
                </div>
                <button class="play-again-button" id="play-again-btn">Play Again</button>
            </div>
        `;

        uiManager.addEventListener(
            document.getElementById('play-again-btn'),
            'click',
            () => {
                uiManager.remove('game-end');
                gameState.reset();
                // Emit join queue or return to lobby
                socketManager.emit('joinQueue');
            }
        );
    }

    handleRainbow(data) {
        console.log('Rainbow!', data);

        const relativePos = gameState.getRelativePosition(data.position);
        const indicator = uiManager.createWithClass(`rainbow-${data.position}`, 'div', 'rainbow-indicator');
        indicator.textContent = 'RAINBOW!';

        // Position based on player
        const { width, height } = this.scale;
        const positions = {
            self: { x: width / 2, y: height - 300 },
            partner: { x: width / 2, y: 250 },
            left: { x: 250, y: height / 2 },
            right: { x: width - 250, y: height / 2 }
        };

        const pos = positions[relativePos];
        indicator.style.left = `${pos.x}px`;
        indicator.style.top = `${pos.y}px`;
        indicator.style.transform = 'translate(-50%, -50%)';

        // Remove after delay
        setTimeout(() => {
            uiManager.remove(`rainbow-${data.position}`);
        }, 3000);
    }

    // User Actions

    onCardClicked(card) {
        if (!gameState.isMyTurn() || gameState.isBidding) {
            return;
        }

        // Validate move
        if (!this.cardManager.isLegalMove(card)) {
            uiManager.showError('Illegal move - must follow suit!');
            return;
        }

        // Update local state
        gameState.removeCard(card);
        gameState.playedCards[gameState.position - 1] = card;

        // Send to server
        socketManager.emit('playCard', {
            card,
            position: gameState.position
        });

        // Animate card to center
        this.cardManager.playCard(card);

        // Disable interaction until our turn again
        this.cardManager.disableInteraction();
    }

    // Lifecycle

    shutdown() {
        console.log('GameScene shutting down');

        // Call all cleanup functions for socket listeners
        this.cleanupFunctions.forEach(cleanup => cleanup());
        this.cleanupFunctions = [];

        // Clean up scene events
        this.events.off('cardClicked', this.onCardClicked, this);

        // Destroy card manager
        this.cardManager?.destroy();
        this.cardManager = null;

        // Clean up UI elements
        uiManager.cleanupGameUI();

        console.log('GameScene shutdown complete');
    }
}
