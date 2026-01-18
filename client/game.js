
// Variable declarations moved to top to avoid temporal dead zone errors
// These are used throughout the file and must be declared before any code that uses them
// Note: hasDrawn, clickedCardPosition, drawnCardDisplays, allCards moved to DrawManager.js
var myCards = [];
var ranks = null; // Will be set from ModernUtils when available

// Helper to get RANK_VALUES lazily (ModernUtils may not be loaded yet)
function getRankValues() {
    if (ranks) return ranks;
    if (window.ModernUtils && window.ModernUtils.RANK_VALUES) {
        ranks = window.ModernUtils.RANK_VALUES;
        return ranks;
    }
    // Fallback values if ModernUtils not available yet
    return { HI: 16, LO: 15, A: 14, K: 13, Q: 12, J: 11, 10: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
}

document.addEventListener("playerAssigned", (event) => {
    let data = event.detail;
    console.log("📡 (game.js) Received forwarded playerAssigned event:", data);
    if (!data.playerId) {
        console.error("🚨 ERROR: 'playerId' is missing in forwarded playerAssigned data!", data);
    } else {
        playerId = data.playerId;
        position = data.position;
        console.log("✅ playerID:", playerId);
    }
});

// Handle rejoin after reconnection
// Store rejoin data to process when scene is ready
let pendingRejoinData = null;

function processRejoin(data) {
    console.log("🔄 Processing rejoin with data:", data);
    console.log("🔄 gameScene exists:", !!gameScene, "game exists:", !!gameScene?.game);

    // Clear any sign-in/lobby screens first
    window.ModernUtils.getUIManager().removeAllVignettes();
    let signInContainer = document.getElementById("signInContainer");
    if (signInContainer) signInContainer.remove();
    let lobbyContainer = document.getElementById("lobbyContainer");
    if (lobbyContainer) lobbyContainer.remove();

    // Restore position and game state
    position = data.position;
    playerId = socket.id;

    // Restore player data (matching the structure from positionUpdate)
    playerData = {
        position: data.players.map(p => p.position),
        socket: data.players.map(p => p.socketId),
        username: data.players.map(p => ({ username: p.username })),
        pics: data.players.map(p => p.pic)
    };

    // Restore game state
    playerCards = data.hand;
    trump = data.trump;
    dealer = data.dealer;
    currentTurn = data.currentTurn;
    bidding = data.bidding ? 1 : 0;
    score1 = data.score.team1;
    score2 = data.score.team2;

    console.log("🔄 Rebuilding game UI after rejoin");

    // Remove any overlays
    window.ModernUtils.getUIManager().removeWaitingScreen();
    // Clean up draw phase via DrawManager (if present)
    if (gameScene && gameScene.drawManager) {
        gameScene.drawManager.cleanup();
    }

    // Create game UI elements (pass true to indicate reconnection)
    window.createGameFeedFromLegacy(true);

    // Restore game log history from server
    if (data.gameLog && data.gameLog.length > 0) {
        console.log(`🔄 Restoring ${data.gameLog.length} game log entries`);
        data.gameLog.forEach(entry => {
            window.addToGameFeedFromLegacy(entry.message, entry.playerPosition, entry.timestamp);
        });
    }

    // Calculate player names (same as gameStart handler)
    myUsername = playerData.username[playerData.position.indexOf(position)]?.username || 'You';
    partner = playerData.username[playerData.position.indexOf(team(position))]?.username || 'Partner';
    opp1 = playerData.username[playerData.position.indexOf(rotate(position))]?.username || 'Opp1';
    opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))]?.username || 'Opp2';

    // Update score display in game log
    if (position % 2 !== 0) {
        window.updateGameLogScoreFromLegacy(myUsername + "/" + partner, opp1 + "/" + opp2, score1, score2);
    } else {
        window.updateGameLogScoreFromLegacy(myUsername + "/" + partner, opp1 + "/" + opp2, score2, score1);
    }

    // Create player info box
    if (!playerInfo) {
        playerInfo = createPlayerInfoBox();
    }

    // NOTE: displayCards and displayOpponentHands now handled by modular code
    // - handleDisplayHand via CardManager (in main.js onRejoinSuccess)
    // - handleDisplayOpponentHands via OpponentManager (in main.js onRejoinSuccess)
    // - DOM backgrounds via LayoutManager.createDomBackgrounds()
    // - Bid UI via BidManager.showBidUI() (if still in bidding phase)

    // Display trump card
    if (trump) {
        displayTableCard.call(gameScene, trump);
    }

    // Bug 2 fix: Restore played cards in current trick
    if (data.playedCards && data.playedCards.length > 0) {
        const screenWidth = gameScene.scale.width;
        const screenHeight = gameScene.scale.height;

        // Ensure play positions are calculated
        updatePlayPositions(screenWidth, screenHeight);

        // Bug 3 fix: Restore leadCard, leadPosition, playedCardIndex from playedCards
        // Find the first non-null card (the lead) and count played cards
        let foundLead = false;
        playedCardIndex = 0;
        data.playedCards.forEach((card, index) => {
            if (card) {
                playedCardIndex++;
                if (!foundLead) {
                    leadCard = card;
                    leadPosition = index + 1; // Convert to 1-4 position
                    foundLead = true;
                    console.log(`🔄 Restored leadCard: ${card.rank} of ${card.suit}, leadPosition: ${leadPosition}`);
                }
            }
        });
        console.log(`🔄 Restored playedCardIndex: ${playedCardIndex}`);

        // playedCards array is indexed by position-1 (index 0 = position 1, etc.)
        data.playedCards.forEach((card, index) => {
            if (!card) return; // No card played at this position yet

            const cardPosition = index + 1; // Convert to 1-4 position
            const cardKey = getCardImageKey(card);
            let x, y, playPosition;

            // Map card position to screen position relative to player
            if (cardPosition === position) {
                x = playPositions.self.x;
                y = playPositions.self.y;
                playPosition = 'self';
            } else if (cardPosition === position + 1 || cardPosition === position - 3) {
                x = playPositions.opponent1.x;
                y = playPositions.opponent1.y;
                playPosition = 'opponent1';
            } else if (cardPosition === position + 2 || cardPosition === position - 2) {
                x = playPositions.partner.x;
                y = playPositions.partner.y;
                playPosition = 'partner';
            } else {
                x = playPositions.opponent2.x;
                y = playPositions.opponent2.y;
                playPosition = 'opponent2';
            }

            const sprite = gameScene.add.image(x, y, 'cards', cardKey)
                .setScale(1.5)
                .setDepth(200);
            sprite.setData('playPosition', playPosition); // Store position for resize
            currentTrick.push(sprite);
        });

        console.log(`🔄 Restored ${currentTrick.length} played cards from current trick`);

        // Update card legality now that we've restored leadCard/playedCardIndex
        // Use modular CardManager if available, otherwise fall back to legacy
        if (gameScene && gameScene.cardManager) {
            const gameState = window.ModernUtils.getGameState();
            const canPlay = !gameState.isBidding &&
                            gameState.currentTurn === gameState.position &&
                            !gameState.hasPlayedCard;
            const legalityChecker = (card) => {
                const result = window.ModernUtils.isLegalMove(
                    card,
                    gameState.myCards,
                    gameState.leadCard,
                    gameState.playedCardIndex === 0,
                    gameState.trump,
                    gameState.trumpBroken,
                    gameState.position,
                    gameState.leadPosition
                );
                return result.legal;
            };
            gameScene.cardManager.updateCardLegality(legalityChecker, canPlay);
        } else if (window.updateCardLegality) {
            window.updateCardLegality();
        }
    }

    window.addToGameFeedFromLegacy("Reconnected to game!");
}

