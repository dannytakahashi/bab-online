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
 * The tutorial (state/tutorial.js): its advice is this same card (source
 * tutorial); its rule tips are sections at the top of the card, in a
 * neutral style, above the advice when both are up (a tip and the advice
 * of the same decision arrive together):
 *
 *     .assist-tip          one tip (at most the welcome and the latest one)
 *       .assist-tip__title   its title ("Trump") and ✕ ("Dismiss tip")
 *       .assist-tip__text    its text
 *       .assist-tip__actions the welcome's Keep / Turn off
 *
 * With tips only, the card is labelled "Tutorial tip" (data-kind tip) and
 * sits above the hand, or above the bid sheet while I bid (`place` 'bid').
 *
 *   .hud-assist-ask        the "?" button by my hand on my own turn at my
 *                          seat ("Ask a bot for advice", which sends /help)
 */
import { hudRoot } from '../tableHud.js';
import { confidenceLabel, assistFooter, isAssistHint, HELP_LABEL } from '../../state/assistHint.js';
import { isTipHint, tipText, tipActions, TIP_ACTION_LABEL } from '../../state/tutorial.js';

let card = null;
let current = null;
let onCloseCb = null;
let adviceOpts = {};
let idSeq = 0;
// the tutorial's tips up (state/tutorial.js), and what their buttons call
let tips = [];
let tipOpts = {};

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
      dismissAll();
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
  if (current) hideAssistCard();
}

/** Escape: the whole card (the advice, then each tip as its own ✕ would). */
function dismissAll() {
  if (current) dismiss();
  for (const t of tips.slice()) closeTip(t);
}

/** A tip's ✕: the owner drops it (GameScene), else it goes here. */
function closeTip(hint) {
  const cb = tipOpts.onClose;
  if (cb) cb(hint);
  else showAssistTips(tips.filter((t) => t !== hint), tipOpts);
}

/** The advice's parts (the /help answer, or a status reply). */
function adviceParts(hint, { unlimited = false, tutorial = false } = {}) {
  const status = hint.kind === 'status';
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
  const footer = assistFooter(hint, { unlimited, tutorial });
  if (footer) parts.push(el('p', 'assist-card__foot', footer));
  return parts;
}

/** One tip's section: its title and ✕, its text, the welcome's buttons. */
function tipSection(hint) {
  const sec = el('section', 'assist-tip');
  sec.dataset.tipId = hint.tipId || '';
  const titleId = `assist-tip-${++idSeq}`;
  sec.setAttribute('aria-labelledby', titleId);
  const top = el('div', 'assist-tip__top');
  const title = el('span', 'assist-tip__title', hint.headline);
  title.id = titleId;
  const close = el('button', 'assist-tip__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss tip');
  close.textContent = '✕';
  close.addEventListener('click', () => closeTip(hint));
  top.append(title, close);
  sec.append(top, el('p', 'assist-tip__text', tipText(hint)));
  const actions = tipActions(hint);
  if (actions.length) {
    const row = el('div', 'assist-tip__actions');
    for (const a of actions) {
      const b = el('button', `assist-tip__action is-${a}`, TIP_ACTION_LABEL[a]);
      b.type = 'button';
      b.dataset.action = a;
      b.addEventListener('click', () => {
        const cb = tipOpts.onAction;
        if (cb) cb(hint, a);
        else showAssistTips(tips.filter((t) => t !== hint), tipOpts);
      });
      row.appendChild(b);
    }
    sec.appendChild(row);
  }
  return sec;
}

/**
 * Draw the card from what is up (tips, then the advice); hidden when
 * nothing is. Focus that was in the card (or on the "?") lands on the
 * advice's ✕, else the first tip's.
 */
function render({ focusFromAsk = false } = {}) {
  const root = slot({ create: !!current || tips.length > 0 });
  if (!root) return null;
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const hadFocus = root.contains(active) || (focusFromAsk && !!active?.classList?.contains('hud-assist-ask'));
  if (!current && !tips.length) {
    root.hidden = true;
    root.replaceChildren();
    delete root.dataset.kind;
    delete root.dataset.place;
    root.classList.remove('is-status', 'has-tip');
    if (hadFocus) document.querySelector('#table-hud > .hud-announcer')?.focus?.({ preventScroll: true });
    return root;
  }
  const kind = current ? current.kind : 'tip';
  root.dataset.kind = kind;
  // a bid answer above the bid sheet; tips alone there too while I bid
  root.dataset.place = kind === 'bid' || (!current && tipOpts.place === 'bid') ? 'bid' : 'hand';
  root.classList.toggle('is-status', kind === 'status' && !tips.length);
  root.classList.toggle('has-tip', tips.length > 0);
  root.setAttribute('aria-label', current ? 'Suggestion' : 'Tutorial tip');
  const parts = tips.map(tipSection);
  if (current) {
    const advice = adviceParts(current, adviceOpts);
    if (tips.length) {
      const wrap = el('div', 'assist-card__advice');
      wrap.append(...advice);
      parts.push(wrap);
    } else {
      parts.push(...advice);
    }
  }
  root.replaceChildren(...parts);
  root.hidden = false;
  if (hadFocus) (root.querySelector('.assist-card__close') || root.querySelector('.assist-tip__close'))?.focus({ preventScroll: true });
  return root;
}

/**
 * Show `hint` (a new one replaces the one up; tips up stay above it).
 * @param {Object} hint - assistHint
 * @param {Object} [o]
 * @param {Function} [o.onClose] - the player dismissed it (✕, Escape)
 * @param {boolean} [o.unlimited] - a game with a native bot seat (no count)
 * @param {boolean} [o.tutorial] - my tutorial is on (/help not counted)
 * @returns {HTMLElement|null} the card
 */
export function showAssistCard(hint, { onClose = null, unlimited = false, tutorial = false } = {}) {
  if (!isAssistHint(hint)) return null;
  current = hint;
  onCloseCb = onClose;
  adviceOpts = { unlimited, tutorial };
  // focus moves to the card only from the card itself (a replace) or from
  // the "?" that asked for it (it hides while the card is up)
  return render({ focusFromAsk: true });
}

/**
 * Show the tutorial's tips (state/tutorial.js isTipHint; at most two: the
 * welcome and the latest), above the advice if one is up; [] takes them
 * down. Never takes focus.
 * @param {Object[]} list - assistHint tips
 * @param {Object} [o]
 * @param {Function} [o.onClose] - (hint): its ✕ (or Escape)
 * @param {Function} [o.onAction] - (hint, 'keep' | 'off'): the welcome's buttons
 * @param {string} [o.place] - 'bid': above the bid sheet (my bid turn), else above the hand
 * @returns {HTMLElement|null} the card
 */
export function showAssistTips(list, { onClose = null, onAction = null, place = 'hand' } = {}) {
  tips = (Array.isArray(list) ? list : []).filter(isTipHint).slice(-2);
  tipOpts = { onClose, onAction, place };
  return render();
}

/** The tips up (newest last). */
export function assistCardTips() {
  return card && card.isConnected && !card.hidden ? tips.slice() : [];
}

/**
 * Take the advice down (no callback); tips up stay. Focus inside it goes to
 * the hand's announcer when nothing is left.
 */
export function hideAssistCard() {
  current = null;
  onCloseCb = null;
  if (!slot({ create: false })) return;
  render();
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
  adviceOpts = {};
  tips = [];
  tipOpts = {};
}
