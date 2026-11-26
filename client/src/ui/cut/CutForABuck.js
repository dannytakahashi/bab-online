/**
 * Cut for a buck on the web (owner 2026-11-25; spec section 6): the
 * tournament lobby's main column while the cut runs (TournamentLobby
 * enterCut). The header (voice) and the chat stay; this view is the ring of
 * players around the deck, drawn from the one state (state/cutForABuck.js,
 * ui/cut/cutStore.js) at every change.
 *
 *   - the ring (ringLayout.js): me at 6 o'clock, then clockwise; avatars
 *     (speaking rings from voice), names ("you" for me), captions; each
 *     player's cards on the inward ray, the newest in front, up to 3 older
 *     ones behind it, then "+n"; cards are canvases painted with the
 *     table's own card faces (phaser/cards/cardFaces.js drawCard / drawBack)
 *   - the deck: a face-down fan narrowing as it empties (+-50 degrees full),
 *     one button ("Draw a card", "37 cards left"); the card under the
 *     pointer peeks up and its slot is what is sent (cutForABuckDraw
 *     {round, slot}); arrows move the peek, Enter / Space draw. A spectator's
 *     deck is not a button
 *   - draws fly from the deck to the player (a back); at the reveal they
 *     flip together (300 ms after the last lands, 400 ms each, 40 ms
 *     stagger), the verdict at +1.2 s: the out players dim with "Out ·
 *     round 2" and a danger outline on the losing card; a reshuffle sends
 *     the table's cards back to the deck; the winner glides to the centre
 *     at twice the size with the gold glow and the buck glyph
 *   - the intro (owner note, under 3 s): "Cut for a buck!" scales in, the
 *     deck riffles and fans, the avatars slide into the ring. Reduced
 *     motion: crossfades only
 *   - Ring | List: the list is one click away (and the default from
 *     13 players at a narrow width)
 *   - sounds (existing cues, the page's mute): draw, card at the flip, set
 *     when someone else is out, gameend-lose when I am, gameend-win for the
 *     winner and gameend for everyone else, turn 5 s before my auto-draw
 *   - screen readers: the ring is a list in ring order (me first), each
 *     player "kim, out in round 2, 3 of clubs" (+ "talking"); one polite
 *     announcement per reveal, an assertive one for the winner; draws are
 *     never announced one by one
 */

import { el, createButton } from '../kit/index.js';
import { ringLayout, ringOrder, STACK_OFFSET, STACK_SHOWN, DENSE_EDGE, CARD_RATIO } from './ringLayout.js';
import {
  STAGE, statusLines, roundLine, deckLine, deckLeft, seatView, verdictLines, revealAnnouncement, winnerLine, ringPlayers,
  isAlive, cardShort, lowestRank, RULES_LINE,
} from '../../state/cutForABuck.js';
import { drawCard, BACK_FRAMES, CARD_DESIGN } from '../../phaser/cards/cardFaces.js';
import { avatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { prefersReducedMotion } from '../motion.js';
import { getSoundManager } from '../../audio/SoundManager.js';
import { createSoundToggle } from '../components/SoundToggle.js';
import { RANK_VALUES } from '../../constants/ranks.js';

/** Animation timings (ms; spec section 6 "Timing"). */
export const TIMING = Object.freeze({
  intro: 2600,
  lift: 120,
  flight: 350,
  flipDelay: 300,
  flip: 400,
  flipStagger: 40,
  verdict: 1200,
  reducedVerdict: 300,
  winnerGlide: 700,
});
const DPR = () => Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
/** Fallback stage size where the page has no layout (tests). */
const FALLBACK = { w: 640, h: 420 };
/** The fan's widest half-angle (degrees, a full deck). */
const FAN_DEG = 50;
const VIEW_KEY = 'bab.cutView';
/** A seat's name line plus its caption line under the avatar (px). */
const NAME_BOX_H = 30;
/** The deck's caption line, inside the deck's box under the fan (px). */
const DECK_CAPTION_H = 14;

let current = null;

/** Is the cut on screen (sound follows it: main.js syncTableScreen). */
export function isCutShowing() {
  return !!current && current.element.isConnected;
}

/** The view on screen, or null. */
export function getCutView() {
  return current;
}

// ------------------------------------------------------------ painting

function context2d(canvas) {
  try {
    const ctx = canvas.getContext?.('2d');
    return ctx && typeof ctx.setTransform === 'function' ? ctx : null;
  } catch {
    return null;
  }
}

/** Paint a card (face, or BACK_FRAMES.red) into a canvas of w x h CSS px. */
export function paintCard(canvas, card, w, h) {
  const dpr = DPR();
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = context2d(canvas);
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / CARD_DESIGN.w, canvas.height / CARD_DESIGN.h);
  try {
    drawCard(ctx, card);
  } catch (err) {
    console.warn('[Cut] card paint failed:', err?.message || err);
    return false;
  }
  return true;
}

/**
 * The fan's geometry for `count` cards in a box of w x h: the pivot, card
 * size and half-angle (radians). The cards rotate about the pivot (their
 * bottom centre), spread evenly from -half to +half.
 */
