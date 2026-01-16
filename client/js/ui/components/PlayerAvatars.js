/**
 * Player Avatars Component
 * DOM-based opponent avatars with CSS turn glow
 */
import gameState from '../../game/GameState.js';
import uiManager from '../UIManager.js';

class PlayerAvatars {
    constructor() {
        this.avatars = {}; // partner, opp1, opp2
        this.dealerButton = null;
        this.currentTurnPosition = null;
    }

    /**
     * Create avatars for all opponents
     * @param {Object} options - { players, dealer, phaserScene }
     */
    show(options = {}) {
        const { players, dealer, phaserScene } = options;

        console.log('Creating player avatars...');

        // Clean up existing avatars
        this.cleanup();

        // Get screen dimensions
        const container = document.getElementById('game-container');
        const screenWidth = container ? container.clientWidth : window.innerWidth;
        const screenHeight = container ? container.clientHeight : window.innerHeight;
        const scaleFactorX = screenWidth / 1920;
        const scaleFactorY = screenHeight / 953;

        // Calculate avatar positions
        const centerX = screenWidth / 2;
        const centerY = screenHeight / 2;

        const positions = {
            partner: {
                x: centerX,
                y: centerY - 400 * scaleFactorY
            },
            opp1: {
                x: centerX - 550 * scaleFactorX,
                y: centerY
            },
            opp2: {
                x: centerX + 550 * scaleFactorX,
                y: centerY
            }
        };

        // Create avatars for each opponent
        ['partner', 'opp1', 'opp2'].forEach(relativePos => {
            const absolutePos = this.getAbsolutePosition(relativePos);
            const player = this.getPlayerByPosition(players, absolutePos);

            if (player) {
                const avatar = this.createAvatar(relativePos, player.pic || 1, player.username);
                avatar.style.left = `${positions[relativePos].x}px`;
                avatar.style.top = `${positions[relativePos].y}px`;
                this.avatars[relativePos] = avatar;

                // Add dealer button if this player is dealer
                if (absolutePos === dealer && phaserScene) {
                    this.createDealerButton(phaserScene, positions[relativePos], relativePos, scaleFactorX, scaleFactorY);
                }
            }
        });

        // Create dealer button for self if we're dealer
        if (gameState.position === dealer && phaserScene) {
            this.createDealerButton(phaserScene, {
                x: centerX + 580 * scaleFactorX,
                y: centerY + 365 * scaleFactorY
            }, 'self', scaleFactorX, scaleFactorY);
        }
    }

    /**
     * Create a single avatar element
     * @param {string} relativePos - partner, opp1, opp2
     * @param {number} pic - Profile picture number
     * @param {string} username
     * @returns {HTMLElement}
     */
    createAvatar(relativePos, pic, username) {
        const container = uiManager.createWithClass(
            `opponent-avatar-${relativePos}`,
            'div',
            `opponent-avatar-container ${relativePos}`
        );

        const img = document.createElement('img');
        img.className = 'opponent-avatar-img';
        img.src = `assets/profile${pic}.png`;
        img.alt = username;

        const nameLabel = document.createElement('div');
        nameLabel.className = 'opponent-avatar-name';
        nameLabel.textContent = username;

        container.appendChild(img);
        container.appendChild(nameLabel);

        const gameContainer = document.getElementById('game-container');
        if (gameContainer) {
            gameContainer.appendChild(container);
        } else {
            document.body.appendChild(container);
        }

        return container;
    }

    /**
     * Create dealer button in Phaser
     * @param {Phaser.Scene} scene
     * @param {Object} position - { x, y }
     * @param {string} relativePos
     * @param {number} scaleFactorX
     * @param {number} scaleFactorY
     */
    createDealerButton(scene, position, relativePos, scaleFactorX, scaleFactorY) {
        // Offset based on position
        let offsetX = 0;
        if (relativePos === 'partner') {
            offsetX = 75 * scaleFactorX;
        } else if (relativePos === 'opp1') {
            offsetX = -75 * scaleFactorX;
        } else if (relativePos === 'opp2') {
            offsetX = 75 * scaleFactorX;
        }

        if (this.dealerButton) {
            this.dealerButton.destroy();
        }

        this.dealerButton = scene.add.image(position.x + offsetX, position.y, 'dealer')
            .setScale(0.03)
            .setDepth(250)
            .setAlpha(1);
    }

    /**
     * Update turn glow to indicate current player
     * @param {number} turnPosition - Absolute position (1-4) of current turn
     */
    updateTurnGlow(turnPosition) {
        this.currentTurnPosition = turnPosition;

        // Remove glow from all avatars
        Object.values(this.avatars).forEach(avatar => {
            if (avatar) {
                avatar.classList.remove('turn-glow');
            }
        });

        // Add glow to current turn player
        const relativePos = gameState.getRelativePosition(turnPosition);

        if (relativePos === 'self') {
            // Could add glow to player's own area if desired
            return;
        }

        const avatar = this.avatars[relativePos];
        if (avatar) {
            avatar.classList.add('turn-glow');
        }
    }

    /**
     * Clear turn glow from all avatars
     */
    clearTurnGlow() {
        Object.values(this.avatars).forEach(avatar => {
            if (avatar) {
                avatar.classList.remove('turn-glow');
            }
        });
    }

    /**
     * Get absolute position from relative position
     * @param {string} relativePos - partner, opp1, opp2
     * @returns {number} Absolute position 1-4
     */
    getAbsolutePosition(relativePos) {
        const myPos = gameState.position;

        if (relativePos === 'partner') {
            return gameState.getPartnerPosition();
        } else if (relativePos === 'opp1') {
            return gameState.getLeftPosition();
        } else if (relativePos === 'opp2') {
            return gameState.getRightPosition();
        }

        return myPos;
    }

    /**
     * Get player data by position
     * @param {Object|Array} players - Player data from game state
     * @param {number} position - Absolute position 1-4
     * @returns {Object|null} Player data
     */
    getPlayerByPosition(players, position) {
        if (!players) return null;

        if (Array.isArray(players)) {
            return players.find(p => p.position === position);
        }

        // Object with position as key
        return players[position];
    }

    /**
     * Reposition avatars on screen resize
     * @param {number} screenWidth
     * @param {number} screenHeight
     */
    reposition(screenWidth, screenHeight) {
        const scaleFactorX = screenWidth / 1920;
        const scaleFactorY = screenHeight / 953;
        const centerX = screenWidth / 2;
        const centerY = screenHeight / 2;

        const positions = {
            partner: { x: centerX, y: centerY - 400 * scaleFactorY },
            opp1: { x: centerX - 550 * scaleFactorX, y: centerY },
            opp2: { x: centerX + 550 * scaleFactorX, y: centerY }
        };

        Object.keys(this.avatars).forEach(key => {
            const avatar = this.avatars[key];
            if (avatar && positions[key]) {
                avatar.style.left = `${positions[key].x}px`;
                avatar.style.top = `${positions[key].y}px`;
            }
        });
    }

    /**
     * Clean up all avatars
     */
    cleanup() {
        // Remove DOM avatars
        Object.keys(this.avatars).forEach(key => {
            uiManager.remove(`opponent-avatar-${key}`);
        });
        this.avatars = {};

        // Destroy Phaser dealer button
        if (this.dealerButton && this.dealerButton.destroy) {
            this.dealerButton.destroy();
        }
        this.dealerButton = null;

        this.currentTurnPosition = null;
    }
}

export default PlayerAvatars;
