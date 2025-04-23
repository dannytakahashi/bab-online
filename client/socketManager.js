const socket = io(
    location.hostname === "localhost"
      ? "http://localhost:3000"
      : "https://bab-online-production.up.railway.app",
       { transports: ["websocket"] }
);
socket.on("connect", () => {
    console.log("Connected to server");
});

socket.on("playerAssigned", (data) => {
    console.log("📡 (socketManager) Received playerAssigned:", data);
    console.log(`You are player ${data.position}`);

    // ✅ Forward the event to game.js
    setTimeout(() => {
        document.dispatchEvent(new CustomEvent("playerAssigned", { detail: data }));
    }, 0);
});

socket.on("gameStart", (data) => {
    console.log("Game Started", data);
});

socket.on("cardPlayed", (data) => {
    console.log(`Player ${data.playerId} played ${data.card.rank} of ${data.card.suit}`);
});