document.addEventListener("rejoinSuccess", (event) => {
    let data = event.detail;

    // Check if gameScene is ready - must have scale property
    if (gameScene && gameScene.scale && gameScene.scale.width) {
        processRejoin(data);
    } else {
        // Scene not ready, store data and wait for create()
        pendingRejoinData = data;
    }
});

// Handle rejoin failure
document.addEventListener("rejoinFailed", (event) => {
    console.log("Rejoin failed:", event.detail.reason);
    // Return to main room
    socket.emit("joinMainRoom");
});

// Handle player reconnection notification
document.addEventListener("playerReconnected", (event) => {
    let data = event.detail;
    console.log(`🔄 Player ${data.username} at position ${data.position} reconnected`);
    window.addToGameFeedFromLegacy(`${data.username} reconnected`);
});

// Handle player disconnect notification (from server)
socket.on("playerDisconnected", (data) => {
    console.log(`⚠️ Player ${data.username} at position ${data.position} disconnected`);
    // Use scene handler if available, fallback to legacy
    if (gameScene && gameScene.handleAddToGameFeed) {
        gameScene.handleAddToGameFeed(`${data.username} disconnected - waiting for reconnection...`);
    } else {
        window.addToGameFeedFromLegacy(`${data.username} disconnected - waiting for reconnection...`);
    }
});

// Handle complete reconnection failure (all attempts exhausted)
document.addEventListener("reconnectFailed", () => {
    console.log("❌ All reconnection attempts failed");
    if(gameScene){
        gameScene.scene.restart();
        socket.off("gameStart");
    }
    cleanupDomBackgrounds();
    window.ModernUtils.getUIManager().removeWaitingScreen();
    window.ModernUtils.getUIManager().clearUI();
    // Show sign-in screen using modular code
    window.ModernUtils.showSignInScreen({
        onSignIn: ({ username, password }) => {
            socket.emit('signIn', { username, password });
        },
        onCreateAccount: () => {
            // User wants to register - show register screen
            const signInContainer = document.getElementById('sign-in-container');
            if (signInContainer) signInContainer.remove();
            const signInVignette = document.getElementById('sign-in-vignette');
            if (signInVignette) signInVignette.remove();
        }
    });
    alert("Connection lost. Please sign in again.");
});
function visible(){
    return document.visibilityState === "visible";
}

// ============================================
// Phaser UI Helper Functions
// ============================================

function createSpeechBubble(scene, x, y, width, height, text, color, tailDirection = 'down') {
    let scaleFactorX = scene.scale.width / 1920;
    let scaleFactorY = scene.scale.height / 953;
    const PADDING   = 10;
    const TAIL_SIZE = 20*scaleFactorX;
    const MAX_W     = 350*scaleFactorX;
    const MAX_H     = 200*scaleFactorY;

    // Style & measure the text off-screen
    const style = {
      fontSize:  "16px",
      fontFamily:"Arial",
      color:     (color === "#FF0000" ? "#FF0000" : "#000000"),
      wordWrap:  { width: MAX_W - 2*PADDING }
    };
    const textObj = scene.add.text(0, 0, text, style);

    // Clamp its measured size
    const txtW = Math.min(textObj.width,  MAX_W - 2*PADDING);
    const txtH = Math.min(textObj.height, MAX_H - 2*PADDING);

    // Final bubble dims
    const bW = txtW + 2*PADDING;
    const bH = txtH + 2*PADDING;

    const bubble = scene.add.graphics();
    bubble.fillStyle(0xffffff, 1);

    let bubbleX, bubbleY;

    if (tailDirection === 'left') {
      // Bubble positioned to the right of x, vertically centered on y
      bubbleX = x + TAIL_SIZE;
      bubbleY = y - bH / 2;

      // Draw bubble background
      bubble.fillRoundedRect(bubbleX, bubbleY, bW, bH, 16);

      // Draw tail pointing left toward the avatar
      bubble.fillTriangle(
        x,                    y,
        bubbleX,              y - TAIL_SIZE / 2,
        bubbleX,              y + TAIL_SIZE / 2
      );

      // Position text inside bubble
      textObj.setPosition(bubbleX + PADDING, bubbleY + PADDING);
    } else {
      // Original 'down' behavior: bubble above y, tail pointing down
      bubbleX = x;
      bubbleY = y - bH;

      // Draw bubble background
      bubble.fillRoundedRect(bubbleX, bubbleY, bW, bH, 16);

      // Draw tail pointing down
      bubble.fillTriangle(
        bubbleX + 20,         bubbleY + bH,
        bubbleX - TAIL_SIZE,  bubbleY + bH,
        bubbleX + 10,         bubbleY + bH - TAIL_SIZE
      );

      // Position text inside bubble
      textObj.setPosition(bubbleX + PADDING, bubbleY + PADDING);
    }

    // Group elements
    const container = scene.add.container(0, 0, [bubble, textObj]);
    container.setDepth(500);
    container.setAlpha(1);

    return container;
}

