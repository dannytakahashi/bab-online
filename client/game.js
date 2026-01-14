

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

    // Create game UI elements
    createGameFeed();
    initGameChat();
    if (!scoreUI) {
        scoreUI = createScorebug();
    }

    // Calculate player names (same as gameStart handler)
    me = playerData.username[playerData.position.indexOf(position)]?.username || 'You';
    partner = playerData.username[playerData.position.indexOf(team(position))]?.username || 'Partner';
    opp1 = playerData.username[playerData.position.indexOf(rotate(position))]?.username || 'Opp1';
    opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))]?.username || 'Opp2';

    // Update score display with team names
    if (position % 2 !== 0) {
        scoreUI.teamScoreLabel.setText(me + "/" + partner + ": -/-       " + score1);
        scoreUI.oppScoreLabel.setText(opp1 + "/" + opp2 + ": -/-       " + score2);
    } else {
        scoreUI.teamScoreLabel.setText(me + "/" + partner + ": -/-       " + score2);
        scoreUI.oppScoreLabel.setText(opp1 + "/" + opp2 + ": -/-       " + score1);
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
    // Auto-join a new lobby
    socket.emit("joinQueue");
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
        playZone = null;
        handBackground = null;
    }
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
let playedCard = false;
let playerInfo = null;
let waitBool = false;
let queueDelay = false;
let lastQueueData; 
function create() {
    gameScene = this; // Store reference to the game scene
    console.log("running create4...");
    console.log("Socket in game.js:", socket);

    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    //this.cameras.main.setBackgroundColor("transparent");
    const bg = this.add.image(0, 0, 'background')
    .setOrigin(0, 0)
    .setDisplaySize(this.scale.width, this.scale.height)  // Stretch to fill screen
    .setScrollFactor(0)
    .setDepth(-100)  // Make it non-scrollable (fixed to camera)
    this.time.delayedCall(10, () => {
        bg.setDisplaySize(this.scale.width, this.scale.height);
    });
    this.scale.on('resize', (gameSize) => {
        bg.setDisplaySize(gameSize.width, gameSize.height);
    });

    // Check if there's pending rejoin data from before scene was ready
    if (pendingRejoinData) {
        processRejoin(pendingRejoinData);
        pendingRejoinData = null;
        return; // Skip normal create flow since we're rejoining
    }
    socket.on("positionUpdate", (data) => {
        console.log("Position update received:", data);
        playerData = {
            position: data.positions,
            socket: data.sockets,
            username: data.usernames,
            pics: data.pics
        };
        console.log("✅ playerData initialized:", playerData);
    });
    socket.on("gameStart", (data) => {
        console.log("Game started! Data received:", data);
        // Debug: Check if playerId is set correctly
        console.log("playerId:", playerId);
        // Debug: Check if player has received cards
        console.log("Hands data:", data.hand);
        console.log("scores:", data.score1, data.score2);
        console.log("Player's hand:", data.hand);
        playerCards = data.hand;
        dealer = data.dealer; 
        if (playerCards) {
            console.log("running display cards...");
            score1 = data.score1;
            score2 = data.score2;
            me = playerData.username[playerData.position.indexOf(position)].username;
            partner = playerData.username[playerData.position.indexOf(team(position))].username;
            opp1 = playerData.username[playerData.position.indexOf(rotate(position))].username;
            opp2 = playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username;
            if(position % 2 !== 0){
                scoreUI.teamScoreLabel.setText(me + "/" + partner  + ": -/-       " +  score1);
                scoreUI.oppScoreLabel.setText(opp1 + "/" + opp2  + ": -/-       " + score2);
            }
            else{
                scoreUI.teamScoreLabel.setText(me + "/" + partner + ": -/-       " + score2);
                scoreUI.oppScoreLabel.setText(opp1 + "/" + opp2 + ": -/-       " + score1);
            }
            if(!playerInfo){
                playerInfo = createPlayerInfoBox(); // Store the reference
            }
            // Set trump BEFORE displayCards so sorting works correctly
            if (data.trump) {
                trump = data.trump;
            }
            displayCards.call(this, playerCards);
            //createVignette.call(this);
        } else {
            console.error("🚨 ERROR: playerCards is undefined! GameState may not be initializing correctly.");
        }
        displayOpponentHands.call(this, playerCards.length, dealer);
        if (data.trump) {
            displayTableCard.call(this, data.trump);
        }
    });
}

