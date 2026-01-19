/**
 * Main entry point for the modular client.
 *
 * All game logic is now in the modular codebase in src/.
 * The window.ModernUtils bridge provides utilities for external access.
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
import { showProfilePage, updateProfilePicDisplay, updateCustomProfilePicDisplay, removeProfilePage, isProfilePageVisible } from './ui/screens/ProfilePage.js';
import { UIManager, SCREENS, getUIManager, initializeUIManager, resetUIManager } from './ui/UIManager.js';

// Phaser
import { createGameConfig, CARD_CONFIG, ANIMATION_CONFIG, TABLE_POSITIONS } from './phaser/config.js';
import { CardManager } from './phaser/managers/CardManager.js';
import { OpponentManager } from './phaser/managers/OpponentManager.js';
import { TrickManager } from './phaser/managers/TrickManager.js';
import { EffectsManager } from './phaser/managers/EffectsManager.js';
import { DrawManager } from './phaser/managers/DrawManager.js';
import { BidManager } from './phaser/managers/BidManager.js';
import { LayoutManager } from './phaser/managers/LayoutManager.js';
import { GameScene } from './phaser/scenes/GameScene.js';
import { createPhaserGame, getPhaserGame, destroyPhaserGame } from './phaser/PhaserGame.js';

// Handlers
import {
  registerAllHandlers,
  registerAuthHandlers,
  registerLobbyHandlers,
  registerGameHandlers,
  registerChatHandlers,
  registerProfileHandlers,
  cleanupGameHandlers,
} from './handlers/index.js';

// ============================================
// Game Scene Access
// ============================================

// Reference to the active Phaser game scene
let gameSceneRef = null;

// Reference to the modular game log instance
let gameLogInstance = null;

/**
 * Set the game scene reference (called when scene is created).
 * Also attaches DrawManager to the scene for draw phase handling.
 * @param {Phaser.Scene} scene - The active game scene
 */