function createPlayerInfoBox() {
    // Safety check: ensure playerData is fully populated
    if (!playerData || !playerData.username || !playerData.position || !playerData.pics) {
        console.warn("⚠️ createPlayerInfoBox called before playerData is ready, deferring...");
        return null;
    }

    let positionIndex = playerData.position.indexOf(position);
    if (positionIndex === -1 || !playerData.username[positionIndex]) {
        console.warn("⚠️ createPlayerInfoBox: position not found in playerData, deferring...");
        return null;
    }

    let screenWidth = gameScene.scale.width;
    let screenHeight = gameScene.scale.height;
    let scaleFactorX = screenWidth / 1920;
    let scaleFactorY = screenHeight / 953;

    let boxX = screenWidth - 380*scaleFactorX;
    let boxY = screenHeight - 150*scaleFactorY;

    // Player Avatar
    let playerAvatar = gameScene.add.image(boxX, boxY - 60*scaleFactorY, "profile" + playerData.pics[positionIndex])
        .setScale(0.2)
        .setOrigin(0.5);

    // Player Name Text
    let playerNameText = gameScene.add.text(boxX, boxY + 10*scaleFactorY, playerData.username[positionIndex].username, {
        fontSize: "18px",
        fontFamily: "Arial",
        color: "#ffffff"
    }).setOrigin(0.5);

    // Position Text
    let playerPositionText = gameScene.add.text(boxX, boxY + 35*scaleFactorY, "", {
        fontSize: "16px",
        fontFamily: "Arial",
        color: "#ffffff"
    }).setOrigin(0.5);

    // Group all elements into a container
    let playerInfoContainer = gameScene.add.container(0, 0, [playerAvatar, playerNameText, playerPositionText]);

    return {playerAvatar, playerNameText, playerPositionText, playerInfoContainer};
}

function showImpactEvent(event){
    let scene = gameScene; // Use the scene reference from window.gameScene
    const screenWidth = scene.scale.width;
    const screenHeight = scene.scale.height;
    const impactImage = scene.add.image(screenWidth / 2, screenHeight / 2, event)
        .setScale(0)
        .setAlpha(1)
        .setDepth(999);

    // Tween for impact effect (scale up + bounce)
    scene.tweens.add({
        targets: impactImage,
        scale: { from: 0, to: 1.2 },
        ease: 'Back.Out',
        duration: 500
    });

    // Remove the image after 1.5 seconds
    scene.time.delayedCall(1500, () => {
        scene.tweens.add({
            targets: impactImage,
            alpha: { from: 1, to: 0 },
            duration: 1000,
            ease: 'Power1',
            onComplete: () => {
                impactImage.destroy();
            }
        });
    });
}

// ============================================
// End Phaser UI Helper Functions
// ============================================

// gameScene is now provided by main.js via window.gameScene when GameScene.create() runs
// No local declaration - uses window.gameScene implicitly
let playerData;
let currentTurn;

// Position utilities - delegating to ModernUtils
function team(pos) {
    return window.ModernUtils.team(pos);
}

function rotate(num) {
    return window.ModernUtils.rotate(num);
}

// Wrapper that passes global playerData to ModernUtils
function getPlayerName(pos) {
    return window.ModernUtils.getPlayerName(pos, playerData);
}

let myUsername = null;  // Renamed from 'me' to avoid shadowing window.me
let partner = null;
let opp1 = null;
let opp2 = null;
let score1 = 0;
let score2 = 0;
let currentTeamBids = "-/-";
let currentOppBids = "-/-";
let playedCard = false;
let playerInfo = null;
let gameListenersRegistered = false; // Track if socket listeners are already registered
let gameActiveChatBubbles = {}; // Track active chat bubbles by position key to prevent overlap
let opponentAvatarDoms = { partner: null, opp1: null, opp2: null }; // DOM-based opponent avatars for CSS glow support

// PHASE 7: create() function moved to GameScene.js
// Scene lifecycle is now handled by the modular GameScene class

// Reposition all game elements when window is resized
function repositionGameElements(newWidth, newHeight) {
    const scaleFactorX = newWidth / 1920;
    const scaleFactorY = newHeight / 953;

    // Position DOM background elements (play zone, hand background, border)
    positionDomBackgrounds(newWidth, newHeight);

    // Reposition cards in player's hand (LEGACY - myCards is now empty, CardManager handles this)
    repositionHandCards(newWidth, newHeight, scaleFactorX, scaleFactorY);

    // Reposition opponent UI elements (LEGACY - mostly empty now, OpponentManager handles this)
    repositionOpponentElements(newWidth, newHeight, scaleFactorX, scaleFactorY);

    // Reposition trump card display (top right area)
    const trumpX = newWidth / 2 + 500 * scaleFactorX;
    const trumpY = newHeight / 2 - 300 * scaleFactorY;
    if (tableCardSprite && tableCardSprite.active) {
        tableCardSprite.setPosition(trumpX, trumpY);
    }
    if (gameScene && gameScene.tableCardBackground && gameScene.tableCardBackground.active) {
        gameScene.tableCardBackground.setPosition(trumpX, trumpY);
    }
    if (gameScene && gameScene.tableCardLabel && gameScene.tableCardLabel.active) {
        gameScene.tableCardLabel.setPosition(trumpX, trumpY - 100);
    }

    // Update bid container position (DOM element)
    const bidContainer = document.getElementById("bidContainer");
    if (bidContainer && gameScene && gameScene.scale) {
        bidContainer.style.left = `${newWidth / 2}px`;
        bidContainer.style.top = `${newHeight / 2}px`;
    }

    // Reposition player info (bottom right)
    if (playerInfo && playerInfo.playerAvatar) {
        const boxX = newWidth - 380 * scaleFactorX;
        const boxY = newHeight - 150 * scaleFactorY;

        playerInfo.playerAvatar.setPosition(boxX, boxY - 60 * scaleFactorY);
        if (playerInfo.playerNameText) {
            playerInfo.playerNameText.setPosition(boxX, boxY + 10 * scaleFactorY);
        }
        if (playerInfo.playerPositionText) {
            playerInfo.playerPositionText.setPosition(boxX, boxY + 35 * scaleFactorY);
        }
    }

    // Reposition turn glow indicators
    repositionTurnGlow(newWidth, newHeight, scaleFactorX, scaleFactorY);

    // Update play area positions for card animations (Bug 3 fix)
    updatePlayPositions(newWidth, newHeight);

    // Reposition cards in the current trick to match new play area positions
    repositionCurrentTrick();
}

