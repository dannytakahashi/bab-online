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
 *     .assist-tip          one tip at a time (state/tutorial.js shownTip:
 *                          the welcome while it is up, else the latest)
 *       .assist-tip__title   its title ("Trump") and ✕ ("Dismiss tip")
 *       .assist-tip__text    its text
 *       .assist-tip__actions the welcome's Keep / Turn off
 *
 * With tips only, the card is labelled "Tutorial tip" (data-kind tip) and
 * sits above the hand, or above the bid sheet while I bid (`place` 'bid').
 *
 *   .hud-assist-ask        the lightbulb button by my hand on my own turn at
 *                          my seat ("Ask a bot for advice", which sends /help)
 *
 * A watched seat's hint (the over-the-shoulder view, state/shoulder.js):
 * the same card, read-only (its footer without counts: assistFooter), under
 * a one-line heading naming the watched player (.assist-card__owner,
 * "Alice's advice" / "Alice's tip"), which is also the card's label.
 *
 * The lightbulb (lightbulbIcon) is our own drawing (not Apple's SF Symbol,
 * which is licensed for Apple platforms only): a filled bulb and two base
 * bars in currentColor, so it themes with the gold token.
 */
import { hudRoot } from '../tableHud.js';
import { confidenceLabel, assistFooter, isAssistHint, HELP_LABEL } from '../../state/assistHint.js';
import { isTipHint, tipText, tipActions, shownTip, TIP_ACTION_LABEL } from '../../state/tutorial.js';
import { watchedCardHeading } from '../../state/shoulder.js';

let card = null;
let current = null;
let onCloseCb = null;
let adviceOpts = {};
let idSeq = 0;
// the tutorial's tips up (state/tutorial.js), and what their buttons call
let tips = [];
let tipOpts = {};

const SVG_NS = 'http://www.w3.org/2000/svg';
// a 24-unit bulb: a circle of radius 6.75 round (12, 9) that narrows to a
// 6-wide neck, then two rounded base bars
const BULB_GLASS = 'M12 2.25A6.75 6.75 0 0 0 8.1 14.51c.56.4.9 1.04.9 1.73v.51h6v-.51c0-.69.34-1.33.9-1.73A6.75 6.75 0 0 0 12 2.25Z';
const BULB_BARS = [[9, 18, 6], [10, 20.5, 4]];

/** The lightbulb glyph (aria-hidden, currentColor). */
export function lightbulbIcon(className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const glass = document.createElementNS(SVG_NS, 'path');
  glass.setAttribute('d', BULB_GLASS);
  svg.appendChild(glass);
  for (const [x, y, w] of BULB_BARS) {
    const bar = document.createElementNS(SVG_NS, 'rect');
    bar.setAttribute('x', String(x));
    bar.setAttribute('y', String(y));
    bar.setAttribute('width', String(w));
    bar.setAttribute('height', '1.5');
    bar.setAttribute('rx', '0.75');
    svg.appendChild(bar);
  }
  return svg;
}

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
  if (typeof ResizeObserver !== 'undefined') {
    const node = card;
    new ResizeObserver(() => { if (!node.hidden) keepAdviceInSight(node); }).observe(node);
  }
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
  top.appendChild(lightbulbIcon('assist-card__bulb'));
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
 * Short of room (the card scrolls inside): the advice's chip and headline
 * stay in sight at the card's foot, the tip above them scrolled up only as
 * far as that takes (its foot, the welcome's Keep / Turn off, first in
 * sight; the tip's row is in the log), its title and ✕ pinned at the card's
 * top meanwhile (table.css: .assist-tip__top is sticky while the card has a
 * tip). Never so far that the welcome's Keep / Turn off row goes under that
 * pinned title (2026-11-21: at 1280 x 800 beside the bid sheet the row was
 * cut off under it): the buttons win over the advice's headline, which is
 * then just below the fold (the card scrolls; the bid or card has its gold
 * ring anyway). Again when the card's room changes (a resize: ResizeObserver
 * in slot).
 */
