

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

    // Clear any sign-in/lobby screens first
    removeAllVignettes();
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
    removeWaitingScreen();
    removeDraw();

    // Create game UI elements (chat input is now integrated into game feed)
    createGameFeed();

    // Calculate player names (same as gameStart handler)
    me = playerData.username[playerData.position.indexOf(position)]?.username || 'You';
    partner = playerData.username[playerData.position.indexOf(team(position))]?.username || 'Partner';
    opp1 = playerData.username[playerData.position.indexOf(rotate(position))]?.username || 'Opp1';
    opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))]?.username || 'Opp2';

    // Update score display in game log
    if (position % 2 !== 0) {
        updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score1, score2);
    } else {
        updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score2, score1);
    }

    // Create player info box
    if (!playerInfo) {
        playerInfo = createPlayerInfoBox();
    }

    // Display cards
    if (playerCards && playerCards.length > 0) {
        displayCards.call(gameScene, playerCards);
    }

    // Display opponent hands (card backs)
    displayOpponentHands.call(gameScene, playerCards ? playerCards.length : 0, dealer);

    // Display trump card
    if (trump) {
        displayTableCard.call(gameScene, trump);
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
    addToGameFeed(`${data.username} disconnected - waiting for reconnection...`);
});

// Handle complete reconnection failure (all attempts exhausted)
document.addEventListener("reconnectFailed", () => {
    console.log("❌ All reconnection attempts failed");
    if(gameScene){
        gameScene.scene.restart();
        socket.off("gameStart");
    }
    cleanupDomBackgrounds();
    removeWaitingScreen();
    clearUI();
    showSignInScreen();
    alert("Connection lost. Please sign in again.");
});
function visible(){
    if(document.visibilityState === "visible"){
        return true;
    }
    else{
        return false;
    }
}
function createVignette() {
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    
    let centerX = screenWidth / 2;
    let centerY = screenHeight / 2;
    
    // ✅ Calculate the diagonal length to fully cover the screen
    let maxRadius = Math.sqrt(screenWidth ** 2 + screenHeight ** 2) * 0.75; // Adjust coverage factor

    let vignette = this.add.graphics();

    for (let i = maxRadius; i > 0; i -= 10) {
        let alpha = (i / maxRadius) * 1.5; // ✅ Stronger fade effect at the edges
        let color = Phaser.Display.Color.Interpolate.ColorWithColor(
            new Phaser.Display.Color(34, 139, 34), // ✅ Bright green (#228B22)
            new Phaser.Display.Color(0, 0, 0),     // ✅ Black
            maxRadius,
            i
        );

        vignette.fillStyle(Phaser.Display.Color.GetColor(color.r, color.g, color.b), alpha);
        vignette.fillCircle(centerX, centerY, i);
    }

    vignette.setDepth(-3); // ✅ Ensure vignette is behind game elements
}
let gameScene;
let playerData;
let currentTurn;
function team(position){
    if(position === 1){
        return 3;
    }
    if (position === 2){
        return 4;
    }
    if (position === 3){
        return 1;
    }
    if (position === 4){
        return 2;
    }
}
// Rotate to next player position (clockwise: 1→2→3→4→1)
function rotate(num){
    return (num % 4) + 1;
}
// Helper function to safely get player username from position
function getPlayerName(pos) {
    if (!playerData || !playerData.username || !playerData.position) {
        console.warn("⚠️ playerData not initialized when getting name for position:", pos);
        return `Player ${pos}`;
    }
    const index = playerData.position.indexOf(pos);
    if (index === -1) {
        console.warn("⚠️ Position not found in playerData:", pos);
        return `Player ${pos}`;
    }
    const player = playerData.username[index];
    if (!player || !player.username) {
        console.warn("⚠️ No username at index:", index);
        return `Player ${pos}`;
    }
    return player.username;
}
let scoreUI = null;
let me = null;
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
let waitBool = false;
let queueDelay = false;
let lastQueueData;
let opponentAvatarDoms = { partner: null, opp1: null, opp2: null }; // DOM-based opponent avatars for CSS glow support
function create() {
    gameScene = this; // Store reference to the game scene
    console.log("🚀 CREATE() RUNNING!");
    console.log("🚀 gameScene set to:", gameScene);
    console.log("🚀 gameScene.textures:", gameScene.textures);
    console.log("🚀 gameScene.add:", gameScene.add);
    console.log("🚀 pendingPositionData:", pendingPositionData);
    console.log("🚀 pendingGameStartData:", pendingGameStartData);
    console.log("running create4...");
    console.log("Socket in game.js:", socket);

    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    // Background is now handled by CSS gradient on body - canvas is transparent

    // Check if there's pending rejoin data from before scene was ready
    if (pendingRejoinData) {
        processRejoin(pendingRejoinData);
        pendingRejoinData = null;
        return; // Skip normal create flow since we're rejoining
    }

    // Process any pending game data that arrived before scene was ready
    if (pendingPositionData) {
        console.log("🚀 Processing PENDING positionUpdate data from create()");
        processPositionUpdate(pendingPositionData);
        pendingPositionData = null;
    }
    if (pendingGameStartData) {
        console.log("🚀 Processing PENDING gameStart data from create()");
        processGameStart(pendingGameStartData);
        pendingGameStartData = null;
    }
    // Handle window resize - reposition all game elements
    this.scale.on('resize', (gameSize) => {
        repositionGameElements.call(this, gameSize.width, gameSize.height);
    });

    console.log("🚀 CREATE() COMPLETE!");
}

// Reposition all game elements when window is resized
function repositionGameElements(newWidth, newHeight) {
    const scaleFactorX = newWidth / 1920;
    const scaleFactorY = newHeight / 953;

    // Position DOM background elements (play zone, hand background, border)
    positionDomBackgrounds(newWidth, newHeight);

    // Reposition cards in player's hand
    repositionHandCards(newWidth, newHeight, scaleFactorX, scaleFactorY);

    // Reposition opponent UI elements (avatars, names, card backs)
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
            if (team(position) === dealer) {
                buttonHandle.setPosition(positions.partner.avatarX + 75 * scaleFactorX, positions.partner.avatarY);
            } else if (rotate(position) === dealer) {
                buttonHandle.setPosition(positions.opp1.avatarX - 75 * scaleFactorX, positions.opp1.avatarY);
            } else if (rotate(rotate(rotate(position))) === dealer) {
                buttonHandle.setPosition(positions.opp2.avatarX + 75 * scaleFactorX, positions.opp2.avatarY);
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
        me = playerData.username[playerData.position.indexOf(position)].username;
        partner = playerData.username[playerData.position.indexOf(team(position))].username;
        opp1 = playerData.username[playerData.position.indexOf(rotate(position))].username;
        opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;
        // Update score in game log instead of old scorebug
        if(position % 2 !== 0){
            updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score1, score2);
        }
        else{
            updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score2, score1);
        }
        if(!playerInfo){
            playerInfo = createPlayerInfoBox(); // Store the reference
        }
        // Set trump BEFORE displayCards so sorting works correctly
        if (data.trump) {
            trump = data.trump;
        }
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

// Register socket handlers globally (outside create) so they're ready immediately
socket.on("positionUpdate", (data) => {
    if (gameScene && gameScene.scale) {
        processPositionUpdate(data);
    } else {
        console.log("⏳ Scene not ready, queuing positionUpdate data");
        pendingPositionData = data;
    }
});

socket.on("gameStart", (data) => {
    if (gameScene && gameScene.scale) {
        processGameStart(data);
    } else {
        console.log("⏳ Scene not ready, queuing gameStart data");
        pendingGameStartData = data;
    }
});

