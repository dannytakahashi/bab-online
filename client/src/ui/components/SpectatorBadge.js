/**
 * Who is watching (owner, 2026-11-11): a small eye + count in the table's
 * bottom-right corner (the layout's `spectators` rect: the HUD slot
 * .hud-spectators, placed by applyHudLayout's --spec-* variables), seen by
 * everyone at the table, players and spectators alike. Hidden at 0.
 *
 *   - a kit IconButton (44 px hit target), aria-label "2 people watching",
 *     a disclosure (aria-expanded + aria-controls; no aria-haspopup: the
 *     list is a group with a plain list, not a menu);
 *   - click / Enter / Space toggles a small popover listing the names with
 *     their avatars (avatarSrc / applyAvatarImg), scrolling past ~8 rows;
 *     hovering with a mouse opens it too, leaving closes a hover-opened one;
 *   - Escape or a click outside closes it. Escape puts the focus back on
 *     the button only when the focus was in the badge (or nowhere, after a
 *     click in Safari); with a hover-opened list and the caret elsewhere (the
 *     chat input, a modal) it only closes the list and the key goes on;
 *   - it fades in with the motion tokens (--dur-fast; 0 ms under reduced
 *     motion, tokens.css; ui/motion.js is the JS side of the same rule) and
 *     closes at once.
 *
 * Data: GameState.watching through renderModel().watching (state is the one
 * writer: spectatorsUpdated and snapshot.watching). renderSpectatorBadge is
 * idempotent: renderTable calls it on every render, the spectatorsUpdated
 * handler on every list. The HUD's clearHud removes the node with the
 * table; removeSpectatorBadge also drops the document listeners.
 *
 * Spectator voice (family lobbies, 2026-11-16; owner 2026-11-22): a voice
 * spectator's speaking ring is the badge's, since a spectator has no seat to
 * light. The badge has a steady green outline (the seats' speaking ring:
 * --success, no animation, so nothing to drop under reduced motion) while
 * any spectator other than me talks (setSpeaking by username, or
 * setUnnamedSpeaking by peer id for a voice spectator with no name; main.js
 * decides who counts: voice/speakingSlot.js spectatorSpeakerFor). Seated
 * players never light it (their seat glows) and neither does my own voice
 * (my mic button shows it). Each talking spectator's row in the list has a
 * green dot (the voice panel's .voice-row__dot look) and "talking" for
 * screen readers; the badge's aria-label adds "Bo is talking" / "Bo and Cy
 * are talking" / "3 spectators are talking", and the table's polite
 * announcer says it when someone starts talking after a quiet spell
 * (SPEAKING_QUIET_MS: changes only, never every breath, never a stop).
 */

import { el, createIconButton } from '../kit/index.js';
import { avatarSrc, applyAvatarImg, CUSTOM_FALLBACK } from '../../utils/avatar.js';
import { hudSpectatorSlot } from '../tableHud.js';
import { prefersReducedMotion } from '../motion.js';
import { watcherRow } from '../../state/shoulder.js';
import { announce } from '../handA11y.js';

/** An SF Symbol-like eye ("eye.fill"), drawn: no emoji in the UI. */
export const EYE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" fill-rule="evenodd" d="M12 5C6.6 5 2.8 9 1.4 11.3a1.4 1.4 0 0 0 0 1.4C2.8 15 6.6 19 12 19'
  + 's9.2-4 10.6-6.3a1.4 1.4 0 0 0 0-1.4C21.2 9 17.4 5 12 5zm0 11.6a4.6 4.6 0 1 1 0-9.2 4.6 4.6 0 0 1 0 9.2z'
  + 'm0-2.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z"/></svg>';

const POPOVER_ID = 'spectator-list';

/** "1 person watching", "2 people watching". */
export function watchingLabel(count) {
  return `${count} ${count === 1 ? 'person' : 'people'} watching`;
}

