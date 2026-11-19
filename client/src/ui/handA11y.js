/**
 * My hand for the keyboard and screen readers (review later #7: the canvas
 * cards are pointer-only). Two HUD nodes:
 *
 *   .hud-hand        role toolbar "Your hand": one button per card in hand
 *                    order, each over its card's visible strip (touch
 *                    exploration finds it where the card is; never a pointer
 *                    target: the canvas keeps the clicks and the hover), a
 *                    ring when focused from the keyboard. One tab stop
 *                    (roving tabindex); Left / Right / Up / Down / Home /
 *                    End move, Enter / Space click. A card the canvas dims
 *                    is aria-disabled (CardManager's isLegal: the pointer's
 *                    own client legality); a click on a playable one is the
 *                    pointer's click (CardManager's handler, MyAction).
 *                    The /help suggested card (CardManager's) carries
 *                    .is-suggested (a gold ring round its strip) and says
 *                    "(suggested)" after its name.
 *   .hud-announcer   role log, polite, visually hidden: the turn, the trump,
 *                    each card played and each trick's winner.
 *
 * Focus is never taken from where the user is (chat, any input, a modal,
 * the voice overlay, another control): only from nowhere (the page's body
 * after a key press) or from the table's own controls (this hand, the
 * announcer, the bid sheet, the draw layer). A focused card that goes
 * hands focus to its neighbour, the last one to the announcer (never to the
 * body; it waits there through the next deal, for my turn); a render that
 * clears and redraws the same hand puts it back on the card.
 *
 * Geometry is the table layout's (CardManager passes the rects), as CSS
 * variables; keys other than the ones above are left alone (the voice keys:
 * backquote, M).
 */
import { hudRoot } from './tableHud.js';

/** How many announcements the log keeps (older ones have been read). */
export const ANNOUNCE_KEEP = 6;

/** Where focus may be taken from on my turn (the table's own controls). */
const HANDOFF = '.hud-hand, .hud-announcer, #bidContainer, .hud-draw, .hud-teams, .hud-assist, .hud-assist-ask';

let handlers = {};
let restoreKey = null;
let lastInput = null;
let lastSaid = { text: '', at: 0 };
let modality = false;

/**
 * Keys that move focus or press a control: only these make the last input
 * the keyboard (a mouse player's voice keys, backquote and M, or a stray
 * letter must not pull focus into the hand on their turn).
 */
