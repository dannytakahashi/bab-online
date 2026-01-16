/**
 * Bidding UI Component
 * Grid of bid buttons shown during bidding phase
 */
import socketManager from '../../socket/SocketManager.js';
import gameState from '../../game/GameState.js';
import uiManager from '../UIManager.js';

class BidUI {
    constructor() {
        this.container = null;
        this.cleanupFunctions = [];
        this.allBidButtons = [];
        this.boreButtons = {};
        this.selectedBid = null;
        this.existingBids = []; // Track bids that have been made
    }

    /**
     * Show the bidding UI
     * @param {Object} options - { handSize, position, onBid }
     */
    show(options = {}) {
        const { handSize = 12, position, onBid } = options;

        if (this.container) {
            // Just show if already exists
            this.container.style.display = 'flex';
            return;
        }

        console.log('Creating bidding UI...');

        // Create container
        this.container = uiManager.createWithClass('bidContainer', 'div', 'bid-container');
        this.container.innerHTML = this.getTemplate(handSize);
        document.body.appendChild(this.container);

        // Setup event listeners
        this.setupEventListeners(handSize, position, onBid);

        // Initial bore button state
        this.updateBoreButtons();
    }

    /**
     * Get the HTML template
     * @param {number} handSize - Number of cards in hand
     * @returns {string}
     */
    getTemplate(handSize) {
        // Create numeric buttons (0 to handSize)
        let numericButtons = '';
        for (let i = 0; i <= handSize; i++) {
            numericButtons += `<button class="bid-button numeric" data-bid="${i}">${i}</button>`;
        }

        return `
            <div class="bid-header">Your Bid:</div>
            <div class="bid-numeric-row">${numericButtons}</div>
            <div class="bid-bore-row">
                <button class="bid-button bore" data-bid="B">B</button>
                <button class="bid-button bore" data-bid="2B">2B</button>
                <button class="bid-button bore" data-bid="3B">3B</button>
                <button class="bid-button bore" data-bid="4B">4B</button>
            </div>
        `;
    }

    /**
     * Setup event listeners for bid buttons
     * @param {number} handSize
     * @param {number} position
     * @param {Function} onBid
     */
    setupEventListeners(handSize, position, onBid) {
        const container = this.container;

        // Get all bid buttons
        this.allBidButtons = Array.from(container.querySelectorAll('.bid-button'));

        // Get bore buttons specifically
        this.boreButtons = {
            'B': container.querySelector('[data-bid="B"]'),
            '2B': container.querySelector('[data-bid="2B"]'),
            '3B': container.querySelector('[data-bid="3B"]'),
            '4B': container.querySelector('[data-bid="4B"]')
        };

        // Setup click handlers for all buttons
        this.allBidButtons.forEach(btn => {
            const bid = btn.dataset.bid;

            const handleClick = () => {
                if (btn.disabled) return;

                // Check if it's our turn to bid
                if (!gameState.isMyTurn() || !gameState.isBidding) {
                    console.warn('Not your turn to bid');
                    return;
                }

                // Highlight selected button
                this.selectBidButton(btn, bid);

                // Emit bid to server
                console.log('Sending bid:', bid);
                socketManager.emit('playerBid', { position: gameState.position, bid });

                // Call callback if provided
                if (onBid) {
                    onBid(bid);
                }
            };

            btn.addEventListener('click', handleClick);
            this.cleanupFunctions.push(() => btn.removeEventListener('click', handleClick));

            // Hover effects
            const handleEnter = () => {
                if (!btn.disabled && this.selectedBid !== bid) {
                    btn.classList.add('hover');
                }
            };
            const handleLeave = () => {
                btn.classList.remove('hover');
            };

            btn.addEventListener('mouseenter', handleEnter);
            btn.addEventListener('mouseleave', handleLeave);
            this.cleanupFunctions.push(() => {
                btn.removeEventListener('mouseenter', handleEnter);
                btn.removeEventListener('mouseleave', handleLeave);
            });
        });
    }

    /**
     * Highlight the selected bid button
     * @param {HTMLElement} btn
     * @param {string} bidValue
     */
    selectBidButton(btn, bidValue) {
        // Remove selection from all buttons
        this.allBidButtons.forEach(b => {
            b.classList.remove('selected');
        });

        // Highlight selected button
        btn.classList.add('selected');
        this.selectedBid = bidValue;
    }

    /**
     * Record a bid (to update bore button availability)
     * @param {string} bid
     */
    recordBid(bid) {
        if (!this.existingBids.includes(bid)) {
            this.existingBids.push(bid);
            this.updateBoreButtons();
        }
    }

    /**
     * Update bore button states based on existing bids
     */
    updateBoreButtons() {
        const hasBore = this.existingBids.includes('B');
        const has2B = this.existingBids.includes('2B');
        const has3B = this.existingBids.includes('3B');
        const has4B = this.existingBids.includes('4B');

        // Enable/disable based on bid progression
        if (this.boreButtons['B']) {
            this.boreButtons['B'].disabled = hasBore;
        }
        if (this.boreButtons['2B']) {
            this.boreButtons['2B'].disabled = !hasBore || has2B;
        }
        if (this.boreButtons['3B']) {
            this.boreButtons['3B'].disabled = !has2B || has3B;
        }
        if (this.boreButtons['4B']) {
            this.boreButtons['4B'].disabled = !has3B || has4B;
        }

        // Update visual styles
        Object.values(this.boreButtons).forEach(btn => {
            if (btn) {
                if (btn.disabled) {
                    btn.classList.add('disabled');
                } else {
                    btn.classList.remove('disabled');
                }
            }
        });
    }

    /**
     * Reset the bid UI for a new hand
     * @param {number} handSize
     */
    reset(handSize) {
        this.selectedBid = null;
        this.existingBids = [];

        // Remove selection highlighting
        this.allBidButtons.forEach(btn => {
            btn.classList.remove('selected');
        });

        // Update bore buttons
        this.updateBoreButtons();
    }

    /**
     * Position the bid UI centered on screen
     * @param {number} x - Center X
     * @param {number} y - Center Y
     */
    setPosition(x, y) {
        if (this.container) {
            this.container.style.left = `${x}px`;
            this.container.style.top = `${y}px`;
        }
    }

    /**
     * Show the bid UI (if hidden)
     */
    showUI() {
        if (this.container) {
            this.container.style.display = 'flex';
        }
    }

    /**
     * Hide the bid UI
     */
    hide() {
        if (this.container) {
            this.container.style.display = 'none';
        }
    }

    /**
     * Check if visible
     * @returns {boolean}
     */
    isVisible() {
        return this.container && this.container.style.display !== 'none';
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
                console.error('Error in BidUI cleanup:', e);
            }
        });
        this.cleanupFunctions = [];

        // Remove container
        uiManager.remove('bidContainer');
        this.container = null;
        this.allBidButtons = [];
        this.boreButtons = {};
        this.selectedBid = null;
        this.existingBids = [];
    }
}

export default BidUI;
