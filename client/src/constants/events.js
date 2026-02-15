/**
 * Socket event name constants for client-server communication.
 *
 * Using constants prevents typos and enables IDE autocomplete.
 */

// Client -> Server Events
export const CLIENT_EVENTS = {
  // Auth
  SIGN_IN: 'signIn',
  SIGN_UP: 'signUp',

  // Main Room
  JOIN_MAIN_ROOM: 'joinMainRoom',
  MAIN_ROOM_CHAT: 'mainRoomChat',

  // Lobby
  CREATE_LOBBY: 'createLobby',
  JOIN_LOBBY: 'joinLobby',
  LEAVE_LOBBY: 'leaveLobby',
  LOBBY_CHAT: 'lobbyChat',
  PLAYER_READY: 'playerReady',
  PLAYER_UNREADY: 'playerUnready',

  // Game
  DRAW: 'draw',
  PLAYER_BID: 'playerBid',
  PLAY_CARD: 'playCard',
  CHAT_MESSAGE: 'chatMessage',
  REJOIN_GAME: 'rejoinGame',
  FORCE_RESIGN: 'forceResign',
  JOIN_AS_SPECTATOR: 'joinAsSpectator',

  // Profile
  GET_PROFILE: 'getProfile',
  UPDATE_PROFILE_PIC: 'updateProfilePic',

  // Leaderboard
  GET_LEADERBOARD: 'getLeaderboard',
};

// Server -> Client Events
export const SERVER_EVENTS = {
  // Auth
  SIGN_IN_RESPONSE: 'signInResponse',
  SIGN_UP_RESPONSE: 'signUpResponse',
  FORCE_LOGOUT: 'forceLogout',
  ACTIVE_GAME_FOUND: 'activeGameFound',

  // Main Room
  MAIN_ROOM_JOINED: 'mainRoomJoined',
  MAIN_ROOM_MESSAGE: 'mainRoomMessage',
  MAIN_ROOM_PLAYER_JOINED: 'mainRoomPlayerJoined',
  LOBBIES_UPDATED: 'lobbiesUpdated',

  // Lobby
  LOBBY_CREATED: 'lobbyCreated',
  LOBBY_JOINED: 'lobbyJoined',
  LOBBY_MESSAGE: 'lobbyMessage',
  LOBBY_PLAYER_JOINED: 'lobbyPlayerJoined',
  LOBBY_PLAYER_LEFT: 'lobbyPlayerLeft',
  LEFT_LOBBY: 'leftLobby',
  PLAYER_READY_UPDATE: 'playerReadyUpdate',
  ALL_PLAYERS_READY: 'allPlayersReady',

  // Draw Phase
  START_DRAW: 'startDraw',
  YOU_DREW: 'youDrew',
  PLAYER_DREW: 'playerDrew',
  TEAMS_ANNOUNCED: 'teamsAnnounced',

  // Game
  POSITION_UPDATE: 'positionUpdate',
  CREATE_UI: 'createUI',
  GAME_START: 'gameStart',
  BID_RECEIVED: 'bidReceived',
  DONE_BIDDING: 'doneBidding',
  UPDATE_TURN: 'updateTurn',
  CARD_PLAYED: 'cardPlayed',
  TRICK_COMPLETE: 'trickComplete',
  HAND_COMPLETE: 'handComplete',
  GAME_END: 'gameEnd',
  RAINBOW: 'rainbow',
  DESTROY_HANDS: 'destroyHands',

  // Chat
  CHAT_MESSAGE: 'chatMessage',

  // Reconnection
  REJOIN_SUCCESS: 'rejoinSuccess',
  REJOIN_FAILED: 'rejoinFailed',
  PLAYER_DISCONNECTED: 'playerDisconnected',
  PLAYER_RECONNECTED: 'playerReconnected',
  PLAYER_ASSIGNED: 'playerAssigned',
  ABORT_GAME: 'abortGame',
  ROOM_FULL: 'roomFull',

  // Resignation & Lazy Mode
  RESIGNATION_AVAILABLE: 'resignationAvailable',
  PLAYER_RESIGNED: 'playerResigned',
  PLAYER_LAZY_MODE: 'playerLazyMode',
  PLAYER_ACTIVE_MODE: 'playerActiveMode',
  GAME_LOG_ENTRY: 'gameLogEntry',
  LEFT_GAME: 'leftGame',
  RESTORE_PLAYER_STATE: 'restorePlayerState',
  SPECTATOR_JOINED: 'spectatorJoined',

  // Connection
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  RECONNECT_ATTEMPT: 'reconnect_attempt',
  RECONNECT_FAILED: 'reconnect_failed',
  ERROR: 'error',

  // Profile
  PROFILE_RESPONSE: 'profileResponse',
  PROFILE_PIC_UPDATE_RESPONSE: 'profilePicUpdateResponse',

  // Leaderboard
  LEADERBOARD_RESPONSE: 'leaderboardResponse',
};