export function setGameScene(scene) {
  gameSceneRef = scene;

  // Also set window.gameScene for global access
  window.gameScene = scene;

  // Handle tab visibility change - reposition elements when tab becomes visible
  // This fixes card positioning issues on background tabs during game start
  if (!scene._visibilityHandlerAdded) {
    scene._visibilityHandlerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && gameSceneRef) {
        console.log('🎮 Tab became visible, repositioning game elements');
        // Use requestAnimationFrame to ensure dimensions are updated
        requestAnimationFrame(() => {
          if (gameSceneRef.cardManager) {
            gameSceneRef.cardManager.repositionHand();
          }
          if (gameSceneRef.opponentManager) {
            gameSceneRef.opponentManager.reposition();
          }
        });
      }
    });
  }

  // Attach DrawManager to the scene if not already present
  if (!scene.drawManager) {
    scene.drawManager = new DrawManager(scene);
    console.log('🎮 DrawManager attached to scene');
  }

  // Attach CardManager to the scene if not already present
  if (!scene.cardManager) {
    scene.cardManager = new CardManager(scene);
    console.log('🎮 CardManager attached to scene');
  }

  // Attach OpponentManager to the scene if not already present
  if (!scene.opponentManager) {
    scene.opponentManager = new OpponentManager(scene);
    console.log('🎮 OpponentManager attached to scene');
  }

  // Add handler methods to the scene for draw phase
  if (!scene.handleStartDraw) {
    scene.handleStartDraw = function(data) {
      console.log('🎮 Legacy scene handleStartDraw');
      if (this.drawManager) {
        this.drawManager.showDrawUI();
      }
    };
  }

  if (!scene.handleYouDrew) {
    scene.handleYouDrew = function(data) {
      console.log('🎮 Legacy scene handleYouDrew');
      if (this.drawManager) {
        this.drawManager.handleYouDrew(data);
      }
    };
  }

  if (!scene.handlePlayerDrew) {
    scene.handlePlayerDrew = function(data) {
      console.log('🎮 Legacy scene handlePlayerDrew');
      if (this.drawManager) {
        this.drawManager.handlePlayerDrew(data);
      }
    };
  }

  if (!scene.handleTeamsAnnounced) {
    scene.handleTeamsAnnounced = function(data) {
      console.log('🎮 Legacy scene handleTeamsAnnounced');
      if (this.drawManager) {
        this.drawManager.handleTeamsAnnounced(data);
      }
    };
  }

  if (!scene.handleCreateUI) {
    scene.handleCreateUI = function(data) {
      console.log('🎮 Legacy scene handleCreateUI');
      if (this.drawManager) {
        this.drawManager.cleanup();
      }
    };
  }

  // Attach BidManager to the scene if not already present
  if (!scene.bidManager) {
    scene.bidManager = new BidManager(scene);
    console.log('🎮 BidManager attached to scene');
  }

  // Add handler methods to the scene for bidding phase
  if (!scene.handleBidReceived) {
    scene.handleBidReceived = function(data) {
      console.log('🎮 Legacy scene handleBidReceived');
      // Add to temp bids for bore button state
      const gameState = getGameState();
      gameState.addTempBid(data.bid);
      // Update bore button states
      if (this.bidManager) {
        this.bidManager.updateBoreButtonStates();
      }
      // Also update legacy bore buttons if they exist
      if (window.updateBoreButtons) {
        window.updateBoreButtons();
      }
    };
  }

  if (!scene.handleDoneBidding) {
    scene.handleDoneBidding = function(data) {
      console.log('🎮 Legacy scene handleDoneBidding');
      // Clear temp bids
      const gameState = getGameState();
      gameState.clearTempBids();
      // Hide bid UI
      if (this.bidManager) {
        this.bidManager.hideBidUI();
      }
    };
  }

  if (!scene.handleUpdateTurn) {
    scene.handleUpdateTurn = function(data) {
      console.log('🎮 Legacy scene handleUpdateTurn');
      const gameState = getGameState();
      const currentTurn = data.currentTurn || data.turn;

      // Update player turn glow via CardManager
      if (this.cardManager && gameState.position) {
        this.cardManager.updatePlayerTurnGlow(currentTurn, gameState.position);
      }

      // Update opponent turn glow via OpponentManager
      if (this.opponentManager && gameState.position) {
        this.opponentManager.setPlayerPosition(gameState.position);
        this.opponentManager.updateTurnGlow(currentTurn);
      }

      // Update bid UI visibility during bidding phase
      if (this.bidManager && gameState.isBidding) {
        this.bidManager.updateVisibility();
      }

      // Update card legality via CardManager
      if (this.cardManager && gameState.position) {
        const canPlay = !gameState.isBidding &&
                        currentTurn === gameState.position &&
                        !gameState.hasPlayedCard;

        // Create legality checker using game state
        const legalityChecker = (card) => {
          const result = isLegalMove(
            card,
            gameState.myCards,
            gameState.leadCard,
            gameState.playedCardIndex === 0,
            gameState.trump,
            gameState.trumpBroken,
            gameState.position,
            gameState.leadPosition
          );
          return result.legal;
        };

        this.cardManager.updateCardLegality(legalityChecker, canPlay);
      }
    };
  }

  // Attach TrickManager to the scene if not already present
  if (!scene.trickManager) {
    scene.trickManager = new TrickManager(scene);
    console.log('🎮 TrickManager attached to scene');
  }

  // Add handler methods to the scene for card play
  if (!scene.handleCardPlayed) {
    scene.handleCardPlayed = function(data) {
      console.log('🎮 Legacy scene handleCardPlayed');
      const gameState = getGameState();

      // Initialize TrickManager position if needed
      if (this.trickManager && gameState.position) {
        this.trickManager.setPlayerPosition(gameState.position);
        this.trickManager.updatePlayPositions();
      }

      // Handle card animation via TrickManager
      if (this.trickManager && this.opponentManager && gameState.position) {
        const cardKey = getCardImageKey(data.card);
        const relativeKey = this.trickManager.getRelativePositionKey(data.position);

        if (relativeKey === 'self') {
          // Self play - just add card at play position (card already removed from hand)
          this.trickManager.addPlayedCard(data.card, data.position, null, true);
        } else if (relativeKey) {
          // Opponent play - get sprite from OpponentManager, animate to center, reveal card
          const opponentId = relativeKey === 'opponent1' ? 'opp1' :
                             relativeKey === 'opponent2' ? 'opp2' : 'partner';
          const sprite = this.opponentManager.removeCard(opponentId);

          if (sprite) {
            const playPos = this.trickManager.getPlayPosition(relativeKey);

            // Animate card back to play position, then reveal card
            if (this.trickManager.isVisible()) {
              this.tweens.add({
                targets: sprite,
                x: playPos.x,
                y: playPos.y,
                duration: 500,
                ease: 'Power2',
                rotation: 0,
                scale: 1.5,
                onComplete: () => {
                  // Guard against destroyed sprite
                  if (!sprite || !sprite.scene) return;
                  sprite.setTexture('cards', cardKey);
                  sprite.setDepth(200);
                },
              });
            } else {
              sprite.x = playPos.x;
              sprite.y = playPos.y;
              sprite.setTexture('cards', cardKey);
              sprite.setDepth(200);
              sprite.setScale(1.5);
              sprite.setRotation(0);
            }

            sprite.setData('playPosition', relativeKey);
            this.trickManager._currentTrick.push(sprite);
          }
        }
      }

      // Update card legality when lead card is set (first card of trick)
      if (this.cardManager && gameState.position && gameState.playedCardIndex === 1) {
        // Lead card was just played, update legality for following cards
        const canPlay = gameState.currentTurn === gameState.position && !gameState.hasPlayedCard;

        const legalityChecker = (card) => {
          const result = isLegalMove(
            card,
            gameState.myCards,
            gameState.leadCard,
            false, // Not leading since lead was just played
            gameState.trump,
            gameState.trumpBroken,
            gameState.position,
            gameState.leadPosition
          );
          return result.legal;
        };

        this.cardManager.updateCardLegality(legalityChecker, canPlay);
      }
    };
  }

  if (!scene.handleTrickComplete) {
    scene.handleTrickComplete = function(data) {
      console.log('🎮 Legacy scene handleTrickComplete');
      const gameState = getGameState();

      // Use TrickManager for trick collection animation
      if (this.trickManager && gameState.position) {
        const isMyTeam = data.winner % 2 === gameState.position % 2;
        this.trickManager.completeTrick(data.winner, isMyTeam);
      }

      // Add to game feed
      if (this.handleAddToGameFeed) {
        this.handleAddToGameFeed(`Trick won by ${getPlayerName(data.winner)}.`);
      }

      // Update game log scores (trick counts)
      if (this.handleUpdateGameLogTricks) {
        this.handleUpdateGameLogTricks(gameState.teamTricks, gameState.oppTricks);
      }
    };
  }

  // Attach EffectsManager to the scene if not already present
  if (!scene.effectsManager) {
    scene.effectsManager = new EffectsManager(scene);
    console.log('🎮 EffectsManager attached to scene');
  }

  // Add handler methods for hand/game end events
  if (!scene.handleHandComplete) {
    scene.handleHandComplete = function(data) {
      console.log('🎮 Legacy scene handleHandComplete');
      const gameState = getGameState();
      // Reset effects for new hand
      if (this.effectsManager) {
        this.effectsManager.resetForNewHand();
      }
      // Reset trick manager for new hand
      if (this.trickManager) {
        this.trickManager.resetForNewHand();
      }
    };
  }

  if (!scene.handleGameEnd) {
    scene.handleGameEnd = function(data) {
      console.log('🎮 Legacy scene handleGameEnd');
      // Clear effects
      if (this.effectsManager) {
        this.effectsManager.clearAll();
      }
    };
  }

  if (!scene.handleRainbow) {
    scene.handleRainbow = function(data) {
      console.log('🎮 Legacy scene handleRainbow');
      const gameState = getGameState();
      // Set player position in effects manager if needed
      if (this.effectsManager && gameState.position) {
        this.effectsManager.setPlayerPosition(gameState.position);
        this.effectsManager.showRainbow(data.position);
      }
    };
  }

  if (!scene.handleDestroyHands) {
    scene.handleDestroyHands = function(data) {
      console.log('🎮 Legacy scene handleDestroyHands');
      // Clear player hand
      if (this.cardManager) {
        this.cardManager.clearHand();
      }
      // Clear opponent displays
      if (this.opponentManager) {
        this.opponentManager.clearAll();
      }
      // Clear trick displays
      if (this.trickManager) {
        this.trickManager.clearAll();
      }
    };
  }

  // Add handler methods for reconnection/error events
  if (!scene.handlePlayerDisconnected) {
    scene.handlePlayerDisconnected = function(data) {
      console.log('🎮 handlePlayerDisconnected:', data.username);
      // Add message to game feed
      if (this.handleAddToGameFeed) {
        this.handleAddToGameFeed(`${data.username} disconnected - waiting for reconnection...`);
      } else if (window.addToGameFeedFromLegacy) {
        window.addToGameFeedFromLegacy(`${data.username} disconnected - waiting for reconnection...`);
      }
    };
  }

  if (!scene.handlePlayerReconnected) {
    scene.handlePlayerReconnected = function(data) {
      console.log('🎮 handlePlayerReconnected:', data.username);
      // Add message to game feed
      if (window.addToGameFeedFromLegacy) {
        window.addToGameFeedFromLegacy(`${data.username} reconnected`);
      }
    };
  }

  if (!scene.handleRejoinSuccess) {
    scene.handleRejoinSuccess = function(data) {
      console.log('🎮 Legacy scene handleRejoinSuccess');
      // Game.js handles this via CustomEvent listener calling processRejoin()
    };
  }

  if (!scene.handleRejoinFailed) {
    scene.handleRejoinFailed = function(data) {
      console.log('🎮 Legacy scene handleRejoinFailed');
      // Game.js handles this via CustomEvent listener for now
    };
  }

  if (!scene.handleAbortGame) {
    scene.handleAbortGame = function(data) {
      console.log('🎮 Legacy scene handleAbortGame');
      // Clear all managers
      if (this.effectsManager) {
        this.effectsManager.clearAll();
      }
      if (this.trickManager) {
        this.trickManager.clearAll();
      }
      if (this.drawManager) {
        this.drawManager.cleanup();
      }
      // Game.js socket.on handler does the rest (restart scene, return to main room)
    };
  }

  // Attach LayoutManager to the scene if not already present
  if (!scene.layoutManager) {
    scene.layoutManager = new LayoutManager(scene);
    console.log('🎮 LayoutManager attached to scene');
  }

  // Add resize handler that updates LayoutManager
  if (!scene.handleResize) {
    scene.handleResize = function(width, height) {
      console.log('🎮 Legacy scene handleResize');
      if (this.layoutManager) {
        this.layoutManager.update();
        // Update TrickManager play positions from LayoutManager
        if (this.trickManager) {
          const playPos = this.layoutManager.getPlayPositions();
          this.trickManager.playPositions = playPos;
        }
        // Update CardManager hand positions from LayoutManager
        if (this.cardManager) {
          this.cardManager.repositionHand();
        }
      }
      // Update player info position
      if (this.repositionPlayerInfo) {
        this.repositionPlayerInfo();
      }
    };
  }

  // Add card display handlers
  if (!scene.handleClearHand) {
    scene.handleClearHand = function() {
      console.log('🎮 Legacy scene handleClearHand');
      if (this.cardManager) {
        this.cardManager.clearHand();
      }
    };
  }

  if (!scene.handleUpdateCardLegality) {
    scene.handleUpdateCardLegality = function(legalityChecker, canPlay) {
      console.log('🎮 Legacy scene handleUpdateCardLegality');
      if (this.cardManager) {
        this.cardManager.updateCardLegality(legalityChecker, canPlay);
      }
    };
  }

  if (!scene.handlePlayCard) {
    scene.handlePlayCard = function(card, position, targetX, targetY) {
      console.log('🎮 Legacy scene handlePlayCard');
      if (this.cardManager) {
        this.cardManager.playCard(card, position, targetX, targetY);
      }
    };
  }

  if (!scene.handleCollectTrick) {
    scene.handleCollectTrick = function(winnerPosition) {
      console.log('🎮 Legacy scene handleCollectTrick');
      if (this.cardManager) {
        this.cardManager.collectTrick(winnerPosition);
      }
    };
  }

  // Add hand display handler that wires CardManager with game logic
  if (!scene.handleDisplayHand) {
    scene.handleDisplayHand = function(cards, skipAnimation = false) {
      console.log('🎮 Legacy scene handleDisplayHand', cards?.length, 'cards, skipAnimation:', skipAnimation);
      if (!this.cardManager || !cards || cards.length === 0) return;

      const gameState = getGameState();
      const socket = window.socket;

      // Sort cards by trump before displaying
      const sortedCards = sortHand([...cards], gameState.trump);

      // Set up click handler for playing cards
      this.cardManager.setCardClickHandler((card, sprite) => {
        console.log(`🃏 Card clicked: ${card.rank} of ${card.suit}`);

        // Only allow playing if the card is marked as legal
        if (!sprite.getData('isLegal')) {
          console.log('Illegal move - card is disabled!');
          return;
        }

        // Set lead card if first play of trick
        if (gameState.playedCardIndex === 0) {
          gameState.leadCard = card;
          gameState.leadPosition = gameState.position;
        }

        // Play the card via socket
        if (socket) {
          socket.emit('playCard', { card, position: gameState.position });
        }

        // Mark that we've played a card (for legality checks)
        gameState.hasPlayedCard = true;

        // Update trump broken status
        if (card.suit === gameState.trump?.suit || card.suit === 'joker') {
          gameState.trumpBroken = true;
        }

        // Remove card from hand display
        this.cardManager.removeCard(card);

        // Also remove from gameState using optimistic update
        gameState.optimisticPlayCard(card);
      });

      // Display the sorted hand
      this.cardManager.displayHand(sortedCards, { animate: !skipAnimation });

      // Update card legality based on current game state
      const canPlay = !gameState.isBidding &&
                      gameState.currentTurn === gameState.position &&
                      !gameState.hasPlayedCard;

      console.log('🎮 handleDisplayHand legality check:', {
        isBidding: gameState.isBidding,
        currentTurn: gameState.currentTurn,
        position: gameState.position,
        hasPlayedCard: gameState.hasPlayedCard,
        canPlay,
        scaleWidth: this._scene?.scale?.width,
      });

      const legalityChecker = (card) => {
        const result = isLegalMove(
          card,
          gameState.myCards,
          gameState.leadCard,
          gameState.playedCardIndex === 0,
          gameState.trump,
          gameState.trumpBroken,
          gameState.position,
          gameState.leadPosition
        );
        return result.legal;
      };

      this.cardManager.updateCardLegality(legalityChecker, canPlay);
    };
  }

  // Add trump card display handler
  if (!scene.handleDisplayTrump) {
    scene.handleDisplayTrump = function(card) {
      console.log('🎮 Legacy scene handleDisplayTrump');
      // Get position from LayoutManager
      let trumpX, trumpY;
      if (this.layoutManager) {
        this.layoutManager.update();
        const trumpPos = this.layoutManager.getTrumpPosition();
        trumpX = trumpPos.x;
        trumpY = trumpPos.y;
      } else {
        // Fallback positioning
        const scaleX = this.scale.width / 1920;
        const scaleY = this.scale.height / 953;
        trumpX = this.scale.width / 2 + 500 * scaleX;
        trumpY = this.scale.height / 2 - 300 * scaleY;
      }

      // Clean up existing trump display
      if (this.tableCardBackground) this.tableCardBackground.destroy();
      if (this.tableCardSprite) this.tableCardSprite.destroy();
      if (this.tableCardLabel) this.tableCardLabel.destroy();

      const scaleX = this.scale.width / 1920;
      const scaleY = this.scale.height / 953;

      // Create background
      this.tableCardBackground = this.add.rectangle(trumpX, trumpY, 120 * scaleX, 160 * scaleY, 0x8B4513)
        .setStrokeStyle(4, 0x654321)
        .setDepth(-1);

      // Create card sprite
      const cardKey = getCardImageKey(card);
      this.tableCardSprite = this.add.image(trumpX, trumpY, 'cards', cardKey).setScale(1.5);

      // Create label
      this.tableCardLabel = this.add.text(trumpX, trumpY - 100, 'TRUMP', {
        fontSize: '24px',
        fontStyle: 'bold',
        color: '#FFFFFF',
        backgroundColor: '#000000AA',
        padding: { x: 10, y: 5 },
        align: 'center'
      }).setOrigin(0.5);
    };
  }

  // Add opponent display handlers
  if (!scene.handleDisplayOpponentHands) {
    scene.handleDisplayOpponentHands = function(cardCount, dealerPosition, playerData, skipAnimation) {
      console.log('🎮 Legacy scene handleDisplayOpponentHands');
      if (this.opponentManager) {
        const gameState = getGameState();
        if (gameState.position) {
          this.opponentManager.setPlayerPosition(gameState.position);
        }
        this.opponentManager.displayOpponentHands(cardCount, dealerPosition, playerData, skipAnimation);
      }
    };
  }

  if (!scene.handleOpponentTurnGlow) {
    scene.handleOpponentTurnGlow = function(opponentId) {
      console.log('🎮 Legacy scene handleOpponentTurnGlow');
      if (this.opponentManager) {
        this.opponentManager.removeTurnGlow();
        if (opponentId) {
          this.opponentManager.addTurnGlow(opponentId);
        }
      }
    };
  }

  if (!scene.handleClearOpponents) {
    scene.handleClearOpponents = function() {
      console.log('🎮 Legacy scene handleClearOpponents');
      if (this.opponentManager) {
        this.opponentManager.clearAll();
      }
    };
  }

  if (!scene.handleRepositionOpponents) {
    scene.handleRepositionOpponents = function() {
      console.log('🎮 Legacy scene handleRepositionOpponents');
      if (this.opponentManager) {
        this.opponentManager.reposition();
      }
    };
  }

  // Add game log handlers
  if (!scene.handleShowGameLog) {
    scene.handleShowGameLog = function(options = {}) {
      console.log('🎮 Legacy scene handleShowGameLog');
      // Store log instance on scene for later use
      if (!this._gameLog) {
        this._gameLog = showGameLog({
          onChatSubmit: options.onChatSubmit || ((msg) => {
            if (window.socket) {
              window.socket.emit('chatMessage', { message: msg });
            }
          }),
        });
      }
      return this._gameLog;
    };
  }

  if (!scene.handleAddToGameFeed) {
    scene.handleAddToGameFeed = function(message, playerPosition = null) {
      console.log('🎮 Legacy scene handleAddToGameFeed');
      // Use modular GameLog if available
      if (this._gameLog && this._gameLog.addGameMessage) {
        this._gameLog.addGameMessage(message, playerPosition);
      } else if (window.addToGameFeedFromLegacy) {
        // Fall back to legacy function
        window.addToGameFeedFromLegacy(message, playerPosition);
      }
    };
  }

  if (!scene.handleUpdateGameLogScores) {
    scene.handleUpdateGameLogScores = function(teamScore, oppScore) {
      console.log('🎮 Legacy scene handleUpdateGameLogScores');
      if (this._gameLog) {
        this._gameLog.updateScores(teamScore, oppScore);
      }
    };
  }

  if (!scene.handleUpdateGameLogTricks) {
    scene.handleUpdateGameLogTricks = function(teamTricks, oppTricks) {
      console.log('🎮 Legacy scene handleUpdateGameLogTricks');
      if (this._gameLog && this._gameLog.updateTricks) {
        this._gameLog.updateTricks(teamTricks, oppTricks);
      }
    };
  }

  if (!scene.handleHideGameLog) {
    scene.handleHideGameLog = function() {
      console.log('🎮 Legacy scene handleHideGameLog');
      if (this._gameLog) {
        this._gameLog.destroy();
        this._gameLog = null;
      }
    };
  }

  // Add chat bubble handler
  if (!scene.handleShowChatBubble) {
    scene.handleShowChatBubble = function(playerPosition, messagePosition, message, color, duration) {
      console.log('🎮 Legacy scene handleShowChatBubble', { playerPosition, messagePosition, message });
      const bubblePos = getBubblePosition(this, playerPosition, messagePosition);
      if (bubblePos) {
        showChatBubble(this, bubblePos.positionKey, bubblePos.x, bubblePos.y, message, color, duration);
      }
    };
  }

  // Player info box (avatar, name, position text)
  if (!scene._playerInfo) {
    scene._playerInfo = null;
  }

  if (!scene.createPlayerInfoBox) {
    scene.createPlayerInfoBox = function(playerData, myPosition) {
      // Safety check
      if (!playerData?.username || !playerData?.position || !playerData?.pics) {
        console.warn('⚠️ createPlayerInfoBox: playerData not ready');
        return null;
      }

      const positionIndex = playerData.position.indexOf(myPosition);
      if (positionIndex === -1 || !playerData.username[positionIndex]) {
        console.warn('⚠️ createPlayerInfoBox: position not found in playerData');
        return null;
      }

      const screenWidth = this.scale.width;
      const screenHeight = this.scale.height;
      const scaleX = screenWidth / 1920;
      const scaleY = screenHeight / 953;

      const boxX = screenWidth - 380 * scaleX;
      const boxY = screenHeight - 150 * scaleY;

      // Player Avatar - use DOM for consistent sizing with opponent avatars
      const pic = playerData.pics[positionIndex];
      const username = playerData.username[positionIndex].username || playerData.username[positionIndex];

      // Create DOM-based avatar (same approach as opponent avatars)
      const avatarContainer = document.createElement('div');
      avatarContainer.id = 'player-avatar-container';
      avatarContainer.style.cssText = `
        position: absolute;
        left: ${boxX}px;
        top: ${boxY - 60 * scaleY}px;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        pointer-events: none;
        z-index: 100;
      `;

      const avatarImg = document.createElement('img');
      avatarImg.className = 'player-avatar-img';
      // Handle both numbered pics and custom base64 pics
      if (pic && typeof pic === 'string' && pic.startsWith('data:image')) {
        avatarImg.src = pic;
      } else if (pic && typeof pic === 'number') {
        avatarImg.src = `assets/profile${pic}.png`;
      } else {
        avatarImg.src = 'assets/profile1.png';
      }
      avatarImg.alt = username;
      avatarImg.style.cssText = `
        width: 80px;
        height: 80px;
        min-width: 80px;
        min-height: 80px;
        max-width: 80px;
        max-height: 80px;
        object-fit: cover;
        border-radius: 50%;
        border: 3px solid #333;
        background: #1a1a1a;
      `;
      avatarContainer.appendChild(avatarImg);

      // Add username label
      const nameLabel = document.createElement('div');
      nameLabel.textContent = username;
      nameLabel.style.cssText = `
        margin-top: 5px;
        font-size: 14px;
        font-family: Arial, sans-serif;
        color: #ffffff;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      `;
      avatarContainer.appendChild(nameLabel);

      // Position Text (BTN, MP, CO, UTG) - still use Phaser for this
      const playerPositionText = this.add.text(boxX, boxY + 35 * scaleY, '', {
        fontSize: '16px',
        fontFamily: 'Arial',
        color: '#ffffff'
      }).setOrigin(0.5);

      // Add avatar to DOM
      document.body.appendChild(avatarContainer);

      this._playerInfo = { avatarContainer, avatarImg, nameLabel, playerPositionText };
      return this._playerInfo;
    };
  }

  if (!scene.updatePlayerPositionText) {
    scene.updatePlayerPositionText = function(dealer, myPosition) {
      if (!this._playerInfo?.playerPositionText) return;

      if (dealer === myPosition) {
        this._playerInfo.playerPositionText.setText('BTN');
      } else if (team(myPosition) === dealer) {
        this._playerInfo.playerPositionText.setText('MP');
      } else if (rotate(myPosition) === dealer) {
        this._playerInfo.playerPositionText.setText('CO');
      } else if (rotate(rotate(rotate(myPosition))) === dealer) {
        this._playerInfo.playerPositionText.setText('UTG');
      }
    };
  }

  if (!scene.repositionPlayerInfo) {
    scene.repositionPlayerInfo = function() {
      if (!this._playerInfo?.avatarContainer) return;

      const screenWidth = this.scale.width;
      const screenHeight = this.scale.height;
      const scaleX = screenWidth / 1920;
      const scaleY = screenHeight / 953;

      const boxX = screenWidth - 380 * scaleX;
      const boxY = screenHeight - 150 * scaleY;

      // Reposition DOM avatar container
      this._playerInfo.avatarContainer.style.left = `${boxX}px`;
      this._playerInfo.avatarContainer.style.top = `${boxY - 60 * scaleY}px`;

      // Reposition Phaser position text
      if (this._playerInfo.playerPositionText) {
        this._playerInfo.playerPositionText.setPosition(boxX, boxY + 35 * scaleY);
      }
    };
  }

  if (!scene.clearPlayerInfo) {
    scene.clearPlayerInfo = function() {
      // Remove DOM avatar container
      if (this._playerInfo?.avatarContainer) {
        this._playerInfo.avatarContainer.remove();
      }
      // Destroy Phaser position text
      if (this._playerInfo?.playerPositionText) {
        this._playerInfo.playerPositionText.destroy();
      }
      this._playerInfo = null;
    };
  }

  console.log('🎮 Game scene reference set with all handlers');
}