const config = {
    type: Phaser.AUTO,
    width: innerWidth,
    height: innerHeight,
    //backgroundColor: "transparent",
    parent: "game-container",
    scale: {
        mode: Phaser.Scale.FIT, // ✅ Ensures full coverage
        autoCenter: Phaser.Scale.CENTER_BOTH
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
    console.log("📝 Creating game feed...");

    // ✅ Create a container for the game feed
    let feedContainer = document.createElement("div");
    feedContainer.id = "gameFeed";
    feedContainer.classList.add("ui-element");
    feedContainer.style.position = "absolute";
    feedContainer.style.width = "10vw";
    feedContainer.style.height = "20vh";
    feedContainer.style.bottom = "20px"; // ✅ Position in lower right
    feedContainer.style.right = "20px";
    feedContainer.style.padding = "10px";
    feedContainer.style.background = "rgba(0, 0, 0, 0.7)"; // ✅ Semi-transparent dark background
    feedContainer.style.color = "white";
    feedContainer.style.fontSize = "16px";
    feedContainer.style.fontFamily = "Arial, sans-serif";
    feedContainer.style.overflowY = "auto";
    feedContainer.style.borderRadius = "10px";
    feedContainer.style.border = "2px solid #FFFFFF";
    feedContainer.style.maxHeight = "20vh"; // ✅ Limits scrolling area
    feedContainer.style.textAlign = "left";
    feedContainer.style.wordWrap = "break-word";
    feedContainer.style.overflowWrap = "break-word";
    feedContainer.style.zIndex = "1000"; // Ensure it's above the Phaser canvas

    document.body.appendChild(feedContainer);

    // Add initial message to confirm feed is working
    addToGameFeed("Game started!");
}
function addToGameFeed(message, playerPosition = null) {
    console.log("📋 addToGameFeed called with:", message);
    let feedContainer = document.getElementById("gameFeed");

    if (!feedContainer) {
        console.warn("⚠️ Game feed container not found!");
        return;
    }
    console.log("📋 Feed container found, adding message");

    // Get current time for timestamp
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Create a new message element
    let messageElement = document.createElement("div");
    messageElement.style.marginBottom = "5px";
    messageElement.style.wordWrap = "break-word";
    messageElement.style.overflowWrap = "break-word";
    messageElement.style.maxWidth = "100%";

    // Add timestamp
    let timeSpan = document.createElement("span");
    timeSpan.innerText = `[${timestamp}] `;
    timeSpan.style.color = "#888";
    timeSpan.style.fontSize = "12px";
    messageElement.appendChild(timeSpan);

    // Add message with player color if position provided
    let msgSpan = document.createElement("span");
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
    feedContainer.appendChild(messageElement);

    // Scroll to the latest message
    feedContainer.scrollTop = feedContainer.scrollHeight;

    console.log("📝 Game Feed Updated:", message);
}
let handGlow;
function addOpponentGlow(scene, relation){
    let glowRadius = 47; // ✅ Adjust the radius as needed
    if (!scene) {
        console.error("🚨 ERROR: Scene is undefined in addOpponentGlow!");
        return;
    }
    if (scene.opponentGlow) {
        scene.opponentGlow.destroy(); // ✅ Remove from the game
        scene.opponentGlow = null; // ✅ Clear reference
    }
    let screenWidth = scene.scale.width;
    let screenHeight = scene.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    let centerPlayAreaX = screenWidth / 2;
    let centerPlayAreaY = screenHeight / 2;
    if (relation === "opp1"){
        glowX = centerPlayAreaX - 550*scaleFactorX;
        glowY = centerPlayAreaY;
    }
    else if (relation === "partner"){
        glowX = centerPlayAreaX;
        glowY = centerPlayAreaY - 400*scaleFactorY;
    }
    else if (relation === "opp2"){
        glowX = centerPlayAreaX + 550*scaleFactorX;
        glowY = centerPlayAreaY;
    }
    scene.opponentGlow = scene.add.circle(glowX, glowY, glowRadius, 0xFFD700)
        .setAlpha(0.3)
        .setDepth(-3);
    console.log("🟫 Added solid background & pulsing glow for opponent hand.");
    scene.tweens.add({
        targets: scene.opponentGlow,
        alpha: { from: 0.1, to: 0.5 },
        duration: 1000,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut"
    });
}
function removeOpponentGlow(scene){
    if (!scene) {
        console.error("🚨 ERROR: Scene is undefined in removeTurnGlow!");
        return;
    }

    if (scene.opponentGlow) {
        console.log("🚫 Removing turn glow...");
        scene.opponentGlow.destroy(); // ✅ Remove from the game
        scene.opponentGlow = null; // ✅ Clear reference
    }
}
function addTurnGlow(scene) {
    if (!scene) {
        console.error("🚨 ERROR: Scene is undefined in addTurnGlow!");
        return;
    }
    if (scene.handGlow) {
        scene.handGlow.destroy(); // ✅ Remove from the game
        scene.handGlow = null; // ✅ Clear reference
    }
    let screenWidth = scene.scale.width;
    let screenHeight = scene.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    let handAreaHeight = 257*scaleFactorY;
    let handAreaWidth = screenWidth * 0.51;
    let bottomClearance = 30*scaleFactorY; // Add clearance so table doesn't touch bottom

    let handX = screenWidth / 2;
    let handY = screenHeight - handAreaHeight / 2 - bottomClearance;

    // ✅ Create a pulsing glow effect behind the hand
    scene.handGlow = scene.add.rectangle(handX, handY, handAreaWidth, handAreaHeight, 0xFFD700)
        .setAlpha(0.3)
        .setDepth(-3);

    console.log("🟫 Added solid background & pulsing glow for player hand.");

    // ✅ Animate the pulsing glow effect
    scene.tweens.add({
        targets: scene.handGlow,
        alpha: { from: 0.1, to: 0.5 },
        duration: 1000,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut"
    });
}
function removeTurnGlow(scene) {
    if (!scene) {
        console.error("🚨 ERROR: Scene is undefined in removeTurnGlow!");
        return;
    }

    if (scene.handGlow) {
        console.log("🚫 Removing turn glow...");
        scene.handGlow.destroy(); // ✅ Remove from the game
        scene.handGlow = null; // ✅ Clear reference
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
});
// Track drawn cards display during draw phase
let drawnCardDisplays = [];
let hasDrawn = false;

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

    const bg = this.add.image(0, 0, 'background')
        .setOrigin(0, 0)
        .setDisplaySize(this.scale.width, this.scale.height)
        .setScrollFactor(0)
        .setDepth(-100);

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

            console.log(`📦 Clicked card ${i + 1} to draw`);
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

        // Create card sprite at deck location, then animate to display position
        let textureKey = getCardImageKey(data.card);
        let drawnCard = scene.add.image(screenWidth / 2, startY, 'cards', textureKey)
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

        // Animate card to display position
        scene.tweens.add({
            targets: drawnCard,
            x: slotX,
            y: drawDisplayY,
            scale: 1.5,
            duration: 500,
            ease: "Power2"
        });

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
    console.log(`🎴 Displaying table card: ${card.rank} of ${card.suit}`);
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    let tableX = screenWidth / 2 + 500*scaleFactorX;
    let tableY = screenHeight / 2 - 300*scaleFactorY;
    let cardKey = getCardImageKey(card);
    if (this.tableCardBackground) this.tableCardBackground.destroy();
    if (this.tableCardSprite) this.tableCardSprite.destroy();
    if (this.tableCardLabel) this.tableCardLabel.destroy();
    this.tableCardBackground = this.add.rectangle(tableX, tableY, 120*scaleFactorX, 160*scaleFactorY, 0x8B4513)
        .setStrokeStyle(4, 0x654321)
        .setDepth(-1); // ✅ Ensure it's behind the card
    tableCardSprite = this.add.image(tableX, tableY, 'cards', cardKey).setScale(1.5);
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
    let proto = {rank: 1, suit : ledsuit}
    for(let card of hand){
        if(sameSuit(card,proto)){
            return false;
        }
    }
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
    if (lead.rank === "HI" && !highestTrump(card.rank, hand, trump) && (leadPosition % 2 !== position % 2)){
        console.log("ILLEGAL: HI lead requires highest trump");
        return false;
    }
    console.log("LEGAL: following rules satisfied");
    return true;
}
let waitingText;
let playZone;
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
let handBackground;
let border;
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
    playZone = null;
    playerInfo = null;
    handBackground = null;
    console.log("caught abortGame");
    clearUI();
    gameScene.children.removeAll(true);
    gameScene.scene.restart();
    // Auto-join a new lobby
    socket.emit("joinQueue");
});
socket.on("forceLogout", (data) => {
    console.log("someone else signed in as you. Logging out.");
    if(gameScene){
        gameScene.scene.restart();
        socket.off("gameStart");
        playZone = null;
        handBackground = null;
    }
    removeWaitingScreen();
    clearUI();
    showSignInScreen();
});
socket.on("roomFull", (data) => {
    console.log("caught roomFull");
    removeWaitingScreen();
    // Auto-join a new lobby (this shouldn't happen with lobby system)
    socket.emit("joinQueue");
});
socket.on("gameEnd", (data) => {
    console.log("caught gameEnd");
    showFinalScore(data.score.team1,data.score.team2);
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
    console.log("caught createUI");
    removeWaitingScreen();
    removeDraw();
    createGameFeed();
    initGameChat();
    scoreUI = createScorebug(this);
    if (!scene.handElements) {
        scene.handElements = [];
    }
});
// queueUpdate handler removed - now using lobby system instead