// Reposition cards in the player's hand during resize
function repositionHandCards(screenWidth, screenHeight, scaleFactorX, scaleFactorY) {
    if (!myCards || myCards.length === 0) return;

    const cardSpacing = 50 * scaleFactorX;
    const totalWidth = (myCards.length - 1) * cardSpacing;
    const startX = (screenWidth - totalWidth) / 2;

    // Calculate hand area (must match positionDomBackgrounds and displayCards)
    const bottomClearance = 20 * scaleFactorY;
    const cardHeight = 140 * 1.5 * scaleFactorY;
    const cardPadding = 10 * scaleFactorY;
    const handAreaHeight = cardHeight + cardPadding * 2;
    const handAreaTop = screenHeight - handAreaHeight - bottomClearance;
    const startY = handAreaTop + handAreaHeight / 2; // Vertically centered on table

    myCards.forEach((card, index) => {
        if (card && card.active) {
            card.x = startX + index * cardSpacing;
            card.y = startY;
            card.setData('baseY', startY); // Update baseY for hover effects
        }
    });
}

// Position DOM background elements (play zone, hand background, border)
function positionDomBackgrounds(screenWidth, screenHeight) {
    const scaleFactorX = screenWidth / 1920;
    const scaleFactorY = screenHeight / 953;

    // Position play zone (center)
    const playZoneDom = document.getElementById('playZoneDom');
    if (playZoneDom) {
        const playZoneWidth = 600 * scaleFactorX;
        const playZoneHeight = 400 * scaleFactorY;
        playZoneDom.style.width = `${playZoneWidth}px`;
        playZoneDom.style.height = `${playZoneHeight}px`;
        playZoneDom.style.left = `${(screenWidth - playZoneWidth) / 2}px`;
        playZoneDom.style.top = `${(screenHeight - playZoneHeight) / 2}px`;
    }

    // Position hand background (bottom center) - snug fit around cards
    const handBgDom = document.getElementById('handBackgroundDom');
    const borderDom = document.getElementById('handBorderDom');
    if (handBgDom) {
        const bottomClearance = 20 * scaleFactorY;
        // Card height at scale 1.5 is ~210px, add minimal padding for snug fit
        const cardHeight = 140 * 1.5 * scaleFactorY;
        const cardPadding = 10 * scaleFactorY;
        const handAreaHeight = cardHeight + cardPadding * 2;
        const handAreaWidth = screenWidth * 0.4;
        const handY = screenHeight - handAreaHeight - bottomClearance;
        const handX = (screenWidth - handAreaWidth) / 2;

        handBgDom.style.width = `${handAreaWidth}px`;
        handBgDom.style.height = `${handAreaHeight}px`;
        handBgDom.style.left = `${handX}px`;
        handBgDom.style.top = `${handY}px`;

        if (borderDom) {
            borderDom.style.width = `${handAreaWidth}px`;
            borderDom.style.height = `${handAreaHeight}px`;
            borderDom.style.left = `${handX}px`;
            borderDom.style.top = `${handY}px`;
        }
    }
}

// Cleanup DOM background elements
function cleanupDomBackgrounds() {
    const playZoneDom = document.getElementById('playZoneDom');
    const handBgDom = document.getElementById('handBackgroundDom');
    const borderDom = document.getElementById('handBorderDom');
    if (playZoneDom) playZoneDom.remove();
    if (handBgDom) handBgDom.remove();
    if (borderDom) borderDom.remove();
    // Clean up opponent avatar DOM elements
    cleanupOpponentAvatars();
}

// Reposition opponent UI elements (avatars, names, card backs) during resize
function repositionOpponentElements(screenWidth, screenHeight, scaleFactorX, scaleFactorY) {
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Clamp positions to stay within canvas bounds (leave margin for avatars and game log)
    const minX = 80;
    const maxX = screenWidth - 120;

    // Calculate opponent positions (matching displayOpponentHands logic)
    // Clamp opp1 and opp2 to prevent overlap with edges/game log
    const positions = {
        partner: {
            cardX: centerX,
            cardY: centerY - 275 * scaleFactorY,
            avatarX: centerX,
            avatarY: centerY - 400 * scaleFactorY
        },
        opp1: {
            cardX: Math.max(minX + 50, centerX - 425 * scaleFactorX),
            cardY: centerY,
            avatarX: Math.max(minX, centerX - 550 * scaleFactorX),
            avatarY: centerY
        },
        opp2: {
            cardX: Math.min(maxX - 50, centerX + 425 * scaleFactorX),
            cardY: centerY,
            avatarX: Math.min(maxX, centerX + 550 * scaleFactorX),
            avatarY: centerY
        }
    };

    // Reposition opponent card sprites
    if (typeof opponentCardSprites !== 'undefined') {
        const cardSpacing = 10 * scaleFactorX;
        Object.keys(positions).forEach(opponentId => {
            if (opponentCardSprites[opponentId]) {
                const pos = positions[opponentId];
                const isHorizontal = opponentId === 'partner';
                const numCards = opponentCardSprites[opponentId].length;

                opponentCardSprites[opponentId].forEach((card, index) => {
                    if (card && card.active) {
                        if (isHorizontal) {
                            const totalWidth = (numCards - 1) * cardSpacing;
                            card.x = pos.cardX - totalWidth / 2 + index * cardSpacing;
                            card.y = pos.cardY;
                        } else {
                            const totalHeight = (numCards - 1) * cardSpacing;
                            card.x = pos.cardX;
                            card.y = pos.cardY - totalHeight / 2 + index * cardSpacing;
                        }
                    }
                });
            }
        });
    }

    // Reposition opponent DOM avatars
    if (typeof opponentAvatarDoms !== 'undefined') {
        Object.keys(positions).forEach(opponentId => {
            const dom = opponentAvatarDoms[opponentId];
            if (dom) {
                dom.style.left = `${positions[opponentId].avatarX}px`;
                dom.style.top = `${positions[opponentId].avatarY}px`;
            }
        });
    }

    // Reposition dealer button if it exists
    if (typeof buttonHandle !== 'undefined' && buttonHandle && buttonHandle.active) {
        // Find which position has the dealer and reposition accordingly
        if (typeof dealer !== 'undefined' && typeof position !== 'undefined' && typeof team === 'function' && typeof rotate === 'function') {
            if (dealer === position) {
                // Player is the dealer - position near player info box
                buttonHandle.setPosition(screenWidth - 380 * scaleFactorX + 100 * scaleFactorX, screenHeight - 150 * scaleFactorY - 60 * scaleFactorY);
            } else if (team(position) === dealer) {
                buttonHandle.setPosition(positions.partner.avatarX + 70, positions.partner.avatarY);
            } else if (rotate(position) === dealer) {
                buttonHandle.setPosition(positions.opp1.avatarX - 70, positions.opp1.avatarY);
            } else if (rotate(rotate(rotate(position))) === dealer) {
                buttonHandle.setPosition(positions.opp2.avatarX + 70, positions.opp2.avatarY);
            }
        }
    }
}