/**
 * Get the current game scene (for use in callbacks).
 * @returns {Phaser.Scene|null} The active game scene or null
 */
export function getGameScene() {
  return gameSceneRef;
}

/**
 * Clear the game scene reference (called on game cleanup).
 */
export function clearGameScene() {
  gameSceneRef = null;
  console.log('🎮 Game scene reference cleared');
}

// UI Components - Bid & Game Log
import { createBidUI, showBidUI, createBidBubble } from './ui/components/BidUI.js';
import { createGameLog, showGameLog } from './ui/components/GameLog.js';
import { createSpeechBubble, showChatBubble, clearChatBubbles, getBubblePosition, getActiveChatBubbles } from './ui/components/ChatBubble.js';
import { showPlayerQueue, updatePlayerQueue, removePlayerQueue, isPlayerQueueVisible } from './ui/components/PlayerQueue.js';
import { getTeamNames, formatHandCompleteMessages, formatGameEndMessages, showFinalScoreOverlay, removeFinalScoreOverlay } from './ui/components/ScoreModal.js';

// Bridge module - exposes new modules to legacy code
window.ModernUtils = {
  // Scene Access
  setGameScene,
  getGameScene,
  clearGameScene,

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
  showProfilePage,
  updateProfilePicDisplay,
  updateCustomProfilePicDisplay,
  removeProfilePage,
  isProfilePageVisible,
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
  DrawManager,
  BidManager,
  LayoutManager,
  GameScene,
  createPhaserGame,
  getPhaserGame,
  destroyPhaserGame,

  // Handlers
  registerAllHandlers,
  registerAuthHandlers,
  registerLobbyHandlers,
  registerGameHandlers,
  registerChatHandlers,
  registerProfileHandlers,
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

  // Score Modal
  getTeamNames,
  formatHandCompleteMessages,
  formatGameEndMessages,
  showFinalScoreOverlay,
  removeFinalScoreOverlay,
};