// ==================== LOBBY SOCKET HANDLERS ====================

socket.on("lobbyCreated", (data) => {
    console.log("🎮 Lobby created!", data);
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
    // Auto-join a new lobby
    socket.emit("joinQueue");
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
    let bottomClearance = 30*scaleFactorY; // Match table clearance
    let startY = this.scale.height - 200*scaleFactorY - bottomClearance; // ✅ Adjust vertical position
    let opponent1_x = screenWidth / 2 - 200*scaleFactorX;
    let opponent1_y = screenHeight / 2;
    let opponent2_x = screenWidth / 2 + 200*scaleFactorX;
    let opponent2_y = screenHeight / 2;
    let team1_x = screenWidth / 2;
    let team1_y = screenHeight / 2 - 150*scaleFactorY;
    let handAreaWidth = screenWidth * 0.5; // ✅ Width of the background area
    let handAreaHeight = 250*scaleFactorY; // ✅ Height of the background area
    let handY = screenHeight - handAreaHeight / 2 - bottomClearance; // reuses bottomClearance from above
    if (!playZone) {
        let playZoneWidth = 600*scaleFactorX;
        let playZoneHeight = 400*scaleFactorY;
        let playZoneX = (screenWidth - playZoneWidth) / 2;
        let playZoneY = (this.scale.height - playZoneHeight) / 2;
        playZone = this.add.rectangle(playZoneX + playZoneWidth / 2, playZoneY + playZoneHeight / 2,
                                      playZoneWidth, playZoneHeight, 0x32CD32)
                        .setStrokeStyle(4, 0xffffff)
                        .setAlpha(0.6);
        console.log("📍 Play zone created at:", playZoneX, playZoneY);
    }
    if (!handBackground){
            handBackground = this.add.rectangle(screenWidth / 2, handY,
            screenWidth * 0.5, handAreaHeight, 0x1a3328)  // Dark green felt
            .setAlpha(0.85)
            .setDepth(-2);
            border = this.add.rectangle(screenWidth / 2, handY,
            screenWidth * 0.5, handAreaHeight)
            .setStrokeStyle(2, 0x2d5a40) // Subtle green border
            .setDepth(-1);
    }
    console.log("🟫 Added background for player hand.");
    // ✅ Create button-grid bidding UI
    let bidContainer = document.createElement("div");
    bidContainer.id = "bidContainer";
    bidContainer.classList.add("ui-element", "bid-grid");
    bidContainer.style.position = "absolute";
    bidContainer.style.display = "flex";
    bidContainer.style.flexDirection = "column";
    bidContainer.style.gap = "8px";
    bidContainer.style.padding = "12px";
    bidContainer.style.background = "rgba(0, 0, 0, 0.85)";
    bidContainer.style.border = "2px solid #444";
    bidContainer.style.borderRadius = "8px";
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

    // Row 1: Numeric bids (0 to hand size)
    let numericRow = document.createElement("div");
    numericRow.style.display = "flex";
    numericRow.style.gap = "4px";
    numericRow.style.flexWrap = "wrap";
    numericRow.style.justifyContent = "center";

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

    // Position the bid container relative to the game canvas
    function updateBidContainerPosition() {
        let canvasRect = document.querySelector("canvas").getBoundingClientRect();
        bidContainer.style.left = `${canvasRect.left + handAreaWidth - 720*scaleFactorX}px`;
        bidContainer.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 - 60*scaleFactorY}px`;
    }

    updateBidContainerPosition();
    window.addEventListener("resize", updateBidContainerPosition);
    console.log(`🖥️ Screen Width: ${screenWidth}, Starting X: ${startX}`);
    console.log("player hand:", playerHand);
    let cardDepth = 200;

    // Function to update card interactivity based on legal moves
    function updateCardLegality() {
        myCards.forEach(sprite => {
            if (!sprite || !sprite.active) return;
            const card = sprite.getData('card');
            if (!card) return;

            // During bidding or not our turn, dim all cards
            if (bidding === 1 || currentTurn !== position || playedCard) {
                sprite.setTint(0xaaaaaa);
                sprite.setData('isLegal', false);
                return;
            }

            // Check if this card is a legal move
            const isLegal = isLegalMove(card, playerCards, leadCard, playedCardIndex === 0, position);

            if (isLegal) {
                sprite.clearTint();
                sprite.setData('isLegal', true);
            } else {
                sprite.setTint(0x666666);
                sprite.setData('isLegal', false);
            }
        });
    }

    // Store the update function globally so socket handlers can call it
    window.updateCardLegality = updateCardLegality;

    playerHand.forEach((card, index) => {
        let cardKey = getCardImageKey(card);
        console.log(`Using image key: ${cardKey}`);
        let cardSprite = this.add.image(screenWidth / 2 + 500*scaleFactorX, screenHeight / 2 - 300*scaleFactorY, 'cards', cardKey)
        .setInteractive()
        .setScale(1.5);  // ✅ Increase size
        cardSprite.input.hitArea.setTo(cardSprite.width * 0.15, 0, cardSprite.width * 0.7, cardSprite.height);
        if (!cardSprite) {
            console.error(`🚨 ERROR: Failed to create card sprite for ${card.rank} of ${card.suit}`);
        }
        // Store card data on sprite for legality checks
        cardSprite.setData('card', card);
        cardSprite.setData('isLegal', false);
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
                this.tweens.add({
                    targets: cardSprite,
                    y: startY - 30,
                    duration: 150,
                    ease: 'Power2'
                });
            }
        });

        cardSprite.on("pointerout", () => {
            // Return card to original position
            this.tweens.add({
                targets: cardSprite,
                y: startY,
                duration: 150,
                ease: 'Power2'
            });
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
            console.log("my hand: ", playerHand);
        });
    });

    // Initial update of card legality (cards should be dimmed during bidding)
    updateCardLegality();

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
        let team1_y = centerPlayAreaY - 470*scaleFactorY;
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
        if(position % 2 !== 0){
            console.log("updating my scoreBug");
            scoreUI.teamScoreLabel.setText(me + "/" + partner + ": " + myBids[position - 1] + "/" + myBids[team(position) - 1] + "       " +  score1);
            scoreUI.oppScoreLabel.setText(opp1 + "/" + opp2 +  ": " + myBids[rotate(position) - 1] + "/" + myBids[rotate(rotate(rotate(position))) - 1] + "       " + score2);
        }
        else{
            console.log("updating their scoreBug");
            scoreUI.teamScoreLabel.setText(me + "/" + partner + ": " + myBids[position - 1] + "/" + myBids[team(position) - 1] + "       " +  score2);
            scoreUI.oppScoreLabel.setText(opp1 + "/" + opp2 + ": " + myBids[rotate(position) - 1] + "/" + myBids[rotate(rotate(rotate(position))) - 1] + "       " + score1);
        }
    });
    socket.on("updateTurn", (data) => {
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
            currentTrick.push(this.add.image(screenWidth / 2, screenHeight / 2 + 150, 'cards', cardKey).setScale(1.5));
        }
    })
    socket.on("trickComplete", (data) => {
        console.log("🏆 Trick complete. Moving and stacking to the right...");
        addToGameFeed("Trick won by " + getPlayerName(data.winner) + ".");

        // Reset lead card for next trick
        leadCard = null;
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
        let bidContainer = document.getElementById("bidContainer");
        if (bidContainer) {
            bidContainer.remove();
            console.log("✅ Bid container removed.");
        }
        // Clear the updateBoreButtons reference
        window.updateBoreButtons = null;
        tempBids = [];
        bidding = 0;

        // Update card legality now that bidding is over
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
            showScore(data.score.team1, data.score.team2, playerBids.bids, data.team1Tricks, data.team2Tricks,data.team1OldScore,data.team2OldScore);
        }
        console.log("🏁 Hand complete. Clearing all tricks...");
        addToGameFeed("Hand complete. Clearing all tricks...");
        teamTricks = 0;
        oppTricks = 0;
        isTrumpBroken = false;
        socket.off("handComplete");
        socket.off("doneBidding");
        socket.off("trickComplete");
        socket.off("cardPlayed");
        socket.off("updateTurn");
        socket.off("bidReceived");
        socket.off("cardPlayed");
        clearAllTricks();
        clearDisplayCards();
    });
}
let buttonHandle;
let oppUI = [];
function displayOpponentHands(numCards,dealer) {
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
        if(opponentId === "partner"){
            let partnerAvi = this.add.image(avatarX, avatarY, "profile" + playerData.pics[playerData.position.indexOf(team(position))])
            .setScale(0.2) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
            oppUI.push(partnerAvi);
            let partnerText = this.add.text(avatarX, avatarY + 60*scaleFactorY, playerData.username[playerData.position.indexOf(team(position))].username, {
                fontSize: "18px",
                fontFamily: "Arial",
                color: "#ffffff",
                fontStyle: "bold"
            })
            .setOrigin(0.5)  // Center the text horizontally
            .setDepth(250);
            oppUI.push(partnerText);
            if(team(position) === dealer){
                buttonHandle = this.add.image(avatarX + 75*scaleFactorX, avatarY, "dealer")
                .setScale(0.03) // Adjust size
                .setDepth(250) // Ensure it's above the cards
                .setAlpha(1);
                playerInfo.playerPositionText.setText("MP");
            }
        }
        if(opponentId === "opp1"){
            let opp1Avi = this.add.image(avatarX, avatarY, "profile" + playerData.pics[playerData.position.indexOf(rotate(position))])
            .setScale(0.2) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
            oppUI.push(opp1Avi);
            let opp1Text = this.add.text(avatarX, avatarY + 60*scaleFactorY, playerData.username[playerData.position.indexOf(rotate(position))].username, {
                fontSize: "18px",
                fontFamily: "Arial",
                color: "#ffffff",
                fontStyle: "bold"
            })
            .setOrigin(0.5)  // Center the text horizontally
            .setDepth(250);
            oppUI.push(opp1Text);
            if(rotate(position) === dealer){
                buttonHandle = this.add.image(avatarX - 75*scaleFactorX, avatarY, "dealer")
                .setScale(0.03) // Adjust size
                .setDepth(250) // Ensure it's above the cards
                .setAlpha(1);
                playerInfo.playerPositionText.setText("CO");
            }
        }
        if(opponentId === "opp2"){
            let opp2Avi = this.add.image(avatarX, avatarY, "profile" + playerData.pics[playerData.position.indexOf(rotate(rotate(rotate(position))))])
            .setScale(0.2) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
            oppUI.push(opp2Avi);
            let opp2Text = this.add.text(avatarX, avatarY + 60*scaleFactorY, playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username, {
                fontSize: "18px",
                fontFamily: "Arial",
                color: "#ffffff",
                fontStyle: "bold"
            })
            .setOrigin(0.5)  // Center the text horizontally
            .setDepth(250);
            oppUI.push(opp2Text);
            if(rotate(rotate(rotate(position))) === dealer){
                buttonHandle = this.add.image(avatarX + 75*scaleFactorX, avatarY, "dealer")
                .setScale(0.03) // Adjust size
                .setDepth(250) // Ensure it's above the cards
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