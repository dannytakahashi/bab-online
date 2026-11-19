/**
 * Toast (roadmap item 18a; iOS look, owner 2026-11-19): ONE queue for the
 * whole page (it replaces Toast.js's per-call toasts and main.js's
 * .error-toast, which could stack on top of each other).
 *
 *   - a pill at the top centre (under the connection banner while that
 *     shows), as iOS's ServerErrorToast: an icon (teal "i" for info, amber
 *     "!" for a refusal or warning, red "!" for a real error, green check
 *     for success) and bold text; a tap dismisses it;
 *   - one toast is shown at a time (z-index token 'toast'); the rest wait
 *     their turn, in order;
 *   - a toast of the type on screen replaces it (the newer message wins),
 *     and a queued one of the same type is replaced in place, so a burst
 *     of errors shows the latest instead of a backlog; the same words again
 *     restart its timer and nudge it (a repeated illegal click);
 *   - an error goes ahead of every waiting toast that is not an error, and a
 *     warning ahead of info and success; one that outranks the toast on
 *     screen takes its place at once (that one leaves early), so a failed
 *     sign-in is never held behind a 5 s "Registration successful";
 *   - screen readers hear each toast once through a persistent pair of
 *     visually hidden announcers in the region (errors assertive, the rest
 *     polite): a live region inserted with its text already in it is read
 *     unreliably (VoiceOver + Safari), so the matching announcer is cleared
 *     and its text set a moment later, and the same words again are read
 *     again. The visible card has no live role, so nothing is said twice.
 */
import { el } from './elements.js';
import { motionMs } from '../motion.js';

export const TOAST_DURATION = 5000;
/** iOS ServerErrorToast.visibleSeconds: table refusals and in-game notices. */
export const TOAST_SHORT = 3000;
export const TOAST_TYPES = ['info', 'success', 'warning', 'error'];
const REGION_ID = 'kit-toast-region';
/** How long after clearing an announcer its new text is set (the "next frame", generous for VoiceOver). */
export const ANNOUNCE_DELAY_MS = 50;
/** A long message stays at least this long per word (about 1 s per 12 words). */
const MS_PER_WORD = 1000 / 12;

/** Which toast goes first: an error, then a warning, then the rest (in order). */
const RANK = { info: 0, success: 0, warning: 1, error: 2 };

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The glyph drawn over the filled circle, per type (24-unit box). */
const GLYPH = {
  info: 'M12 11v6M12 7.5v.01',
  success: 'M7.5 12.5l3 3 6-6.5',
  warning: 'M12 7v6.5M12 16.5v.01',
  error: 'M12 7v6.5M12 16.5v.01',
};

const queue = [];
let current = null; // { el, type, timer, duration, text, announce }
let announceTimer = null;
let spokenBy = null; // the toast whose words the announcers hold (cleared when it goes)

function visuallyHidden(role, live) {
  return el('div', {
    className: 'kit-toast-announcer',
    attrs: { role, 'aria-live': live, 'aria-atomic': 'true' },
  });
}

function region() {
  let r = document.getElementById(REGION_ID);
  if (!r || !r.isConnected) {
    r = el('div', { className: 'kit-toast-region', attrs: { id: REGION_ID } });
    r.appendChild(visuallyHidden('status', 'polite'));
    r.appendChild(visuallyHidden('alert', 'assertive'));
    document.body.appendChild(r);
  }
  return r;
}

/** The region's announcers: { polite, assertive }. */
export function toastAnnouncers() {
  const r = region();
  return {
    polite: r.querySelector('.kit-toast-announcer[aria-live="polite"]'),
    assertive: r.querySelector('.kit-toast-announcer[aria-live="assertive"]'),
  };
}

