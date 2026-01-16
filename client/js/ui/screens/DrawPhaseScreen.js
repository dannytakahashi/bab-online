/**
 * Draw Phase Screen
 * Coordinates the "draw for deal" phase
 * Works with Phaser GameScene for card animations
 */
import socketManager from '../../socket/SocketManager.js';
import appState from '../../state/AppState.js';
import gameState from '../../game/GameState.js';
import uiManager from '../UIManager.js';

class DrawPhaseScreen {
    constructor() {
        this.cleanupFunctions = [];
        this.hasDrawn = false;
        this.drawnCards = []; // Track drawn cards for display
        this.onComplete = null; // Callback when draw phase completes
        this.phaserScene = null; // Reference to Phaser scene
    }

    /**
     * Initialize the draw phase
     * @param {Phaser.Scene} scene - The Phaser scene to use for animations
     * @param {Function} onComplete - Callback when draw phase completes
     */
    show(scene, onComplete) {
        console.log('Starting draw phase...');

        this.cleanup();
        this.phaserScene = scene;
        this.onComplete = onComplete;
        this.hasDrawn = false;
        this.drawnCards = [];

        appState.setScreen('draw');

        // Create title overlay
        this.createTitle();

        // Setup socket handlers
        this.setupSocketHandlers();

        // Create the card deck in Phaser
        this.createCardDeck();
    }

    /**
     * Create the "Draw for Deal" title
     */
    createTitle() {
        const title = uiManager.createWithClass('draw-title', 'div', 'draw-phase-title');
        title.innerText = 'Draw for Deal';
    }

    /**
     * Setup socket event handlers
     */
    setupSocketHandlers() {
        // Your draw result
        this.cleanupFunctions.push(
            socketManager.on('youDrew', (data) => {
                console.log('You drew:', data.card);
                // The playerDrew event handles display for all players
            })
        );

        // Any player drew (including self)
        this.cleanupFunctions.push(
            socketManager.on('playerDrew', (data) => {
                console.log(`${data.username} drew:`, data.card, 'order:', data.drawOrder);
                this.displayDrawnCard(data);
            })
        );

        // Teams announced - draw phase complete
        this.cleanupFunctions.push(
            socketManager.on('teamsAnnounced', (data) => {
                console.log('Teams announced:', data);
                this.showTeamsAnnouncement(data);
            })
        );

        // Position update (after teams)
        this.cleanupFunctions.push(
            socketManager.on('positionUpdate', (data) => {
                console.log('Position update:', data);
                gameState.position = data.position;
                gameState.players = data.players;
            })
        );
    }

    /**
     * Create the card deck in Phaser
     */
    createCardDeck() {
        if (!this.phaserScene) return;

        const scene = this.phaserScene;
        const { width, height } = scene.scale;
        const scaleFactorX = width / 1920;
        const scaleFactorY = height / 953;
        const startX = 400 * scaleFactorX;
        const startY = height / 2;
        const overlap = 20 * scaleFactorX;

        this.deckCards = [];

        // Create 54 face-down cards
        for (let i = 0; i < 54; i++) {
            const cardSprite = scene.add.image(width / 2 + 500 * scaleFactorX, startY, 'cardBack')
                .setScale(1.2)
                .setInteractive()
                .setDepth(100);

            // Animate cards spreading out
            scene.tweens.add({
                targets: cardSprite,
                x: startX + i * overlap,
                y: startY,
                duration: 750,
                ease: 'Power2',
                delay: 0
            });

            // Card click handler
            cardSprite.on('pointerdown', () => {
                if (this.hasDrawn) return;
                this.hasDrawn = true;

                console.log('Clicked card to draw');
                socketManager.emit('draw', { num: Math.floor(Math.random() * 54) });

                // Disable all cards
                this.deckCards.forEach(card => {
                    if (card.disableInteractive) card.disableInteractive();
                });
            });

            this.deckCards.push(cardSprite);
        }
    }

