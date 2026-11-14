/**
 * DrawManager - the draw for deal (startDraw -> playerDrew x4 -> teamsAnnounced).
 *
 * The iOS DrawPhaseView's structure and design language (PR 239), on the
 * web's own pieces:
 *
 *   - the canvas has the cards: the deck (54 backs in a row; each card is
 *     its own button, the one under the pointer is the one picked, and it
 *     peeks up under the pointer) and the drawn cards, which fly from the
 *     deck and turn face up into their slot (at least the hand card's size,
 *     larger where the canvas has the height; each face from its own frame,
 *     cards/drawSlotFaces.js, so 1:1 at any size);
 *   - the HUD has the words and the players (ui/drawHud.js): the title and
 *     the rule, each slot's avatar and name over a dashed placeholder, the
 *     prompt under the deck, then the teams panel over a scrim.
 *
 * Every place is the table layout's (computeTableLayout draw / teams), so a
 * relayout moves it all; every tween goes through the TableDirector
 * (sceneTween / sceneDelay). The teams fade to black is sized to the
 * server's hold (teamsAnnounced.resumeInMs, pacing.js), never to motion
 * settings; the cosmetic durations follow reduced motion (motionMs).
 */

import { getGameState } from '../../state/GameState.js';
import { getCardImageKey } from '../../utils/cards.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { teamsFade } from '../pacing.js';
import { sceneDelay, sceneTween } from '../TableDirector.js';
import { createTransitionOverlay, setOverlayState } from '../../ui/transitionOverlay.js';
import { layoutOf, deckPosition } from '../layout/computeTableLayout.js';
import { CARD_TEXTURE_KEY } from '../cards/CardAtlas.js';
import { tableBackFrame } from '../cards/tableBack.js';
import { MOTION } from '../../ui/tokens.js';
import { motionMs, EASE_EMPHASIZED } from '../../ui/motion.js';
import { applyHudLayout } from '../../ui/tableHud.js';
import { showDrawHud, fillDrawSlot, landDrawSlot, fitDrawNames, endMyDraw, showTeamsHud, clearDrawHud, drawHud } from '../../ui/drawHud.js';
import { DRAW_SLOTS_KEY, ensureDrawSlotFace } from '../cards/drawSlotFaces.js';

/** A deck card under the pointer peeks up by this share of its height. */
export const DECK_PEEK = 0.12;

export class DrawManager {
  constructor(scene) {
    this.scene = scene;
    this.state = getGameState();

    // Deck cards by deck index (null once drawn) and the drawn cards
    this.allCards = [];
    this.drawnCardDisplays = [];

    // My clicked card (it is the one that flies to my slot)
    this.clickedCardSprite = null;
    this.clickedCardIndex = null;

    this._teamsShown = false;
    this._spectator = false;

    // Pending fade-to-black timer (cancelled in cleanup so a stale one can't
    // add an overlay after the game UI has been built)
    this._fadeTimer = null;
  }

  /** The table layout this manager draws with (its `draw` and `teams` parts). */
  layout() {
    return layoutOf(this.scene);
  }

  /**
   * Check if document is visible (for animation decisions).
   */
  isVisible() {
    return document.visibilityState === 'visible';
  }

  /**
   * Show the draw: the HUD's title, rule, waiting slots and prompt, and the
   * deck of 54 backs flying in. Called on startDraw.
   */
  showDrawUI() {
    this.cleanup();
    this.state.setHasDrawn(false);
    this._spectator = !!this.state.isSpectator;

    const L = this.layout();
    applyHudLayout(L);
    showDrawHud({ spectator: this._spectator, onDraw: () => this.drawByKey() });
    const flyIn = this.isVisible();
    for (let i = 0; i < 54; i++) this._addDeckCard(L, i, { flyIn, pickable: !this._spectator });
  }

