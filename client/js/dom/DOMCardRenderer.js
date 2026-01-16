/**
 * DOMCardRenderer - Renders cards using DOM elements instead of Phaser sprites
 *
 * Handles:
 * - Player hand display with hover effects
 * - Opponent card backs
 * - Card play animations
 * - Trick collection
 * - Draw phase rendering
 */
class DOMCardRenderer {
    constructor(container) {
        this.container = container;
        this.handCards = [];           // Player's hand card elements
        this.playedCards = [];         // Cards on table this trick
        this.opponentHands = {};       // Opponent card backs by position
        this.trickPiles = {};          // Collected trick stacks
        this.interactionEnabled = false;

        // Draw phase elements
        this.drawDeckCards = [];       // Card backs for draw phase
        this.drawnCardDisplays = [];   // Revealed drawn cards with labels
        this.drawPhaseElements = [];   // All draw phase UI (title, etc.)
        this.hasDrawn = false;
        this.onDrawClick = null;
        this.clickedCardPosition = null;

        // Speech bubbles
        this.speechBubbles = [];

        // Scale factors (updated on resize)
        this.scaleX = 1;
        this.scaleY = 1;

        // Callbacks
        this.onCardClick = null;

        // Animation config (matches GameConfig.ANIMATION)
        this.ANIMATION = {
            CARD_PLAY_DURATION: 300,
            CARD_DEAL_STAGGER: 30,
            TRICK_COLLECT_DELAY: 2000,
            CARD_HOVER_DURATION: 150,
            HAND_REPOSITION_DURATION: 200
        };

        // Easing function matching Phaser's Power2
        this.EASING = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
    }

    /**
     * Update scale factors based on container size
     */
    updateScale(width, height) {
        const designWidth = 1920;
        const designHeight = 953;
        this.scaleX = width / designWidth;
        this.scaleY = height / designHeight;
    }

    /**
     * Get image filename for a card (matches actual asset file names)
     * Files are named like: ace_spades.png, 10_hearts.png, hi_joker.png
     */
    getCardImageKey(card) {
        if (card.suit === 'joker') {
            return card.rank === 'HI' ? 'hi_joker' : 'lo_joker';
        }

        // Convert rank to lowercase and handle face cards
        let rank = card.rank.toLowerCase();
        let suit = card.suit.toLowerCase();

        // Map single letter face cards to full names for file matching
        const rankMap = {
            'a': 'ace',
            'k': 'king',
            'q': 'queen',
            'j': 'jack'
        };

        if (rankMap[rank]) {
            rank = rankMap[rank];
        }

        return `${rank}_${suit}`;
    }

    /**
     * Create a face-up card element
     */
    createCard(card, options = {}) {
        const el = document.createElement('div');
        el.className = 'game-card';
        el.dataset.suit = card.suit;
        el.dataset.rank = card.rank;

        const imageKey = this.getCardImageKey(card);
        el.style.backgroundImage = `url(assets/${imageKey}.png)`;

        if (options.scale) {
            el.style.transform = `scale(${options.scale})`;
        }

        return el;
    }

    /**
     * Create a card back element
     */
    createCardBack() {
        const el = document.createElement('div');
        el.className = 'game-card card-back';
        el.style.backgroundImage = 'url(assets/card_back.png)';
        return el;
    }

    /**
     * Set up click and hover handlers for a hand card
     */
    setupCardInteraction(el, card) {
        el.addEventListener('click', (e) => {
            if (!this.interactionEnabled) return;
            if (el.classList.contains('disabled')) return;
            if (this.onCardClick) {
                this.onCardClick(card, el);
            }
        });

        // Hover is now handled purely by CSS :hover pseudo-class
    }

