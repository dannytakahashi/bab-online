
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
    createGameFeed(true);

    // Restore game log history from server
    if (data.gameLog && data.gameLog.length > 0) {
        console.log(`🔄 Restoring ${data.gameLog.length} game log entries`);
        data.gameLog.forEach(entry => {
            addToGameFeed(entry.message, entry.playerPosition, entry.timestamp);
        });
    }

    // Calculate player names (same as gameStart handler)
    myUsername = playerData.username[playerData.position.indexOf(position)]?.username || 'You';
    partner = playerData.username[playerData.position.indexOf(team(position))]?.username || 'Partner';
    opp1 = playerData.username[playerData.position.indexOf(rotate(position))]?.username || 'Opp1';
    opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))]?.username || 'Opp2';

    // Update score display in game log
    if (position % 2 !== 0) {
        updateGameLogScore(myUsername + "/" + partner, opp1 + "/" + opp2, score1, score2);
    } else {
        updateGameLogScore(myUsername + "/" + partner, opp1 + "/" + opp2, score2, score1);
    }

    // Create player info box
    if (!playerInfo) {
        playerInfo = createPlayerInfoBox();
    }

    // Display cards (skip animation on rejoin - just place them directly)
    if (playerCards && playerCards.length > 0) {
        displayCards.call(gameScene, playerCards, true);
    }

    // Display opponent hands (card backs) - skip animation on rejoin
    displayOpponentHands.call(gameScene, playerCards ? playerCards.length : 0, dealer, true);

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
        if (window.updateCardLegality) {
            window.updateCardLegality();
        }
    }

    addToGameFeed("Reconnected to game!");
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
    addToGameFeed(`${data.username} reconnected`);
});

