/**
 * Main game scene for the Phaser game.
 *
 * A view of GameState: render(model) draws the whole table from the
 * snapshot-shaped model (GameState.renderModel) and is idempotent; the
 * handle* methods animate one applied event. The scene never writes table
 * state (handlers/gameHandlers.js does); every delayedCall and tween goes
 * through the TableDirector (this.director), which owns and cancels them.
 *
 * Layout (item 17): every anchor comes from getLayout()
 * (layout/computeTableLayout.js, a pure function of the canvas size); the
 * DOM pieces live in the HUD (ui/tableHud.js). relayout() runs on every
 * resize: a table with work in flight fast-forwards to the model (the
 * director's render at the new size), else every manager snaps to the new
 * layout.
 */

import { avatarSrc, applyAvatarImg, isAvatarPic } from '../../utils/avatar.js';
import { getGameState } from '../../state/GameState.js';
import { getCardImageKey, sortHand } from '../../utils/cards.js';
import { team, rotate } from '../../utils/positions.js';
import { isLegalMove } from '../../rules/legality.js';
import { ANIMATION_CONFIG } from '../config.js';
import { reattachMuteButton } from '../../ui/components/VoiceChatUI.js';
import { CardManager } from '../managers/CardManager.js';
import { OpponentManager } from '../managers/OpponentManager.js';
import { TrickManager } from '../managers/TrickManager.js';
import { EffectsManager } from '../managers/EffectsManager.js';
import { DrawManager } from '../managers/DrawManager.js';
import { flyInMs, FLIP } from '../pacing.js';
import { transitionGeneration, getTransitionOverlay, createTransitionOverlay, releaseTransitionOverlay, setOverlayState } from '../../ui/transitionOverlay.js';
import { getTableDirector, sceneDelay, sceneTween, UI_READY_DELAY_MS, FLIP_AFTER_DEAL_MS, FLIP_AFTER_FADE_MS } from '../TableDirector.js';
import { getMyAction } from '../../state/MyAction.js';
import { BidManager } from '../managers/BidManager.js';
import { LayoutManager } from '../managers/LayoutManager.js';
import { showChatBubble as showChatBubbleUI } from '../../ui/components/ChatBubble.js';
import { computeTableLayout, logWidthFor } from '../layout/computeTableLayout.js';
import { applyHudLayout, hudSeat, hudRoot, logColumnWidth, getHud } from '../../ui/tableHud.js';
import { buildAvatarRing, updateSeatPlates } from '../../ui/seatPlates.js';
import { resizeShape } from '../shapes.js';
import { cssSize, zoomCamera } from '../backingStore.js';
import { ensureCardAtlas, refreshCardSprites, CARD_TEXTURE_KEY } from '../cards/CardAtlas.js';
import { BACK_FRAME } from '../cards/cardFaces.js';
import { uiTextStyle, refreshTextResolution } from '../text.js';
import { COLOR, hex, alpha } from '../../ui/tokens.js';
import { motionMs, EASE_EMPHASIZED } from '../../ui/motion.js';

/**
 * Main game scene class.
 */