    /**
     * Display player's hand with optional deal animation
     */
    displayHand(cards, skipAnimation = false) {
        this.clearHand();

        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        // Card images are 64x64, scaled 1.5x = 96x96
        const cardWidth = 96 * this.scaleX;
        const cardSpacing = 50 * this.scaleX;
        const totalWidth = cards.length > 0 ? (cards.length - 1) * cardSpacing + cardWidth : 0;
        const startX = (width - totalWidth) / 2;
        const startY = height - 180 * this.scaleY;

        cards.forEach((card, index) => {
            const el = this.createCard(card);
            el.classList.add('in-hand');

            const targetX = startX + index * cardSpacing;
            const targetY = startY;

            // Store card data
            el.dataset.index = index;
            el.cardData = card;

            if (skipAnimation) {
                el.style.left = `${targetX}px`;
                el.style.top = `${targetY}px`;
            } else {
                // Start from trump/deck position (top right)
                const fromX = width / 2 + 400 * this.scaleX;
                const fromY = 100 * this.scaleY;

                el.style.left = `${fromX}px`;
                el.style.top = `${fromY}px`;
                el.style.opacity = '0';

                // Force reflow before animation
                el.offsetHeight;

                // Animate to position with stagger
                const animation = el.animate([
                    { left: `${fromX}px`, top: `${fromY}px`, opacity: 0 },
                    { left: `${targetX}px`, top: `${targetY}px`, opacity: 1 }
                ], {
                    duration: 750,
                    delay: index * this.ANIMATION.CARD_DEAL_STAGGER,
                    easing: this.EASING,
                    fill: 'forwards'
                });

                animation.onfinish = () => {
                    el.style.left = `${targetX}px`;
                    el.style.top = `${targetY}px`;
                    el.style.opacity = '1';
                };
            }

            el.style.zIndex = 100 + index;
            this.setupCardInteraction(el, card);
            this.container.appendChild(el);
            this.handCards.push(el);
        });
    }

    /**
     * Get position offset for played cards relative to center
     */
    getPlayedCardOffset(relativePos) {
        const offset = 80 * this.scaleX;
        const positions = {
            'self': { x: 0, y: offset },
            'partner': { x: 0, y: -offset },
            'left': { x: -offset, y: 0 },
            'right': { x: offset, y: 0 }
        };
        return positions[relativePos] || { x: 0, y: 0 };
    }

    /**
     * Get center play position for a card
     */
    getPlayPosition(relativePos) {
        const containerRect = this.container.getBoundingClientRect();
        const centerX = containerRect.width / 2;
        const centerY = containerRect.height / 2;
        const offset = this.getPlayedCardOffset(relativePos);

        return {
            x: centerX + offset.x - 75 * this.scaleX,  // Adjust for card width
            y: centerY + offset.y - 105 * this.scaleY  // Adjust for card height
        };
    }

    /**
     * Find card element in hand by card data
     */
    findCardElement(card) {
        return this.handCards.find(el =>
            el.cardData &&
            el.cardData.suit === card.suit &&
            el.cardData.rank === card.rank
        );
    }

    /**
     * Animate playing a card from hand to center
     */
    playCard(card, relativePos = 'self') {
        const el = this.findCardElement(card);
        if (!el) {
            console.warn('Card element not found:', card);
            return null;
        }

        // Remove from hand tracking
        const idx = this.handCards.indexOf(el);
        if (idx > -1) {
            this.handCards.splice(idx, 1);
        }

        // Get current and target positions
        const currentLeft = parseFloat(el.style.left) || 0;
        const currentTop = parseFloat(el.style.top) || 0;
        const target = this.getPlayPosition(relativePos);

        // Update classes
        el.classList.remove('in-hand', 'hovering');
        el.classList.add('playing', 'played');
        el.style.zIndex = 200 + this.playedCards.length;

        // Animate to center
        const animation = el.animate([
            { left: `${currentLeft}px`, top: `${currentTop}px` },
            { left: `${target.x}px`, top: `${target.y}px` }
        ], {
            duration: this.ANIMATION.CARD_PLAY_DURATION,
            easing: this.EASING,
            fill: 'forwards'
        });

        animation.onfinish = () => {
            el.style.left = `${target.x}px`;
            el.style.top = `${target.y}px`;
            el.classList.remove('playing');
        };

        this.playedCards.push(el);

        // Reposition remaining hand cards
        this.repositionHand();

        return el;
    }