function keepAdviceInSight(root) {
  const wrap = root.querySelector(':scope > .assist-card__advice');
  const head = wrap?.querySelector('.assist-card__head');
  if (wrap && head && root.scrollHeight > root.clientHeight) {
    // (offsetTop: from the card itself, the advice's wrap is not positioned)
    const footOfHead = head.offsetTop + head.offsetHeight + 8;
    let top = Math.min(wrap.offsetTop, Math.max(0, footOfHead - root.clientHeight));
    const actions = root.querySelector(':scope > .assist-tip .assist-tip__actions');
    const pinned = actions?.closest('.assist-tip')?.querySelector('.assist-tip__top');
    if (actions && pinned) {
      // what the pinned title covers of the card's top: its box less its sticky offset (top: -8px)
      const offset = parseFloat(getComputedStyle(pinned).top) || 0;
      top = Math.min(top, Math.max(0, actions.offsetTop - (pinned.offsetHeight + offset)));
    }
    root.scrollTop = top;
  } else {
    root.scrollTop = 0;
  }
}

/**
 * Draw the card from what is up (tips, then the advice); hidden when
 * nothing is. Focus that was in the card (or on the lightbulb) lands on the
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
  // a bid answer above the bid sheet (a watcher's read-only sheet of the
  // watched seat too); tips alone there too while that seat bids
  root.dataset.place = kind === 'bid' || (!current && tipOpts.place === 'bid') ? 'bid' : 'hand';
  root.classList.toggle('is-status', kind === 'status' && !tips.length);
  root.classList.toggle('has-tip', tips.length > 0);
  // a watched seat's hint (the over-the-shoulder view, owner 2026-11-21):
  // a heading naming its player ("Alice's advice", "Alice's tip"), one line
  // at the card's top (shortened, never wrapped), and the same words as
  // the card's label
  const adviceOwner = current ? adviceOpts.owner || null : null;
  const tipOwner = tips.length ? tipOpts.owner || null : null;
  const owner = adviceOwner || tipOwner;
  const heading = owner ? watchedCardHeading(owner, { advice: !!adviceOwner, tip: !!tipOwner }) : null;
  root.setAttribute('aria-label', heading || (current ? 'Suggestion' : 'Tutorial tip'));
  if (owner) root.dataset.watched = owner;
  else delete root.dataset.watched;
  const parts = tips.map(tipSection);
  if (heading) {
    const h = el('p', 'assist-card__owner', heading);
    h.title = heading;
    parts.unshift(h);
  }
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
  keepAdviceInSight(root);
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
 * @param {string} [o.owner] - a watched seat's hint: its player's name (the over-the-shoulder view)
 * @returns {HTMLElement|null} the card
 */
export function showAssistCard(hint, { onClose = null, unlimited = false, tutorial = false, owner = null } = {}) {
  if (!isAssistHint(hint)) return null;
  current = hint;
  onCloseCb = onClose;
  adviceOpts = { unlimited, tutorial, owner };
  // focus moves to the card only from the card itself (a replace) or from
  // the lightbulb that asked for it (it hides while the card is up)
  return render({ focusFromAsk: true });
}

/**
 * Show the tutorial's tip (state/tutorial.js isTipHint): one tip card at a
 * time, shownTip of `list` (the welcome while it is up, else the newest),
 * above the advice if one is up; [] takes it down. Never takes focus.
 * @param {Object[]} list - assistHint tips
 * @param {Object} [o]
 * @param {Function} [o.onClose] - (hint): its ✕ (or Escape)
 * @param {Function} [o.onAction] - (hint, 'keep' | 'off'): the welcome's buttons
 * @param {string} [o.place] - 'bid': above the bid sheet (my bid turn), else above the hand
 * @param {string} [o.owner] - a watched seat's tip: its player's name
 * @returns {HTMLElement|null} the card
 */
export function showAssistTips(list, { onClose = null, onAction = null, place = 'hand', owner = null } = {}) {
  const one = shownTip(list);
  tips = one ? [one] : [];
  tipOpts = { onClose, onAction, place, owner };
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

// ------------------------------------------------------- the lightbulb button

let ask = null;

/**
 * The lightbulb button by my hand: shown while `visible`, a click calls `onAsk`
 * (GameScene: sends /help). Hidden while the card is up.
 */
export function syncAssistButton({ visible = false, onAsk = null } = {}) {
  if (typeof document === 'undefined') return null;
  if (ask && !ask.isConnected) ask = null;
  if (!ask) {
    if (!visible) return null;
    ask = el('button', 'hud-assist-ask');
    ask.appendChild(lightbulbIcon('hud-assist-ask__bulb'));
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
