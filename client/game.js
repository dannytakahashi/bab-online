

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
document.addEventListener("rejoinSuccess", (event) => {
    let data = event.detail;
    console.log("🔄 Rejoining game:", data);

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

    // Get the scene
    let scene = game.scene.scenes[0];
    if (!scene) {
        console.error("🚨 No scene available for rejoin");
        return;
    }

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
        displayCards.call(scene, playerCards);
    }

    // Display opponent hands (card backs)
    displayOpponentHands.call(scene, playerCards ? playerCards.length : 0, dealer);

    // Display trump card
    if (trump) {
        displayTableCard.call(scene, trump);
    }

    addToGameFeed("Reconnected to game!");
});

// Handle rejoin failure
document.addEventListener("rejoinFailed", (event) => {
    console.log("❌ Rejoin failed:", event.detail.reason);
    // Show lobby screen since we can't rejoin
    showLobbyScreen();
});

// Handle player reconnection notification
document.addEventListener("playerReconnected", (event) => {
    let data = event.detail;
    console.log(`🔄 Player ${data.username} at position ${data.position} reconnected`);
    addToGameFeed(`${data.username} reconnected`);
});

// Handle player disconnect notification (from server)
socket.on("playerDisconnected", (data) => {
    console.log(`⚠️ Player at position ${data.position} disconnected`);
    addToGameFeed(`Player ${data.position} disconnected - waiting for reconnection...`);
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
function rotate(num){
    num = num + 1;
    if (num > 4){
        num = 1;
    }
    return num;
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
    console.log("⏳ Waiting for players...");
    socket.on("positionUpdate", (data) => {
        console.log("Position update received:", data);
        playerData = {
            position: data.positions,
            socket: data.sockets,
            username: data.usernames,
            pics: data.pics
        }
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
            displayCards.call(this, playerCards);
            //createVignette.call(this);
        } else {
            console.error("🚨 ERROR: playerCards is undefined! GameState may not be initializing correctly.");
        }
        displayOpponentHands.call(this, playerCards.length, dealer);
        if (data.trump) {
            displayTableCard.call(this, data.trump);
            trump = data.trump;
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
    this.load.image("cardBack", "assets/card_back.png");
    this.load.image("a_spades", "assets/ace_spades.png");
    this.load.image("k_spades", "assets/king_spades.png");
    this.load.image("q_spades", "assets/queen_spades.png");
    this.load.image("j_spades", "assets/jack_spades.png");
    this.load.image("10_spades", "assets/10_spades.png");
    this.load.image("9_spades", "assets/9_spades.png");
    this.load.image("8_spades", "assets/8_spades.png");
    this.load.image("7_spades", "assets/7_spades.png");
    this.load.image("6_spades", "assets/6_spades.png");
    this.load.image("5_spades", "assets/5_spades.png");
    this.load.image("4_spades", "assets/4_spades.png");
    this.load.image("3_spades", "assets/3_spades.png");
    this.load.image("2_spades", "assets/2_spades.png");
    this.load.image("a_hearts", "assets/ace_hearts.png");
    this.load.image("k_hearts", "assets/king_hearts.png");
    this.load.image("q_hearts", "assets/queen_hearts.png");
    this.load.image("j_hearts", "assets/jack_hearts.png");
    this.load.image("10_hearts", "assets/10_hearts.png");
    this.load.image("9_hearts", "assets/9_hearts.png");
    this.load.image("8_hearts", "assets/8_hearts.png");
    this.load.image("7_hearts", "assets/7_hearts.png");
    this.load.image("6_hearts", "assets/6_hearts.png");
    this.load.image("5_hearts", "assets/5_hearts.png");
    this.load.image("4_hearts", "assets/4_hearts.png");
    this.load.image("3_hearts", "assets/3_hearts.png");
    this.load.image("2_hearts", "assets/2_hearts.png");
    this.load.image("a_clubs", "assets/ace_clubs.png");
    this.load.image("k_clubs", "assets/king_clubs.png");
    this.load.image("q_clubs", "assets/queen_clubs.png");
    this.load.image("j_clubs", "assets/jack_clubs.png");
    this.load.image("10_clubs", "assets/10_clubs.png");
    this.load.image("9_clubs", "assets/9_clubs.png");
    this.load.image("8_clubs", "assets/8_clubs.png");
    this.load.image("7_clubs", "assets/7_clubs.png");
    this.load.image("6_clubs", "assets/6_clubs.png");
    this.load.image("5_clubs", "assets/5_clubs.png");
    this.load.image("4_clubs", "assets/4_clubs.png");
    this.load.image("3_clubs", "assets/3_clubs.png");
    this.load.image("2_clubs", "assets/2_clubs.png");
    this.load.image("a_diamonds", "assets/ace_diamonds.png");
    this.load.image("k_diamonds", "assets/king_diamonds.png");
    this.load.image("q_diamonds", "assets/queen_diamonds.png");
    this.load.image("j_diamonds", "assets/jack_diamonds.png");
    this.load.image("10_diamonds", "assets/10_diamonds.png");
    this.load.image("9_diamonds", "assets/9_diamonds.png");
    this.load.image("8_diamonds", "assets/8_diamonds.png");
    this.load.image("7_diamonds", "assets/7_diamonds.png");
    this.load.image("6_diamonds", "assets/6_diamonds.png");
    this.load.image("5_diamonds", "assets/5_diamonds.png");
    this.load.image("4_diamonds", "assets/4_diamonds.png");
    this.load.image("3_diamonds", "assets/3_diamonds.png");
    this.load.image("2_diamonds", "assets/2_diamonds.png");
    this.load.image("hi_joker", "assets/hi_joker.png");
    this.load.image("lo_joker", "assets/lo_joker.png");
    this.load.image("profile1", "assets/profile1.png");
    this.load.image("profile2", "assets/profile2.png");
    this.load.image("profile3", "assets/profile3.png");
    this.load.image("profile4", "assets/profile4.png");
    this.load.image("profile5", "assets/profile5.png");
    this.load.image("profile6", "assets/profile6.png");
    this.load.image("profile7", "assets/profile7.png");
    this.load.image("profile8", "assets/profile8.png");
    this.load.image("profile9", "assets/profile9.png");
    this.load.image("profile12", "assets/profile12.png");
    this.load.image("profile13", "assets/profile13.png");
    this.load.image("profile14", "assets/profile14.png");
    this.load.image("profile15", "assets/profile15.png");
    this.load.image("profile16", "assets/profile16.png");
    this.load.image("profile17", "assets/profile17.png");
    this.load.image("profile18", "assets/profile18.png");
    this.load.image("profile19", "assets/profile19.png");
    this.load.image("profile20", "assets/profile20.png");
    this.load.image("profile21", "assets/profile21.png");
    this.load.image("profile22", "assets/profile22.png");
    this.load.image("profile23", "assets/profile23.png");
    this.load.image("profile24", "assets/profile24.png");
    this.load.image("profile25", "assets/profile25.png");
    this.load.image("profile26", "assets/profile26.png");
    this.load.image("profile27", "assets/profile27.png");
    this.load.image("profile28", "assets/profile28.png");
    this.load.image("profile29", "assets/profile29.png");
    this.load.image("profile30", "assets/profile30.png");
    this.load.image("profile31", "assets/profile31.png");
    this.load.image("profile32", "assets/profile32.png");
    this.load.image("profile33", "assets/profile33.png");
    this.load.image("profile34", "assets/profile34.png");
    this.load.image("profile35", "assets/profile35.png");
    this.load.image("profile36", "assets/profile36.png");
    this.load.image("profile37", "assets/profile37.png");
    this.load.image("profile38", "assets/profile38.png");
    this.load.image("profile39", "assets/profile39.png");
    this.load.image("profile40", "assets/profile40.png");
    this.load.image("profile41", "assets/profile41.png");
    this.load.image("profile42", "assets/profile42.png");
    this.load.image("profile43", "assets/profile43.png");
    this.load.image("profile44", "assets/profile44.png");
    this.load.image("profile45", "assets/profile45.png");
    this.load.image("profile46", "assets/profile46.png");
    this.load.image("profile47", "assets/profile47.png");
    this.load.image("profile48", "assets/profile48.png");
    this.load.image("profile49", "assets/profile49.png");
    this.load.image("profile50", "assets/profile50.png");
    this.load.image("profile51", "assets/profile51.png");
    this.load.image("profile52", "assets/profile52.png");
    this.load.image("profile53", "assets/profile53.png");
    this.load.image("profile54", "assets/profile54.png");
    this.load.image("profile55", "assets/profile55.png");
    this.load.image("profile56", "assets/profile56.png");
    this.load.image("profile57", "assets/profile57.png");
    this.load.image("profile58", "assets/profile58.png");
    this.load.image("profile59", "assets/profile59.png");
    this.load.image("profile60", "assets/profile60.png");
    this.load.image("profile61", "assets/profile61.png");
    this.load.image("profile62", "assets/profile62.png");
    this.load.image("profile63", "assets/profile63.png");
    this.load.image("profile64", "assets/profile64.png");
    this.load.image("profile65", "assets/profile65.png");
    this.load.image("profile66", "assets/profile66.png");
    this.load.image("profile67", "assets/profile67.png");
    this.load.image("profile68", "assets/profile68.png");
    this.load.image("profile69", "assets/profile69.png");
    this.load.image("profile70", "assets/profile70.png");
    this.load.image("profile71", "assets/profile71.png");
    this.load.image("profile72", "assets/profile72.png");
    this.load.image("profile73", "assets/profile73.png");
    this.load.image("profile74", "assets/profile74.png");
    this.load.image("profile75", "assets/profile75.png");
    this.load.image("profile76", "assets/profile76.png");
    this.load.image("profile77", "assets/profile77.png");
    this.load.image("profile78", "assets/profile78.png");
    this.load.image("profile79", "assets/profile79.png");
    this.load.image("profile80", "assets/profile80.png");
    this.load.image("profile81", "assets/profile81.png");
    this.load.image("profile82", "assets/profile82.png");
    this.load.image("dealer", "assets/frog.png");
    this.load.image("background", "assets/background.png");
    this.load.image("rainbow", "assets/rainbow1.png");
    this.load.image("ot", "assets/ot.png");
    this.load.image("b", "assets/b.png");
    this.load.image("2b", "assets/2b.png");
    this.load.image("3b", "assets/3b.png");
    this.load.image("4b", "assets/4b.png");
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
    feedContainer.style.textAlign = "right";

    document.body.appendChild(feedContainer);
}
function addToGameFeed(message) {
    let feedContainer = document.getElementById("gameFeed");
    
    if (!feedContainer) {
        console.warn("⚠️ Game feed container not found!");
        return;
    }

    // ✅ Create a new message element
    let messageElement = document.createElement("div");
    messageElement.innerText = message;
    messageElement.style.marginBottom = "5px";

    // ✅ Add the message at the bottom
    feedContainer.appendChild(messageElement);

    // ✅ Scroll to the latest message
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

    let handX = screenWidth / 2;
    let handY = screenHeight - handAreaHeight / 2;

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
function draw() {
    clearScreen.call(game.scene.scenes[0]);
    socket.off("youDrew");
    console.log("🃏 Placing all 54 cards face down...");
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let scaleFactorX = screenWidth / 1920; // Adjust based on your design resolution
    let scaleFactorY = screenHeight / 953; // Adjust based on your design resolution
    let startX = 400*scaleFactorX; // ✅ Starting X position for first card
    let startY = screenHeight / 2; // ✅ Center the row of cards
    let overlap = 20*scaleFactorX; // ✅ Adjust overlap for better spacing
    const bg = this.add.image(0, 0, 'background')
    .setOrigin(0, 0)
    .setDisplaySize(this.scale.width, this.scale.height)  // Stretch to fill screen
    .setScrollFactor(0)
    .setDepth(-100)  // Make it non-scrollable (fixed to camera)
    for (let i = 0; i < 54; i++) {
        let cardSprite = this.add.image(screenWidth/2 + 500*scaleFactorX, startY, "cardBack") // ✅ All cards face down
            .setScale(1.2)
            .setInteractive()
            .setDepth(100);
        this.input.setDraggable(cardSprite);
        if (visible()){
        this.tweens.add({
            targets: cardSprite,
            x: startX + i * overlap,
            y: startY,
            duration: 750,
            ease: "Power2",
            delay: 0,
            onComplete: () =>{
            }
        });
        }else{
            cardSprite.x = startX + i * overlap;
            cardSprite.y = startY;
        }
        cardSprite.on("pointerup", () => {
            console.log(`📦 Picked up card ${i + 1}`);
            socket.emit("draw", {num: Math.floor(Math.random() * 54)});
            socket.on("youDrew", (data)=>{
                console.log(`🎴 You drew: ${data.card.rank} of ${data.card.suit}`);

                let textureKey = getCardImageKey(data.card); // ✅ Convert card to asset key
                if (this.textures.exists(textureKey)) {
                    cardSprite.setTexture(textureKey); // ✅ Change the sprite
                } else {
                    console.error(`❌ Texture ${textureKey} not found!`);
                }
                allCards.forEach(card => {
                    card.disableInteractive(); // ✅ Remove interactivity from other cards
                });

                console.log("🚫 All other cards are now non-draggable.");
            });
        });
        this.input.on("drag", (pointer, gameObject, dragX, dragY) => {
            gameObject.x = dragX;
            gameObject.y = dragY;
        });
        allCards.push(cardSprite);
    }
    console.log("✅ All 54 cards placed face down and draggable.");
}
function removeDraw() {
    console.log("🔥 Destroying all displayed cards...");

    allCards.forEach(card => {
        if (card) {
            card.destroy(); // ✅ Remove card from the game
        }
    });

    allCards = []; // ✅ Clear the array to free memory

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
    tableCardSprite = this.add.image(tableX, tableY, cardKey).setScale(1.5);
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
    console.log("card.suit: ", card.suit);
    console.log("lead.suit: ", lead);
    console.log("leadBool: ", leadBool);
    console.log("isVoid: ", isVoid(hand, lead.suit));
    if (sameSuit(card,trump) && !isTrumpBroken && leadBool && !isTrumpTight(hand, trump)){
        console.log("trump not broken");
        return false;
    }
    if (!sameSuit(card,lead) && !isVoid(hand, lead.suit)){
        console.log("not void of lead suit.");
        return false;
    }
    if (lead.rank === "HI" && !highestTrump(card.rank,hand,trump) && (leadPosition % 2 !== position % 2)){
        console.log("Hi lead. Highest trump only.")
        return false;
    }
    else{
        console.log("legal move.");
        return true;
    }

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
    showLobbyScreen();
    gameScene.children.removeAll(true);
    gameScene.scene.restart();
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
    showLobbyScreen();
    alert("Queue is full. Please try again later.");
});
socket.on("gameEnd", (data) => {
    console.log("caught gameEnd");
    showFinalScore(data.score.team1,data.score.team2);
});
socket.on("startDraw", (data) => {
    removeWaitingScreen();
    draw.call(game.scene.scenes[0]);
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
socket.on("queueUpdate", (data) => {
    console.log("caught queueUpdate");
    if(waitBool){
        console.log("queue update data is: ", data);
        showPlayerQueue(data.queuedUsers);
    }
    else{
        queueDelay = true;
        lastQueueData = data.queuedUsers;
    }
});
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
function displayCards(playerHand) {
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
    let startY = this.scale.height - 200*scaleFactorY; // ✅ Adjust vertical position lower
    let opponent1_x = screenWidth / 2 - 200*scaleFactorX;
    let opponent1_y = screenHeight / 2;
    let opponent2_x = screenWidth / 2 + 200*scaleFactorX;
    let opponent2_y = screenHeight / 2;
    let team1_x = screenWidth / 2;
    let team1_y = screenHeight / 2 - 150*scaleFactorY;
    let handAreaWidth = screenWidth * 0.5; // ✅ Width of the background area
    let handAreaHeight = 250*scaleFactorY; // ✅ Height of the background area
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
            handBackground = this.add.rectangle(screenWidth / 2, screenHeight - handAreaHeight / 2, 
            screenWidth * 0.5, handAreaHeight, 0xD2B48C)
            .setDepth(-2); // 
            border = this.add.rectangle(screenWidth / 2, screenHeight - handAreaHeight / 2, 
            screenWidth * 0.5, handAreaHeight)
            .setStrokeStyle(4, 0x8B4513) // ✅ Dark brown border
            .setDepth(-1); // ✅ Slightly above background, but below cards
    }
    console.log("🟫 Added background for player hand.");
    let bidContainer = document.createElement("div");
    bidContainer.id = "bidContainer";
    bidContainer.classList.add("ui-element");
    bidContainer.style.position = "absolute";
    bidContainer.style.width = "6vw"; // Slightly wider than input box
    bidContainer.style.height = "10vh"; // Taller than input box
    bidContainer.style.padding = "1vw";
    bidContainer.style.background = "#333333"; // Dark grey
    bidContainer.style.border = "3px solid #444444"; // Slightly lighter grey border
    bidContainer.style.borderRadius = "10px";
    bidContainer.style.textAlign = "center"; // Center text inside
    document.body.appendChild(bidContainer);
    console.log("✅ BID background container created.");
    this.handElements.push(bidContainer);
    let inputBox = document.createElement("input");
    inputBox.id = "inputBox";
    inputBox.type = "text";
    inputBox.classList.add("ui-element");
    inputBox.placeholder = "Enter Bid...";
    inputBox.style.position = "absolute";
    inputBox.style.fontSize = "20px";
    inputBox.style.padding = "10px";
    inputBox.style.width = "5vw";
    inputBox.style.border = "2px solid #8B4513";
    inputBox.style.background = "#FFF8DC"; // Light beige color
    inputBox.style.color = "#000";
    inputBox.style.borderRadius = "10px";
    inputBox.style.textAlign = "center";
    document.body.appendChild(inputBox);
    this.handElements.push(inputBox);
    let bidButton = document.createElement("button");
    bidButton.id = "bidButton";
    bidButton.classList.add("ui-element");
    bidButton.innerText = "BID";
    bidButton.style.position = "absolute";
    bidButton.style.fontSize = "18px";
    bidButton.style.padding = "10px 20px";
    bidButton.style.width = "6vw"; // Same width as input box
    bidButton.style.border = "2px solid #8B4513";
    bidButton.style.background = "#D50505";
    bidButton.style.color = "#FFF";
    bidButton.style.borderRadius = "10px";
    bidButton.style.cursor = "pointer";
    document.body.appendChild(bidButton);
    this.handElements.push(bidButton);
    console.log("✅ Enter bid button created.");
    // ✅ Position the input box relative to the game canvas
    function updateInputBoxPosition() {
        let canvasRect = document.querySelector("canvas").getBoundingClientRect();
        inputBox.style.left = `${canvasRect.left + handAreaWidth - 640*scaleFactorX}px`; // Right of hand area
        inputBox.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 - 20*scaleFactorY}px`;
        bidButton.style.left = `${canvasRect.left + handAreaWidth - 640*scaleFactorX}px`; // Right of hand area
        bidButton.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 + 35*scaleFactorY}px`;
        bidContainer.style.left = `${canvasRect.left + handAreaWidth - 660*scaleFactorX}px`; // Right of hand area
        bidContainer.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 - 50*scaleFactorY}px`;
    }
    // ✅ Update position initially and on window resize
    updateInputBoxPosition();
    window.addEventListener("resize", updateInputBoxPosition);
    bidButton.addEventListener("click", () => {
        let bidValue = inputBox.value.trim();
        if (currentTurn !== position || bidding === 0){
            console.warn("not your bid.");
            return;
        }
        if (bidValue === "") {
            console.warn("⚠️ No bid entered.");
            return;
        }
        if ((bidValue < 0 || bidValue > playerCards.length) || ((!Number.isInteger(Number(bidValue))) && bidValue.toUpperCase() !== "B" && bidValue.toUpperCase() !== "2B" && bidValue.toUpperCase() !== "3B" && bidValue.toUpperCase() !== "4B")){
            console.warn("⚠️ Invalid bid entered.");
            return;
        }
        if(bidValue.toUpperCase() === "2B"){
            console.log("tempBids: ", tempBids);
            console.log("indexOf B: ", tempBids.indexOf("B"));
            if(tempBids.indexOf("B") === -1){
                console.warn("⚠️ invalid 2B.");
                return;
            }
        }
        if(bidValue.toUpperCase() === "3B"){
            console.log("tempBids: ", tempBids);
            console.log("indexOf 2B: ", tempBids.indexOf("2B"));
            if(tempBids.indexOf("2B") === -1){
                console.warn("⚠️ invalid 3B.");
                return;
            }
        }
        if(bidValue.toUpperCase() === "4B"){
            if(tempBids.indexOf("3B") === -1){
                console.warn("⚠️ invalid 4B.");
                return;
            }
        }
        if(bidValue.toUpperCase() !== "B" && bidValue.toUpperCase() !== "2B" && bidValue.toUpperCase() !== "3B" && bidValue.toUpperCase() !== "4B"){
            bidValue = Math.round(Number(bidValue)).toString(); // ✅ Round to nearest integer
        }
        console.log(`📩 Sending bid: ${bidValue}`);
        socket.emit("playerBid", { position: position, bid: bidValue });

        // ✅ Clear the input box after submission
        inputBox.value = "";
    });
    console.log(`🖥️ Screen Width: ${screenWidth}, Starting X: ${startX}`);
    console.log("player hand:", playerHand);
    let cardDepth = 200;
    playerHand.forEach((card, index) => {
        let cardKey = getCardImageKey(card);
        console.log(`Using image key: ${cardKey}`);
        let cardSprite = this.add.image(screenWidth / 2 + 500*scaleFactorX, screenHeight / 2 - 300*scaleFactorY, cardKey)
        .setInteractive()
        .setScale(1.5);  // ✅ Increase size
        cardSprite.input.hitArea.setTo(cardSprite.width * 0.15, 0, cardSprite.width * 0.7, cardSprite.height);
        if (!cardSprite) {
            console.error(`🚨 ERROR: Failed to create card sprite for ${card.rank} of ${card.suit}`);
        }
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
        this.input.setDraggable(cardSprite);
        let originalX = startX + index * cardSpacing;
        let originalY = startY;
        cardSprite.on("dragstart", (pointer, gameObject) => {
            cardSprite.setDepth(cardDepth);
            cardDepth++;
        });
        cardSprite.on("dragend", (pointer, gameObject) => {
            console.log("playzone bounds:", playZone.getBounds());
            console.log("you dropped at: ", cardSprite.x, ", ", cardSprite.y);
            if (Phaser.Geom.Rectangle.Contains(playZone.getBounds(), cardSprite.x, cardSprite.y)) {
                console.log(`✅ Card dropped in play zone: ${card.rank} of ${card.suit}`);
                if(currentTurn !== position || bidding === 1 || playedCard){
                    console.log("Not your turn!");
                    cardSprite.setPosition(originalX, originalY); // Return the card to its original position
                    return;
                    }
                console.log("playedCardIndex: ", playedCardIndex);
                if(playedCardIndex === 0){
                    leadCard = card;
                    leadPosition = position;
                    leadBool = true;
                    console.log("leadBool changed to true.");
                }
                if (!isLegalMove(card, playerCards, leadCard, leadBool, leadPosition)){
                    console.log("Illegal move!");
                    cardSprite.setPosition(originalX, originalY); // Return the card to its original position
                    return;
                }
                socket.emit("playCard", { card, position });
                playedCard = true;
                if(card.suit === trump.suit || card.suit === "joker"){
                    isTrumpBroken = true;
                }
                leadBool = false;
                cardSprite.destroy(); // Remove after playing
                playerHand = removeCard(playerHand, card);
                console.log("my hand: ", playerHand);
            }else if (Phaser.Geom.Rectangle.Contains(handBackground.getBounds(), cardSprite.x, cardSprite.y)) {
                originalX = cardSprite.x;
                originalY = cardSprite.y;
                return;
            }else {
                console.warn("🚫 Card dropped outside play zone, returning to original position.");
                cardSprite.setPosition(originalX, originalY); // Return the card to its original position
            }
        });

        this.input.on("drag", (pointer, gameObject, dragX, dragY) => {
            gameObject.x = dragX;
            gameObject.y = dragY;
        });
    });
    socket.on("bidReceived", (data) => {
        console.log("bid received: ", data.bid);
        if(data.bid.toUpperCase() === "B"){
            showImpactEvent("b");
        }
        if(data.bid.toUpperCase() === "2B"){
            showImpactEvent("2b");
        }
        if(data.bid.toUpperCase() === "3B"){
            showImpactEvent("3b");
        }
        if(data.bid.toUpperCase() === "4B"){
            showImpactEvent("4b");
        }
        addToGameFeed(playerData.username[playerData.position.indexOf(data.position)].username + " bid "+ data.bid + ".");
        tempBids.push(data.bid.toUpperCase());
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
    })
    socket.on("cardPlayed", (data) => {
        console.log(`position ${data.position} played ${data.card.rank} of ${data.card.suit}`);
        if(playedCardIndex === 0){
            leadCard = data.card;
            leadPosition = data.position;
            console.log("leadCard: ", leadCard);
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
                            removedCard.setTexture(cardKey);
                            removedCard.setDepth(200);
                            console.log("card texture changed to: ", cardKey);
                        } 
                    });
                }else{
                    removedCard.x = opponent1_x;
                    removedCard.y = opponent1_y;
                    removedCard.setTexture(cardKey);
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
                            removedCard.setTexture(cardKey);
                            removedCard.setDepth(200);
                            console.log("card texture changed to: ", cardKey);
                        } 
                    });
                }else{
                    removedCard.x = team1_x;
                    removedCard.y = team1_y;
                    removedCard.setTexture(cardKey);
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
                            removedCard.setTexture(cardKey);
                            removedCard.setDepth(200);
                            console.log("card texture changed to: ", cardKey);
                        } 
                    });
                }else{
                    removedCard.x = opponent2_x;
                    removedCard.y = opponent2_y;
                    removedCard.setTexture(cardKey);
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
            currentTrick.push(this.add.image(screenWidth / 2, screenHeight / 2 + 150, cardKey).setScale(1.5));
        }
    })
    socket.on("trickComplete", (data) => {
        console.log("🏆 Trick complete. Moving and stacking to the right...");
        addToGameFeed("Trick won by " + playerData.username[playerData.position.indexOf(data.winner)].username + ".");
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
        let inputBox = document.getElementById("inputBox");
        let bidButton = document.getElementById("bidButton");
        if (bidContainer) {
            bidContainer.remove();
            console.log("✅ Bid container removed.");
        }
        if (inputBox) {
            inputBox.remove();
            console.log("✅ Bid input removed.");
        }
        if (bidButton) {
            bidButton.remove();
            console.log("✅ Bid button removed.");
        }
        tempBids = [];
        bidding = 0;
        playerBids = data;
        console.log("bids: ", playerBids);
        rainbows.forEach((rainbow) => {
            if(rainbow === position){
                console.log("adding rainbow to me");
                addToGameFeed(playerData.username[playerData.position.indexOf(position)].username + " has a rainbow!");
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
                addToGameFeed(playerData.username[playerData.position.indexOf(rotate(position))].username + " has a rainbow!");
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
                addToGameFeed(playerData.username[playerData.position.indexOf(team(position))].username + " has a rainbow!");
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
                addToGameFeed(playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username + " has a rainbow!");
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