    /**
     * Create and animate an opponent's card from their hand to center
     */
    animateOpponentCard(relativePos, card, opponentPos) {
        // Remove a card back from opponent's hand
        const hand = this.opponentHands[opponentPos];
        if (hand && hand.length > 0) {
            const cardBack = hand.pop();

            // Get positions
            const currentLeft = parseFloat(cardBack.style.left) || 0;
            const currentTop = parseFloat(cardBack.style.top) || 0;
            const target = this.getPlayPosition(relativePos);
            const midX = (currentLeft + target.x) / 2;
            const midY = (currentTop + target.y) / 2;

            cardBack.style.zIndex = 200 + this.playedCards.length;

            // Phase 1: Move halfway and start flip (scaleX to 0)
            const phase1 = cardBack.animate([
                {
                    left: `${currentLeft}px`,
                    top: `${currentTop}px`,
                    transform: cardBack.style.transform || 'none'
                },
                {
                    left: `${midX}px`,
                    top: `${midY}px`,
                    transform: 'scaleX(0)'
                }
            ], {
                duration: 250,
                easing: 'ease-in',
                fill: 'forwards'
            });

            phase1.onfinish = () => {
                // Change texture to face-up card
                const imageKey = this.getCardImageKey(card);
                cardBack.style.backgroundImage = `url(assets/${imageKey}.png)`;
                cardBack.classList.remove('card-back');
                cardBack.classList.add('played');

                // Phase 2: Complete flip and move to final position
                const phase2 = cardBack.animate([
                    {
                        left: `${midX}px`,
                        top: `${midY}px`,
                        transform: 'scaleX(0)'
                    },
                    {
                        left: `${target.x}px`,
                        top: `${target.y}px`,
                        transform: 'scaleX(1)'
                    }
                ], {
                    duration: 250,
                    easing: 'ease-out',
                    fill: 'forwards'
                });

                phase2.onfinish = () => {
                    cardBack.style.left = `${target.x}px`;
                    cardBack.style.top = `${target.y}px`;
                    cardBack.style.transform = 'scaleX(1)';
                };
            };

            this.playedCards.push(cardBack);
            return cardBack;
        }

        // Fallback: create card at target position directly
        const el = this.createCard(card);
        el.classList.add('played');
        const target = this.getPlayPosition(relativePos);
        el.style.left = `${target.x}px`;
        el.style.top = `${target.y}px`;
        el.style.zIndex = 200 + this.playedCards.length;
        this.container.appendChild(el);
        this.playedCards.push(el);
        return el;
    }

    /**
     * Reposition hand cards after one is played
     */
    repositionHand() {
        if (this.handCards.length === 0) return;

        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        const cardWidth = 96 * this.scaleX;
        const cardSpacing = 50 * this.scaleX;
        const totalWidth = (this.handCards.length - 1) * cardSpacing + cardWidth;
        const startX = (width - totalWidth) / 2;
        const startY = height - 180 * this.scaleY;

        this.handCards.forEach((el, index) => {
            const targetX = startX + index * cardSpacing;
            const targetY = startY;

            el.dataset.index = index;
            el.style.zIndex = 100 + index;

            el.animate([
                { left: el.style.left, top: el.style.top },
                { left: `${targetX}px`, top: `${targetY}px` }
            ], {
                duration: this.ANIMATION.HAND_REPOSITION_DURATION,
                easing: this.EASING,
                fill: 'forwards'
            }).onfinish = () => {
                el.style.left = `${targetX}px`;
                el.style.top = `${targetY}px`;
            };
        });
    }

    /**
     * Get trick pile position for collecting cards
     */
    getTrickPilePosition(relativePos) {
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        // Team's tricks go bottom-left, opponent tricks top-left
        if (relativePos === 'self' || relativePos === 'partner') {
            return {
                x: 20 * this.scaleX,
                y: height - 200 * this.scaleY
            };
        } else {
            return {
                x: 20 * this.scaleX,
                y: 100 * this.scaleY
            };
        }
    }

