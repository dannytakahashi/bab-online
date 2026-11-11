/**
 * Who is watching (owner, 2026-11-11): a small eye + count in the table's
 * bottom-right corner (the layout's `spectators` rect: the HUD slot
 * .hud-spectators, placed by applyHudLayout's --spec-* variables), seen by
 * everyone at the table, players and spectators alike. Hidden at 0.
 *
 *   - a kit IconButton (44 px hit target), aria-label "2 people watching";
 *   - click / Enter / Space toggles a small popover listing the names with
 *     their avatars (avatarSrc / applyAvatarImg), scrolling past ~8 rows;
 *     hovering with a mouse opens it too, leaving closes a hover-opened one;
 *   - Escape (focus back on the button) or a click outside closes it;
 *   - its fade is the motion tokens' (--dur-fast; 0 ms under reduced
 *     motion, tokens.css; ui/motion.js is the JS side of the same rule).
 *
 * Data: GameState.watching through renderModel().watching (state is the one
 * writer: spectatorsUpdated and snapshot.watching). renderSpectatorBadge is
 * idempotent: renderTable calls it on every render, the spectatorsUpdated
 * handler on every list. The HUD's clearHud removes the node with the
 * table; removeSpectatorBadge also drops the document listeners.
 */

import { el, createIconButton } from '../kit/index.js';
import { avatarSrc, applyAvatarImg, CUSTOM_FALLBACK } from '../../utils/avatar.js';
import { hudSpectatorSlot } from '../tableHud.js';
import { prefersReducedMotion } from '../motion.js';

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

let docListeners = null;
let openedBy = null; // 'click' | 'hover' | null

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
  // the fade (CSS, --dur-fast); instant under reduced motion
  pop.classList.toggle('is-instant', prefersReducedMotion());
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
        if (e.key === 'Escape' && isSpectatorListOpen()) {
          e.stopPropagation();
          closeSpectatorList({ refocus: true });
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
  btn.setAttribute('aria-haspopup', 'true');
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
      el('ul', { className: 'spectator-popover__list', attrs: { 'aria-label': 'People watching' } }),
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

function renderRows(list, spectators, me) {
  const rows = [...list.children];
  spectators.forEach((s, i) => {
    let li = rows[i];
    if (!li) {
      li = el('li', {
        className: 'spectator-popover__row',
        children: [el('img', { className: 'spectator-popover__avatar', attrs: { alt: '' } }), el('span', { className: 'spectator-popover__name' })],
      });
      list.appendChild(li);
    }
    const src = s.avatarUrl || (s.pic ? avatarSrc(s.pic) : CUSTOM_FALLBACK);
    applyAvatarImg(li.querySelector('img'), src, { fallback: CUSTOM_FALLBACK }); // not lazy: at most 50 small images, shown at once on open
    li.querySelector('.spectator-popover__name').textContent = s.username === me ? `${s.username} (you)` : s.username;
    li.dataset.username = s.username;
  });
  for (const extra of rows.slice(spectators.length)) extra.remove();
}

/**
 * Show who is watching (idempotent).
 * @param {{spectators: Array<{username, pic, avatarUrl?}>, count: number}|null} watching
 * @param {Object} [opts]
 * @param {string|null} [opts.me] - my username (marked "(you)" in the list)
 */
export function renderSpectatorBadge(watching, { me = null } = {}) {
  const count = Math.max(0, watching?.count || 0);
  const spectators = Array.isArray(watching?.spectators) ? watching.spectators : [];
  let slot = hudSpectatorSlot({ create: false });
  if (!slot && count === 0) return null;
  slot = slot || hudSpectatorSlot({ create: true });
  if (!slot) return null;
  if (!buttonOf(slot)) build(slot);
  const btn = buttonOf(slot);
  const label = watchingLabel(count);
  btn.setAttribute('aria-label', label);
  btn.querySelector('.spectator-badge__count').textContent = count > 99 ? '99+' : String(count);
  const pop = popoverOf(slot);
  renderRows(pop.querySelector('.spectator-popover__list'), spectators, me);
  const more = pop.querySelector('.spectator-popover__more');
  more.textContent = count > spectators.length ? `and ${count - spectators.length} more` : '';
  more.hidden = count <= spectators.length;
  slot.dataset.count = String(count);
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
  hudSpectatorSlot({ create: false })?.remove();
}
