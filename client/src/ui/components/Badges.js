/**
 * Badges (achievements; owner 2026-11-24 / 25): the "Badges" section of a
 * profile and the words of the "badge earned" toast.
 *
 * The client holds NO catalog: it only ever draws the badges the server
 * sent for a player who earned them (profileResponse / playerProfileResponse
 * `badges`, s2c badgesAwarded; cap `badges`), so a badge nobody has shown
 * you stays a surprise. Each entry is {id, name, description, at?}; the art
 * is the static file assets/badges/<id>.svg (scripts/build-badges.py). An
 * id this bundle has no art for (a badge added on the server later) shows
 * its name and description without a picture.
 */

import { el } from '../kit/index.js';

/** The client capability that asks the server for badges (utils/avatar.js clientHello). */
export const BADGES_CAP = 'badges';

/** A badge id is a file name: lower-case words joined by hyphens. */
const BADGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function badgeArtSrc(id) {
  return `assets/badges/${id}.svg`;
}

/** The entries worth drawing: a file-safe id and a name, each id once. */
export function cleanBadges(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const b of list) {
    if (!b || typeof b.id !== 'string' || b.id.length > 40 || !BADGE_ID.test(b.id)) continue;
    if (typeof b.name !== 'string' || !b.name || seen.has(b.id)) continue;
    seen.add(b.id);
    out.push({ id: b.id, name: b.name, description: typeof b.description === 'string' ? b.description : '' });
  }
  return out;
}

function createBadgeItem(badge) {
  const art = el('img', {
    className: 'badge-item__art',
    attrs: { src: badgeArtSrc(badge.id), alt: '', width: 64, height: 64, loading: 'lazy', decoding: 'async' },
  });
  // No art in this bundle for the id: the words stand alone
  art.addEventListener('error', () => { art.hidden = true; }, { once: true });
  return el('li', {
    className: 'badge-item',
    dataset: { badge: badge.id },
    children: [
      art,
      el('div', { className: 'badge-item__name', text: badge.name }),
      badge.description ? el('div', { className: 'badge-item__desc', text: badge.description }) : null,
    ],
  });
}

/**
 * The profile's Badges section: a heading and the earned badges (or a
 * short note when there are none yet). Goes below the statistics.
 *
 * @param {Array} badges - the server's earned badges for this player
 * @param {string} regionId
 * @returns {{nodes: HTMLElement[], update(badges: Array): void}}
 */
export function createBadgesSection(badges, regionId) {
  const region = el('div', { className: 'badges-region', attrs: { id: regionId } });
  const fill = (list) => {
    const clean = cleanBadges(list);
    if (clean.length === 0) {
      region.replaceChildren(el('p', { className: 'scope-note', text: 'No badges yet.' }));
      return;
    }
    region.replaceChildren(el('ul', { className: 'badges-grid', children: clean.map(createBadgeItem) }));
  };
  fill(badges);
  return {
    nodes: [el('h3', { className: 'section-title badges-title', text: 'Badges' }), region],
    update: fill,
  };
}

/** The pictures of badges just earned, for their toast (ui/kit/toast.js `art`). */
export function badgesEarnedArt(badges) {
  return cleanBadges(badges).map((b) => badgeArtSrc(b.id));
}

/** The toast for badges just earned: "Badge earned: <name>" / "Badges earned: <name>, <name>". */
export function badgesEarnedText(badges) {
  const names = cleanBadges(badges).map((b) => b.name);
  if (names.length === 0) return '';
  return `${names.length === 1 ? 'Badge earned' : 'Badges earned'}: ${names.join(', ')}`;
}
