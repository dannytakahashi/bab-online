/**
 * The Tournaments section of a profile (owner 2026-11-25: tournament
 * history visible on profiles in this release): tournaments finished and
 * won, Cut for a buck wins out of cuts played, and the last few results,
 * newest first. Reads the profile reply's additive `tournaments {played,
 * won, recent}` and `cutForABuck {wins, played}` (server
 * profileHandlers.tournamentProfile, contract $defs.profileTournaments /
 * tournamentResult); the same in every stats scope, so a scope switch
 * never redraws it. Nothing at all for a player with no finished
 * tournament (or a server without the fields). User text (tournament and
 * player names) only as text. People are named, never numbered.
 */

import { el } from '../kit/index.js';

export const TOURNAMENT_HISTORY_COPY = Object.freeze({
  title: 'Tournaments',
  played: 'Played',
  won: 'Won',
  cut: 'Cut for a buck',
  recent: 'Recent results',
  wonCut: 'Won cut for a buck',
  cutBy: (name) => `Cut for a buck: ${name}`,
});

const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function ordinal(k) {
  const tens = k % 100;
  if (tens >= 11 && tens <= 13) return `${k}th`;
  return `${k}${{ 1: 'st', 2: 'nd', 3: 'rd' }[k % 10] || 'th'}`;
}

function when(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** How the player did: "Won", "Won (tied)", "2nd of 6", or "Finished". */
export function resultLabel(r) {
  const of = n(r.players) > 0 ? ` of ${n(r.players)}` : '';
  if (r.won) return (Array.isArray(r.winners) && r.winners.length > 1) ? 'Won (tied)' : 'Won';
  if (Number.isInteger(r.place) && r.place >= 1) return `${ordinal(r.place)}${of}`;
  return 'Finished';
}

function resultItem(r, username) {
  const meta = [when(r.completedAt), n(r.players) ? `${n(r.players)} players` : '', n(r.totalRounds) ? `${n(r.totalRounds)} ${n(r.totalRounds) === 1 ? 'round' : 'rounds'}` : '']
    .filter(Boolean).join(' · ');
  const lines = [
    el('div', {
      className: 'tournament-history__row',
      children: [
        el('span', { className: 'tournament-history__name', text: r.name || 'Tournament' }),
        el('span', { className: `tournament-history__result${r.won ? ' is-win' : ''}`, text: resultLabel(r) }),
      ],
    }),
    meta ? el('div', { className: 'tournament-history__meta', text: meta }) : null,
  ];
  if (typeof r.cutWinner === 'string' && r.cutWinner) {
    const mine = r.cutWinner === username;
    lines.push(el('div', {
      className: `tournament-history__cut${mine ? ' is-win' : ''}`,
      text: mine ? TOURNAMENT_HISTORY_COPY.wonCut : TOURNAMENT_HISTORY_COPY.cutBy(r.cutWinner),
    }));
  }
  return el('li', { className: 'tournament-history__item', children: lines });
}

function stat(label, value) {
  return el('div', {
    className: 'stat',
    children: [el('div', { className: 'stat__value', text: value }), el('div', { className: 'stat__label', text: label })],
  });
}

/**
 * @param {Object} profile - the profile reply's `profile`
 * @param {string} regionId - id of the section (own / other profile)
 * @returns {{nodes: HTMLElement[]}} empty when there is nothing to show
 */
export function createTournamentHistorySection(profile, regionId) {
  const t = profile?.tournaments;
  const cut = profile?.cutForABuck;
  const played = n(t?.played);
  const cutPlayed = n(cut?.played);
  if (played === 0 && cutPlayed === 0) return { nodes: [] };
  const C = TOURNAMENT_HISTORY_COPY;
  const headingId = `${regionId}Title`;
  const stats = [stat(C.played, String(played)), stat(C.won, String(n(t?.won)))];
  // "2 of 5": Cut for a buck wins out of the cuts played (only once one was played)
  if (cutPlayed > 0) stats.push(stat(C.cut, `${n(cut?.wins)} of ${cutPlayed}`));
  const children = [
    el('h3', { className: 'section-title', text: C.title, attrs: { id: headingId } }),
    el('div', { className: 'stats-grid tournament-history__stats', children: stats }),
  ];
  const recent = Array.isArray(t?.recent) ? t.recent.filter((r) => r && typeof r === 'object') : [];
  if (recent.length > 0) {
    const listId = `${regionId}Recent`;
    children.push(
      el('h4', { className: 'tournament-history__subtitle', text: C.recent, attrs: { id: listId } }),
      el('ol', {
        className: 'tournament-history__list',
        attrs: { 'aria-labelledby': listId },
        children: recent.map((r) => resultItem(r, profile.username)),
      }),
    );
  }
  const section = el('section', {
    className: 'tournament-history',
    attrs: { id: regionId, 'aria-labelledby': headingId },
    children,
  });
  return { nodes: [section] };
}
