/**
 * The tutorial on the web (2026-11-19, the LEAN scope with the fade-out;
 * server side docs/claude/assist.md, The tutorial): the words and rules,
 * kept apart from the view (ui/components/AssistCard.js tips, the Tutorial
 * button in my seat's row, ui/components/TutorialButton.js) so they can be
 * tested without a table.
 *
 *  - The clientHello cap `tutorial` (utils/avatar.js) tells the server this
 *    page can draw tips and their actions: only such a socket gets rule tips
 *    as s2c assistHint {source 'tutorial', kind 'tip'}, the s2c assistState,
 *    and the auto-start in a new account's first game.
 *  - While the tutorial is on, the server pushes the /help answer on each
 *    of my non-forced decisions (assistHint source 'tutorial', kind bid /
 *    card: the same card, rings and announcer as /help; never counted) and
 *    rule tips (kind tip: headline = the tip's title, reasons = [its text],
 *    tipId). A tip and the advice of the same decision arrive tip first, so
 *    the card shows both: the tip above the advice. One tip card at a time
 *    (shownTip): the welcome first, then the newest rule tip; every tip
 *    leaves its private row "Tutorial: <text>" (only a log's first such row
 *    ends " (only you see this)": tutorialFeedRow), and the
 *    announcer says only the tip shown (one kept behind the welcome when it
 *    comes into view).
 *  - T.welcome carries actions ['keep', 'off']: Keep sends `/tutorial keep`
 *    (an acknowledgement: the account stays as it is), Turn off `/tutorial
 *    off`, its ✕ `/tutorial close` (the server marks an auto-started
 *    account dismissed for those two, plan 5.2; the tutorial stays on
 *    after a close).
 *  - Whether it is on: s2c assistState {tutorial, auto, ...} on every change
 *    and after a rejoin, and a snapshot's viewer.assist.tutorial / .auto
 *    (present only while on) after a reload. Reset when a game starts
 *    (createUI comes before the auto-start's assistState) and forgotten
 *    with the table.
 *  - Commands are chat lines (chatMessage); there is no new c2s event.
 *
 * Names only in every text (never team numbers, "your team", "opponents");
 * the tips' own texts come from the server, which lints them.
 */

/** The clientHello cap that asks for tips, assistState and the auto-start. */
export const TUTORIAL_CAP = 'tutorial';

/** The chat command (toggles); `/tutorial on|off` set it; keep / close answer the welcome tip. */
export const TUTORIAL_COMMAND = '/tutorial';
export const TUTORIAL_ON_COMMAND = '/tutorial on';
export const TUTORIAL_OFF_COMMAND = '/tutorial off';
export const TUTORIAL_KEEP_COMMAND = '/tutorial keep';
export const TUTORIAL_CLOSE_COMMAND = '/tutorial close';

/** The chat autocomplete's line for /tutorial, off and on. */
export const TUTORIAL_ON_DESCRIPTION = 'Tutorial: tips and advice every turn';
export const TUTORIAL_OFF_DESCRIPTION = 'Turn off the tutorial';

/**
 * The Tutorial button in my seat's row (owner 2026-11-21: "the old people struggle
 * with slash commands"; ui/components/TutorialButton.js): iOS's round corner
 * button, the graduation cap alone (aria-label "Tutorial", aria-pressed the
 * state), its tooltip iOS's label ("Tutorial on" / "Tutorial off") and hint.
 * Off -> on asks first where it makes this game bot-assisted for me (the
 * confirm, iOS's TutorialRules.confirm* words exactly;
 * assistHint.tutorialNeedsConfirm).
 */
export const BUTTON_LABEL = 'Tutorial';
export const BUTTON_ON_TEXT = 'Tutorial on';
export const BUTTON_OFF_TEXT = 'Tutorial off';
export const BUTTON_ON_HINT = "Turns off the tutorial's tips and advice. /help still works any time.";
export const BUTTON_OFF_HINT = 'Turns on tips and advice for every turn.';
export const CONFIRM_TITLE = 'Turn on the tutorial?';
export const CONFIRM_MESSAGE = "You'll get tips and advice on every turn. This game will count as bot-assisted for you: it goes in your bot-game stats, not the human leaderboard.";
export const CONFIRM_BUTTON = 'Turn on';
export const CONFIRM_CANCEL = 'Cancel';

/** The welcome tip's id (its Keep / Turn off). */
export const WELCOME_TIP = 'T.welcome';
/** The game-end tip: a log row only (the game-end screen comes right after it). */
export const DONE_TIP = 'T.done';

/** The welcome tip's buttons, by action. */
export const TIP_ACTION_LABEL = Object.freeze({ keep: 'Keep', off: 'Turn off' });

// ------------------------------------------------------------ on or off

const blank = (gameId = null) => ({ gameId, on: false, auto: false });
let state = blank();

/** A new game started (createUI): off until the server says otherwise. */
export function resetTutorial(gameId = null) {
  state = blank(gameId);
}

/** Left the table (or tests): off. */
export function forgetTutorial() {
  state = blank();
  resetTutorialRows();
}

/**
 * The server said (assistState, or a snapshot's viewer.assist: its
 * `tutorial` / `auto` are there only while on).
 * @param {Object} payload
 * @param {string} [gameId]
 */
export function noteTutorialState(payload, gameId = null) {
  if (!payload || typeof payload !== 'object') return;
  const on = payload.tutorial === true;
  state = { gameId: gameId || state.gameId || null, on, auto: on && payload.auto === true };
}

/** Is the tutorial on for me in this game? */
export function tutorialIsOn(gameId = null) {
  if (!state.on) return false;
  return !(gameId && state.gameId && gameId !== state.gameId);
}