// Reserve 320px on the right for game log (300px width + 20px padding)
const GAME_LOG_WIDTH = 320;
const config = {
    type: Phaser.AUTO,
    width: innerWidth - GAME_LOG_WIDTH,
    height: innerHeight,
    transparent: true, // Make canvas transparent so CSS background shows through
    parent: "game-container",
    scale: {
        mode: Phaser.Scale.RESIZE, // Dynamic resizing for window resize handling
        autoCenter: Phaser.Scale.NO_CENTER // Align left to leave room for game log
    },
    scene: { preload, create, update }
};
const game = new Phaser.Game(config);// ✅ Small delay to ensure the game is loaded
let playerId, playerCards, trump = [];
function getCardImageKey(card) {
    let rank = card.rank.toLowerCase(); // Example: "A" → "a", "10" → "10"
    let suit = card.suit.toLowerCase(); // Example: "Spades" → "spades"

    return `${rank}_${suit}`;  // Example: "ace_spades"
}
function preload() {
    console.log("running preload...");

    // Load card atlas (reduces 54 requests to 2)
    this.load.atlas("cards", "assets/sprites/cards.png", "assets/sprites/cards.json");

    // Load other essential assets
    this.load.image("cardBack", "assets/card_back.png");
    this.load.image("dealer", "assets/frog.png");
    this.load.image("background", "assets/background.png");
    this.load.image("rainbow", "assets/rainbow1.png");
    this.load.image("ot", "assets/ot.png");
    this.load.image("b", "assets/b.png");
    this.load.image("2b", "assets/2b.png");
    this.load.image("3b", "assets/3b.png");
    this.load.image("4b", "assets/4b.png");

    // Load profile images (will be lazy-loaded in future optimization)
    for (let i = 1; i <= 82; i++) {
        // Skip missing profile numbers (10, 11 don't exist)
        if (i === 10 || i === 11) continue;
        this.load.image(`profile${i}`, `assets/profile${i}.png`);
    }
}
let ranks = {
    "HI": 16,
    "LO": 15,
    "A": 14,
    "K": 13,
    "Q": 12,
    "J": 11,
    "10": 10,
    "9": 9,
    "8": 8,
    "7": 7,
    "6": 6,
    "5": 5,
    "4": 4,
    "3": 3,
    "2": 2
}
let opponentCardSprites = {};
let tableCardSprite;
function createGameFeed() {
    let feedCheck = document.getElementById("gameFeed");
    if(feedCheck){
        console.log("feed already exists.");
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

    // Add initial message to confirm feed is working
    addToGameFeed("Game started!");

    // Restrict game container width to make room for game log
    document.getElementById('game-container').classList.add('in-game');
    // Trigger resize so Phaser recalculates canvas size
    window.dispatchEvent(new Event('resize'));
}
function addToGameFeed(message, playerPosition = null) {
    let messagesArea = document.getElementById("gameFeedMessages");

    if (!messagesArea) {
        console.warn("Game feed messages area not found!");
        return;
    }

    // Get current time for timestamp
    const now = new Date();
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

let handGlow;
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
let allCards = [];
let rainbows = [];
socket.on("rainbow", (data) => {
    console.log("caught rainbow");
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
    socket.off("handComplete");
    socket.off("doneBidding");
    socket.off("trickComplete");
    socket.off("cardPlayed");
    socket.off("updateTurn");
    socket.off("bidReceived");
    socket.off("cardPlayed");
    destroyAllCards();
    // Reset flag so listeners are re-registered on redeal
    gameListenersRegistered = false;
    // Reset bid and trick state for redeal
    currentTeamBids = "-/-";
    currentOppBids = "-/-";
    teamTricks = 0;
    oppTricks = 0;
});
// Track drawn cards display during draw phase
let drawnCardDisplays = [];
let hasDrawn = false;
let clickedCardPosition = null; // Store position of clicked card for draw animation

function draw() {
    clearScreen.call(game.scene.scenes[0]);
    socket.off("youDrew");
    socket.off("playerDrew");
    hasDrawn = false;
    drawnCardDisplays = [];

    console.log("🃏 Placing all 54 cards face down...");
    let scene = this;
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let scaleFactorX = screenWidth / 1920;
    let scaleFactorY = screenHeight / 953;
    let startX = 400*scaleFactorX;
    let startY = screenHeight / 2;
    let overlap = 20*scaleFactorX;

    // Positions for drawn cards display (4 slots above the deck)
    const drawDisplayY = screenHeight / 2 - 200*scaleFactorY;
    const drawDisplayStartX = screenWidth / 2 - 300*scaleFactorX;
    const drawDisplaySpacing = 200*scaleFactorX;

    // Background is now handled by CSS gradient on body - canvas is transparent

    // Add "Draw for Deal" title
    const titleText = this.add.text(screenWidth / 2, 80*scaleFactorY, "Draw for Deal", {
        fontSize: `${48*scaleFactorX}px`,
        fontStyle: "bold",
        color: "#FFFFFF",
        stroke: "#000000",
        strokeThickness: 4
    }).setOrigin(0.5).setDepth(200);
    allCards.push(titleText);

    // Create deck cards
    for (let i = 0; i < 54; i++) {
        let cardSprite = this.add.image(screenWidth/2 + 500*scaleFactorX, startY, "cardBack")
            .setScale(1.2)
            .setInteractive()
            .setDepth(100);

        if (visible()) {
            this.tweens.add({
                targets: cardSprite,
                x: startX + i * overlap,
                y: startY,
                duration: 750,
                ease: "Power2",
                delay: 0
            });
        } else {
            cardSprite.x = startX + i * overlap;
            cardSprite.y = startY;
        }

        cardSprite.on("pointerdown", () => {
            if (hasDrawn) return; // Prevent multiple draws
            hasDrawn = true;

            // Store clicked card position for flip animation
            clickedCardPosition = { x: cardSprite.x, y: cardSprite.y };

            console.log(`📦 Clicked card ${i + 1} to draw at (${cardSprite.x}, ${cardSprite.y})`);
            socket.emit("draw", {num: Math.floor(Math.random() * 54)});

            // Disable all cards immediately
            allCards.forEach(card => {
                if (card.disableInteractive) card.disableInteractive();
            });
        });
        allCards.push(cardSprite);
    }

    // Listen for your own draw result
    socket.on("youDrew", (data) => {
        console.log(`🎴 You drew: ${data.card.rank} of ${data.card.suit}`);
        // The playerDrew event will handle the display for all players including self
    });

    // Listen for any player drawing (including self)
    socket.on("playerDrew", (data) => {
        console.log(`🎴 ${data.username} drew: ${data.card.rank} of ${data.card.suit} (order: ${data.drawOrder})`);

        // Calculate position for this drawn card (drawOrder is 1-4)
        const slotX = drawDisplayStartX + (data.drawOrder - 1) * drawDisplaySpacing;
        let textureKey = getCardImageKey(data.card);

        // Determine start position: clicked position for local player, deck center for others
        let isLocalPlayer = clickedCardPosition !== null;
        let startPos = isLocalPlayer
            ? { x: clickedCardPosition.x, y: clickedCardPosition.y }
            : { x: screenWidth / 2, y: startY };

        // Create card with BACK texture initially at start position
        let drawnCard = scene.add.image(startPos.x, startPos.y, 'cardBack')
            .setScale(0.8)
            .setDepth(300);

        // Create username label
        let nameLabel = scene.add.text(slotX, drawDisplayY - 80*scaleFactorY, data.username, {
            fontSize: `${24*scaleFactorX}px`,
            fontStyle: "bold",
            color: "#FFFFFF",
            stroke: "#000000",
            strokeThickness: 3
        }).setOrigin(0.5).setDepth(300);

        // Calculate midpoint for flip animation
        const midX = (startPos.x + slotX) / 2;
        const midY = (startPos.y + drawDisplayY) / 2;

        // Phase 1: Move toward midpoint and scale X to 0 (flip start)
        scene.tweens.add({
            targets: drawnCard,
            x: midX,
            y: midY,
            scaleX: 0,
            scaleY: 1.1,
            duration: 250,
            ease: "Power2",
            onComplete: () => {
                // Change texture to revealed card at the flip midpoint
                drawnCard.setTexture('cards', textureKey);

                // Phase 2: Scale X back and complete movement to display slot
                scene.tweens.add({
                    targets: drawnCard,
                    x: slotX,
                    y: drawDisplayY,
                    scaleX: 1.5,
                    scaleY: 1.5,
                    duration: 250,
                    ease: "Power2"
                });
            }
        });

        // Clear clicked position after local player's card is processed
        if (isLocalPlayer) {
            clickedCardPosition = null;
        }

        drawnCardDisplays.push(drawnCard, nameLabel);
    });

    console.log("✅ All 54 cards placed face down and clickable.");
}
function removeDraw() {
    console.log("🔥 Destroying all displayed cards...");

    allCards.forEach(card => {
        if (card) {
            card.destroy();
        }
    });
    allCards = [];

    // Also clean up drawn card displays
    drawnCardDisplays.forEach(item => {
        if (item) {
            item.destroy();
        }
    });
    drawnCardDisplays = [];

    // Clean up socket listeners
    socket.off("youDrew");
    socket.off("playerDrew");

    console.log("✅ All cards removed.");
}
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
function sameSuit(card1, card2){
    if(card1.suit === card2.suit){
        return true;
    }
    else if((card1.suit === "joker" && card2.suit === trump.suit) || (card2.suit === "joker" && card1.suit === trump.suit)){
        return true;
    }
    else{
        return false;
    }
}
function isVoid(hand, ledsuit){
    console.log("isVoid check - ledsuit:", ledsuit, "hand:", hand.map(c => c.rank + " of " + c.suit));
    let proto = {rank: 1, suit : ledsuit}
    for(let card of hand){
        if(sameSuit(card,proto)){
            console.log("Found matching card:", card.rank, "of", card.suit);
            return false;
        }
    }
    console.log("No matching cards - player is void");
    return true;
}
function isTrumpTight(hand, trump){
    for(let card of hand){
        if(card.suit !== trump.suit && card.suit !== "joker"){
            return false;
        }
    }
    return true;
}
function highestTrump(rank, hand, trump){
    for(let card of hand){
        if((sameSuit(card,trump)) && (ranks[card.rank] > ranks[rank])){
            return false;
        }
    }
    return true;
}
let isTrumpBroken = false;
let teamTricks = 0;
let oppTricks = 0;
function isLegalMove(card, hand, lead, leadBool, leadPosition){
    console.log("=== isLegalMove check ===");
    console.log("card:", card.rank, "of", card.suit);
    console.log("lead:", lead?.rank, "of", lead?.suit);
    console.log("leadBool (is leading?):", leadBool);
    console.log("hand suits:", hand.map(c => c.suit));
    console.log("trump:", trump?.suit);

    // Skip following-suit check if we're leading
    if (leadBool) {
        // Leading: can't lead trump unless broken (or trump tight)
        if (sameSuit(card,trump) && !isTrumpBroken && !isTrumpTight(hand, trump)){
            console.log("ILLEGAL: trump not broken and not trump tight");
            return false;
        }
        console.log("LEGAL: leading");
        return true;
    }

    // Following
    console.log("lead.suit value:", lead.suit, "typeof:", typeof lead.suit);
    console.log("lead object:", JSON.stringify(lead));
    const isVoidInLeadSuit = isVoid(hand, lead.suit);
    console.log("isVoid in lead suit:", isVoidInLeadSuit);
    console.log("sameSuit(card, lead):", sameSuit(card, lead));

    if (!sameSuit(card, lead) && !isVoidInLeadSuit){
        console.log("ILLEGAL: not following suit when not void");
        return false;
    }
    // HI joker special rule: opponents must play highest trump
    if (lead.rank === "HI") {
        console.log("HI joker led! Checking highest trump rule...");
        console.log("leadPosition:", leadPosition, "position:", position);
        console.log("Is opponent?", leadPosition % 2 !== position % 2);
        console.log("Is highest trump in hand?", highestTrump(card.rank, hand, trump));

        if ((leadPosition % 2 !== position % 2) && !highestTrump(card.rank, hand, trump)) {
            console.log("ILLEGAL: HI lead requires highest trump from opponents");
            return false;
        }
    }
    console.log("LEGAL: following rules satisfied");
    return true;
}
let waitingText;
// Note: playZone is now a DOM element with id 'playZoneDom'
function removeCard(hand, card) {
    hand.forEach((c) => {
        if (c.rank === card.rank && c.suit === card.suit) {
            hand.splice(hand.indexOf(c), 1);
        }
    });
    return hand;
}
let teamTrickHistory = [];
let oppTrickHistory = [];
let bidding = 1;
let playerBids = [];
let playedCardIndex = 0;
let leadCard = [];
let leadPosition = [];
let leadBool = false;
let tempBids = [];
let currentTrick = [];
let thisTrick = [];
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
    cleanupDomBackgrounds();
    clearUI();
    gameScene.children.removeAll(true);
    gameScene.scene.restart();
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
    removeWaitingScreen();
    clearUI();
    showSignInScreen();
});
socket.on("roomFull", (data) => {
    console.log("caught roomFull");
    removeWaitingScreen();
    // Return to main room (this shouldn't happen with lobby system)
    socket.emit("joinMainRoom");
});
socket.on("gameEnd", (data) => {
    console.log("caught gameEnd");
    // Determine which team the player is on (positions 1,3 = Team 1, positions 2,4 = Team 2)
    // and show scores accordingly
    if (position % 2 !== 0) {
        // Player is on Team 1 (odd positions 1, 3)
        showFinalScore(data.score.team1, data.score.team2);
    } else {
        // Player is on Team 2 (even positions 2, 4)
        showFinalScore(data.score.team2, data.score.team1);
    }
});
socket.on("startDraw", (data) => {
    removeWaitingScreen();
    draw.call(game.scene.scenes[0]);
});
socket.on("teamsAnnounced", (data) => {
    console.log("🏆 Teams announced:", data);
    let scene = game.scene.scenes[0];
    let screenWidth = scene.scale.width;
    let screenHeight = scene.scale.height;
    let scaleFactorX = screenWidth / 1920;
    let scaleFactorY = screenHeight / 953;

    // Create semi-transparent overlay
    const overlay = scene.add.rectangle(screenWidth / 2, screenHeight / 2, screenWidth, screenHeight, 0x000000, 0.7)
        .setDepth(400);

    // Team announcement title
    const title = scene.add.text(screenWidth / 2, screenHeight / 2 - 120*scaleFactorY, "Teams", {
        fontSize: `${56*scaleFactorX}px`,
        fontStyle: "bold",
        color: "#FFD700",
        stroke: "#000000",
        strokeThickness: 4
    }).setOrigin(0.5).setDepth(401);

    // Team 1 display
    const team1Label = scene.add.text(screenWidth / 2, screenHeight / 2 - 30*scaleFactorY, "Team 1", {
        fontSize: `${32*scaleFactorX}px`,
        fontStyle: "bold",
        color: "#4ade80"
    }).setOrigin(0.5).setDepth(401);

    const team1Players = scene.add.text(screenWidth / 2, screenHeight / 2 + 20*scaleFactorY,
        `${data.team1[0]} & ${data.team1[1]}`, {
        fontSize: `${28*scaleFactorX}px`,
        color: "#FFFFFF"
    }).setOrigin(0.5).setDepth(401);

    // VS text
    const vsText = scene.add.text(screenWidth / 2, screenHeight / 2 + 70*scaleFactorY, "vs", {
        fontSize: `${24*scaleFactorX}px`,
        fontStyle: "italic",
        color: "#9ca3af"
    }).setOrigin(0.5).setDepth(401);

    // Team 2 display
    const team2Label = scene.add.text(screenWidth / 2, screenHeight / 2 + 120*scaleFactorY, "Team 2", {
        fontSize: `${32*scaleFactorX}px`,
        fontStyle: "bold",
        color: "#f87171"
    }).setOrigin(0.5).setDepth(401);

    const team2Players = scene.add.text(screenWidth / 2, screenHeight / 2 + 170*scaleFactorY,
        `${data.team2[0]} & ${data.team2[1]}`, {
        fontSize: `${28*scaleFactorX}px`,
        color: "#FFFFFF"
    }).setOrigin(0.5).setDepth(401);

    // Store references for cleanup
    const teamElements = [overlay, title, team1Label, team1Players, vsText, team2Label, team2Players];
    drawnCardDisplays.push(...teamElements);
});
socket.on("chatMessage", (data) => {
    console.log("chatMessage received: ", data.message, " from position: ", data.position, " and I think my pos is ", position);

    // Add to game log
    let senderName = data.username || getPlayerName(data.position);
    addToGameFeed(`${senderName}: ${data.message}`, data.position);

    let scene = game.scene.scenes[0];
    let screenWidth = scene.scale.width;
    let screenHeight = scene.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    let centerPlayAreaX = screenWidth / 2;
    let centerPlayAreaY = screenHeight / 2;
    let opp1_x = centerPlayAreaX - 480*scaleFactorX;
    let opp1_y = centerPlayAreaY;
    let opp2_x = centerPlayAreaX + 620*scaleFactorX;
    let opp2_y = centerPlayAreaY;
    let team1_x = centerPlayAreaX + 80*scaleFactorX;
    let team1_y = centerPlayAreaY - 380*scaleFactorY;
    let me_x = screenWidth - 310*scaleFactorX;
    let me_y = screenHeight - 270*scaleFactorY;
    if (data.position === position + 1 || data.position === position - 3) {
        console.log("placing chat on opp1");
        let chatBubble = createSpeechBubble(scene, opp1_x, opp1_y, 150, 50, data.message);
        scene.time.delayedCall(6000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    if (data.position === position - 1 || data.position === position + 3) {
        console.log("placing chat on opp2");
        let chatBubble = createSpeechBubble(scene, opp2_x, opp2_y, 150, 50, data.message);
        scene.time.delayedCall(6000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    if (data.position === position + 2 || data.position === position - 2) {
        console.log("placing chat on team1");
        let chatBubble = createSpeechBubble(scene, team1_x, team1_y, 150, 50, data.message);
        scene.time.delayedCall(6000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    if (data.position === position) {
        console.log("placing chat on me");
        let chatBubble = createSpeechBubble(scene, me_x, me_y, 150, 50, data.message);
        scene.time.delayedCall(6000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    
});
socket.on("createUI", (data) => {
    let scene = game.scene.scenes[0];
    console.log("🎨 caught createUI");
    removeWaitingScreen();
    removeDraw();
    removeMainRoom(); // Ensure main room is removed
    removeGameLobby(); // Ensure game lobby is removed
    console.log("🎨 Creating game feed...");
    createGameFeed();
    console.log("🎨 Game feed created, checking DOM:", document.getElementById("gameFeed"));
    // Score is now displayed in the game log, no separate scorebug needed
    if (!scene.handElements) {
        scene.handElements = [];
    }
});
// queueUpdate handler removed - now using lobby system instead

// ==================== MAIN ROOM SOCKET HANDLERS ====================

socket.on("mainRoomJoined", (data) => {
    console.log("Joined main room", data);
    showMainRoom(data);
});

socket.on("mainRoomMessage", (data) => {
    console.log("Main room message", data);
    addMainRoomChatMessage(data.username, data.message);
});

socket.on("lobbiesUpdated", (data) => {
    console.log("Lobbies updated", data);
    updateLobbyList(data.lobbies);
});

socket.on("mainRoomPlayerJoined", (data) => {
    console.log("Player joined main room", data);
    updateMainRoomOnlineCount(data.onlineCount);
});

// ==================== LOBBY SOCKET HANDLERS ====================

socket.on("lobbyCreated", (data) => {
    console.log("Lobby created!", data);
    removeMainRoom();
    showGameLobby(data);
});

socket.on("playerReadyUpdate", (data) => {
    console.log("👤 Player ready update", data);
    updateLobbyPlayersList(null, data.players);
});

socket.on("lobbyMessage", (data) => {
    console.log("💬 Lobby message", data);
    addLobbyChatMessage(data.username, data.message);
});

socket.on("lobbyPlayerLeft", (data) => {
    console.log("👋 Player left lobby", data);
    updateLobbyPlayersList(null, data.players);
    addLobbyChatMessage("System", `${data.leftUsername} left the lobby`);
});

socket.on("lobbyPlayerJoined", (data) => {
    console.log("👋 Player joined lobby", data);
    updateLobbyPlayersList(null, data.players);
    addLobbyChatMessage("System", `${data.newPlayer.username} joined the lobby`);
});

socket.on("leftLobby", () => {
    console.log("👋 You left the lobby");
    removeGameLobby();
    // Server will send mainRoomJoined event to show main room
});

socket.on("allPlayersReady", (data) => {
    console.log("✅ All players ready! Starting game...", data);
    removeGameLobby();
    // The draw phase will be triggered by startDraw event
});

// ==================== END LOBBY SOCKET HANDLERS ====================

function clearDisplayCards() {
    console.log("🗑️ Clearing all elements from displayCards...");

    if (this.handElements) {
        this.handElements.forEach(element => {
            if (element) element.destroy(); // ✅ Destroy each tracked element
        });

        this.handElements = []; // ✅ Reset array
    }
    console.log("✅ All elements cleared from displayCards.");
}
let myCards = [];

/**
 * Get suit order for sorting - alternating colors with trump rightmost
 * @param {string} trumpSuit - The trump suit for this hand
 * @returns {Array} - Ordered array of suits
 */
function getSuitOrder(trumpSuit) {
    // Alternating colors with trump always last (rightmost)
    // If trump is joker (no trump), use default alternating order
    const orders = {
        'spades':   ['hearts', 'clubs', 'diamonds', 'spades'],
        'hearts':   ['spades', 'diamonds', 'clubs', 'hearts'],
        'diamonds': ['clubs', 'hearts', 'spades', 'diamonds'],
        'clubs':    ['diamonds', 'spades', 'hearts', 'clubs'],
        'joker':    ['clubs', 'diamonds', 'hearts', 'spades']  // No trump - just alternate colors
    };
    return orders[trumpSuit] || ['clubs', 'diamonds', 'hearts', 'spades'];
}

/**
 * Sort hand by suit (trump rightmost) and rank (low to high)
 * @param {Array} hand - Array of card objects
 * @param {Object} trumpCard - Trump card with suit property
 * @returns {Array} - Sorted hand
 */
function sortHand(hand, trumpCard) {
    if (!hand || hand.length === 0) return hand;
    if (!trumpCard || !trumpCard.suit) return hand;

    const trumpSuit = trumpCard.suit;
    const suitOrder = getSuitOrder(trumpSuit);
    const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

    return [...hand].sort((a, b) => {
        // Jokers go last (they're trump) - HI joker rightmost
        if (a.suit === 'joker' && b.suit === 'joker') {
            return a.rank === 'LO' ? -1 : 1;
        }
        if (a.suit === 'joker') return 1;
        if (b.suit === 'joker') return -1;

        // Sort by suit order (trump rightmost)
        const suitDiff = suitOrder.indexOf(a.suit) - suitOrder.indexOf(b.suit);
        if (suitDiff !== 0) return suitDiff;

        // Within suit, sort by rank (low to high)
        return rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank);
    });
}

function displayCards(playerHand) {
    console.log("🃏 displayCards called with hand:", playerHand);
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
    bidding = 1;
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

    // Play positions - inside the green play zone with smaller offsets
    let playOffsetX = 80 * scaleFactorX;
    let playOffsetY = 80 * scaleFactorY;
    let opponent1_x = screenWidth / 2 - playOffsetX;
    let opponent1_y = screenHeight / 2;
    let opponent2_x = screenWidth / 2 + playOffsetX;
    let opponent2_y = screenHeight / 2;
    let team1_x = screenWidth / 2;
    let team1_y = screenHeight / 2 - playOffsetY;
    let selfPlay_x = screenWidth / 2;
    let selfPlay_y = screenHeight / 2 + playOffsetY;

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
        console.log(`🎯 updateCardLegality called: bidding=${bidding}, currentTurn=${currentTurn}, position=${position}, playedCard=${playedCard}, myCards.length=${myCards.length}`);
        myCards.forEach(sprite => {
            if (!sprite || !sprite.active) return;
            const card = sprite.getData('card');
            if (!card) return;

            // During bidding or not our turn, dim all cards
            if (bidding === 1 || currentTurn !== position || playedCard) {
                console.log(`🔒 Dimming ${card.rank} of ${card.suit}: bidding=${bidding}, currentTurn=${currentTurn}, position=${position}, playedCard=${playedCard}`);
                sprite.setTint(0xaaaaaa);
                sprite.setData('isLegal', false);
                return;
            }

            // Check if this card is a legal move
            // Pass leadPosition (who led the trick) for HI joker rule, not player's position
            const isLegal = isLegalMove(card, playerCards, leadCard, playedCardIndex === 0, leadPosition);

            if (isLegal) {
                console.log(`✅ Clearing tint for ${card.rank} of ${card.suit}, sprite.tintTopLeft before:`, sprite.tintTopLeft);
                sprite.clearTint();
                console.log(`✅ After clearTint, sprite.tintTopLeft:`, sprite.tintTopLeft);
                sprite.setData('isLegal', true);
            } else {
                sprite.setTint(0x666666);
                sprite.setData('isLegal', false);
            }
        });
    }

    // Store the update function globally so socket handlers can call it
    window.updateCardLegality = updateCardLegality;

    console.log("🃏 Creating", playerHand.length, "card sprites...");
    console.log("🃏 visible() =", visible());

    playerHand.forEach((card, index) => {
        let cardKey = getCardImageKey(card);
        console.log(`🃏 Card ${index}: ${card.rank} of ${card.suit} -> key: ${cardKey}`);

        // Check if frame exists
        if (this.textures && this.textures.exists('cards')) {
            const frame = this.textures.get('cards').get(cardKey);
            console.log(`🃏 Frame '${cardKey}' exists:`, frame && frame.name === cardKey);
        }

        let cardSprite = this.add.image(screenWidth / 2 + 500*scaleFactorX, screenHeight / 2 - 300*scaleFactorY, 'cards', cardKey)
        .setInteractive()
        .setScale(1.5);  // ✅ Increase size

        console.log(`🃏 Card sprite created:`, cardSprite);
        console.log(`🃏 Sprite dimensions: ${cardSprite.width}x${cardSprite.height}`);
        console.log(`🃏 Sprite position: (${cardSprite.x}, ${cardSprite.y})`);
        console.log(`🃏 Sprite visible: ${cardSprite.visible}, alpha: ${cardSprite.alpha}`);

        cardSprite.input.hitArea.setTo(cardSprite.width * 0.15, 0, cardSprite.width * 0.7, cardSprite.height);
        if (!cardSprite) {
            console.error(`🚨 ERROR: Failed to create card sprite for ${card.rank} of ${card.suit}`);
        }
        // Store card data on sprite for legality checks
        cardSprite.setData('card', card);
        cardSprite.setData('isLegal', false);
        cardSprite.setData('baseY', startY); // Store base Y for hover effects
        myCards.push(cardSprite);
        if (visible()){
            this.tweens.add({
                targets: cardSprite,
                x: startX + index * cardSpacing,
                y: startY,
                duration: 750,
                ease: "Power2",
                delay: index * 30,
                onComplete: () =>{
                }
            });
        }else{
            cardSprite.x = startX + index * cardSpacing;
            cardSprite.y = startY;
        }
        // Click-based card play (no dragging)
        cardSprite.on("pointerover", () => {
            // Only raise card if it's a legal move
            if (cardSprite.getData('isLegal')) {
                const baseY = cardSprite.getData('baseY');
                this.tweens.add({
                    targets: cardSprite,
                    y: baseY - 30,
                    duration: 150,
                    ease: 'Power2'
                });
            }
        });

        cardSprite.on("pointerout", () => {
            // Only return card if it was raised (isLegal)
            if (cardSprite.getData('isLegal')) {
                const baseY = cardSprite.getData('baseY');
                this.tweens.add({
                    targets: cardSprite,
                    y: baseY,
                    duration: 150,
                    ease: 'Power2'
                });
            }
        });

        cardSprite.on("pointerdown", () => {
            console.log(`🃏 Card clicked: ${card.rank} of ${card.suit}`);

            // Only allow playing if the card is marked as legal
            if (!cardSprite.getData('isLegal')) {
                console.log("Illegal move - card is disabled!");
                return;
            }

            // Set lead card if first play of trick
            if (playedCardIndex === 0) {
                leadCard = card;
                leadPosition = position;
                leadBool = true;
                console.log("leadBool changed to true.");
            }

            // Play the card
            socket.emit("playCard", { card, position });
            playedCard = true;
            if (card.suit === trump.suit || card.suit === "joker") {
                isTrumpBroken = true;
            }
            leadBool = false;
            cardSprite.destroy(); // Remove after playing
            playerHand = removeCard(playerHand, card);
            playerCards = removeCard(playerCards, card); // Also update global playerCards for legality checks
            console.log("my hand: ", playerHand);
        });
    });

    // Initial update of card legality (cards should be dimmed during bidding)
    updateCardLegality();

    // Only register socket listeners once to prevent duplicates across hands
    if (gameListenersRegistered) {
        console.log("⏭️ Socket listeners already registered, skipping...");
        return;
    }
    gameListenersRegistered = true;
    console.log("📡 Registering game socket listeners...");

    socket.on("bidReceived", (data) => {
        console.log("bid received: ", data.bid);
        const bidStr = String(data.bid).toUpperCase();
        if(bidStr === "B"){
            showImpactEvent("b");
        }
        if(bidStr === "2B"){
            showImpactEvent("2b");
        }
        if(bidStr === "3B"){
            showImpactEvent("3b");
        }
        if(bidStr === "4B"){
            showImpactEvent("4b");
        }
        const playerName = getPlayerName(data.position);
        const feedMessage = playerName + " bid " + data.bid + ".";
        console.log("📝 Adding to game feed:", feedMessage, "position:", data.position);
        addToGameFeed(feedMessage);
        tempBids.push(bidStr);

        // Update bore button states after receiving a bid
        if (window.updateBoreButtons) {
            window.updateBoreButtons();
        }

        let scene = game.scene.scenes[0];
        let screenWidth = scene.scale.width;
        let screenHeight = scene.scale.height;
        let centerPlayAreaX = screenWidth / 2;
        let centerPlayAreaY = screenHeight / 2;
        let opp1_x = centerPlayAreaX - 480*scaleFactorX;
        let opp1_y = centerPlayAreaY - 60*scaleFactorY;
        let opp2_x = centerPlayAreaX + 620*scaleFactorX;
        let opp2_y = centerPlayAreaY - 60*scaleFactorY;
        let team1_x = centerPlayAreaX + 80*scaleFactorX;
        // Reduce offset and ensure minimum Y of 80 to keep bubble visible
        let team1_y = Math.max(80, centerPlayAreaY - 280*scaleFactorY);
        let me_x = screenWidth - 310*scaleFactorX;
        let me_y = screenHeight - 330*scaleFactorY;
        let myBids = ["-","-","-","-"];
        console.log("got bidArray: ", data.bidArray);
        console.log("myBids before: ", myBids);
        for(i = 0; i < data.bidArray.length; i++){
            if(data.bidArray[i] !== undefined && data.bidArray[i] !== null){
                myBids[i] = data.bidArray[i];
                console.log("changed myBids at index ", i, " to ", myBids[i]);
            }
        }
        console.log("myBids: ", myBids);
        if (data.position === position + 1 || data.position === position - 3) {
            console.log("placing chat on opp1");
            let chatBubble = createSpeechBubble(scene, opp1_x, opp1_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(5000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        if (data.position === position - 1 || data.position === position + 3) {
            console.log("placing chat on opp2");
            let chatBubble = createSpeechBubble(scene, opp2_x, opp2_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(5000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        if (data.position === position + 2 || data.position === position - 2) {
            console.log("placing chat on team1");
            let chatBubble = createSpeechBubble(scene, team1_x, team1_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(5000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        if (data.position === position) {
            console.log("placing chat on me");
            let chatBubble = createSpeechBubble(scene, me_x, me_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(5000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        // Update score in game log with bid info
        let teamBids = myBids[position - 1] + "/" + myBids[team(position) - 1];
        let oppBids = myBids[rotate(position) - 1] + "/" + myBids[rotate(rotate(rotate(position))) - 1];
        // Store bids globally for use in trickComplete
        currentTeamBids = teamBids;
        currentOppBids = oppBids;
        if(position % 2 !== 0){
            console.log("updating game log score");
            updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score1, score2, teamBids, oppBids);
        }
        else{
            console.log("updating game log score");
            updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score2, score1, teamBids, oppBids);
        }
    });
    socket.on("updateTurn", (data) => {
        console.log(`📍 updateTurn received: data.currentTurn=${data.currentTurn}, my position=${position}`);
        currentTurn = data.currentTurn;
        playedCard = false;
        console.log("Current turn:", currentTurn);
        removeOpponentGlow(this);
        if(currentTurn === position){
            addTurnGlow(this);
        }
        else{
            removeTurnGlow(this);
        }
        if (currentTurn === rotate(position)){
            addOpponentGlow(this, "opp1");
        }
        else if (currentTurn === team(position)){
            addOpponentGlow(this, "partner");
        }
        else if (currentTurn === rotate(rotate(rotate(position)))){
            addOpponentGlow(this, "opp2");
        }

        // Update card legality when turn changes
        if (window.updateCardLegality) {
            window.updateCardLegality();
        }

        // Show/hide bid container based on whose turn it is during bidding
        let bidContainer = document.getElementById("bidContainer");
        if (bidContainer) {
            if (bidding === 1 && currentTurn === position) {
                bidContainer.style.display = "flex";
            } else {
                bidContainer.style.display = "none";
            }
        }
    })
    socket.on("cardPlayed", (data) => {
        console.log(`position ${data.position} played ${data.card.rank} of ${data.card.suit}`);
        if(playedCardIndex === 0){
            leadCard = data.card;
            leadPosition = data.position;
            console.log("leadCard: ", leadCard);

            // Update card legality when lead card is set
            if (window.updateCardLegality) {
                window.updateCardLegality();
            }
        }
        isTrumpBroken = data.trump;
        console.log("is trump broken? ", isTrumpBroken, "server thinks its ", data.trump);
        console.log("incrementing index after receiving cardPlayed");
        playedCardIndex += 1;
        thisTrick.push(data.card);
        console.log("trick length:",thisTrick.length)
        if(thisTrick.length > 2){
            console.log("trump suit:", trump.suit);
            console.log("played card suit:", thisTrick[thisTrick.length - 1].suit);
            console.log("previous card suit:", thisTrick[thisTrick.length - 2].suit);
            console.log("played card rank:", ranks[thisTrick[thisTrick.length - 1].rank]);
            console.log("previous card rank:", ranks[thisTrick[thisTrick.length - 2].rank]);
            if((thisTrick[thisTrick.length - 1].suit === trump.suit || thisTrick[thisTrick.length - 1].suit === "joker") && (thisTrick[thisTrick.length - 2].suit === trump.suit || thisTrick[thisTrick.length - 2].suit === "joker" ) && (ranks[thisTrick[thisTrick.length - 1].rank] > ranks[thisTrick[thisTrick.length - 2].rank]) && leadCard.suit !== trump.suit && leadCard.suit !== "joker"){
                console.log("showing ot");
                showImpactEvent("ot");
            }
        }
        console.log("playedCardIndex: ", playedCardIndex);
        if (playedCardIndex === 4){
            playedCardIndex = 0;
        }
        let cardKey = getCardImageKey(data.card);
        console.log(`Using image key: ${cardKey}`);
        if(data.position === position + 1 || data.position === position - 3){
            if (opponentCardSprites["opp1"] && opponentCardSprites["opp1"].length > 0) {
                let removedCard = opponentCardSprites["opp1"].pop();
                currentTrick.push(removedCard); // Add the removed card to the current trick
                if(visible()){
                    this.tweens.add({
                        targets: removedCard,
                        x: opponent1_x,
                        y: opponent1_y,
                        duration: 500,
                        ease: "Power2",
                        rotation: 0,
                        scale: 1.5,
                        onComplete: () => {
                            removedCard.setTexture('cards', cardKey);
                            removedCard.setDepth(200);
                            console.log("card texture changed to: ", cardKey);
                        } 
                    });
                }else{
                    removedCard.x = opponent1_x;
                    removedCard.y = opponent1_y;
                    removedCard.setTexture('cards', cardKey);
                    removedCard.setDepth(200);
                    removedCard.setScale(1.5);
                    removedCard.setRotation(0);
                    console.log("card texture changed to: ", cardKey);
                }
                console.log("✅ Removed a card from Opponent 1");
            } else {
                console.warn("⚠️ No cards left to remove from Opponent 1!");
            }
        }
        else if(data.position === position + 2 || data.position === position - 2){
            if (opponentCardSprites["partner"] && opponentCardSprites["partner"].length > 0) {
                let removedCard = opponentCardSprites["partner"].pop();
                currentTrick.push(removedCard); // Add the removed card to the current trick
                if(visible()){
                    this.tweens.add({
                        targets: removedCard,
                        x: team1_x,
                        y: team1_y,
                        duration: 500,
                        ease: "Power2",
                        rotation: 0,
                        scale: 1.5,
                        onComplete: () => {
                            removedCard.setTexture('cards', cardKey);
                            removedCard.setDepth(200);
                            console.log("card texture changed to: ", cardKey);
                        } 
                    });
                }else{
                    removedCard.x = team1_x;
                    removedCard.y = team1_y;
                    removedCard.setTexture('cards', cardKey);
                    removedCard.setDepth(200);
                    removedCard.setScale(1.5);
                    removedCard.setRotation(0);
                    console.log("card texture changed to: ", cardKey);
                }
                console.log("✅ Removed a card from Partner");
            } else {
                console.warn("⚠️ No cards left to remove from Partner!");
            }
        }
        else if (data.position === position + 3 || data.position === position - 1){
            if (opponentCardSprites["opp2"] && opponentCardSprites["opp2"].length > 0) {
                let removedCard = opponentCardSprites["opp2"].pop();
                currentTrick.push(removedCard); // Add the removed card to the current trick
                if(visible()){  
                    this.tweens.add({
                        targets: removedCard,
                        x: opponent2_x,
                        y: opponent2_y,
                        duration: 500,
                        ease: "Power2",
                        rotation: 0,
                        scale: 1.5,
                        onComplete: () => {
                            removedCard.setTexture('cards', cardKey);
                            removedCard.setDepth(200);
                            console.log("card texture changed to: ", cardKey);
                        } 
                    });
                }else{
                    removedCard.x = opponent2_x;
                    removedCard.y = opponent2_y;
                    removedCard.setTexture('cards', cardKey);
                    removedCard.setDepth(200);
                    removedCard.setScale(1.5);
                    removedCard.setRotation(0);
                    console.log("card texture changed to: ", cardKey);
                }
                console.log("✅ Removed a card from Opponent 2");
            } else {
                console.warn("⚠️ No cards left to remove from Opponent 2!");
            }
        }
        else if (data.position === position){
            currentTrick.push(this.add.image(selfPlay_x, selfPlay_y, 'cards', cardKey).setScale(1.5).setDepth(200));
        }
    })
    socket.on("trickComplete", (data) => {
        console.log("🏆 Trick complete. Moving and stacking to the right...");
        addToGameFeed("Trick won by " + getPlayerName(data.winner) + ".");

        // Reset lead card and position for next trick
        leadCard = null;
        leadPosition = null;
        playedCardIndex = 0;
        let screenWidth = this.scale.width;
        let screenHeight = this.scale.height;
        let trickSpacing = 40*scaleFactorX; // ✅ Horizontal spacing between tricks
    
    
        let winningPosition;
        if (data.winner % 2 !== position % 2) {
            oppTricks += 1;
            // ✅ Stack tricks in the top-left, moving **right** as more tricks are played
            winningPosition = { x: 20 + oppTricks * trickSpacing, y: 100 };
        } else {
            teamTricks += 1;
            // ✅ Stack tricks in the bottom-left, moving **right** as more tricks are played
            winningPosition = { x: 20 + teamTricks * trickSpacing, y: screenHeight - 100 };
        }

        // Update game log with trick counts
        if(position % 2 !== 0){
            updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score1, score2, currentTeamBids, currentOppBids, teamTricks, oppTricks);
        } else {
            updateGameLogScore(me + "/" + partner, opp1 + "/" + opp2, score2, score1, currentTeamBids, currentOppBids, teamTricks, oppTricks);
        }

        let trickCards = [...currentTrick]; // ✅ Store the completed trick
        currentTrick = [];
        thisTrick = []; // ✅ Clear the reference to avoid moving previous tricks
    
        // ✅ Stack the new trick at the correct position
        let stackIndex = 0;
        trickCards.forEach((card) => {
            if(data.winner % 2 !== position % 2){
                card.setTexture("cardBack");
            }
            if(visible()){
                this.tweens.add({
                    targets: card,
                    x: winningPosition.x,
                    y: winningPosition.y,
                    scale: 0.75, // ✅ Shrink while moving
                    duration: 500,
                    ease: "Power2",
                    onComplete: () => {
                        card.setDepth(200 + stackIndex);
                        console.log(`✅ Trick moved and stacked.`);
                    }
                });
            }else{
                card.x = winningPosition.x;
                card.y = winningPosition.y;
                card.setDepth(200 + stackIndex);
                card.setScale(0.75);
                console.log(`✅ Trick moved and stacked.`);
            }
            stackIndex += 1; // ✅ Increment stack index for depth
            card.setInteractive();
            card.originalDepth = card.depth;
        });
        stackIndex = 0;
        // ✅ Store this trick separately in history
        if(data.winner % 2 !== position % 2){
            oppTrickHistory.push(trickCards);
        }
        else{
            teamTrickHistory.push(trickCards);
        }
    
        // ✅ Function to fan out THIS trick only
        function fanOutTrick(trick) {
            trick.forEach((card, index) => {
                card.setDepth(250 + index);
                if(visible()){   
                    this.tweens.add({
                        targets: card,
                        x: winningPosition.x + index * 20*scaleFactorX, // ✅ Fan out horizontally
                        y: winningPosition.y - index * 5*scaleFactorY, // ✅ Slight vertical offset
                        duration: 200,
                        ease: "Power1"
                    });
                }else{
                    card.x = winningPosition.x + index * 20*scaleFactorX;
                    card.y = winningPosition.y - index * 5*scaleFactorY;
                }
            });
        }
    
        // ✅ Function to reset THIS trick only
        function resetTrick(trick) {
            trick.forEach((card) => {
                card.setDepth(card.originalDepth);
                if(visible()){
                    this.tweens.add({
                        targets: card,
                        x: winningPosition.x,
                        y: winningPosition.y,
                        duration: 200,
                        ease: "Power1"
                    });
                }else{
                    card.x = winningPosition.x;
                    card.y = winningPosition.y;
                }
            });
        }
        // ✅ Add hover events to THIS trick only
        console.log("data.winner: ", data.winner, "position:", position);
        if(data.winner % 2 === position % 2){
            console.log("applying fanout")
            trickCards.forEach((card) => {
                card.on("pointerover", () => fanOutTrick.call(this, trickCards));
                card.on("pointerout", () => resetTrick.call(this, trickCards));
            });
        }
    });
    socket.on("doneBidding", (data) => {
        console.log(`📣 doneBidding received: data=${JSON.stringify(data)}, bidding was=${bidding}`);
        let bidContainer = document.getElementById("bidContainer");
        if (bidContainer) {
            bidContainer.remove();
            console.log("✅ Bid container removed.");
        }
        // Clear the updateBoreButtons reference
        window.updateBoreButtons = null;
        tempBids = [];
        bidding = 0;
        console.log(`📣 doneBidding: set bidding to 0, currentTurn=${currentTurn}, position=${position}`);

        // Update card legality now that bidding is over
        console.log(`📣 doneBidding: window.updateCardLegality exists=${!!window.updateCardLegality}`);
        if (window.updateCardLegality) {
            window.updateCardLegality();
        }
        playerBids = data;
        console.log("bids: ", playerBids);
        rainbows.forEach((rainbow) => {
            if(rainbow === position){
                console.log("adding rainbow to me");
                addToGameFeed(getPlayerName(position) + " has a rainbow!");
                let myRainbow = this.add.image(screenWidth / 2 + 580*scaleFactorX, screenHeight / 2 + 125*scaleFactorY, "rainbow").setScale(1).setDepth(1000).setAlpha(1);
                this.tweens.add({
                    targets: myRainbow,
                    scale: { from: 0, to: 1},
                    ease: 'Back.Out',
                    duration: 500
                });
                this.time.delayedCall(5000, () => {
                    this.tweens.add({
                        targets: myRainbow,
                        alpha: { from: 1, to: 0},
                        duration: 1000,
                        ease: 'Power1',
                        onComplete: () => {
                            myRainbow.destroy();
                        }
                    });
                });
            }
            if(rainbow === rotate(position)){
                console.log("adding rainbow to opp1");
                addToGameFeed(getPlayerName(rotate(position)) + " has a rainbow!");
                let opp1Rainbow = this.add.image(screenWidth / 2 - 645*scaleFactorX, screenHeight / 2, "rainbow").setScale(1).setDepth(1000).setAlpha(1);
                this.tweens.add({
                    targets: opp1Rainbow,
                    scale: { from: 0, to: 1},
                    ease: 'Back.Out',
                    duration: 500
                });
                this.time.delayedCall(5000, () => {
                    this.tweens.add({
                        targets: opp1Rainbow,
                        alpha: { from: 1, to: 0},
                        duration: 1000,
                        ease: 'Power1',
                        onComplete: () => {
                            opp1Rainbow.destroy();
                        }
                    });
                });
            }
            if(rainbow === team(position)){
                console.log("adding rainbow to partner");
                addToGameFeed(getPlayerName(team(position)) + " has a rainbow!");
                let teamRainbow = this.add.image(screenWidth / 2 + 135*scaleFactorX, screenHeight / 2 - 400*scaleFactorY, "rainbow").setScale(1).setDepth(1000).setAlpha(1);
                this.tweens.add({
                    targets: teamRainbow,
                    scale: { from: 0, to: 1},
                    ease: 'Back.Out',
                    duration: 500
                });
                this.time.delayedCall(5000, () => {
                    this.tweens.add({
                        targets: teamRainbow,
                        alpha: { from: 1, to: 0},
                        duration: 1000,
                        ease: 'Power1',
                        onComplete: () => {
                            teamRainbow.destroy();
                        }
                    });
                });
            }
            if(rainbow === rotate(rotate(rotate(position)))){
                console.log("adding rainbow to opp2");
                addToGameFeed(getPlayerName(rotate(rotate(rotate(position)))) + " has a rainbow!");
                let opp2Rainbow = this.add.image(screenWidth / 2 + 630*scaleFactorX, screenHeight / 2, "rainbow").setScale(1).setDepth(1000).setAlpha(1);
                this.tweens.add({
                    targets: opp2Rainbow,
                    scale: { from: 0, to: 1},
                    ease: 'Back.Out',
                    duration: 500
                });
                this.time.delayedCall(5000, () => {
                    this.tweens.add({
                        targets: opp2Rainbow,
                        alpha: { from: 1, to: 0},
                        duration: 1000,
                        ease: 'Power1',
                        onComplete: () => {
                            opp2Rainbow.destroy();
                        }
                    });
                });
            }
        });
        rainbows = [];
    });
    socket.on("handComplete", (data) => {
        if(data.team1Tricks + data.team2Tricks !== 13){
            // Swap team1/team2 data based on player's team (positions 1,3 = Team 1, positions 2,4 = Team 2)
            if (position % 2 !== 0) {
                // Player is on Team 1
                showScore(data.score.team1, data.score.team2, playerBids.bids, data.team1Tricks, data.team2Tricks, data.team1OldScore, data.team2OldScore);
            } else {
                // Player is on Team 2 - swap all team1/team2 values
                showScore(data.score.team2, data.score.team1, playerBids.bids, data.team2Tricks, data.team1Tricks, data.team2OldScore, data.team1OldScore);
            }
        }
        console.log("🏁 Hand complete. Clearing all tricks...");
        addToGameFeed("Hand complete. Clearing all tricks...");
        teamTricks = 0;
        oppTricks = 0;
        isTrumpBroken = false;
        // NOTE: Do NOT remove socket listeners here - they need to persist across hands
        // The gameStart event for the next hand will reinitialize state
        clearAllTricks();
        clearDisplayCards();
    });
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

function displayOpponentHands(numCards,dealer) {
    console.log("🎭 displayOpponentHands called!");
    console.log("🎭 this (scene):", this);
    console.log("🎭 numCards:", numCards, "dealer:", dealer);
    console.log("🎭 playerData:", playerData);
    console.log("🎭 position:", position);

    if (buttonHandle && typeof buttonHandle.destroy === 'function') {
        buttonHandle.destroy();
      }
    oppUI.forEach((element) => element.destroy());
    oppUI = [];
    console.log("🎭 Displaying opponent hands...");
    console.log("dealer: ", dealer);
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let scaleFactorX = this.scale.width / 1920;
    let scaleFactorY = this.scale.height / 953;
    let cardSpacing = 10*scaleFactorX; // Spacing between cards
    let centerPlayAreaX = screenWidth / 2;
    let centerPlayAreaY = screenHeight / 2;
    let opponentPositions = {
        "partner": { x: centerPlayAreaX, y: centerPlayAreaY - 275*scaleFactorY, rotation: 0, horizontal: true, avatarX: centerPlayAreaX, avatarY: centerPlayAreaY - 400*scaleFactorY },  // ✅ Top (horizontal)
        "opp1": { x: centerPlayAreaX - 425*scaleFactorX, y: centerPlayAreaY, rotation: Math.PI / 2, horizontal: false, avatarX: centerPlayAreaX - 550*scaleFactorX, avatarY: centerPlayAreaY},  // ✅ Left (closer)
        "opp2": { x: centerPlayAreaX + 425*scaleFactorX, y: centerPlayAreaY, rotation: -Math.PI / 2, horizontal: false, avatarX: centerPlayAreaX + 550*scaleFactorX, avatarY: centerPlayAreaY} // ✅ Right (closer)
    };
    Object.keys(opponentCardSprites).forEach((opponentId) => {
        opponentCardSprites[opponentId].forEach(card => card.destroy());
    });
    opponentCardSprites = {}; // ✅ Reset storage
    Object.keys(opponentPositions).forEach((opponentId) => {
        let { x, y, rotation, horizontal, avatarX, avatarY } = opponentPositions[opponentId];

        // Create DOM-based avatars with CSS glow support
        if(opponentId === "partner"){
            const pic = playerData.pics[playerData.position.indexOf(team(position))];
            const username = playerData.username[playerData.position.indexOf(team(position))].username;
            const avatarDom = createOpponentAvatarDom("partner", pic, username);
            avatarDom.style.left = `${avatarX}px`;
            avatarDom.style.top = `${avatarY}px`;

            if(team(position) === dealer){
                buttonHandle = this.add.image(avatarX + 75*scaleFactorX, avatarY, "dealer")
                .setScale(0.03)
                .setDepth(250)
                .setAlpha(1);
                playerInfo.playerPositionText.setText("MP");
            }
        }
        if(opponentId === "opp1"){
            const pic = playerData.pics[playerData.position.indexOf(rotate(position))];
            const username = playerData.username[playerData.position.indexOf(rotate(position))].username;
            const avatarDom = createOpponentAvatarDom("opp1", pic, username);
            avatarDom.style.left = `${avatarX}px`;
            avatarDom.style.top = `${avatarY}px`;

            if(rotate(position) === dealer){
                buttonHandle = this.add.image(avatarX - 75*scaleFactorX, avatarY, "dealer")
                .setScale(0.03)
                .setDepth(250)
                .setAlpha(1);
                playerInfo.playerPositionText.setText("CO");
            }
        }
        if(opponentId === "opp2"){
            const pic = playerData.pics[playerData.position.indexOf(rotate(rotate(rotate(position))))];
            const username = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;
            const avatarDom = createOpponentAvatarDom("opp2", pic, username);
            avatarDom.style.left = `${avatarX}px`;
            avatarDom.style.top = `${avatarY}px`;

            if(rotate(rotate(rotate(position))) === dealer){
                buttonHandle = this.add.image(avatarX + 75*scaleFactorX, avatarY, "dealer")
                .setScale(0.03)
                .setDepth(250)
                .setAlpha(1);
                playerInfo.playerPositionText.setText("UTG");
            }
        }
        if(dealer === position){
            if (buttonHandle && typeof buttonHandle.destroy === 'function') {
                buttonHandle.destroy();
            }
            playerInfo.playerPositionText.setText("BTN");
            buttonHandle = this.add.image(centerPlayAreaX + 580*scaleFactorX, centerPlayAreaY + 365*scaleFactorY, "dealer")
            .setScale(0.03) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
        }
        opponentCardSprites[opponentId] = [];
        for (let i = 0; i < numCards; i++) {
            let offsetX = horizontal ? (i - numCards / 2) * cardSpacing : 0; // ✅ Left/Right: No horizontal movement
            let offsetY = horizontal ? 0 : (i - numCards / 2) * cardSpacing; // ✅ Top: No vertical movement

            let cardBack = this.add.image(screenWidth / 2 + 500*scaleFactorX, screenHeight / 2 - 300*scaleFactorY, "cardBack")
                .setScale(1.5)
            // Ensure opponent cards are visually below player cards
            cardBack.setDepth(200);
            opponentCardSprites[opponentId].push(cardBack);
            if(visible()){
                this.tweens.add({
                    targets: cardBack,
                    x: x + offsetX,
                    y: y + offsetY,
                    duration: 750,
                    ease: "Power2",
                    scaleX: 1.2,
                    scaleY: 1.2,
                    rotation: rotation,
                    delay: i*30,
                    onComplete: () => {
                    //cardBack.setRotation(rotation);
                    }
                });
            }else{
                cardBack.x = x + offsetX;
                cardBack.y = y + offsetY;
                cardBack.rotation = rotation;
                cardBack.setScale(1.2);
            }
        }
    });

    console.log("🎭 Opponent hands displayed correctly.");
}

function update() {}