console.log('Modular client initialized - All utilities available via window.ModernUtils');

// ============================================
// Game Log Bridges (window functions for external access)
// ============================================

// Bridge for creating game feed - now uses modular GameLog
window.createGameFeedFromLegacy = function(isReconnection = false) {
  if (!gameLogInstance) {
    gameLogInstance = showGameLog({
      onChatSubmit: (message) => {
        if (window.socket) {
          window.socket.emit('chatMessage', { message });
        }
      },
    });

    // Add .in-game class to restrict game container width
    document.getElementById('game-container')?.classList.add('in-game');

    // Force Phaser resize
    requestAnimationFrame(() => {
      const container = document.getElementById('game-container');
      if (container && gameSceneRef?.game?.scale) {
        const newWidth = container.clientWidth;
        const newHeight = container.clientHeight;
        gameSceneRef.game.scale.resize(newWidth, newHeight);
      }
    });

    if (!isReconnection) {
      gameLogInstance.addGameMessage('Game started!');
    }
  }
};

// Bridge for adding messages to game feed
window.addToGameFeedFromLegacy = function(message, playerPosition = null) {
  if (gameLogInstance && gameLogInstance.addGameMessage) {
    gameLogInstance.addGameMessage(message, playerPosition);
  } else {
    console.warn('Game log not initialized, message dropped:', message);
  }
};

// Bridge for updating game log score display
window.updateGameLogScoreFromLegacy = function(teamNames, oppNames, teamScore, oppScore, teamBids = '-/-', oppBids = '-/-', teamTricks = 0, oppTricks = 0) {
  if (gameLogInstance && gameLogInstance.updateFullScore) {
    gameLogInstance.updateFullScore(teamNames, oppNames, teamScore, oppScore, teamBids, oppBids, teamTricks, oppTricks);
  } else {
    console.warn('Game log not initialized, score update dropped');
  }
};

// Export getter for game log instance
export function getGameLogInstance() {
  return gameLogInstance;
}

// Export function to destroy game log (for cleanup)
export function destroyGameLog() {
  if (gameLogInstance) {
    gameLogInstance.destroy();
    gameLogInstance = null;
  }
  document.getElementById('game-container')?.classList.remove('in-game');
}

// ============================================
// Application Initialization
// ============================================

/**
 * Get the socket connection.
 * Socket is created in socket-init.js which loads before this module.
 */
function getSocket() {
  // Socket is created in index.html inline script
  if (window.socket) {
    return window.socket;
  }
  // Fallback: create socket if not already created (shouldn't happen)
  console.warn('Socket not found on window, creating new socket');
  const serverUrl =
    location.hostname === 'localhost'
      ? 'http://localhost:3000'
      : 'https://bab-online-production.up.railway.app';

  const socket = io(serverUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  window.socket = socket;
  return socket;
}

// Get socket (created in socket-init.js)
const socket = getSocket();
console.log('Using socket from window.socket');

// ==================== RECONNECTION LOGIC ====================

// Track if we've already attempted rejoin this session
let rejoinAttempted = false;
// Track if rejoin was successful (to ignore mainRoomJoined during game)
let rejoinSucceeded = false;

socket.on('connect', () => {
  console.log('Connected to server:', socket.id);
  // Note: Rejoin logic moved to window.load handler to ensure callbacks are registered first
});

socket.on('disconnect', (reason) => {
  console.log('Disconnected from server:', reason);
  document.dispatchEvent(new CustomEvent('connectionLost', { detail: { reason } }));
});

socket.on('reconnect_attempt', (attemptNumber) => {
  console.log(`Reconnection attempt ${attemptNumber}/5`);
  document.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: attemptNumber } }));
});

socket.on('reconnect_failed', () => {
  console.log('Reconnection failed after all attempts');

  // Full cleanup on reconnect failure
  const scene = getGameScene();
  if (scene) {
    scene.scene.restart();
    socket.off("gameStart");
  }
  if (scene && scene.layoutManager) {
    scene.layoutManager.cleanupDomBackgrounds();
  }
  uiManager.removeWaitingScreen();
  uiManager.clearUI();

  // Clear game log
  let gameFeed = document.getElementById("gameFeed");
  if (gameFeed) gameFeed.remove();
  gameLogInstance = null;

  // Remove width restriction from game container
  document.getElementById('game-container')?.classList.remove('in-game');

  // Clear session and state
  sessionStorage.removeItem('username');
  sessionStorage.removeItem('sessionToken');
  sessionStorage.removeItem('gameId');
  getGameState().reset();

  // Show sign-in screen
  displaySignInScreen();
  alert("Connection lost. Please sign in again.");
});