  /**
   * The draw as the model has it (render(): a rejoin, or a spectator who
   * comes in mid-draw): the HUD, the cards still in the deck (a button for a
   * seat that has not drawn), and the cards drawn so far face up in their
   * slots. The draws still to come fly from the deck as usual.
   * @param {Object} m - GameState.renderModel(): its `draw` and `viewer`
   */
  renderDraw(m) {
    const draw = m?.draw;
    if (!draw) return;
    this.cleanup();
    this._spectator = (m.viewer?.role || 'seat') !== 'seat';
    const L = this.layout();
    const done = this._spectator || !!draw.hasDrawn || draw.viewerDrawOrder !== null;
    applyHudLayout(L);
    showDrawHud({ spectator: this._spectator, onDraw: () => this.drawByKey() });
    if (done && !this._spectator) endMyDraw();
    const left = Math.max(0, 54 - draw.drawn.length);
    for (let i = 0; i < left; i++) this._addDeckCard(L, i, { flyIn: false, pickable: !done });
    for (const d of draw.drawn) {
      const slot = L.draw.slots[d.drawOrder - 1];
      if (!slot) continue;
      const mine = !this._spectator && (d.drawOrder === draw.viewerDrawOrder || (!!this.state.username && d.username === this.state.username));
      if (d.card) {
        const face = getCardImageKey(d.card);
        const card = this.scene.add.image(slot.x, slot.y, DRAW_SLOTS_KEY, this._slotFace(L, d.drawOrder - 1, face))
          .setScale(L.draw.slotCard.scale).setDepth(300);
        card.setData?.('drawOrder', d.drawOrder);
        card.setData?.('faceKey', face);
        this.drawnCardDisplays.push(card);
      }
      fillDrawSlot(d.drawOrder - 1, { username: d.username, mine, card: d.card, announce: false });
      if (d.card) landDrawSlot(d.drawOrder - 1);
    }
  }

  /** Slot i's face at the layout's slot size (its own frame: cards/drawSlotFaces.js); the frame name. */
  _slotFace(L, i, faceKey) {
    return ensureDrawSlotFace(this.scene.textures, L.draw.slotCard.tex, i, faceKey);
  }

  /**
   * Deck card i: its own button over its visible bounds (the atlas frame IS
   * the card: no padding), so the one under the pointer is the one picked
   * (Phaser's input checks the top object first; a later card lies over the
   * one before it; ui-19: one hit zone used to map a click two or three
   * cards to the left). A spectator's deck is not theirs to pick from.
   */
  _addDeckCard(L, i, { flyIn, pickable }) {
    const { deck } = L.draw;
    const spot = deckPosition(L, i);
    const cardSprite = this.scene.add.image(flyIn ? deck.enterX : spot.x, spot.y, CARD_TEXTURE_KEY, tableBackFrame())
      .setScale(deck.card.scale).setDepth(100);
    cardSprite.setData?.('deckIndex', i);
    if (flyIn) {
      cardSprite.setData?.('moveTween', sceneTween(this.scene, {
        targets: cardSprite,
        x: spot.x,
        y: spot.y,
        duration: motionMs(MOTION.slow * 2),
        ease: EASE_EMPHASIZED,
        delay: 0,
        onComplete: () => { if (cardSprite.scene) cardSprite.setData?.('moveTween', null); },
      }));
    }
    if (pickable) {
      cardSprite.setInteractive(
        new Phaser.Geom.Rectangle(0, 0, cardSprite.width, cardSprite.height),
        Phaser.Geom.Rectangle.Contains
      );
      if (cardSprite.input) cardSprite.input.cursor = 'pointer';
      cardSprite.on('pointerdown', () => this._onDeckCardDown(cardSprite));
      cardSprite.on('pointerover', () => this._peek(cardSprite, true));
      cardSprite.on('pointerout', () => this._peek(cardSprite, false));
    }
    this.allCards[i] = cardSprite;
    return cardSprite;
  }