// Reposition turn glow indicators during resize
function repositionTurnGlow(screenWidth, screenHeight, scaleFactorX, scaleFactorY) {
    // Player's hand glow is CSS-based (turn-glow class on handBorderDom)
    // so it automatically stays aligned with the hand border element.
    // Opponent glow is also CSS-based on DOM avatar elements, which are
    // repositioned by repositionOpponentElements, so no action needed here.
}

// Update play area positions for card animations (Bug 3 fix)
function updatePlayPositions(screenWidth, screenHeight) {
    const scaleFactorX = screenWidth / 1920;
    const scaleFactorY = screenHeight / 953;
    const playOffsetX = 80 * scaleFactorX;
    const playOffsetY = 80 * scaleFactorY;

    playPositions.opponent1 = { x: screenWidth / 2 - playOffsetX, y: screenHeight / 2 };
    playPositions.opponent2 = { x: screenWidth / 2 + playOffsetX, y: screenHeight / 2 };
    playPositions.partner = { x: screenWidth / 2, y: screenHeight / 2 - playOffsetY };
    playPositions.self = { x: screenWidth / 2, y: screenHeight / 2 + playOffsetY };
}

// Reposition cards in current trick during resize
function repositionCurrentTrick() {
    if (!currentTrick || currentTrick.length === 0) return;

    currentTrick.forEach(card => {
        if (!card || !card.active) return;

        const playPosition = card.getData('playPosition');
        if (!playPosition || !playPositions[playPosition]) return;

        card.x = playPositions[playPosition].x;
        card.y = playPositions[playPosition].y;
    });
}

// Store pending data if events arrive before scene is ready
let pendingPositionData = null;
let pendingGameStartData = null;

function processPositionUpdate(data) {
    console.log("Position update received:", data);
    playerData = {
        position: data.positions,
        socket: data.sockets,
        username: data.usernames,
        pics: data.pics
    };
    console.log("✅ playerData initialized:", playerData);

    // If playerInfo was deferred because playerData wasn't ready, create it now
    if (!playerInfo && position && gameScene) {
        playerInfo = createPlayerInfoBox();
        if (playerInfo) {
            console.log("✅ playerInfo created after positionUpdate");
        }
    }
}

function processGameStart(data) {
    console.log("🎮 processGameStart called!");

    // Clear any remaining tricks from previous hand (safeguard for race conditions)
    clearAllTricks();

    console.log("🎮 gameScene:", gameScene);
    console.log("🎮 gameScene.add:", gameScene?.add);
    console.log("🎮 gameScene.textures:", gameScene?.textures);
    console.log("🎮 gameScene.scale:", gameScene?.scale);
    console.log("🎮 gameScene.scale.width:", gameScene?.scale?.width);
    console.log("🎮 gameScene.scene:", gameScene?.scene);
    console.log("🎮 gameScene.sys:", gameScene?.sys);
    console.log("🎮 gameScene.sys.isActive():", gameScene?.sys?.isActive());
    console.log("Game started! Data received:", data);
    // Debug: Check if playerId is set correctly
    console.log("playerId:", playerId);
    // Debug: Check critical global variables
    console.log("🎮 position (global):", position);
    console.log("🎮 position (from server):", data.position);
    console.log("🎮 playerData:", playerData);
    // Debug: Check if player has received cards
    console.log("Hands data:", data.hand);
    console.log("scores:", data.score1, data.score2);
    console.log("Player's hand:", data.hand);

    // Use position from gameStart data to avoid race condition with playerAssigned event
    if (data.position) {
        position = data.position;
        console.log("✅ Set position from gameStart data:", position);
    }

    // Check for race condition: position might not be set yet
    if (position === undefined) {
        console.error("🚨 RACE CONDITION: position is undefined!");
        console.log("⏳ Waiting 100ms for playerAssigned to process...");
        setTimeout(() => {
            console.log("🔄 Retrying processGameStart after delay, position now:", position);
            processGameStart(data);
        }, 100);
        return;
    }

    // Check for playerData not being set
    if (!playerData) {
        console.error("🚨 RACE CONDITION: playerData is undefined! positionUpdate hasn't been processed yet.");
        console.log("⏳ Waiting 100ms for positionUpdate to process...");
        setTimeout(() => {
            console.log("🔄 Retrying processGameStart after delay, playerData now:", playerData);
            processGameStart(data);
        }, 100);
        return;
    }

    playerCards = data.hand;
    dealer = data.dealer;
    if (playerCards && playerCards.length > 0) {
        console.log("🎮 playerCards has", playerCards.length, "cards, running display cards...");
        score1 = data.score1;
        score2 = data.score2;
        myUsername = playerData.username[playerData.position.indexOf(position)].username;
        partner = playerData.username[playerData.position.indexOf(team(position))].username;
        opp1 = playerData.username[playerData.position.indexOf(rotate(position))].username;
        opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;
        // Update score in game log instead of old scorebug
        if(position % 2 !== 0){
            window.updateGameLogScoreFromLegacy(myUsername + "/" + partner, opp1 + "/" + opp2, score1, score2);
        }
        else{
            window.updateGameLogScoreFromLegacy(myUsername + "/" + partner, opp1 + "/" + opp2, score2, score1);
        }
        if(!playerInfo){
            playerInfo = createPlayerInfoBox(); // Store the reference
        }
        // Set trump for legacy code (modular code handles via gameState.setTrump)
        if (data.trump) {
            trump = data.trump;
        }
        // Set bidding state for legacy code (modular code handles via gameState.isBidding)
        bidding = 1;
        // NOTE: displayCards and displayOpponentHands now handled by modular code
        // - handleDisplayHand via CardManager
        // - handleDisplayOpponentHands via OpponentManager
        // - DOM backgrounds via LayoutManager.createDomBackgrounds()
        // - Bid UI via BidManager.showBidUI()
    } else {
        console.error("🚨 ERROR: playerCards is undefined or empty!", playerCards);
    }
    // NOTE: displayOpponentHands now handled by modular code (OpponentManager)
    if (data.trump) {
        console.log("🎮 Calling displayTableCard");
        displayTableCard.call(gameScene, data.trump);
    }
}