/**
 * Who of the watchers is talking, in words: "Bo is talking", "Bo and Cy are
 * talking", "3 spectators are talking" past two; a nameless voice spectator
 * is "a spectator" ("A spectator is talking", "2 spectators are talking").
 * '' when nobody talks.
 * @param {string[]} names - talking spectators' usernames, in the order they started
 * @param {number} [unnamed] - talking voice spectators with no name
 */
export function speakingText(names, unnamed = 0) {
  const total = names.length + unnamed;
  if (total === 0) return '';
  if (total > 2 || (unnamed > 0 && total > 1)) return `${total} spectators are talking`;
  if (total === 1) return `${names[0] || 'A spectator'} is talking`;
  return `${names[0]} and ${names[1]} are talking`;
}

/** A spectator who starts talking within this long of their last talk is not announced again. */
export const SPEAKING_QUIET_MS = 10000;

let docListeners = null;
let openedBy = null; // 'click' | 'hover' | null
// Watching usernames whose voice is speaking now (setSpeaking), in the order they started
const speaking = new Set();
// Talking voice spectators with no username, by peer socket id (setUnnamedSpeaking)
const unnamedSpeaking = new Set();
// key ('u:<name>' / 'p:<peer id>') -> when it last talked (the announcer's quiet spell)
const lastTalked = new Map();

const anySpeaking = () => speaking.size + unnamedSpeaking.size > 0;

/** The badge's aria-label: the count, then who is talking. */
function badgeLabel(count) {
  const talking = speakingText([...speaking], unnamedSpeaking.size);
  return talking ? `${watchingLabel(count)}. ${talking}` : watchingLabel(count);
}

/** The badge, its label and the list rows show who of the watchers is speaking. */
function applySpeaking(slot) {
  const btn = buttonOf(slot);
  if (!btn) return;
  btn.classList.toggle('voice-speaking', anySpeaking());
  btn.setAttribute('aria-label', badgeLabel(Number(slot.dataset.count) || 0));
  for (const li of slot.querySelectorAll('.spectator-popover__row')) {
    const on = speaking.has(li.dataset.username);
    li.classList.toggle('is-speaking', on);
    const said = li.querySelector('.spectator-popover__talking');
    if (said) said.textContent = on ? ' (talking)' : '';
  }
}

/**
 * Someone started or stopped talking: redraw, and on a start after a quiet
 * spell say who is talking now (the polite table announcer), while the
 * badge is up.
 */
function speakingChanged(key, on, wasOn) {
  const slot = hudSpectatorSlot({ create: false });
  if (slot) applySpeaking(slot);
  if (!on || wasOn) {
    if (!on && wasOn) lastTalked.set(key, Date.now());
    return;
  }
  const now = Date.now();
  const last = lastTalked.get(key);
  lastTalked.set(key, now);
  if (last !== undefined && now - last < SPEAKING_QUIET_MS) return;
  if (slot && !slot.hidden) announce(speakingText([...speaking], unnamedSpeaking.size));
}

/**
 * A watcher's voice started or stopped speaking (VoiceChatManager's
 * speaking poll, by username: main.js showVoiceControls).
 * @param {string} username
 * @param {boolean} on
 */
export function setSpeaking(username, on) {
  if (!username) return;
  const wasOn = speaking.has(username);
  if (on) speaking.add(username);
  else speaking.delete(username);
  speakingChanged(`u:${username}`, !!on, wasOn);
}

/**
 * A voice spectator with no username started or stopped speaking (by its
 * peer socket id): it lights the badge (no row to mark).
 * @param {string} peerId
 * @param {boolean} on
 */
export function setUnnamedSpeaking(peerId, on) {
  if (!peerId) return;
  const wasOn = unnamedSpeaking.has(peerId);
  if (on) unnamedSpeaking.add(peerId);
  else unnamedSpeaking.delete(peerId);
  speakingChanged(`p:${peerId}`, !!on, wasOn);
}

/** Nobody is talking any more (voice stopped): the ring and the dots go. */
export function clearSpeaking() {
  if (!anySpeaking()) return;
  speaking.clear();
  unnamedSpeaking.clear();
  const slot = hudSpectatorSlot({ create: false });
  if (slot) applySpeaking(slot);
}

