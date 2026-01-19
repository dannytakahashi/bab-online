// Socket initialization - must load before main.js module
// Creates global socket variable for modular code compatibility
var socket = io(location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://bab-online-production.up.railway.app', {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});
window.socket = socket;
console.log('Socket created in socket-init.js');
