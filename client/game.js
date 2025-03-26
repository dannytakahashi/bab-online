

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
function create() {
    gameScene = this; // Store reference to the game scene
    console.log("running create4...");
    console.log("Socket in game.js:", socket);
    // Connect to server
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    this.cameras.main.setBackgroundColor("#228B22");
    //createVignette.call(this);
    console.log("✅ Background fade effect applied.");

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
        console.log("Hands data:", data.hands);
        console.log("scores:", data.score1, data.score2);
        console.log("Player's hand:", data.hands[playerId]);
        playerCards = data.hands[playerId]; 
        if (playerCards) {
            console.log("running display cards...");
            createGameFeed();
            initGameChat();
            scoreUI = createScorebug(this);
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
            let playerInfo = createPlayerInfoBox(); // Store the reference
            displayCards.call(this, playerCards);
            createVignette.call(this);
        } else {
            console.error("🚨 ERROR: playerCards is undefined! GameState may not be initializing correctly.");
        }
        displayOpponentHands.call(this, playerCards.length);
        if (data.trump) {
            displayTableCard.call(this, data.trump);
            trump = data.trump;
        }
    });
}
const config = {
    type: Phaser.AUTO,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: "transparent",
    parent: "game-container",
    scale: {
        mode: Phaser.Scale.FIT, // ✅ Ensures full coverage
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    scene: { preload, create, update },
    fps: {
        min: 10,       // prevent freezing
        target: 60,
        forceSetTimeOut: true // ⬅️ uses setTimeout instead of requestAnimationFrame
      },
      autoFocus: true,
      disableVisibilityChange: true // ⬅️ KEY LINE!
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
    feedContainer.style.position = "absolute";
    feedContainer.style.width = "200px";
    feedContainer.style.height = "200px";
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
    feedContainer.style.maxHeight = "200px"; // ✅ Limits scrolling area
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
    let handAreaHeight = 257;
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
function draw() {
    clearScreen.call(game.scene.scenes[0]);
    socket.off("youDrew");
    console.log("🃏 Placing all 54 cards face down...");
    createVignette.call(game.scene.scenes[0]);
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    
    let startX = 400; // ✅ Starting X position for first card
    let startY = screenHeight / 2; // ✅ Center the row of cards

    let overlap = 20; // ✅ Adjust overlap for better spacing

   

    for (let i = 0; i < 54; i++) {
        let cardSprite = this.add.image(screenWidth/2 + 500, startY, "cardBack") // ✅ All cards face down
            .setScale(1.2)
            .setInteractive()
            .setDepth(100);

        // ✅ Enable dragging
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

        // ✅ Make cards draggable
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

    let tableX = screenWidth / 2 + 500;
    let tableY = screenHeight / 2 - 300;

    let cardKey = getCardImageKey(card);

    // ✅ Remove the old table card if it exists
    if (this.tableCardBackground) this.tableCardBackground.destroy();
    if (this.tableCardSprite) this.tableCardSprite.destroy();
    if (this.tableCardLabel) this.tableCardLabel.destroy();

    // ✅ Create new table card sprite
    this.tableCardBackground = this.add.rectangle(tableX, tableY, 120, 160, 0x8B4513)
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
        if(card.suit !== trump.suit){
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
socket.on("abortGame", (data) => {
    console.log("caught abortGame");
    clearUI();
    showLobbyScreen();
    gameScene.children.removeAll(true);
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
    let centerPlayAreaX = screenWidth / 2;
    let centerPlayAreaY = screenHeight / 2;
    let opp1_x = centerPlayAreaX - 480;
    let opp1_y = centerPlayAreaY - 60;
    let opp2_x = centerPlayAreaX + 620;
    let opp2_y = centerPlayAreaY - 60;
    let team1_x = centerPlayAreaX + 80;
    let team1_y = centerPlayAreaY - 470;
    let me_x = screenWidth - 310;
    let me_y = screenHeight - 330;
    if (data.position === position + 1 || data.position === position - 3) {
        console.log("placing chat on opp1");
        let chatBubble = createSpeechBubble(scene, opp1_x, opp1_y, 150, 50, data.message);
        scene.time.delayedCall(3000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    if (data.position === position - 1 || data.position === position + 3) {
        console.log("placing chat on opp2");
        let chatBubble = createSpeechBubble(scene, opp2_x, opp2_y, 150, 50, data.message);
        scene.time.delayedCall(3000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    if (data.position === position + 2 || data.position === position - 2) {
        console.log("placing chat on team1");
        let chatBubble = createSpeechBubble(scene, team1_x, team1_y, 150, 50, data.message);
        scene.time.delayedCall(3000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
    }
    if (data.position === position) {
        console.log("placing chat on me");
        let chatBubble = createSpeechBubble(scene, me_x, me_y, 150, 50, data.message);
        scene.time.delayedCall(3000, () => {
            chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
        });
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
function displayCards(playerHand) {
    if (!this.handElements) {
        this.handElements = [];
    }
    removeWaitingScreen();
    removeDraw();
    console.log("running card display...");
    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let cardWidth = 100; // Approximate width of each card
    let cardSpacing = 50; // Spacing between cards
    let totalWidth = (playerHand.length - 1) * cardSpacing; // Width of all cards together
    let startX = (screenWidth - totalWidth) / 2; // ✅ Centered starting position
    let startY = this.scale.height - 200; // ✅ Adjust vertical position lower
    let handAreaHeight = 250; // ✅ Height of the background area
    let handAreaWidth = screenWidth * 0.5; // ✅ Width of the background area
    let opponent1_x = screenWidth / 2 - 200;
    let opponent1_y = screenHeight / 2;
    let opponent2_x = screenWidth / 2 + 200;
    let opponent2_y = screenHeight / 2;
    let team1_x = screenWidth / 2;
    let team1_y = screenHeight / 2 -150;
    if (!playZone) {
        let playZoneWidth = 600;
        let playZoneHeight = 400;
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
    this.handElements.push(playZone);

    let bidContainer = document.createElement("div");
    bidContainer.id = "bidContainer";
    bidContainer.style.position = "absolute";
    bidContainer.style.width = "120px"; // Slightly wider than input box
    bidContainer.style.height = "100px"; // Taller than input box
    bidContainer.style.padding = "20px";
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
    inputBox.placeholder = "Enter Bid...";
    inputBox.style.position = "absolute";
    inputBox.style.fontSize = "20px";
    inputBox.style.padding = "10px";
    inputBox.style.width = "100px";
    inputBox.style.border = "2px solid #8B4513";
    inputBox.style.background = "#FFF8DC"; // Light beige color
    inputBox.style.color = "#000";
    inputBox.style.borderRadius = "10px";
    inputBox.style.textAlign = "center";
    document.body.appendChild(inputBox);
    this.handElements.push(inputBox);

    let bidButton = document.createElement("button");
    bidButton.id = "bidButton";
    bidButton.innerText = "BID";
    bidButton.style.position = "absolute";
    bidButton.style.fontSize = "18px";
    bidButton.style.padding = "10px 20px";
    bidButton.style.width = "125px"; // Same width as input box
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
        inputBox.style.left = `${canvasRect.left + handAreaWidth - 640}px`; // Right of hand area
        inputBox.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 - 20}px`;
        bidButton.style.left = `${canvasRect.left + handAreaWidth - 640}px`; // Right of hand area
        bidButton.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 + 35}px`;
        bidContainer.style.left = `${canvasRect.left + handAreaWidth - 660}px`; // Right of hand area
        bidContainer.style.top = `${canvasRect.top + screenHeight - handAreaHeight / 2 - 50}px`;
    }
    // ✅ Update position initially and on window resize
    updateInputBoxPosition();
    window.addEventListener("resize", updateInputBoxPosition);
    bidButton.addEventListener("click", () => {
        let bidValue = inputBox.value.trim();
        if (bidValue === "") {
            console.warn("⚠️ No bid entered.");
            return;
        }
        if ((bidValue < 0 || bidValue > playerCards.length) && (bidValue.toUpperCase() !== "B" || bidValue.toUpperCase() !== "2B" || bidValue.toUpperCase() !== "3B" || bidValue.toUpperCase() !== "4B")){
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
        console.log(`📩 Sending bid: ${bidValue}`);

        // ✅ Send bid data to the server
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
        let cardSprite = this.add.image(screenWidth / 2 + 500, screenHeight / 2 - 300, cardKey)
        .setInteractive()
        .setScale(1.5);  // ✅ Increase size
        if (!cardSprite) {
            console.error(`🚨 ERROR: Failed to create card sprite for ${card.rank} of ${card.suit}`);
        }
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
                if(currentTurn !== position || bidding === 1){
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
                if(card.suit === trump.suit){
                    isTrumpBroken = true;
                }
                leadBool = false;
                cardSprite.destroy(); // Remove after playing
                playerHand = removeCard(playerHand, card);
                console.log("my hand: ", playerHand);
            }else if (Phaser.Geom.Rectangle.Contains(handBackground.getBounds(), cardSprite.x, cardSprite.y)) {
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
        addToGameFeed("Player "+ data.position + " bid "+ data.bid + ".");
        tempBids.push(data.bid.toUpperCase());
        let scene = game.scene.scenes[0];
        let screenWidth = scene.scale.width;
        let screenHeight = scene.scale.height;
        let centerPlayAreaX = screenWidth / 2;
        let centerPlayAreaY = screenHeight / 2;
        let opp1_x = centerPlayAreaX - 480;
        let opp1_y = centerPlayAreaY - 60;
        let opp2_x = centerPlayAreaX + 620;
        let opp2_y = centerPlayAreaY - 60;
        let team1_x = centerPlayAreaX + 80;
        let team1_y = centerPlayAreaY - 470;
        let me_x = screenWidth - 310;
        let me_y = screenHeight - 330;
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
            scene.time.delayedCall(3000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        if (data.position === position - 1 || data.position === position + 3) {
            console.log("placing chat on opp2");
            let chatBubble = createSpeechBubble(scene, opp2_x, opp2_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(3000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        if (data.position === position + 2 || data.position === position - 2) {
            console.log("placing chat on team1");
            let chatBubble = createSpeechBubble(scene, team1_x, team1_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(3000, () => {
                chatBubble.destroy(); // ✅ Destroy the chat bubble after 3 seconds
            });
        }
        if (data.position === position) {
            console.log("placing chat on me");
            let chatBubble = createSpeechBubble(scene, me_x, me_y, 50, 50, data.bid, "#FF0000");
            scene.time.delayedCall(3000, () => {
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
        console.log("Current turn:", currentTurn);
        if(currentTurn === position){
            addTurnGlow(this);
        }
        else{
            removeTurnGlow(this);
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
        addToGameFeed("Trick won by player " + data.winner + ".");
        let screenWidth = this.scale.width;
        let screenHeight = this.scale.height;
        let trickSpacing = 40; // ✅ Horizontal spacing between tricks
    
    
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
        currentTrick = []; // ✅ Clear the reference to avoid moving previous tricks
    
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
                        x: winningPosition.x + index * 20, // ✅ Fan out horizontally
                        y: winningPosition.y - index * 5, // ✅ Slight vertical offset
                        duration: 200,
                        ease: "Power1"
                    });
                }else{
                    card.x = winningPosition.x + index * 20;
                    card.y = winningPosition.y - index * 5;
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
function displayOpponentHands(numCards) {
    console.log("🎭 Displaying opponent hands...");

    let screenWidth = this.scale.width;
    let screenHeight = this.scale.height;
    let cardSpacing = 10; // Spacing between cards
    let centerPlayAreaX = screenWidth / 2;
    let centerPlayAreaY = screenHeight / 2;
    let opponentPositions = {
        "partner": { x: centerPlayAreaX, y: centerPlayAreaY - 275, rotation: 0, horizontal: true, avatarX: centerPlayAreaX, avatarY: centerPlayAreaY - 400 },  // ✅ Top (horizontal)
        "opp1": { x: centerPlayAreaX - 425, y: centerPlayAreaY, rotation: Math.PI / 2, horizontal: false, avatarX: centerPlayAreaX - 550, avatarY: centerPlayAreaY},  // ✅ Left (closer)
        "opp2": { x: centerPlayAreaX + 425, y: centerPlayAreaY, rotation: -Math.PI / 2, horizontal: false, avatarX: centerPlayAreaX + 550, avatarY: centerPlayAreaY} // ✅ Right (closer)
    };
    Object.keys(opponentCardSprites).forEach((opponentId) => {
        opponentCardSprites[opponentId].forEach(card => card.destroy());
    });
    opponentCardSprites = {}; // ✅ Reset storage
    Object.keys(opponentPositions).forEach((opponentId) => {
        let { x, y, rotation, horizontal, avatarX, avatarY } = opponentPositions[opponentId];
        if(opponentId === "partner"){
            this.add.image(avatarX, avatarY, "profile" + playerData.pics[playerData.position.indexOf(team(position))])
            .setScale(0.2) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
            this.add.text(avatarX, avatarY + 60, playerData.username[playerData.position.indexOf(team(position))].username, {
                fontSize: "18px",
                fontFamily: "Arial",
                color: "#ffffff",
                fontStyle: "bold"
            })
            .setOrigin(0.5)  // Center the text horizontally
            .setDepth(250);
        }
        if(opponentId === "opp1"){
            this.add.image(avatarX, avatarY, "profile" + playerData.pics[playerData.position.indexOf(rotate(position))])
            .setScale(0.2) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
            this.add.text(avatarX, avatarY + 60, playerData.username[playerData.position.indexOf(rotate(position))].username, {
                fontSize: "18px",
                fontFamily: "Arial",
                color: "#ffffff",
                fontStyle: "bold"
            })
            .setOrigin(0.5)  // Center the text horizontally
            .setDepth(250);
        }
        if(opponentId === "opp2"){
            this.add.image(avatarX, avatarY, "profile" + playerData.pics[playerData.position.indexOf(rotate(rotate(rotate(position))))])
            .setScale(0.2) // Adjust size
            .setDepth(250) // Ensure it's above the cards
            .setAlpha(1);
            this.add.text(avatarX, avatarY + 60, playerData.username[playerData.position.indexOf(rotate(rotate(rotate(position))))].username, {
                fontSize: "18px",
                fontFamily: "Arial",
                color: "#ffffff",
                fontStyle: "bold"
            })
            .setOrigin(0.5)  // Center the text horizontally
            .setDepth(250);
        }
        opponentCardSprites[opponentId] = [];
        for (let i = 0; i < numCards; i++) {
            let offsetX = horizontal ? (i - numCards / 2) * cardSpacing : 0; // ✅ Left/Right: No horizontal movement
            let offsetY = horizontal ? 0 : (i - numCards / 2) * cardSpacing; // ✅ Top: No vertical movement

            let cardBack = this.add.image(screenWidth / 2 + 500, screenHeight / 2 - 300, "cardBack")
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