/** Is a watcher's voice speaking now? (tests, the overlay) */
export function isWatcherSpeaking(username) {
  return speaking.has(username);
}

/** Is any spectator talking now (the badge's ring)? (tests) */
export function isAnyWatcherSpeaking() {
  return anySpeaking();
}

function popoverOf(slot) {
  return slot?.querySelector(`#${POPOVER_ID}`) || null;
}

function buttonOf(slot) {
  return slot?.querySelector('.spectator-badge') || null;
}

/** Is the list open? */
export function isSpectatorListOpen() {
  const pop = popoverOf(hudSpectatorSlot({ create: false }));
  return !!pop && !pop.hidden;
}

function removeDocListeners() {
  if (!docListeners) return;
  document.removeEventListener('pointerdown', docListeners.down, true);
  document.removeEventListener('keydown', docListeners.key, true);
  docListeners = null;
}

/** Close the list (focus back on the badge when `refocus`). */
export function closeSpectatorList({ refocus = false } = {}) {
  const slot = hudSpectatorSlot({ create: false });
  const pop = popoverOf(slot);
  const btn = buttonOf(slot);
  if (pop) {
    pop.hidden = true;
    pop.classList.remove('is-open');
  }
  btn?.setAttribute('aria-expanded', 'false');
  openedBy = null;
  removeDocListeners();
  if (refocus) btn?.focus();
}

function openSpectatorList(slot, how) {
  const pop = popoverOf(slot);
  const btn = buttonOf(slot);
  if (!pop || !btn || slot.hidden) return;
  pop.hidden = false;
  // the fade-in (CSS, --dur-fast); instant under reduced motion. Coming out
  // of display:none it has no before-change style, so flush the opacity-0
  // style first or the transition never runs.
  pop.classList.toggle('is-instant', prefersReducedMotion());
  void pop.offsetWidth;
  pop.classList.add('is-open');
  btn.setAttribute('aria-expanded', 'true');
  openedBy = how;
  if (!docListeners) {
    docListeners = {
      down: (e) => {
        const s = hudSpectatorSlot({ create: false });
        if (s && !s.contains(e.target)) closeSpectatorList();
      },
      key: (e) => {
        if (e.key !== 'Escape' || !isSpectatorListOpen()) return;
        const s = hudSpectatorSlot({ create: false });
        const active = document.activeElement;
        const focusInBadge = !!s && !!active && s.contains(active);
        const focusNowhere = !active || active === document.body;
        if (focusInBadge || (openedBy === 'click' && focusNowhere)) {
          e.stopPropagation(); // the badge's Escape
          closeSpectatorList({ refocus: true });
        } else {
          closeSpectatorList(); // focus stays where it is; the key goes on
        }
      },
    };
    document.addEventListener('pointerdown', docListeners.down, true);
    document.addEventListener('keydown', docListeners.key, true);
  }
}

function build(slot) {
  const btn = createIconButton({ icon: EYE_ICON, label: watchingLabel(0), className: 'spectator-badge' });
  btn.removeAttribute('title'); // the popover is the tooltip
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', POPOVER_ID);
  btn.appendChild(el('span', { className: 'spectator-badge__count', attrs: { 'aria-hidden': 'true' } }));
  btn.addEventListener('click', () => {
    // a click on a hover-opened list pins it open; else it toggles
    if (isSpectatorListOpen() && openedBy !== 'hover') closeSpectatorList();
    else if (isSpectatorListOpen()) openedBy = 'click';
    else openSpectatorList(slot, 'click');
  });
  const pop = el('div', {
    className: 'spectator-popover kit-elev-3',
    attrs: { id: POPOVER_ID, role: 'group', 'aria-label': 'People watching' },
    children: [
      el('div', { className: 'spectator-popover__title', text: 'Watching' }),
      // role=list: WebKit drops list semantics under list-style: none
      el('ul', { className: 'spectator-popover__list', attrs: { role: 'list' } }),
      el('div', { className: 'spectator-popover__more' }),
    ],
  });
  pop.hidden = true;
  slot.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse' && !isSpectatorListOpen()) openSpectatorList(slot, 'hover');
  });
  slot.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && openedBy === 'hover') closeSpectatorList();
  });
  slot.append(btn, pop);
}