const NAV_KEYS = new Set(['Tab', 'Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Whether the last input was a key (focus moves only for the keyboard). */
function trackModality() {
  if (modality || typeof document === 'undefined') return;
  modality = true;
  document.addEventListener('keydown', (e) => { if (NAV_KEYS.has(e.key)) lastInput = 'keyboard'; }, true);
  document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
}

const px = (v) => `${Math.round(v * 100) / 100}px`;

/** The hand toolbar (created on demand), or null. */
export function handBar({ create = true } = {}) {
  const root = document.getElementById('table-hud') || document.body;
  let bar = root.querySelector(':scope > .hud-hand');
  if (bar || !create) return bar;
  bar = document.createElement('div');
  bar.className = 'hud-hand';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Your hand');
  bar.addEventListener('keydown', onBarKey);
  hudRoot().appendChild(bar);
  return bar;
}

/** The announcer (created on demand), or null. */
export function announcer({ create = true } = {}) {
  const root = document.getElementById('table-hud') || document.body;
  let log = root.querySelector(':scope > .hud-announcer');
  if (log || !create) return log;
  log = document.createElement('div');
  log.className = 'hud-announcer';
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', 'Table');
  log.tabIndex = -1;
  hudRoot().appendChild(log);
  return log;
}

/**
 * Say `text` (each a new line of the log, so lines in quick succession are
 * all read). The same words again within a second are dropped (a held key).
 */
export function announce(text) {
  if (!text || typeof document === 'undefined') return;
  const now = Date.now();
  if (lastSaid.text === text && now - lastSaid.at < 1000) return;
  lastSaid = { text, at: now };
  const log = announcer();
  const line = document.createElement('p');
  line.textContent = text;
  log.appendChild(line);
  while (log.childElementCount > ANNOUNCE_KEEP) log.firstElementChild.remove();
}

const buttons = (bar) => Array.from(bar.querySelectorAll(':scope > .hud-hand__card'));
const isPlayable = (btn) => btn.getAttribute('aria-disabled') !== 'true';

/** The card key focused in the hand, or null. */
export function focusedHandKey() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  return a?.classList?.contains('hud-hand__card') ? a.dataset.key : null;
}

function focusButton(btn) {
  const bar = btn.parentElement;
  for (const b of buttons(bar)) b.tabIndex = b === btn ? 0 : -1;
  btn.focus({ preventScroll: true });
}

function onBarKey(e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const list = buttons(e.currentTarget);
  const i = list.indexOf(document.activeElement);
  if (i === -1 || !list.length) return;
  const to = { ArrowLeft: i - 1, ArrowUp: i - 1, ArrowRight: i + 1, ArrowDown: i + 1, Home: 0, End: list.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  focusButton(list[Math.max(0, Math.min(list.length - 1, to))]);
}

function makeButton(key) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hud-hand__card';
  btn.dataset.key = key;
  btn.tabIndex = -1;
  btn.addEventListener('click', () => {
    if (isPlayable(btn)) handlers.onActivate?.(key);
    // a dimmed card: the pointer's refusal (the table's toast, spoken once
    // by the toast announcer), else said here
    else if (!handlers.onRefuse?.(key)) announce(handlers.reasonFor?.(key) || 'You can\'t play that card now.');
  });
  btn.addEventListener('focus', () => {
    for (const b of buttons(btn.parentElement)) b.tabIndex = b === btn ? 0 : -1;
    handlers.onFocusCard?.(key);
  });
  btn.addEventListener('blur', () => handlers.onBlurCard?.(key));
  return btn;
}

/**
 * Mirror the hand (CardManager calls it whenever the hand or its legality
 * changes). Buttons are kept by card, so focus survives a re-render.
 * @param {Object} o
 * @param {Array<{key: string, label: string, legal: boolean, suggested?: boolean, rect: {x, y, w, h}}>} o.cards - hand order; rect in CSS px (the visible strip); suggested: the /help card
 * @param {number} [o.cardW] - a whole card's width (the focus ring)
 * @param {number} [o.cardH]
 * @param {number} [o.lift] - how far a playable card rises when focused
 * @param {Function} [o.onActivate] - (key) a playable card was clicked
 * @param {Function} [o.onFocusCard] - (key)
 * @param {Function} [o.onBlurCard] - (key)
 * @param {Function} [o.reasonFor] - (key) why a dimmed card can't be played
 * @param {Function} [o.onRefuse] - (key) => true when it handled a click on a
 *   dimmed card (the pointer's refusal: GameScene's toast); else the
 *   announcer says reasonFor
 * @param {boolean} [o.redraw] - an empty hand a render redraws in the same task
 */
export function syncHand({ cards = [], cardW = 0, cardH = 0, lift = 0, redraw = false, ...rest } = {}) {
  if (typeof document === 'undefined') return;
  trackModality();
  handlers = rest;
  const bar = handBar({ create: cards.length > 0 });
  if (!bar) return;
  const list = buttons(bar);
  const active = document.activeElement;
  const focusedIndex = list.indexOf(active);
  const focusedKey = focusedIndex === -1 ? null : active.dataset.key;

  const byKey = new Map(list.map((b) => [b.dataset.key, b]));
  const want = cards.map((c) => byKey.get(c.key) || makeButton(c.key));
  const keep = new Set(cards.map((c) => c.key));
  for (const [key, b] of byKey) if (!keep.has(key)) b.remove();
  want.forEach((b, i) => {
    // only out-of-place nodes move (moving a focused node would blur it)
    if (bar.children[i] !== b) bar.insertBefore(b, bar.children[i] || null);
    const c = cards[i];
    b.setAttribute('aria-label', c.suggested ? `${c.label} (suggested)` : c.label);
    b.classList.toggle('is-suggested', !!c.suggested);
    b.setAttribute('aria-disabled', c.legal ? 'false' : 'true');
    const st = b.style;
    st.setProperty('--x', px(c.rect.x));
    st.setProperty('--y', px(c.rect.y));
    st.setProperty('--w', px(c.rect.w));
    st.setProperty('--h', px(c.rect.h));
  });
  bar.style.setProperty('--card-w', px(cardW));
  bar.style.setProperty('--card-h', px(cardH));
  bar.style.setProperty('--lift', px(lift));
  bar.hidden = cards.length === 0;

  // the focused card went: its neighbour, or the announcer (never the body;
  // it waits there through the next deal: my turn takes it from there)
  if (focusedKey && !keep.has(focusedKey)) {
    if (want.length) focusButton(want[Math.min(focusedIndex, want.length - 1)]);
    else {
      announcer().focus({ preventScroll: true });
      // only a render's clear comes back to the card (its redraw is in this
      // task); the last card played must not pull focus into the next deal
      if (redraw) {
        restoreKey = focusedKey;
        queueMicrotask(() => { restoreKey = null; });
      }
    }
  } else if (restoreKey && want.length) {
    // the render redrew the hand it cleared: back on the same card
    const back = keep.has(restoreKey) && document.activeElement === announcer({ create: false });
    if (back) focusButton(byKey.get(restoreKey) || want[cards.findIndex((c) => c.key === restoreKey)]);
    restoreKey = null;
  }

  // one tab stop: the focused card, else the first playable, else the first
  if (want.length && !want.some((b) => b === document.activeElement)) {
    const stop = want.find(isPlayable) || want[0];
    for (const b of want) b.tabIndex = b === stop ? 0 : -1;
  }
}

/** Whether focus may move to my hand now (see the header). */
function mayTakeFocus(active) {
  if (!active || active === document.body || active === document.documentElement) return lastInput === 'keyboard';
  return !!active.closest?.(HANDOFF);
}

/**
 * My turn to play: focus my first playable card if focus is nowhere or on
 * the table's own controls (a card already focused stays, unless it is
 * dimmed). Returns whether focus moved.
 */
export function offerTurnFocus() {
  if (typeof document === 'undefined') return false;
  const bar = handBar({ create: false });
  if (!bar || bar.hidden) return false;
  const active = document.activeElement;
  if (!mayTakeFocus(active)) return false;
  const list = buttons(bar);
  if (list.includes(active) && isPlayable(active)) return false;
  const target = list.find(isPlayable);
  if (!target) return false;
  focusButton(target);
  return true;
}

/** Forget the hand's focus memory (tests; a table teardown clears the nodes). */
export function resetHandA11y() {
  handlers = {};
  restoreKey = null;
  lastSaid = { text: '', at: 0 };
  lastInput = null;
}
