/**
 * Voice chat signaling relay handlers.
 * Forwards WebRTC signaling messages (SDP offers/answers, ICE candidates)
 * between peers. No audio touches the server.
 */

const { socketLogger } = require('../utils/logger');

function voiceOffer(socket, io, data) {
    const { targetSocketId, offer } = data;
    if (!targetSocketId || !offer) return;

    io.to(targetSocketId).emit('voiceOffer', {
        fromSocketId: socket.id,
        offer
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

module.exports = {
    voiceOffer,
    voiceAnswer,
    voiceIceCandidate
};
