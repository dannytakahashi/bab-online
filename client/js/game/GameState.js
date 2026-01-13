/**
 * Client-side game state container
 * Single source of truth for game data on the client
 * Replaces 50+ scattered global variables
 * Supports optimistic updates with rollback
 */
class GameState {
    constructor() {
        this.reset();
        this._listeners = new Map();  // event -> Set of callbacks
    }

    /**
     * Reset all state to initial values
     */
    reset() {
        // Player info
        this.playerId = null;
        this.username = null;
        this.position = null;
        this.pic = 1;

        // Hand info
        this.myCards = [];
        this.currentHand = 12;
        this.trump = null;
        this.dealer = 1;

        // Game phase
        this.phase = 'waiting';  // waiting, drawing, bidding, playing
        this.currentTurn = 1;
        this.leadPosition = 1;
        this.isBidding = true;

        // Trick state
        this.leadCard = null;
        this.playedCards = [null, null, null, null];  // indexed by position-1
        this.trumpBroken = false;
        this.cardsPlayedThisTrick = 0;

        // Bids
        this.bids = {};  // position -> bid value
        this.myBid = null;
        this.partnerBid = null;
        this.team1Mult = 1;
        this.team2Mult = 1;

        // Scores
        this.teamTricks = 0;
        this.oppTricks = 0;
        this.teamScore = 0;
        this.oppScore = 0;
        this.teamRainbows = 0;
        this.oppRainbows = 0;

        // Players info
        this.players = {};  // position -> { username, pic, socketId }

        // Optimistic update tracking
        this._pendingCard = null;      // Card being played (before server confirms)
        this._pendingBid = null;       // Bid being submitted (before server confirms)
    }

    /**
     * Update state from server sync message
     * @param {Object} data - Server state data
     */
    syncFromServer(data) {
        if (data.position !== undefined) this.position = data.position;
        if (data.hand !== undefined) this.myCards = [...data.hand];
        if (data.trump !== undefined) this.trump = data.trump;
        if (data.currentTurn !== undefined) this.currentTurn = data.currentTurn;
        if (data.bidding !== undefined) this.isBidding = data.bidding === 1;
        if (data.players !== undefined) this.players = { ...data.players };
        if (data.dealer !== undefined) this.dealer = data.dealer;
        if (data.currentHand !== undefined) this.currentHand = data.currentHand;
        if (data.leadPosition !== undefined) this.leadPosition = data.leadPosition;
    }

    /**
     * Get relative position for rendering
     * @param {number} absolutePos - Position 1-4
     * @returns {string} - 'self', 'partner', 'left', 'right'
     */
    getRelativePosition(absolutePos) {
        if (absolutePos === this.position) return 'self';
        if (absolutePos === this.getPartnerPosition()) return 'partner';

        // Determine left/right based on turn order
        const diff = (absolutePos - this.position + 4) % 4;
        return diff === 1 ? 'left' : 'right';
    }

    /**
     * Get partner's position (1&3 or 2&4 are partners)
     * @returns {number}
     */
    getPartnerPosition() {
        return ((this.position + 1) % 4) + 1;
    }

    /**
     * Get left opponent position
     * @returns {number}
     */
    getLeftPosition() {
        return (this.position % 4) + 1;
    }

    /**
     * Get right opponent position
     * @returns {number}
     */
    getRightPosition() {
        return ((this.position + 2) % 4) + 1;
    }

    /**
     * Check if it's this player's turn
     * @returns {boolean}
     */
    isMyTurn() {
        return this.currentTurn === this.position;
    }

    /**
     * Check if a position is on my team
     * @param {number} position - Position 1-4
     * @returns {boolean}
     */
    isTeammate(position) {
        return position === this.position || position === this.getPartnerPosition();
    }

    /**
     * Check if I'm on team 1 (positions 1 & 3)
     * @returns {boolean}
     */
    isTeam1() {
        return this.position === 1 || this.position === 3;
    }