    /**
     * Collect all played cards to winner's trick pile
     */
    collectTrick(winnerRelativePos) {
        const target = this.getTrickPilePosition(winnerRelativePos);
        const cardsToCollect = [...this.playedCards];

        // Clear playedCards immediately to avoid race conditions with next trick
        // (new cards played during the delay will be added to a fresh array)
        this.playedCards = [];

        // Determine pile key (team or opponent)
        const pileKey = (winnerRelativePos === 'self' || winnerRelativePos === 'partner') ? 'team' : 'opponent';
        if (!this.trickPiles[pileKey]) {
            this.trickPiles[pileKey] = [];
        }

        // Calculate horizontal offset based on existing tricks
        const trickIndex = this.trickPiles[pileKey].length / 4;  // Each trick has ~4 cards
        const trickSpacing = 40 * this.scaleX;

        // Wait before collecting (matches existing delay)
        setTimeout(() => {
            cardsToCollect.forEach((card, index) => {
                const currentLeft = parseFloat(card.style.left) || 0;
                const currentTop = parseFloat(card.style.top) || 0;
                const finalX = target.x + trickIndex * trickSpacing + index * 3;
                const finalY = target.y + index * 2;

                card.animate([
                    {
                        left: `${currentLeft}px`,
                        top: `${currentTop}px`,
                        transform: 'scale(1)',
                        opacity: 1
                    },
                    {
                        left: `${finalX}px`,
                        top: `${finalY}px`,
                        transform: 'scale(0.5)',
                        opacity: 1
                    }
                ], {
                    duration: 500,
                    easing: this.EASING,
                    fill: 'forwards'
                }).onfinish = () => {
                    // Keep card in DOM but update its final position
                    card.style.left = `${finalX}px`;
                    card.style.top = `${finalY}px`;
                    card.style.transform = 'scale(0.5)';
                    card.style.zIndex = 50 + index;
                };

                // Add to trick pile storage
                this.trickPiles[pileKey].push(card);
            });
        }, this.ANIMATION.TRICK_COLLECT_DELAY);
    }

    /**
     * Display opponent hands (card backs)
     */
    displayOpponentHands(numCards, positions, skipAnimation = false) {
        this.clearOpponentHands();

        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        // Position configs for each opponent (matching Phaser's displayOpponentHands)
        const centerX = width / 2;
        const centerY = height / 2;
        const positionConfigs = {
            'partner': {
                baseX: centerX,
                baseY: centerY - 275 * this.scaleY,  // Match Phaser
                horizontal: true,
                spacing: 10 * this.scaleX,  // Match Phaser's cardSpacing
                rotation: 0
            },
            'left': {
                baseX: centerX - 425 * this.scaleX,  // Match Phaser
                baseY: centerY,
                horizontal: false,
                spacing: 10 * this.scaleY,
                rotation: Math.PI / 2  // 90 degrees
            },
            'right': {
                baseX: centerX + 425 * this.scaleX,  // Match Phaser
                baseY: centerY,
                horizontal: false,
                spacing: 10 * this.scaleY,
                rotation: -Math.PI / 2  // -90 degrees
            }
        };

        Object.entries(positionConfigs).forEach(([pos, config]) => {
            this.opponentHands[pos] = [];

            for (let i = 0; i < numCards; i++) {
                const el = this.createCardBack();
                el.classList.add('opponent-card', pos);

                let x, y;
                if (config.horizontal) {
                    const totalWidth = (numCards - 1) * config.spacing;
                    x = config.baseX - totalWidth / 2 + i * config.spacing;
                    y = config.baseY;
                } else {
                    const totalHeight = (numCards - 1) * config.spacing;
                    x = config.baseX;
                    y = config.baseY - totalHeight / 2 + i * config.spacing;
                }

                // Apply rotation for side opponents
                if (config.rotation !== 0) {
                    el.style.transform = `rotate(${config.rotation}rad)`;
                }

                // Card is 96px fixed in CSS, center it by offsetting by half (48px)
                const cardOffset = 48;

                if (skipAnimation) {
                    el.style.left = `${x - cardOffset}px`;
                    el.style.top = `${y - cardOffset}px`;
                } else {
                    // Animate from deck position
                    const fromX = width / 2 + 400 * this.scaleX;
                    const fromY = 100 * this.scaleY;

                    el.style.left = `${fromX}px`;
                    el.style.top = `${fromY}px`;
                    el.style.opacity = '0';

                    const targetX = x - cardOffset;
                    const targetY = y - cardOffset;

                    el.animate([
                        { left: `${fromX}px`, top: `${fromY}px`, opacity: 0 },
                        { left: `${targetX}px`, top: `${targetY}px`, opacity: 1 }
                    ], {
                        duration: 750,
                        delay: i * this.ANIMATION.CARD_DEAL_STAGGER,
                        easing: this.EASING,
                        fill: 'forwards'
                    }).onfinish = () => {
                        el.style.left = `${targetX}px`;
                        el.style.top = `${targetY}px`;
                        el.style.opacity = '1';
                    };
                }

                el.style.zIndex = 50 + i;
                this.container.appendChild(el);
                this.opponentHands[pos].push(el);
            }
        });
    }