// NOTE: positionUpdate and gameStart are now handled by modular code (gameHandlers.js)
// The modular callbacks call the processing functions below

// Expose processing functions for modular code to call
window.processPositionUpdateFromLegacy = function(data) {
    if (gameScene && gameScene.scale) {
        processPositionUpdate(data);
    } else {
        console.log("⏳ Scene not ready, queuing positionUpdate data");
        pendingPositionData = data;
    }
};

window.processGameStartFromLegacy = function(data) {
    if (gameScene && gameScene.scale) {
        processGameStart(data);
    } else {
        console.log("⏳ Scene not ready, queuing gameStart data");
        pendingGameStartData = data;
    }
};

// PHASE 7: Phaser initialization moved to main.js via PhaserGame.js
// The Phaser game is now created with GameScene as the scene class
const GAME_LOG_WIDTH = 320; // Still used for layout calculations
let playerId, position, playerCards, trump = [];

// Card utility - delegating to ModernUtils
function getCardImageKey(card) {
    return window.ModernUtils.getCardImageKey(card);
}
// PHASE 7: preload() moved to GameScene.js

// Rank values - use getRankValues() function defined at top of file
// (ranks variable already declared at top, will be populated lazily)
var opponentCardSprites = {};
var tableCardSprite;
// NOTE: createGameFeed, addToGameFeed, updateGameLogScore moved to modular GameLog.js
// Now provided via window.*FromLegacy bridges from main.js

function addOpponentGlow(scene, relation){
    // Use CSS class on DOM avatar element for consistent glow effect
    removeOpponentGlow(scene);

    const avatarDom = opponentAvatarDoms[relation];
    if (avatarDom) {
        avatarDom.classList.add('turn-glow');
        console.log(`🟫 Added CSS turn glow to ${relation} avatar.`);
    }
}
function removeOpponentGlow(scene){
    // Remove glow class from all opponent avatars
    Object.values(opponentAvatarDoms).forEach(dom => {
        if (dom) {
            dom.classList.remove('turn-glow');
        }
    });
}
function addTurnGlow(scene) {
    // Use CSS class on hand border DOM element for perfect alignment on resize
    const borderDom = document.getElementById('handBorderDom');
    if (borderDom) {
        borderDom.classList.add('turn-glow');
        console.log("🟫 Added CSS turn glow to hand border.");
    }
}
function removeTurnGlow(scene) {
    // Remove CSS class from hand border DOM element
    const borderDom = document.getElementById('handBorderDom');
    if (borderDom) {
        borderDom.classList.remove('turn-glow');
        console.log("🚫 Removed CSS turn glow from hand border.");
    }
}
// rainbows declared below (allCards moved to DrawManager.js)
var rainbows = [];
socket.on("rainbow", (data) => {
    console.log("caught rainbow");
    // Store rainbow position for doneBidding handler to display at end of bidding
    // Note: scene.handleRainbow is called by modular handler (gameHandlers.js → main.js callback)
    // so we don't need to call it here - that would cause duplicate rainbow effects
    rainbows.push(data.position);
});
function destroyAllCards(){
    myCards.forEach((card) => {
        card.destroy(); // ✅ Remove card from the game
    });
    opponentCardSprites["opp1"].forEach((card) => {
        card.destroy(); // ✅ Remove card from the game
    });
    opponentCardSprites["opp2"].forEach((card) => {
        card.destroy(); // ✅ Remove card from the game
    });
    opponentCardSprites["partner"].forEach((card) => {
        card.destroy(); // ✅ Remove card from the game
    });
}
socket.on("destroyHands", (data) => {
    console.log("caught destroyHands");
    // Remove socket listeners registered in displayCards()
    socket.off("handComplete");
    socket.off("doneBidding");
    socket.off("trickComplete");
    socket.off("cardPlayed");
    socket.off("updateTurn");
    socket.off("bidReceived");

    // Destroy all card sprites
    destroyAllCards();

    // Note: scene.handleDestroyHands, handleClearHand, handleClearOpponents
    // are called by modular handler (gameHandlers.js → main.js callback)

    // Reset flag so listeners are re-registered on redeal
    gameListenersRegistered = false;
    // Reset bid and trick state for redeal
    currentTeamBids = "-/-";
    currentOppBids = "-/-";
    teamTricks = 0;
    oppTricks = 0;
});
// Draw phase functions (draw, removeDraw) moved to DrawManager.js
// See client/src/phaser/managers/DrawManager.js