/** Was it turned on by the auto-start (a new account's first game)? */
export function tutorialIsAuto(gameId = null) {
  return tutorialIsOn(gameId) && state.auto;
}

/** The /tutorial line in the chat autocomplete. */
export function tutorialDescription(gameId = null) {
  return tutorialIsOn(gameId) ? TUTORIAL_OFF_DESCRIPTION : TUTORIAL_ON_DESCRIPTION;
}

/**
 * Is the Tutorial button up: I play my own seat at the table
 * (not a spectator, not while a bot plays it), with the tutorial on or off,
 * for the whole game (the draw included, where it is disabled:
 * tutorialButtonDisabled); never on the game-end screen.
 * @param {Object} gs - GameState
 */
export function tutorialButtonVisible(gs) {
  if (!gs || !gs.position || gs.isSpectator || gs.isLazy) return false;
  return gs.phase === 'draw' || gs.phase === 'bidding' || gs.phase === 'playing';
}

/**
 * Is the button disabled: during the draw (the server answers "The tutorial
 * can be turned on once the game starts."), or while a /tutorial line it sent
 * waits for the server's assistState.
 * @param {Object} gs - GameState
 * @param {Object} [o]
 * @param {boolean} [o.pending] - an on or off was sent and not answered yet
 */
export function tutorialButtonDisabled(gs, { pending = false } = {}) {
  return !!pending || gs?.phase === 'draw';
}

// ------------------------------------------------------------ tips

/** Is `hint` a rule tip this page can show (assistHint source tutorial, kind tip)? */
export function isTipHint(hint) {
  return !!hint && typeof hint === 'object' && hint.v === 1 && hint.source === 'tutorial' && hint.kind === 'tip' &&
    typeof hint.headline === 'string' && hint.headline.length > 0 &&
    Array.isArray(hint.reasons) && typeof hint.reasons[0] === 'string' && hint.reasons[0].length > 0;
}

/** The tip's text (its one reason). */
export function tipText(hint) {
  return isTipHint(hint) ? hint.reasons[0] : '';
}

/** The welcome tip (it has the Keep / Turn off buttons)? */
export function isWelcomeTip(hint) {
  return isTipHint(hint) && (hint.tipId === WELCOME_TIP || tipActions(hint).length > 0);
}

/** The tip's buttons this page knows ('keep', 'off'), in order, once each. */
export function tipActions(hint) {
  const a = Array.isArray(hint?.actions) ? hint.actions : [];
  return ['keep', 'off'].filter((x) => a.includes(x));
}

/** The chat line an action sends. */
export function tipActionCommand(action) {
  if (action === 'off') return TUTORIAL_OFF_COMMAND;
  if (action === 'keep') return TUTORIAL_KEEP_COMMAND;
  return null;
}

/** The private log rows' label for what the tutorial says (its tips and status replies; /help's keep "Help"). */
export const TUTORIAL_ROW_LABEL = 'Tutorial';

/**
 * The local log row (never sent): "Tutorial: <text> (only you see this)"
 * (the page's feed keeps the note on a log's first tutorial row only:
 * tutorialFeedRow). Every tip gets one, shown as a card or not (one tip
 * card at a time).
 */
export function tipLogLine(hint) {
  return isTipHint(hint) ? `${TUTORIAL_ROW_LABEL}: ${tipText(hint)} (only you see this)` : null;
}

/** The note on a private row's end ("/help"'s always; the tutorial's on a log's first row only). */
export const PRIVATE_ROW_NOTE = ' (only you see this)';

// Has this log shown a tutorial row yet (the page's one log at the table)
let tutorialRowNoted = false;

/** A new log at the table (main.js showGameLog), or left the table: its first tutorial row has the note again. */
export function resetTutorialRows() {
  tutorialRowNoted = false;
}

/**
 * A private row as the page's log writes it (main.js addPrivateToGameFeed;
 * call it only for a row that is written): the first "Tutorial: ..." row of
 * a log keeps " (only you see this)", later ones are just "Tutorial: <text>"
 * (owner 2026-11-19: once is enough). /help's "Help: ..." rows are as built.
 * @param {string} line
 */
export function tutorialFeedRow(line) {
  if (typeof line !== 'string' || !line.startsWith(`${TUTORIAL_ROW_LABEL}: `)) return line;
  if (!tutorialRowNoted) {
    tutorialRowNoted = true;
    return line;
  }
  return line.endsWith(PRIVATE_ROW_NOTE) ? line.slice(0, -PRIVATE_ROW_NOTE.length) : line;
}

/**
 * ONE TIP CARD AT A TIME (lead 2026-11-19: the welcome, a rule tip and the
 * advice stacked over the partner's seat): of the tips up, the one shown.
 * The welcome has priority while it is up (until Keep, ✕ or Turn off); after
 * it, the newest rule tip (a newer one replaces an older). A rule tip that
 * came behind the welcome shows once the welcome goes, if my bid or card
 * has not ended it. Null when none.
 * @param {Object[]} tips - assistHint tips, oldest first
 * @returns {Object|null}
 */
export function shownTip(tips) {
  const list = (Array.isArray(tips) ? tips : []).filter(isTipHint);
  return list.find(isWelcomeTip) || list[list.length - 1] || null;
}

/** What the screen reader hears, once per tip: "Tip: Trump. <text>". */
export function tipAnnouncement(hint) {
  if (!isTipHint(hint)) return '';
  const end = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
  return `Tip: ${end(hint.headline)} ${end(tipText(hint))}`;
}

/** Is it a tip that is only a log row (the game-end one)? */
export function isRowOnlyTip(hint) {
  return isTipHint(hint) && hint.tipId === DONE_TIP;
}