    /**
     * Highlight legal moves in player's hand
     */
    highlightLegalMoves(legalCards) {
        this.handCards.forEach(el => {
            const card = el.cardData;
            const isLegal = legalCards.some(c =>
                c.suit === card.suit && c.rank === card.rank
            );

            if (isLegal) {
                el.classList.remove('disabled');
            } else {
                el.classList.add('disabled');
            }
        });
    }

    /**
     * Enable card interactions
     */
    enableInteraction() {
        this.interactionEnabled = true;
        this.handCards.forEach(el => {
            el.classList.add('interactive');
        });
    }

    /**
     * Disable card interactions
     */
    disableInteraction() {
        this.interactionEnabled = false;
        this.handCards.forEach(el => {
            el.classList.remove('interactive');
        });
    }

    /**
     * Reposition opponent hands (for window resize)
     */
    repositionOpponentHands() {
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        const centerX = width / 2;
        const centerY = height / 2;
        const cardSpacing = 10 * this.scaleX;
        const cardOffset = 48;  // Half of 96px card size (fixed, not scaled)

        // Position configs matching displayOpponentHands
        const positionConfigs = {
            'partner': {
                baseX: centerX,
                baseY: centerY - 275 * this.scaleY,
                horizontal: true
            },
            'left': {
                baseX: centerX - 425 * this.scaleX,
                baseY: centerY,
                horizontal: false
            },
            'right': {
                baseX: centerX + 425 * this.scaleX,
                baseY: centerY,
                horizontal: false
            }
        };

        Object.entries(this.opponentHands).forEach(([pos, cards]) => {
            const config = positionConfigs[pos];
            if (!config) return;

            const numCards = cards.length;
            cards.forEach((el, i) => {
                let x, y;
                if (config.horizontal) {
                    const totalWidth = (numCards - 1) * cardSpacing;
                    x = config.baseX - totalWidth / 2 + i * cardSpacing;
                    y = config.baseY;
                } else {
                    const totalHeight = (numCards - 1) * cardSpacing;
                    x = config.baseX;
                    y = config.baseY - totalHeight / 2 + i * cardSpacing;
                }

                el.style.left = `${x - cardOffset}px`;
                el.style.top = `${y - cardOffset}px`;
            });
        });
    }

    /**
     * Clear all hand cards
     */
    clearHand() {
        this.handCards.forEach(el => el.remove());
        this.handCards = [];
    }

    /**
     * Clear opponent hands
     */
    clearOpponentHands() {
        Object.values(this.opponentHands).forEach(hand => {
            hand.forEach(el => el.remove());
        });
        this.opponentHands = {};
    }

    /**
     * Clear played cards from table
     */
    clearTable() {
        this.playedCards.forEach(el => el.remove());
        this.playedCards = [];
    }

    /**
     * Clear trick piles
     */
    clearTrickPiles() {
        Object.values(this.trickPiles).forEach(pile => {
            pile.forEach(el => el.remove());
        });
        this.trickPiles = {};
    }

    // ==========================================================================
    // Draw Phase Methods
    // ==========================================================================

