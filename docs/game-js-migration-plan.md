# game.js Migration Plan

## Overview

Migrate `client/game.js` (3,127 lines) to the modular structure in `client/src/`.

**Goal:** Delete game.js and have index.html only load `dist/main.js`

**Approach:** Incremental migration - move one piece at a time, test after each change, keep game.js working until everything is migrated.

---

## Current State

### Global Variables (~50)
These need to move to `GameState.js`:

```javascript
// Core game state
let position, playerId, playerCards, trump
let currentTurn, dealer, bidding
let score1, score2, teamTricks, oppTricks
let isTrumpBroken, leadCard, leadPosition, leadBool
let playedCardIndex, playedCard, currentTrick, thisTrick

// Player info
let playerData  // { position: [], socket: [], username: [], pics: [] }
let myUsername, partner, opp1, opp2

// UI state
let gameScene, game  // Phaser references
let myCards  // Card sprites array
let opponentCardSprites  // Opponent card back sprites
let tableCardSprite  // Trump card display
let playerInfo  // Player info box
let scoreUI, handGlow
let activeChatBubbles  // Chat bubble tracking

// Bid state
let playerBids, tempBids
let currentTeamBids, currentOppBids
let rainbows  // Rainbow tracking

// Draw phase
let drawnCardDisplays, hasDrawn, clickedCardPosition

// Misc
let pendingRejoinData, pendingPositionData, pendingGameStartData
let gameListenersRegistered
let waitBool, queueDelay
let playPositions  // Card play position coordinates
let opponentAvatarDoms
```

### Socket Handlers (~20)
These need to move to `handlers/gameHandlers.js`:

| Event | Lines | Purpose |
|-------|-------|---------|
| `playerDisconnected` | 196-199 | Show disconnect message |
| `positionUpdate` | 915-922 | Set player positions |
| `gameStart` | 924-932 | Initialize game state |
| `rainbow` | 1250-1252 | Track rainbow hands |
| `destroyHands` | 1268-1285 | Clean up between hands |
| `youDrew` | 1380-1384 | Handle own draw card |
| `playerDrew` | 1386-1451 | Handle other player draw |
| `disconnect` | 1589-1592 | Handle socket disconnect |
| `abortGame` | 1594-1603 | Game cancelled |
| `forceLogout` | 1605-1614 | Kicked from server |
| `roomFull` | 1616-1619 | Queue full error |
| `gameEnd` | 1622-1668 | Game finished |
| `startDraw` | 1671-1673 | Begin draw phase |
| `teamsAnnounced` | 1675-1733 | Show team assignments |
| `chatMessage` | 1756-1793 | In-game chat |
| `createUI` | 1795-1809 | Create game UI elements |
| `bidReceived` | 2384-2466 | Handle bid from player |
| `updateTurn` | 2468-2502 | Turn changed |
| `cardPlayed` | 2504-2648 | Card was played |
| `trickComplete` | 2650-2769 | Trick finished |
| `doneBidding` | 2771-2905 | Bidding phase complete |
| `handComplete` | 2907-2956 | Hand finished, scores |

### Functions by Category

#### Phaser Scene (~200 lines)
```javascript
function preload()           // Asset loading
function create()            // Scene setup
function update()            // Game loop (empty)
```

#### Rendering - Cards (~600 lines)
```javascript
function displayCards()           // Player hand display
function displayOpponentHands()   // Opponent card backs
function displayTableCard()       // Trump card
function clearDisplayCards()      // Remove card sprites
function destroyAllCards()        // Destroy all cards
```

#### Rendering - UI (~400 lines)
```javascript
function createVignette()         // Background gradient
function createPlayerInfoBox()    // Player avatar/name
function createGameFeed()         // Game log panel
function addToGameFeed()          // Add log message
function updateGameLogScore()     // Update score display
function createOpponentAvatarDom() // Opponent avatars
function cleanupOpponentAvatars() // Remove avatars
```

#### Rendering - Effects (~200 lines)
```javascript
function createSpeechBubble()     // Chat bubbles
function showChatBubble()         // Display chat bubble
function showImpactEvent()        // Bore/event animations
function addTurnGlow()            // Turn indicator
function removeTurnGlow()         // Remove indicator
function addOpponentGlow()        // Opponent turn glow
function removeOpponentGlow()     // Remove glow
```

#### Draw Phase (~200 lines)
```javascript
function draw()                   // Draw phase UI
function removeDraw()             // Clean up draw phase
```

#### Repositioning (~300 lines)
```javascript
function repositionGameElements()    // Main resize handler
function repositionHandCards()       // Resize cards
function repositionOpponentElements() // Resize opponents
function repositionTurnGlow()        // Resize glow
function repositionCurrentTrick()    // Resize played cards
function updatePlayPositions()       // Update play coordinates
function positionDomBackgrounds()    // Position DOM elements
function cleanupDomBackgrounds()     // Clean up backgrounds
```