// Handle rejoinSuccess cleanup (main state restoration via gameHandlers onRejoinSuccess)
socket.on('rejoinSuccess', (data) => {
  console.log('Rejoin successful:', data);
  rejoinSucceeded = true;

  // Remove any auth screens that might be showing
  const signInContainer = document.getElementById('sign-in-container');
  if (signInContainer) signInContainer.remove();
  const signInVignette = document.getElementById('sign-in-vignette');
  if (signInVignette) signInVignette.remove();
  const legacySignIn = document.getElementById('signInContainer');
  if (legacySignIn) legacySignIn.remove();
  const legacyVignette = document.getElementById('SignInVignette');
  if (legacyVignette) legacyVignette.remove();
  const registerContainer = document.getElementById('register-container');
  if (registerContainer) registerContainer.remove();
  const registerVignette = document.getElementById('register-vignette');
  if (registerVignette) registerVignette.remove();

  // Also remove main room and lobby if present
  removeMainRoom();
  removeGameLobby();
  // Note: State restoration and UI rebuild handled by gameHandlers onRejoinSuccess callback
});

socket.on('rejoinFailed', (data) => {
  console.log('Rejoin failed:', data?.reason || data);
  // Only clear gameId if it's a real failure, not "Already connected"
  // "Already connected" means a previous rejoin attempt succeeded
  const reason = typeof data === 'string' ? data : data?.reason;
  if (reason !== 'Already connected') {
    sessionStorage.removeItem('gameId');
    // Return to main room
    socket.emit("joinMainRoom");
  }
  // Note: Additional handling in gameHandlers onRejoinFailed callback
});

socket.on('playerReconnected', (data) => {
  console.log(`Player at position ${data.position} (${data.username}) reconnected`);
  document.dispatchEvent(new CustomEvent('playerReconnected', { detail: data }));
});

socket.on('playerAssigned', (data) => {
  console.log('📡 Received playerAssigned:', data);
  const state = getGameState();
  if (data.playerId) {
    state.playerId = data.playerId;
  }
  if (data.position) {
    state.position = data.position;
  }
});

socket.on('gameStart', (data) => {
  console.log('Game Started', data);
  if (data.gameId) {
    sessionStorage.setItem('gameId', data.gameId);
  }
});

socket.on('gameEnd', (data) => {
  console.log('Game ended:', data);
  sessionStorage.removeItem('gameId');
  // Reset rejoin flags so future rejoins work
  rejoinAttempted = false;
  rejoinSucceeded = false;
});

// ==================== END RECONNECTION LOGIC ====================

// Also create a socketManager shim for legacy compatibility
window.socketManager = {
  setGameId: (id) => {
    sessionStorage.setItem('gameId', id);
  },
  clearGameId: () => {
    sessionStorage.removeItem('gameId');
  },
  getGameId: () => sessionStorage.getItem('gameId'),
  getUsername: () => sessionStorage.getItem('username'),
  showErrorToast: (message, duration) => {
    const existing = document.querySelector('.error-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'error-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration || 5000);
  },
};

/**
 * Show error toast notification (same as legacy socketManager.js).
 */
