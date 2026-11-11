/**
 * Toast (roadmap item 18a): ONE queue for the whole page (it replaces
 * Toast.js's per-call toasts and main.js's .error-toast, which could stack
 * on top of each other).
 *
 *   - one toast is shown at a time, in the region at the bottom centre
 *     (z-index token 'toast'); the rest wait their turn, in order;
 *   - a toast of the type on screen replaces it (the newer message wins),
 *     and a queued one of the same type is replaced in place, so a burst
 *     of errors shows the latest instead of a backlog;
 *   - an error goes ahead of every waiting toast that is not an error, and a
 *     warning ahead of info and success; one that outranks the toast on
 *     screen takes its place at once (that one leaves early), so a failed
 *     sign-in is never held behind a 5 s "Registration successful";
 *   - errors are announced assertively (role=alert), the rest politely.
 */
import { el } from './elements.js';
import { motionMs } from '../motion.js';

export const TOAST_DURATION = 5000;
export const TOAST_TYPES = ['info', 'success', 'warning', 'error'];
const REGION_ID = 'kit-toast-region';

/** Which toast goes first: an error, then a warning, then the rest (in order). */
const RANK = { info: 0, success: 0, warning: 1, error: 2 };

const queue = [];
let current = null; // { el, type, timer }

function region() {
  let r = document.getElementById(REGION_ID);
  if (!r || !r.isConnected) {
    r = el('div', { className: 'kit-toast-region', attrs: { id: REGION_ID } });
    document.body.appendChild(r);
  }
  return r;
}

function build(message, type) {
  return el('div', {
    className: `kit-toast toast toast-${type}`,
    attrs: { role: type === 'error' ? 'alert' : 'status', 'aria-live': type === 'error' ? 'assertive' : 'polite' },
    text: message,
  });
}

function show(item) {
  current = item;
  region().appendChild(item.el);
  item.timer = setTimeout(() => dismissCurrent(), item.duration);
}

function next() {
  current = null;
  const item = queue.shift();
  if (item) show(item);
}

function dismissCurrent() {
  const item = current;
  if (!item) return;
  clearTimeout(item.timer);
  item.el.classList.add('is-leaving');
  const leave = motionMs('fast');
  const done = () => {
    item.el.remove();
    if (current === item) next();
  };
  if (leave > 0) item.timer = setTimeout(done, leave);
  else done();
}

/**
 * Queue a toast.
 * @param {string} message
 * @param {Object} [o]
 * @param {'info'|'success'|'warning'|'error'} [o.type='info']
 * @param {number} [o.duration=5000]
 * @returns {HTMLElement} the toast's element (attached once it is its turn)
 */
export function toast(message, { type = 'info', duration = TOAST_DURATION } = {}) {
  const kind = TOAST_TYPES.includes(type) ? type : 'info';
  if (current && current.type === kind && !current.el.classList.contains('is-leaving')) {
    // the newer message of the same kind replaces the one on screen
    clearTimeout(current.timer);
    current.el.textContent = String(message);
    current.duration = duration;
    current.timer = setTimeout(() => dismissCurrent(), duration);
    return current.el;
  }
  const queued = queue.find((q) => q.type === kind);
  if (queued) {
    queued.el.textContent = String(message);
    queued.duration = duration;
    return queued.el;
  }
  const item = { el: build(message, kind), type: kind, duration, timer: null };
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
  document.getElementById(REGION_ID)?.remove();
}