export function fanGeometry(w, h, count, deckSize) {
  const share = deckSize > 0 ? Math.min(1, count / deckSize) : 0;
  const half = count <= 1 ? 0 : (Math.max(4, FAN_DEG * share) * Math.PI) / 180;
  // fit: width 2 (ch sin a + cw/2 cos a); height the lift room, the card,
  // and the outer cards' bottom corners dipping below the pivot (cw/2 sin a)
  const lift = 0.12;
  const dip = Math.sin(half) / CARD_RATIO / 2;
  let ch = (h * 0.97) / (1 + lift + dip);
  const widthOf = (c) => 2 * (c * Math.sin(half) + (c / CARD_RATIO / 2) * Math.cos(half));
  if (widthOf(ch) > w * 0.96) ch = (w * 0.96) / (widthOf(1) || 1);
  const cw = ch / CARD_RATIO;
  return { half, ch, cw, px: w / 2, py: h * 0.03 + ch * (1 + lift), lift };
}

/** The angle of free card i of n in the fan. */
export function fanAngle(i, n, half) {
  return n <= 1 ? 0 : -half + (2 * half * i) / (n - 1);
}

/** The free card index nearest a point (x, y) in the fan box. */
export function fanIndexAt(x, y, geo, n) {
  if (n <= 0) return -1;
  if (n === 1) return 0;
  const a = Math.atan2(x - geo.px, geo.py - y);
  const i = Math.round(((a + geo.half) / (2 * geo.half)) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/** The free slots of the round's deck, in order. */
export function freeSlots(state) {
  if (!state) return [];
  const taken = new Set(Object.values(state.drawn || {}).map((d) => d.slot));
  const out = [];
  const n = state.stage === STAGE.DRAWING ? state.deckCount : deckLeft(state);
  for (let i = 0; i < n; i++) if (!taken.has(i) || state.stage !== STAGE.DRAWING) out.push(i);
  return out;
}

let backCache = null;
function backImage(cw, ch) {
  const dpr = DPR();
  const key = `${Math.round(cw * dpr)}x${Math.round(ch * dpr)}`;
  if (backCache?.key === key) return backCache.canvas;
  const c = document.createElement('canvas');
  if (!paintCard(c, BACK_FRAMES.red, cw, ch)) return null;
  backCache = { key, canvas: c };
  return c;
}

function paintFan(canvas, w, h, count, deckSize, peek) {
  const dpr = DPR();
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = context2d(canvas);
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (count <= 0) return;
  const geo = fanGeometry(w, h, count, deckSize);
  const img = backImage(geo.cw, geo.ch);
  if (!img) return;
  for (let i = 0; i < count; i++) {
    const a = fanAngle(i, count, geo.half);
    ctx.save();
    ctx.translate(geo.px, geo.py);
    ctx.rotate(a);
    const up = i === peek ? geo.ch * geo.lift : 0;
    ctx.drawImage(img, -geo.cw / 2, -geo.ch - up, geo.cw, geo.ch);
    ctx.restore();
  }
}

// ------------------------------------------------------------ the view

const BUCK_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="M12 5.5v13M15.2 8.4c-.6-.9-1.8-1.4-3.2-1.4-1.9 0-3.2 1-3.2 2.4 0 3.4 6.6 1.8 6.6 5.1 0 1.5-1.4 2.5-3.4 2.5-1.6 0-2.9-.6-3.5-1.6" fill="none" stroke="var(--surface-0)" stroke-width="1.9" stroke-linecap="round"/></svg>';

function readView() {
  try {
    return globalThis.localStorage?.getItem(VIEW_KEY) || null;
  } catch {
    return null;
  }
}
function saveView(v) {
  try {
    globalThis.localStorage?.setItem(VIEW_KEY, v);
  } catch {
    /* a blocked storage keeps the default */
  }
}

/**
 * The cut's view.
 * @param {Object} opts
 * @param {string} opts.me - my username
 * @param {boolean} [opts.spectator]
 * @param {Object} opts.socket - emits cutForABuckDraw / leaveTournament / getPlayerProfile
 * @param {Array} [opts.players] - tournament players ({username, pic, connected})
 * @param {Function} [opts.onViewProfile] - (username) => void
 * @param {Object} [opts.sound] - the SoundManager (tests)
 * @param {Function} [opts.now] - clock (tests)
 * @returns {{element, update, setPlayers, setTalking, destroy, relayout}}
 */
export function createCutView({ me, spectator = false, socket = null, players = [], onViewProfile = null, sound = getSoundManager(), now = () => Date.now() } = {}) {
  const view = {};
  let state = null;
  let layout = null;
  let order = [];
  let mode = null; // 'ring' | 'list'
  let peek = -1;
  let myDrawSent = null; // the round I drew in (no second emit)
  let backSent = null; // the round I tapped in after the server drew for me (canSayBack)
  let turnCued = null;
  let verdictRound = null; // the reveal whose verdict is showing
  let pendingVerdict = null;
  let introUntil = 0;
  let winnerShown = null;
  let destroyed = false;
  const timers = new Set();
  const people = new Map(); // username -> {pic, connected}
  const talking = new Set();
  const seats = new Map(); // username -> {root, avatar, img, name, caption, cards, cardEls: [], more}

  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!destroyed) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const play = (name, opts) => {
    try {
      sound?.play?.(name, opts);
    } catch {
      /* sounds never break the screen */
    }
  };
  const reduced = () => prefersReducedMotion();

  // ---- DOM
  const root = el('section', { className: 'cut', attrs: { 'aria-label': 'Cut for a buck', id: 'cutForABuck' } });
  const title = el('h2', { className: 'cut-bar__title', text: 'Cut for a buck' });
  const roundEl = el('span', { className: 'cut-bar__round', attrs: { id: 'cutRoundLine' } });
  const viewGroup = el('div', { className: 'scope-control cut-view-toggle', attrs: { role: 'radiogroup', 'aria-label': 'Show the players as' } });
  const viewBtns = {};
  for (const [key, label] of [['ring', 'Ring'], ['list', 'List']]) {
    const b = el('button', { className: 'scope-control__option', attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' }, dataset: { view: key }, text: label });
    b.addEventListener('click', () => setMode(key, { save: true }));
    viewBtns[key] = b;
    viewGroup.appendChild(b);
  }
  viewGroup.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    setMode(mode === 'ring' ? 'list' : 'ring', { save: true });
    viewBtns[mode].focus();
  });
  let soundBtn = null;
  try {
    soundBtn = createSoundToggle({ className: 'cut-bar__sound', sound });
  } catch {
    soundBtn = null;
  }
  const bar = el('div', { className: 'cut-bar', children: [title, roundEl, el('span', { className: 'cut-bar__spacer' }), viewGroup, ...(soundBtn ? [soundBtn] : [])] });
  const statusMain = el('p', { className: 'cut-status__main', attrs: { id: 'cutStatus' } });
  const statusSub = el('p', { className: 'cut-status__sub', attrs: { id: 'cutStatusSub' } });
  const status = el('div', { className: 'cut-status', children: [statusMain, statusSub] });

  const ring = el('div', { className: 'cut-ring', attrs: { role: 'list', 'aria-label': 'Players' } });
  const deckCanvas = el('canvas', { className: 'cut-deck__fan', attrs: { 'aria-hidden': 'true' } });
  const deckCaption = el('span', { className: 'cut-deck__caption', attrs: { id: 'cutDeckCaption' } });
  const shuffle = el('div', { className: 'cut-shuffle', attrs: { 'aria-hidden': 'true' }, children: [0, 1, 2, 3].map((i) => el('span', { className: `cut-shuffle__card cut-shuffle__card--${i}` })) });
  const deck = spectator
    ? el('div', { className: 'cut-deck is-watch', attrs: { id: 'cutDeck', 'aria-hidden': 'true' }, children: [deckCanvas, shuffle] })
    : el('button', { className: 'cut-deck', attrs: { id: 'cutDeck', type: 'button', 'aria-label': 'Draw a card', 'aria-describedby': 'cutDeckCaption' }, children: [deckCanvas, shuffle] });
  const overlay = el('div', { className: 'cut-overlay', attrs: { 'aria-hidden': 'true' } });
  const stage = el('div', { className: 'cut-stage', attrs: { id: 'cutStage' }, children: [ring, deck, deckCaption, overlay] });
  const listRows = el('div', { className: 'cut-list__rows', attrs: { role: 'list', 'aria-label': 'Players' } });
  // the list has no deck: its own Draw a card (a random card, slot null)
  const listDraw = createButton({ label: 'Draw a card', variant: 'primary', onClick: () => drawSlot(null, -1) });
  listDraw.id = 'cutListDraw';
  const list = el('div', { className: 'cut-list', attrs: { id: 'cutList' }, children: spectator ? [listRows] : [listDraw, listRows] });
  const live = el('div', { className: 'visually-hidden', attrs: { 'aria-live': 'polite', id: 'cutLive' } });
  const liveLoud = el('div', { className: 'visually-hidden', attrs: { 'aria-live': 'assertive', id: 'cutLiveWinner' } });
  const popover = el('div', { className: 'cut-popover kit-panel kit-elev-3', attrs: { role: 'dialog', 'aria-modal': 'false', hidden: '' } });
  stage.appendChild(popover);
  const leaveBtn = createButton({ label: 'Leave', variant: 'secondary', onClick: () => socket?.emit('leaveTournament') });
  leaveBtn.id = 'cutLeaveBtn';
  const actions = el('div', { className: 'screen-actions cut-actions', children: [leaveBtn] });
  if (spectator) leaveBtn.textContent = 'Stop watching';
  root.append(bar, status, stage, list, actions, live, liveLoud);
  if (spectator) root.classList.add('is-spectator');

  // ---- view mode
  function setMode(next, { save = false } = {}) {
    mode = next === 'list' ? 'list' : 'ring';
    for (const [k, b] of Object.entries(viewBtns)) {
      b.setAttribute('aria-checked', String(k === mode));
      b.tabIndex = k === mode ? 0 : -1;
    }
    root.dataset.view = mode;
    stage.hidden = mode !== 'ring';
    list.hidden = mode !== 'list';
    if (save) saveView(mode);
    renderAll();
  }

  // ---- deck input
  function canDraw() {
    return !spectator && !!state && state.stage === STAGE.DRAWING && isAlive(state, me) && !state.drawn[me] && myDrawSent !== state.round && now() >= introUntil;
  }
  /**
   * The server drew for me this round (away: 2 timeouts in a row, so it
   * draws for me at each open before I can). A tap still sends a draw,
   * once a round: the server drops it as a repeat but stops drawing for me
   * at the open, so the next round waits for me again.
   */
  function canSayBack() {
    return !spectator && !!state && state.stage === STAGE.DRAWING && isAlive(state, me) && !!state.drawn[me]?.auto && backSent !== state.round;
  }
  function sayBack() {
    if (!canSayBack()) return;
    backSent = state.round;
    socket?.emit('cutForABuckDraw', { round: state.round, slot: null });
    listDraw.disabled = true;
  }
  function fanPoint(e) {
    const r = deck.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function setPeek(i) {
    if (i === peek) return;
    peek = i;
    paintDeck();
  }
  if (!spectator) {
    deck.addEventListener('pointermove', (e) => {
      if (!canDraw() || !layout) return;
      const free = freeSlots(state);
      const { x, y } = fanPoint(e);
      setPeek(fanIndexAt(x, y, fanGeometry(layout.deck.w, fanH(), free.length, state.deckSize), free.length));
    });
    deck.addEventListener('pointerleave', () => setPeek(-1));
    deck.addEventListener('click', (e) => {
      if (!canDraw()) return sayBack();
      const free = freeSlots(state);
      let i = peek;
      if (e.detail > 0 && layout && e.clientX !== undefined && (e.clientX || e.clientY)) {
        const { x, y } = fanPoint(e);
        i = fanIndexAt(x, y, fanGeometry(layout.deck.w, fanH(), free.length, state.deckSize), free.length);
      }
      drawSlot(i >= 0 ? free[i] : null, i);
    });
    deck.addEventListener('keydown', (e) => {
      if (!canDraw()) return;
      const free = freeSlots(state);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.key === 'ArrowRight' ? 1 : -1;
        setPeek(peek < 0 ? Math.floor(free.length / 2) : Math.max(0, Math.min(free.length - 1, peek + step)));
      }
    });
  }

  /** Send my draw (slot null: a random one) and fly a back to my spot at once. */
  function drawSlot(slot, freeIndex) {
    if (!canDraw()) return sayBack();
    myDrawSent = state.round;
    socket?.emit('cutForABuckDraw', { round: state.round, slot: Number.isInteger(slot) ? slot : null });
    play('draw');
    const from = fanOrigin(freeIndex);
    peek = -1;
    // shown as drawn at once; the server's cutForABuckDrew confirms it
    state = { ...state, drawn: { ...state.drawn, [me]: { slot: Number.isInteger(slot) ? slot : -1, auto: false, local: true } } };
    renderAll({ flyFrom: { [me]: from } });
  }

  /** Where in the stage a free card of the fan sits (its centre), for a flight. */
  function fanOrigin(freeIndex) {
    if (!layout) return null;
    const free = freeSlots(state);
    const geo = fanGeometry(layout.deck.w, fanH(), free.length, state?.deckSize || 54);
    const i = freeIndex >= 0 ? freeIndex : Math.floor(free.length / 2);
    const a = fanAngle(i, free.length, geo.half);
    const lift = geo.ch * (0.5 + geo.lift);
    return { x: layout.deck.x + geo.px + Math.sin(a) * lift, y: layout.deck.y + geo.py - Math.cos(a) * lift, rot: (a * 180) / Math.PI };
  }

  // ---- layout
  function stageSize() {
    const w = stage.clientWidth || FALLBACK.w;
    const h = stage.clientHeight || FALLBACK.h;
    return { w, h };
  }
  function relayout() {
    const names = ringPlayers(state);
    order = ringOrder(names, spectator ? null : me);
    const { w, h } = stageSize();
    layout = ringLayout({ w, h, n: Math.max(order.length, 1), nameH: NAME_BOX_H });
    root.classList.toggle('is-dense', !!layout.dense);
    renderAll({ instant: true });
  }
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      if (!destroyed) relayout();
    });
    ro.observe(stage);
  }

  // ---- seats
  function seatFor(username) {
    let s = seats.get(username);
    if (s) return s;
    const img = el('img', { className: 'cut-seat__img', attrs: { alt: '', draggable: 'false' } });
    const avatar = el('button', { className: 'cut-seat__avatar', attrs: { type: 'button', 'aria-label': `${username === me ? 'You' : username}: cards this deck` }, children: [img] });
    const name = el('span', { className: 'cut-seat__name', text: username === me ? 'you' : username, attrs: { title: username } });
    const caption = el('span', { className: 'cut-seat__caption' });
    const cards = el('div', { className: 'cut-seat__cards', attrs: { 'aria-hidden': 'true' } });
    const more = el('span', { className: 'cut-seat__more', attrs: { hidden: '' } });
    cards.appendChild(more);
    const r = el('div', { className: 'cut-seat', attrs: { role: 'listitem' }, dataset: { username }, children: [avatar, name, caption] });
    avatar.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopover(username, avatar);
    });
    s = { root: r, avatar, img, name, caption, cards, more, cardEls: [] };
    seats.set(username, s);
    return s;
  }

  function placeSeat(s, k, instant) {
    const seat = layout.seats[k];
    if (!seat) return;
    const d = layout.avatarD;
    s.root.style.left = `${seat.avatar.x + d / 2 - layout.nameW / 2}px`;
    s.root.style.top = `${seat.avatar.y}px`;
    s.root.style.width = `${layout.nameW}px`;
    s.root.style.setProperty('--d', `${d}px`);
    s.root.style.setProperty('--name-h', `${layout.nameH}px`);
    // the intro slides each avatar in from the centre
    s.root.style.setProperty('--from-x', `${layout.cx - seat.x}px`);
    s.root.style.setProperty('--from-y', `${layout.cy - seat.y}px`);
    s.root.style.setProperty('--i', String(k));
    s.cards.style.left = `${seat.stack.x}px`;
    s.cards.style.top = `${seat.stack.y}px`;
    s.cards.style.width = `${seat.stack.w}px`;
    s.cards.style.height = `${seat.stack.h}px`;
    if (instant) s.root.classList.add('no-anim');
  }

  /** Make a card element (front face + back), face down. */
  function makeCard() {
    const back = el('canvas', { className: 'cut-card__back' });
    const face = el('canvas', { className: 'cut-card__face' });
    const inner = el('div', { className: 'cut-card__inner', children: [back, face] });
    const c = el('div', { className: 'cut-card', children: [inner] });
    c._back = back;
    c._face = face;
    c._card = null;
    c._painted = '';
    return c;
  }

  function sizeCard(c, w, h) {
    const key = `${w.toFixed(1)}x${h.toFixed(1)}`;
    if (c._painted === key + (c._card ? `${c._card.rank}${c._card.suit}` : '')) return;
    paintCard(c._back, BACK_FRAMES.red, w, h);
    if (c._card) paintCard(c._face, c._card, w, h);
    c._painted = key + (c._card ? `${c._card.rank}${c._card.suit}` : '');
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }

  /** FLIP: start `node` at the stage point `from` (its centre) and let it move home. */
  function flyIn(node, from, home, { rot = 0 } = {}) {
    if (!from || reduced()) {
      node.classList.add('is-fading-in');
      return;
    }
    const dx = from.x - (home.x + home.w / 2);
    const dy = from.y - (home.y + home.h / 2);
    node.style.transition = 'none';
    node.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    void node.offsetWidth;
    node.style.transition = `transform ${TIMING.flight}ms var(--ease-emphasized) ${TIMING.lift}ms`;
    node.style.transform = '';
  }

  /** The cards of one seat from the state: the table's, then this round's back. */
  function renderCards(username, k, { flyFrom = null, flipRound = null, instant = false } = {}) {
    const s = seatFor(username);
    const seat = layout.seats[k];
    if (!seat) return;
    const cw = layout.cardW;
    const ch = layout.cardH;
    const table = state?.table?.[username] || [];
    const drawn = state?.stage === STAGE.DRAWING ? state.drawn?.[username] : null;
    const want = [...table.map((card) => ({ card })), ...(drawn ? [{ back: true }] : [])];
    const els = s.cardEls;
    // a reshuffle: the table's cards go back to the deck
    if (want.length < els.length) {
      const gone = els.splice(want.length);
      for (const c of gone) {
        if (instant || reduced()) {
          c.remove();
          continue;
        }
        const r = { x: parseFloat(s.cards.style.left) || 0, y: parseFloat(s.cards.style.top) || 0 };
        const dx = layout.deck.x + layout.deck.w / 2 - (r.x + (parseFloat(c.style.left) || 0) + cw / 2);
        const dy = layout.deck.y + layout.deck.h / 2 - (r.y + ch / 2);
        c.classList.remove('is-face');
        c.style.transition = `transform ${TIMING.flight + 150}ms var(--ease-standard), opacity ${TIMING.flight + 150}ms`;
        c.style.transform = `translate(${dx}px, ${dy}px) scale(0.6)`;
        c.style.opacity = '0';
        later(TIMING.flight + 200, () => c.remove());
      }
    }
    while (els.length < want.length) {
      const c = makeCard();
      els.push(c);
      s.cards.insertBefore(c, s.more);
      c._new = true;
    }
    const shown = Math.min(want.length, STACK_SHOWN + 1);
    const hiddenOlder = want.length - shown;
    const step = layout.dense ? DENSE_EDGE : STACK_OFFSET * cw;
    const lowRank = state?.lastReveal && state.out?.[username] && !state.out[username].left ? lowestRank(state.lastReveal.draws.map((d) => d.card)) : null;
    want.forEach((w, i) => {
      const c = els[i];
      const visibleIndex = i - hiddenOlder; // 0..shown-1; the newest is shown-1
      c.hidden = visibleIndex < 0;
      if (c.hidden) return;
      const left = (layout.seats[k].stack.w - cw) - (shown - 1 - visibleIndex) * step;
      c.style.left = `${left}px`;
      c.style.zIndex = String(visibleIndex + 1);
      const wasBack = !c._card;
      if (w.card) c._card = w.card;
      sizeCard(c, cw, ch);
      // the newest face of the last reveal flips with the others, staggered
      const flipNow = w.card && wasBack && c._isBackShown && flipRound != null;
      if (w.card) {
        if (flipNow && !instant && !reduced()) {
          const pos = state.lastReveal.draws.findIndex((d) => d.username === username);
          c.style.setProperty('--flip-delay', `${TIMING.flipDelay + Math.max(0, pos) * TIMING.flipStagger}ms`);
          c.classList.add('is-flipping');
          // the next frame, so the transition runs from the back
          requestFrame(() => c.classList.add('is-face'));
        } else {
          c.classList.add('is-face');
          if (instant || !c._new) c.classList.add('no-anim');
        }
      } else {
        c._isBackShown = true;
        c.classList.remove('is-face');
      }
      const newest = visibleIndex === shown - 1;
      c.classList.toggle('is-losing', !!(newest && lowRank != null && w.card && RANK_VALUES[w.card.rank] === lowRank && verdictRound === state.lastReveal?.round));
      if (c._new) {
        c._new = false;
        const from = flyFrom?.[username] || (w.back && !instant ? deckCentre() : null);
        if (w.back && !instant) flyIn(c, from, { x: seat.stack.x + left, y: seat.stack.y, w: cw, h: ch }, { rot: from?.rot || 0 });
        else c.classList.add('no-anim');
      }
    });
    s.more.hidden = hiddenOlder <= 0;
    s.more.textContent = hiddenOlder > 0 ? `+${hiddenOlder}` : '';
  }

  /** The fan's height: the deck's box less its caption line. */
  function fanH() {
    return Math.max(20, (layout?.deck.h || 0) - DECK_CAPTION_H);
  }

  function deckCentre() {
    return layout ? { x: layout.deck.x + layout.deck.w / 2, y: layout.deck.y + layout.deck.h / 2, rot: 0 } : null;
  }

  // ---- popover
  function openPopover(username, anchor) {
    popover.replaceChildren();
    const cards = state?.table?.[username] || [];
    popover.append(
      el('h3', { className: 'cut-popover__name', text: username === me ? 'You' : username }),
      el('p', { className: 'cut-popover__cards', text: cards.length ? `Cards this deck: ${cards.map(cardShort).join(', ')}` : 'No cards yet this deck' }),
    );
    if (onViewProfile) {
      const b = createButton({ label: 'View Profile', variant: 'secondary', size: 'sm', onClick: () => { closePopover(); onViewProfile(username); } });
      popover.appendChild(b);
    }
    popover.hidden = false;
    const r = anchor.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const x = Math.max(4, Math.min((r.left - sr.left) + r.width / 2 - 90, (stage.clientWidth || FALLBACK.w) - 184));
    const y = Math.max(4, (r.top - sr.top) - 8);
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
    popover.style.transform = 'translateY(-100%)';
    popover.dataset.username = username;
  }
  function closePopover() {
    popover.hidden = true;
    delete popover.dataset.username;
  }
  const onDocClick = (e) => {
    if (!popover.hidden && !popover.contains(e.target)) closePopover();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !popover.hidden) closePopover();
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKey);

  // ---- rendering
  function requestFrame(fn) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => !destroyed && fn());
    else later(16, fn);
  }

  function paintDeck() {
    if (!layout) return;
    const free = freeSlots(state);
    const count = state ? (state.stage === STAGE.DRAWING ? free.length : deckLeft(state)) : 0;
    deck.style.left = `${layout.deck.x}px`;
    deck.style.top = `${layout.deck.y}px`;
    deck.style.width = `${layout.deck.w}px`;
    deck.style.height = `${layout.deck.h}px`;
    deckCaption.style.left = `${layout.deck.x}px`;
    deckCaption.style.width = `${layout.deck.w}px`;
    deckCaption.style.top = `${layout.deck.y + layout.deck.h - DECK_CAPTION_H}px`;
    paintFan(deckCanvas, layout.deck.w, fanH(), count, state?.deckSize || 54, canDraw() ? peek : -1);
    deckCaption.textContent = state ? deckLine(state) : '';
    if (!spectator) {
      const can = canDraw();
      deck.setAttribute('aria-disabled', String(!can));
      deck.classList.toggle('is-ready', can);
    }
  }

  function renderStatus() {
    if (!state) return;
    let { main, sub } = statusLines(state, { me, spectator, now: now() });
    // the cards are turning over: the verdict waits for them
    if ((state.stage === STAGE.REVEAL || state.stage === STAGE.WINNER) && state.lastReveal && verdictRound !== state.lastReveal.round) {
      main = 'Turning the cards over';
      sub = RULES_LINE;
    }
    if (state.stage === STAGE.WINNER && state.winner && winnerShown !== state.winner) {
      main = verdictLines(state.lastReveal, me)[0] || main;
    }
    if (statusMain.textContent !== main) statusMain.textContent = main;
    if (statusSub.textContent !== sub) statusSub.textContent = sub;
    roundEl.textContent = roundLine(state);
  }

  /** A player's look now: an out player looks in until the verdict (the cards are still turning). */
  function lookOf(username, v) {
    const out = state?.out?.[username];
    if (v.state === 'out' && out && !out.left && out.round === state.lastReveal?.round && verdictRound !== state.lastReveal.round) return 'idle';
    return v.state;
  }

  function renderList() {
    listRows.replaceChildren();
    listDraw.disabled = !canDraw() && !canSayBack();
    listDraw.hidden = !state || state.stage !== STAGE.DRAWING || !isAlive(state, me);
    for (const username of order) {
      const p = people.get(username) || {};
      const v = seatView(state, username, { me, connected: p.connected !== false, talking: talking.has(username) });
      const look = lookOf(username, v);
      const caption = look === v.state ? v.caption : '';
      const label = look === v.state ? v.label : v.label.replace(/, out in round \d+/, '');
      const img = el('img', { className: 'cut-list__img', attrs: { alt: '' } });
      applyAvatarImg(img, avatarSrc(p.pic));
      img.setAttribute('src', avatarSrc(p.pic));
      const drawnNow = state?.stage === STAGE.DRAWING && state.drawn?.[username];
      const row = el('div', {
        className: `cut-list__row is-${look}${v.disconnected ? ' is-disconnected' : ''}${talking.has(username) ? ' is-talking' : ''}`,
        attrs: { role: 'listitem', 'aria-label': label },
        dataset: { username },
        children: [
          img,
          el('span', { className: 'cut-list__name', text: username === me ? 'you' : username }),
          el('span', { className: 'cut-list__status', text: caption || (v.state === 'waiting' ? 'To draw' : drawnNow ? 'Drew' : '') }),
          el('span', { className: 'cut-list__cards', text: v.cards.map(cardShort).join(' ') }),
        ],
      });
      listRows.appendChild(row);
    }
  }

  function renderSeats(opts = {}) {
    if (!layout) return;
    const keep = new Set(order);
    for (const [u, s] of seats) {
      if (!keep.has(u)) {
        s.root.remove();
        s.cards.remove();
        seats.delete(u);
      }
    }
    order.forEach((username, k) => {
      const s = seatFor(username);
      if (!s.root.isConnected) ring.appendChild(s.root);
      if (!s.cards.isConnected) stage.insertBefore(s.cards, deck);
      // reading order: the ring order (me first)
      if (ring.children[k] !== s.root) ring.insertBefore(s.root, ring.children[k] || null);
      placeSeat(s, k, opts.instant);
      const p = people.get(username) || {};
      const src = avatarSrc(p.pic);
      if (s.img.getAttribute('src') !== src) {
        applyAvatarImg(s.img, src);
        s.img.setAttribute('src', src);
      }
      const v = seatView(state, username, { me, connected: p.connected !== false, talking: talking.has(username) });
      const look = lookOf(username, v);
      s.root.className = `cut-seat is-${look}${v.disconnected ? ' is-disconnected' : ''}${talking.has(username) ? ' is-talking' : ''}${username === me ? ' is-me' : ''}${s.root.classList.contains('is-entering') ? ' is-entering' : ''}${opts.instant ? ' no-anim' : ''}`;
      s.root.setAttribute('aria-label', look === v.state ? v.label : v.label.replace(/, out in round \d+/, ''));
      s.caption.textContent = look === v.state ? v.caption : '';
      s.cards.classList.toggle('is-out', look === 'out' || look === 'left');
      renderCards(username, k, opts);
    });
  }

  function renderWinner() {
    if (!state || state.stage !== STAGE.WINNER || !state.winner || !layout) {
      overlay.querySelector('.cut-winner')?.remove();
      return;
    }
    if (verdictRound !== state.lastReveal?.round && state.lastReveal) return;
    if (winnerShown === state.winner && overlay.querySelector('.cut-winner')) return;
    const firstTime = winnerShown !== state.winner;
    winnerShown = state.winner;
    const k = order.indexOf(state.winner);
    const seat = layout.seats[k];
    const p = people.get(state.winner) || {};
    const img = el('img', { className: 'cut-winner__img', attrs: { alt: '' } });
    applyAvatarImg(img, avatarSrc(p.pic));
    img.setAttribute('src', avatarSrc(p.pic));
    const size = Math.min(layout.avatarD * 2, Math.max(64, Math.min(layout.deck.h * 1.1, 128)));
    const face = el('div', { className: 'cut-winner__avatar', children: [img, el('span', { className: 'cut-winner__buck', attrs: { 'aria-hidden': 'true' } })] });
    face.querySelector('.cut-winner__buck').innerHTML = BUCK_SVG;
    face.style.width = `${size}px`;
    face.style.height = `${size}px`;
    const box = el('div', {
      className: 'cut-winner',
      attrs: { id: 'cutWinner' },
      children: [face, el('p', { className: 'cut-winner__line', text: winnerLine(state.winner, me) })],
    });
    box.style.left = `${layout.cx}px`;
    box.style.top = `${layout.cy}px`;
    overlay.querySelector('.cut-winner')?.remove();
    overlay.appendChild(box);
    root.classList.add('has-winner');
    // the glide from the winner's seat
    if (firstTime && seat && !reduced()) {
      face.style.transition = 'none';
      face.style.transform = `translate(${seat.x - layout.cx}px, ${seat.y - layout.cy}px) scale(${layout.avatarD / size})`;
      void face.offsetWidth;
      face.style.transition = `transform ${TIMING.winnerGlide}ms var(--ease-emphasized)`;
      face.style.transform = '';
    }
    if (firstTime && state.last?.type !== 'restore') {
      play(state.winner === me ? 'gameend-win' : 'gameend');
      liveLoud.textContent = winnerLine(state.winner, me);
    }
  }

  function renderAll(opts = {}) {
    if (destroyed || !state) return;
    if (!layout) {
      const names = ringPlayers(state);
      order = ringOrder(names, spectator ? null : me);
      const { w, h } = stageSize();
      layout = ringLayout({ w, h, n: Math.max(order.length, 1), nameH: NAME_BOX_H });
      root.classList.toggle('is-dense', !!layout.dense);
    }
    root.dataset.stage = state.stage;
    renderStatus();
    if (mode === 'list') renderList();
    renderSeats(opts);
    paintDeck();
    renderWinner();
  }

  // ---- the state's changes
  function scheduleVerdict(reveal) {
    if (pendingVerdict) clearTimeout(pendingVerdict);
    const wait = state.last?.type === 'restore' ? 0 : (reduced() ? TIMING.reducedVerdict : TIMING.verdict);
    const show = () => {
      pendingVerdict = null;
      verdictRound = reveal.round;
      if (state.last?.type !== 'restore') {
        const mineOut = reveal.eliminated.includes(me);
        if (mineOut) play('gameend-lose');
        else if (reveal.eliminated.length) play('set');
        live.textContent = revealAnnouncement(reveal, me);
      }
      renderAll();
    };
    if (wait <= 0) show();
    else pendingVerdict = later(wait, show);
  }

  function playIntro() {
    if (reduced()) {
      root.classList.add('is-intro', 'is-intro-reduced');
    } else {
      root.classList.add('is-intro');
      for (const s of seats.values()) s.root.classList.add('is-entering');
    }
    const t = el('div', { className: 'cut-intro', children: [el('p', { className: 'cut-intro__title', text: 'Cut for a buck!' })] });
    overlay.querySelector('.cut-intro')?.remove();
    overlay.appendChild(t);
    introUntil = now() + TIMING.intro;
    later(TIMING.intro, () => {
      root.classList.remove('is-intro', 'is-intro-reduced');
      for (const s of seats.values()) s.root.classList.remove('is-entering');
      t.remove();
      renderAll();
    });
  }

  /**
   * The new state.
   * @param {Object} next
   * @param {Object} [o]
   * @param {boolean} [o.intro] - play the intro (the cut just started here)
   */
  view.update = (next, { intro = false } = {}) => {
    if (destroyed) return;
    state = next;
    if (!state) return;
    // my draw is on its way: shown as drawn until the server's
    // cutForABuckDrew for it comes (another player's may come first)
    if (state.stage === STAGE.DRAWING && myDrawSent === state.round && !state.drawn[me] && state.alive.includes(me)) {
      state = { ...state, drawn: { ...state.drawn, [me]: { slot: -1, auto: false, local: true } } };
    }
    const change = state.last?.type;
    // a new participant set (the gather became the cut): the ring again
    const names = ringPlayers(state);
    const nextOrder = ringOrder(names, spectator ? null : me);
    if (nextOrder.join('\u0000') !== order.join('\u0000')) {
      order = nextOrder;
      const { w, h } = stageSize();
      layout = ringLayout({ w, h, n: Math.max(order.length, 1), nameH: NAME_BOX_H });
      root.classList.toggle('is-dense', !!layout.dense);
      if (!mode) setMode(readView() || (order.length >= 13 && (stage.clientWidth || FALLBACK.w) < 600 ? 'list' : 'ring'));
    }
    if (!mode) setMode(readView() || 'ring');
    if (change === 'round') {
      myDrawSent = myDrawSent === state.round ? myDrawSent : null;
      turnCued = null;
      peek = -1;
    }
    // my own draw already flew: the server's confirmation draws nothing new
    const flyFrom = {};
    if (change === 'drew' && state.last.username !== me) flyFrom[state.last.username] = deckCentre();
    if (change === 'drew' && state.last.username !== me) play('draw', { gain: 0.6 });
    if (change === 'reveal') {
      play('card');
      scheduleVerdict(state.lastReveal);
    }
    if (change === 'restore') {
      verdictRound = state.lastReveal?.round ?? null;
      winnerShown = null;
    }
    if (change === 'round' && state.reshuffled) live.textContent = 'Not enough cards left. Shuffling them back in.';
    renderAll({ flyFrom, flipRound: change === 'reveal' ? state.lastReveal.round : null, instant: change === 'restore' });
    if (intro) playIntro();
  };

  view.setPlayers = (list) => {
    people.clear();
    for (const p of Array.isArray(list) ? list : []) {
      if (p && typeof p.username === 'string') people.set(p.username, { pic: p.pic ?? null, connected: p.connected !== false });
    }
    renderAll();
  };

  /** A voice peer started or stopped talking (by username). */
  view.setTalking = (username, on) => {
    if (!username) return;
    if (on) talking.add(username); else talking.delete(username);
    const s = seats.get(username);
    if (s) {
      s.root.classList.toggle('is-talking', !!on);
      const p = people.get(username) || {};
      s.root.setAttribute('aria-label', seatView(state, username, { me, connected: p.connected !== false, talking: !!on }).label);
    }
  };

  view.relayout = relayout;

  view.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    clearInterval(tick);
    ro?.disconnect();
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
    root.remove();
    if (current === view) current = null;
  };

  /** Test hook: send a draw of that free card (as a click on it). */
  view.drawFree = (freeIndex) => {
    const free = freeSlots(state);
    drawSlot(freeIndex >= 0 ? free[freeIndex] : null, freeIndex);
  };
  view.getState = () => state;
  view.getLayout = () => layout;

  // the countdowns, once a second is enough (4 x a second: no visible lag)
  const tick = setInterval(() => {
    if (destroyed || !state) return;
    renderStatus();
    if (state.stage === STAGE.DRAWING && canDraw() && state.endsAt != null && turnCued !== state.round && state.endsAt - now() <= 5000) {
      turnCued = state.round;
      play('turn');
    }
    if (state.stage === STAGE.DRAWING) paintDeckState();
    if (mode === 'list' && !spectator && listDraw.disabled === (canDraw() || canSayBack())) listDraw.disabled = !canDraw() && !canSayBack();
  }, 250);
  function paintDeckState() {
    if (spectator) return;
    const can = canDraw();
    if (deck.classList.contains('is-ready') !== can) paintDeck();
  }

  for (const p of players) if (p?.username) people.set(p.username, { pic: p.pic ?? null, connected: p.connected !== false });
  view.element = root;
  current = view;
  return view;
}
