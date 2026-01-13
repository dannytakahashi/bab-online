import GameConfig from '../config.js';
import gameState from './GameState.js';

/**
 * Manages card sprites, interactions, and animations
 * Encapsulates all card-related Phaser logic
 */
export default class CardManager {
    constructor(scene) {
        this.scene = scene;
        this.cardSprites = [];          // Player's hand sprites
        this.playedCardSprites = [];    // Cards on table
        this.opponentCardSprites = {};  // Opponent card backs
        this.interactionEnabled = false;
    }

    /**
     * Display player's hand
     * @param {Array} cards - Array of card objects
     */
    displayHand(cards) {
        this.clearHand();

        const { width, height } = this.scene.scale;
        const cardWidth = GameConfig.CARD_WIDTH * GameConfig.CARD_SCALE;
        const overlap = cardWidth * 0.3;
        const totalWidth = cardWidth + (cards.length - 1) * (cardWidth - overlap);
        const startX = (width - totalWidth) / 2 + cardWidth / 2;
        const y = height - 100;

        cards.forEach((card, index) => {
            const x = startX + index * (cardWidth - overlap);
            const sprite = this.createCardSprite(card, x, y);
            sprite.setData('card', card);
            sprite.setData('index', index);
            sprite.setData('baseY', y);
            this.cardSprites.push(sprite);
        });

        this.updateCardDepths();
    }

    /**
     * Create a card sprite with interactions
     * @param {Object} card - Card data
     * @param {number} x - X position
     * @param {number} y - Y position
     * @returns {Phaser.GameObjects.Image}
     */
    createCardSprite(card, x, y) {
        const key = this.getCardTextureKey(card);

        // Try atlas first, fall back to individual image
        let sprite;
        if (this.scene.textures.exists('cards')) {
            sprite = this.scene.add.image(x, y, 'cards', key);
        } else {
            sprite = this.scene.add.image(x, y, key);
        }

        sprite.setScale(GameConfig.CARD_SCALE);
        sprite.setInteractive({ useHandCursor: true });

        // Hover effect - raise card
        sprite.on('pointerover', () => {
            if (this.interactionEnabled) {
                this.scene.tweens.add({
                    targets: sprite,
                    y: y - 30,
                    duration: GameConfig.ANIMATION.CARD_HOVER_DURATION,
                    ease: 'Power2'
                });
            }
        });

        sprite.on('pointerout', () => {
            const baseY = sprite.getData('baseY');
            this.scene.tweens.add({
                targets: sprite,
                y: baseY,
                duration: GameConfig.ANIMATION.CARD_HOVER_DURATION,
                ease: 'Power2'
            });
        });

        sprite.on('pointerdown', () => {
            if (this.interactionEnabled) {
                const cardData = sprite.getData('card');
                this.scene.events.emit('cardClicked', cardData);
            }
        });

        return sprite;
    }

    /**
     * Get texture key for a card
     * @param {Object} card - Card with suit and rank
     * @returns {string}
     */
    getCardTextureKey(card) {
        if (card.suit === 'joker') {
            return card.rank === 'HI' ? 'joker_red' : 'joker_black';
        }

        const rankMap = {
            'A': 'A', 'K': 'K', 'Q': 'Q', 'J': 'J',
            '10': '10', '9': '9', '8': '8', '7': '7',
            '6': '6', '5': '5', '4': '4', '3': '3', '2': '2'
        };

        // Format: rank_of_suit (e.g., "A_of_spades")
        return `${rankMap[card.rank]}_of_${card.suit}`;
    }

    /**
     * Update z-order of cards in hand
     */
    updateCardDepths() {
        this.cardSprites.forEach((sprite, index) => {
            sprite.setDepth(100 + index);
        });
    }

    /**
     * Animate playing a card to center
     * @param {Object} card - Card being played
     */
    playCard(card) {
        const sprite = this.cardSprites.find(s => {
            const c = s.getData('card');
            return c.suit === card.suit && c.rank === card.rank;
        });

        if (!sprite) return;

        // Remove from hand array
        const index = this.cardSprites.indexOf(sprite);
        this.cardSprites.splice(index, 1);

        // Animate to center
        const { width, height } = this.scene.scale;
        const centerOffset = this.getPlayedCardOffset('self');

        sprite.setDepth(200);

        this.scene.tweens.add({
            targets: sprite,
            x: width / 2 + centerOffset.x,
            y: height / 2 + centerOffset.y,
            duration: GameConfig.ANIMATION.CARD_PLAY_DURATION,
            ease: 'Power2',
            onComplete: () => {
                this.playedCardSprites.push(sprite);
            }
        });

        // Rearrange remaining cards
        this.repositionHand();
    }

    /**
     * Get offset for played card based on position
     * @param {string} relativePos - 'self', 'partner', 'left', 'right'
     * @returns {Object} - {x, y} offset
     */
    getPlayedCardOffset(relativePos) {
        const offsets = {
            self: { x: 0, y: 80 },
            partner: { x: 0, y: -80 },
            left: { x: -80, y: 0 },
            right: { x: 80, y: 0 }
        };
        return offsets[relativePos] || { x: 0, y: 0 };
    }

    /**
     * Reposition hand after card is played
     */
    repositionHand() {
        if (this.cardSprites.length === 0) return;

        const { width, height } = this.scene.scale;
        const cardWidth = GameConfig.CARD_WIDTH * GameConfig.CARD_SCALE;
        const overlap = cardWidth * 0.3;
        const totalWidth = cardWidth + (this.cardSprites.length - 1) * (cardWidth - overlap);
        const startX = (width - totalWidth) / 2 + cardWidth / 2;
        const y = height - 100;

        this.cardSprites.forEach((sprite, index) => {
            const targetX = startX + index * (cardWidth - overlap);
            sprite.setData('baseY', y);
            sprite.setData('index', index);

            this.scene.tweens.add({
                targets: sprite,
                x: targetX,
                y: y,
                duration: GameConfig.ANIMATION.HAND_REPOSITION_DURATION,
                ease: 'Power2'
            });
        });

        this.updateCardDepths();
    }

