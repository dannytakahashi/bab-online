// LEGACY: only pages cached before the client was bundled still load this
// (with the CDN socket.io 4.0.1 global). The current page creates its socket
// in src/socket/createSocket.js, and main.js reuses a window.socket made
// here. Delete together with the /dist/main.js shim (vite.config.js).
var socket = io(location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://bab-online-production.up.railway.app', {
    transports: ['websocket'],
    reconnection: true,
    // Keep retrying (Socket.IO's default): once reconnect_failed fires the
    // client never reconnects again, so a long outage would strand the page
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});
window.socket = socket;
console.log('Socket created in socket-init.js');