  /**
   * A deck card under the pointer peeks up (its hit area grows down by as
   * much, so the pointer stays on it); it settles back when the pointer
   * leaves, a draw is made or the deck moves.
   */
  _peek(card, up) {
    if (!card?.active || card.getData?.('deckIndex') === undefined) return;
    if (up && (this.state.hasDrawn || this._teamsShown || card.getData?.('moveTween'))) return;
    const L = this.layout();
    const home = deckPosition(L, card.getData('deckIndex'));
    const lift = up ? L.draw.deck.card.h * DECK_PEEK : 0;
    const area = card.input?.hitArea;
    if (area) area.height = card.height + (card.scaleY ? lift / card.scaleY : 0);
    this.scene.tweens?.killTweensOf?.(card);
    sceneTween(this.scene, { targets: card, y: home.y - lift, duration: motionMs('fast'), ease: EASE_EMPHASIZED });
  }

  /** The keyboard / screen reader button: draw the deck's middle card (any card: the server picks the value). */
  drawByKey() {
    const cards = this.deckCards();
    if (!cards.length) return;
    this._onDeckCardDown(cards[Math.floor(cards.length / 2)].card);
  }

  /** My click on a deck card: that card is mine to flip (the server picks the value). */
  _onDeckCardDown(cardSprite) {
    if (this.state.hasDrawn || this._spectator) return;
    const index = this.allCards.indexOf(cardSprite);
    if (index < 0) return;
    this.state.setHasDrawn(true);

    // Store clicked card sprite and index for the draw animation
    this.clickedCardSprite = cardSprite;
    this.clickedCardIndex = index;

    // Emit draw event to server
    getSocketManager().emit('draw', { num: Math.floor(Math.random() * 54) });

    this._closeDeck();
  }

  /** No more picks: the deck stops being buttons, the prompt goes, a peeking card settles. */
  _closeDeck() {
    const L = this.layout();
    for (const { card } of this.deckCards()) {
      card.disableInteractive?.();
      if (card === this.clickedCardSprite) continue;
      const home = deckPosition(L, card.getData('deckIndex'));
      if (card.y !== home.y && !card.getData?.('moveTween')) {
        this.scene.tweens?.killTweensOf?.(card);
        sceneTween(this.scene, { targets: card, y: home.y, duration: motionMs('fast'), ease: EASE_EMPHASIZED });
      }
    }
    endMyDraw();
  }