    /**
     * Animate opponent playing a card
     * @param {string} relativePos - 'partner', 'left', 'right'
     * @param {Object} card - Card played
     */
    animateOpponentCard(relativePos, card) {
        const { width, height } = this.scene.scale;

        const startPositions = {
            partner: { x: width / 2, y: 100 },
            left: { x: 100, y: height / 2 },
            right: { x: width - 100, y: height / 2 }
        };

        const startPos = startPositions[relativePos];
        const offset = this.getPlayedCardOffset(relativePos);
        const endPos = { x: width / 2 + offset.x, y: height / 2 + offset.y };

        // Create card sprite
        const key = this.getCardTextureKey(card);
        let sprite;
        if (this.scene.textures.exists('cards')) {
            sprite = this.scene.add.image(startPos.x, startPos.y, 'cards', key);
        } else {
            sprite = this.scene.add.image(startPos.x, startPos.y, key);
        }

        sprite.setScale(GameConfig.CARD_SCALE);
        sprite.setDepth(200);

        this.scene.tweens.add({
            targets: sprite,
            x: endPos.x,
            y: endPos.y,
            duration: GameConfig.ANIMATION.CARD_PLAY_DURATION,
            ease: 'Power2',
            onComplete: () => {
                this.playedCardSprites.push(sprite);
            }
        });
    }

    /**
     * Collect trick and animate cards to winner
     * @param {number} winnerPosition - Position 1-4 of winner
     */
    collectTrick(winnerPosition) {
        const relativePos = gameState.getRelativePosition(winnerPosition);
        const { width, height } = this.scene.scale;

        const targetPositions = {
            self: { x: width / 2, y: height + 100 },
            partner: { x: width / 2, y: -100 },
            left: { x: -100, y: height / 2 },
            right: { x: width + 100, y: height / 2 }
        };

        const target = targetPositions[relativePos];

        // Animate all played cards off screen
        this.scene.time.delayedCall(GameConfig.ANIMATION.TRICK_COLLECT_DELAY, () => {
            this.playedCardSprites.forEach(sprite => {
                this.scene.tweens.add({
                    targets: sprite,
                    x: target.x,
                    y: target.y,
                    alpha: 0,
                    duration: 500,
                    ease: 'Power2',
                    onComplete: () => sprite.destroy()
                });
            });
            this.playedCardSprites = [];

            // Clear played cards in game state
            gameState.clearTrick();
        });
    }

    /**
     * Check if a move is legal
     * @param {Object} card - Card to play
     * @returns {boolean}
     */
    isLegalMove(card) {
        // Find the lead card (first non-null in played cards)
        const leadCard = gameState.playedCards.find(c => c !== null);

        if (!leadCard) {
            // Leading - can't lead trump unless broken (or only have trump)
            const isTrump = card.suit === gameState.trump?.suit || card.suit === 'joker';
            if (isTrump && !gameState.trumpBroken) {
                // Check if we have non-trump
                const hasNonTrump = gameState.myCards.some(c =>
                    c.suit !== gameState.trump?.suit && c.suit !== 'joker'
                );
                return !hasNonTrump;
            }
            return true;
        }

        // Following - must follow suit if possible
        const leadSuit = leadCard.suit === 'joker' ? gameState.trump?.suit : leadCard.suit;
        const cardSuit = card.suit === 'joker' ? gameState.trump?.suit : card.suit;

        if (cardSuit !== leadSuit) {
            // Check if we're void in lead suit
            const hasSuit = gameState.myCards.some(c => {
                const s = c.suit === 'joker' ? gameState.trump?.suit : c.suit;
                return s === leadSuit;
            });
            return !hasSuit;
        }

        return true;
    }

    /**
     * Enable card interaction (player's turn)
     */
    enableInteraction() {
        this.interactionEnabled = true;
        this.cardSprites.forEach(sprite => {
            sprite.setTint(0xffffff);
            sprite.setAlpha(1);
        });
    }

    /**
     * Disable card interaction (not player's turn)
     */
    disableInteraction() {
        this.interactionEnabled = false;
        this.cardSprites.forEach(sprite => {
            sprite.setTint(0xaaaaaa);
            sprite.setAlpha(0.9);
        });
    }

    /**
     * Highlight legal moves
     */
    highlightLegalMoves() {
        this.cardSprites.forEach(sprite => {
            const card = sprite.getData('card');
            if (this.isLegalMove(card)) {
                sprite.setTint(0xffffff);
            } else {
                sprite.setTint(0x666666);
            }
        });
    }

    /**
     * Clear player's hand
     */
    clearHand() {
        this.cardSprites.forEach(sprite => sprite.destroy());
        this.cardSprites = [];
    }

    /**
     * Clear all cards from table
     */
    clearTable() {
        this.playedCardSprites.forEach(sprite => sprite.destroy());
        this.playedCardSprites = [];
    }

    /**
     * Clean up all sprites
     */
    destroy() {
        this.clearHand();
        this.clearTable();

        // Clean up opponent card sprites
        Object.values(this.opponentCardSprites).forEach(sprites => {
            if (Array.isArray(sprites)) {
                sprites.forEach(s => s.destroy());
            }
        });
        this.opponentCardSprites = {};
    }
}
