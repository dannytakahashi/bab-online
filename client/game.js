
// Variable declarations moved to top to avoid temporal dead zone errors
// Note: hasDrawn, clickedCardPosition, drawnCardDisplays, allCards moved to DrawManager.js
// NOTE: myCards, ranks, getRankValues() removed - card sprites now in CardManager

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

    // Display trump card via modular GameScene
    if (trump && gameScene) {
        gameScene.displayTrumpCard(trump);
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
    if (gameScene && gameScene.layoutManager) {
        gameScene.layoutManager.cleanupDomBackgrounds();
    }
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
// NOTE: visible() removed - not used anywhere

// ============================================
// Phaser UI Helper Functions
// ============================================

// NOTE: createSpeechBubble removed - now handled by ChatBubble.createSpeechBubble()

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

// NOTE: showImpactEvent removed - now handled by EffectsManager.showImpactEvent()

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
// NOTE: currentTeamBids, currentOppBids, playedCard, opponentAvatarDoms removed - not used
let playerInfo = null;
let gameListenersRegistered = false; // Track if socket listeners are already registered

// PHASE 7: create() function moved to GameScene.js
// Scene lifecycle is now handled by the modular GameScene class

// Reposition remaining game elements when window is resized
// NOTE: Most repositioning is now handled by modular managers:
// - LayoutManager: DOM backgrounds, bid container
// - CardManager: player hand cards
// - OpponentManager: opponent avatars and cards
// - TrickManager: current trick cards
function repositionGameElements(newWidth, newHeight) {
    const scaleFactorX = newWidth / 1920;
    const scaleFactorY = newHeight / 953;

    // Reposition trump card display (top right area) via GameScene
    if (gameScene) {
        gameScene.repositionTrumpDisplay();
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

    // Update play area positions for card animations
    updatePlayPositions(newWidth, newHeight);
}

// NOTE: The following resize functions have been removed as they're now handled by modular managers:
// - repositionHandCards -> CardManager.repositionHand()
// - positionDomBackgrounds -> LayoutManager.positionDomBackgrounds()
// - cleanupDomBackgrounds -> LayoutManager.cleanupDomBackgrounds()
// - repositionOpponentElements -> OpponentManager.reposition()
// - repositionTurnGlow -> CSS-based, no action needed
// - repositionCurrentTrick -> TrickManager.repositionCurrentTrick()

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

    // Note: Tricks are now cleared by TrickManager.clearAll() in handleHandComplete

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
    // Display trump card via modular GameScene
    if (data.trump && gameScene) {
        console.log("🎮 Calling displayTrumpCard");
        gameScene.displayTrumpCard(data.trump);
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
// NOTE: GAME_LOG_WIDTH removed - now in LayoutManager
let playerId, position, playerCards, trump = [];

// Card utility - delegating to ModernUtils
function getCardImageKey(card) {
    return window.ModernUtils.getCardImageKey(card);
}
// PHASE 7: preload() moved to GameScene.js

// NOTE: Rank values now use window.ModernUtils.RANK_VALUES directly
// NOTE: opponentCardSprites, myCards, destroyAllCards removed
// - Card sprites now managed by CardManager and OpponentManager
// - Cleanup done via handleDestroyHands -> CardManager.clearHand() + OpponentManager.clearAll()
socket.on("destroyHands", (data) => {
    console.log("caught destroyHands");
    // Remove socket listeners registered in legacy code
    socket.off("handComplete");
    socket.off("doneBidding");
    socket.off("trickComplete");
    socket.off("cardPlayed");
    socket.off("updateTurn");
    socket.off("bidReceived");

    // Note: Card sprite destruction now handled by modular handler:
    // gameHandlers.js → main.js onDestroyHands → scene.handleDestroyHands
    // which calls CardManager.clearHand() + OpponentManager.clearAll()

    // Reset flag so listeners are re-registered on redeal
    gameListenersRegistered = false;
    // Reset trick counts for redeal
    teamTricks = 0;
    oppTricks = 0;
});
// Draw phase functions (draw, removeDraw) moved to DrawManager.js
// See client/src/phaser/managers/DrawManager.js

// NOTE: displayTableCard removed - now handled by GameScene.displayTrumpCard()

let isTrumpBroken = false;
let teamTricks = 0;
let oppTricks = 0;

// NOTE: isLegalMove wrapper removed - use window.ModernUtils.isLegalMove() directly

// NOTE: teamTrickHistory, oppTrickHistory, playerBids, tempBids, thisTrick removed - never used
// Trick history now managed by TrickManager
let bidding = 1;
let playedCardIndex = 0;
let leadCard = null;
let leadPosition = null;
let currentTrick = []; // Still used by processRejoin for restoring played cards
// Play area positions - updated on resize (Bug 3 fix)
let playPositions = {
    opponent1: { x: 0, y: 0 },
    opponent2: { x: 0, y: 0 },
    partner: { x: 0, y: 0 },
    self: { x: 0, y: 0 }
};
// Note: handBackground and border are now DOM elements with ids 'handBackgroundDom' and 'handBorderDom'
// NOTE: clearAllTricks removed - trick history now managed by TrickManager
// TrickManager.clearAll() is called by handleHandComplete when a new hand starts
socket.on("disconnect", () => {
    console.log("⚠️ Disconnected from server. Auto-reconnecting...");
    // Don't show sign-in screen - let Socket.IO handle reconnection
    // The socketManager will attempt to rejoin the game on reconnect
});
socket.on("abortGame", (data) => {
    playerInfo = null;
    console.log("caught abortGame");
    // Use scene handler if available
    if (gameScene && gameScene.handleAbortGame) {
        gameScene.handleAbortGame(data);
    }
    if (gameScene && gameScene.layoutManager) {
        gameScene.layoutManager.cleanupDomBackgrounds();
    }
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
    if (gameScene && gameScene.layoutManager) {
        gameScene.layoutManager.cleanupDomBackgrounds();
    }
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
            // Return to main room
            socket.emit("joinMainRoom");
        }
    });
});

// NOTE: showChatBubble and chatMessage handler removed
// - Now handled by modular ChatBubble.js and main.js onChatMessage callback
// - GameScene.handleShowChatBubble uses ChatBubble.showChatBubble

// NOTE: window.*FromLegacy bridges now provided by main.js using modular GameLog

// NOTE: clearDisplayCards, getSuitOrder, sortHand, displayCards removed - now handled by modular code:
// - CardManager.displayHand() for card sprites
// - BidManager.showBidUI() for bidding interface
// - LayoutManager.createDomBackgrounds() for play zone and hand backgrounds
// myCards declared at top of file

// NOTE: buttonHandle and oppUI removed - never populated
// NOTE: createOpponentAvatarDom and cleanupOpponentAvatars removed
// - Now handled by OpponentManager.createOpponentAvatar() and OpponentManager.cleanupOpponentAvatars()

function displayOpponentHands(numCards, dealer, skipAnimation = false) {
    console.log("🎭 displayOpponentHands called! skipAnimation:", skipAnimation);
    console.log("🎭 numCards:", numCards, "dealer:", dealer);
    console.log("🎭 position:", position);

    // PHASE 6 MIGRATION: Card sprites and avatars are now handled by OpponentManager
    // via handleDisplayOpponentHands in main.js. This function now only handles
    // the player position text (BTN, MP, CO, UTG) which OpponentManager doesn't manage.

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