function showErrorToast(message, duration = 5000) {
  // Remove existing toast
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Track retry attempts for joinMainRoom
let joinMainRoomRetries = 0;
const MAX_JOIN_RETRIES = 5;

/**
 * Handle socket error based on type.
 */
function handleSocketError(error, socket) {
  let message = 'Something went wrong';

  // Handle race condition where joinMainRoom is called before user is registered
  if (error.message === 'User not registered yet') {
    // Don't retry if we're in a game (have a gameId)
    if (sessionStorage.getItem('gameId')) {
      console.log('User not registered yet, but have gameId - waiting for rejoin instead');
      return;
    }

    joinMainRoomRetries++;
    if (joinMainRoomRetries <= MAX_JOIN_RETRIES) {
      console.log(`User not registered yet, retrying joinMainRoom (${joinMainRoomRetries}/${MAX_JOIN_RETRIES})...`);
      setTimeout(() => {
        socket.emit('joinMainRoom');
      }, 100);
      return; // Don't show error toast for this
    } else {
      console.log('Max joinMainRoom retries reached, showing sign-in screen');
      joinMainRoomRetries = 0;
      displaySignInScreen();
      return;
    }
  }

  switch (error.type) {
    case 'VALIDATION_ERROR':
    case 'validation':
      message = error.message || 'Invalid input';
      break;
    case 'AUTH_ERROR':
      message = 'Please sign in again';
      break;
    case 'RATE_LIMIT_ERROR':
    case 'rateLimit':
      message = 'Too many requests. Please slow down.';
      break;
    case 'GAME_STATE_ERROR':
      message = error.message || 'Game error occurred';
      break;
    case 'server':
    default:
      message = 'Server error. Please try again.';
      break;
  }

  showErrorToast(message);
}

/**
 * Initialize the application.
 * This is the main entry point that wires everything together.
 * Note: socket is already created at module load time (see above)
 */
function initializeApp() {
  console.log('Initializing BAB Online...');

  // Socket already created at module level as window.socket
  // Initialize socket manager with the existing socket
  const socketMgr = initializeSocketManager(socket);

  // Initialize UI manager
  const uiManager = initializeUIManager(socket);

  // Get game state singleton
  const gameState = getGameState();

  // Set up error handler
  socket.on('error', (error) => {
    console.error('Server error:', error);
    handleSocketError(error, socket);
  });

  // Register all handlers with UI callbacks
  registerAllHandlers(socketMgr, {
    // Auth callbacks
    onSignInSuccess: (data) => {
      console.log('Sign in success, going to main room');
      gameState.username = data.username;
      uiManager.setUsername(data.username);
      // Reset rejoin flags for fresh session
      rejoinAttempted = false;
      rejoinSucceeded = false;

      // Check if user has an active game to rejoin
      if (data.activeGameId) {
        console.log(`Active game found: ${data.activeGameId}, attempting to rejoin...`);
        sessionStorage.setItem('gameId', data.activeGameId);
        socket.emit('rejoinGame', { gameId: data.activeGameId, username: data.username });
      } else {
        // Go to main room
        socket.emit('joinMainRoom');
      }
    },
    onSignInError: (message) => {
      showError(message || 'Sign-in failed! Incorrect username or password.');
    },
    onSignUpSuccess: (data) => {
      if (data.autoLoggedIn) {
        // Auto-login: go straight to main room
        console.log(`Registration & auto-login successful: ${data.username}`);
        gameState.username = data.username;
        uiManager.setUsername(data.username);
        socket.emit('joinMainRoom');
      } else {
        showSuccess('Registration successful! Please sign in.');
      }
    },
    onSignUpError: (message) => {
      showError(`Registration failed: ${message}`);
    },
    onForceLogout: (data) => {
      console.warn('Force logout:', data?.reason || 'Unknown reason');

      const scene = getGameScene();

      // Restart scene
      if (scene) {
        scene.scene.restart();
        socket.off("gameStart");
      }

      // Clean up DOM backgrounds
      if (scene && scene.layoutManager) {
        scene.layoutManager.cleanupDomBackgrounds();
      }

      // Remove UI elements
      uiManager.removeWaitingScreen();
      uiManager.clearUI();

      // Remove game log
      let gameFeed = document.getElementById("gameFeed");
      if (gameFeed) gameFeed.remove();
      gameLogInstance = null;

      // Remove width restriction from game container
      document.getElementById('game-container')?.classList.remove('in-game');

      // Clear scene reference
      clearGameScene();

      // Clear session storage and state
      sessionStorage.removeItem('username');
      sessionStorage.removeItem('sessionToken');
      sessionStorage.removeItem('gameId');
      gameState.reset();

      // Show sign-in screen
      displaySignInScreen();
    },
    onActiveGameFound: (data) => {
      console.log('Active game found:', data.gameId);
      // The rejoin will be handled by the server's sign-in response
    },

    // Main Room callbacks
    onMainRoomJoined: (data) => {
      // Reset retry counter on success
      joinMainRoomRetries = 0;

      // Don't show main room if we're in a game or rejoin succeeded
      if (sessionStorage.getItem('gameId') || rejoinSucceeded) {
        console.log('Main room joined event ignored - in game (gameId:', sessionStorage.getItem('gameId'), 'rejoinSucceeded:', rejoinSucceeded, ')');
        return;
      }
      console.log('Joined main room, showing UI');
      // Clear modular sign-in/register screens (with dashes)
      const signInContainer = document.getElementById('sign-in-container');
      if (signInContainer) signInContainer.remove();
      const signInVignette = document.getElementById('sign-in-vignette');
      if (signInVignette) signInVignette.remove();
      const registerContainer = document.getElementById('register-container');
      if (registerContainer) registerContainer.remove();
      const registerVignette = document.getElementById('register-vignette');
      if (registerVignette) registerVignette.remove();
      // Also clear legacy screens (camelCase) just in case
      const legacySignIn = document.getElementById('signInContainer');
      if (legacySignIn) legacySignIn.remove();
      const legacySignInVignette = document.getElementById('SignInVignette');
      if (legacySignInVignette) legacySignInVignette.remove();

      showMainRoom(data, socket);
    },
    onMainRoomMessage: (data) => {
      addMainRoomChatMessage(data.username, data.message);
    },
    onLobbiesUpdated: (data) => {
      updateLobbyList(data.lobbies, socket);
    },
    onMainRoomPlayerJoined: (data) => {
      updateMainRoomOnlineCount(data.onlineCount);
    },

    // Lobby callbacks
    onLobbyCreated: (data) => {
      // Don't show lobby if we're in a game (e.g., during rejoin)
      if (sessionStorage.getItem('gameId')) {
        console.log('Lobby created event ignored - in game');
        return;
      }
      console.log('Lobby created, showing lobby UI');
      removeMainRoom();
      showGameLobby(
        { lobbyId: data.lobbyId, players: data.players, messages: data.messages || [] },
        socket,
        gameState.username
      );
    },
    onLobbyJoined: (data) => {
      // Don't show lobby if we're in a game (e.g., during rejoin)
      if (sessionStorage.getItem('gameId')) {
        console.log('Lobby joined event ignored - in game');
        return;
      }
      console.log('Joined lobby, showing lobby UI');
      removeMainRoom();
      showGameLobby(
        { lobbyId: data.lobbyId, players: data.players, messages: data.messages || [] },
        socket,
        gameState.username
      );
    },
    onPlayerReadyUpdate: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLobbyMessage: (data) => {
      addLobbyChatMessage(data.username, data.message);
    },
    onLobbyPlayerLeft: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLobbyPlayerJoined: (data) => {
      updateLobbyPlayersList(null, data.players, gameState.username);
    },
    onLeftLobby: () => {
      console.log('Left lobby, returning to main room');
      removeGameLobby();
      socket.emit('joinMainRoom');
    },
    onAllPlayersReady: (data) => {
      console.log('All players ready, game starting soon...');
      // The game will start via positionUpdate/gameStart events
    },

    // Game callbacks - update GameState and trigger scene handlers
    onPositionUpdate: (data) => {
      console.log('📍 onPositionUpdate callback');
      // Update modular GameState with player data
      gameState.setPlayerData(data);

      // Create player info if deferred (scene ready but waiting for position data)
      const scene = getGameScene();
      if (gameState.position && scene && scene.createPlayerInfoBox && !scene._playerInfo) {
        scene.createPlayerInfoBox(gameState.playerData, gameState.position);
        console.log("✅ playerInfo created via scene after positionUpdate");
      }
    },
    onGameStart: (data) => {
      console.log('🎮 onGameStart callback');
      // Update modular GameState
      if (data.position) {
        gameState.position = data.position;
        gameState._updatePlayerNames();
      }
      if (data.hand) {
        gameState.setCards(data.hand);
      }
      if (data.trump) {
        gameState.setTrump(data.trump);
      }
      if (data.dealer !== undefined) {
        gameState.dealer = data.dealer;
      }
      gameState.phase = PHASE.BIDDING;
      gameState.isBidding = true;

      // Initialize all managers with player position
      const scene = getGameScene();
      if (scene && data.position) {
        if (scene.trickManager) {
          scene.trickManager.setPlayerPosition(data.position);
          scene.trickManager.updatePlayPositions();
        }
        if (scene.opponentManager) {
          scene.opponentManager.setPlayerPosition(data.position);
        }
        if (scene.effectsManager) {
          scene.effectsManager.setPlayerPosition(data.position);
        }

        // Display player hand via CardManager
        if (scene.handleDisplayHand && data.hand) {
          scene.handleDisplayHand(data.hand, false);
        }

        // Display opponent hands via OpponentManager
        // Note: skip animation to avoid conflicts with resize events during game start
        if (scene.handleDisplayOpponentHands && data.hand) {
          scene.handleDisplayOpponentHands(
            data.hand.length,
            data.dealer,
            gameState.playerData,
            true // skip animation - resize events interfere with tweens
          );
        }

        // Create player info box (avatar, name, position text) via scene method
        if (scene.createPlayerInfoBox && !scene._playerInfo) {
          scene.createPlayerInfoBox(gameState.playerData, data.position);
        }

        // Update player position text (BTN, MP, CO, UTG)
        if (scene.updatePlayerPositionText && data.dealer !== undefined) {
          scene.updatePlayerPositionText(data.dealer, data.position);
        }

        // Create DOM backgrounds via LayoutManager
        if (scene.layoutManager) {
          scene.layoutManager.update();
          scene.layoutManager.createDomBackgrounds();
        }

        // Display trump card via scene method
        if (data.trump && scene.displayTrumpCard) {
          scene.displayTrumpCard(data.trump);
        }

        // Create bid UI via BidManager
        if (scene.bidManager && data.hand) {
          scene.bidManager.showBidUI(data.hand.length, (bid) => {
            console.log(`📩 Sending bid: ${bid}`);
            if (window.socket) {
              window.socket.emit('playerBid', { position: gameState.position, bid });
            }
          });
        }
      }

      // Update game log score display
      if (data.hand && data.hand.length > 0) {
        const position = gameState.position;
        const playerData = gameState.playerData;
        if (playerData && position) {
          const { teamName, oppName } = getTeamNames(position, playerData);
          // Get scores from data, adjusted for player's team
          const teamScore = position % 2 !== 0 ? (data.score1 || 0) : (data.score2 || 0);
          const oppScore = position % 2 !== 0 ? (data.score2 || 0) : (data.score1 || 0);
          window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);
        }
      }
    },
    // Draw phase - handled by DrawManager
    onStartDraw: (data) => {
      console.log('🎴 onStartDraw callback');
      // Remove waiting screen
      uiManager.removeWaitingScreen();

      // Use DrawManager via scene handler
      const scene = getGameScene();
      if (scene && scene.handleStartDraw) {
        scene.handleStartDraw(data);
      }
    },
    onYouDrew: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleYouDrew) {
        scene.handleYouDrew(data);
      }
    },
    onPlayerDrew: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerDrew) {
        scene.handlePlayerDrew(data);
      }
    },
    onTeamsAnnounced: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleTeamsAnnounced) {
        scene.handleTeamsAnnounced(data);
      }
    },
    onCreateUI: (data) => {
      console.log('🎨 onCreateUI callback');
      // Remove waiting screen and lobby/main room UI
      uiManager.removeWaitingScreen();
      removeMainRoom();
      removeGameLobby();

      // Clean up draw phase via DrawManager
      const scene = getGameScene();
      if (scene && scene.handleCreateUI) {
        scene.handleCreateUI(data);
      }

      // Create game feed using modular GameLog
      if (!gameLogInstance) {
        gameLogInstance = showGameLog({
          onChatSubmit: (message) => {
            const socket = getSocketManager()?.socket;
            if (socket) {
              socket.emit('chatMessage', { message });
            }
          },
        });

        // Add .in-game class to restrict game container width for game log
        document.getElementById('game-container')?.classList.add('in-game');

        // Force Phaser to resize after container width change
        requestAnimationFrame(() => {
          const container = document.getElementById('game-container');
          if (container && scene?.game?.scale) {
            const newWidth = container.clientWidth;
            const newHeight = container.clientHeight;
            scene.game.scale.resize(newWidth, newHeight);
            if (scene.game.renderer?.resize) {
              scene.game.renderer.resize(newWidth, newHeight);
            }
          }
        });

        // Add initial message
        gameLogInstance.addGameMessage('Game started!');
      }

      // Initialize scene handElements if needed
      if (scene && !scene.handElements) {
        scene.handElements = [];
      }
    },
    // Bidding phase - call GameScene handlers plus legacy code
    onBidReceived: (data) => {
      // Update GameState with bid
      if (data.position !== undefined && data.bid !== undefined) {
        gameState.recordBid(data.position, data.bid);
      }
      const scene = getGameScene();
      if (scene && scene.handleBidReceived) {
        scene.handleBidReceived(data);
      }
      // Note: Legacy code in displayCards() also handles bidReceived for bubbles/impact events
    },
    onDoneBidding: (data) => {
      // Update GameState - transition from bidding to playing
      gameState.phase = PHASE.PLAYING;
      gameState.isBidding = false;
      const scene = getGameScene();
      if (scene && scene.handleDoneBidding) {
        scene.handleDoneBidding(data);
      }
      // Note: Legacy code in displayCards() also handles doneBidding
    },
    onUpdateTurn: (data) => {
      // Update GameState with current turn
      if (data.currentTurn !== undefined) {
        gameState.setCurrentTurn(data.currentTurn);
      }
      const scene = getGameScene();
      if (scene && scene.handleUpdateTurn) {
        scene.handleUpdateTurn(data);
      }
      // Note: Legacy code in displayCards() also handles updateTurn for glow effects
    },
    // Card play & tricks - call GameScene handlers (legacy still runs in displayCards)
    onCardPlayed: (data) => {
      // Update GameState
      if (data.trumpBroken) {
        gameState.breakTrump();
      }
      const scene = getGameScene();
      if (scene && scene.handleCardPlayed) {
        scene.handleCardPlayed(data);
      }
    },
    onTrickComplete: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleTrickComplete) {
        scene.handleTrickComplete(data);
      }
    },
    // Hand & game end - call GameScene handlers
    onHandComplete: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleHandComplete) {
        scene.handleHandComplete(data);
      }
    },
    onGameEnd: (data) => {
      const scene = getGameScene();

      // Determine which team the player is on (positions 1,3 = Team 1, positions 2,4 = Team 2)
      const position = gameState.position;
      let teamScore, oppScore;
      if (position % 2 !== 0) {
        // Player is on Team 1 (odd positions 1, 3)
        teamScore = data.score.team1;
        oppScore = data.score.team2;
      } else {
        // Player is on Team 2 (even positions 2, 4)
        teamScore = data.score.team2;
        oppScore = data.score.team1;
      }

      // Add game end messages to game log
      const playerData = gameState.playerData;
      const messages = formatGameEndMessages({
        myPosition: position,
        playerData: playerData,
        teamScore: teamScore,
        oppScore: oppScore,
      });
      messages.forEach(msg => window.addToGameFeedFromLegacy(msg));

      // Update game log score display
      const { teamName, oppName } = getTeamNames(position, playerData);
      window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);

      // Show final score overlay
      showFinalScoreOverlay({
        teamScore: teamScore,
        oppScore: oppScore,
        onReturnToLobby: () => {
          // Remove game feed/log
          let gameFeed = document.getElementById("gameFeed");
          if (gameFeed) gameFeed.remove();
          gameLogInstance = null;

          // Remove width restriction from game container
          document.getElementById('game-container')?.classList.remove('in-game');

          // Restart scene and return to main room
          if (scene) {
            scene.scene.restart();
          }
          socket.off("gameStart");
          socket.emit("joinMainRoom");
        }
      });

      // Also call scene handler if it exists
      if (scene && scene.handleGameEnd) {
        scene.handleGameEnd(data);
      }
    },
    onRainbow: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleRainbow) {
        scene.handleRainbow(data);
      }
    },
    onDestroyHands: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleDestroyHands) {
        scene.handleDestroyHands(data);
      }
    },
    // Error & connection handlers
    onAbortGame: (data) => {
      console.log("Handling abortGame");
      const scene = getGameScene();

      // Clear scene player info
      if (scene && scene.clearPlayerInfo) {
        scene.clearPlayerInfo();
      }

      // Use scene handler if available
      if (scene && scene.handleAbortGame) {
        scene.handleAbortGame(data);
      }

      // Clean up DOM backgrounds
      if (scene && scene.layoutManager) {
        scene.layoutManager.cleanupDomBackgrounds();
      }

      // Clear all UI
      uiManager.clearUI();

      // Remove game log
      let gameFeed = document.getElementById("gameFeed");
      if (gameFeed) gameFeed.remove();
      gameLogInstance = null;

      // Remove width restriction from game container
      document.getElementById('game-container')?.classList.remove('in-game');

      // Clear scene reference in modular code
      clearGameScene();

      // Restart scene and return to main room
      if (scene) {
        scene.children.removeAll(true);
        scene.scene.restart();
      }
      socket.emit("joinMainRoom");
    },
    onRoomFull: (data) => {
      console.log('Room full:', data);
      uiManager.removeWaitingScreen();
      // Return to main room (this shouldn't happen with lobby system)
      socket.emit("joinMainRoom");
    },
    // Reconnection handlers
    onPlayerDisconnected: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerDisconnected) {
        scene.handlePlayerDisconnected(data);
      }
    },
    onPlayerReconnected: (data) => {
      const scene = getGameScene();
      if (scene && scene.handlePlayerReconnected) {
        scene.handlePlayerReconnected(data);
      }
    },
    onRejoinSuccess: (data) => {
      console.log("🔄 Processing rejoin with data:", data);

      // Clear any sign-in/lobby screens first
      uiManager.removeAllVignettes();
      const signInContainer = document.getElementById("signInContainer");
      if (signInContainer) signInContainer.remove();
      const lobbyContainer = document.getElementById("lobbyContainer");
      if (lobbyContainer) lobbyContainer.remove();
      const signInContainer2 = document.getElementById("sign-in-container");
      if (signInContainer2) signInContainer2.remove();

      // Remove any overlays
      uiManager.removeWaitingScreen();

      // Helper function to process rejoin after scene is ready
      const processRejoinData = () => {
        console.log("🔄 Scene ready, processing rejoin UI...");
        const scene = getGameScene();

        // Clean up draw phase via DrawManager (if present)
        if (scene && scene.drawManager) {
          scene.drawManager.cleanup();
        }

        // Create game UI elements (pass true to indicate reconnection)
        window.createGameFeedFromLegacy(true);

        // Restore game log history from server
        if (data.gameLog && data.gameLog.length > 0) {
          console.log(`🔄 Restoring ${data.gameLog.length} game log entries`);
          data.gameLog.forEach(entry => {
            window.addToGameFeedFromLegacy(entry.message, entry.playerPosition, entry.timestamp);
          });
        }

        // Calculate player names and update game log score
        const position = gameState.position;
        const playerData = gameState.playerData;
        if (playerData && position) {
          const { teamName, oppName } = getTeamNames(position, playerData);
          const teamScore = gameState.teamScore;
          const oppScore = gameState.oppScore;
          window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);
        }

        // Initialize managers with player position for reconnection
        if (scene && data.position) {
          if (scene.trickManager) {
            scene.trickManager.setPlayerPosition(data.position);
            scene.trickManager.updatePlayPositions();
          }
          if (scene.opponentManager) {
            scene.opponentManager.setPlayerPosition(data.position);
          }
          if (scene.effectsManager) {
            scene.effectsManager.setPlayerPosition(data.position);
          }

          // Display trump card
          if (data.trump && scene.displayTrumpCard) {
            scene.displayTrumpCard(data.trump);
          }

          // Display player hand via CardManager (skip animation on rejoin)
          if (scene.handleDisplayHand && data.hand) {
            scene.handleDisplayHand(data.hand, true);
          }

          // Display opponent hands via OpponentManager (skip animation on rejoin)
          if (scene.handleDisplayOpponentHands && data.hand) {
            scene.handleDisplayOpponentHands(
              data.hand.length,
              data.dealer,
              gameState.playerData,
              true // skip animation on rejoin
            );
          }

          // Create player info box (avatar, name, position text) via scene method
          if (scene.createPlayerInfoBox && !scene._playerInfo) {
            scene.createPlayerInfoBox(gameState.playerData, data.position);
          }

          // Update player position text (BTN, MP, CO, UTG)
          if (scene.updatePlayerPositionText && data.dealer !== undefined) {
            scene.updatePlayerPositionText(data.dealer, data.position);
          }

          // Create DOM backgrounds via LayoutManager
          if (scene.layoutManager) {
            scene.layoutManager.update();
            scene.layoutManager.createDomBackgrounds();
          }

          // Restore played cards in current trick via TrickManager
          if (data.playedCards && data.playedCards.length > 0 && scene.trickManager) {
            scene.trickManager.restorePlayedCards(data.playedCards);
            console.log(`🔄 Restored played cards from current trick via TrickManager`);
          }

          // Update card legality after restoring state
          if (scene.cardManager) {
            const canPlay = !gameState.isBidding &&
                            gameState.currentTurn === gameState.position &&
                            !gameState.hasPlayedCard;
            const legalityChecker = (card) => {
              const result = isLegalMove(
                card,
                gameState.myCards,
                gameState.leadCard,
                gameState.playedCardIndex === 0,
                gameState.trump,
                gameState.trumpBroken,
                gameState.position,
                gameState.leadPosition
              );
              return result.legal;
            };
            scene.cardManager.updateCardLegality(legalityChecker, canPlay);
          }

          // Create bid UI via BidManager (only if still in bidding phase)
          if (scene.bidManager && data.hand && gameState.isBidding) {
            scene.bidManager.showBidUI(data.hand.length, (bid) => {
              console.log(`📩 Sending bid: ${bid}`);
              if (window.socket) {
                window.socket.emit('playerBid', { position: gameState.position, bid });
              }
            });
          }
        }

        // Add reconnected message to game feed
        window.addToGameFeedFromLegacy("Reconnected to game!");

        // Call scene handler for any additional rejoin logic
        if (scene && scene.handleRejoinSuccess) {
          scene.handleRejoinSuccess(data);
        }
      };

      // Wait for scene to be ready before processing UI
      const waitForScene = () => {
        const scene = getGameScene();
        if (scene && scene.cardManager) {
          processRejoinData();
        } else {
          console.log("🔄 Waiting for scene to be ready...");
          setTimeout(waitForScene, 100);
        }
      };

      // Update GameState from rejoin data first (synchronously)
      if (data.position) gameState.position = data.position;
      if (data.hand) gameState.setCards(data.hand);
      if (data.trump) gameState.setTrump(data.trump);
      if (data.dealer !== undefined) gameState.dealer = data.dealer;
      if (data.currentTurn !== undefined) gameState.setCurrentTurn(data.currentTurn);

      // Server sends 'bidding', client uses 'isBidding'
      const bidding = data.isBidding !== undefined ? data.isBidding : data.bidding;
      if (bidding !== undefined) {
        gameState.isBidding = bidding;
        gameState.phase = bidding ? PHASE.BIDDING : PHASE.PLAYING;
      }

      // Extract lead card and played count from playedCards array
      if (data.playedCards && Array.isArray(data.playedCards)) {
        let foundLead = false;
        let playedCount = 0;
        data.playedCards.forEach((card, index) => {
          if (card) {
            playedCount++;
            if (!foundLead) {
              gameState.leadCard = card;
              gameState.leadPosition = index + 1; // positions are 1-indexed
              foundLead = true;
            }
          }
        });
        gameState.playedCardIndex = playedCount;
      } else {
        if (data.leadCard) gameState.leadCard = data.leadCard;
        if (data.leadPosition !== undefined) gameState.leadPosition = data.leadPosition;
        if (data.playedCardIndex !== undefined) gameState.playedCardIndex = data.playedCardIndex;
      }

      // Server uses isTrumpBroken, client uses trumpBroken
      const trumpBroken = data.trumpBroken !== undefined ? data.trumpBroken : data.isTrumpBroken;
      if (trumpBroken !== undefined) gameState.trumpBroken = trumpBroken;
      gameState.hasPlayedCard = false; // Reset for current trick

      // Update scores from rejoin data
      if (data.score) {
        const position = gameState.position;
        if (position % 2 !== 0) {
          gameState.setGameScores(data.score.team1, data.score.team2);
        } else {
          gameState.setGameScores(data.score.team2, data.score.team1);
        }
      }

      // Now wait for scene to be ready before processing UI
      waitForScene();
    },
    onRejoinFailed: (data) => {
      const scene = getGameScene();
      if (scene && scene.handleRejoinFailed) {
        scene.handleRejoinFailed(data);
      }
    },

    // Chat callback - add to game feed and show bubble
    onChatMessage: (data) => {
      const scene = getGameScene();
      const state = getGameState();

      // Get sender name from player data or fall back to username in data
      const senderName = data.username || getPlayerName(data.position, state.playerData);

      // Add to game feed with player position for color coding
      if (scene && scene.handleAddToGameFeed) {
        scene.handleAddToGameFeed(`${senderName}: ${data.message}`, data.position);
      } else if (window.addToGameFeedFromLegacy) {
        window.addToGameFeedFromLegacy(`${senderName}: ${data.message}`, data.position);
      }

      // Show chat bubble at appropriate position
      if (scene && scene.handleShowChatBubble && state.position) {
        scene.handleShowChatBubble(state.position, data.position, data.message);
      }
    },

    // Profile callbacks
    onProfileReceived: (profile) => {
      showProfilePage(profile, socket);
    },
    onProfileError: (message) => {
      showError(message || 'Failed to load profile');
    },
    onProfilePicUpdated: (newPic) => {
      updateProfilePicDisplay(newPic);
      showSuccess('Profile picture updated!');
    },
    onProfilePicUpdateError: (message) => {
      showError(message || 'Failed to update profile picture');
    },
    onCustomProfilePicUploaded: (customPic) => {
      updateCustomProfilePicDisplay(customPic);
      showSuccess('Profile picture uploaded!');
    },
    onCustomProfilePicUploadError: (message) => {
      showError(message || 'Failed to upload profile picture');
    },
  });

  // Note: window.socket and window.socketManager are already set at module level above

  console.log('App initialization complete');
}

