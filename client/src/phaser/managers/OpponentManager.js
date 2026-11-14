/**
 * Opponent sprite management for Phaser.
 *
 * Handles opponent card backs, avatars, dealer button, and turn glow.
 * Every position comes from the table layout (layout/computeTableLayout.js):
 * the backs fan from their seat's `cards` anchor, the avatars and the
 * dealer frog live in the DOM HUD's seat nodes (ui/tableHud.js).
 */

import { avatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { team, rotate } from '../../utils/positions.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { sceneTween } from '../TableDirector.js';
import { layoutOf, fanPositions } from '../layout/computeTableLayout.js';
import { hudSeat, hudRoot } from '../../ui/tableHud.js';
import { buildAvatarRing, setRingPosition } from '../../ui/seatPlates.js';
import { CARD_TEXTURE_KEY } from '../cards/CardAtlas.js';
import { tableBackFrame } from '../cards/tableBack.js';
import { dealMs } from './CardManager.js';
import { dealStaggerMs, EASE_EMPHASIZED } from '../../ui/motion.js';
import { scopePayload } from '../../state/statsScope.js';

/** OpponentManager slot → layout seat ('bottom' is a spectator's self seat). */
const SEAT_OF = { partner: 'partner', opp1: 'opp1', opp2: 'opp2', bottom: 'self' };

/**
 * OpponentManager handles all opponent-related sprite operations.
 */
export class OpponentManager {
  /**
   * @param {Phaser.Scene} scene - The Phaser scene
   */
  constructor(scene) {
    this._scene = scene;

    // Card back sprites for each opponent
    this._cardSprites = {
      partner: [],
      opp1: [],
      opp2: [],
      bottom: [],
    };

    // DOM-based avatars (for CSS glow support)
    this._avatarDoms = {
      partner: null,
      opp1: null,
      opp2: null,
      bottom: null,
    };

    // Dealer button DOM element
    this._dealerButton = null;

    // Track dealer position for repositioning
    this._dealerPosition = null;

    // Player's position (needed to calculate relative positions)
    this._playerPosition = null;

    // Spectator mode flag (shows all 4 players as opponents)
    this._isSpectatorMode = false;

    // Avatar DOM trees built (webclient-21: once per game, then updated in place)
    this.avatarBuilds = 0;
    this.dealerBuilds = 0;
  }

  /**
   * Set the player's position (1-4).
   */
  setPlayerPosition(position) {
    this._playerPosition = position;
  }

  /**
   * Enable or disable spectator mode (shows all 4 players as opponents).
   */
  setSpectatorMode(enabled) {
    this._isSpectatorMode = enabled;
  }

  /**
   * Get the slot keys to iterate over based on mode.
   */
  _getSlotKeys() {
    return this._isSpectatorMode
      ? ['partner', 'opp1', 'opp2', 'bottom']
      : ['partner', 'opp1', 'opp2'];
  }

  /** The table layout this manager draws with. */
  layout() {
    return layoutOf(this._scene);
  }

  /**
   * Opponent anchors from the layout ({slot: {cardX, cardY, avatarX, avatarY}}).
   */
  getOpponentPositions() {
    const L = this.layout();
    const positions = {};
    for (const slot of this._getSlotKeys()) {
      const seat = L.seats[SEAT_OF[slot]];
      if (!seat?.cards) continue;
      positions[slot] = { cardX: seat.cards.x, cardY: seat.cards.y, avatarX: seat.avatar.x, avatarY: seat.avatar.y };
    }
    return positions;
  }

  /** Where the deal flies from: the trump card, else its layout spot. */
  _dealOrigin() {
    const scene = this._scene;
    if (scene.tableCardSprite) return { x: scene.tableCardSprite.x, y: scene.tableCardSprite.y };
    const { trump } = this.layout();
    return { x: trump.x, y: trump.y };
  }

  /** The back sprites of one slot at the layout's fan positions (optionally dealt in). */
  _drawFan(slot, count, { animate = false } = {}) {
    const L = this.layout();
    const scene = this._scene;
    const scale = L.card.back.scale;
    const spots = fanPositions(L, SEAT_OF[slot], count);
    const from = animate ? this._dealOrigin() : null;
    spots.forEach((p, i) => {
      const sprite = scene.add.image(p.x, p.y, CARD_TEXTURE_KEY, tableBackFrame());
      sprite.setScale(scale);
      sprite.setRotation(p.rotation);
      sprite.setDepth(100 + i);
      if (from) {
        // From the trump (today's deal: start larger, land at the fan's scale)
        sprite.setPosition(from.x, from.y);
        sprite.setScale(L.card.trump.scale);
        sprite.setAlpha(1);
        sprite.setRotation(0);
        // Held so a play can cancel it even before the tween manager has
        // activated it (killTweensOf misses tweens queued while hidden)
        sprite.setData('moveTween', sceneTween(scene, {
          targets: sprite,
          x: p.x,
          y: p.y,
          scaleX: scale,
          scaleY: scale,
          rotation: p.rotation,
          duration: dealMs(),
          ease: EASE_EMPHASIZED,
          delay: i * dealStaggerMs(),
        }));
      }
      this._cardSprites[slot].push(sprite);
    });
  }

  /**
   * Display opponent hands (card backs).
   *
   * @param {number} cardCount - Number of cards each opponent has
   * @param {number} dealerPosition - Position of the dealer (1-4)
   * @param {Object} playerData - Player data with usernames and pics
   * @param {boolean} skipAnimation - Skip deal animation
   */
  displayOpponentHands(cardCount, dealerPosition, playerData = null, skipAnimation = false) {
    this.clearCards();

    if (cardCount === 0) return;

    this._getSlotKeys().forEach((slot) => this._drawFan(slot, cardCount, { animate: !skipAnimation }));

    // Display dealer button
    this.displayDealerButton(dealerPosition);

    // Display opponent avatars if we have player data
    if (playerData) {
      this.displayAvatars(playerData);
    }
  }

  /**
   * Display only opponent card backs (no avatars or dealer button).
   * @param {number} cardCount - Number of cards each opponent has
   * @param {boolean} skipAnimation - Skip deal animation
   */
  displayOpponentCards(cardCount, skipAnimation = false) {
    this.clearCards();

    if (cardCount === 0) return;

    this._getSlotKeys().forEach((slot) => this._drawFan(slot, cardCount, { animate: !skipAnimation }));
  }

  /** Game position of each slot relative to the viewer ({partner, opp1, opp2[, bottom]}). */
  slotPositions() {
    const me = this._playerPosition;
    if (!me) return {};
    const map = { partner: team(me), opp1: rotate(me), opp2: rotate(rotate(rotate(me))) };
    if (this._isSpectatorMode) map.bottom = me;
    return map;
  }

  /**
   * Card backs per seat, placed at once (GameScene.render): each opponent
   * shows what the table says it holds (webclient-8).
   * @param {Object} countsByPosition - {1..4: cards in hand}
   */
  displayOpponentCardsBySeat(countsByPosition = {}) {
    this.clearCards();
    const slots = this.slotPositions();
    this._getSlotKeys().forEach((slot) => {
      const count = countsByPosition[slots[slot]] || 0;
      if (count > 0) this._drawFan(slot, count);
    });
  }

  /** Card backs left per slot (render checks). */
  cardCounts() {
    return Object.fromEntries(Object.entries(this._cardSprites).map(([k, v]) => [k, v.length]));
  }

  /** The HUD slot of a game position's seat (null: none at this table). */
  _slotOfPosition(position) {
    const me = this._playerPosition;
    if (!me || !position) return null;
    if (position === me) return this._isSpectatorMode ? 'bottom' : 'self';
    if (position === team(me)) return 'partner';
    if (position === rotate(me)) return 'opp1';
    return 'opp2';
  }

  /**
   * Display the dealer button (the frog) on the dealer's seat: a child of
   * that seat's HUD node, on its layout side (webclient-7, ui-4: one
   * coordinate space with the avatar, so it follows the avatar). One frog
   * per game: a new hand moves it to the next dealer's seat (webclient-21:
   * no rebuild, no image re-decode).
   */
  displayDealerButton(dealerPosition) {
    if (!dealerPosition || !this._playerPosition) {
      this.clearDealerButton();
      return;
    }

    this._dealerPosition = dealerPosition;
    const slot = this._slotOfPosition(dealerPosition);

    let button = this._dealerButton;
    if (!button || !button.isConnected) {
      button = document.createElement('div');
      button.className = 'dealer-button';
      // 120 px WebP (immutable, versioned), the legacy PNG if WebP fails
      const frog = document.createElement('img');
      frog.alt = 'Dealer';
      frog.decoding = 'async';
      frog.onerror = () => { frog.onerror = null; frog.setAttribute('src', 'assets/frog.png'); };
      frog.setAttribute('src', 'assets/avatars/v1/frog.webp');
      button.appendChild(frog);
      this.dealerBuilds++;
    }
    button.dataset.seat = slot === 'bottom' ? 'self' : slot;

    const seat = hudSeat(slot);
    const parent = seat?.dealer || hudRoot();
    if (button.parentElement !== parent) parent.appendChild(button);
    this._dealerButton = button;
  }

  /**
   * Display opponent avatars using DOM elements (for CSS glow support).
   * Built once per game and updated in place (webclient-21, cli-23): a new
   * hand or a render keeps the same trees, so the turn ring and the voice
   * indicator stay on and no picture is decoded again; only a changed name
   * or picture (a bot took the seat) is written.
   */
  displayAvatars(playerData) {
    if (!this._playerPosition || !playerData) {
      this.clearAvatars();
      return;
    }

    const opponentMap = this.slotPositions();
    const slots = this._getSlotKeys();

    // a slot this view no longer shows (a spectator's bottom seat after /active)
    for (const key of Object.keys(this._avatarDoms)) {
      if (this._avatarDoms[key] && !slots.includes(key)) {
        this._avatarDoms[key].remove();
        this._avatarDoms[key] = null;
      }
    }

    slots.forEach((opponentId) => {
      const pos = opponentMap[opponentId];

      // Find player data for this position
      const posIndex = playerData.position?.indexOf(pos);
      if (posIndex === -1 || posIndex === undefined) return;

      const username = playerData.username?.[posIndex]?.username ||
        playerData.username?.[posIndex] ||
        `P${pos}`;
      const pic = playerData.pics?.[posIndex];

      const dom = this._avatarDoms[opponentId];
      if (dom && dom.isConnected && dom.dataset.position === String(pos)) {
        this._updateAvatarDom(dom, pic, username);
        return;
      }
      this._createAvatarDom(opponentId, pic, username, pos);
    });
  }

  /** A built avatar takes a new name or picture (only what changed is written). */
  _updateAvatarDom(dom, pic, username) {
    const img = dom.querySelector('.opponent-avatar-img');
    const src = avatarSrc(pic);
    if (img && src && dom.dataset.src !== src) {
      applyAvatarImg(img, src);
      dom.dataset.src = src;
    }
    if (img && img.alt !== username) img.alt = username;
    dom.dataset.username = username; // the click asks for the seat's player now
    const label = dom.querySelector('.hud-plate');
    if (label && label.textContent !== username) {
      label.textContent = username;
      label.title = username;
    }
  }

  /**
   * Create a DOM-based avatar element in its HUD seat (sized by the HUD's
   * layout variables).
   */
  _createAvatarDom(opponentId, pic, username, position = null) {
    // Remove existing
    if (this._avatarDoms[opponentId]) {
      this._avatarDoms[opponentId].remove();
    }

    const container = document.createElement('div');
    container.id = `opponent-avatar-${opponentId}`;
    container.className = `opponent-avatar-container ${opponentId}`;
    container.dataset.position = position ? String(position) : '';
    container.dataset.username = username;
    this.avatarBuilds++;

    // the avatar outlives its first player (built once per game): the click
    // reads the seat's name now, so a bot that took the seat (or the human
    // back from /lazy) is whose profile it opens
    container.addEventListener('click', () => {
      const sm = getSocketManager();
      if (sm.socket) {
        sm.socket.emit('getPlayerProfile', scopePayload({ username: container.dataset.username }));
      }
    });

    // Avatar image
    const img = document.createElement('img');
    img.className = 'opponent-avatar-img hud-avatar-img';
    // Stock number, inline data URL or /avatar URL (utils/avatar.js)
    applyAvatarImg(img, avatarSrc(pic));
    container.dataset.src = avatarSrc(pic) || '';
    img.alt = username;
    // in its seat ring: the team's color, the bid chip and the trick pips (ui/seatPlates.js)
    container.appendChild(buildAvatarRing(img, position));

    // Username label (the seat's plate)
    const label = document.createElement('div');
    label.className = 'hud-plate';
    label.textContent = username;
    label.title = username; // the plate truncates a long name (its seat's width)
    container.appendChild(label);

    const seat = hudSeat(opponentId);
    (seat?.avatar || hudRoot()).appendChild(container);
    this._avatarDoms[opponentId] = container;
  }

  /**
   * Add turn glow to an opponent avatar.
   */
  addTurnGlow(opponentId) {
    const dom = this._avatarDoms[opponentId];
    if (dom) {
      dom.classList.add('turn-glow');
    }
  }

  /**
   * Remove turn glow from all opponent avatars.
   */
  removeTurnGlow() {
    Object.values(this._avatarDoms).forEach((dom) => {
      if (dom) {
        dom.classList.remove('turn-glow');
      }
    });
  }

  /**
   * Update turn glow based on current turn position.
   * Adds glow to the appropriate opponent avatar.
   *
   * @param {number} currentTurn - The position (1-4) of the current turn
   */
  updateTurnGlow(currentTurn) {
    this.removeTurnGlow();

    if (!this._playerPosition) return;

    if (currentTurn === this._playerPosition) {
      if (this._isSpectatorMode) {
        // In spectator mode, glow the bottom avatar
        this.addTurnGlow('bottom');
      }
      return;
    }

    // Determine which opponent has the turn
    const partnerPos = team(this._playerPosition);
    const opp1Pos = rotate(this._playerPosition);
    const opp2Pos = rotate(rotate(rotate(this._playerPosition)));

    if (currentTurn === partnerPos) {
      this.addTurnGlow('partner');
    } else if (currentTurn === opp1Pos) {
      this.addTurnGlow('opp1');
    } else if (currentTurn === opp2Pos) {
      this.addTurnGlow('opp2');
    }
  }

  /**
   * Update player info (name + pic) for a given position.
   * Used when a bot takes over (resignation, lazy mode) or player resumes (active mode).
   *
   * @param {number} position - Game position (1-4)
   * @param {Object} info - { username, pic }
   */
  updatePlayerInfo(position, { username, pic }) {
    if (!this._playerPosition) return;

    // Determine which opponent slot this position maps to
    const partnerPos = team(this._playerPosition);
    const opp1Pos = rotate(this._playerPosition);
    const opp2Pos = rotate(rotate(rotate(this._playerPosition)));

    let opponentId = null;
    if (position === partnerPos) opponentId = 'partner';
    else if (position === opp1Pos) opponentId = 'opp1';
    else if (position === opp2Pos) opponentId = 'opp2';
    else if (position === this._playerPosition && this._isSpectatorMode) opponentId = 'bottom';

    if (!opponentId) return; // This is the local player's own position

    const dom = this._avatarDoms[opponentId];
    if (!dom) return;

    // Update the image
    const img = dom.querySelector('.opponent-avatar-img');
    if (img) {
      applyAvatarImg(img, avatarSrc(pic));
      dom.dataset.src = avatarSrc(pic) || '';
      img.alt = username;
    }

    dom.dataset.username = username;

    // Update the label
    const label = dom.querySelector('.hud-plate');
    if (label) {
      label.textContent = username;
      label.title = username;
    }
  }

  /**
   * Remove a card from an opponent's hand (when they play).
   *
   * @param {string} opponentId - 'partner', 'opp1', or 'opp2'
   * @returns {Phaser.GameObjects.Image|null} The removed sprite
   */
  removeCard(opponentId) {
    const sprites = this._cardSprites[opponentId];
    if (sprites && sprites.length > 0) {
      return sprites.pop();
    }
    return null;
  }

  /**
   * Follow a relayout: every back to its fan spot at the layout's scale.
   * A deal tween still heading for the old spot is stopped first (the
   * relayout fast-forwards a live deal, so this is the not-live case:
   * webclient-17(c)). The avatars and the frog are HUD children: the HUD's
   * layout moves them.
   */
  reposition() {
    const L = this.layout();
    const scale = L.card.back.scale;

    this._getSlotKeys().forEach((slot) => {
      const sprites = (this._cardSprites[slot] || []).filter((sp) => sp && sp.active !== false);
      if (!sprites.length) return;
      const spots = fanPositions(L, SEAT_OF[slot], sprites.length);
      sprites.forEach((sprite, index) => {
        const moveTween = sprite.getData?.('moveTween');
        if (moveTween) {
          moveTween.stop?.();
          sprite.setData('moveTween', null);
        }
        this._scene.tweens?.killTweensOf?.(sprite);
        const p = spots[index];
        sprite.x = p.x;
        sprite.y = p.y;
        sprite.setScale(scale);
        sprite.setRotation(p.rotation);
      });
    });
  }

  /**
   * Clear all card sprites.
   */
  clearCards() {
    // Every slot, the spectator's bottom one too (a role change keeps none)
    Object.keys(this._cardSprites).forEach((opponentId) => {
      if (this._cardSprites[opponentId]) {
        this._cardSprites[opponentId].forEach((sprite) => {
          if (sprite && sprite.destroy) {
            sprite.destroy();
          }
        });
        this._cardSprites[opponentId] = [];
      }
    });
  }

  /**
   * Clear all avatar DOM elements.
   */
  clearAvatars() {
    Object.keys(this._avatarDoms).forEach((key) => {
      if (this._avatarDoms[key]) {
        this._avatarDoms[key].remove();
        this._avatarDoms[key] = null;
      }
    });
  }

  /**
   * Clear dealer button.
   */
  clearDealerButton() {
    if (this._dealerButton) {
      this._dealerButton.remove();
      this._dealerButton = null;
    }
    this._dealerPosition = null;
  }

  /**
   * Clear all opponent elements.
   */
  clearAll() {
    this.clearCards();
    this.clearAvatars();
    this.clearDealerButton();
  }

  /**
   * Get card count for an opponent.
   */
  getCardCount(opponentId) {
    return this._cardSprites[opponentId]?.length || 0;
  }
}
