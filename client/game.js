/**
 * Legacy game.js - Minimal bridge for client modularization
 *
 * MIGRATION STATUS: Most functionality has been migrated to modular code in src/
 * This file contains remaining functions needed during the transition:
 * - processRejoin: Game reconnection handling (partial overlap with main.js onRejoinSuccess)
 * - createPlayerInfoBox: Player avatar/name display
 * - Socket handlers: abortGame, forceLogout, roomFull, gameEnd
 * - Window bridges: processPositionUpdateFromLegacy, processGameStartFromLegacy, etc.
 *
 * See src/main.js and src/phaser/ for the modular implementations.
 */

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

    // Create player info via scene method (preferred) or legacy
    if (gameScene && gameScene.createPlayerInfoBox && !gameScene._playerInfo) {
        gameScene.createPlayerInfoBox(playerData, position);
    } else if (!playerInfo) {
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
        // Scene not ready - modular code in main.js onRejoinSuccess handles deferred setup
        console.log("⏳ processRejoin deferred - scene not ready, modular code will handle");
    }
});

// Handle rejoin failure
document.addEventListener("rejoinFailed", (event) => {
    console.log("Rejoin failed:", event.detail.reason);
    // Return to main room
    socket.emit("joinMainRoom");
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
let playerInfo = null;

function repositionGameElements(newWidth, newHeight) {
    const scaleFactorX = newWidth / 1920;
    const scaleFactorY = newHeight / 953;

    // Reposition trump card display (top right area) via GameScene
    if (gameScene) {
        gameScene.repositionTrumpDisplay();
    }

    // Reposition player info (bottom right) via scene method or legacy
    if (gameScene && gameScene.repositionPlayerInfo) {
        gameScene.repositionPlayerInfo();
    } else if (playerInfo && playerInfo.playerAvatar) {
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

function processPositionUpdate(data) {
    console.log("Position update received:", data);
    playerData = {
        position: data.positions,
        socket: data.sockets,
        username: data.usernames,
        pics: data.pics
    };
    console.log("✅ playerData initialized:", playerData);

    // Create player info if deferred - use scene method (preferred) or legacy
    if (position && gameScene) {
        if (gameScene.createPlayerInfoBox && !gameScene._playerInfo) {
            gameScene.createPlayerInfoBox(playerData, position);
            console.log("✅ playerInfo created via scene after positionUpdate");
        } else if (!playerInfo) {
            playerInfo = createPlayerInfoBox();
            if (playerInfo) {
                console.log("✅ playerInfo created after positionUpdate");
            }
        }
    }
}

function processGameStart(data) {
    console.log("🎮 processGameStart called with position:", data.position);

    // Use position from gameStart data to avoid race condition with playerAssigned event
    if (data.position) {
        position = data.position;
    }

    // Check for race condition: position might not be set yet
    if (position === undefined) {
        console.warn("⏳ Position not set, waiting for playerAssigned...");
        setTimeout(() => processGameStart(data), 100);
        return;
    }

    // Check for playerData not being set
    if (!playerData) {
        console.warn("⏳ playerData not set, waiting for positionUpdate...");
        setTimeout(() => processGameStart(data), 100);
        return;
    }

    playerCards = data.hand;
    dealer = data.dealer;
    if (playerCards && playerCards.length > 0) {
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
        // Create player info via scene method (preferred) or legacy
        if (gameScene && gameScene.createPlayerInfoBox && !gameScene._playerInfo) {
            gameScene.createPlayerInfoBox(playerData, position);
        } else if (!playerInfo) {
            playerInfo = createPlayerInfoBox();
        }
        // Set trump for legacy code (modular code handles via gameState.setTrump)
        if (data.trump) {
            trump = data.trump;
        }
        // Set bidding state for legacy code (modular code handles via gameState.isBidding)
        bidding = 1;
        // NOTE: displayCards and displayOpponentHands now handled by modular code
        // via CardManager, OpponentManager, LayoutManager, and BidManager
    }
    // Display trump card via modular GameScene
    if (data.trump && gameScene) {
        gameScene.displayTrumpCard(data.trump);
    }
}

// Expose processing functions for modular code to call
window.processPositionUpdateFromLegacy = function(data) {
    if (gameScene && gameScene.scale) {
        processPositionUpdate(data);
    } else {
        // Scene not ready - modular code in main.js onPositionUpdate handles deferred setup
        console.log("⏳ processPositionUpdate deferred - scene not ready");
    }
};

window.processGameStartFromLegacy = function(data) {
    if (gameScene && gameScene.scale) {
        processGameStart(data);
    } else {
        // Scene not ready - modular code in main.js onGameStart handles deferred setup
        console.log("⏳ processGameStart deferred - scene not ready");
    }
};

let playerId, position, playerCards, trump = [], dealer;

function getCardImageKey(card) {
    return window.ModernUtils.getCardImageKey(card);
}

let bidding = 1;
let playedCardIndex = 0;
let leadCard = null;
let leadPosition = null;
let currentTrick = [];
let playPositions = {
    opponent1: { x: 0, y: 0 },
    opponent2: { x: 0, y: 0 },
    partner: { x: 0, y: 0 },
    self: { x: 0, y: 0 }
};

socket.on("abortGame", (data) => {
    playerInfo = null;
    console.log("caught abortGame");
    // Clear scene player info
    if (gameScene && gameScene.clearPlayerInfo) {
        gameScene.clearPlayerInfo();
    }
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

window.updatePlayerPositionTextFromLegacy = function(dealer) {
    // Use scene method (preferred) or legacy playerInfo
    if (gameScene && gameScene.updatePlayerPositionText) {
        gameScene.updatePlayerPositionText(dealer, position);
    } else if (playerInfo && playerInfo.playerPositionText) {
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
};

window.repositionGameElements = function(newWidth, newHeight) {
    const scene = window.gameScene;
    if (!scene) return;
    repositionGameElements.call(scene, newWidth, newHeight);
};