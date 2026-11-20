/**
 * The tutorial on the web (2026-11-19, the LEAN scope with the fade-out;
 * server side docs/claude/assist.md, The tutorial): the words and rules,
 * kept apart from the view (ui/components/AssistCard.js tips, the chip in
 * ui/components/TutorialChip.js) so they can be tested without a table.
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
 *    the card shows both: the tip above the advice.
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
export const TUTORIAL_OFF_COMMAND = '/tutorial off';
export const TUTORIAL_KEEP_COMMAND = '/tutorial keep';
export const TUTORIAL_CLOSE_COMMAND = '/tutorial close';

/** The chat autocomplete's line for /tutorial, off and on. */
export const TUTORIAL_ON_DESCRIPTION = 'Tutorial: tips and advice every turn';
export const TUTORIAL_OFF_DESCRIPTION = 'Turn off the tutorial';

/** The chip and its switch. */
export const CHIP_LABEL = 'Tutorial on';
export const CHIP_OFF_LABEL = 'Turn off the tutorial';

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
 * Is the chip up: the tutorial is on and I play my own seat at the table
 * (not a spectator, not while a bot plays it), past the draw.
 * @param {Object} gs - GameState
 */
export function chipVisible(gs) {
  if (!gs || !tutorialIsOn(gs.gameId || null)) return false;
  if (!gs.position || gs.isSpectator || gs.isLazy) return false;
  return gs.phase === 'bidding' || gs.phase === 'playing';
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

/** The local log row (never sent): "Tip: <text>". */
export function tipLogLine(hint) {
  return isTipHint(hint) ? `Tip: ${tipText(hint)}` : null;
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