    /**
     * Display the draw deck (54 card backs spread out)
     */
    displayDrawDeck(onDrawClick) {
        this.clearDrawPhase();
        this.hasDrawn = false;
        this.onDrawClick = onDrawClick;

        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        const startX = 400 * this.scaleX;
        const startY = height / 2;
        const overlap = 20 * this.scaleX;

        // Add "Draw for Deal" title
        const title = document.createElement('div');
        title.className = 'draw-phase-title';
        title.textContent = 'Draw for Deal';
        title.style.cssText = `
            position: absolute;
            left: 50%;
            top: ${80 * this.scaleY}px;
            transform: translateX(-50%);
            font-size: ${48 * this.scaleX}px;
            font-weight: bold;
            color: #FFFFFF;
            text-shadow: 2px 2px 4px #000000;
            z-index: 200;
            pointer-events: none;
        `;
        this.container.appendChild(title);
        this.drawPhaseElements.push(title);

        // Create 54 card backs
        for (let i = 0; i < 54; i++) {
            const el = this.createCardBack();
            el.classList.add('draw-card');
            el.style.transform = 'scale(1.2)';
            el.style.zIndex = 100 + i;

            // Animate from right side to spread position
            const fromX = width / 2 + 500 * this.scaleX;
            const targetX = startX + i * overlap - 48;  // Offset by half card width
            const targetY = startY - 48;

            el.style.left = `${fromX}px`;
            el.style.top = `${targetY}px`;
            el.style.opacity = '0';

            // Store target position for click handling
            el.dataset.targetX = targetX;
            el.dataset.targetY = targetY;
            el.dataset.cardIndex = i;

            // Animate to position
            el.animate([
                { left: `${fromX}px`, opacity: 0 },
                { left: `${targetX}px`, opacity: 1 }
            ], {
                duration: 750,
                easing: this.EASING,
                fill: 'forwards'
            }).onfinish = () => {
                el.style.left = `${targetX}px`;
                el.style.opacity = '1';
            };

            // Click handler
            el.addEventListener('click', () => {
                if (this.hasDrawn) return;
                this.hasDrawn = true;

                // Store clicked position for animation
                this.clickedCardPosition = {
                    x: parseFloat(el.dataset.targetX),
                    y: parseFloat(el.dataset.targetY)
                };

                // Disable all cards
                this.drawDeckCards.forEach(card => {
                    card.style.pointerEvents = 'none';
                    card.classList.remove('draw-card');
                });

                // Callback with random card index
                if (this.onDrawClick) {
                    this.onDrawClick(Math.floor(Math.random() * 54));
                }
            });

            this.container.appendChild(el);
            this.drawDeckCards.push(el);
        }
    }