/** Say `text` through the announcer for `type` (cleared first, so the same words are read again), for toast `owner`. */
function speak(type, text, owner) {
  spokenBy = owner;
  const { polite, assertive } = toastAnnouncers();
  const target = type === 'error' ? assertive : polite;
  const other = target === polite ? assertive : polite;
  clearTimeout(announceTimer);
  target.textContent = '';
  other.textContent = '';
  announceTimer = setTimeout(() => {
    announceTimer = null;
    if (target.isConnected) target.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

function icon(type) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('focusable', 'false');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  circle.setAttribute('class', 'kit-toast__disc');
  const glyph = document.createElementNS(SVG_NS, 'path');
  glyph.setAttribute('d', GLYPH[type]);
  glyph.setAttribute('class', 'kit-toast__glyph');
  svg.append(circle, glyph);
  const wrap = el('span', { className: 'kit-toast__icon', attrs: { 'aria-hidden': 'true' } });
  wrap.appendChild(svg);
  return wrap;
}

function build(message, type) {
  const card = el('div', { className: `kit-toast toast toast-${type}` });
  card.appendChild(icon(type));
  card.appendChild(el('span', { className: 'kit-toast__text', text: message }));
  // a tap (or click) dismisses it, as on iOS; not focusable (no close button, no focus trap)
  card.addEventListener('click', () => {
    if (current && current.el === card) dismissCurrent();
  });
  return card;
}

function setText(item, message) {
  item.text = message;
  const span = item.el.querySelector('.kit-toast__text');
  if (span) span.textContent = message;
}

/** At least ~1 s per 12 words, so a long text in a 3 s slot can still be read. */
function readable(message, duration) {
  const words = String(message).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(duration, Math.round(words * MS_PER_WORD));
}

function arm(item) {
  clearTimeout(item.timer);
  item.timer = setTimeout(() => dismissCurrent(), item.duration);
}

function show(item) {
  current = item;
  region().appendChild(item.el);
  arm(item);
  if (item.announce) speak(item.type, item.text, item);
}

function next() {
  current = null;
  const item = queue.shift();
  if (item) show(item);
}

function dismissCurrent() {
  const item = current;
  if (!item || item.el.classList.contains('is-leaving')) return;
  clearTimeout(item.timer);
  item.el.classList.add('is-leaving');
  const leave = motionMs('fast');
  const done = () => {
    item.el.remove();
    // its words leave with it: a reader browsing later finds no stale
    // "Not your turn." in the region (another toast's words are kept)
    if (spokenBy === item) silence();
    if (current === item) next();
  };
  if (leave > 0) item.timer = setTimeout(done, leave);
  else done();
}

/** Empty both announcers (and drop a pending announcement). */
function silence() {
  spokenBy = null;
  clearTimeout(announceTimer);
  announceTimer = null;
  const r = document.getElementById(REGION_ID);
  r?.querySelectorAll('.kit-toast-announcer').forEach((a) => { a.textContent = ''; });
}

/** Replay the nudge (the same words again). */
function nudge(card) {
  card.classList.remove('is-nudged');
  // restart the animation: a reflow between removing and adding the class
  void card.offsetWidth;
  card.classList.add('is-nudged');
}

/**
 * Queue a toast.
 * @param {string} message
 * @param {Object} [o]
 * @param {'info'|'success'|'warning'|'error'} [o.type='info']
 * @param {number} [o.duration=5000]
 * @param {boolean} [o.announce=true] - false when the caller already spoke the words
 * @returns {HTMLElement} the toast's element (attached once it is its turn)
 */
export function toast(message, { type = 'info', duration = TOAST_DURATION, announce = true } = {}) {
  const kind = TOAST_TYPES.includes(type) ? type : 'info';
  const text = String(message);
  const ms = readable(text, duration);
  if (current && current.type === kind && !current.el.classList.contains('is-leaving')) {
    // the same words again: restart the timer, nudge, say it again;
    // other words of the same kind replace the ones on screen
    if (current.text === text) nudge(current.el);
    else setText(current, text);
    current.duration = ms;
    current.announce = announce;
    arm(current);
    if (announce) speak(kind, text, current);
    return current.el;
  }
  const queued = queue.find((q) => q.type === kind);
  if (queued) {
    setText(queued, text);
    queued.duration = ms;
    queued.announce = announce;
    return queued.el;
  }
  const item = { el: build(text, kind), type: kind, duration: ms, timer: null, text, announce };
  // ahead of every waiting toast it outranks (in order among its equals)
  const at = queue.findIndex((q) => RANK[q.type] < RANK[kind]);
  if (at === -1) queue.push(item);
  else queue.splice(at, 0, item);
  if (!current) next();
  else if (RANK[kind] > RANK[current.type] && !current.el.classList.contains('is-leaving')) {
    // it outranks the one on screen: that one leaves now
    dismissCurrent();
  }
  return item.el;
}

/** Waiting toasts plus the one on screen (tests). */
export function toastQueueLength() {
  return queue.length + (current ? 1 : 0);
}

/** Drop every toast (teardown, tests). */
export function clearToasts() {
  if (current) {
    clearTimeout(current.timer);
    current.el.remove();
  }
  current = null;
  queue.length = 0;
  clearTimeout(announceTimer);
  announceTimer = null;
  spokenBy = null;
  document.getElementById(REGION_ID)?.remove();
}