  /** Deck cards still in the deck (not drawn), with their deck index. */
  deckCards() {
    return this.allCards
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card && card.active !== false && card.getData?.('deckIndex') !== undefined);
  }

  /** The drawn cards on the canvas (in draw order 1-4 by their 'drawOrder'). */
  drawnCards() {
    return this.drawnCardDisplays.filter((o) => o?.active !== false && o?.getData?.('drawOrder'));
  }

  /**
   * Follow a relayout: the deck, the drawn cards and the HUD go to their
   * places in the new layout (ui-19: the draw used to ignore a resize).
   * Tweens still heading for the old places are cut short at their end
   * state. (applyHudLayout already moved the HUD's words and players.)
   */
  relayout() {
    const L = this.layout();
    const { draw } = L;
    const stop = (obj) => {
      const t = obj.getData?.('moveTween');
      if (t) {
        t.stop?.();
        obj.setData('moveTween', null);
      }
      this.scene.tweens?.killTweensOf?.(obj);
    };
    if (!this._teamsShown) {
      // the deck in its row (the teams whisk sends it off the top: leave it)
      for (const { card } of this.deckCards()) {
        stop(card);
        const p = deckPosition(L, card.getData('deckIndex'));
        card.setPosition(p.x, p.y);
        card.setScale(draw.deck.card.scale);
        if (card.input?.hitArea) card.input.hitArea.height = card.height;
      }
    }
    // the drawn cards face up in their slots
    for (const item of this.drawnCards()) {
      const slot = draw.slots[item.getData('drawOrder') - 1];
      if (!slot) continue;
      stop(item);
      const face = item.getData('faceKey');
      if (face) item.setTexture(DRAW_SLOTS_KEY, this._slotFace(L, item.getData('drawOrder') - 1, face));
      item.setPosition(slot.x, slot.y);
      item.setScale(draw.slotCard.scale);
      item.setAlpha?.(1);
      landDrawSlot(item.getData('drawOrder') - 1);
    }
    fitDrawNames();
  }

  /**
   * My own draw's card (youDrew): the deck is no longer mine to pick from
   * (the server's 30 s auto-draw sends it without a click too). The card
   * itself flies with playerDrew.
   */
  handleYouDrew() {
    if (!this._spectator) this._closeDeck();
  }

  /**
   * A draw (any player's, in draw order): a card leaves the deck (mine: the
   * one I clicked), turns face up on its way to the slot, and the slot shows
   * the player. Called on playerDrew.
   * @param {Object} data - { username, card, drawOrder, position }
   */
  handlePlayerDrew(data) {
    const L = this.layout();
    const { draw } = L;
    // a draw seen without the draw up (no startDraw or render of it here):
    // its words and slots, as a spectator's (no deck to pick from)
    if (!drawHud()) {
      applyHudLayout(L);
      showDrawHud({ spectator: true });
    }
    const order = Math.max(1, Math.min(4, data.drawOrder || 1));
    const slot = draw.slots[order - 1];
    const textureKey = getCardImageKey(data.card);
    const mine = !this._spectator && !!this.state.username && data.username === this.state.username;

    let drawnCard = null;
    let cardIndexToRemove;
    if (mine && this.clickedCardSprite?.active !== false && this.clickedCardSprite) {
      drawnCard = this.clickedCardSprite;
      cardIndexToRemove = this.clickedCardIndex;
      this.clickedCardSprite = null;
      this.clickedCardIndex = null;
    } else {
      // another player's (or my auto-draw): any card still in the deck,
      // never the one I clicked (mine flies with my own draw)
      const available = this.deckCards().filter(({ card }) => card !== this.clickedCardSprite);
      if (available.length > 0) {
        const pick = available[Math.floor(Math.random() * available.length)];
        cardIndexToRemove = pick.index;
        drawnCard = pick.card;
      } else {
        const p = deckPosition(this.layout(), 0);
        drawnCard = this.scene.add.image(p.x, p.y, CARD_TEXTURE_KEY, tableBackFrame()).setScale(draw.deck.card.scale);
      }
    }
    if (mine) this._closeDeck();
    if (cardIndexToRemove !== undefined) this.allCards[cardIndexToRemove] = null;
    drawnCard.setDepth(300);

    // A drawn card leaves the deck: no longer a button, its slot and face kept for a relayout
    drawnCard.disableInteractive?.();
    drawnCard.removeAllListeners?.('pointerdown');
    drawnCard.removeAllListeners?.('pointerover');
    drawnCard.removeAllListeners?.('pointerout');
    drawnCard.setData?.('deckIndex', undefined);
    drawnCard.setData?.('drawOrder', order);
    drawnCard.setData?.('faceKey', textureKey);
    this.scene.tweens?.killTweensOf?.(drawnCard);
    const inTween = drawnCard.getData?.('moveTween');
    if (inTween) {
      inTween.stop?.();
      drawnCard.setData('moveTween', null);
    }

    // The slot shows who drew (its placeholder goes as the card comes)
    fillDrawSlot(order - 1, { username: data.username, mine, card: data.card });

    // Fly and turn over: half way the back narrows to its edge (growing to
    // the slot card's height), the face widens from it into the slot, and
    // the slot's dashed placeholder fades out as it comes (never an empty
    // slot while the card is on its way)
    const start = { x: drawnCard.x, y: drawnCard.y };
    const flip = motionMs('base');
    const backScaleY = drawnCard.height ? draw.slotCard.h / drawnCard.height : draw.slotCard.scale;
    sceneTween(this.scene, {
      targets: drawnCard,
      x: (start.x + slot.x) / 2,
      y: (start.y + slot.y) / 2,
      scaleX: 0,
      scaleY: backScaleY,
      duration: flip,
      ease: EASE_EMPHASIZED,
      onComplete: () => {
        if (!drawnCard || !drawnCard.scene) return;
        const now = this.layout();
        drawnCard.setTexture(DRAW_SLOTS_KEY, this._slotFace(now, order - 1, textureKey));
        drawnCard.setScale(0, now.draw.slotCard.scale);
        landDrawSlot(order - 1, { ms: flip });
        const to = now.draw.slots[order - 1] || slot;
        sceneTween(this.scene, {
          targets: drawnCard,
          x: to.x,
          y: to.y,
          scaleX: now.draw.slotCard.scale,
          scaleY: now.draw.slotCard.scale,
          duration: flip,
          ease: EASE_EMPHASIZED,
        });
      },
    });

    this.drawnCardDisplays.push(drawnCard);
  }

  /**
   * The teams (teamsAnnounced): the deck leaves, the drawn cards stay face
   * up under the teams panel, then the fade to black ends when the server's
   * hold does.
   * @param {Object} data - { team1: [username1, username2], team2: [...], resumeInMs }
   */
  handleTeamsAnnounced(data) {
    const L = this.layout();
    this._teamsShown = true;

    // The deck's part is over: it settles into its row and fades out under
    // the scrim (iOS shows only the results by now)
    for (const { card } of this.deckCards()) {
      card.disableInteractive?.();
      this.scene.tweens?.killTweensOf?.(card);
      card.setData?.('moveTween', null);
      sceneTween(this.scene, {
        targets: card,
        y: deckPosition(L, card.getData('deckIndex')).y,
        alpha: 0,
        duration: motionMs('slow'),
        ease: EASE_EMPHASIZED,
      });
    }

    this._showTeamAnnouncement(data);
  }

  /** The seat's picture for a username once the players are seated (positionUpdate comes before the teams). */
  picFor(username) {
    const pd = this.state.playerData;
    if (!pd?.username) return null;
    const i = pd.username.findIndex((u) => (u?.username ?? u) === username);
    return i >= 0 ? (pd.pics?.[i] ?? null) : null;
  }

  /**
   * The teams panel, then the fade to black.
   * @param {Object} data - { team1: [username1, username2], team2: [username1, username2], resumeInMs }
   */
  _showTeamAnnouncement(data) {
    endMyDraw();
    showTeamsHud(data, { me: this._spectator ? null : this.state.username, picFor: (u) => this.picFor(u) });

    // After showing teams for a moment, fade to black, ending exactly when
    // the server's hold does (teamsAnnounced.resumeInMs; createUI then
    // forces the overlay opaque)
    const { fadeDelay, fadeDuration } = teamsFade(data.resumeInMs);

    // The first deal waits for this fade (TableDirector.uiReady)
    this.scene.director?.beginFade();
    this._fadeTimer = sceneDelay(this.scene, fadeDelay, () => {
      this._fadeTimer = null;
      // DOM overlay for the fade to black (covers the DOM UI too);
      // handleCreateUI finds it through transitionOverlay.js
      const domOverlay = createTransitionOverlay({ opacity: 0, transitionMs: fadeDuration });

      // Force reflow and start fade
      domOverlay.offsetHeight;
      setOverlayState(domOverlay, { opaque: true });
    });
  }

  /**
   * Clean up and remove the draw UI (the canvas cards and the HUD layers).
   * Called when transitioning to the game phase, and by every render.
   */
  cleanup() {
    if (this._fadeTimer) {
      this._fadeTimer.remove(false);
      this._fadeTimer = null;
    }

    for (const card of this.allCards) card?.destroy?.();
    this.allCards = [];
    for (const item of this.drawnCardDisplays) item?.destroy?.();
    this.drawnCardDisplays = [];
    clearDrawHud();

    this.clickedCardSprite = null;
    this.clickedCardIndex = null;
    this._teamsShown = false;
  }
}