    /**
     * Handle a player drawing a card (animate and display)
     */
    handlePlayerDrew(username, card, drawOrder, isLocalPlayer) {
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        // Display positions for drawn cards (4 slots)
        const displayY = height / 2 - 200 * this.scaleY;
        const displayStartX = width / 2 - 300 * this.scaleX;
        const displaySpacing = 200 * this.scaleX;
        const slotX = displayStartX + (drawOrder - 1) * displaySpacing;

        // Start position
        const startPos = isLocalPlayer && this.clickedCardPosition
            ? this.clickedCardPosition
            : { x: width / 2, y: height / 2 };

        // Create card (starts as back)
        const cardEl = this.createCardBack();
        cardEl.style.left = `${startPos.x}px`;
        cardEl.style.top = `${startPos.y}px`;
        cardEl.style.transform = 'scale(0.8)';
        cardEl.style.zIndex = 300;
        this.container.appendChild(cardEl);

        // Create username label
        const label = document.createElement('div');
        label.className = 'drawn-card-label';
        label.textContent = username;
        label.style.cssText = `
            position: absolute;
            left: ${slotX + 48}px;
            top: ${displayY - 80 * this.scaleY}px;
            transform: translateX(-50%);
            font-size: ${24 * this.scaleX}px;
            font-weight: bold;
            color: #FFFFFF;
            text-shadow: 2px 2px 4px #000000;
            z-index: 300;
            pointer-events: none;
        `;
        this.container.appendChild(label);

        // Calculate midpoint for flip
        const midX = (startPos.x + slotX) / 2;
        const midY = (startPos.y + displayY) / 2;

        // Phase 1: Move to midpoint and flip (scaleX to 0)
        const phase1 = cardEl.animate([
            {
                left: `${startPos.x}px`,
                top: `${startPos.y}px`,
                transform: 'scale(0.8) scaleX(1)'
            },
            {
                left: `${midX}px`,
                top: `${midY}px`,
                transform: 'scale(1.1) scaleX(0)'
            }
        ], {
            duration: 250,
            easing: 'ease-in',
            fill: 'forwards'
        });

        phase1.onfinish = () => {
            // Change to face-up card
            const imageKey = this.getCardImageKey(card);
            cardEl.style.backgroundImage = `url(assets/${imageKey}.png)`;
            cardEl.classList.remove('card-back');

            // Phase 2: Complete flip and move to display slot
            const phase2 = cardEl.animate([
                {
                    left: `${midX}px`,
                    top: `${midY}px`,
                    transform: 'scale(1.1) scaleX(0)'
                },
                {
                    left: `${slotX}px`,
                    top: `${displayY}px`,
                    transform: 'scale(1.5) scaleX(1)'
                }
            ], {
                duration: 250,
                easing: 'ease-out',
                fill: 'forwards'
            });

            phase2.onfinish = () => {
                cardEl.style.left = `${slotX}px`;
                cardEl.style.top = `${displayY}px`;
                cardEl.style.transform = 'scale(1.5)';
            };
        };

        // Clear local clicked position after processing
        if (isLocalPlayer) {
            this.clickedCardPosition = null;
        }

        this.drawnCardDisplays.push(cardEl, label);
    }

    /**
     * Show teams announcement overlay
     */
    showTeamsAnnouncement(team1Players, team2Players, onComplete) {
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'teams-overlay';
        overlay.style.cssText = `
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 400;
        `;

        overlay.innerHTML = `
            <div class="teams-title" style="
                font-size: ${56 * this.scaleX}px;
                font-weight: bold;
                color: #FFD700;
                text-shadow: 2px 2px 4px #000000;
                margin-bottom: ${40 * this.scaleY}px;
            ">Teams</div>

            <div class="team1-section" style="text-align: center; margin-bottom: ${30 * this.scaleY}px;">
                <div style="
                    font-size: ${32 * this.scaleX}px;
                    font-weight: bold;
                    color: #4ade80;
                    margin-bottom: ${10 * this.scaleY}px;
                ">Team 1</div>
                <div style="
                    font-size: ${28 * this.scaleX}px;
                    color: #FFFFFF;
                ">${team1Players[0]} & ${team1Players[1]}</div>
            </div>

            <div class="vs-text" style="
                font-size: ${24 * this.scaleX}px;
                font-style: italic;
                color: #9ca3af;
                margin-bottom: ${30 * this.scaleY}px;
            ">vs</div>

            <div class="team2-section" style="text-align: center;">
                <div style="
                    font-size: ${32 * this.scaleX}px;
                    font-weight: bold;
                    color: #f87171;
                    margin-bottom: ${10 * this.scaleY}px;
                ">Team 2</div>
                <div style="
                    font-size: ${28 * this.scaleX}px;
                    color: #FFFFFF;
                ">${team2Players[0]} & ${team2Players[1]}</div>
            </div>
        `;

        this.container.appendChild(overlay);
        this.drawnCardDisplays.push(overlay);

        // Optional callback after display
        if (onComplete) {
            setTimeout(onComplete, 3000);
        }
    }

    /**
     * Clear draw phase elements
     */
    clearDrawPhase() {
        // Remove deck cards
        this.drawDeckCards.forEach(el => el.remove());
        this.drawDeckCards = [];

        // Remove drawn card displays and labels
        this.drawnCardDisplays.forEach(el => el.remove());
        this.drawnCardDisplays = [];

        // Remove other draw phase elements (title, etc.)
        this.drawPhaseElements.forEach(el => el.remove());
        this.drawPhaseElements = [];

        this.hasDrawn = false;
        this.clickedCardPosition = null;
        this.onDrawClick = null;
    }

