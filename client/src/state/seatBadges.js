/**
 * The avatar badges (owner 2026-11-23: "a little light bulb indicator on
 * the player avatar when they use help ... Would be nice for people that
 * don't look at the running log", "Same for grad cap"; server and wire:
 * docs/claude/assist.md, Avatar badges).
 *
 * GameState keeps, per seat, whether it asked for /help on its open turn
 * (`helpAsked`) and whether its owner has the tutorial on
 * (`tutorialSeats`); ui/seatPlates.js draws one badge per avatar from them:
 *   - the lightbulb: from the live help notice (gameLogEntry help
 *     {position}) until that seat bids or plays, the turn moves to another
 *     seat, the bidding or the hand ends, a new deal, the game's end, or the
 *     seat goes lazy or is replaced; a snapshot sets it from
 *     seats[].askedHelp instead;
 *   - the graduation cap: from the tutorial's live tag (gameLogEntry
 *     tutorial {position, on}); the stored / snapshot log lines carry the
 *     tag too, but a replay only draws its row in the cap's green and never
 *     toggles the cap: a snapshot sets it from seats[].tutorial (absent =
 *     off);
 *   - one badge per seat, the cap when both are known (a tutorial's /help
 *     is never counted, so in practice a seat never has both);
 *   - never on the viewer's own seat (a seat holder or a lazy watcher); a
 *     pure spectator sees every seat's, a watcher (the over-the-shoulder
 *     view) the watched seat's too, on its box.
 * Only the live notice, or the live tag turning the cap on, pops the badge
 * (GameScene.updateSeatBadges; iOS the same); a snapshot (rejoin, spectate,
 * resync) draws it still.
 */

const isSeat = (p) => p === 1 || p === 2 || p === 3 || p === 4;

/** The badge kinds (ui/seatPlates.js: data-badge on the ring's chip). */
export const BADGE = Object.freeze({ HELP: 'help', TUTORIAL: 'tutorial' });

/** The help notice's seat (gameLogEntry `help {position}`), or null. */
export function helpNoticeSeat(data) {
  const p = data && typeof data === 'object' ? data.help?.position : null;
  return isSeat(p) ? p : null;
}

/** The tutorial's live tag (gameLogEntry `tutorial {position, on}`) as {position, on}, or null. */
export function tutorialTag(data) {
  const t = data && typeof data === 'object' ? data.tutorial : null;
  if (!t || typeof t !== 'object' || !isSeat(t.position) || typeof t.on !== 'boolean') return null;
  return { position: t.position, on: t.on };
}

/** Is `pos` the viewer's own seat (a seat holder or a lazy watcher; never a spectator's)? */
export function isOwnSeat(s, pos) {
  return !!s && !s.isSpectator && !!s.position && pos === s.position;
}

/**
 * The badge seat `pos` shows to this viewer: 'tutorial', 'help' or null.
 * @param {Object} s - GameState (helpAsked, tutorialSeats, isSpectator, position)
 * @param {number} pos
 */
export function seatBadgeOf(s, pos) {
  if (!s || !isSeat(pos) || isOwnSeat(s, pos)) return null;
  if (s.tutorialSeats?.[pos] === true) return BADGE.TUTORIAL;
  if (s.helpAsked?.[pos] === true) return BADGE.HELP;
  return null;
}

/** The badge's words (its title and accessible name), after the seat's name. */
export function seatBadgeLabel(kind, name) {
  const who = name || 'This player';
  if (kind === BADGE.TUTORIAL) return `${who}, tutorial on`;
  if (kind === BADGE.HELP) return `${who}, asked for help this turn`;
  return '';
}
