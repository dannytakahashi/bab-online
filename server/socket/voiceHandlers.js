/**
 * Voice chat signaling relay handlers.
 * Forwards WebRTC signaling messages (SDP offers/answers, ICE candidates)
 * between peers. No audio touches the server.
 */

const { socketLogger } = require('../utils/logger');
const gameManager = require('../game/GameManager');

function voiceOffer(socket, io, data) {
    const { targetSocketId, offer } = data;
    if (!targetSocketId || !offer) return;

    // Look up username server-side — don't trust client payload
    const user = gameManager.getUserBySocketId(socket.id);

    io.to(targetSocketId).emit('voiceOffer', {
        fromSocketId: socket.id,
        offer,
        username: user?.username
    });
}

function voiceAnswer(socket, io, data) {
    const { targetSocketId, answer } = data;
    if (!targetSocketId || !answer) return;

    io.to(targetSocketId).emit('voiceAnswer', {
        fromSocketId: socket.id,
        answer
    });
}

function voiceIceCandidate(socket, io, data) {
    const { targetSocketId, candidate } = data;
    if (!targetSocketId || !candidate) return;

    io.to(targetSocketId).emit('voiceIceCandidate', {
        fromSocketId: socket.id,
        candidate
    });
}

function voiceRelayAudio(socket, io, data) {
    const { targetSocketId, audio } = data;
    if (!targetSocketId || !audio) return;

    io.to(targetSocketId).emit('voiceRelayAudio', {
        fromSocketId: socket.id,
        audio
    });
}

module.exports = {
    voiceOffer,
    voiceAnswer,
    voiceIceCandidate,
    voiceRelayAudio
};
