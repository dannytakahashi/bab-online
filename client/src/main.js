/**
 * Main entry point for the modular client.
 *
 * This stub will be expanded as modules are extracted from the monolithic
 * game.js and ui.js files.
 *
 * During the transition, we use a bridge pattern to expose new modules
 * to the existing code via window.ModernUtils.
 */

// Constants
import { CLIENT_EVENTS, SERVER_EVENTS } from './constants/events.js';
import { RANK_VALUES, RANK_ORDER, SUITS, JOKER_SUIT, HAND_PROGRESSION } from './constants/ranks.js';

// Utilities
import { team, rotate, isSameTeam, getTeamNumber, getPlayerName, getRelativePosition } from './utils/positions.js';
import { getCardImageKey, getSuitOrder, sortHand, cardsEqual, isJoker, getCardDisplayName } from './utils/cards.js';
import { hashToHue, generateDistinctColor, getUsernameColor, extractHue } from './utils/colors.js';

// Rules
import { sameSuit, isVoid, isTrumpTight, isHighestTrump, isLegalMove, wouldBreakTrump, getLegalCards } from './rules/legality.js';

// State
import { GameState, PHASE, getGameState, resetGameState } from './state/GameState.js';

// Socket
import { SocketManager, CONNECTION_STATE, getSocketManager, initializeSocketManager, resetSocketManager } from './socket/SocketManager.js';

// UI Components
import { createModal, confirm as confirmDialog, alert as alertDialog } from './ui/components/Modal.js';
import { showToast, showError, showSuccess, showWarning, showInfo } from './ui/components/Toast.js';
import { createSignInScreen, showSignInScreen } from './ui/screens/SignIn.js';
import { createRegisterScreen, showRegisterScreen } from './ui/screens/Register.js';
import { showMainRoom, addMainRoomChatMessage, updateLobbyList, removeMainRoom, updateMainRoomOnlineCount, getMainRoomUserColors } from './ui/screens/MainRoom.js';
import { showGameLobby, updateLobbyPlayersList, addLobbyChatMessage, removeGameLobby, getCurrentLobbyId, getIsPlayerReady, getLobbyUserColors } from './ui/screens/GameLobby.js';
import { UIManager, SCREENS, getUIManager, initializeUIManager, resetUIManager } from './ui/UIManager.js';

// Phaser
import { createGameConfig, CARD_CONFIG, ANIMATION_CONFIG, TABLE_POSITIONS } from './phaser/config.js';
import { CardManager } from './phaser/managers/CardManager.js';
import { OpponentManager } from './phaser/managers/OpponentManager.js';
import { TrickManager } from './phaser/managers/TrickManager.js';
import { EffectsManager } from './phaser/managers/EffectsManager.js';
import { GameScene } from './phaser/scenes/GameScene.js';

// Handlers
import {
  registerAllHandlers,
  registerAuthHandlers,
  registerLobbyHandlers,
  registerGameHandlers,
  registerChatHandlers,
  cleanupGameHandlers,
} from './handlers/index.js';

// UI Components - Bid & Game Log
import { createBidUI, showBidUI, createBidBubble } from './ui/components/BidUI.js';
import { createGameLog, showGameLog } from './ui/components/GameLog.js';
import { createSpeechBubble, showChatBubble, clearChatBubbles, getBubblePosition, getActiveChatBubbles } from './ui/components/ChatBubble.js';
import { showPlayerQueue, updatePlayerQueue, removePlayerQueue, isPlayerQueueVisible } from './ui/components/PlayerQueue.js';

// Bridge module - exposes new modules to legacy code
window.ModernUtils = {
  // Constants
  CLIENT_EVENTS,
  SERVER_EVENTS,
  RANK_VALUES,
  RANK_ORDER,
  SUITS,
  JOKER_SUIT,
  HAND_PROGRESSION,

  // Position utilities
  team,
  rotate,
  isSameTeam,
  getTeamNumber,
  getPlayerName,
  getRelativePosition,

  // Card utilities
  getCardImageKey,
  getSuitOrder,
  sortHand,
  cardsEqual,
  isJoker,
  getCardDisplayName,

  // Color utilities
  hashToHue,
  generateDistinctColor,
  getUsernameColor,
  extractHue,

  // Rules
  sameSuit,
  isVoid,
  isTrumpTight,
  isHighestTrump,
  isLegalMove,
  wouldBreakTrump,
  getLegalCards,

  // State
  GameState,
  PHASE,
  getGameState,
  resetGameState,

  // Socket
  SocketManager,
  CONNECTION_STATE,
  getSocketManager,
  initializeSocketManager,
  resetSocketManager,

  // UI Components
  createModal,
  confirmDialog,
  alertDialog,
  showToast,
  showError,
  showSuccess,
  showWarning,
  showInfo,
  createSignInScreen,
  showSignInScreen,
  createRegisterScreen,
  showRegisterScreen,
  showMainRoom,
  addMainRoomChatMessage,
  updateLobbyList,
  removeMainRoom,
  updateMainRoomOnlineCount,
  getMainRoomUserColors,
  showGameLobby,
  updateLobbyPlayersList,
  addLobbyChatMessage,
  removeGameLobby,
  getCurrentLobbyId,
  getIsPlayerReady,
  getLobbyUserColors,
  UIManager,
  SCREENS,
  getUIManager,
  initializeUIManager,
  resetUIManager,

  // Phaser
  createGameConfig,
  CARD_CONFIG,
  ANIMATION_CONFIG,
  TABLE_POSITIONS,
  CardManager,
  OpponentManager,
  TrickManager,
  EffectsManager,
  GameScene,

  // Handlers
  registerAllHandlers,
  registerAuthHandlers,
  registerLobbyHandlers,
  registerGameHandlers,
  registerChatHandlers,
  cleanupGameHandlers,

  // UI Components - Bid & Game Log
  createBidUI,
  showBidUI,
  createBidBubble,
  createGameLog,
  showGameLog,
  createSpeechBubble,
  showChatBubble,
  clearChatBubbles,
  getBubblePosition,
  getActiveChatBubbles,
  showPlayerQueue,
  updatePlayerQueue,
  removePlayerQueue,
  isPlayerQueueVisible,
};

console.log('Modular client initialized - All utilities available via window.ModernUtils');
