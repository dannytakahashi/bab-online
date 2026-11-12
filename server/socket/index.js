/**
 * Socket.IO setup and event routing
 * All handlers are wrapped with validation and error handling
 */

const authHandlers = require('./authHandlers');
const queueHandlers = require('./queueHandlers');
const lobbyHandlers = require('./lobbyHandlers');
const mainRoomHandlers = require('./mainRoomHandlers');
const gameHandlers = require('./gameHandlers');
const chatHandlers = require('./chatHandlers');
const reconnectHandlers = require('./reconnectHandlers');
const profileHandlers = require('./profileHandlers');
const tournamentHandlers = require('./tournamentHandlers');
const voiceHandlers = require('./voiceHandlers');
const safetyHandlers = require('./safetyHandlers');
const snapshotHandlers = require('./snapshotHandlers');
const adminHandlers = require('./adminHandlers');
const clientInfo = require('./clientInfo');
const sessionIdentity = require('./sessionIdentity');
const upgradeGate = require('./upgradeGate');
const { asyncHandler, syncHandler, safeHandler, rateLimiter } = require('./errorHandler');
const { socketLogger } = require('../utils/logger');
const { getClientIp } = require('../utils/clientIp');

function setupSocketHandlers(io) {
    io.on('connection', (socket) => {
        socketLogger.debug('Player connected', { socketId: socket.id });

        // Client IP for the failed-sign-in throttle, from the handshake
        // (Railway edge: X-Real-IP behind a proxy peer; see utils/clientIp)
        if (socket.data) socket.data.clientIp = getClientIp(socket);

        // The old App Store iOS build (1.0.0 build 1, positively identified
        // by its handshake User-Agent) gets only the update message and no
        // handler at all: nothing below is registered for it (upgradeGate.js;
        // kill switch UPGRADE_GATE=off). Also records socket.data.appBuild
        if (upgradeGate.gate(socket)) return;

        // A connection a newer one of the same session replaced (another
        // tab): its events are refused with sessionSuperseded until it
        // takes the session back (sessionIdentity.supersededGate)
        socket.use?.(sessionIdentity.supersededGate(socket)); // (stub sockets in tests have no use)

        // Client capabilities (avatarUrl): socket.data.client, no reply.
        // Rate limited inside the handler (silently dropped over the limit)
        socket.on('clientHello', (data) =>
            syncHandler('clientHello', clientInfo.handle, { rateLimit: false, event: 'clientHello' })(socket, io, data)
        );

        // Auth events - with validation
        socket.on('signIn', (data) =>
            asyncHandler('signIn', authHandlers.signIn)(socket, io, data)
        );
        socket.on('signUp', (data) =>
            asyncHandler('signUp', authHandlers.signUp)(socket, io, data)
        );
        socket.on('restoreSession', (data) =>
            asyncHandler('restoreSession', authHandlers.restoreSession)(socket, io, data)
        );
        socket.on('deleteAccount', (data) =>
            asyncHandler('deleteAccount', authHandlers.deleteAccount)(socket, io, data)
        );

        // Main room events
        socket.on('joinMainRoom', () =>
            safeHandler(mainRoomHandlers.joinMainRoom)(socket, io, {})
        );
        socket.on('mainRoomChat', (data) =>
            syncHandler('chatMessage', mainRoomHandlers.mainRoomChat, { event: 'mainRoomChat' })(socket, io, data)
        );
        socket.on('createLobby', (data) =>
            asyncHandler('createLobby', mainRoomHandlers.createLobby)(socket, io, data || {})
        );
        socket.on('joinLobby', (data) =>
            syncHandler('joinLobby', mainRoomHandlers.joinLobby)(socket, io, data)
        );
        socket.on('joinAsSpectator', (data) =>
            asyncHandler('joinAsSpectator', mainRoomHandlers.joinAsSpectator)(socket, io, data)
        );

        // Lobby events
        socket.on('playerReady', () =>
            safeHandler(lobbyHandlers.playerReady)(socket, io, {})
        );
        socket.on('playerUnready', () =>
            safeHandler(lobbyHandlers.playerUnready)(socket, io, {})
        );
        socket.on('lobbyChat', (data) =>
            syncHandler('chatMessage', lobbyHandlers.lobbyChat, { event: 'lobbyChat' })(socket, io, data)
        );
        socket.on('leaveLobby', () =>
            safeHandler(lobbyHandlers.leaveLobby)(socket, io, {})
        );
        socket.on('addBot', () =>
            safeHandler(lobbyHandlers.addBot)(socket, io, {})
        );
        socket.on('removeBot', (data) =>
            syncHandler('removeBot', lobbyHandlers.removeBot)(socket, io, data)
        );

        // Game events - with validation
        socket.on('draw', (data) =>
            asyncHandler('draw', gameHandlers.draw)(socket, io, data)
        );
        socket.on('playerBid', (data) =>
            asyncHandler('playerBid', gameHandlers.playerBid)(socket, io, data)
        );
        socket.on('playCard', (data) =>
            asyncHandler('playCard', gameHandlers.playCard)(socket, io, data)
        );
        socket.on('forceResign', (data) =>
            asyncHandler('forceResign', gameHandlers.forceResign)(socket, io, data)
        );

        // Chat events - with validation
        socket.on('chatMessage', (data) =>
            syncHandler('chatMessage', chatHandlers.chatMessage)(socket, io, data)
        );

        // Reconnection events
        socket.on('rejoinGame', (data) =>
            asyncHandler('rejoinGame', reconnectHandlers.rejoinGame)(socket, io, data)
        );

        // Snapshot v2: the table as this socket sees it (reply: stateSnapshot)
        socket.on('requestSnapshot', (data) =>
            syncHandler('requestSnapshot', snapshotHandlers.requestSnapshot)(socket, io, data)
        );

        // Profile events
        socket.on('getProfile', () =>
            safeHandler(profileHandlers.getProfile)(socket, io, {})
        );
        socket.on('updateProfilePic', (data) =>
            asyncHandler('updateProfilePic', profileHandlers.updateProfilePic)(socket, io, data)
        );
        socket.on('uploadProfilePic', (data) =>
            asyncHandler('uploadProfilePic', profileHandlers.uploadProfilePic)(socket, io, data)
        );
        socket.on('getLeaderboard', () =>
            safeHandler(profileHandlers.getLeaderboard)(socket, io, {})
        );
        socket.on('getRecords', () =>
            safeHandler(profileHandlers.getRecords)(socket, io, {})
        );
        socket.on('searchPlayers', (data) =>
            asyncHandler('searchPlayers', profileHandlers.searchPlayers)(socket, io, data)
        );
        socket.on('getPlayerProfile', (data) =>
            asyncHandler('getPlayerProfile', profileHandlers.getPlayerProfile)(socket, io, data)
        );

        // Tournament events - rate limited via their schema names
        socket.on('createTournament', () =>
            asyncHandler('createTournament', tournamentHandlers.createTournament)(socket, io, {})
        );
        socket.on('joinTournament', (data) =>
            asyncHandler('joinTournament', tournamentHandlers.joinTournament)(socket, io, data)
        );
        socket.on('leaveTournament', () =>
            asyncHandler('leaveTournament', tournamentHandlers.leaveTournament)(socket, io, {})
        );
        socket.on('tournamentReady', () =>
            asyncHandler('tournamentReady', tournamentHandlers.tournamentReady)(socket, io, {})
        );
        socket.on('tournamentUnready', () =>
            asyncHandler('tournamentUnready', tournamentHandlers.tournamentUnready)(socket, io, {})
        );
        socket.on('beginTournament', () =>
            asyncHandler('beginTournament', tournamentHandlers.beginTournament)(socket, io, {})
        );
        socket.on('beginNextRound', () =>
            asyncHandler('beginNextRound', tournamentHandlers.beginNextRound)(socket, io, {})
        );
        socket.on('tournamentChat', (data) =>
            syncHandler('chatMessage', tournamentHandlers.tournamentChat, { event: 'tournamentChat' })(socket, io, data)
        );
        socket.on('spectateTournament', (data) =>
            asyncHandler('spectateTournament', tournamentHandlers.spectateTournament)(socket, io, data)
        );
        socket.on('spectateTournamentGame', (data) =>
            asyncHandler('spectateTournamentGame', tournamentHandlers.spectateTournamentGame)(socket, io, data)
        );
        socket.on('returnToTournament', () =>
            asyncHandler('returnToTournament', tournamentHandlers.returnToTournament)(socket, io, {})
        );
        socket.on('cancelTournament', () =>
            asyncHandler('cancelTournament', tournamentHandlers.cancelTournament)(socket, io, {})
        );

        // Safety / moderation events
        socket.on('reportUser', (data) =>
            asyncHandler('reportUser', safetyHandlers.reportUser)(socket, io, data)
        );
        socket.on('blockUser', (data) =>
            asyncHandler('blockUser', safetyHandlers.blockUser)(socket, io, data)
        );
        socket.on('unblockUser', (data) =>
            asyncHandler('unblockUser', safetyHandlers.unblockUser)(socket, io, data)
        );

        // Admin panel (web only): authorized per request against the
        // database (adminHandlers.authorizeAdmin)
        socket.on('adminRequest', (data) =>
            asyncHandler('adminRequest', adminHandlers.adminRequest)(socket, io, data)
        );

        // Voice chat signaling relay (Joi, rate limit and peer checks run
        // inside voiceHandlers: a refused signal is dropped silently)
        socket.on('voiceOffer', (data) =>
            safeHandler(voiceHandlers.voiceOffer)(socket, io, data)
        );
        socket.on('voiceAnswer', (data) =>
            safeHandler(voiceHandlers.voiceAnswer)(socket, io, data)
        );
        socket.on('voiceIceCandidate', (data) =>
            safeHandler(voiceHandlers.voiceIceCandidate)(socket, io, data)
        );
        // ICE servers (Cloudflare TURN credentials, else STUN) for voice peers
        socket.on('getVoiceIceServers', (data) =>
            asyncHandler('getVoiceIceServers', voiceHandlers.getVoiceIceServers)(socket, io, data)
        );

        // Disconnect - cleanup rate limiter and handle game state
        socket.on('disconnect', () => {
            try {
                // Clear rate limit data for this socket
                rateLimiter.clearSocket(socket.id);

                // Handle game/lobby disconnect (async: a rejection must not
                // become an unhandledRejection)
                queueHandlers.handleDisconnect(socket, io).catch(error =>
                    socketLogger.error('Error in disconnect handler', {
                        socketId: socket.id,
                        error: error.message,
                        stack: error.stack
                    })
                );
            } catch (error) {
                socketLogger.error('Error in disconnect handler', {
                    socketId: socket.id,
                    error: error.message,
                    stack: error.stack
                });
            }
        });
    });
}

module.exports = { setupSocketHandlers };