function displayTableCard(card) {
    console.log(`🎴 displayTableCard called!`);
    console.log(`🎴 this (scene):`, this);
    console.log(`🎴 card:`, card);
    console.log(`🎴 Displaying table card: ${card.rank} of ${card.suit}`);
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    let tableX = screenWidth / 2 + 500*scaleFactorX;
    let tableY = screenHeight / 2 - 300*scaleFactorY;
    let cardKey = getCardImageKey(card);
    console.log(`🎴 cardKey: ${cardKey}, position: (${tableX}, ${tableY})`);
    if (this.tableCardBackground) this.tableCardBackground.destroy();
    if (this.tableCardSprite) this.tableCardSprite.destroy();
    if (this.tableCardLabel) this.tableCardLabel.destroy();
    this.tableCardBackground = this.add.rectangle(tableX, tableY, 120*scaleFactorX, 160*scaleFactorY, 0x8B4513)
        .setStrokeStyle(4, 0x654321)
        .setDepth(-1); // ✅ Ensure it's behind the card
    console.log(`🎴 Background rectangle created`);
    tableCardSprite = this.add.image(tableX, tableY, 'cards', cardKey).setScale(1.5);
    console.log(`🎴 Table card sprite created:`, tableCardSprite);
    this.tableCardLabel = this.add.text(tableX, tableY - 100, "TRUMP", {
        fontSize: "24px",
        fontStyle: "bold",
        color: "#FFFFFF",
        backgroundColor: "#000000AA",
        padding: { x: 10, y: 5 },
        align: "center"
    }).setOrigin(0.5);
}

let isTrumpBroken = false;
let teamTricks = 0;
let oppTricks = 0;

// Rule utilities - delegating to ModernUtils
function isLegalMove(card, hand, lead, leadBool, leadPos) {
    // ModernUtils.isLegalMove returns { legal: boolean, reason?: string }
    const result = window.ModernUtils.isLegalMove(card, hand, lead, leadBool, trump, isTrumpBroken, leadPos, position);
    return result.legal;
}

let teamTrickHistory = [];
let oppTrickHistory = [];
let bidding = 1;
let playerBids = [];
let playedCardIndex = 0;
let leadCard = null;
let leadPosition = null;
let tempBids = [];
let currentTrick = [];
let thisTrick = [];
// Play area positions - updated on resize (Bug 3 fix)
let playPositions = {
    opponent1: { x: 0, y: 0 },
    opponent2: { x: 0, y: 0 },
    partner: { x: 0, y: 0 },
    self: { x: 0, y: 0 }
};
// Note: handBackground and border are now DOM elements with ids 'handBackgroundDom' and 'handBorderDom'
function clearAllTricks() {
    console.log("🗑️ Clearing all tricks...");

    // ✅ Loop through each trick in trickHistory and destroy its cards
    teamTrickHistory.forEach((trick, index) => {
        trick.forEach((card) => {
            card.destroy();
        });
        console.log(`✅ Trick #${index + 1} removed.`);
    });

    // ✅ Clear the trick history array
    teamTrickHistory = [];
    oppTrickHistory.forEach((trick, index) => {
        trick.forEach((card) => {
            card.destroy();
        });
        console.log(`✅ Trick #${index + 1} removed.`);
    });

    // ✅ Clear the trick history array
    oppTrickHistory = [];
    console.log("🧹 All tricks have been cleared.");
}
socket.on("disconnect", () => {
    console.log("⚠️ Disconnected from server. Auto-reconnecting...");
    // Don't show sign-in screen - let Socket.IO handle reconnection
    // The socketManager will attempt to rejoin the game on reconnect
});
socket.on("abortGame", (data) => {
    playedCard = false;
    playerInfo = null;
    console.log("caught abortGame");
    // Use scene handler if available
    if (gameScene && gameScene.handleAbortGame) {
        gameScene.handleAbortGame(data);
    }
    cleanupDomBackgrounds();
    window.ModernUtils.getUIManager().clearUI();
    // Clear scene reference in modular code
    if (window.ModernUtils && window.ModernUtils.clearGameScene) {
        window.ModernUtils.clearGameScene();
    }
    if (gameScene) {
        gameScene.children.removeAll(true);
        gameScene.scene.restart();
    }
    // Return to main room
    socket.emit("joinMainRoom");
});
socket.on("forceLogout", (data) => {
    console.log("someone else signed in as you. Logging out.");
    if(gameScene){
        gameScene.scene.restart();
        socket.off("gameStart");
    }
    cleanupDomBackgrounds();
    window.ModernUtils.getUIManager().removeWaitingScreen();
    window.ModernUtils.getUIManager().clearUI();
    // Clear scene reference in modular code
    if (window.ModernUtils && window.ModernUtils.clearGameScene) {
        window.ModernUtils.clearGameScene();
    }
    // Sign-in screen now handled by modular code in main.js authHandlers
});
socket.on("roomFull", (data) => {
    console.log("caught roomFull");
    window.ModernUtils.getUIManager().removeWaitingScreen();
    // Return to main room (this shouldn't happen with lobby system)
    socket.emit("joinMainRoom");
});
socket.on("gameEnd", (data) => {
    console.log("caught gameEnd");
    // Determine which team the player is on (positions 1,3 = Team 1, positions 2,4 = Team 2)
    // and show scores accordingly
    let teamScore, oppScore;
    if (position % 2 !== 0) {
        // Player is on Team 1 (odd positions 1, 3)
        teamScore = data.score.team1;
        oppScore = data.score.team2;
    } else {
        // Player is on Team 2 (even positions 2, 4)
        teamScore = data.score.team2;
        oppScore = data.score.team1;
    }

    // Add game end messages to game log
    const messages = window.ModernUtils.formatGameEndMessages({
        myPosition: position,
        playerData: playerData,
        teamScore: teamScore,
        oppScore: oppScore,
    });
    messages.forEach(msg => window.addToGameFeedFromLegacy(msg));

    // Update game log score display
    const { teamName, oppName } = window.ModernUtils.getTeamNames(position, playerData);
    window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);

    // Show final score overlay
    window.ModernUtils.showFinalScoreOverlay({
        teamScore: teamScore,
        oppScore: oppScore,
        onReturnToLobby: () => {
            // Remove game feed/log
            let gameFeed = document.getElementById("gameFeed");
            if (gameFeed) gameFeed.remove();

            // Remove width restriction from game container
            document.getElementById('game-container').classList.remove('in-game');

            gameScene.scene.restart();
            socket.off("gameStart");
            playZone = null;
            handBackground = null;
            // Return to main room
            socket.emit("joinMainRoom");
        }
    });
});

