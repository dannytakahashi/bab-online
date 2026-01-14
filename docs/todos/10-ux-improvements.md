# UX Improvements

## Overview
Improve the gameplay experience with better UI interactions, visual feedback, and responsive design. These improvements build on the completed infrastructure work to create a polished player experience.

## Critical Issues (All Resolved)

1. ~~**Hand progression bug** - Game ends after 1-card hand instead of continuing to 3→5→7→9→11→13~~ ✅
2. ~~**Card interaction** - Currently drag-based, should be click-based for better UX~~ ✅
3. ~~**Bidding UI** - Text input is error-prone, needs button-based interface~~ ✅
4. ~~**Card sorting** - Cards displayed in dealt order, should auto-sort by suit~~ ✅

---

## Task 1: Fix Hand Progression Bug ✅

**File**: `server/socket/gameHandlers.js` (lines 362-371)

**Current behavior**: After 1-card hand, `nextHandSize = 13` triggers game end

**Expected progression**:
```
12 → 10 → 8 → 6 → 4 → 2 → 1 → 3 → 5 → 7 → 9 → 11 → 13 → [game end]
```

**Fix**:
```javascript
// Calculate next hand size
let nextHandSize;
if (game.currentHand === 2) {
    nextHandSize = 1;
} else if (game.currentHand === 1) {
    nextHandSize = 3;  // Start going back up through odds
} else if (game.currentHand === 13) {
    nextHandSize = 0;  // Signal game end
} else if (game.currentHand % 2 === 0) {
    nextHandSize = game.currentHand - 2;  // Even: go down by 2
} else {
    nextHandSize = game.currentHand + 2;  // Odd (3,5,7,9,11): go up by 2
}
```

---

## Task 2: Card Interaction - Drag to Click ✅

**File**: `client/game.js` (legacy system)

**Current**: Cards are dragged to center table area to play them

**Change to**:
- Single click on a card plays it immediately
- Hover effect shows card is interactive (already exists - card rises 30px)
- Remove drag event handlers

**Implementation**:
1. Remove `setDraggable(true)` from card sprites
2. Remove `drag`, `dragstart`, `dragend` event handlers
3. Keep `pointerdown` handler that calls `playCard()`
4. Add `pointerover`/`pointerout` for hover effect (if not already present)

---

## Task 3: Card Auto-Sorting ✅

**File**: `client/game.js` (legacy system)

After dealing, sort cards automatically:

**Sort Order**:
- Trump suit always rightmost
- Remaining suits alternate by color
- Within each suit, sort low to high (2→A)
- Jokers appear rightmost (they are trump)

**Example** (trump = hearts):
```
[spades 2-A] [diamonds 2-A] [clubs 2-A] [hearts 2-A] [LO] [HI]
```

**Example** (trump = spades):
```
[hearts 2-A] [clubs 2-A] [diamonds 2-A] [spades 2-A] [LO] [HI]
```

**Implementation**:
```javascript
function getSuitOrder(trumpSuit) {
    // Alternating colors with trump last
    const orders = {
        'spades':   ['hearts', 'clubs', 'diamonds', 'spades'],
        'hearts':   ['spades', 'diamonds', 'clubs', 'hearts'],
        'diamonds': ['clubs', 'hearts', 'spades', 'diamonds'],
        'clubs':    ['diamonds', 'spades', 'hearts', 'clubs']
    };
    return orders[trumpSuit];
}

function sortHand(cards, trumpSuit) {
    const suitOrder = getSuitOrder(trumpSuit);
    const rankOrder = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

    return cards.sort((a, b) => {
        // Jokers go last (they're trump)
        if (a.suit === 'joker' && b.suit === 'joker') {
            return a.rank === 'LO' ? -1 : 1;
        }
        if (a.suit === 'joker') return 1;
        if (b.suit === 'joker') return -1;

        // Sort by suit order
        const suitDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
        if (suitDiff !== 0) return suitDiff;

        // Within suit, sort by rank
        return rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank);
    });
}
```

---

## Task 4: Bidding UI Overhaul ✅

**Files**:
- `client/game.js` (legacy system)
- `client/styles.css`

**Current**: Text input field accepting numbers or "B", "2B", etc.

**Change to**: Button grid with two rows

**Row 1 - Numeric bids**: Buttons 0 through hand size
```
[0] [1] [2] [3] [4] [5] [6] [7] [8] [9] [10] [11] [12]
```

**Row 2 - Bore bids**: Only show valid options
```
[B] [2B] [3B] [4B]
```

**Bore button logic**:
- `B` always available (unless someone already bid bore)
- `2B` only enabled if someone bid `B`
- `3B` only enabled if someone bid `2B`
- `4B` only enabled if someone bid `3B`