    /**
     * Display a drawn card with flip animation
     * @param {Object} data - Draw data (username, card, drawOrder)
     */
    displayDrawnCard(data) {
        if (!this.phaserScene) return;

        const scene = this.phaserScene;
        const { width, height } = scene.scale;
        const scaleFactorX = width / 1920;
        const scaleFactorY = height / 953;

        // Calculate display position based on draw order (1-4)
        const displayY = height / 2 - 200 * scaleFactorY;
        const displayStartX = width / 2 - 300 * scaleFactorX;
        const displaySpacing = 200 * scaleFactorX;
        const slotX = displayStartX + (data.drawOrder - 1) * displaySpacing;

        // Get texture key for the card
        const textureKey = this.getCardTextureKey(data.card);

        // Start position (center of deck)
        const startX = width / 2;
        const startY = height / 2;

        // Create card with back texture
        const drawnCard = scene.add.image(startX, startY, 'cardBack')
            .setScale(0.8)
            .setDepth(300);

        // Create username label
        const nameLabel = scene.add.text(slotX, displayY - 80 * scaleFactorY, data.username, {
            fontSize: `${24 * scaleFactorX}px`,
            fontStyle: 'bold',
            color: '#FFFFFF',
            stroke: '#000000',
            strokeThickness: 3
        }).setOrigin(0.5).setDepth(300);

        // Calculate midpoint for flip
        const midX = (startX + slotX) / 2;
        const midY = (startY + displayY) / 2;

        // Phase 1: Move to midpoint and scale X to 0 (flip start)
        scene.tweens.add({
            targets: drawnCard,
            x: midX,
            y: midY,
            scaleX: 0,
            scaleY: 1.1,
            duration: 250,
            ease: 'Power2',
            onComplete: () => {
                // Change texture at flip midpoint
                drawnCard.setTexture('cards', textureKey);

                // Phase 2: Scale X back and complete movement
                scene.tweens.add({
                    targets: drawnCard,
                    x: slotX,
                    y: displayY,
                    scaleX: 1.5,
                    scaleY: 1.5,
                    duration: 250,
                    ease: 'Power2'
                });
            }
        });

        this.drawnCards.push({ card: drawnCard, label: nameLabel });
    }

    /**
     * Get texture key for a card
     * @param {Object} card - Card object with suit and rank
     * @returns {string} Texture key
     */
    getCardTextureKey(card) {
        if (card.suit === 'joker') {
            return card.rank === 'HI' ? 'joker_red' : 'joker_black';
        }
        return `${card.rank}_of_${card.suit}`;
    }

    /**
     * Show teams announcement
     * @param {Object} data - Teams data
     */
    showTeamsAnnouncement(data) {
        // Create overlay
        const overlay = uiManager.createWithClass('teams-announcement', 'div', 'teams-announcement-overlay');

        // Format teams display
        const team1Names = data.team1.map(p => p.username).join(' & ');
        const team2Names = data.team2.map(p => p.username).join(' & ');

        overlay.innerHTML = `
            <div class="teams-announcement-content">
                <h1 class="teams-title">Teams</h1>
                <div class="teams-display">
                    <div class="team team-1">
                        <div class="team-label">Team 1</div>
                        <div class="team-players">${team1Names}</div>
                    </div>
                    <div class="team-vs">VS</div>
                    <div class="team team-2">
                        <div class="team-label">Team 2</div>
                        <div class="team-players">${team2Names}</div>
                    </div>
                </div>
            </div>
        `;

        // After delay, clean up and transition to game
        setTimeout(() => {
            this.transitionToGame();
        }, 3000);
    }

    /**
     * Transition to the main game phase
     */
    transitionToGame() {
        console.log('Transitioning to game phase...');

        // Clean up draw phase elements
        this.cleanupDrawPhase();

        // Call completion callback
        if (this.onComplete) {
            this.onComplete();
        }
    }

    /**
     * Clean up draw phase Phaser elements
     */
    cleanupDrawPhase() {
        // Destroy deck cards
        if (this.deckCards) {
            this.deckCards.forEach(card => {
                if (card && card.destroy) card.destroy();
            });
            this.deckCards = [];
        }

        // Destroy drawn card displays
        this.drawnCards.forEach(({ card, label }) => {
            if (card && card.destroy) card.destroy();
            if (label && label.destroy) label.destroy();
        });
        this.drawnCards = [];

        // Remove DOM elements
        uiManager.remove('draw-title');
        uiManager.remove('teams-announcement');
    }

    /**
     * Hide the draw phase screen
     */
    hide() {
        this.cleanup();
    }

    /**
     * Clean up all resources
     */
    cleanup() {
        // Run cleanup functions for socket handlers
        this.cleanupFunctions.forEach(fn => {
            try {
                fn();
            } catch (e) {
                console.error('Error in DrawPhaseScreen cleanup:', e);
            }
        });
        this.cleanupFunctions = [];

        // Clean up Phaser elements
        this.cleanupDrawPhase();

        this.phaserScene = null;
        this.onComplete = null;
    }
}

// Export singleton
const drawPhaseScreen = new DrawPhaseScreen();
export default drawPhaseScreen;