export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });

    // State reference
    this.state = null;

    // Managers (instantiated in create())
    this.cardManager = null;
    this.opponentManager = null;
    this.trickManager = null;
    this.effectsManager = null;
    this.drawManager = null;
    this.bidManager = null;
    this.layoutManager = null;

    // Trump display (CardManager/OpponentManager read tableCardSprite)
    this.tableCardSprite = null;
    this.tableCardBackground = null;
    this.tableCardLabel = null;

    // Own avatar box (DOM, outside the canvas): createPlayerInfoBox. Not
    // reset by a scene restart (the constructor runs once); clearPlayerInfo
    // removes it
    this._playerInfo = null;
  }

  /**
   * The table layout for the canvas as it is now (cached by size, role,
   * log column and pixel ratio). The canvas size is in CSS pixels: the
   * backing store is that times the ratio (backingStore.cssSize).
   */
  getLayout() {
    const css = cssSize(this.scale);
    const w = css.w || 1920;
    const h = css.h || 953;
    const dpr = css.dpr;
    const state = this.state;
    const spectator = this._spectatorView ?? !!(state?.isSpectator && !state?.isLazy);
    const vw = typeof window !== 'undefined' ? window.innerWidth : w;
    const logW = typeof document !== 'undefined' ? logColumnWidth({ fallback: () => logWidthFor(vw) }) : 0;
    const key = `${w}x${h}:${spectator ? 'spec' : 'seat'}:${logW}:${dpr}`;
    if (!this._layout || this._layout.key !== key) {
      const layout = computeTableLayout({ w, h, dpr, isSpectator: spectator, logW });
      this._layout = { key, layout };
      // the atlas always matches the layout its sprite scales are for
      this.ensureCardTextures(layout);
    }
    return this._layout.layout;
  }

  /** A sprite scale of the current layout ('hand', 'trick', 'back', 'trump', ...). */
  cardScale(kind) {
    return this.getLayout().card[kind].scale;
  }

  /**
   * The card atlas at the layout's frame size (hand card x DPR): drawn and
   * uploaded only when that size changes; the card sprites on the table then
   * take the new frames (their scales come with the relayout or render).
   * @returns {{changed: boolean, spec: Object, bytes: number}}
   */
  ensureCardTextures(layout = this.getLayout()) {
    const r = ensureCardAtlas(this.textures, layout.cardTexture);
    if (r.changed) refreshCardSprites(this);
    return r;
  }

  // ============================================
  // Phaser Lifecycle Methods
  // ============================================

  preload() {
    console.log('🎮 GameScene.preload() running...');

    // The cards are drawn, not loaded (cards/CardAtlas.js: one canvas
    // texture at the device pixel ratio, built in create)

    // Effect art
    this.load.image('rainbow', 'assets/rainbow1.png');
    this.load.image('ot', 'assets/ot.png');
    this.load.image('b', 'assets/b.png');
    this.load.image('2b', 'assets/2b.png');
    this.load.image('3b', 'assets/3b.png');
    this.load.image('4b', 'assets/4b.png');

    // Profile avatars are DOM <img> elements loaded on demand; they are not
    // preloaded as Phaser textures (~18 MB download, ~120 MB of GPU memory)
  }

  create() {
    console.log('🎮 GameScene.create() running...');

    // Get state reference
    this.state = getGameState();
    this._spectatorView = undefined;
    this._layout = null;

    // The director owns every timer and tween of this scene's table work
    // (main.js attaches it in setGameScene; a shutdown cancels it all)
    this.director = getTableDirector();

    // World units are CSS pixels; the camera draws them at the backing
    // store's ratio. The card atlas for this layout (one canvas texture)
    zoomCamera(this);
    this.ensureCardTextures();

    // Instantiate managers
    this.layoutManager = new LayoutManager(this);
    this.cardManager = new CardManager(this);
    this.opponentManager = new OpponentManager(this);
    this.trickManager = new TrickManager(this);
    this.effectsManager = new EffectsManager(this);
    this.drawManager = new DrawManager(this);
    this.bidManager = new BidManager(this);

    // Initialize layout
    this.layoutManager.update();

    console.log('🎮 Managers instantiated');

    // Set up resize handler. this.scale is the game-wide ScaleManager, which
    // outlives scene restarts, so remove the listener on shutdown
    const onScaleResize = (gameSize) => {
      console.log(`📐 Phaser resize: ${gameSize.width}x${gameSize.height}`);
      this.handleResize(gameSize.width, gameSize.height);
    };
    this.scale.on('resize', onScaleResize);
    this.events.once('shutdown', () => {
      this.scale.off('resize', onScaleResize);
      if (this.director?.scene === this) this.director.detach();
    });

    // Register this scene with main.js for external access
    if (window.ModernUtils && window.ModernUtils.setGameScene) {
      window.ModernUtils.setGameScene(this);
      console.log('🎮 GameScene registered with ModernUtils');
    }

    console.log('🎮 GameScene.create() complete!');
  }

  update() {
    // Empty - we don't need per-frame updates
  }

  // ============================================
  // Resize Handling
  // ============================================

  /**
   * Handle window/container resize (Phaser's scale 'resize').
   */
  handleResize(newWidth, newHeight) {
    try {
      this.relayout();
    } catch (e) {
      console.error('❌ Error in handleResize:', e);
    }
  }

  /**
   * Lay the whole table out again for the current canvas (one layout for
   * Phaser and the HUD). Work in flight (a deal, a fly-in, a collect, the
   * whisk) would land at the old anchors: the director fast-forwards to
   * the model instead, a render at the new size. Otherwise every manager
   * snaps to the new anchors and scales.
   * @returns {Object} the layout
   */
  relayout() {
    this._layout = null;
    const layout = this.getLayout();
    // a ratio change (another display) zooms the camera, redraws the
    // atlas at the new frame size and re-rasterises the text
    zoomCamera(this);
    this.ensureCardTextures(layout);
    refreshTextResolution(this);
    applyHudLayout(layout);
    if (this.layoutManager) {
      this.layoutManager.update();
      this.layoutManager.positionDomBackgrounds();
    }
    if (this.director?.settleForRelayout?.(this)) return layout;

    this.cardManager?.repositionHand();
    this.opponentManager?.reposition();
    this.trickManager?.repositionCurrentTrick();
    this.repositionTrumpDisplay();
    this.drawManager?.relayout?.();
    this.effectsManager?.relayout?.();
    reattachMuteButton();
    return layout;
  }

  /**
   * Reposition trump card display.
   */
  repositionTrumpDisplay() {
    const { trump } = this.getLayout();

    if (this.tableCardSprite && this.tableCardSprite.active) {
      const sprite = this.tableCardSprite;
      sprite.setPosition(trump.x, trump.y);
      // the layout's scale; a card mid-flip keeps its flip (scaleX: the
      // flip's second half lands on scaleY, so it reaches the new size).
      // Only the 300 ms flip itself, not the wait before it: the first
      // hand's face-down trump is drawn before the log column narrows the
      // canvas, and must not keep that size all hand
      const flipping = sprite.getData?.('flipping') && (!this.director || this.director.pending('deal') > 0);
      if (flipping) sprite.scaleY = trump.card.scale;
      else sprite.setScale(trump.card.scale);
    }
    if (this.tableCardBackground && this.tableCardBackground.active) {
      this.tableCardBackground.setPosition(trump.x, trump.y);
      resizeShape(this.tableCardBackground, trump.box, trump.box);
    }
    if (this.tableCardLabel && this.tableCardLabel.active) {
      this.tableCardLabel.setPosition(trump.label.x, trump.label.y);
      this.tableCardLabel.setFontSize?.(trump.label.font);
    }
  }

  /** Destroy the trump card, its box and its label. */
  clearTrumpDisplay() {
    for (const k of ['tableCardSprite', 'tableCardBackground', 'tableCardLabel']) {
      if (this[k]) {
        this[k].destroy();
        this[k] = null;
      }
    }
  }

  /**
   * Display trump card on table.
   * @param {Object} trumpCard
   * @param {Object} [options]
   * @param {boolean} [options.faceUp=false] - already revealed (a render): no flip
   * @param {number} [options.flipDelay] - ms until the flip (default: after the deal)
   * @param {Function} [options.onFlipped] - after the flip, for this deal only
   */
  displayTrumpCard(trumpCard, { faceUp = false, flipDelay, onFlipped } = {}) {
    const { trump } = this.getLayout();
    const trumpX = trump.x;
    const trumpY = trump.y;
    const trumpScale = trump.card.scale;

    // Clear existing
    this.clearTrumpDisplay();

    // Card - face down until the deal reveals it, same scale as player hand cards
    const cardKey = getCardImageKey(trumpCard);
    this.tableCardSprite = faceUp
      ? this.add.image(trumpX, trumpY, CARD_TEXTURE_KEY, cardKey)
      : this.add.image(trumpX, trumpY, CARD_TEXTURE_KEY, BACK_FRAME);
    this.tableCardSprite.setScale(trumpScale);
    this.tableCardSprite.setDepth(100);

    // Background - box around card with padding (the layout's box): a
    // surface tile with a gold hairline (gold marks the trump)
    this.tableCardBackground = this.add.rectangle(trumpX, trumpY, trump.box, trump.box, hex(COLOR.surface.s1), 0.55);
    this.tableCardBackground.setStrokeStyle(1, hex(COLOR.gold), 0.55);
    this.tableCardBackground.setDepth(99);

    // Label - above the card (a readable size: ui-7)
    this.tableCardLabel = this.add.text(trump.label.x, trump.label.y, 'TRUMP', uiTextStyle(this, {
      fontSize: `${trump.label.font}px`,
      weight: 'semibold',
      color: COLOR.gold,
    }));
    this.tableCardLabel.setOrigin(0.5);
    this.tableCardLabel.setDepth(100);

    if (faceUp) return;

    // Flip the trump face up once every hand is dealt (the first hand also
    // waits for createUI's fade). The flip belongs to this deal: a later
    // deal, a render or a teardown cancels it, so onFlipped (the bid panel)
    // never fires for another hand (cli-19, ui-22)
    const delay = flipDelay ?? (this.director && !this.director.uiReady ? FLIP_AFTER_FADE_MS : FLIP_AFTER_DEAL_MS);
    // cosmetic: the slow token (two halves), instant under reduced motion
    const flipDuration = motionMs('slow');
    const sprite = this.tableCardSprite;

    sceneDelay(this, delay, () => {
      if (!sprite || !sprite.scene) return;
      sprite.setData('flipping', true);
      // Phase 1: Scale X to 0 (flip start)
      sceneTween(this, {
        targets: sprite,
        scaleX: 0,
        duration: flipDuration / 2,
        ease: EASE_EMPHASIZED,
        onComplete: () => {
          if (!sprite || !sprite.scene) return;
          // Change to face up texture
          sprite.setTexture(CARD_TEXTURE_KEY, cardKey);
          // Phase 2: Scale X back (flip complete)
          sceneTween(this, {
            targets: sprite,
            scaleX: sprite.scaleY || trumpScale,
            duration: flipDuration / 2,
            ease: EASE_EMPHASIZED,
            onComplete: () => {
              if (!sprite.scene) return;
              sprite.setData('flipping', false);
              // a relayout during this half moved scaleY: land on it
              sprite.setScale(sprite.scaleY);
              onFlipped?.();
            },
          }, { scope: 'deal' });
        },
      }, { scope: 'deal' });
    }, { scope: 'deal' });
  }

  // ============================================
  // Game Feed Methods
  // ============================================

  /**
   * Add a message to the game feed/log.
   * @param {string} message - The message to add
   * @param {number|null} playerPosition - Player position for color coding (optional)
   */
  handleAddToGameFeed(message, playerPosition = null) {
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy(message, playerPosition);
    }
  }

  // ============================================
  // Chat Bubble Methods
  // ============================================

  /**
   * Handle showing a chat bubble from a chat message event.
   * @param {number} myPosition - The local player's position
   * @param {number} senderPosition - The position of the message sender
   * @param {string} message - The chat message text
   */
  handleShowChatBubble(myPosition, senderPosition, message) {
    // Determine which position key the sender maps to relative to the player
    const positionKey = this.getPositionKey(senderPosition);
    if (positionKey) {
      this.showChatBubble(positionKey, message, null, 6000);
    }
  }

  /**
   * Show a chat/bid bubble on a seat: a child of the seat's HUD node, at
   * the seat's bubble anchor from the layout (it follows the avatar).
   */
  showChatBubble(positionKey, message, kind = null, duration = 6000) {
    if (!positionKey) return;
    showChatBubbleUI(positionKey, message, kind, duration);
  }

  // ============================================
  // Draw Phase Handlers
  // ============================================

  /**
   * Handle startDraw event - show the draw UI.
   * @param {Object} data - Event data from server
   */
  handleStartDraw(data) {
    console.log('🎮 GameScene.handleStartDraw()');
    this.drawManager.showDrawUI();
  }

  /**
   * Handle youDrew event - player drew a card.
   * @param {Object} data - { card }
   */
  handleYouDrew(data) {
    console.log('🎮 GameScene.handleYouDrew()');
    this.drawManager.handleYouDrew(data);
  }

  /**
   * Handle playerDrew event - any player drew a card.
   * @param {Object} data - { username, card, drawOrder, position }
   */
  handlePlayerDrew(data) {
    console.log('🎮 GameScene.handlePlayerDrew()');
    this.drawManager.handlePlayerDrew(data);
  }

  /**
   * Handle teamsAnnounced event - show teams overlay.
   * @param {Object} data - { team1: [], team2: [] }
   */
  handleTeamsAnnounced(data) {
    console.log('🎮 GameScene.handleTeamsAnnounced()');
    this.drawManager.handleTeamsAnnounced(data);
  }

  /**
   * Handle createUI event - transition from draw to game.
   * @param {Object} data - Event data from server
   * @param {Function} onUIReady - Callback to create UI elements (called after fade to black)
   */
  handleCreateUI(data, onUIReady) {
    console.log('🎮 GameScene.handleCreateUI()');

    const fadeDuration = 1200;
    const scene = this;
    const director = this.director;

    // The first deal waits for this fade (director.uiReady), whether or not
    // the teams fade put an overlay up
    director?.beginFade();

    // The overlay the teams fade created, else an opaque one now
    let overlay = getTransitionOverlay();

    if (!overlay) {
      overlay = createTransitionOverlay({ opacity: 1, blocking: true });
      // Overlay is already opaque, proceed immediately
      proceedWithTransition();
    } else {
      // Overlay exists - wait for it to become fully opaque
      // Force it to full opacity immediately to ensure nothing shows through
      setOverlayState(overlay, { ms: 0, opaque: true, blocking: true });

      // Proceed after a frame to ensure opacity is applied
      requestAnimationFrame(() => {
        proceedWithTransition();
      });
    }

    function proceedWithTransition() {
      // Clean up draw phase (hidden behind black overlay)
      scene.drawManager.cleanup();

      // Create the play UI (hidden behind the overlay)
      onUIReady?.();

      // Wait for next frame to ensure UI is rendered, then fade out
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Add transition and fade out
          setOverlayState(overlay, { ms: fadeDuration, blocking: false });

          // Force reflow
          overlay.offsetHeight;

          // Listen for fade to complete. transitionend is not guaranteed
          // (no event when the transition is skipped, e.g. a style flush
          // the browser coalesces), so a timer finishes the fade as well
          let finished = false;
          const gen = transitionGeneration();
          const onFadeComplete = () => {
            if (finished) return;
            finished = true;
            overlay.removeEventListener('transitionend', onFadeComplete);
            clearTimeout(fallback);
            // A rejoin or exit removed the overlay meanwhile and owns the UI
            if (transitionGeneration() !== gen) return;
            releaseTransitionOverlay(overlay);

            // The first deal may show now (after a short delay)
            setTimeout(() => {
              if (transitionGeneration() !== gen) return;
              director?.endFade();
            }, UI_READY_DELAY_MS);
          };
          overlay.addEventListener('transitionend', onFadeComplete);
          const fallback = setTimeout(onFadeComplete, fadeDuration + 250);

          // Fade out to reveal play screen
          setOverlayState(overlay, { opaque: false });
        });
      });
    }
  }

  // ============================================
  // Bidding Phase Handlers
  // ============================================

  /**
   * Handle bidReceived event - show bid bubble, impact events, update game log.
   * (GameState already recorded the bid.)
   * @param {Object} data - { position, bid, bidArray }
   */
  handleBidReceived(data) {
    console.log('🎮 GameScene.handleBidReceived()');

    const bidStr = String(data.bid).toUpperCase();

    // Show impact event for bore bids
    if (this.effectsManager) {
      if (bidStr === 'B') this.effectsManager.showImpactEvent('b');
      if (bidStr === '2B') this.effectsManager.showImpactEvent('2b');
      if (bidStr === '3B') this.effectsManager.showImpactEvent('3b');
      if (bidStr === '4B') this.effectsManager.showImpactEvent('4b');
    }

    // Update bore button states (from state.tempBids)
    if (this.bidManager) {
      this.bidManager.updateBoreButtonStates();
    }

    // Show bid bubble at the appropriate position
    const positionKey = this.getPositionKey(data.position);
    if (positionKey && this.bidManager) {
      this.bidManager.showBidBubble(positionKey, data.bid);
    }

    // Add to game feed
    const playerName = this.getPlayerNameForPosition(data.position);
    const feedMessage = `${playerName} bid ${data.bid}.`;
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy(feedMessage);
    }

    // Update game log score with bid info
    this.renderScoreHeader();
  }

  /**
   * Get player name for a position.
   */
  getPlayerNameForPosition(pos) {
    if (window.ModernUtils && window.ModernUtils.getPlayerName) {
      return window.ModernUtils.getPlayerName(pos, this.state.playerData);
    }
    return `Player ${pos}`;
  }

  /**
   * The game log's score header, projected from GameState: names, scores,
   * bids (mine/partner vs the opponents, '-' until placed) and tricks. Every
   * change redraws all of it, so no field can go stale (the spectator's
   * "Bids: 0/2" after a re-spectate).
   */
  renderScoreHeader() {
    const state = this.state;
    if (!window.updateGameLogScoreFromLegacy || !state) {
      this.updateSeatPlates?.();
      return;
    }
    const pos = state.position || 1;
    const names = window.ModernUtils?.getTeamNames?.(pos, state.playerData);
    const teamName = names?.teamName ?? `${state.username}/${state.partnerName}`;
    const oppName = names?.oppName ?? `${state.opp1Name}/${state.opp2Name}`;
    const bid = (p) => state.bids?.[p] ?? '-';
    const anyBid = Object.keys(state.bids || {}).length > 0;
    const teamBids = anyBid ? `${bid(pos)}/${bid(team(pos))}` : '-/-';
    const oppBids = anyBid ? `${bid(rotate(pos))}/${bid(rotate(rotate(rotate(pos))))}` : '-/-';
    window.updateGameLogScoreFromLegacy(
      teamName, oppName,
      state.teamScore || 0, state.oppScore || 0,
      teamBids, oppBids,
      state.teamTricks || 0, state.oppTricks || 0
    );
    this.updateSeatPlates?.();
  }

  /** Every seat's bid chip and trick pips, projected from GameState (ui/seatPlates.js). */
  updateSeatPlates() {
    const hud = getHud({ create: false });
    if (hud && this.state) updateSeatPlates(hud, this.state);
  }

  /**
   * Handle doneBidding event - transition to playing phase (the state is
   * already in PLAYING).
   * @param {Object} data - { bids, lead }
   */
  handleDoneBidding(data) {
    console.log('🎮 GameScene.handleDoneBidding()', data);

    // Hide bid UI
    if (this.bidManager) {
      this.bidManager.hideBidUI();
    }

    // Update card legality now that bidding is over
    // The lead player can play any card, others are dimmed
    if (this.cardManager) {
      const canPlay = this.state.currentTurn === this.state.position && !this.state.isLazy && !this.state.isSpectator;
      // No lead card yet, so all cards are legal for the lead player
      this.cardManager.updateCardLegality(() => true, canPlay);
    }

    // Update turn glow
    const isPureSpectator = this.state.isSpectator && !this.state.isLazy;
    if (this.cardManager && !isPureSpectator) {
      this.cardManager.updatePlayerTurnGlow(this.state.currentTurn, this.state.position);
    }
    if (this.opponentManager) {
      this.opponentManager.updateTurnGlow(this.state.currentTurn);
    }
    this.renderScoreHeader();
  }

  /** Legality of a card in my hand for the trick in play (GameState). */
  legalityChecker() {
    const gameState = this.state;
    const myPosition = gameState.position;
    return (card) => {
      if (window.ModernUtils && window.ModernUtils.isLegalMove) {
        const result = window.ModernUtils.isLegalMove(
          card,
          gameState.myCards,
          gameState.leadCard,
          gameState.playedCardIndex === 0,
          gameState.trump,
          gameState.trumpBroken,
          myPosition,
          gameState.leadPosition
        );
        return result.legal;
      }
      return true;
    };
  }

  /** My bid or play is out and not answered yet (MyAction). */
  _myActionPending() {
    return getMyAction().isPending();
  }

  /**
   * Handle updateTurn event - update turn glow, card legality, and bid UI visibility.
   * @param {Object} data - { currentTurn }
   */
  handleUpdateTurn(data) {
    console.log('🎮 GameScene.handleUpdateTurn()');

    const currentTurn = data.currentTurn;
    const myPosition = this.state.position;
    const isPureSpectator = this.state.isSpectator && !this.state.isLazy;

    // Update turn glow for player's hand (skip for pure spectators — no hand area)
    if (this.cardManager && !isPureSpectator) {
      this.cardManager.updatePlayerTurnGlow(currentTurn, myPosition);
    }

    // Update turn glow for opponents (OpponentManager handles 'bottom' for spectators)
    if (this.opponentManager) {
      this.opponentManager.updateTurnGlow(currentTurn);
    }

    // Update card legality
    // Each updateTurn supersedes any deferred one (see below)
    this._turnToken = (this._turnToken || 0) + 1;
    if (this.cardManager && !this.state.isBidding) {
      const canPlay = currentTurn === myPosition && !this.state.hasPlayedCard && !this.state.isLazy &&
        !isPureSpectator && !this._myActionPending();
      const gameState = this.state;
      const legalityChecker = this.legalityChecker();

      if (canPlay && this.trickManager?.isCollecting?.()) {
        // The previous trick is still flying to its stack: keep the hand
        // dimmed until it lands, then apply THIS turn, unless another
        // updateTurn came meanwhile or the turn moved on. Never derives a
        // turn itself (the hand's last trick sends none: nothing enables)
        const token = this._turnToken;
        this.cardManager.updateCardLegality(legalityChecker, false);
        this.trickManager.onCollected(() => {
          if (this._turnToken !== token || !this.cardManager) return;
          if (gameState.currentTurn !== currentTurn || gameState.hasPlayedCard || gameState.isBidding || gameState.isLazy) return;
          if (this._myActionPending()) return;
          this.cardManager.updateCardLegality(legalityChecker, true);
        });
      } else {
        this.cardManager.updateCardLegality(legalityChecker, canPlay);
      }
    }

    // Update bid UI visibility (only during bidding)
    if (this.bidManager && this.state.isBidding) {
      this.bidManager.updateVisibility();
    }
  }

  /**
   * Get position key ('opp1', 'opp2', 'partner', 'me') from game position.
   * @param {number} gamePosition - Position 1-4
   * @returns {string|null} Position key or null
   */
  getPositionKey(gamePosition) {
    const myPosition = this.state.position;
    if (!myPosition) return null;

    if (gamePosition === myPosition) {
      // Pure spectators see position 1 as 'bottom' opponent slot
      if (this.state.isSpectator && !this.state.isLazy) return 'bottom';
      return 'me';
    }
    if (gamePosition === team(myPosition)) return 'partner';
    if (gamePosition === rotate(myPosition)) return 'opp1';
    if (gamePosition === rotate(rotate(rotate(myPosition)))) return 'opp2';

    return null;
  }

  // ============================================
  // Card Play & Trick Handlers
  // ============================================

  /**
   * Handle cardPlayed event - animate card to play area (GameState already
   * holds the card in the trick).
   * @param {Object} data - { card, position, trump/trumpBroken }
   */
  handleCardPlayed(data) {
    console.log('🎮 GameScene.handleCardPlayed()');

    const myPosition = this.state.position;
    const playedPosition = data.position;
    const card = data.card;

    // Update card legality when lead card is first played
    if (this.state.currentTrick.length === 1) {
      this.updateCardLegalityAfterPlay();
    }

    // Detect over-trump and show effect
    this.detectOverTrump();

    // Initialize TrickManager if needed
    if (this.trickManager && myPosition) {
      this.trickManager.setPlayerPosition(myPosition);
      this.trickManager.updatePlayPositions();
    }

    // Get position key for the player who played
    const positionKey = this.getPositionKey(playedPosition);

    // Handle opponent card animation (includes spectator's view of position 1)
    const isPureSpectator = this.state.isSpectator && !this.state.isLazy;
    const isOpponentPlay = playedPosition !== myPosition || isPureSpectator;
    if (isOpponentPlay && this.opponentManager && this.trickManager) {
      const sprite = this.opponentManager.removeCard(positionKey);
      if (sprite) {
        // Update texture to show the actual card
        const cardKey = getCardImageKey(card);
        const relativeKey = this.trickManager.getRelativePositionKey(playedPosition);
        const targetPos = this.trickManager._playPositions[relativeKey];
        const targetX = targetPos?.x || sprite.x;
        const targetY = targetPos?.y || sprite.y;

        // Stop any deal/hand-layout tween still on the sprite, and record its
        // face and slot so TrickManager can finish an interrupted flip and
        // reposition it on resize
        this.trickManager._stopCardAnimations(sprite);
        sprite.setData('faceKey', cardKey);
        sprite.setData('playPosition', relativeKey);

        // Animate move and flip simultaneously
        // Move to play position. Keep the handle: a tween added while the tab
        // is hidden is still queued, and killTweensOf cannot see it.
        // The trick-completing card lands within a quarter of the server's
        // hold (resumeInMs), so the full trick is visible before the collect
        const flyMs = flyInMs(data.resumeInMs);
        const flipHalf = Math.min(FLIP.HALF, flyMs / 2);
        const trickScale = this.cardScale('trick');
        const moveTween = sceneTween(this, {
          targets: sprite,
          x: targetX,
          y: targetY,
          duration: flyMs,
          ease: EASE_EMPHASIZED,
          rotation: 0,
          scale: trickScale,
          onComplete: () => {
            if (!sprite || !sprite.scene) return;
            sprite.setData('moveTween', null);
            sprite.setDepth(200);
          },
        });
        sprite.setData('moveTween', moveTween);

        // Flip animation runs in parallel, starting after a short delay.
        // Keep the handle so completeTrick can cancel a flip that never ran.
        const flipTimer = sceneDelay(this, FLIP.DELAY, () => {
          if (!sprite || !sprite.scene) return;
          sprite.setData('flipTimer', null);

          // Scale X to 0
          sceneTween(this, {
            targets: sprite,
            scaleX: 0,
            duration: flipHalf,
            ease: EASE_EMPHASIZED,
            onComplete: () => {
              if (!sprite || !sprite.scene) return;
              sprite.setTexture(CARD_TEXTURE_KEY, cardKey);

              // Scale X back to the trick scale
              sceneTween(this, {
                targets: sprite,
                scaleX: trickScale,
                duration: flipHalf,
                ease: EASE_EMPHASIZED,
              });
            },
          });
        });
        sprite.setData('flipTimer', flipTimer);

        this.trickManager._currentTrick.push(sprite);
      }
    } else if (playedPosition === myPosition && this.trickManager) {
      // My seat's card: my own click already flew it in; otherwise (lazy:
      // the bot played it, or a play acknowledged after a render) fly it
      // from the hand now
      const already = this.trickManager._currentTrick.some((s) => s?.getData?.('playPosition') === 'self');
      if (!already) this._flyMyCard(card, data.resumeInMs);
    }
  }

  /** Move my card from the hand to my trick slot (the bot played it, or the click path did not run). */
  _flyMyCard(card, resumeInMs) {
    const myPosition = this.state.position;
    const sprite = this.cardManager?.extractCard(card);
    if (!sprite) {
      // Not in the hand display (a render showed it played already): place it
      this.trickManager.addPlayedCard(card, myPosition, null, false);
      return;
    }
    sprite.removeAllListeners();
    sprite.disableInteractive();
    // a lazy seat's hand is dimmed: the card on the table is not (as a
    // render draws it)
    sprite.clearTint?.();
    // A hand-layout or hover tween still on the sprite would fight the
    // move (and replay after a hidden tab)
    this.trickManager._stopCardAnimations(sprite);

    // Animate to self play position
    this.trickManager.setPlayerPosition(myPosition);
    this.trickManager.updatePlayPositions();
    const targetPos = this.trickManager._playPositions.self;
    const moveTween = sceneTween(this, {
      targets: sprite,
      x: targetPos.x,
      y: targetPos.y,
      duration: flyInMs(resumeInMs),
      ease: EASE_EMPHASIZED,
      rotation: 0,
      scale: this.cardScale('trick'),
      onComplete: () => {
        if (!sprite?.scene) return;
        sprite.setData('moveTween', null);
        sprite.setDepth(200);
      },
    });
    sprite.setData('moveTween', moveTween);
    sprite.setData('playPosition', 'self');
    this.trickManager._currentTrick.push(sprite);

    // Reposition remaining cards
    this.cardManager?.repositionHand();
  }

  /**
   * Detect over-trump and show effect.
   */
  detectOverTrump() {
    const trick = this.state.currentTrick;
    const trump = this.state.trump;
    const leadCard = this.state.leadCard;

    // Need at least 3 cards for over-trump: lead, first trump, over-trump
    // (currentTrick entries are { card, position } from addPlayedCard)
    if (!trick || trick.length < 3 || !trump || !leadCard) return;

    const RANK_VALUES = window.ModernUtils?.RANK_VALUES || {};
    // currentTrick stores { card, position } objects from addPlayedCard()
    const currentCard = trick[trick.length - 1].card;
    const previousCard = trick[trick.length - 2].card;

    const isTrumpOrJoker = (c) => c.suit === trump.suit || c.suit === 'joker';
    const leadIsTrump = leadCard.suit === trump.suit || leadCard.suit === 'joker';

    // Over-trump: current card is trump, previous was trump, current outranks previous, lead wasn't trump
    if (
      isTrumpOrJoker(currentCard) &&
      isTrumpOrJoker(previousCard) &&
      RANK_VALUES[currentCard.rank] > RANK_VALUES[previousCard.rank] &&
      !leadIsTrump
    ) {
      if (this.effectsManager) {
        this.effectsManager.showImpactEvent('ot');
      }
    }
  }

  /**
   * The local player took the seat back (/active): lazy mode had dimmed
   * every card (isLegal false) and hidden the bid UI. updateTurn may have
   * arrived while the seat was still lazy, so recompute here.
   * @param {Function} onBidSelect - sends the chosen bid
   */
  refreshControlAfterActive(onBidSelect) {
    const state = this.state;
    if (state.isBidding) {
      this.cardManager?.updateCardLegality(() => true, false);
      const handSize = state.myCards?.length || 0;
      if (this.bidManager && state.bids?.[state.position] === undefined && handSize > 0) {
        this.bidManager.showBidUI(handSize, onBidSelect);
      }
      return;
    }
    // Same gate as handleUpdateTurn: the hand stays dimmed until a trick
    // still flying to its stack lands
    if (this.trickManager?.isCollecting?.()) {
      this.cardManager?.updateCardLegality(() => true, false);
      this.trickManager.onCollected(() => {
        if (!state.isLazy) this.updateCardLegalityAfterPlay();
      });
      return;
    }
    this.updateCardLegalityAfterPlay();
  }

  /**
   * Update card legality after a play (when lead card changes).
   */
  updateCardLegalityAfterPlay() {
    if (!this.cardManager || this.state.isBidding) return;

    const myPosition = this.state.position;
    const currentTurn = this.state.currentTurn;
    // A lazy seat's hand stays dimmed (the bot plays it; cli-1's side note)
    const canPlay = currentTurn === myPosition && !this.state.hasPlayedCard && !this.state.isLazy &&
      !this.state.isSpectator && !this._myActionPending();
    this.cardManager.updateCardLegality(this.legalityChecker(), canPlay);
  }

  /**
   * Handle trickComplete event (GameState already counted it).
   * @param {Object} data - { winner }
   */
  handleTrickComplete(data) {
    console.log('🎮 GameScene.handleTrickComplete()', data);

    const myPosition = this.state.position || 1;
    const winner = data.winner;

    // Add to game feed
    const winnerName = this.getPlayerNameForPosition(winner);
    if (window.addToGameFeedFromLegacy) {
      window.addToGameFeedFromLegacy(`Trick won by ${winnerName}.`);
    }

    // Determine if winner is on my team (same parity = same team)
    const isMyTeam = winner % 2 === myPosition % 2;

    // Animate cards to winner's stack via TrickManager
    if (this.trickManager) {
      this.trickManager.completeTrick(winner, isMyTeam, data.resumeInMs);
    }

    // Update game log with current trick counts
    this.renderScoreHeader();
  }

  // ============================================
  // Hand & Game End Handlers
  // ============================================

  /**
   * Handle handComplete event.
   * @param {Object} data - Scoring and hand completion data
   * @param {Object} [hand] - the hand's bids, captured when the event applied
   */
  handleHandComplete(data, { bids } = {}) {
    console.log('🎮 GameScene.handleHandComplete()', data);

    // Start trick animation immediately (before score processing)
    this._animateTricksAndTrumpAway();

    const state = this.state;
    const myPosition = state.position || 1;

    // Calculate team/opp scores based on position parity
    let teamScore, oppScore, teamTricksWon, oppTricksWon, teamOldScore, oppOldScore;
    if (myPosition % 2 !== 0) {
      // Player is on Team 1
      teamScore = data.score.team1;
      oppScore = data.score.team2;
      teamTricksWon = data.team1Tricks;
      oppTricksWon = data.team2Tricks;
      teamOldScore = data.team1OldScore;
      oppOldScore = data.team2OldScore;
    } else {
      // Player is on Team 2 - swap all team1/team2 values
      teamScore = data.score.team2;
      oppScore = data.score.team1;
      teamTricksWon = data.team2Tricks;
      oppTricksWon = data.team1Tricks;
      teamOldScore = data.team2OldScore;
      oppOldScore = data.team1OldScore;
    }

    // Add hand complete messages to game log
    if (window.ModernUtils && window.ModernUtils.formatHandCompleteMessages) {
      const messages = window.ModernUtils.formatHandCompleteMessages({
        myPosition: myPosition,
        playerData: state.playerData,
        bids: bids || state.bids,
        teamScore: teamScore,
        oppScore: oppScore,
        teamOldScore: teamOldScore,
        oppOldScore: oppOldScore,
        teamTricks: teamTricksWon,
        oppTricks: oppTricksWon,
      });
      messages.forEach((msg) => {
        if (window.addToGameFeedFromLegacy) {
          window.addToGameFeedFromLegacy(msg);
        }
      });
    }

    // Update game log score display
    if (window.ModernUtils && window.ModernUtils.getTeamNames) {
      const { teamName, oppName } = window.ModernUtils.getTeamNames(myPosition, state.playerData);
      if (window.updateGameLogScoreFromLegacy) {
        window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);
      }
    }

    // Clear hand cards
    if (this.cardManager) {
      this.cardManager.clearHand();
    }
  }

  /**
   * Animate tricks back to trump card and flip trump face down.
   * Extracted to run immediately at start of handleHandComplete. The next
   * deal waits for it (director.beginWhisk / endWhisk).
   */
  _animateTricksAndTrumpAway() {
    if (this.trickManager && this.tableCardSprite) {
      const trumpX = this.tableCardSprite.x;
      const trumpY = this.tableCardSprite.y;

      // The next hand's deal waits until the stacks are gone
      this.director?.beginWhisk();

      // Flip trump card face down while tricks are whisked
      const trumpSprite = this.tableCardSprite;
      const flipDuration = motionMs('fast', { reduced: 0 });
      sceneTween(this, {
        targets: trumpSprite,
        scaleX: 0,
        duration: flipDuration,
        ease: EASE_EMPHASIZED,
        onComplete: () => {
          if (trumpSprite && trumpSprite.scene) {
            trumpSprite.setTexture(CARD_TEXTURE_KEY, BACK_FRAME);
            sceneTween(this, {
              targets: trumpSprite,
              scaleX: trumpSprite.scaleY || this.cardScale('trump'),
              duration: flipDuration,
              ease: EASE_EMPHASIZED,
            });
          }
        },
      });

      this.trickManager.animateTricksAway(trumpX, trumpY, () => {
        // Reset bid totals after animation
        this.trickManager._teamBidTotal = 0;
        this.trickManager._oppBidTotal = 0;

        // The next deal may come in
        this.director?.endWhisk();
      });
    } else if (this.trickManager) {
      // Fallback if no trump card - just reset immediately
      this.trickManager.resetForNewHand();
    }
  }

  /**
   * Handle rainbow event.
   * @param {Object} data - { position }
   */
  handleRainbow(data) {
    console.log('🎮 GameScene.handleRainbow()');

    // Show rainbow effect
    if (this.effectsManager && this.effectsManager.showRainbow) {
      this.effectsManager.showRainbow(data.position);
    }
  }

  /**
   * Handle destroyHands event (GameState cleared the hand and the bids).
   * @param {Object} data - Event data
   */
  handleDestroyHands(data) {
    console.log('🎮 GameScene.handleDestroyHands()');

    // Clear hand and trick displays (the redeal's gameStart, sent in the
    // same server tick, deals the new hand)
    this.cardManager?.clearHand();
    if (this.trickManager) {
      this.trickManager.clearAll();
    }

    // destroyHands means an all-zero redeal, which the server sends instead
    // of doneBidding: drop the old bid grid here, or the next updateTurn
    // re-shows it before the new hand and trump flip arrive
    if (this.bidManager) {
      this.bidManager.hideBidUI(false);
    }
    this.renderScoreHeader();
  }

  // ============================================
  // Reconnection & Error Handlers
  // ============================================

  /**
   * playerResigned / playerLazyMode / playerActiveMode: GameState already
   * holds who the seat shows now (applySeatDisplay); draw that seat and the
   * score header from it.
   */
  handlePlayerResigned(data) {
    this.showSeatDisplay(data.position);
  }

  handlePlayerLazyMode(data) {
    this.showSeatDisplay(data.position);
  }

  handlePlayerActiveMode(data) {
    this.showSeatDisplay(data.position);
  }

  /**
   * Who a seat shows, from GameState (the bot after /lazy, an AFK takeover
   * or a resignation; the owner after /active), everywhere the table names
   * it at once: my own box or the seat's avatar, and the score header.
   * @param {number} position
   */
  showSeatDisplay(position) {
    const state = this.state;
    const i = state?.playerData?.position?.indexOf(position) ?? -1;
    if (i !== -1) {
      const display = {
        username: state.getPlayerNameByPosition(position),
        pic: state.playerData.pics?.[i] ?? null,
      };
      if (position === state.position && !state.isSpectator) this.updatePlayerInfoBox(display);
      else this.opponentManager?.updatePlayerInfo(position, display);
    }
    this.renderScoreHeader();
  }

  /**
   * Handle abortGame event.
   * @param {Object} data - Abort reason
   */
  handleAbortGame(data) {
    console.log('🎮 GameScene.handleAbortGame()');

    // Full cleanup
    this.cleanup();
  }

  // ============================================
  // Hand, opponent hands and own avatar box
  // ============================================

  /**
   * Display the local player's hand via CardManager and wire card clicks
   * to MyAction.submitPlay (sorted by trump; legality from the game state).
   * A click never edits GameState: the card leaves the hand when its
   * cardPlayed echo applies, and returns with the snapshot of a refusal.
   * @param {Array} cards - Hand from the server
   * @param {boolean} skipAnimation - true on rejoin (no deal animation)
   */
  handleDisplayHand(cards, skipAnimation = false) {
    console.log('🎮 handleDisplayHand', cards?.length, 'cards, skipAnimation:', skipAnimation);
    if (!this.cardManager || !cards || cards.length === 0) return;

    const gameState = getGameState();

    // Sort cards by trump before displaying
    const sortedCards = sortHand([...cards], gameState.trump);

    // Set up click handler for playing cards
    const scene = this;
    this.cardManager.setCardClickHandler((card, clickedSprite) => {
      console.log(`🃏 Card clicked: ${card.rank} of ${card.suit}`);

      // Only allow playing if the card is marked as legal
      if (!clickedSprite.getData('isLegal')) {
        console.log('Illegal move - card is disabled!');
        return;
      }
      // A dead socket would buffer the play and flush it ahead of the
      // rejoin, where the server drops it (cli-18): wait for the reconnect
      if (window.socket && window.socket.connected === false) {
        console.log('Not connected: play ignored');
        return;
      }

      // One outstanding action at a time (MyAction: pending until the echo)
      if (!getMyAction().submitPlay(card, gameState.position)) return;

      // Capture the current (hovered) position before any operations that might reset it
      const startX = clickedSprite.x;
      const startY = clickedSprite.y;

      // Extract card sprite for animation (don't destroy it)
      const sprite = this.cardManager.extractCard(card);
      if (sprite && this.trickManager) {
        // Remove event listeners to prevent pointerout from resetting position
        sprite.removeAllListeners();

        // Restore the hovered position (in case it was reset)
        sprite.x = startX;
        sprite.y = startY;

        // Get target position
        this.trickManager.setPlayerPosition(gameState.position);
        this.trickManager.updatePlayPositions();
        const targetPos = this.trickManager._playPositions.self;

        // Disable interactions during animation
        sprite.disableInteractive();
        // Its pointerout will never fire now: drop the hand cursor
        scene.input?.setDefaultCursor?.('default');
        // Stop the hover tween (it would pull the card back toward the
        // hand) and keep the move handle so a trick can cancel it
        this.trickManager._stopCardAnimations(sprite);

        // Animate from hovered position to play position
        // No flip needed since player's cards are already face-up
        const moveTween = sceneTween(scene, {
          targets: sprite,
          x: targetPos.x,
          y: targetPos.y,
          duration: ANIMATION_CONFIG.CARD_PLAY,
          ease: EASE_EMPHASIZED,
          rotation: 0,
          scale: this.cardScale('trick'),
          onComplete: () => {
            if (!sprite || !sprite.scene) return;
            sprite.setData('moveTween', null);
            sprite.setDepth(200);
          },
        });
        sprite.setData('moveTween', moveTween);

        // Add to trick manager's current trick
        sprite.setData('playPosition', 'self');
        sprite.setData('pending', true);
        this.trickManager._currentTrick.push(sprite);
      }

      // Close the hand up around the played card (as _flyMyCard does)
      this.cardManager.repositionHand();

      // Immediately dim all remaining cards since player can't play again this trick
      this.cardManager.updateCardLegality(() => true, false);
    });

    // Display the sorted hand
    this.cardManager.displayHand(sortedCards, { animate: !skipAnimation });

    // Update card legality based on current game state
    const canPlay = !gameState.isBidding &&
                    gameState.currentTurn === gameState.position &&
                    !gameState.hasPlayedCard && !gameState.isLazy && !gameState.isSpectator &&
                    !getMyAction().isPending();

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

  /** The bid panel's choice: MyAction sends it (one outstanding at a time). */
  submitBid(bid) {
    return getMyAction().submitBid(bid, this.state.position);
  }

  /**
   * Display the other seats' card backs and avatars via OpponentManager,
   * and the own avatar box at the same time (not for pure spectators: they
   * see all 4 players as opponent avatars).
   */
  handleDisplayOpponentHands(cardCount, dealerPosition, playerData, skipAnimation) {
    const gameState = getGameState();
    if (this.opponentManager) {
      if (gameState.position) {
        this.opponentManager.setPlayerPosition(gameState.position);
      }
      this.opponentManager.displayOpponentHands(cardCount, dealerPosition, playerData, skipAnimation);
    }
    const isPureSpectator = gameState.isSpectator && !gameState.isLazy;
    if (!this._playerInfo && !isPureSpectator) {
      if (gameState.position && gameState.playerData) {
        this.createPlayerInfoBox(gameState.playerData, gameState.position);
      }
    }
  }

  // ============================================
  // Render (the whole table from the model)
  // ============================================

  /** The model render() draws by default: GameState plus my pending action. */
  currentModel() {
    const action = getMyAction();
    return this.state.renderModel({ pendingCard: action.pendingCard, pendingBid: action.isPending('bid') });
  }

  /**
   * Draw the whole table from a snapshot-shaped model
   * (GameState.renderModel, after applySnapshot for a snapshot): cancel the
   * director's work, clear every manager, then draw. Idempotent: the same
   * model gives the same sprites, however many times and over whatever was
   * on the table (cli-4: no doubled trick cards or log, no card backs over
   * real stacks; webclient-8: each opponent shows the cards it holds; the
   * trump is face up, never re-flipped).
   * @param {Object} [model] - default currentModel()
   * @returns {Object} the model drawn
   */
  render(model = null) {
    const m = model || this.currentModel();
    this.director?.reset();

    // Clear: the hand before the tricks (a collect cleared in flight runs
    // its onCollected callbacks, which must find no hand)
    this.cardManager?.clearAll();
    this.trickManager?.clearAll();
    // the backs only: the avatars and the frog are the game's, updated in
    // place below (webclient-21: built once per game)
    this.opponentManager?.clearCards();
    this.effectsManager?.clearAll();
    this.drawManager?.cleanup();
    this.clearTrumpDisplay();
    this.bidManager?.hideBidUI(false);
    this._turnToken = (this._turnToken || 0) + 1;

    const role = m.viewer?.role || 'seat';
    const spectator = role === 'spectator';
    const lazy = role === 'lazyWatcher';
    const pos = m.viewer?.position || 1;

    // The role picks the layout (a spectator's bottom seat has no hand)
    this._spectatorView = spectator;
    applyHudLayout(this.getLayout());
    this.ensureCardTextures();

    this.trickManager?.setPlayerPosition(pos);
    this.trickManager?.setSpectatorMode(spectator);
    this.trickManager?.updatePlayPositions();
    this.opponentManager?.setPlayerPosition(pos);
    this.opponentManager?.setSpectatorMode(spectator);
    this.effectsManager?.setPlayerPosition(pos);

    if (this.layoutManager) {
      this.layoutManager.update();
      this.layoutManager.cleanupDomBackgrounds();
      this.layoutManager.createDomBackgrounds({ skipHandArea: spectator });
    }
    if (spectator) this.clearPlayerInfo();
    if (m.playerData) this.opponentManager?.displayAvatars(m.playerData);
    if (!spectator && !this._playerInfo && m.playerData) this.createPlayerInfoBox(m.playerData, pos);
    else if (!spectator && m.playerData) {
      const i = m.playerData.position?.indexOf(pos) ?? -1;
      const u = m.playerData.username?.[i];
      if (i !== -1 && u) this.updatePlayerInfoBox({ username: u.username || u, pic: m.playerData.pics?.[i] ?? null });
    }
    if (!spectator) this.updatePlayerHsi(m.hsi);
    // the voice buttons' slot moves with the role (my box, or the corner)
    reattachMuteButton();
    this.renders = (this.renders || 0) + 1;

    if (!m.live) {
      this.opponentManager?.clearDealerButton();
      this.renderScoreHeader();
      return m;
    }

    this.opponentManager?.displayDealerButton(m.dealer);
    this.opponentManager?.displayOpponentCardsBySeat(m.seatCards);
    if (m.trump) this.displayTrumpCard(m.trump, { faceUp: true });
    if (m.hand && m.hand.length) this.handleDisplayHand(m.hand, true);

    if (!m.isBidding && this.trickManager) {
      const num = (b) => (b === undefined || String(b).includes('B') ? 0 : parseInt(b, 10) || 0);
      const teamBid = num(m.bids[pos]) + num(m.bids[team(pos)]);
      const oppBid = num(m.bids[rotate(pos)]) + num(m.bids[rotate(rotate(rotate(pos)))]);
      this.trickManager.setBidTotals(teamBid, oppBid);
      this.trickManager.createTrickBackgrounds(false);
      if (m.history) {
        // team 1 holds the odd seats, team 2 the even ones
        this.trickManager.restoreTrickHistory(m.history, (t) => t.team % 2 === pos % 2);
      } else {
        this.trickManager.restoreTrickPlaceholders(m.tricks.team, m.tricks.opp);
      }
    }
    for (const c of m.trick || []) {
      const sprite = this.trickManager?.addPlayedCard(c.card, c.position, null, false);
      if (sprite && c.pending) sprite.setData('pending', true);
    }

    if (!spectator) this.cardManager?.updatePlayerTurnGlow(m.turn, pos);
    this.opponentManager?.updateTurnGlow(m.turn);
    if (lazy) this.cardManager?.setInteractive(false);

    if (m.isBidding && role === 'seat' && m.hand?.length && m.bids[pos] === undefined &&
        !getMyAction().isPending('bid') && this.bidManager) {
      this.bidManager.showBidUI(m.hand.length, (bid) => this.submitBid(bid));
    }

    this.renderScoreHeader();
    return m;
  }

  /** What is on the table (render checks and tests). */
  tableCounts() {
    const opp = this.opponentManager?.cardCounts?.() || {};
    const tricks = this.trickManager?.spriteCounts?.() || {};
    return {
      hand: this.cardManager?.getHandCount?.() ?? 0,
      opponentBacks: Object.values(opp).reduce((a, b) => a + b, 0),
      opponentBySlot: opp,
      trick: tricks.trick ?? 0,
      teamStacks: tricks.teamStacks ?? 0,
      oppStacks: tricks.oppStacks ?? 0,
      stackCards: tricks.stackCards ?? 0,
      whisking: tricks.whisking ?? 0,
      trump: this.tableCardSprite ? (this.tableCardSprite.frame?.name ?? this.tableCardSprite.texture?.key ?? 'set') : null,
      bidPanel: !!this.bidManager?.bidContainer,
    };
  }

  /**
   * Create the own avatar box (DOM: avatar, name, HSI) at the bottom right.
   * @returns {Object|null} { avatarContainer, avatarImg, nameLabel, hsiBox }
   */
  createPlayerInfoBox(playerData, myPosition) {
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

    // The self seat's HUD node holds it (the layout's spot; ui-4)
    applyHudLayout(this.getLayout());

    // Player Avatar    // Player Avatar - use DOM for consistent sizing with opponent avatars
    const pic = playerData.pics[positionIndex];
    const username = playerData.username[positionIndex].username || playerData.username[positionIndex];

    // Create DOM-based avatar (same approach as opponent avatars)
    const avatarContainer = document.createElement('div');
    avatarContainer.id = 'player-avatar-container';

    // the seat's player now (a bot after /lazy): updatePlayerInfoBox
    avatarContainer.dataset.username = username;
    avatarContainer.addEventListener('click', () => {
      const socket = window.socket;
      if (socket) {
        socket.emit('getPlayerProfile', { username: avatarContainer.dataset.username });
      }
    });

    const avatarImg = document.createElement('img');
    avatarImg.className = 'player-avatar-img hud-avatar-img';
    // Stock number, inline data URL or /avatar URL (utils/avatar.js)
    applyAvatarImg(avatarImg, avatarSrc(pic));
    avatarImg.alt = username;
    // in its seat ring: the team's color, the bid chip and the trick pips (ui/seatPlates.js)
    avatarContainer.appendChild(buildAvatarRing(avatarImg, myPosition));

    // Add username label (the seat's plate)
    const nameLabel = document.createElement('div');
    nameLabel.className = 'hud-plate';
    nameLabel.textContent = username;
    nameLabel.title = username; // the plate truncates a long name (its seat's width)
    avatarContainer.appendChild(nameLabel);

    // Add HSI display box
    const hsiBox = document.createElement('div');
    hsiBox.id = 'player-hsi-box';
    hsiBox.className = 'hud-hsi';
    hsiBox.textContent = 'HSI: --';
    avatarContainer.appendChild(hsiBox);

    // Into the self seat (the frog and my bubbles are its siblings there)
    const seat = hudSeat('self');
    (seat?.avatar || hudRoot()).appendChild(avatarContainer);

    // Move voice mute button into avatar container if voice is active
    reattachMuteButton();

    this._playerInfo = { avatarContainer, avatarImg, nameLabel, hsiBox };
    return this._playerInfo;
  }

  /**
   * Show another name and picture in the own avatar box (the bot holding my
   * seat, or me again).
   * @param {Object} display - {username, pic}
   */
  updatePlayerInfoBox({ username, pic }) {
    const info = this._playerInfo;
    if (!info || !username) return;
    info.nameLabel.textContent = username;
    info.nameLabel.title = username;
    info.avatarImg.alt = username;
    info.avatarContainer.dataset.username = username;
    if (isAvatarPic(pic)) applyAvatarImg(info.avatarImg, avatarSrc(pic));
  }

  /**
   * Follow a resize with the own avatar box (a HUD seat: the layout moves
   * it) and the voice buttons under it.
   */
  repositionPlayerInfo() {
    if (!this._playerInfo?.avatarContainer) return;
    applyHudLayout(this.getLayout());
    reattachMuteButton();
  }

  /**
   * Remove the own avatar box.
   */
  clearPlayerInfo() {
    if (this._playerInfo?.avatarContainer) {
      this._playerInfo.avatarContainer.remove();
    }
    this._playerInfo = null;
  }

  /**
   * Show the hand's HSI in the own avatar box.
   */
  updatePlayerHsi(hsi) {
    if (this._playerInfo?.hsiBox && hsi !== undefined) {
      this._playerInfo.hsiBox.textContent = `HSI: ${hsi.toFixed(1)}`;
    }
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up all visual elements (game end Return to Lobby, abortGame).
   * The card hand goes before the trick manager: clearing a collect in
   * flight runs its onCollected callbacks, which must find no hand.
   */
  cleanup() {
    this.cardManager?.clearAll();
    this.opponentManager?.clearAll();
    this.trickManager?.clearAll();
    this.effectsManager?.clearAll();
    this.drawManager?.cleanup();

    // Clear trump
    if (this.tableCardSprite) {
      this.tableCardSprite.destroy();
      this.tableCardSprite = null;
    }
    if (this.tableCardBackground) {
      this.tableCardBackground.destroy();
      this.tableCardBackground = null;
    }
    if (this.tableCardLabel) {
      this.tableCardLabel.destroy();
      this.tableCardLabel = null;
    }
  }
}

// Export for use in Phaser config
export default GameScene;
