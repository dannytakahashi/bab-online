
function sleepSync(milliseconds) {
    const start = Date.now();
    while (Date.now() - start < milliseconds) {
    }
}
function rotate(num){
    num = num + 1;
    if (num > 4){
        num = 1;
    }
    return num;
}
let bidRanks = {
    "4B": 16,
    "3B": 15,
    "2B": 14,
    "B": 13,
    "12": 12,
    "11": 11,
    "10": 10,
    "9": 9,
    "8": 8,
    "7": 7,
    "6": 6,
    "5": 5,
    "4": 4,
    "3": 3,
    "2": 2,
    "1": 1,
    "0": 0
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
const { connectDB, getUsersCollection } = require("./database.js");
connectDB();
let drawIndex = 0;
let drawCards = [];
let drawIDs = [];
console.log("defined ranks");
function indexOfMax(position, arr) {
    if (arr.length === 0) {
        return -1;
    }
    console.log("testing lead");
    var max = 0;
    var maxIndex = 0;
    var spot = position - 1;
    for (var i = 0; i < arr.length; i++) {
        console.log("current max: ", max);
        console.log("checking bid: ", arr[spot]);
        if (bidRanks[arr[spot]] > max) {
            maxIndex = spot;
            max = bidRanks[arr[spot]];
            console.log("maxIndex: ", maxIndex);
            console.log("max: ", max);
        }
        spot = spot + 1;
        if(spot === 4){
            spot = 0;
        }
    }

    return maxIndex;
}
require("dotenv").config();
const bcrypt = require("bcryptjs");
const User = require("./database"); // ✅ Import User model
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const helmet = require("helmet");
const cors = require("cors");
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",  // Allows any client to connect
        methods: ["GET", "POST"]
    }
});
console.log("update check2");
app.use((req, res, next) => {
    console.log("✅ CSP Middleware running for:", req.url);
    res.setHeader("Content-Security-Policy",
        "default-src 'self' http://localhost:3000; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdn.socket.io; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' ws://localhost:3000 ws://127.0.0.1:3000 wss://localhost:3000;"
    );
    console.log("Headers being sent:", res.getHeaders());
    next();
});
app.use(helmet({
    contentSecurityPolicy: false // Disabling Helmet's CSP to prevent conflicts
}));
//app.use(express.static("client"));
// ✅ Define a simple route to check if the server is working
app.get("/", (req, res) => {
    res.send("Server is running!");
});
let positions = [];
let players = [];
let playedCards = [];
let playedCardsIndex = 0;
let playerBids = [];
let numBids = 0;
let team1OldScore, team2OldScore = [];
let gameState = { 
    deck: [], 
    hands: {},
    currentTurn: 1,
    bidding: 1,
    dealer: 1,
    bidder: 2,
    currentHand: 4,
    trump: {}, 
    isTrumpBroken: false,
    bids: {
        team1: 0,
        team2: 0    
    },
    tricks: {
        team1: 0,
        team2: 0
    },
    score : {
        team1: 0,
        team2: 0
    },
    rainbows : {
        team1: 0,
        team2: 0
    },
    cardIndex : 0,
    team1Mult : 1,
    team2Mult : 1,
    start: false
};
let trumpCard = [];
function drawOrder(myCard,cards){
    let suits = {
        "clubs": 0,
        "diamonds": 1,
        "hearts": 2,
        "spades": 3,
        "joker": 4
    };
    let rank = 0;
    console.log(cards);
    for(let card of cards){
        console.log("comparing " + card.rank + " of " + card.suit + "to" + myCard.rank + "of" + myCard.suit);
        if(ranks[myCard.rank] > ranks[card.rank]){
            rank ++;
        }
        if(ranks[myCard.rank] === ranks[card.rank] && suits[myCard.suit] > suits[card.suit]){
            rank ++;
        }
    }
    if(4 - rank === 2){
        return 3;
    }else if(4 - rank === 3){
        return 2;
    }else{
        return 4 - rank;
    }
}
function cleanupNextHand(dealer, hand){
    gameState.deck = [];
    gameState.hands = {};
    gameState.currentTurn = 1;
    gameState.bidding = 1;
    gameState.dealer = dealer;
    gameState.bidder = rotate(gameState.dealer);
    gameState.currentHand = hand;
    gameState.trump = {};
    gameState.isTrumpBroken = false;
    gameState.bids = {
        team1: 0,
        team2: 0
    }; 
    gameState.team1Mult = 1;
    gameState.team2Mult = 1;
    gameState.tricks = {
        team1: 0,
        team2: 0
    };
    gameState.rainbows = {
        team1: 0,
        team2: 0
    }
    gameState.deck = initializeDeck();
    for (let i = 0; i < players.length; i++) {
        gameState.hands[players[i]] = gameState.deck.splice(0, gameState.currentHand);
    }
    trumpCard = gameState.deck.shift()
    gameState.trump = trumpCard;
    for(let i = 0; i < players.length; i++){
        if((isRainbow(gameState.hands[players[i]])) && gameState.hands[players[i]].length === 4){
            console.log("player ", players[i], " has a rainbow!");
            if(positions[i] === 1 || positions[i] === 3){
                gameState.rainbows.team1 += 1;
            }
            else if(positions[i] === 2 || positions[i] === 4){
                gameState.rainbows.team2 += 1;
            }
        }
    }
    players.forEach((player) => {
        let socketId = player;
        let socket = io.sockets.sockets.get(socketId);
        if(socket){
            socket.emit("gameStart", { players, hand: gameState.hands[player], trump: gameState.trump, score1: gameState.score.team1, score2: gameState.score.team2, dealer: gameState.dealer });
        }
    });
    console.log("hand started", gameState.hands);
    gameState.currentTurn = gameState.bidder;
    gameState.start = true;
    io.emit("updateTurn", { currentTurn: gameState.currentTurn });
    console.log("emitted update turn on a cleanup/handstart");

}
function abortClean(){
    gameState.deck = [];
    gameState.hands = {};
    gameState.currentTurn = 1;
    gameState.bidding = 1;
    gameState.dealer = 1;
    gameState.bidder = rotate(gameState.dealer);
    gameState.currentHand = 12;
    gameState.trump = {};
    gameState.isTrumpBroken = false;
    gameState.bids = {
        team1: 0,
        team2: 0
    }; 
    gameState.tricks = {
        team1: 0,
        team2: 0
    };
    gameState.rainbows = {
        team1: 0,
        team2: 0
    }
    gameState.score = {
        team1: 0,
        team2: 0
    }
    playerBids = [];
    numBids = 0;
    gameState.start = false;
}
function initializeDeck() {
    const suits = ["spades", "hearts", "diamonds", "clubs"];
    const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    const jokerSuits = ["joker"];
    const jokerRanks = ["HI", "LO"];
    let deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({ suit, rank });
        }
    }
    for (let suit of jokerSuits) {
        for (let rank of jokerRanks) {
            deck.push({ suit, rank });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
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
function isRainbow(hand){
    let flags = {
        spades: false,
        hearts: false,
        diamonds: false,
        clubs: false
    }
    for(let card of hand){
        if(card.suit === "spades"){
            flags.spades = true;
        }
        else if(card.suit === "hearts"){
            flags.hearts = true;
        }
        else if(card.suit === "diamonds"){
            flags.diamonds = true;
        }
        else if(card.suit === "clubs"){
            flags.clubs = true;
        }
        else if(card.suit === "joker"){
            if(gameState.trump.suit === "spades"){
                flags.spades = true;
            }
            else if(gameState.trump.suit === "hearts"){
                flags.hearts = true;
            }
            else if(gameState.trump.suit === "diamonds"){
                flags.diamonds = true;
            }
            else if(gameState.trump.suit === "clubs"){
                flags.clubs = true;
            }
        }
    }
    if(flags.spades && flags.hearts && flags.diamonds && flags.clubs){
        return true;
    }
    else{
        return false;
    }
}
function sameSuit(card1, card2){
    if(card1.suit === card2.suit){
        return true;
    }
    else if((card1.suit === "joker" && card2.suit === gameState.trump.suit) || (card2.suit === "joker" && card1.suit === gameState.trump.suit)){
        return true;
    }
    else{
        return false;
    }
}
function highestTrump(rank, hand){
    for(let card of hand){
        if((sameSuit(card,gameState.trump)) && (ranks[card.rank] > ranks[rank])){
            console.log(card.rank," is greater than ", rank);
            return false;
        }
        else{
            console.log(card.rank," is less than ", rank)
        }
    }
    return true;
}

function isLegalMove(card, hand, lead, leadBool, playPosition, leadPosition){
    //console.log("card.suit: ", card.suit);
    //console.log("lead.suit: ", lead);
    //console.log("leadBool: ", leadBool);
    //console.log("isVoid: ", isVoid(hand, lead.suit));
    console.log("playPosition: " + playPosition);
    console.log("leadPosition: " + leadPosition);
    if (sameSuit(card,gameState.trump) && !gameState.isTrumpBroken && leadBool){
        console.log("trump not broken");
        return false;
    }
    else if (!sameSuit(card,lead) && !isVoid(hand, lead.suit)){
        console.log("not void of lead suit.");
        return false;
    }
    else if (lead.rank === "HI" && !highestTrump(card.rank,hand) && (leadPosition % 2 !== playPosition % 2)){
        console.log("Hi lead. Highest trump only.")
        return false;
    }
    else{
        console.log("legal move.");
        return true;
    }

}
function isTrumpTight(hand, trump){
    for(let card of hand){
        if(!sameSuit(card,trump)){
            return false;
        }
    }
    return true;
}
function removeCard(hand, card) {
    hand.forEach((c) => {
        if (c.rank === card.rank && c.suit === card.suit) {
            hand.splice(hand.indexOf(c), 1);
        }
    });
    return hand;
}
function reOrderUsers(currentUsers, players) {
    let orderedUsers = [];
    for (let i = 0; i < players.length; i++) {
        let playerIndex = players.indexOf(currentUsers[i].socketId);
        orderedUsers[playerIndex] = currentUsers[i];
    }
    return orderedUsers;
}
function determineWinner(trick, lead, trump){
    let winner = lead;
    let tempIndex = 0;
    //console.log("lead: ", lead);
    //console.log("trump: ", trump);
    //console.log("trick: ", trick);
    for (let i = 1; i < 4; i++){
        tempIndex = i + lead;
        if (tempIndex > 4){
            tempIndex = tempIndex - 4;
        }
        if (sameSuit(trick[tempIndex - 1],trick[winner - 1]) && ranks[trick[tempIndex-1].rank] > ranks[trick[winner-1].rank]){
            winner = tempIndex;
            //console.log(trick[tempIndex - 1]);
            //console.log(trick[winner - 1]);
            //console.log("updating winner to ", winner);
        }
        if (sameSuit(trick[tempIndex - 1],trump) && !sameSuit(trick[winner - 1],trump)){
            winner = tempIndex;
            //console.log("updating winner to ", winner);
        }
        if (sameSuit(trick[tempIndex - 1],trump) && sameSuit(trick[winner - 1],trump) && ranks[trick[tempIndex-1].rank] > ranks[trick[winner-1].rank]){
            winner = tempIndex;
            //console.log("updating winner to ", winner);
        }
    }
    if (winner ===1 || winner === 3){
        console.log("team 1 wins this trick via player ", winner);
        gameState.tricks.team1 += 1;
    }
    if (winner === 2 || winner === 4){
        console.log("team 2 wins this trick via player" , winner);
        gameState.tricks.team2 += 1;
    }
    return winner;
}
let leadCard = [];
let leadPosition = 1;
let currentUsers = [];
io.on("connection", (socket) => {
    console.log(`Player connected: ${socket.id}`);
        // ✅ Handle player sign-in
        socket.on("signIn", async (data) => {
            let usersCollection = getUsersCollection();
            let { username, password } = data;
        
            try {
                let user = await usersCollection.findOne({ username });
        
                if (!user) {
                    socket.emit("signInResponse", { success: false, message: "Invalid username or password!" });
                    console.log(`❌ Sign-in failed: User ${username} not found.`);
                    return;
                }
        
                // ✅ Verify the password
                let passwordMatch = await bcrypt.compare(password, user.password);
                if (!passwordMatch) {
                    socket.emit("signInResponse", { success: false, message: "Invalid username or password!" });
                    console.log(`❌ Sign-in failed: Incorrect password for ${username}`);
                    return;
                }
        
                // ✅ If user is already logged in, disconnect the old session
                if (user.socketId) {
                    let oldSocket = io.sockets.sockets.get(user.socketId);
                    if (oldSocket) {
                        oldSocket.emit("forceLogout"); // ✅ Notify the old session
                        oldSocket.disconnect();
                        console.log(`🔄 ${username} was logged out from another device.`);
                    }
                }
        
                // ✅ Update MongoDB with the new socket ID
                await usersCollection.updateOne({ username }, { $set: { socketId: socket.id } });
        
                // ✅ Send sign-in success response
                socket.emit("signInResponse", { success: true, username });
                console.log(`✅ ${username} signed in successfully.`);
                currentUsers = currentUsers.filter((user) => user.username !== username);
                currentUsers.push({username, socketId: socket.id });
                console.log("current users: ", currentUsers);
            } catch (error) {
                console.error("❌ Database error:", error);
                socket.emit("signInResponse", { success: false, message: "Database error. Try again." });
            }
        });
    
    // ✅ Handle user registration (sign-up)
    socket.on("signUp", async (data) => {
        let usersCollection = getUsersCollection(); // ✅ Retrieve users collection
        if (!usersCollection) {
            socket.emit("signUpResponse", { success: false, message: "Database not ready. Try again." });
            return console.error("❌ Database error: usersCollection is undefined.");
        }
    
        let { username, password } = data;
    
        try {
            let existingUser = await usersCollection.findOne({ username });
    
            if (existingUser) {
                socket.emit("signUpResponse", { success: false, message: "Username already taken!" });
                return console.log(`❌ Sign-up failed: Username "${username}" is already in use.`);
            }
    
            let hashedPassword = await bcrypt.hash(password, 10);
            await usersCollection.insertOne({ username, password: hashedPassword });
    
            socket.emit("signUpResponse", { success: true });
            console.log(`✅ New user registered: ${username}`);
        } catch (error) {
            console.error("❌ Database error:", error);
            socket.emit("signUpResponse", { success: false, message: "Database error. Try again." });
        }
    });
    socket.on("joinQueue", () =>{
        if (players.length < 4) {
            players.push(socket.id);
            console.log(players.length);
            if (players.length === 4) {
                console.log("Game is starting...");
                sleepSync(3500);
                io.emit("startDraw", {start : true});
                gameState.deck = initializeDeck();
            }
        } else {
            socket.emit("roomFull");
        }
    });
    socket.on("draw", (data)=> {
        let order = data.num;
        let pics = [];
        let picInt = 0;
        for(i = 0; i < 4; i++){
            do{
                picInt = Math.floor(Math.random() * 83) + 1;
            }while(pics.includes(picInt));
            pics.push(picInt);
        }
        if (order > gameState.deck.length -1){
            order = gameState.deck.length -1;
        }
        drawCards.push(gameState.deck[order]);
        drawIDs.push(socket.id);
        console.log("socket " + socket.id + "pulled the " + gameState.deck[order].rank + " of " + gameState.deck[order].suit);
        socket.emit("youDrew", {card: gameState.deck[order]});
        console.log(drawCards);
        gameState.deck.splice(order,1);
        drawIndex ++;
        if (drawIndex === 4){
            let i = 0;
            for(let player of drawIDs){
                io.to(player).emit("playerAssigned", {playerId: player, position: drawOrder(drawCards[i], drawCards) });
                console.log("assigned player with socket ", player, " to position ", drawOrder(drawCards[i], drawCards));
                positions[players.indexOf(player)] = drawOrder(drawCards[i], drawCards);
                i++;
            }
            currentUsers = reOrderUsers(currentUsers, players);
            console.log("current users after reordering: ", currentUsers);
            console.log("positions: ", positions);
            console.log("sockets: ", players);
            sleepSync(1000);
            io.emit("positionUpdate", {positions: positions, sockets: players, usernames: currentUsers, pics: pics});
            i = 0;
            sleepSync(2000);
            gameState.deck = initializeDeck();
            for (let i = 0; i < players.length; i++) {
                gameState.hands[players[i]] = gameState.deck.splice(0, gameState.currentHand);
                
            }
            trumpCard = gameState.deck.shift()
            gameState.trump = trumpCard;
            for (let i = 0; i < players.length; i++){
                if((isRainbow(gameState.hands[players[i]])) && gameState.hands[players[i]].length === 4){
                    console.log("player ", players[i], " has a rainbow!");
                    io.emit("rainbow", {position: positions[i]});
                    if(positions[i] === 1 || positions[i] === 3){
                        gameState.rainbows.team1 += 1;
                    }
                    else if(positions[i] === 2 || positions[i] === 4){
                        gameState.rainbows.team2 += 1;
                    }
                }
            }
            drawCards = [];
            drawIndex = 0;
            drawIDs = [];
            io.emit("createUI");
            sleepSync(1000);
            players.forEach((player) => {
                let socketId = player;
                let socket = io.sockets.sockets.get(socketId);
                if(socket){
                    socket.emit("gameStart", { players, hand: gameState.hands[player], trump: gameState.trump, score1: gameState.score.team1, score2: gameState.score.team2, dealer: gameState.dealer });
                }
            });
            console.log("Game started", gameState.hands);
            gameState.start = true;
            gameState.currentTurn = rotate(gameState.dealer);
            io.emit("updateTurn", { currentTurn: gameState.currentTurn });
            console.log("emitted update turn on game start");
        }
    });
    socket.on("playCard", (data) => {
        console.log("bidding: ", gameState.bidding);
        if (data.position !== gameState.currentTurn || gameState.bidding === 1){
            console.log(`❌ Player ${socket.id} tried to play out of turn!`);
            return;
        }
        if (gameState.hands[socket.id]) {
            gameState.hands[socket.id] = gameState.hands[socket.id].filter(
                (card) => !(card.rank === data.card.rank && card.suit === data.card.suit)
            );
            if (playedCards.length === 0 && !isLegalMove(data.card, gameState.hands[socket.id], data.card, true, data.position, data.position) && !isTrumpTight(gameState.hands[socket.id], gameState.trump)){
                console.log("❌ Player ", data.position, " tried to lead an illegal card!");
                return;
            }
            console.log("PlayedCardIndex: ", playedCardsIndex);
            if (playedCardsIndex === 0){
                leadCard = data.card;
                leadPosition = data.position;
                console.log("leadCard: ", leadCard);    
                leadPosition = data.position;
            }
            if (playedCards.length > 0 && !isLegalMove(data.card, gameState.hands[socket.id], leadCard, false, data.position, leadPosition)){
                console.log("❌ Player ", data.position, " tried to play an illegal card!");
                return;
            }
            playedCards[data.position - 1] = data.card;
            console.log("leadCard: ", leadCard);
            if(data.card.suit === gameState.trump.suit){
                gameState.isTrumpBroken = true;
            }
            //console.log("trying to send trump boolean ", gameState.isTrumpBroken);
            io.emit("cardPlayed", { playerId: socket.id, card: data.card, position: data.position, trump: gameState.isTrumpBroken});
            gameState.hands[socket.id] = removeCard(gameState.hands[socket.id], data.card);
            playedCardsIndex += 1;
            gameState.cardIndex += 1;
        }
        gameState.currentTurn += 1;
        if(gameState.currentTurn === 5){
            gameState.currentTurn = 1;
        }
        console.log("playedCards: ", playedCards);
        console.log("length: ", playedCards.length);
        if (playedCardsIndex === 4) {
            console.log("updating turn to: ", gameState.currentTurn);
            sleepSync(2000);
            if(gameState.bidding === 0){
                gameState.currentTurn = determineWinner(playedCards, leadPosition, gameState.trump);
                io.emit("trickComplete", {winner: gameState.currentTurn});
                console.log("fired trick complete")
                playedCards = [];
                playedCardsIndex = 0;
                console.log("played cards: ", gameState.cardIndex);
                if (gameState.cardIndex === gameState.currentHand*4){
                    sleepSync(4000);
                    console.log("hand complete.");
                    team1OldScore = gameState.score.team1;
                    team2OldScore = gameState.score.team2;
                    if(gameState.tricks.team1 >= gameState.bids.team1){
                        gameState.score.team1 += gameState.bids.team1*10*gameState.team1Mult + gameState.tricks.team1*1 - gameState.bids.team1*1 + gameState.rainbows.team1*10;
                    }
                    if(gameState.tricks.team1 < gameState.bids.team1){
                        gameState.score.team1 -= gameState.bids.team1*10*gameState.team1Mult + gameState.rainbows.team1*10;
                    }
                    if(gameState.tricks.team2 >= gameState.bids.team2){
                        gameState.score.team2 += gameState.bids.team2*10*gameState.team2Mult + gameState.tricks.team2*1 - gameState.bids.team2*1 + gameState.rainbows.team2*10;
                    }
                    if(gameState.tricks.team2 < gameState.bids.team2){
                        gameState.score.team2 -= gameState.bids.team2*10*gameState.team2Mult + gameState.rainbows.team2*10;
                    }
                    console.log("team 1 score: ", gameState.score.team1, " bidding ", playerBids[0], " and ", playerBids[2], " and getting ", gameState.tricks.team1);
                    console.log("team 2 score: ", gameState.score.team2, " bidding ", playerBids[1], " and ", playerBids[3], " and getting ", gameState.tricks.team2);
                    io.emit("handComplete", { score: gameState.score, team1Tricks: gameState.tricks.team1, team2Tricks: gameState.tricks.team2, team1OldScore: team1OldScore, team2OldScore: team2OldScore});
                    playerBids = [];
                    gameState.cardIndex = 0;
                    if(gameState.currentHand === 2){
                        cleanupNextHand(rotate(gameState.dealer), 1);
                    }
                    else if(gameState.currentHand % 2 === 0){
                        console.log("starting next hand with dealer ", rotate(gameState.dealer), " and hand ", gameState.currentHand - 2);
                        cleanupNextHand(rotate(gameState.dealer), gameState.currentHand - 2);
                    }
                    else if(gameState.currentHand === 13){
                        console.log("firing gameEnd");
                        io.emit("gameEnd", {score:gameState.score});
                        players = [];
                        gameState.bidding = 1;
                        gameState.start = false;
                        gameState.score.team1 = 0;
                        gameState.score.team2 = 0;

                    }
                    else{
                        cleanupNextHand(rotate(gameState.dealer), gameState.currentHand + 2);
                    }
                }
            }
        }
        io.emit("updateTurn", { currentTurn: gameState.currentTurn });
        console.log("emitted update turn on a playCard");
    });
    socket.on("playerBid", (data) => {
        console.log("server thinks its ", gameState.currentTurn, " turn");
        if(gameState.bidding === 1 && data.position === gameState.currentTurn){
            playerBids[gameState.currentTurn - 1] = data.bid.toUpperCase();
            numBids = numBids + 1;   
            console.log("position ", data.position, " bid ", data.bid);
            io.emit("bidReceived", { bid: data.bid, position: data.position, bidArray: playerBids });
            gameState.currentTurn += 1;
            if(gameState.currentTurn === 5){
                gameState.currentTurn = 1;  
            }
            console.log("bid array is ", playerBids);
            if(numBids === 4){
                gameState.bidding = 0;
                gameState.bids.team1 = bidRanks[playerBids[0]]*1 + bidRanks[playerBids[2]]*1;
                if(gameState.bids.team1 > gameState.currentHand){
                    gameState.bids.team1 = gameState.currentHand;
                    if(playerBids[0] === "B" || playerBids[2] === "B"){
                        gameState.team1Mult = 2;
                    }
                    if(playerBids[0] === "2B" || playerBids[2] === "2B"){
                        gameState.team1Mult = 4;
                    }
                    if(playerBids[0] === "3B" || playerBids[2] === "3B"){
                        gameState.team1Mult = 8;
                    }
                    if(playerBids[0] === "4B" || playerBids[2] === "4B"){
                        gameState.team1Mult = 16;
                    }
                }
                gameState.bids.team2 = bidRanks[playerBids[1]]*1 + bidRanks[playerBids[3]]*1;
                if(gameState.bids.team2 > gameState.currentHand){
                    gameState.bids.team2 = gameState.currentHand;
                    if(playerBids[1] === "B" || playerBids[3] === "B"){
                        gameState.team2Mult = 2;
                    }
                    if(playerBids[1] === "2B" || playerBids[3] === "2B"){
                        gameState.team2Mult = 4;
                    }
                    if(playerBids[1] === "3B" || playerBids[3] === "3B"){
                        gameState.team2Mult = 8;
                    }
                    if(playerBids[1] === "4B" || playerBids[3] === "4B"){
                        gameState.team2Mult = 16;
                    }
                }
                console.log("team 1 bid: ", gameState.bids.team1);
                console.log("team 2 bid: ", gameState.bids.team2);
                io.emit("doneBidding", { bids: playerBids, lead: indexOfMax(gameState.bidder, playerBids) + 1 });
                if(gameState.bids.team1 === 0 && gameState.bids.team2 === 0){
                    console.log("zero bids, redeal!");
                    playerBids = [];
                    numBids = 0;
                    io.emit("destroyHands");
                    cleanupNextHand(gameState.dealer, gameState.currentHand);
                    return;
                }
                console.log("position ", indexOfMax(gameState.bidder, playerBids) + 1, " leads");
                gameState.currentTurn = indexOfMax(gameState.bidder, playerBids) + 1;
                numBids = 0;
            }
            io.emit("updateTurn", { currentTurn: gameState.currentTurn });
            console.log("emitted update turn after a bid");
            console.log("current turn: ", gameState.currentTurn);
            
        }else{
            console.log("❌ Player ", data.position, " tried to bid out of turn!");
            return;
        }
    })
    socket.on("chatMessage", (data) => {
        console.log(`Chat message from ${socket.id}: ${data.message}`);
        // Emit the chat message to all players
        io.emit("chatMessage", { position: positions[players.indexOf(socket.id)], message: data.message });
    });
    socket.on("disconnect", () => {
        players = players.filter((player) => player !== socket.id);
        currentUsers = currentUsers.filter((user) => user.socketId !== socket.id);
        console.log(`Player disconnected: ${socket.id}`);
        console.log(gameState.start);
        if (gameState.start){
            console.log("aborting mid-game...");
            io.emit("abortGame");
            abortClean();
        }
    });
});

server.listen(3000, () => console.log("Server running on port 3000"));