    // ==========================================================================
    // Speech Bubble Methods
    // ==========================================================================

    /**
     * Show a speech bubble at a position
     * @param {string} relativePos - 'self', 'partner', 'left', 'right'
     * @param {string} text - Text to display
     * @param {object} options - { color, duration }
     */
    showSpeechBubble(relativePos, text, options = {}) {
        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;
        const height = containerRect.height;
        const centerX = width / 2;
        const centerY = height / 2;

        // Position configs for speech bubbles (near player positions)
        const positions = {
            'self': {
                x: width - 310 * this.scaleX,
                y: height - 270 * this.scaleY,
                pointer: 'pointer-top'
            },
            'partner': {
                x: centerX + 80 * this.scaleX,
                y: centerY - 380 * this.scaleY,
                pointer: 'pointer-bottom'
            },
            'left': {
                x: centerX - 480 * this.scaleX,
                y: centerY,
                pointer: 'pointer-right'
            },
            'right': {
                x: centerX + 620 * this.scaleX,
                y: centerY,
                pointer: 'pointer-left'
            }
        };

        const pos = positions[relativePos];
        if (!pos) return null;

        const bubble = document.createElement('div');
        bubble.className = `speech-bubble-dom ${pos.pointer}`;
        bubble.textContent = text;

        if (options.color === '#FF0000') {
            bubble.style.color = '#FF0000';
        }

        bubble.style.left = `${pos.x}px`;
        bubble.style.top = `${pos.y}px`;

        this.container.appendChild(bubble);
        this.speechBubbles.push(bubble);

        // Auto-remove after duration
        const duration = options.duration || 6000;
        setTimeout(() => {
            bubble.remove();
            const idx = this.speechBubbles.indexOf(bubble);
            if (idx > -1) this.speechBubbles.splice(idx, 1);
        }, duration);

        return bubble;
    }

    /**
     * Clear all speech bubbles
     */
    clearSpeechBubbles() {
        this.speechBubbles.forEach(el => el.remove());
        this.speechBubbles = [];
    }

    // ==========================================================================
    // Trump Card Display
    // ==========================================================================

    /**
     * Show trump card in corner
     */
    showTrumpCard(card) {
        // Remove existing trump display
        this.hideTrumpCard();

        const containerRect = this.container.getBoundingClientRect();
        const width = containerRect.width;

        const wrapper = document.createElement('div');
        wrapper.className = 'trump-card-dom';
        wrapper.id = 'trump-card-display';

        // Position top-right area
        const x = width / 2 + 400 * this.scaleX;
        const y = 100 * this.scaleY;

        wrapper.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            text-align: center;
            z-index: 150;
        `;

        // Label
        const label = document.createElement('div');
        label.className = 'trump-label';
        label.textContent = 'TRUMP';
        label.style.cssText = `
            color: #888;
            font-size: 14px;
            text-transform: uppercase;
            margin-bottom: 4px;
        `;

        // Card
        const cardEl = this.createCard(card);
        cardEl.style.position = 'relative';
        cardEl.style.transform = 'scale(1.5)';
        cardEl.style.pointerEvents = 'none';

        wrapper.appendChild(label);
        wrapper.appendChild(cardEl);
        this.container.appendChild(wrapper);
    }

    /**
     * Hide trump card display
     */
    hideTrumpCard() {
        const existing = document.getElementById('trump-card-display');
        if (existing) existing.remove();
    }

    /**
     * Full cleanup
     */
    destroy() {
        this.clearHand();
        this.clearOpponentHands();
        this.clearTable();
        this.clearTrickPiles();
        this.clearDrawPhase();
        this.clearSpeechBubbles();
        this.hideTrumpCard();
        this.onCardClick = null;
        this.onDrawClick = null;
    }
}

// Export for ES6 modules (if used) or attach to window for script tag usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DOMCardRenderer;
} else {
    window.DOMCardRenderer = DOMCardRenderer;
}
