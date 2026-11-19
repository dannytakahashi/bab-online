/**
 * The /help card (plan H3; words and rules in state/assistHint.js): the
 * private answer to my /help (s2c assistHint), drawn in the table HUD just
 * above my hand, centred on it (tableHud's --assist-x / --assist-y, from
 * the layout's hand box). Only I see it.
 *
 *   .hud-assist            role region "Suggestion" (not live: the table's
 *                          announcer says the headline and the main reason
 *                          once, ui/handA11y.js announce)
 *     .assist-card__top    the confidence chip and the close button (✕,
 *                          "Dismiss suggestion"; Escape inside the card too)
 *     .assist-card__head   the headline ("Bid 4", "Lead A♣")
 *     .assist-card__reasons  up to 2 reasons
 *     .assist-card__note   the warning on the last free use, or "This game
 *                          now counts as bot-assisted for you." (amber)
 *     .assist-card__why    "Why?" (aria-expanded) and up to 4 details
 *     .assist-card__foot   "What our strongest bot would play · Help 2 of 3 free"
 *                          (just "What our strongest bot would play" in a
 *                          game with a native bot seat: `unlimited`)
 *
 * A status reply (kind status: off-turn, a refusal) is the same card with
 * the headline only. The card never takes focus.
 *
 *   .hud-assist-ask        the "?" button by my hand on my own turn at my
 *                          seat ("Ask a bot for advice", which sends /help)
 */
import { hudRoot } from '../tableHud.js';
import { confidenceLabel, assistFooter, isAssistHint, HELP_LABEL } from '../../state/assistHint.js';

let card = null;
let current = null;
let onCloseCb = null;
let idSeq = 0;

function el(tag, className, text = null) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== null && text !== undefined) e.textContent = String(text);
  return e;
}

/** The card's node (created on demand in the HUD), or null. */
function slot({ create = true } = {}) {
  if (card && card.isConnected) return card;
  card = null;
  if (!create || typeof document === 'undefined') return null;
  card = el('div', 'hud-assist');
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Suggestion');
  card.hidden = true;
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  });
  hudRoot().appendChild(card);
  return card;
}

/** ✕ / Escape: the owner takes it down (and places focus), else it goes here. */
function dismiss() {
  const cb = onCloseCb;
  onCloseCb = null;
  cb?.();
  if (card && card.isConnected && !card.hidden) hideAssistCard();
}

/**
 * Show `hint` (a new one replaces the one up).
 * @param {Object} hint - assistHint
 * @param {Object} [o]
 * @param {Function} [o.onClose] - the player dismissed it (✕, Escape)
 * @returns {HTMLElement|null} the card
 */
export function showAssistCard(hint, { onClose = null, unlimited = false } = {}) {
  if (!isAssistHint(hint)) return null;
  const root = slot();
  if (!root) return null;
  // focus moves to the card only from the card itself (a replace) or from
  // the "?" that asked for it (it hides while the card is up)
  const active = document.activeElement;
  const hadFocus = root.contains(active) || !!active?.classList?.contains('hud-assist-ask');
  current = hint;
  onCloseCb = onClose;
  const status = hint.kind === 'status';
  root.classList.toggle('is-status', status);
  root.dataset.kind = hint.kind;

  const top = el('div', 'assist-card__top');
  const label = status ? null : confidenceLabel(hint);
  if (label) top.appendChild(el('span', `assist-card__chip is-${hint.confidence}`, label));
  const close = el('button', 'assist-card__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss suggestion');
  close.textContent = '✕';
  close.addEventListener('click', dismiss);
  top.appendChild(close);

  const parts = [top, el('div', 'assist-card__head', hint.headline)];
  const reasons = status ? [] : (Array.isArray(hint.reasons) ? hint.reasons : []).filter(Boolean).slice(0, 2);
  if (reasons.length) {
    const ul = el('ul', 'assist-card__reasons');
    for (const r of reasons) ul.appendChild(el('li', null, r));
    parts.push(ul);
  }
  if (hint.note) parts.push(el('p', 'assist-card__note', hint.note));
  const details = status ? [] : (Array.isArray(hint.details) ? hint.details : []).filter(Boolean).slice(0, 4);
  if (details.length) {
    const why = el('div', 'assist-card__why');
    const id = `assist-why-${++idSeq}`;
    const toggle = el('button', 'assist-card__why-toggle', 'Why?');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', id);
    const list = el('ul', 'assist-card__details');
    list.id = id;
    list.hidden = true;
    for (const d of details) list.appendChild(el('li', null, d));
    toggle.addEventListener('click', () => {
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    why.append(toggle, list);
    parts.push(why);
  }
  const footer = assistFooter(hint, { unlimited });
  if (footer) parts.push(el('p', 'assist-card__foot', footer));

  root.replaceChildren(...parts);
  root.hidden = false;
  if (hadFocus) close.focus({ preventScroll: true });
  return root;
}

/** Take the card down (no callback). Focus inside it goes to the hand's announcer. */
export function hideAssistCard() {
  const root = slot({ create: false });
  current = null;
  onCloseCb = null;
  if (!root) return;
  const hadFocus = root.contains(document.activeElement);
  root.hidden = true;
  root.replaceChildren();
  if (hadFocus) document.querySelector('#table-hud > .hud-announcer')?.focus?.({ preventScroll: true });
}

/** The hint the card shows, or null. */
export function assistCardHint() {
  return card && card.isConnected && !card.hidden ? current : null;
}

// ------------------------------------------------------------ the "?" button

let ask = null;

/**
 * The "?" button by my hand: shown while `visible`, a click calls `onAsk`
 * (GameScene: sends /help). Hidden while the card is up.
 */
export function syncAssistButton({ visible = false, onAsk = null } = {}) {
  if (typeof document === 'undefined') return null;
  if (ask && !ask.isConnected) ask = null;
  if (!ask) {
    if (!visible) return null;
    ask = el('button', 'hud-assist-ask', '?');
    ask.type = 'button';
    ask.setAttribute('aria-label', HELP_LABEL);
    ask.title = `${HELP_LABEL} (/help)`;
    ask.addEventListener('click', () => ask?._onAsk?.());
    hudRoot().appendChild(ask);
  }
  ask._onAsk = onAsk;
  ask.hidden = !visible;
  return ask;
}

/** Tests: forget the nodes. */
export function resetAssistCard() {
  card?.remove();
  ask?.remove();
  card = null;
  ask = null;
  current = null;
  onCloseCb = null;
}
