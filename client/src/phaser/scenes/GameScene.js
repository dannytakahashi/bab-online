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

import { seatAvatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { getGameState, PHASE, teamPlayerDataOf } from '../../state/GameState.js';
import { teamsLine } from '../../ui/drawCopy.js';
import { getCardImageKey, getCardDisplayName, sortHand } from '../../utils/cards.js';
import { announce } from '../../ui/handA11y.js';
import { scoreHeaderNames, scoreHeaderPairs } from '../../ui/components/ScoreModal.js';
import { team, rotate, slotOf } from '../../utils/positions.js';
import { soloHeaderRows, formatSoloHandMessages, soloTally } from '../../state/gyb.js';
import { isLegalMove } from '../../rules/legality.js';
import { isOverTrump } from '../../rules/overTrump.js';
import { bidTotalsFor } from '../../rules/bids.js';
import { ANIMATION_CONFIG } from '../config.js';
import { reattachMuteButton } from '../../ui/components/VoiceChatUI.js';
import { placeSoundToggle } from '../../ui/components/SoundToggle.js';
import { CardManager } from '../managers/CardManager.js';
import { OpponentManager } from '../managers/OpponentManager.js';
import { TrickManager } from '../managers/TrickManager.js';
import { EffectsManager } from '../managers/EffectsManager.js';
import { DrawManager } from '../managers/DrawManager.js';
import { flyInMs, FLIP } from '../pacing.js';
import { transitionGeneration, getTransitionOverlay, createTransitionOverlay, releaseTransitionOverlay, setOverlayState } from '../../ui/transitionOverlay.js';
import { getTableDirector, sceneDelay, sceneTween, UI_READY_DELAY_MS, FLIP_AFTER_DEAL_MS, FLIP_AFTER_FADE_MS } from '../TableDirector.js';
import { getMyAction } from '../../state/MyAction.js';
import { NOTICE } from '../../state/noticeText.js';
import { showNotice } from '../../ui/components/Toast.js';
import { BidManager } from '../managers/BidManager.js';
import { LayoutManager } from '../managers/LayoutManager.js';
import { showChatBubble as showChatBubbleUI } from '../../ui/components/ChatBubble.js';
import { computeTableLayout, logWidthFor } from '../layout/computeTableLayout.js';
import { applyHudLayout, hudSeat, hudRoot, logColumnWidth, getHud, hudLayout } from '../../ui/tableHud.js';
import { buildAvatarRing, updateSeatPlates, updateSeatBadges } from '../../ui/seatPlates.js';
import { cssSize, zoomCamera } from '../backingStore.js';
import { ensureCardAtlas, refreshCardSprites, CARD_TEXTURE_KEY } from '../cards/CardAtlas.js';
import { tableBackFrame } from '../cards/tableBack.js';
import { isBackFrame } from '../cards/cardFaces.js';
import { uiTextStyle, refreshTextResolution } from '../text.js';
import { COLOR, hex, alpha } from '../../ui/tokens.js';
import { motionMs, EASE_EMPHASIZED } from '../../ui/motion.js';
import { scopePayload } from '../../state/statsScope.js';
import {
  isAssistHint, hintIsLive, noteAssistUses, helpIsUnlimited, suggestedBid, suggestedCard, assistLogLine, assistAnnouncement, HELP_COMMAND,
  parseTurnKey, ASSIST_LATE_LINE, tutorialNeedsConfirm, isWatchedHint,
} from '../../state/assistHint.js';
import { isPureSpectator, isShoulder, isViewedSeat } from '../../state/shoulder.js';
import { syncShoulderHud, clearShoulderHud } from '../../ui/components/ShoulderHud.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { showAssistCard, hideAssistCard, syncAssistButton, showAssistTips } from '../../ui/components/AssistCard.js';
import {
  isTipHint, isWelcomeTip, isRowOnlyTip, tipLogLine, tipAnnouncement, tipActionCommand, tutorialIsOn, shownTip,
  tutorialButtonVisible, tutorialButtonDisabled, TUTORIAL_CLOSE_COMMAND, TUTORIAL_OFF_COMMAND, TUTORIAL_ON_COMMAND,
} from '../../state/tutorial.js';
import { syncTutorialButton, showTutorialConfirm, closeTutorialConfirm, tutorialConfirmOpen } from '../../ui/components/TutorialButton.js';

/** A pointer press this soon after my own play is a double-click's second: no refusal toast. */
export const DOUBLE_CLICK_QUIET_MS = 400;
/** After a lightbulb click the lightbulb waits this long at most for the answer before it shows again. */
export const ASSIST_ASK_WAIT_MS = 10000;
/** After an off (the Tutorial button, the welcome's Turn off) the button waits this long at most for the server's assistState. */
export const TUTORIAL_OFF_WAIT_MS = 10000;
/** After the Tutorial button's on, the button waits this long at most for the server's assistState. */
export const TUTORIAL_ON_WAIT_MS = 10000;

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
    // a watcher (the over-the-shoulder view) has the seated layout of the watched seat
    const spectator = this._spectatorView ?? isPureSpectator(state);
    // my voice row reserves the Tutorial button's slot while I play my own
    // seat (not lazy): a lazy watcher's table is as before
    const tutorial = this._tutorialSlot();
    // a watcher: its own voice row in the corner, above the spectator badge
    const watcher = !spectator && isShoulder(state);
    const vw = typeof window !== 'undefined' ? window.innerWidth : w;
    const logW = typeof document !== 'undefined' ? logColumnWidth({ fallback: () => logWidthFor(vw) }) : 0;
    // a three-seat table (Get Your Bid): no partner, the others in the upper corners
    const solo = !!state?.isSolo;
    // a tournament table's draw for first deal: its teams line (my team first)
    // (only while the draw is up: the rest of the game keeps the table's own layout)
    const drawTeams = !solo && state?.phase === PHASE.DRAW && state?.draw?.teams ? teamsLine(state.draw.teams, spectator ? null : state.username) : '';
    const key = `${w}x${h}:${spectator ? 'spec' : (watcher ? 'watch' : 'seat')}${tutorial ? '+tut' : ''}${solo ? '+solo' : ''}:${logW}:${dpr}${drawTeams ? `:teams=${drawTeams}` : ''}`;
    if (!this._layout || this._layout.key !== key) {
      const layout = computeTableLayout({ w, h, dpr, isSpectator: spectator, logW, tutorial, ...(watcher && { watcher: true }), ...(solo && { solo: true }), ...(drawTeams && { drawTeams }) });
      this._layout = { key, layout };
      // the atlas always matches the layout its sprite scales are for
      this.ensureCardTextures(layout);
    }
    return this._layout.layout;
  }

  /** Does my table reserve the Tutorial button's slot (I play my own seat: not a spectator, not lazy, not a watcher)? */
  _tutorialSlot() {
    const state = this.state;
    const spectator = this._spectatorView ?? isPureSpectator(state);
    // (no tutorial at a Get Your Bid table: no button, no slot)
    return !spectator && !state?.isLazy && !isShoulder(state) && !state?.isSolo;
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
    placeSoundToggle();
    this._syncTutorialButton();
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
      this.drawTrumpFrame(this.tableCardBackground, trump);
    }
    if (this.tableCardLabel && this.tableCardLabel.active) {
      this.tableCardLabel.setPosition(trump.label.x, trump.label.y);
      this.tableCardLabel.setFontSize?.(trump.label.font);
    }
  }

  /**
   * (Re)draw the trump's frame: a rounded surface tile tight to the card
   * (sized from the card, not the layout's square box) with a gold border.
   * @param {Phaser.GameObjects.Graphics} g - positioned at the card's centre
   * @param {Object} trump - the layout's trump spot ({card: {w, h}})
   */
  drawTrumpFrame(g, trump) {
    const pad = trump.card.w * 0.08;
    const w = trump.card.w + 2 * pad;
    const h = trump.card.h + 2 * pad;
    const r = Math.max(4, trump.card.w * 0.1);
    g.clear();
    g.fillStyle(hex(COLOR.surface.s1), 0.55);
    g.fillRoundedRect(-w / 2, -h / 2, w, h, r);
    g.lineStyle(2, hex(COLOR.gold), 0.7);
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, r);
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
   * The deal landed (after the previous hand's whisk): a face-down trump
   * still showing the finished hand's back takes this hand's.
   */
  dealTrumpBack() {
    const sprite = this.tableCardSprite;
    const back = sprite?.getData?.('backFrame');
    if (!sprite?.scene || !back || sprite.getData('flipping')) return;
    if (isBackFrame(sprite.frame?.name) && sprite.frame.name !== back) sprite.setTexture(CARD_TEXTURE_KEY, back);
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

    // The next hand's gameStart lands during the finished hand's whisk
    // (its tricks flying into this spot) and its deal waits for it: until
    // then the face-down trump keeps the finished hand's back, and takes
    // this hand's when the deal lands (dealTrumpBack)
    const handBack = tableBackFrame();
    const finishedBack = !faceUp && this.director?.whisking ? this.tableCardSprite?.getData?.('backFrame') : null;

    // Clear existing
    this.clearTrumpDisplay();

    // Card - face down until the deal reveals it, same scale as player hand cards
    const cardKey = getCardImageKey(trumpCard);
    this.tableCardSprite = faceUp
      ? this.add.image(trumpX, trumpY, CARD_TEXTURE_KEY, cardKey)
      : this.add.image(trumpX, trumpY, CARD_TEXTURE_KEY, finishedBack || handBack);
    this.tableCardSprite.setScale(trumpScale);
    this.tableCardSprite.setDepth(100);
    // This hand's back (the end-of-hand flip shows it even once the next
    // hand's gameStart has moved GameState.handNo on)
    this.tableCardSprite.setData('backFrame', handBack);

    // Background - a rounded surface tile hugging the card, with a gold
    // border (gold marks the trump)
    this.tableCardBackground = this.add.graphics({ x: trumpX, y: trumpY });
    this.drawTrumpFrame(this.tableCardBackground, trump);
    this.tableCardBackground.setDepth(99);

    // Label - above the card (a readable size: ui-7)
    this.tableCardLabel = this.add.text(trump.label.x, trump.label.y, 'Trump', uiTextStyle(this, {
      fontSize: `${trump.label.font}px`,
      weight: 'regular',
      color: COLOR.gold,
    }));
    this.tableCardLabel.setOrigin(0.5);
    this.tableCardLabel.setDepth(100);

    if (faceUp) return;

    // a new deal (a render's face-up trump is not news)
    const cards = this.state?.currentHand;
    announce(`New hand${cards ? ` of ${cards} ${cards === 1 ? 'card' : 'cards'}` : ''}. Trump is the ${getCardDisplayName(trumpCard)}.`);

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

    // my own bid (or the watched seat's): the /help card (and the tutorial's rule tip) is done
    if (isViewedSeat(this.state, data.position)) {
      this.clearAssist();
      this.clearTips();
    }
    // the watched seat bid: its read-only sheet goes
    if (isShoulder(this.state) && data.position === this.state.position) this.bidManager?.hideBidUI();

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
    if (state.isSolo) {
      // Get Your Bid: three players, each their own score, bid and tricks
      window.updateGameLogSoloScore?.(soloHeaderRows(state, { spectator: isPureSpectator(state) }));
      this.updateSeatPlates?.();
      return;
    }
    // Player names only, '' until they are known (never a placeholder)
    const { teamName, oppName } = scoreHeaderNames(state.position, teamPlayerDataOf(state), { spectator: isPureSpectator(state) });
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
    // the watched seat's clock pill follows the bids (the over-the-shoulder view)
    if (hud && this.state) syncShoulderHud(this.state);
  }

  /**
   * Every seat's avatar badge (the /help lightbulb, the tutorial's cap;
   * state/seatBadges.js), projected from GameState: updateSeatPlates draws
   * them too; a turn, a card and the hand's end call this alone. `pop`: the
   * seats a live help notice or tutorial tag just set (main.js onGameLogEntry).
   */
  updateSeatBadges({ pop = [] } = {}) {
    const hud = getHud({ create: false });
    if (hud && this.state) updateSeatBadges(hud, this.state, { pop });
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
    // a bid suggestion is over with the bidding
    this.clearAssist();

    // Update card legality now that bidding is over
    // The lead player can play any card, others are dimmed
    if (this.cardManager) {
      const canPlay = this.state.currentTurn === this.state.position && !this.state.isLazy && !this.state.isSpectator;
      // No lead card yet, so all cards are legal for the lead player
      this.cardManager.updateCardLegality(() => true, canPlay);
    }

    // Update turn glow
    const pureSpectator = isPureSpectator(this.state);
    if (this.cardManager && !pureSpectator) {
      this.cardManager.updatePlayerTurnGlow(this.state.currentTurn, this.state.position);
    }
    if (this.opponentManager) {
      this.opponentManager.updateTurnGlow(this.state.currentTurn);
    }
    this.renderScoreHeader();
  }

  /**
   * A Get Your Bid table's trick pile for a seat (TrickManager's piles):
   * 'team' my own, 'opp' the next seat's in turn (drawn on my left, its
   * pile top left), 'opp2' the other's (on my right, its pile top right).
   */
  _soloPile(position) {
    const slot = slotOf(position, this.state.position || 1, 3);
    return slot === 'self' ? 'team' : (slot === 'opp2' ? 'opp2' : 'opp');
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
          gameState.leadPosition,
          gameState.isSolo
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
    const pureSpectator = isPureSpectator(this.state);

    // a turn change ends a /help answer (plan 4.4): one still live by its
    // turnKey stays (a repeat of this turn, a resync); an answer that came
    // while the state lagged behind (a seq gap) shows now if it is live
    this._endAsking();
    this._settleAssist({ abandon: true });

    // the announcer: my turn, with the trick so far (before the hand takes focus)
    if (currentTurn === myPosition && !this.state.isSpectator && !this.state.isLazy) {
      announce(this.turnAnnouncement());
    }

    // Update turn glow for player's hand (skip for pure spectators — no hand area)
    if (this.cardManager && !pureSpectator) {
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
        !this.state.isSpectator && !this._myActionPending();
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
    this.syncAssistButton();
    this.syncTutorial();
    syncShoulderHud(this.state);
    // the last seat's lightbulb goes with its turn
    this.updateSeatBadges();
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
      if (isPureSpectator(this.state)) return 'bottom';
      return 'me';
    }
    // (the seats round the viewer: three at a Get Your Bid table)
    return slotOf(gamePosition, myPosition, this.state.seatCount);
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

    announce(`${this._seatName(playedPosition)} played the ${getCardDisplayName(card)}.`);
    // the seat played: its lightbulb goes
    this.updateSeatBadges();

    // my own card (or the watched seat's): the /help card (and the tutorial's rule tip) is done
    if (isViewedSeat(this.state, playedPosition)) {
      this.clearAssist();
      this.clearTips();
    }

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
    const isOpponentPlay = playedPosition !== myPosition || isPureSpectator(this.state);
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
   * Show the OT effect when the card just played over-trumps (rules/
   * overTrump.js: it takes the trick from an opponent's winning trump on a
   * non-trump lead). Runs only from handleCardPlayed, i.e. once per server
   * cardPlayed (the seq gate drops a repeat); a render, relayout or
   * snapshot rebuild never calls it, and my pending card is not in
   * currentTrick until the server confirms it.
   */
  detectOverTrump() {
    // currentTrick entries are { card, position } in play order (GameState.applyCardPlayed)
    if (!isOverTrump(this.state.currentTrick, this.state.trump, { solo: this.state.isSolo })) return;
    this.effectsManager?.showImpactEvent('ot');
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

    // Determine if winner is on my team (same parity = same team; at a
    // Get Your Bid table only my own seat's tricks are "mine")
    const isMyTeam = this.state.isSolo ? winner === myPosition : winner % 2 === myPosition % 2;

    // the announcer: who took it, and (for a seat) the hand's tricks so far
    const tally = isPureSpectator(this.state) ? ''
      : this.state.isSolo ? soloTally(' Tricks:', this.state, this.state.tricksByPosition || {})
        : this._teamsSaid(' Tricks:', this.state.teamTricks || 0, this.state.oppTricks || 0);
    announce(`${this._seatName(winner)} won the trick.${tally}`);

    // Animate cards to winner's stack via TrickManager
    if (this.trickManager) {
      this.trickManager.completeTrick(winner, this.state.isSolo ? this._soloPile(winner) : isMyTeam, data.resumeInMs);
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
   * @param {Object} [hand] - the hand's bids, captured when the event
   *   applied (GameState resets them next). The hand's red fault lines
   *   are the server's: gameLogEntry with `fault`, after this event
   *   (main.js onGameLogEntry)
   */
  handleHandComplete(data, { bids } = {}) {
    console.log('🎮 GameScene.handleHandComplete()', data);

    // Start trick animation immediately (before score processing)
    this._animateTricksAndTrumpAway();
    this.clearAssist();
    // the hand is over: no lightbulb stays
    this.updateSeatBadges();

    const state = this.state;
    const myPosition = state.position || 1;

    if (data.gyb) {
      // Get Your Bid: one line per player (the server's own words, each
      // seat by its owner), the three-player header, the scores said by name
      for (const msg of formatSoloHandMessages(data.gyb, teamPlayerDataOf(state))) window.addToGameFeedFromLegacy?.(msg);
      this.renderScoreHeader();
      const scores = Object.fromEntries((data.gyb.scores || []).map((v, i) => [i + 1, v]));
      announce(`Hand over.${soloTally(' Score:', state, scores, { spectator: isPureSpectator(state) })}`);
      if (this.cardManager) this.cardManager.clearHand();
      return;
    }

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
        playerData: teamPlayerDataOf(state),
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

    // Update game log score display (player names only, as renderScoreHeader)
    if (window.updateGameLogScoreFromLegacy) {
      const { teamName, oppName } = scoreHeaderNames(myPosition, teamPlayerDataOf(state), { spectator: isPureSpectator(state) });
      window.updateGameLogScoreFromLegacy(teamName, oppName, teamScore, oppScore);
    }

    announce(isPureSpectator(state) ? 'Hand over.' : `Hand over.${this._teamsSaid(' Score:', teamScore, oppScore)}`);

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
            // the finished hand's back, not the next one's: its gameStart
            // (GameState.handNo + 1) often lands during the whisk
            trumpSprite.setTexture(CARD_TEXTURE_KEY, trumpSprite.getData('backFrame') ?? tableBackFrame());
            sceneTween(this, {
              targets: trumpSprite,
              scaleX: trumpSprite.scaleY || this.cardScale('trump'),
              duration: flipDuration,
              ease: EASE_EMPHASIZED,
            });
          }
        },
      });

      const finishedHand = this.trickManager.bidTotalsGen();
      this.trickManager.animateTricksAway(trumpX, trumpY, () => {
        // The finished hand's bid totals go, unless the next hand's
        // doneBidding already set its own (it may land during the whisk)
        this.trickManager.clearBidTotals(finishedHand);

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
    this.clearAssist();
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
    if (data.position === this.state?.position) {
      this.clearAssist();
      this.clearTips({ all: true });
      this.syncTutorial();
    }
    this.showSeatDisplay(data.position);
  }

  handlePlayerActiveMode(data) {
    this.showSeatDisplay(data.position);
    // my own seat back: my row takes the Tutorial button's slot again
    if (data.position === this.state?.position) this.syncTutorial();
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
      if (isViewedSeat(state, position)) this.updatePlayerInfoBox(display);
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
    this.cardManager.setCardClickHandler((card, clickedSprite, via) => {
      console.log(`🃏 Card clicked: ${card.rank} of ${card.suit}`);

      // A double-click's second press lands on the neighbour that slid
      // under the pointer after my play (the hand closes up and dims): no
      // refusal toast for a pointer press just after my own play. The
      // keyboard, and a later press, still say why.
      const justPlayed = via === 'pointer' &&
        Date.now() - (scene._myPlayAt ?? -Infinity) < DOUBLE_CLICK_QUIET_MS;

      // Only allow playing if the card is marked as legal; a dimmed card
      // says why (iOS's table notice: "Must follow suit.", "Not your turn."...)
      if (!clickedSprite.getData('isLegal')) {
        const why = justPlayed ? null : scene.illegalReason(card);
        if (why) showNotice(why);
        return;
      }
      // A dead socket would buffer the play and flush it ahead of the
      // rejoin, where the server drops it (cli-18): wait for the reconnect
      if (window.socket && window.socket.connected === false) {
        showNotice(NOTICE.RECONNECTING);
        return;
      }

      // One outstanding action at a time (MyAction: pending until the echo).
      // A send it refused (reconnecting) told the player itself (onRefused)
      if (!getMyAction().submitPlay(card, gameState.position)) {
        if (getMyAction().isPending() && !justPlayed) showNotice(NOTICE.CARD_ON_ITS_WAY);
        return;
      }
      scene._myPlayAt = Date.now();
      // my card is on its way: the /help card (and its lightbulb), the rule tip, are done
      scene.clearAssist();
      scene.clearTips();

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
        gameState.leadPosition,
        gameState.isSolo
      );
      return result.legal;
    };

    // what the keyboard hand says for a dimmed card (ui/handA11y.js)
    this.cardManager.setIllegalReasonHandler?.((card) => this.illegalReason(card));
    this.cardManager.updateCardLegality(legalityChecker, canPlay);
  }

  /**
   * Why `card` can't be played right now, in words (the toast of a click on
   * a dimmed card, pointer or keyboard; iOS's words), or null for a
   * spectator (no hand of their own to play).
   */
  illegalReason(card) {
    const s = this.state || getGameState();
    if (s.isSpectator) return null;
    if (s.isLazy) return NOTICE.BOT_PLAYING;
    if (s.isBidding) return NOTICE.BID_FIRST;
    if (s.currentTurn !== s.position) return NOTICE.NOT_YOUR_TURN;
    if (s.hasPlayedCard || getMyAction().isPending()) return NOTICE.CARD_ON_ITS_WAY;
    const r = isLegalMove(card, s.myCards, s.leadCard, s.playedCardIndex === 0, s.trump, s.trumpBroken, s.position, s.leadPosition, s.isSolo);
    if (!r.legal && r.reason) return `${r.reason}.`;
    return NOTICE.TRICK_CLEARING;
  }

  /**
   * A count per side for the announcer, the sides by their players' names,
   * mine first (" Tricks: ann and cat 3, bob and dan 2."), never "your
   * team" / "opponents" (owner 2026-11-17); '' while the names are not known.
   * Built from the seats' names, never by splitting the shown "a/b", so a
   * legacy username with a "/" is said whole (as iOS).
   */
  _teamsSaid(lead, mine, theirs) {
    const s = this.state;
    const pairs = scoreHeaderPairs(s.position, teamPlayerDataOf(s), { spectator: isPureSpectator(s) });
    if (!pairs.mine || !pairs.theirs) return '';
    return `${lead} ${pairs.mine.join(' and ')} ${mine}, ${pairs.theirs.join(' and ')} ${theirs}.`;
  }

  /** Who a seat is, for the announcer: "You", or the seat's name. */
  _seatName(pos) {
    const s = this.state;
    if (pos === s.position && !s.isSpectator) return 'You';
    return this.getPlayerNameForPosition(pos);
  }

  /** "Your turn to bid." / "Your turn to lead." / "Your turn. On the trick: Ann, King of Hearts; ..." */
  turnAnnouncement() {
    const s = this.state;
    if (s.isBidding) return 'Your turn to bid.';
    const trick = s.currentTrick || [];
    if (!trick.length) return 'Your turn to lead.';
    const cards = trick.map((t) => `${this._seatName(t.position)}, ${getCardDisplayName(t.card)}`).join('; ');
    return `Your turn. On the trick: ${cards}.`;
  }

  /** The bid panel's choice: MyAction sends it (one outstanding at a time). */
  submitBid(bid) {
    const sent = getMyAction().submitBid(bid, this.state.position);
    if (sent) {
      this.clearAssist();
      this.clearTips();
    }
    return sent;
  }

  // ============================================
  // /help (plan H3): my private suggestion
  // ============================================

  /**
   * assistHint (main.js, in table order through the director): my /help
   * answer. One for this turn shows the card above my hand, the suggested
   * card or bid ringed, a dim local log row ("Help: Play 9♦ (only you see
   * this)"), and the announcer says the headline and the main reason.
   *  - A status reply while a live suggestion is up (a rate limit after
   *    repeated asks) leaves the suggestion and shows as a notice.
   *  - A bid or card answer that is not live is held: an updateTurn or a
   *    render shows it if it turns out live (it came ahead of a held
   *    updateTurn, a seq gap), else it leaves the row ASSIST_LATE_LINE.
   * Its counts are this game's either way.
   * @param {Object} hint - s2c assistHint
   */
  handleAssistHint(hint) {
    const s = this.state || getGameState();
    // the tutorial's rule tip: its own section of the card
    if (isTipHint(hint)) {
      this.handleTutorialTip(hint);
      return;
    }
    if (!isAssistHint(hint)) return;
    // the watched seat's hint (the over-the-shoulder view): shown read-only
    // while it is that seat's turn, never held, never counted
    if (isWatchedHint(hint)) {
      if (hint.kind === 'status' || !hintIsLive(hint, s)) return;
      this._showAssist(hint);
      return;
    }
    this._endAsking();
    const watching = s.isSpectator && !s.isLazy;
    // a spectator's reply ("players only") says nothing about my uses
    if (!watching) noteAssistUses(hint, s.gameId);
    const pending = getMyAction().isPending();
    const up = this._assistHint;
    if (hint.kind === 'status' && up && up.kind !== 'status' && hintIsLive(up, s, { pending })) {
      showNotice(hint.headline);
      this.syncAssistButton();
      return;
    }
    if (!hintIsLive(hint, s, { pending })) {
      this._abandonParked();
      this._parkedAssist = hint;
      this.syncAssistButton();
      return;
    }
    this._abandonParked();
    this._showAssist(hint);
  }

  /** Put a live answer up (the card, the rings, the row, the announcement). */
  _showAssist(hint) {
    const watched = isWatchedHint(hint);
    // (a watched seat's hint has no row: it is not mine)
    if (!watched) window.addPrivateToGameFeed?.(assistLogLine(hint));
    this._assistHint = hint;
    // no count in a game with a native bot seat (the hint says, or the table)
    const st = this.state || getGameState();
    const unlimited = watched || helpIsUnlimited(st, hint);
    showAssistCard(hint, {
      onClose: () => this.clearAssist(),
      unlimited,
      tutorial: !watched && tutorialIsOn(st.gameId || null),
      owner: watched ? st.getPlayerNameByPosition?.(hint.watched) || null : null,
    });
    this.cardManager?.setSuggestedCard?.(suggestedCard(hint));
    this.bidManager?.setSuggestedBid?.(suggestedBid(hint));
    announce(assistAnnouncement(hint));
    this.syncAssistButton();
  }

  /** A held (not yet live) answer is given up: its row says the turn had passed. */
  _abandonParked() {
    const held = this._parkedAssist;
    if (!held) return;
    this._parkedAssist = null;
    // the tutorial's advice is never counted: no trace needed (nor a watched seat's)
    if (held.source !== 'tutorial' && !isWatchedHint(held)) window.addPrivateToGameFeed?.(ASSIST_LATE_LINE);
  }

  /**
   * Is a bid or card answer still this turn's by its turnKey (a status
   * reply, or one without a turnKey, ends at a turn change)?
   */
  _assistStillLive(hint) {
    return !!hint && hint.kind !== 'status' && !!parseTurnKey(hint.turnKey) &&
      hintIsLive(hint, this.state, { pending: getMyAction().isPending() });
  }

  /**
   * After a turn change (or a render): a held answer that is live now
   * shows; with `abandon`, one that is not is given up. The answer up goes
   * unless it is still live.
   */
  _settleAssist({ abandon = false } = {}) {
    const held = this._parkedAssist;
    if (held && this._assistStillLive(held)) {
      this._parkedAssist = null;
      this._showAssist(held);
    } else if (held && abandon) {
      this._abandonParked();
    }
    if (this._assistHint && !this._assistStillLive(this._assistHint)) this.clearAssist();
  }

  /** The lightbulb was clicked and its answer came (or the turn moved): it may show again. */
  _endAsking() {
    this._assistAsking = false;
    clearTimeout(this._assistAskTimer);
    this._assistAskTimer = null;
  }

  /** Take my /help answer down (the card, the ring on a card or bid). */
  clearAssist() {
    // a held answer of a turn that is over now
    this._abandonParked();
    const had = !!this._assistHint;
    // focus in the card (its ✕, Escape, Why?) goes to the lightbulb when it comes back
    const focused = had && typeof document !== 'undefined' && !!document.activeElement?.closest?.('.hud-assist');
    this._assistHint = null;
    if (had) hideAssistCard();
    this.cardManager?.setSuggestedCard?.(null);
    this.bidManager?.setSuggestedBid?.(null);
    const ask = this.syncAssistButton();
    if (focused && ask && !ask.hidden) ask.focus({ preventScroll: true });
  }

  /** The /help answer up now, or null. */
  assistHint() {
    return this._assistHint || null;
  }

  /**
   * After a redraw (render): the answer up stays if it is still this
   * turn's (its rings drawn again), else it goes.
   */
  syncAssist() {
    // an answer held while the state lagged (a seq gap's snapshot): live now?
    const held = this._parkedAssist;
    if (held && this._assistStillLive(held)) {
      this._parkedAssist = null;
      this._showAssist(held);
    }
    const hint = this._assistHint;
    if (hint && !hintIsLive(hint, this.state, { pending: getMyAction().isPending() })) {
      this.clearAssist();
      return;
    }
    if (hint) {
      this.cardManager?.setSuggestedCard?.(suggestedCard(hint));
      this.bidManager?.setSuggestedBid?.(suggestedBid(hint));
    }
    this._dropStaleWatchedTips();
    this.syncAssistButton();
    this.syncTutorial();
  }

  /** A watched seat's tips go with a switch or a stop (the seat watched now keeps its own). */
  _dropStaleWatchedTips() {
    const tips = this._tips || [];
    const s = this.state;
    const keep = tips.filter((t) => !isWatchedHint(t) || (isShoulder(s) && !s.shoulder.paused && t.watched === s.position));
    if (keep.length === tips.length) return;
    this._tips = keep;
    this.drawTips();
  }

  /**
   * Is it my own bid or play turn at my seat, with nothing of mine on its
   * way (where the lightbulb shows)?
   */
  canAskHelp() {
    const s = this.state;
    // (no /help at a Get Your Bid table: owner 2026-11-24)
    if (!s || !s.position || s.isSpectator || s.isLazy || s.isSolo) return false;
    if (s.currentTurn !== s.position || !s.myCards?.length || getMyAction().isPending()) return false;
    if (s.isBidding) return s.phase === 'bidding' && s.bids?.[s.position] === undefined;
    return s.phase === 'playing' && !s.hasPlayedCard && s.stage === 'PLAYING';
  }

  /**
   * The lightbulb by my hand: on my turn at my seat while no answer is up, and
   * not while one asked for is on its way (one click, one ask).
   */
  syncAssistButton() {
    return syncAssistButton({
      visible: this.canAskHelp() && !this._assistHint && !this._assistAsking,
      onAsk: () => this.requestHelp(),
    });
  }

  /**
   * The lightbulb: send /help as the chat would. Offline, or while the session
   * is being restored (the emit gate would hold or refuse it, with a notice
   * about a "message"), the one reconnecting notice instead.
   */
  requestHelp() {
    const socket = window.socket;
    let canSend = true;
    try { canSend = getSocketManager().canSend('chatMessage') !== false; } catch { canSend = true; }
    if (!socket || socket.connected === false || !canSend) {
      showNotice(NOTICE.RECONNECTING);
      return;
    }
    // (a false here: the gate refused it and said so itself)
    if (socket.emit('chatMessage', { message: HELP_COMMAND }) === false) return;
    this._assistAsking = true;
    clearTimeout(this._assistAskTimer);
    this._assistAskTimer = setTimeout(() => {
      this._assistAskTimer = null;
      this._assistAsking = false;
      this.syncAssistButton();
    }, ASSIST_ASK_WAIT_MS);
    this.syncAssistButton();
  }

  // ============================================
  // The tutorial (state/tutorial.js): rule tips and the Tutorial button in my seat's row
  // ============================================

  /**
   * A rule tip (assistHint source tutorial, kind tip): its log row
   * ("Tutorial: ..."; the log's first ends "(only you see this)", main.js
   * tutorialFeedRow), except the welcome's (a card only), and a section at the top
   * of the card. ONE TIP CARD AT A TIME (state/tutorial.js shownTip): the
   * welcome while it is up, else the newest rule tip; a rule tip that comes
   * behind the welcome waits (kept, not drawn) and shows when the welcome
   * goes, if still up. The announcer says only the tip shown, once (a
   * waiting one when it comes into view). The game-end tip is the row and
   * its announcement (the end screen follows it). A rule tip stays until
   * its ✕, the next tip, or my own bid or card; the welcome until its
   * Keep / Turn off / ✕.
   * @param {Object} hint
   */
  handleTutorialTip(hint) {
    const s = this.state || getGameState();
    // the watched seat's rule tip (the over-the-shoulder view): its card
    // only, while that seat is watched (no row, never counted, no buttons)
    if (isWatchedHint(hint)) {
      if (!isShoulder(s) || s.shoulder.paused || hint.watched !== s.position || isWelcomeTip(hint) || isRowOnlyTip(hint)) return;
      this._tips = [...(this._tips || []).filter((t) => !isWatchedHint(t) || t.watched === hint.watched), hint];
      this.drawTips();
      return;
    }
    if (!(s.isSpectator && !s.isLazy)) noteAssistUses(hint, s.gameId);
    // The welcome is a card only (owner 2026-11-20: its card and a matching
    // log row under "<name> turned on the tutorial." read as the start
    // message twice); every other tip also leaves its row
    if (!isWelcomeTip(hint)) window.addPrivateToGameFeed?.(tipLogLine(hint));
    if (isRowOnlyTip(hint)) {
      announce(tipAnnouncement(hint));
      return;
    }
    const tips = this._tips || [];
    const welcome = isWelcomeTip(hint);
    const other = tips.filter((t) => isWelcomeTip(t) !== welcome);
    this._tips = welcome ? [hint, ...other] : [...other, hint];
    this.drawTips();
  }

  /** The tips up (oldest first). */
  tutorialTips() {
    return (this._tips || []).slice();
  }

  /** Where tips alone go: above the bid sheet on my bid turn, else above the hand. */
  _tipPlace() {
    const s = this.state;
    // my bid turn, or the watched seat's (its read-only sheet is up)
    const bidding = !!s && s.isBidding && !!s.position && isViewedSeat(s, s.position) && !s.isLazy &&
      s.currentTurn === s.position && s.bids?.[s.position] === undefined;
    return bidding ? 'bid' : 'hand';
  }

  /**
   * Draw the tip shown (one at a time; the card keeps the advice up below
   * it) and say it if it has not been said.
   */
  drawTips() {
    this._tipPlaceDrawn = this._tipPlace();
    const shown = shownTip(this._tips || []);
    if (shown) {
      this._tipsHeard ??= new WeakSet();
      if (!this._tipsHeard.has(shown)) {
        this._tipsHeard.add(shown);
        announce(tipAnnouncement(shown));
      }
    }
    showAssistTips(shown ? [shown] : [], {
      place: this._tipPlaceDrawn,
      onClose: (h) => this.closeTip(h),
      onAction: (h, a) => this.tipAction(h, a),
      owner: shown && isWatchedHint(shown) ? this.state?.getPlayerNameByPosition?.(shown.watched) || null : null,
    });
  }

  /** A tip's ✕ (Escape): the welcome's sends /tutorial close (it dismisses an auto-start; Keep does not). */
  closeTip(hint) {
    if (isWelcomeTip(hint) && !isWatchedHint(hint)) this._sendTutorial(TUTORIAL_CLOSE_COMMAND);
    this._dropTip(hint);
  }

  /** The welcome's Keep / Turn off. */
  tipAction(hint, action) {
    // a watched seat's tip sends nothing (the server drops its actions anyway)
    if (isWatchedHint(hint)) return;
    const cmd = tipActionCommand(action);
    if (!cmd) return;
    if (!this._sendTutorial(cmd)) return;
    // Turn off: every tip goes now (a rule tip waiting behind the welcome never comes up)
    if (action === 'off') {
      this._noteOffSent();
      this.clearTips({ all: true });
      return;
    }
    this._dropTip(hint);
  }

  _dropTip(hint) {
    const tips = this._tips || [];
    if (!tips.includes(hint)) return;
    this._tips = tips.filter((t) => t !== hint);
    this.drawTips();
  }

  /**
   * Take the rule tip down (my own bid or card); `all`: the welcome too
   * (the tutorial went off, a bot took my seat, the table goes).
   */
  clearTips({ all = false } = {}) {
    const tips = this._tips || [];
    const keep = all ? [] : tips.filter(isWelcomeTip);
    if (keep.length === tips.length) return;
    this._tips = keep;
    this.drawTips();
  }

  /**
   * Send a /tutorial line as the chat would; offline (or while the session
   * is restored) the one reconnecting notice instead.
   * @returns {boolean} sent
   */
  _sendTutorial(command) {
    const socket = window.socket;
    let canSend = true;
    try { canSend = getSocketManager().canSend('chatMessage') !== false; } catch { canSend = true; }
    if (!socket || socket.connected === false || !canSend) {
      showNotice(NOTICE.RECONNECTING);
      return false;
    }
    return socket.emit('chatMessage', { message: command }) !== false;
  }

  /** The off was sent: the switch waits for the server's assistState (or 10 s). */
  _noteOffSent() {
    this._tutorialOffSent = true;
    clearTimeout(this._tutorialOffTimer);
    this._tutorialOffTimer = setTimeout(() => {
      this._tutorialOffTimer = null;
      this._tutorialOffSent = false;
      this.syncTutorial();
    }, TUTORIAL_OFF_WAIT_MS);
    this.syncTutorial();
  }

  /** The Tutorial button's on -> off: `/tutorial off`. */
  turnOffTutorial() {
    if (this._tutorialOffSent) return;
    if (this._sendTutorial(TUTORIAL_OFF_COMMAND)) this._noteOffSent();
  }

  /** The Tutorial button is up and usable now (my own seat, past the draw, nothing waiting). */
  _tutorialButtonLive() {
    const s = this.state || getGameState();
    return tutorialButtonVisible(s) && !tutorialButtonDisabled(s, { pending: this._tutorialPending() });
  }

  /** A /tutorial on or off the button sent waits for the server. */
  _tutorialPending() {
    return !!this._tutorialOffSent || !!this._tutorialOnSent;
  }

  /**
   * The Tutorial button in my seat's row (ui/components/TutorialButton.js): on ->
   * off sends `/tutorial off` at once; off -> on asks first where that makes
   * this game bot-assisted for me (assistHint.tutorialNeedsConfirm: never in
   * a game with a native bot seat, nor once the server says `assisted`).
   */
  toggleTutorialFromButton() {
    if (!this._tutorialButtonLive()) return;
    const s = this.state || getGameState();
    if (tutorialIsOn(s?.gameId || null)) {
      this.turnOffTutorial();
      return;
    }
    if (tutorialNeedsConfirm(s)) {
      if (!tutorialConfirmOpen()) showTutorialConfirm({ onConfirm: () => this.turnOnTutorial() });
      return;
    }
    this.turnOnTutorial();
  }

  /** `/tutorial on` (the confirm's Turn on, or no need to ask); the button waits for assistState (or 10 s). */
  turnOnTutorial() {
    if (!this._tutorialButtonLive()) return;
    const s = this.state || getGameState();
    if (tutorialIsOn(s?.gameId || null)) return;
    if (!this._sendTutorial(TUTORIAL_ON_COMMAND)) return;
    this._tutorialOnSent = true;
    clearTimeout(this._tutorialOnTimer);
    this._tutorialOnTimer = setTimeout(() => {
      this._tutorialOnTimer = null;
      this._tutorialOnSent = false;
      this.syncTutorial();
    }, TUTORIAL_ON_WAIT_MS);
    this.syncTutorial();
  }

  /** The Tutorial button and its confirm, from the state now. */
  _syncTutorialButton() {
    const s = this.state || getGameState();
    const on = tutorialIsOn(s?.gameId || null);
    const visible = tutorialButtonVisible(s);
    const pending = this._tutorialPending();
    // the question is moot once the button is gone, the tutorial is on, or the draw is back
    if (tutorialConfirmOpen() && (!visible || on || tutorialButtonDisabled(s, { pending }))) closeTutorialConfirm();
    syncTutorialButton({
      visible,
      // an off on its way shows off already
      on: on && !this._tutorialOffSent,
      disabled: tutorialButtonDisabled(s, { pending }),
      onToggle: () => this.toggleTutorialFromButton(),
    });
  }

  /**
   * After an assistState, a snapshot, a turn change or a render: the
   * Tutorial button in my seat's row (it replaced the in-hand "Tutorial on"
   * chip, owner 2026-11-21), and with the tutorial off its tips and its advice
   * go (a /help answer stays). Tips alone move above the bid sheet on my
   * bid turn.
   */
  syncTutorial() {
    // a lazy / active change of my seat adds or drops the button's slot in my
    // row. Compared with what the HUD has, not with the cached layout: a
    // getLayout() between GameState's flip and this (a sprite in flight
    // during the director's queue) rebuilds the cache with the new key but
    // never applies it to the HUD
    const hud = hudLayout();
    if (this._layout && hud && !!hud.voice?.tutorial !== this._tutorialSlot()) this.relayout();
    const s = this.state || getGameState();
    const on = tutorialIsOn(s?.gameId || null);
    if (!on) {
      clearTimeout(this._tutorialOffTimer);
      this._tutorialOffTimer = null;
      this._tutorialOffSent = false;
      // (a watched seat's tutorial is that player's, not mine: its tips and advice stay)
      if (this._tips?.some((t) => !isWatchedHint(t))) {
        this._tips = this._tips.filter(isWatchedHint);
        this.drawTips();
      }
      if (this._parkedAssist?.source === 'tutorial') this._parkedAssist = null;
      if (this._assistHint?.source === 'tutorial' && !isWatchedHint(this._assistHint)) this.clearAssist();
    } else {
      // the server says on: the button's on is answered
      clearTimeout(this._tutorialOnTimer);
      this._tutorialOnTimer = null;
      this._tutorialOnSent = false;
    }
    this._syncTutorialButton();
    if (this._tips?.length && this._tipPlace() !== this._tipPlaceDrawn) this.drawTips();
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
    if (!this._playerInfo && !isPureSpectator(gameState)) {
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
    this.cardManager?.clearAll({ redraw: true });
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
    // a watcher (the over-the-shoulder view) is drawn as the watched seat's
    // own table, its hand read-only: a lazy watcher's view, nothing to act on
    const shoulder = role === 'spectator' && !!m.viewer?.shoulder;
    const spectator = role === 'spectator' && !shoulder;
    const lazy = role === 'lazyWatcher';
    const pos = m.viewer?.position || 1;

    // The role picks the layout (a spectator's bottom seat has no hand)
    this._spectatorView = spectator;
    this.cardManager?.setReadOnly?.(shoulder);
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
      // The draw for deal is on the bare felt, as when it opens: no play
      // zone or hand box yet. So is the countdown before it (CREATED: a
      // family lobby's extra is put at the table then, before the startDraw)
      const preDraw = !!m.draw || m.stage === 'CREATED';
      if (m.live || !preDraw) this.layoutManager.createDomBackgrounds({ skipHandArea: spectator });
    }
    // (a watcher's box is the watched seat's: another seat, another box)
    if (spectator || (this._playerInfo && this._playerInfo.position !== undefined && this._playerInfo.position !== pos)) this.clearPlayerInfo();
    if (m.playerData) this.opponentManager?.displayAvatars(m.playerData);
    if (!spectator && !this._playerInfo && m.playerData) this.createPlayerInfoBox(m.playerData, pos);
    else if (!spectator && m.playerData) {
      const i = m.playerData.position?.indexOf(pos) ?? -1;
      const u = m.playerData.username?.[i];
      if (i !== -1 && u) this.updatePlayerInfoBox({ username: u.username || u, pic: m.playerData.pics?.[i] ?? null });
    }
    if (shoulder && m.hsi === undefined) this.clearPlayerHsi();
    else if (!spectator) this.updatePlayerHsi(m.hsi);
    // the voice buttons' slot moves with the role (my box, or the corner)
    reattachMuteButton();
    placeSoundToggle();
    this._syncTutorialButton();
    this.renders = (this.renders || 0) + 1;

    if (!m.live) {
      this.opponentManager?.clearDealerButton();
      // the draw for deal so far (a rejoin, or a spectator who comes in mid-draw)
      if (m.draw) this.drawManager?.renderDraw(m);
      this.syncAssist();
      this.renderScoreHeader();
      syncShoulderHud(this.state);
      return m;
    }

    this.opponentManager?.displayDealerButton(m.dealer);
    this.opponentManager?.displayOpponentCardsBySeat(m.seatCards);
    if (m.trump) this.displayTrumpCard(m.trump, { faceUp: true });
    if (m.hand && m.hand.length) this.handleDisplayHand(m.hand, true);

    if (!m.isBidding && this.trickManager) {
      // a bore counts as the whole hand, each total capped at the hand size
      const totals = bidTotalsFor(m.bids, pos, m.handSize, m.seatCount);
      // (a Get Your Bid table: my own pile and one per opponent)
      if (m.seatCount === 3) this.trickManager.setBidTotals(totals.team, totals.opp1, totals.opp2);
      else this.trickManager.setBidTotals(totals.team, totals.opp);
      this.trickManager.createTrickBackgrounds(false);
      if (m.history && m.seatCount === 3 && m.history.some((t) => !t.winner)) {
        // (Get Your Bid with a trick whose winner is unknown: counts only)
        this.trickManager.restoreTrickPlaceholders(m.tricks.team, m.tricks.opp);
      } else if (m.history) {
        // team 1 holds the odd seats, team 2 the even ones; at a Get Your
        // Bid table each seat's tricks go to its own pile
        this.trickManager.restoreTrickHistory(m.history, m.seatCount === 3 ? (t) => this._soloPile(t.winner) : (t) => t.team % 2 === pos % 2);
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
    } else if (shoulder && !m.viewer.shoulder.paused && m.isBidding && m.hand?.length && m.bids[pos] === undefined) {
      this.showWatchedBidSheet(m.hand.length);
    }

    this.syncAssist();
    this.renderScoreHeader();
    syncShoulderHud(this.state);
    return m;
  }

  /**
   * A watcher's read-only sheet of the watched seat (BidManager readOnly):
   * its choices, chips, countdown and the mirrored hint's ring; nothing sends.
   * Open on that seat's bid turn (updateVisibility), gone on its bid.
   */
  showWatchedBidSheet(handSize) {
    const s = this.state;
    if (!this.bidManager || !isShoulder(s) || s.shoulder.paused) return;
    this.bidManager.showBidUI(handSize, null, { readOnly: true, owner: s.getPlayerNameByPosition(s.position) });
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
        socket.emit('getPlayerProfile', scopePayload({ username: avatarContainer.dataset.username }));
      }
    });

    const avatarImg = document.createElement('img');
    avatarImg.className = 'player-avatar-img hud-avatar-img';
    // Stock number, inline data URL or /avatar URL (utils/avatar.js)
    applyAvatarImg(avatarImg, seatAvatarSrc(pic));
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
    // (no HSI at a Get Your Bid table: owner 2026-11-24)
    hsiBox.hidden = !!this.state?.isSolo;
    avatarContainer.appendChild(hsiBox);

    // Into the self seat (the frog and my bubbles are its siblings there)
    const seat = hudSeat('self');
    (seat?.avatar || hudRoot()).appendChild(avatarContainer);

    // Move voice mute button into avatar container if voice is active
    reattachMuteButton();
    placeSoundToggle();
    this._syncTutorialButton();

    this._playerInfo = { avatarContainer, avatarImg, nameLabel, hsiBox, position: myPosition };
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
    // null (a custom picture with no URL) is the neutral picture, never the
    // previous one (the bot's after /active)
    applyAvatarImg(info.avatarImg, seatAvatarSrc(pic));
  }

  /**
   * Follow a resize with the own avatar box (a HUD seat: the layout moves
   * it) and the voice buttons under it.
   */
  repositionPlayerInfo() {
    if (!this._playerInfo?.avatarContainer) return;
    applyHudLayout(this.getLayout());
    reattachMuteButton();
    placeSoundToggle();
    this._syncTutorialButton();
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
   * Show the hand's HSI in the own avatar box, colored red (weak) through
   * yellow (an average deal, ~132) to green (strong).
   */
  updatePlayerHsi(hsi) {
    if (this._playerInfo?.hsiBox) this._playerInfo.hsiBox.hidden = !!this.state?.isSolo;
    if (this._playerInfo?.hsiBox && hsi !== undefined) {
      this._playerInfo.hsiBox.textContent = `HSI: ${hsi.toFixed(1)}`;
      const hue = 120 * Math.min(1, Math.max(0, (hsi - 70) / 125));
      this._playerInfo.hsiBox.style.setProperty('--hsi-color', `hsl(${hue}, 75%, 55%)`);
    }
  }

  /**
   * Reset the own avatar box's HSI to the placeholder (a new deal: the
   * value shows with the dealt cards).
   */
  clearPlayerHsi() {
    if (this._playerInfo?.hsiBox) {
      this._playerInfo.hsiBox.textContent = 'HSI: --';
      this._playerInfo.hsiBox.style.removeProperty('--hsi-color');
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
    // a held answer means nothing once the table goes (no row)
    this._parkedAssist = null;
    clearShoulderHud();
    this.cardManager?.setReadOnly?.(false);
    this._endAsking();
    this.clearAssist();
    // the tutorial's tips and button (its state goes with the table: main.js)
    this.clearTips({ all: true });
    clearTimeout(this._tutorialOffTimer);
    this._tutorialOffTimer = null;
    this._tutorialOffSent = false;
    clearTimeout(this._tutorialOnTimer);
    this._tutorialOnTimer = null;
    this._tutorialOnSent = false;
    closeTutorialConfirm();
    syncTutorialButton({ visible: false });
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