    /**
     * Remove a card from my hand
     * @param {Object} card - Card to remove
     * @returns {boolean} - Whether card was found and removed
     */
    removeCard(card) {
        const index = this.myCards.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );
        if (index !== -1) {
            this.myCards.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Record a bid
     * @param {number} position - Position that bid
     * @param {number} bid - Bid value
     */
    recordBid(position, bid) {
        this.bids[position] = bid;
        if (position === this.position) {
            this.myBid = bid;
        } else if (position === this.getPartnerPosition()) {
            this.partnerBid = bid;
        }
    }

    /**
     * Get team bid total
     * @returns {number}
     */
    getTeamBid() {
        const myBid = this.bids[this.position] || 0;
        const partnerBid = this.bids[this.getPartnerPosition()] || 0;
        return myBid + partnerBid;
    }

    /**
     * Get opponent bid total
     * @returns {number}
     */
    getOpponentBid() {
        const leftBid = this.bids[this.getLeftPosition()] || 0;
        const rightBid = this.bids[this.getRightPosition()] || 0;
        return leftBid + rightBid;
    }

    /**
     * Clear trick state for new trick
     */
    clearTrick() {
        this.playedCards = [null, null, null, null];
        this.leadCard = null;
        this.cardsPlayedThisTrick = 0;
    }

    /**
     * Reset for new hand
     */
    resetForNewHand() {
        this.myCards = [];
        this.trump = null;
        this.bids = {};
        this.myBid = null;
        this.partnerBid = null;
        this.teamTricks = 0;
        this.oppTricks = 0;
        this.teamRainbows = 0;
        this.oppRainbows = 0;
        this.trumpBroken = false;
        this.isBidding = true;
        this.phase = 'bidding';
        this.clearTrick();
    }

    // ========================================
    // Optimistic Updates
    // ========================================

    /**
     * Optimistically play a card (before server confirms)
     * @param {Object} card - Card to play
     * @returns {boolean} - Whether card was found in hand
     */
    optimisticPlayCard(card) {
        const index = this.myCards.findIndex(c =>
            c.suit === card.suit && c.rank === card.rank
        );

        if (index === -1) return false;

        // Store for potential rollback
        this._pendingCard = this.myCards.splice(index, 1)[0];

        // Update local state
        this.playedCards[this.position - 1] = card;
        this.cardsPlayedThisTrick++;

        // Emit event for UI update
        this._emit('handChanged', this.myCards);

        return true;
    }

    /**
     * Confirm the pending card play (server accepted)
     */
    confirmCardPlay() {
        this._pendingCard = null;
    }

    /**
     * Rollback a rejected card play
     */
    rollbackCardPlay() {
        if (this._pendingCard) {
            // Put card back in hand
            this.myCards.push(this._pendingCard);

            // Remove from played cards
            this.playedCards[this.position - 1] = null;
            this.cardsPlayedThisTrick--;

            this._pendingCard = null;

            // Emit event for UI update
            this._emit('handChanged', this.myCards);
        }
    }

    /**
     * Optimistically record a bid (before server confirms)
     * @param {*} bid - Bid value
     */
    optimisticBid(bid) {
        this._pendingBid = bid;
        this.bids[this.position] = bid;
        this.myBid = bid;

        this._emit('bidChanged', { position: this.position, bid });
    }

    /**
     * Confirm the pending bid (server accepted)
     */
    confirmBid() {
        this._pendingBid = null;
    }

    /**
     * Rollback a rejected bid
     */
    rollbackBid() {
        if (this._pendingBid !== null) {
            delete this.bids[this.position];
            this.myBid = null;
            this._pendingBid = null;

            this._emit('bidChanged', { position: this.position, bid: null });
        }
    }

    /**
     * Check if there's a pending action
     * @returns {boolean}
     */
    hasPendingAction() {
        return this._pendingCard !== null || this._pendingBid !== null;
    }

    // ========================================
    // Event System (for UI updates)
    // ========================================

    /**
     * Subscribe to state changes
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     * @returns {Function} - Unsubscribe function
     */
    on(event, callback) {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(callback);

        return () => this.off(event, callback);
    }

    /**
     * Unsubscribe from state changes
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    off(event, callback) {
        const callbacks = this._listeners.get(event);
        if (callbacks) {
            callbacks.delete(callback);
        }
    }

    /**
     * Emit a state change event
     * @param {string} event - Event name
     * @param {*} data - Event data
     */
    _emit(event, data) {
        const callbacks = this._listeners.get(event);
        if (callbacks) {
            callbacks.forEach(cb => {
                try {
                    cb(data);
                } catch (err) {
                    console.error(`Error in ${event} listener:`, err);
                }
            });
        }
    }

    // ========================================
    // Debug
    // ========================================

    /**
     * Serialize state for debugging
     * @returns {Object}
     */
    toJSON() {
        return {
            position: this.position,
            username: this.username,
            phase: this.phase,
            currentTurn: this.currentTurn,
            isBidding: this.isBidding,
            handSize: this.myCards.length,
            trump: this.trump,
            teamScore: this.teamScore,
            oppScore: this.oppScore,
            hasPending: this.hasPendingAction()
        };
    }

    /**
     * Log current state (for debugging)
     */
    logState() {
        console.log('[GameState]', this.toJSON());
    }
}

// Singleton instance
const gameState = new GameState();
export default gameState;