// Helper to show chat/bid bubble, replacing any existing bubble for the same position
function showChatBubble(scene, positionKey, x, y, message, color = null, duration = 6000) {
    // Destroy existing bubble for this position if present
    if (gameActiveChatBubbles[positionKey]) {
        if (gameActiveChatBubbles[positionKey].timer) {
            gameActiveChatBubbles[positionKey].timer.remove();
        }
        if (gameActiveChatBubbles[positionKey].bubble) {
            gameActiveChatBubbles[positionKey].bubble.destroy();
        }
    }

    // Create new bubble
    let bubble = createSpeechBubble(scene, x, y, 150, 50, message, color);
    let timer = scene.time.delayedCall(duration, () => {
        bubble.destroy();
        delete gameActiveChatBubbles[positionKey];
    });

    gameActiveChatBubbles[positionKey] = { bubble, timer };
}

socket.on("chatMessage", (data) => {
    console.log("chatMessage received: ", data.message, " from position: ", data.position, " and I think my pos is ", position);

    // Add to game log with player position for color coding
    let senderName = data.username || getPlayerName(data.position);
    if (gameScene && gameScene.handleAddToGameFeed) {
        gameScene.handleAddToGameFeed(`${senderName}: ${data.message}`, data.position);
    } else {
        window.addToGameFeedFromLegacy(`${senderName}: ${data.message}`, data.position);
    }

    // Show chat bubble at appropriate position using modular handler
    if (gameScene && gameScene.handleShowChatBubble) {
        gameScene.handleShowChatBubble(position, data.position, data.message);
    } else {
        // Legacy fallback
        let scene = game.scene.scenes[0];
        let screenWidth = scene.scale.width;
        let screenHeight = scene.scale.height;
        let scaleFactorX = screenWidth / 1920;
        let scaleFactorY = screenHeight / 953;
        let centerPlayAreaX = screenWidth / 2;
        let centerPlayAreaY = screenHeight / 2;
        let opp1_x = centerPlayAreaX - 480*scaleFactorX;
        let opp1_y = centerPlayAreaY;
        let opp2_x = centerPlayAreaX + 620*scaleFactorX;
        let opp2_y = centerPlayAreaY;
        let partner_x = centerPlayAreaX + 20*scaleFactorX;
        let partner_y = centerPlayAreaY - 380*scaleFactorY;
        let me_x = screenWidth - 310*scaleFactorX;
        let me_y = screenHeight - 270*scaleFactorY;
        if (data.position === position + 1 || data.position === position - 3) {
            showChatBubble(scene, 'opp1', opp1_x, opp1_y, data.message);
        }
        if (data.position === position - 1 || data.position === position + 3) {
            showChatBubble(scene, 'opp2', opp2_x, opp2_y, data.message);
        }
        if (data.position === position + 2 || data.position === position - 2) {
            showChatBubble(scene, 'partner', partner_x, partner_y, data.message);
        }
        if (data.position === position) {
            showChatBubble(scene, 'me', me_x, me_y, data.message);
        }
    }
});

// NOTE: window.*FromLegacy bridges now provided by main.js using modular GameLog

// NOTE: clearDisplayCards, getSuitOrder, sortHand, displayCards removed - now handled by modular code:
// - CardManager.displayHand() for card sprites
// - BidManager.showBidUI() for bidding interface
// - LayoutManager.createDomBackgrounds() for play zone and hand backgrounds
// myCards declared at top of file

let buttonHandle;
let oppUI = [];

// Create DOM-based opponent avatar with CSS glow support
function createOpponentAvatarDom(opponentId, pic, username) {
    // Remove existing if any
    if (opponentAvatarDoms[opponentId]) {
        opponentAvatarDoms[opponentId].remove();
    }

    const container = document.createElement('div');
    container.id = `opponent-avatar-${opponentId}`;
    container.className = `opponent-avatar-container ${opponentId}`;

    const img = document.createElement('img');
    img.className = 'opponent-avatar-img';
    img.src = `assets/profile${pic}.png`;
    img.alt = username;

    const nameLabel = document.createElement('div');
    nameLabel.className = 'opponent-avatar-name';
    nameLabel.textContent = username;

    container.appendChild(img);
    container.appendChild(nameLabel);
    document.getElementById('game-container').appendChild(container);

    opponentAvatarDoms[opponentId] = container;
    return container;
}

// Clean up opponent avatar DOM elements
function cleanupOpponentAvatars() {
    Object.keys(opponentAvatarDoms).forEach(key => {
        if (opponentAvatarDoms[key]) {
            opponentAvatarDoms[key].remove();
            opponentAvatarDoms[key] = null;
        }
    });
}

function displayOpponentHands(numCards, dealer, skipAnimation = false) {
    console.log("🎭 displayOpponentHands called! skipAnimation:", skipAnimation);
    console.log("🎭 numCards:", numCards, "dealer:", dealer);
    console.log("🎭 position:", position);

    // PHASE 6 MIGRATION: Card sprites and avatars are now handled by OpponentManager
    // via handleDisplayOpponentHands in main.js. This function now only handles
    // the player position text (BTN, MP, CO, UTG) which OpponentManager doesn't manage.

    // Clean up old UI elements
    if (buttonHandle && typeof buttonHandle.destroy === 'function') {
        buttonHandle.destroy();
        buttonHandle = null;
    }
    oppUI.forEach((element) => element.destroy());
    oppUI = [];

    // Set player position text based on dealer position
    if (playerInfo && playerInfo.playerPositionText) {
        if (dealer === position) {
            playerInfo.playerPositionText.setText("BTN");
        } else if (team(position) === dealer) {
            playerInfo.playerPositionText.setText("MP");
        } else if (rotate(position) === dealer) {
            playerInfo.playerPositionText.setText("CO");
        } else if (rotate(rotate(rotate(position))) === dealer) {
            playerInfo.playerPositionText.setText("UTG");
        }
    }

    console.log("🎭 displayOpponentHands: position text updated, sprites handled by OpponentManager");
}

// PHASE 7: update() moved to GameScene.js (empty - no per-frame updates needed)

// Expose repositionGameElements for GameScene.handleResize() to call
window.repositionGameElements = function(newWidth, newHeight) {
    const scene = window.gameScene;
    if (!scene) return;
    repositionGameElements.call(scene, newWidth, newHeight);
};