/**
 * Socket.IO connection manager with reconnection support
 */

const socket = io(
    location.hostname === "localhost"
      ? "http://localhost:3000"
      : "https://bab-online-production.up.railway.app",
    {
        transports: ["websocket"],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    }
);

// Track game state for reconnection
let currentGameId = null;

/**
 * Store the current game ID (call when game starts)
 */
function setGameId(gameId) {
    currentGameId = gameId;
    sessionStorage.setItem('gameId', gameId);
    console.log('Game ID stored:', gameId);
}

/**
 * Clear the game ID (call when game ends)
 */
function clearGameId() {
    currentGameId = null;
    sessionStorage.removeItem('gameId');
    console.log('Game ID cleared');
}

/**
 * Get the stored game ID
 */
function getGameId() {
    if (!currentGameId) {
        currentGameId = sessionStorage.getItem('gameId');
    }
    return currentGameId;
}

/**
 * Get the stored username
 */
function getUsername() {
    return sessionStorage.getItem('username');
}

// Connection event handlers
socket.on("connect", () => {
    console.log("Connected to server:", socket.id);

    // Check if we were in a game and should try to rejoin
    const gameId = getGameId();
    const username = getUsername();

    if (gameId && username) {
        console.log(`Attempting to rejoin game ${gameId} as ${username}`);
        socket.emit('rejoinGame', { gameId, username });
    }
});

socket.on("disconnect", (reason) => {
    console.log("Disconnected from server:", reason);

    // Dispatch event for UI to show disconnected state
    document.dispatchEvent(new CustomEvent("connectionLost", { detail: { reason } }));
});

socket.on("reconnect_attempt", (attemptNumber) => {
    console.log(`Reconnection attempt ${attemptNumber}/5`);
    document.dispatchEvent(new CustomEvent("reconnecting", { detail: { attempt: attemptNumber } }));
});

socket.on("reconnect_failed", () => {
    console.log("Reconnection failed after all attempts");
    document.dispatchEvent(new CustomEvent("reconnectFailed"));
    clearGameId(); // Clear game since we can't reconnect
});

socket.on("error", (data) => {
    console.error("🚨 Server error:", data);
});

// Rejoin response handlers
socket.on("rejoinSuccess", (data) => {
    console.log("Rejoin successful:", data);
    document.dispatchEvent(new CustomEvent("rejoinSuccess", { detail: data }));
});

socket.on("rejoinFailed", (data) => {
    console.log("Rejoin failed:", data.reason);
    clearGameId(); // Clear invalid game ID
    document.dispatchEvent(new CustomEvent("rejoinFailed", { detail: data }));
});

// Player reconnected notification (for other players)
socket.on("playerReconnected", (data) => {
    console.log(`Player at position ${data.position} (${data.username}) reconnected`);
    document.dispatchEvent(new CustomEvent("playerReconnected", { detail: data }));
});

// Forward events to game.js
socket.on("playerAssigned", (data) => {
    console.log("📡 (socketManager) Received playerAssigned:", data);
    console.log(`You are player ${data.position}`);

    setTimeout(() => {
        document.dispatchEvent(new CustomEvent("playerAssigned", { detail: data }));
    }, 0);
});

socket.on("gameStart", (data) => {
    console.log("Game Started", data);
    // Store gameId when game starts (it's sent in the gameStart data)
    if (data.gameId) {
        setGameId(data.gameId);
    }
});

socket.on("cardPlayed", (data) => {
    console.log(`Player ${data.playerId} played ${data.card.rank} of ${data.card.suit}`);
});

socket.on("gameEnd", (data) => {
    console.log("Game ended:", data);
    clearGameId(); // Clear game ID when game ends
});

// Export functions for use by other modules
window.socketManager = {
    setGameId,
    clearGameId,
    getGameId,
    getUsername
};