#### Game Logic Helpers (~100 lines)
```javascript
function processRejoin()          // Handle rejoin
function processPositionUpdate()  // Handle position data
function processGameStart()       // Handle game start
function team()                   // Get partner position
function rotate()                 // Get next position
function getPlayerName()          // Get username by position
function removeCard()             // Remove card from hand
function clearAllTricks()         // Reset trick state
function isLegalMove()            // Check card legality (wrapper)
function visible()                // Check page visibility
function clearScreen()            // Clear Phaser scene
```

---

## Migration Phases

### Phase 1: State Migration
Move global variables to `GameState.js` singleton.

**Files to modify:**
- `client/src/state/GameState.js` - Add new state properties
- `client/game.js` - Replace globals with `getGameState()` calls

**Steps:**
1. Add all game state properties to GameState class
2. Create getter/setter methods where needed
3. Replace each global in game.js with state access
4. Test after each batch of replacements

### Phase 2: Socket Handler Migration
Move socket handlers to `handlers/gameHandlers.js`.

**Files to modify:**
- `client/src/handlers/gameHandlers.js` - Add handler functions
- `client/src/handlers/index.js` - Register new handlers
- `client/game.js` - Remove migrated handlers

**Steps:**
1. Create handler function for each socket event
2. Handler updates GameState and calls rendering functions
3. Register handlers in index.js
4. Comment out handler in game.js, test
5. Delete commented handler once verified

### Phase 3: Card Rendering Migration
Move card display logic to `CardManager.js`.

**Files to modify:**
- `client/src/phaser/managers/CardManager.js` - Expand with display logic
- `client/game.js` - Replace card functions with CardManager calls

**Steps:**
1. Add displayHand() method to CardManager
2. Add displayOpponentHands() method
3. Add card animation methods
4. Wire up to socket handlers
5. Test card rendering

### Phase 4: UI Component Migration
Move remaining UI to components.

**Files to create:**
- `client/src/ui/components/OpponentDisplay.js`
- `client/src/ui/components/TurnIndicator.js`
- `client/src/phaser/managers/EffectsManager.js`

**Steps:**
1. Create component for each UI piece
2. Export via main.js bridge
3. Replace in game.js
4. Test each component

### Phase 5: Phaser Scene Migration
Create proper GameScene class.

**Files to create:**
- `client/src/phaser/scenes/GameScene.js` - Full scene class

**Steps:**
1. Create GameScene class extending Phaser.Scene
2. Move preload/create/update methods
3. Move resize handlers
4. Update Phaser config to use class
5. Test full game flow

### Phase 6: Final Cleanup
Remove game.js entirely.

**Steps:**
1. Verify all functionality works from modular code
2. Update main.js to initialize Phaser game
3. Remove game.js from index.html
4. Delete game.js file
5. Final testing

---

## Key Challenges

### 1. Phaser Scene Context
Many functions use `this` to refer to the Phaser scene. When moving to modules, need to either:
- Pass scene as parameter
- Store scene reference in singleton
- Use class methods with proper binding

### 2. Socket Handler Dependencies
Handlers depend on many globals. Migration order matters:
1. State first (so handlers can access it)
2. Rendering functions (so handlers can call them)
3. Handlers last (they orchestrate everything)

### 3. The Tinting Bug
There's a known bug where card tinting doesn't update after bidding until page refresh. This is likely related to:
- Phaser WebGL state not updating
- Sprite recreation timing
- The `forceRenderUpdate()` function not working reliably

Consider fixing during Phase 3 (card rendering migration) by restructuring how cards are created/updated.

### 4. Circular Dependencies
GameState → CardManager → GameState could cause issues.
Solution: Use event emitter pattern - state emits events, managers listen.

---

## Testing Checkpoints

After each phase, verify:
1. Sign in → Main room works
2. Create/join lobby works
3. Draw phase works
4. Bidding works (including Bore)
5. Card play works (including legality)
6. Trick collection animation works
7. Score updates work
8. Hand complete → new hand works
9. Game end works
10. Reconnection works
11. Chat works

---

## Estimated Effort

| Phase | Lines | Complexity |
|-------|-------|------------|
| 1. State | ~100 | Medium |
| 2. Handlers | ~800 | High |
| 3. Cards | ~600 | High |
| 4. UI | ~400 | Medium |
| 5. Scene | ~400 | High |
| 6. Cleanup | ~100 | Low |

**Total: 3,127 lines to migrate**

---

## Quick Start for Next Session

1. Read this plan
2. Check current state: `wc -l client/game.js`
3. Run tests: `npm run test:client`
4. Start with Phase 1 (State Migration)
5. After each change: build, test manually, commit

```bash
# Build and verify
source ~/.nvm/nvm.sh && nvm use 18
npm run build:client
npm run test:client
npm run dev  # Manual testing
```