function renderRows(list, spectators, me, seatName) {
  const rows = [...list.children];
  spectators.forEach((s, i) => {
    let li = rows[i];
    if (!li) {
      li = el('li', {
        className: 'spectator-popover__row',
        children: [
          el('img', { className: 'spectator-popover__avatar', attrs: { alt: '' } }),
          el('span', { className: 'spectator-popover__name' }),
          // talking now: a green dot (the voice panel's), "(talking)" for screen readers
          el('span', { className: 'spectator-popover__talking' }),
          el('span', { className: 'spectator-popover__dot', attrs: { 'aria-hidden': 'true' } }),
        ],
      });
      list.appendChild(li);
    }
    const src = s.avatarUrl || (s.pic ? avatarSrc(s.pic) : CUSTOM_FALLBACK);
    applyAvatarImg(li.querySelector('img'), src, { fallback: CUSTOM_FALLBACK }); // not lazy: at most 50 small images, shown at once on open
    const name = s.username === me ? `${s.username} (you)` : s.username;
    // the over-the-shoulder view: whose hand this watcher looks at ("Zach · watching Alice")
    const player = s.shoulder && seatName ? seatName(s.shoulder) : null;
    li.querySelector('.spectator-popover__name').textContent = watcherRow(name, player);
    li.dataset.username = s.username;
    if (player) li.dataset.watching = String(s.shoulder);
    else delete li.dataset.watching;
  });
  for (const extra of rows.slice(spectators.length)) extra.remove();
}

/**
 * Show who is watching (idempotent).
 * @param {{spectators: Array<{username, pic, avatarUrl?}>, count: number}|null} watching
 * @param {Object} [opts]
 * @param {string|null} [opts.me] - my username (marked "(you)" in the list)
 * @param {Function} [opts.seatName] - (position) => that seat's player's name: a watcher's row
 *   says whose hand it watches (the over-the-shoulder view, spectator entries' `shoulder`)
 */
export function renderSpectatorBadge(watching, { me = null, seatName = null } = {}) {
  const count = Math.max(0, watching?.count || 0);
  const spectators = Array.isArray(watching?.spectators) ? watching.spectators : [];
  let slot = hudSpectatorSlot({ create: false });
  if (!slot && count === 0) return null;
  slot = slot || hudSpectatorSlot({ create: true });
  if (!slot) return null;
  if (!buttonOf(slot)) build(slot);
  const btn = buttonOf(slot);
  btn.querySelector('.spectator-badge__count').textContent = count > 99 ? '99+' : String(count);
  const pop = popoverOf(slot);
  renderRows(pop.querySelector('.spectator-popover__list'), spectators, me, seatName);
  const more = pop.querySelector('.spectator-popover__more');
  more.textContent = count > spectators.length ? `and ${count - spectators.length} more` : '';
  more.hidden = count <= spectators.length;
  slot.dataset.count = String(count);
  // A complete list: a speaking ring of someone no longer watching goes
  if (count <= spectators.length) {
    const names = new Set(spectators.map((s) => s?.username));
    for (const name of [...speaking]) if (!names.has(name)) speaking.delete(name);
  }
  applySpeaking(slot);
  if (count === 0) {
    if (isSpectatorListOpen()) closeSpectatorList();
    slot.hidden = true;
  } else {
    slot.hidden = false;
  }
  return slot;
}

/** Take the badge down (the table's teardown; clearHud removes the node too). */
export function removeSpectatorBadge() {
  removeDocListeners();
  openedBy = null;
  speaking.clear();
  unnamedSpeaking.clear();
  lastTalked.clear();
  hudSpectatorSlot({ create: false })?.remove();
}