/**
 * Show the sign-in screen with proper callbacks.
 */
function displaySignInScreen() {
  // Pre-fill username if we have it stored (e.g., after failed rejoin)
  const storedUsername = sessionStorage.getItem('username') || '';

  showSignInScreen({
    onSignIn: ({ username, password }) => {
      console.log('Signing in as:', username);
      socket.emit('signIn', { username, password });
    },
    onCreateAccount: ({ username, password }) => {
      console.log('Creating account, showing register screen');
      // Remove sign-in screen
      const signInContainer = document.getElementById('sign-in-container');
      if (signInContainer) signInContainer.remove();
      const signInVignette = document.getElementById('sign-in-vignette');
      if (signInVignette) signInVignette.remove();
      // Show register screen
      displayRegisterScreen(username, password);
    },
    prefill: {
      username: storedUsername,
    },
  });
}

/**
 * Show the register screen with proper callbacks.
 */
function displayRegisterScreen(prefillUsername = '', prefillPassword = '') {
  showRegisterScreen({
    onRegister: ({ username, password }) => {
      console.log('Registering as:', username);
      socket.emit('signUp', { username, password });
    },
    onBackToSignIn: () => {
      // Remove register screen
      const registerContainer = document.getElementById('register-container');
      if (registerContainer) registerContainer.remove();
      const registerVignette = document.getElementById('register-vignette');
      if (registerVignette) registerVignette.remove();
      // Show sign-in screen
      displaySignInScreen();
    },
    prefill: {
      username: prefillUsername,
      password: prefillPassword,
    },
  });
}