**CSS Classes**:
```css
.bid-grid {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    background: rgba(0, 0, 0, 0.8);
    border-radius: 8px;
}

.bid-row {
    display: flex;
    gap: 4px;
    justify-content: center;
    flex-wrap: wrap;
}

.bid-button {
    min-width: 44px;
    min-height: 44px;
    padding: 8px 12px;
    font-size: 16px;
    font-weight: bold;
    border: none;
    border-radius: 4px;
    background: #4a5568;
    color: white;
    cursor: pointer;
    transition: background 0.2s;
}

.bid-button:hover:not(:disabled) {
    background: #2d3748;
}

.bid-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.bid-button.bore {
    background: #c53030;
}

.bid-button.bore:hover:not(:disabled) {
    background: #9b2c2c;
}
```

---

## Task 5: Prevent Invalid Card Plays ✅

**File**: `client/game.js` (legacy system)

**Current**: Invalid cards are tinted dark (0x666666) but still clickable

**Change**:
1. Set `interactive: false` on illegal cards
2. Set cursor style to `not-allowed`
3. Add tint to indicate disabled state
4. Show tooltip explaining why card is illegal

**Implementation**:
```javascript
function updateCardInteractivity(cards, leadCard, trump, trumpBroken) {
    for (const cardSprite of cards) {
        const card = cardSprite.getData('card');
        const isLegal = isLegalMove(card, cards.map(c => c.getData('card')), leadCard, trump, trumpBroken);

        if (isLegal) {
            cardSprite.setInteractive({ cursor: 'pointer' });
            cardSprite.clearTint();
        } else {
            cardSprite.disableInteractive();
            cardSprite.setTint(0x666666);
            // Store reason for tooltip
            cardSprite.setData('disabledReason', getIllegalMoveReason(card, leadCard, trump, trumpBroken));
        }
    }
}

function getIllegalMoveReason(card, leadCard, trump, trumpBroken) {
    if (!leadCard) {
        // Leading
        if ((card.suit === trump.suit || card.suit === 'joker') && !trumpBroken) {
            return 'Cannot lead trump until broken';
        }
    } else {
        // Following
        const leadSuit = leadCard.suit === 'joker' ? trump.suit : leadCard.suit;
        return `Must follow ${leadSuit}`;
    }
    return 'Invalid move';
}
```

---

## Task 6: Chat Improvements ✅

**Files**:
- `client/game.js` (legacy system)
- `client/ui.js` (legacy system)

**Improvements**:

1. **Fix message truncation**:
```css
.chat-message {
    word-wrap: break-word;
    overflow-wrap: break-word;
    max-width: 100%;
}
```

2. **Add timestamps**:
```javascript
function formatMessage(username, message) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `[${time}] ${username}: ${message}`;
}
```

3. **Add player colors**:
```css
.chat-message[data-position="1"],
.chat-message[data-position="3"] {
    color: #63b3ed;  /* Team 1 - blue */
}

.chat-message[data-position="2"],
.chat-message[data-position="4"] {
    color: #fc8181;  /* Team 2 - red */
}
```

---

## Task 7: UI Scaling & Styling ✅

**Files**:
- `client/styles.css`

**Changes**:

1. **Replace hardcoded pixels with viewport units**:
```css
/* Before */
.chat-container {
    width: 280px;
    height: 350px;
}

/* After */
.chat-container {
    width: min(280px, 25vw);
    height: min(350px, 40vh);
}
```

2. **Add responsive breakpoints**:
```css
/* Mobile */
@media (max-width: 768px) {
    .bid-button {
        min-width: 36px;
        min-height: 36px;
        padding: 6px 8px;
        font-size: 14px;
    }

    .chat-container {
        width: 100%;
        height: 30vh;
    }
}

/* Tablet */
@media (min-width: 769px) and (max-width: 1024px) {
    .bid-button {
        min-width: 40px;
        min-height: 40px;
    }
}
```

3. **Ensure touch targets (44px minimum)**

---

## Verification

All tasks implemented. Manual testing recommended:

- [x] Hand progression: Fixed - game now correctly goes 12→10→8→6→4→2→1→3→5→7→9→11→13→[end]
- [x] Card click: Single click plays card (no dragging)
- [x] Card sorting: Cards auto-sort with trump rightmost, alternating colors
- [x] Bidding UI: Button grid works, bore buttons enable/disable correctly
- [x] Invalid cards: Cannot click illegal cards (cards are tinted and non-interactive)
- [x] Chat: Long messages wrap, timestamps visible, player colors for teams
- [x] Scaling: Basic responsive styles added for mobile/tablet/desktop

---

## Implementation Notes

All changes were made to the **legacy system** (`client/game.js`, `client/ui.js`, `client/styles.css`) since that's what `index.html` currently loads. The modular system (`client/js/`) remains unchanged but has similar patterns that could be migrated later.