// Handle player disconnect notification (from server)
socket.on("playerDisconnected", (data) => {
    console.log(`⚠️ Player ${data.username} at position ${data.position} disconnected`);
    // Use scene handler if available, fallback to legacy
    if (gameScene && gameScene.handleAddToGameFeed) {
        gameScene.handleAddToGameFeed(`${data.username} disconnected - waiting for reconnection...`);
    } else {
        addToGameFeed(`${data.username} disconnected - waiting for reconnection...`);
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
            updateGameLogScore(myUsername + "/" + partner, opp1 + "/" + opp2, score1, score2);
        }
        else{
            updateGameLogScore(myUsername + "/" + partner, opp1 + "/" + opp2, score2, score1);
        }
        if(!playerInfo){
            playerInfo = createPlayerInfoBox(); // Store the reference
        }
        // Set trump BEFORE displayCards so sorting works correctly
        if (data.trump) {
            trump = data.trump;
        }
        // Set bidding to 1 for new game start (not in displayCards, which is also called on rejoin)
        bidding = 1;
        console.log("🎮 Calling displayCards.call(gameScene, playerCards)");
        displayCards.call(gameScene, playerCards);
        //createVignette.call(gameScene);
    } else {
        console.error("🚨 ERROR: playerCards is undefined or empty!", playerCards);
    }
    console.log("🎮 Calling displayOpponentHands");
    displayOpponentHands.call(gameScene, playerCards?.length || 0, dealer);
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
function createGameFeed(isReconnection = false) {
    let feedCheck = document.getElementById("gameFeed");
    if(feedCheck){
        console.log("feed already exists, ensuring layout is correct...");
        // Still need to ensure .in-game class even if feed exists
        document.getElementById('game-container').classList.add('in-game');
        // Phaser's RESIZE mode handles container changes automatically
        return;
    }
    console.log("Creating game feed...");

    // Create main container using CSS class for full right column
    let feedContainer = document.createElement("div");
    feedContainer.id = "gameFeed";
    feedContainer.classList.add("chat-container", "ui-element");

    // Header
    let header = document.createElement("div");
    header.classList.add("chat-header");
    header.innerText = "Game Log";
    feedContainer.appendChild(header);

    // Score display section (inside game log)
    let scoreSection = document.createElement("div");
    scoreSection.id = "gameLogScore";
    scoreSection.style.padding = "10px";
    scoreSection.style.borderBottom = "1px solid #333";
    scoreSection.style.display = "flex";
    scoreSection.style.justifyContent = "space-around";
    scoreSection.style.background = "rgba(0,0,0,0.3)";

    let teamScoreDiv = document.createElement("div");
    teamScoreDiv.id = "teamScoreDisplay";
    teamScoreDiv.style.textAlign = "center";
    teamScoreDiv.style.color = "#4ade80";
    teamScoreDiv.innerHTML = '<div style="font-size:12px;color:#888;">Your Team</div><div style="font-size:20px;font-weight:bold;">0</div><div style="font-size:11px;color:#aaa;">Tricks: 0</div>';

    let oppScoreDiv = document.createElement("div");
    oppScoreDiv.id = "oppScoreDisplay";
    oppScoreDiv.style.textAlign = "center";
    oppScoreDiv.style.color = "#f87171";
    oppScoreDiv.innerHTML = '<div style="font-size:12px;color:#888;">Opponents</div><div style="font-size:20px;font-weight:bold;">0</div><div style="font-size:11px;color:#aaa;">Tricks: 0</div>';

    scoreSection.appendChild(teamScoreDiv);
    scoreSection.appendChild(oppScoreDiv);
    feedContainer.appendChild(scoreSection);

    // Messages area
    let messagesArea = document.createElement("div");
    messagesArea.id = "gameFeedMessages";
    messagesArea.classList.add("chat-messages");
    feedContainer.appendChild(messagesArea);

    // Chat input container
    let inputContainer = document.createElement("div");
    inputContainer.classList.add("chat-input-container");

    let chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.id = "chatInput";
    chatInput.classList.add("chat-input");
    chatInput.placeholder = "Type a message...";

    let sendBtn = document.createElement("button");
    sendBtn.classList.add("chat-send");
    sendBtn.innerText = "Send";

    inputContainer.appendChild(chatInput);
    inputContainer.appendChild(sendBtn);
    feedContainer.appendChild(inputContainer);

    document.body.appendChild(feedContainer);

    // Handle sending messages
    function sendMessage() {
        let message = chatInput.value.trim();
        if (message !== "") {
            console.log("Sending message:", message);
            socket.emit("chatMessage", { message });
            chatInput.value = "";
        }
    }

    sendBtn.addEventListener("click", sendMessage);
    chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            sendMessage();
        }
    });

    // Add initial message only for fresh games, not reconnections
    if (!isReconnection) {
        addToGameFeed("Game started!");
    }

    // Restrict game container width to make room for game log
    document.getElementById('game-container').classList.add('in-game');

    // Force Phaser to resize after container width change
    // Use requestAnimationFrame to ensure DOM has repainted with new layout
    requestAnimationFrame(() => {
        const container = document.getElementById('game-container');
        if (container && gameScene?.game?.scale) {
            const newWidth = container.clientWidth;
            const newHeight = container.clientHeight;
            // Resize the scale manager - this triggers GameScene.handleResize
            gameScene.game.scale.resize(newWidth, newHeight);
            if (gameScene.game.renderer?.resize) {
                gameScene.game.renderer.resize(newWidth, newHeight);
            }
        }
    });

    // Backup resize listener removed - Phaser's scale manager handles resize via GameScene.handleResize
    // The old backup handler was causing infinite recursion by calling scale.resize()
}
function addToGameFeed(message, playerPosition = null, serverTimestamp = null) {
    let messagesArea = document.getElementById("gameFeedMessages");

    if (!messagesArea) {
        console.warn("Game feed messages area not found!");
        return;
    }

    // Use server timestamp if provided, otherwise current time
    const now = serverTimestamp ? new Date(serverTimestamp) : new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Create a new message element using CSS classes
    let messageElement = document.createElement("div");
    messageElement.classList.add("chat-message");
    if (playerPosition === null) {
        messageElement.classList.add("system");
    }

    // Add timestamp
    let timeSpan = document.createElement("span");
    timeSpan.innerText = `[${timestamp}] `;
    timeSpan.style.color = "#888";
    timeSpan.style.fontSize = "11px";
    timeSpan.style.marginRight = "4px";
    messageElement.appendChild(timeSpan);

    // Add message with player color if position provided
    let msgSpan = document.createElement("span");
    msgSpan.classList.add("text");
    msgSpan.innerText = message;
    if (playerPosition !== null) {
        // Team 1 (positions 1, 3) = blue, Team 2 (positions 2, 4) = red
        if (playerPosition === 1 || playerPosition === 3) {
            msgSpan.style.color = "#63b3ed";
        } else {
            msgSpan.style.color = "#fc8181";
        }
    }
    messageElement.appendChild(msgSpan);

    // Add the message at the bottom
    messagesArea.appendChild(messageElement);

    // Scroll to the latest message
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

/**
 * Update the score display in the game log
 * @param {string} teamNames - e.g. "test1/test3"
 * @param {string} oppNames - e.g. "test2/test4"
 * @param {number} teamScore - Your team's score
 * @param {number} oppScore - Opponent's score
 * @param {string} teamBids - Optional bid info e.g. "2/3"
 * @param {string} oppBids - Optional bid info e.g. "1/4"
 * @param {number} teamTricks - Optional tricks won
 * @param {number} oppTricks - Optional tricks won
 */
function updateGameLogScore(teamNames, oppNames, teamScore, oppScore, teamBids = "-/-", oppBids = "-/-", teamTricks = 0, oppTricks = 0) {
    let teamDiv = document.getElementById("teamScoreDisplay");
    let oppDiv = document.getElementById("oppScoreDisplay");

    if (teamDiv) {
        teamDiv.innerHTML = `<div style="font-size:11px;color:#888;">${teamNames}</div><div style="font-size:20px;font-weight:bold;">${teamScore}</div><div style="font-size:11px;color:#aaa;">Bids: ${teamBids} | Tricks: ${teamTricks}</div>`;
    }
    if (oppDiv) {
        oppDiv.innerHTML = `<div style="font-size:11px;color:#888;">${oppNames}</div><div style="font-size:20px;font-weight:bold;">${oppScore}</div><div style="font-size:11px;color:#aaa;">Bids: ${oppBids} | Tricks: ${oppTricks}</div>`;
    }
}

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
    messages.forEach(msg => addToGameFeed(msg));

    // Update game log score display
    const { teamName, oppName } = window.ModernUtils.getTeamNames(position, playerData);
    updateGameLogScore(teamName, oppName, teamScore, oppScore);

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
        addToGameFeed(`${senderName}: ${data.message}`, data.position);
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

// Expose createGameFeed for modular code to call
window.createGameFeedFromLegacy = function(isReconnection = false) {
    createGameFeed(isReconnection);
};

// Expose addToGameFeed for modular code to call
window.addToGameFeedFromLegacy = function(message, playerPosition = null) {
    addToGameFeed(message, playerPosition);
};

// Expose updateGameLogScore for modular code to call
window.updateGameLogScoreFromLegacy = function(teamNames, oppNames, teamScore, oppScore, teamBids, oppBids, teamTricks, oppTricks) {
    updateGameLogScore(teamNames, oppNames, teamScore, oppScore, teamBids, oppBids, teamTricks, oppTricks);
};

function clearDisplayCards() {
    console.log("🗑️ Clearing all elements from displayCards...");

    // Explicitly remove bidContainer (DOM element) - belt-and-suspenders approach
    const bidContainer = document.getElementById("bidContainer");
    if (bidContainer) {
        bidContainer.remove();
    }

    // Use gameScene for handElements since this function may be called without proper binding
    if (gameScene && gameScene.handElements) {
        gameScene.handElements.forEach(element => {
            if (element) {
                // Check if it's a DOM node or Phaser object
                if (element.nodeType) {
                    element.remove();  // DOM element
                } else if (element.destroy) {
                    element.destroy(); // Phaser object
                }
            }
        });
        gameScene.handElements = [];
    }
    console.log("✅ All elements cleared from displayCards.");
}
// myCards declared at top of file

// Card sorting utilities - delegating to ModernUtils
function getSuitOrder(trumpSuit) {
    return window.ModernUtils.getSuitOrder(trumpSuit);
}

function sortHand(hand, trumpCard) {
    return window.ModernUtils.sortHand(hand, trumpCard);
}

function displayCards(playerHand, skipAnimation = false) {
    console.log("🃏 displayCards called with hand:", playerHand, "skipAnimation:", skipAnimation);
    console.log("🃏 this (scene) =", this);
    console.log("🃏 this.textures =", this.textures);
    console.log("🃏 this.add =", this.add);

    // Check if texture atlas is loaded
    if (this.textures && this.textures.exists('cards')) {
        console.log("✅ 'cards' texture atlas is loaded");
        const frames = this.textures.get('cards').getFrameNames();
        console.log("🃏 Available frames in atlas:", frames.slice(0, 10), "... (", frames.length, "total)");
    } else {
        console.error("🚨 'cards' texture atlas NOT loaded!");
    }

    // Clear old cards before creating new ones
    if (myCards && myCards.length > 0) {
        console.log("🗑️ Clearing", myCards.length, "old card sprites");
        myCards.forEach(sprite => {
            if (sprite && sprite.destroy) {
                sprite.destroy();
            }
        });
        myCards = [];
    }

    // Sort the hand before displaying
    playerHand = sortHand(playerHand, trump);
    let scaleFactorX = this.scale.width / 1920; // Adjust based on your design resolution
    let scaleFactorY = this.scale.height / 953; // Adjust based on your design resolution
    // Note: bidding state is set by callers (gameStart sets to 1, rejoin restores from server)
    console.log("🧠 Scene children:", this.children.list.length);
    console.log("🎯 Active tweens:", this.tweens._active.length);
    console.log("📨 cardPlayed listeners:", socket.listeners("cardPlayed").length);
    console.log("🧱 DOM elements:", document.querySelectorAll("*").length);
    if (!this.handElements) {
        this.handElements = [];
    };
    console.log("running card display...");
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    console.log("🖥️ Screen dimensions: ", screenWidth, "x", screenHeight, "y");
    console.log("screenWidth: ", screenWidth);
    console.log("screenHeight: ", screenHeight);
    let cardWidth = 100*scaleFactorX; // Approximate width of each card
    let cardSpacing = 50*scaleFactorX; // Spacing between cards
    let totalWidth = (playerHand.length - 1) * cardSpacing; // Width of all cards together
    let startX = (screenWidth - totalWidth) / 2; // ✅ Centered starting position

    // Calculate hand area dimensions (must match positionDomBackgrounds)
    let bottomClearance = 20*scaleFactorY;
    let cardHeight = 140 * 1.5 * scaleFactorY;
    let cardPadding = 10 * scaleFactorY;
    let handAreaHeight = cardHeight + cardPadding * 2;
    let handAreaWidth = screenWidth * 0.4;

    // Center cards vertically within the hand area
    let handAreaTop = screenHeight - handAreaHeight - bottomClearance;
    let startY = handAreaTop + handAreaHeight / 2; // ✅ Vertically centered on table

    // Initialize play positions (Bug 3 fix - use module-level positions updated on resize)
    updatePlayPositions(screenWidth, screenHeight);

    let handY = screenHeight - handAreaHeight / 2 - bottomClearance; // reuses bottomClearance from above
    // Create play zone as DOM element (replaces Phaser rectangle)
    if (!document.getElementById('playZoneDom')) {
        const playZoneDom = document.createElement('div');
        playZoneDom.id = 'playZoneDom';
        playZoneDom.style.position = 'absolute';
        playZoneDom.style.backgroundColor = 'rgba(50, 205, 50, 0.6)'; // 0x32CD32 at 60% opacity
        playZoneDom.style.border = '4px solid white';
        playZoneDom.style.borderRadius = '8px';
        playZoneDom.style.pointerEvents = 'none'; // Don't interfere with card clicks
        playZoneDom.style.zIndex = '-1'; // Behind canvas so cards show on top
        document.getElementById('game-container').appendChild(playZoneDom);
        console.log("📍 Play zone DOM element created");
    }

    // Create hand background as DOM element
    if (!document.getElementById('handBackgroundDom')) {
        const handBgDom = document.createElement('div');
        handBgDom.id = 'handBackgroundDom';
        handBgDom.style.position = 'absolute';
        handBgDom.style.backgroundColor = 'rgba(26, 51, 40, 0.85)'; // 0x1a3328 at 85% opacity
        handBgDom.style.pointerEvents = 'none';
        handBgDom.style.zIndex = '-2'; // Behind canvas so cards show on top
        document.getElementById('game-container').appendChild(handBgDom);

        // Border element
        const borderDom = document.createElement('div');
        borderDom.id = 'handBorderDom';
        borderDom.style.position = 'absolute';
        borderDom.style.border = '2px solid #2d5a40';
        borderDom.style.pointerEvents = 'none';
        borderDom.style.zIndex = '-1'; // Behind canvas so cards show on top
        document.getElementById('game-container').appendChild(borderDom);
    }
    // Position the DOM background elements
    positionDomBackgrounds(screenWidth, screenHeight);
    console.log("🟫 Added DOM background elements for player hand.");
    // Remove any existing bidContainer before creating new one
    const existingBidContainer = document.getElementById("bidContainer");
    if (existingBidContainer) {
        console.log("🗑️ Removing existing bidContainer before creating new one");
        existingBidContainer.remove();
    }
    // ✅ Create button-grid bidding UI (hidden initially, shown only when it's your turn)
    let bidContainer = document.createElement("div");
    bidContainer.id = "bidContainer";
    bidContainer.classList.add("ui-element", "bid-grid");
    bidContainer.style.position = "fixed";
    bidContainer.style.zIndex = "1000";
    bidContainer.style.display = (bidding === 1 && currentTurn === position) ? "flex" : "none";
    bidContainer.style.flexDirection = "column";
    bidContainer.style.alignItems = "center"; // Center the rows within the container
    bidContainer.style.gap = "8px";
    bidContainer.style.padding = "12px";
    bidContainer.style.background = "rgba(0, 0, 0, 0.85)";
    bidContainer.style.border = "2px solid #444";
    bidContainer.style.borderRadius = "8px";
    // Set initial position centered on Phaser game area
    bidContainer.style.left = `${this.scale.width / 2}px`;
    bidContainer.style.top = `${this.scale.height / 2}px`;
    bidContainer.style.transform = "translate(-50%, -50%)";
    document.body.appendChild(bidContainer);
    this.handElements.push(bidContainer);

    // Header label
    let bidHeader = document.createElement("div");
    bidHeader.style.color = "#ffd700";
    bidHeader.style.fontSize = "18px";
    bidHeader.style.fontWeight = "bold";
    bidHeader.style.textAlign = "center";
    bidHeader.style.marginBottom = "4px";
    bidHeader.innerText = "Your Bid:";
    bidContainer.appendChild(bidHeader);

    // Track all bid buttons for selection highlighting
    let allBidButtons = [];
    let selectedBid = null;

    // Function to highlight selected button
    function selectBidButton(btn, bidValue) {
        // Remove highlight from previously selected button
        allBidButtons.forEach(b => {
            if (b.classList.contains('bore-button')) {
                b.style.background = b.disabled ? "#666" : "#c53030";
                b.style.border = "none";
            } else {
                b.style.background = "#4a5568";
                b.style.border = "none";
            }
        });
        // Highlight selected button
        btn.style.background = "#38a169";
        btn.style.border = "2px solid #68d391";
        selectedBid = bidValue;
    }

    // Row 1: Numeric bids (0 to hand size) - 4 per row using CSS grid
    let numericRow = document.createElement("div");
    numericRow.style.display = "grid";
    numericRow.style.gridTemplateColumns = "repeat(4, 1fr)";
    numericRow.style.gap = "4px";

    for (let i = 0; i <= playerHand.length; i++) {
        let btn = document.createElement("button");
        btn.classList.add("bid-button");
        btn.innerText = i.toString();
        btn.style.minWidth = "40px";
        btn.style.minHeight = "40px";
        btn.style.padding = "8px";
        btn.style.fontSize = "16px";
        btn.style.fontWeight = "bold";
        btn.style.border = "none";
        btn.style.borderRadius = "4px";
        btn.style.background = "#4a5568";
        btn.style.color = "white";
        btn.style.cursor = "pointer";
        allBidButtons.push(btn);
        btn.addEventListener("mouseenter", () => {
            if (selectedBid !== i.toString()) btn.style.background = "#2d3748";
        });
        btn.addEventListener("mouseleave", () => {
            if (selectedBid !== i.toString()) btn.style.background = "#4a5568";
        });
        btn.addEventListener("click", () => {
            if (currentTurn !== position || bidding === 0) {
                console.warn("Not your turn to bid.");
                return;
            }
            selectBidButton(btn, i.toString());
            console.log(`📩 Sending bid: ${i}`);
            socket.emit("playerBid", { position: position, bid: i.toString() });
        });
        numericRow.appendChild(btn);
    }
    bidContainer.appendChild(numericRow);

    // Row 2: Bore bids (B, 2B, 3B, 4B)
    let boreRow = document.createElement("div");
    boreRow.style.display = "flex";
    boreRow.style.gap = "4px";
    boreRow.style.justifyContent = "center";

    const boreBids = ['B', '2B', '3B', '4B'];
    const boreButtons = {};

    boreBids.forEach((bid, index) => {
        let btn = document.createElement("button");
        btn.classList.add("bid-button", "bore-button");
        btn.innerText = bid;
        btn.dataset.bid = bid;
        btn.style.minWidth = "50px";
        btn.style.minHeight = "40px";
        btn.style.padding = "8px 12px";
        btn.style.fontSize = "16px";
        btn.style.fontWeight = "bold";
        btn.style.border = "none";
        btn.style.borderRadius = "4px";
        btn.style.background = "#c53030";
        btn.style.color = "white";
        btn.style.cursor = "pointer";
        allBidButtons.push(btn);

        btn.addEventListener("mouseenter", () => {
            if (!btn.disabled && selectedBid !== bid) btn.style.background = "#9b2c2c";
        });
        btn.addEventListener("mouseleave", () => {
            if (!btn.disabled && selectedBid !== bid) btn.style.background = "#c53030";
        });

        btn.addEventListener("click", () => {
            if (btn.disabled) return;
            if (currentTurn !== position || bidding === 0) {
                console.warn("Not your turn to bid.");
                return;
            }
            selectBidButton(btn, bid);
            console.log(`📩 Sending bore bid: ${bid}`);
            socket.emit("playerBid", { position: position, bid: bid });
        });

        boreButtons[bid] = btn;
        boreRow.appendChild(btn);
    });
    bidContainer.appendChild(boreRow);

    // Function to update bore button states based on previous bids
    function updateBoreButtons() {
        // B is always enabled (unless someone already bid bore)
        const hasBore = tempBids.indexOf("B") !== -1;
        const has2B = tempBids.indexOf("2B") !== -1;
        const has3B = tempBids.indexOf("3B") !== -1;
        const has4B = tempBids.indexOf("4B") !== -1;

        // Disable all bore buttons if someone already bid 4B
        boreButtons['B'].disabled = hasBore;
        boreButtons['2B'].disabled = !hasBore || has2B;
        boreButtons['3B'].disabled = !has2B || has3B;
        boreButtons['4B'].disabled = !has3B || has4B;

        // Update visual styles for disabled buttons
        Object.values(boreButtons).forEach(btn => {
            if (btn.disabled) {
                btn.style.opacity = "0.4";
                btn.style.cursor = "not-allowed";
                btn.style.background = "#666";
            } else {
                btn.style.opacity = "1";
                btn.style.cursor = "pointer";
                btn.style.background = "#c53030";
            }
        });
    }

    // Initial update
    updateBoreButtons();

    // Store the update function globally so bidReceived can call it
    window.updateBoreButtons = updateBoreButtons;

    console.log("✅ Button-grid bidding UI created.");

    // Position the bid container in the center of the play zone (green square)
    // Use CSS transform for centering - doesn't require measuring element dimensions
    // Note: Resize is handled by Phaser's scale event in create(), not window resize
    console.log(`🖥️ Screen Width: ${screenWidth}, Starting X: ${startX}`);
    console.log("player hand:", playerHand);
    let cardDepth = 200;

    // Function to update card interactivity based on legal moves
    function updateCardLegality() {
        console.log(`updateCardLegality: bidding=${bidding}, currentTurn=${currentTurn}, position=${position}, myCards.length=${myCards.length}`);
        myCards.forEach(sprite => {
            if (!sprite || !sprite.active) return;
            const card = sprite.getData('card');
            if (!card) return;

            // During bidding or not our turn, dim all cards
            if (bidding === 1 || currentTurn !== position || playedCard) {
                sprite.setTint(0xaaaaaa);
                console.log(`Dimmed ${card.rank} of ${card.suit}, tint after: ${sprite.tintTopLeft}`);
                sprite.setData('isLegal', false);
                return;
            }

            // Check if this card is a legal move
            // Pass leadPosition (who led the trick) for HI joker rule, not player's position
            const isLegal = isLegalMove(card, playerCards, leadCard, playedCardIndex === 0, leadPosition);

            if (isLegal) {
                console.log(`Enabling ${card.rank} of ${card.suit}, tint before: ${sprite.tintTopLeft}`);
                sprite.clearTint();
                console.log(`After clearTint: ${sprite.tintTopLeft}`);
                sprite.setData('isLegal', true);
            } else {
                sprite.setTint(0x666666);
                sprite.setData('isLegal', false);
            }
        });
    }

    // Store the update function globally so socket handlers can call it
    window.updateCardLegality = updateCardLegality;

    // PHASE 5 MIGRATION: Card sprite creation is now handled by CardManager via handleDisplayHand in main.js
    // The card sprites, hover effects, click handlers, and legality updates are all managed by CardManager.
    // This section is kept for reference but the card creation loop has been removed.
    console.log("🃏 Card sprites now handled by CardManager (", playerHand.length, "cards)");

    // Note: updateCardLegality() is kept for legacy handlers but will operate on empty myCards array
    // The actual card legality is now managed by CardManager.updateCardLegality() via handleUpdateTurn

    // Helper function to force Phaser to re-render sprites
    // This fixes a bug where visual updates don't show until page refresh
    function forceRenderUpdate() {
        requestAnimationFrame(() => {
            // Strategy 1: Force WebGL pipeline flush by toggling blend mode
            myCards.forEach(sprite => {
                if (sprite && sprite.active) {
                    const currentBlend = sprite.blendMode;
                    sprite.setBlendMode(Phaser.BlendModes.ADD);
                    sprite.setBlendMode(currentBlend);
                    sprite.setVisible(false);
                    sprite.setVisible(true);
                    sprite.setInteractive();
                }
            });

            // Note: Removed scale.refresh() and game.renderer.render() calls
            // as they can trigger resize event loops
        });
    }

    // Only register socket listeners once to prevent duplicates across hands
    if (gameListenersRegistered) {
        console.log("⏭️ Socket listeners already registered, skipping...");
        return;
    }
    gameListenersRegistered = true;
    console.log("📡 Registering game socket listeners...");

    // NOTE: bidReceived handler migrated to GameScene.handleBidReceived()

    // NOTE: updateTurn handler migrated to GameScene.handleUpdateTurn()

    // NOTE: cardPlayed handler migrated to GameScene.handleCardPlayed()

    // NOTE: trickComplete handler migrated to GameScene.handleTrickComplete()
    // NOTE: doneBidding handler migrated to GameScene.handleDoneBidding()
    // NOTE: handComplete handler migrated to GameScene.handleHandComplete()
}
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