/**
 * Attempt to restore session using stored token.
 * Called when we have username and sessionToken in sessionStorage.
 */
function attemptSessionRestore() {
  const username = sessionStorage.getItem('username');
  const sessionToken = sessionStorage.getItem('sessionToken');

  if (!username || !sessionToken) {
    console.log('No session to restore, showing sign-in');
    displaySignInScreen();
    return;
  }

  console.log(`Attempting to restore session for ${username}`);
  window.socket.emit('restoreSession', { username, sessionToken });
}

// Handle restoreSessionResponse
socket.on('restoreSessionResponse', (data) => {
  if (data.success) {
    console.log('Session restored successfully');
    const gameState = getGameState();
    gameState.username = data.username;

    // Check if user has an active game to rejoin
    if (data.activeGameId) {
      console.log(`Active game found: ${data.activeGameId}, attempting to rejoin...`);
      sessionStorage.setItem('gameId', data.activeGameId);
      socket.emit('rejoinGame', { gameId: data.activeGameId, username: data.username });
    } else {
      // Go to main room
      console.log('Session restored, joining main room');
      socket.emit('joinMainRoom');
    }
  } else {
    console.log('Session restore failed:', data.message);
    // Clear invalid session data
    sessionStorage.removeItem('username');
    sessionStorage.removeItem('sessionToken');
    sessionStorage.removeItem('gameId');
    displaySignInScreen();
  }
});

/**
 * Handle window load - show sign-in or attempt rejoin.
 */
window.addEventListener('load', () => {
  // Initialize the app
  initializeApp();

  // Create the Phaser game - GameScene.create() will call setGameScene
  createPhaserGame('game-container');

  // Check if user is logged in and was in a game
  const username = sessionStorage.getItem('username');
  const sessionToken = sessionStorage.getItem('sessionToken');
  const gameId = sessionStorage.getItem('gameId');

  console.log(`Window load: username=${username}, sessionToken=${sessionToken ? 'present' : 'none'}, gameId=${gameId}`);

  if (!username) {
    // Not logged in - show sign-in screen
    console.log('No username, showing sign-in screen');
    displaySignInScreen();
  } else if (gameId) {
    // Was in a game - attempt rejoin now that handlers are registered
    console.log(`User ${username} has pending game ${gameId}, attempting rejoin...`);
    if (window.socket.connected && !rejoinAttempted) {
      rejoinAttempted = true;
      window.socket.emit('rejoinGame', { gameId, username });
    } else if (!window.socket.connected) {
      // Socket not connected yet - wait for connect then rejoin
      window.socket.once('connect', () => {
        if (!rejoinAttempted) {
          rejoinAttempted = true;
          window.socket.emit('rejoinGame', { gameId, username });
        }
      });
    }
  } else if (sessionToken) {
    // Have stored session - try to restore it
    console.log('Session token found, attempting to restore session');

    // Check if socket is already connected
    if (window.socket.connected) {
      attemptSessionRestore();
    } else {
      // Wait for socket to connect, then restore session
      window.socket.once('connect', () => {
        if (!sessionStorage.getItem('gameId')) {
          attemptSessionRestore();
        }
      });
    }
  } else {
    // Have username but no session token (legacy) - show sign-in
    console.log('No session token, showing sign-in screen');
    displaySignInScreen();
  }
});
