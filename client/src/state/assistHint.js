/**
 * /help on the web (plan H3; server side docs/claude/assist.md): the words
 * and rules of the private assistHint, kept apart from the view
 * (ui/components/AssistCard.js) so they can be tested without a table.
 *
 *  - The clientHello cap `assist` (utils/avatar.js) makes the server answer
 *    this socket's /help with s2c assistHint instead of private plain-text
 *    game-log lines.
 *  - A hint is live while it is still my turn as it was answered:
 *    hintIsLive() checks the parts of its turnKey the client knows (stage,
 *    seat on turn, bids so far, cards played this hand; `${dealSeq}|
 *    ${stage}|${currentTurn}|${bidCount}|${cardIndex}`, server
 *    GameState.turnKey) against GameState. dealSeq is not compared: the
 *    client's count is its own (+1 per gameStart, null after a v1 rejoin),
 *    and a mismatch would drop every hint for the rest of the game. The
 *    scene clears the card on an updateTurn that ends it, on my own bid or
 *    card, at hand end, a redeal, game end and when a bot takes my seat.
 *  - The /help uses of this game (uses / freeUses / assisted) come from the
 *    latest hint or snapshot (viewer.assist, 2026-11-19: a seat owner's
 *    own count, state/tableSync.js) and reset when a game starts (createUI);
 *    so after a reload or a rejoin they are exact again. Unknown only before
 *    either arrives (or from a server without viewer.assist). The chat
 *    autocomplete describes /help from them (helpDescription).
 *  - A game with a native bot seat (owner 2026-11-19, "Unlimited, keep
 *    notice"; server assistState.isFreeHelpGame: a lobby's Add Bot, a
 *    tournament filler, a solo game; never a lazy or resign bot) has no
 *    /help limit, and players see nothing about free uses or limits (no
 *    count, never "free", "unlimited" or "bot-assisted"): the footer is just
 *    FOOTER_BOT and the chat line just HELP_LABEL. Known from the hint's
 *    `unlimited`, the snapshot's viewer.assist.unlimited, and before either
 *    from GameState.nativeBotSeat (positionUpdate.nativeBot, the snapshot's
 *    seats[].controller; never positionUpdate.isBot alone, which a
 *    draw-phase leaver's resign bot has too). Once the server has said (a
 *    hint, a snapshot's viewer.assist) its word wins over the table, as on
 *    iOS (helpIsUnlimited). The flag name is internal: never shown.
 *
 * Names only in every text (never team numbers, "your team", "opponents");
 * the hint's own texts come from the server, which lints them.
 */

import { isTipHint, tipLogLine } from './tutorial.js';

/** The clientHello cap that asks for assistHint. */
export const ASSIST_CAP = 'assist';

/** Free counted /help uses per game when no hint has said (server ASSIST_FREE_HELP). */
export const DEFAULT_FREE_USES = 3;

/** The confidence chip's words (server copy.js CONFIDENCE_LABEL). */
export const CONFIDENCE_LABEL = Object.freeze({
  only: 'Only legal card',
  certain: 'Sure thing',
  clear: 'Clear choice',
  close: 'Close call',
  any: 'Any card works',
  quick: 'Quick suggestion',
});

/** The footer's first part (copy.js FOOTER, without its second sentence). */
export const FOOTER_BOT = 'What our strongest bot would play';
/** A Quick suggestion's footer (copy.js QUICK_NOTE). */
export const FOOTER_QUICK = 'Quick suggestion: rules only, the server is busy.';

/** The plain words of the chat command (GameLog's autocomplete). */
export const HELP_COMMAND = '/help';
/**
 * What asking is called everywhere (the lightbulb button, the chat line; owner
 * 2026-11-19: the old label read as the player suggesting a move).
 */
export const HELP_LABEL = 'Ask a bot for advice';

// ------------------------------------------------------------ this game's uses

// told: the server sent these (a hint, a snapshot's viewer.assist), so their
// `unlimited` is its verdict; false for createUI's zero count
const blank = (gameId, known) => ({ gameId: gameId || null, known, told: false, uses: 0, freeUses: DEFAULT_FREE_USES, assisted: false, unlimited: false });
let uses = blank(null, false);

const count = (v, d = 0) => (Number.isSafeInteger(v) && v >= 0 ? v : d);

/** A new game started (createUI): no /help used yet. */
export function resetAssistUses(gameId = null) {
  uses = blank(gameId, true);
}

/** Forget the counts (left the table, tests): unknown until the next hint. */
export function forgetAssistUses() {
  uses = blank(null, false);
}

/**
 * A hint (or a snapshot's viewer.assist) arrived: its counts are this
 * game's. `unlimited` (a game with a native bot seat) stays once seen in
 * the same game (native bots never leave).
 */
export function noteAssistUses(hint, gameId = null) {
  if (!hint || typeof hint !== 'object') return;
  const id = gameId || uses.gameId || null;
  const sameGame = uses.known && (!id || !uses.gameId || id === uses.gameId);
  uses = {
    gameId: id,
    known: true,
    told: true,
    uses: count(hint.uses),
    freeUses: count(hint.freeUses, DEFAULT_FREE_USES),
    assisted: hint.assisted === true,
    unlimited: hint.unlimited === true || (sameGame && uses.unlimited),
  };
}

/**
 * This game's /help uses as known, or null when unknown (none seen since a
 * reload, or the counts are another game's).
 */
export function assistUses(gameId = null) {
  if (!uses.known) return null;
  if (gameId && uses.gameId && gameId !== uses.gameId) return null;
  return { uses: uses.uses, freeUses: uses.freeUses, assisted: uses.assisted, unlimited: uses.unlimited };
}

/**
 * Does this game have no /help limit to show (a native bot seat)? The
 * server's word wins, as on iOS (AssistRules.isFreeHelpGame / inFreeHelpGame):
 * a hint's own `unlimited` decides for that hint (its footer); else this
 * game's uses once the server has sent them (a hint's or a snapshot's
 * viewer.assist.unlimited); before that, the table itself
 * (GameState.nativeBotSeat: positionUpdate.nativeBot, snapshot
 * seats[].controller 'bot'; a lazy or resign bot never counts).
 * @param {Object} [state] - GameState
 * @param {Object} [hint] - an assistHint
 */
export function helpIsUnlimited(state = null, hint = null) {
  if (hint && typeof hint === 'object') return hint.unlimited === true;
  if (assistUses(state?.gameId || null) && uses.told) return uses.unlimited === true;
  return state?.nativeBotSeat === true;
}

/**
 * The /help line in the chat autocomplete, from this game's uses:
 *   "Ask a bot for advice (1 of 3 free used)"
 *   "Ask a bot for advice (the next one makes this game bot-assisted)"
 *   "Ask a bot for advice (this game is bot-assisted for you)"
 *   "Ask a bot for advice (after 3 free, this game counts as bot-assisted)"
 *        (unknown: no hint or snapshot with viewer.assist yet; the warning
 *        stays, since the uses so far may be spent)
 *   "Ask a bot for advice"   (a game with a native bot seat: `unlimited`,
 *        helpIsUnlimited, or this game's uses say so; or the tutorial is
 *        on, which /help is never counted under: then "(this game is
 *        bot-assisted for you)" only once the server says it is)
 * @param {string} [gameId]
 * @param {Object} [o]
 * @param {boolean} [o.unlimited] - the table has a native bot seat
 * @param {boolean} [o.tutorial] - my tutorial is on (state/tutorial.js)
 */
export function helpDescription(gameId = null, { unlimited = false, tutorial = false } = {}) {
  const u = assistUses(gameId);
  if (unlimited || u?.unlimited) return HELP_LABEL;
  // the tutorial on: /help is never counted (only the bot-assisted it made)
  if (tutorial) return u?.assisted ? `${HELP_LABEL} (this game is bot-assisted for you)` : HELP_LABEL;
  if (!u) return `${HELP_LABEL} (after ${DEFAULT_FREE_USES} free, this game counts as bot-assisted)`;
  if (u.assisted || u.uses > u.freeUses) return `${HELP_LABEL} (this game is bot-assisted for you)`;
  if (u.uses >= u.freeUses) return `${HELP_LABEL} (the next one makes this game bot-assisted)`;
  return `${HELP_LABEL} (${u.uses} of ${u.freeUses} free used)`;
}

// ------------------------------------------------------------ the hint

/** The parts of a turnKey, or null. */
export function parseTurnKey(key) {
  if (typeof key !== 'string') return null;
  const p = key.split('|');
  if (p.length !== 5) return null;
  return { dealSeq: p[0], stage: p[1], currentTurn: Number(p[2]), bidCount: Number(p[3]), cardIndex: Number(p[4]) };
}

/** Is `hint` a hint this client can show (v 1, a known kind)? */
export function isAssistHint(hint) {
  return !!hint && typeof hint === 'object' && hint.v === 1 &&
    ['bid', 'card', 'status'].includes(hint.kind) && typeof hint.headline === 'string' && hint.headline.length > 0;
}

/**
 * Cards played so far this hand as the server counts them (turnKey's
 * cardIndex), or null when the client cannot tell (no trick number yet).
 */
export function clientCardIndex(state) {
  const t = state?.trickNo;
  if (!Number.isSafeInteger(t) || t < 1) return null;
  const inTrick = Array.isArray(state.playedCards) ? state.playedCards.length : 0;
  return (t - 1) * 4 + inTrick;
}

/** Does my seat act now (a player at the table, not a bot playing it)? */
function seated(state) {
  return !!state && !!state.position && !state.isSpectator && !state.isLazy;
}

/**
 * Is a bid or card hint still my turn's? A status reply always shows (the
 * next updateTurn clears it like any hint): a spectator's or a lazy
 * seat's included ("A bot is playing your seat. Type /active first.").
 * @param {Object} hint - assistHint
 * @param {Object} state - GameState
 * @param {Object} [o]
 * @param {boolean} [o.pending] - my bid or card is on its way (MyAction)
 */
export function hintIsLive(hint, state, { pending = false } = {}) {
  if (!isAssistHint(hint) || !state) return false;
  // a status reply (off turn, a refusal, "players only") is for whoever asked
  if (hint.kind === 'status') return true;
  if (!seated(state)) return false;
  if (pending || state.currentTurn !== state.position) return false;
  const k = parseTurnKey(hint.turnKey);
  if (k && k.currentTurn !== state.position) return false;
  if (hint.kind === 'bid') {
    if (!state.isBidding) return false;
    if (state.bids?.[state.position] !== undefined) return false;
    if (k && (k.stage !== 'BIDDING' || k.bidCount !== Object.keys(state.bids || {}).length)) return false;
    return true;
  }
  // a card
  if (state.isBidding || state.hasPlayedCard) return false;
  if (k && k.stage !== 'PLAYING') return false;
  // a later trick's turn of mine (the scene lagging behind the state)
  const at = clientCardIndex(state);
  if (k && at !== null && Number.isSafeInteger(k.cardIndex) && k.cardIndex !== at) return false;
  return true;
}

/** The private row for a bid or card answer that came after its turn had passed. */
export const ASSIST_LATE_LINE = 'Help: that turn had passed before the answer came (only you see this)';

/**
 * Where an assistHint goes (main.js): 'scene' at the table (the card, in
 * table order); 'row' on the game-end screen for a status reply ("Nothing
 * to suggest right now.": the log is still up) or a tutorial tip ("Tip:
 * ..."); else null.
 * @param {{isAtTable: boolean, hasTable: boolean}} session
 */
export function assistHintRoute(session, hint) {
  if (!session) return null;
  // a rule tip (the tutorial): the card at the table, else its row
  if (isTipHint(hint)) return session.isAtTable ? 'scene' : (session.hasTable ? 'row' : null);
  if (!isAssistHint(hint)) return null;
  if (session.isAtTable) return 'scene';
  if (session.hasTable && hint.kind === 'status') return 'row';
  return null;
}

/** The suggested bid ('4', 'B'), or null. */
export function suggestedBid(hint) {
  const b = hint?.kind === 'bid' ? hint.suggest?.bid : null;
  return typeof b === 'string' && b ? b.toUpperCase() : null;
}

/** The suggested card ({suit, rank}), or null. */
export function suggestedCard(hint) {
  const c = hint?.kind === 'card' ? hint.suggest?.card : null;
  return c && typeof c.suit === 'string' && c.rank !== undefined && c.rank !== null ? { suit: c.suit, rank: c.rank } : null;
}

/** The confidence chip's words, or null. */
export function confidenceLabel(hint) {
  return CONFIDENCE_LABEL[hint?.confidence] || null;
}

/**
 * The card's footer: what the suggestion is and the use count.
 *   "What our strongest bot would play · Help 2 of 3 free"
 *   "What our strongest bot would play · Help 4: this game counts as bot-assisted for you"
 *   "Not counted"                              (forced: nothing to guess)
 *   "What our strongest bot would play · Asked again this turn: not counted"
 *   "Quick suggestion: rules only, the server is busy. · Help 1 of 3 free"
 * In a game with a native bot seat (hint.unlimited, or `o.unlimited` from
 * helpIsUnlimited) no count and no "not counted": just "What our strongest
 * bot would play" (a forced move and a re-ask too), or the Quick note alone.
 * The same for the tutorial's advice (source tutorial: never counted) and
 * for /help asked while the tutorial is on (`o.tutorial`: not counted).
 * null for a status reply.
 * @param {Object} hint
 * @param {Object} [o]
 * @param {boolean} [o.unlimited]
 * @param {boolean} [o.tutorial] - my tutorial is on
 */
export function assistFooter(hint, { unlimited = false, tutorial = false } = {}) {
  if (!isAssistHint(hint) || hint.kind === 'status') return null;
  const lead = hint.confidence === 'quick' ? FOOTER_QUICK : FOOTER_BOT;
  if (unlimited || hint.unlimited === true) return lead;
  if (hint.source === 'tutorial' || (tutorial && !hint.counted)) return lead;
  const free = count(hint.freeUses, DEFAULT_FREE_USES);
  const n = count(hint.uses);
  if (hint.confidence === 'only') return 'Not counted';
  let tail;
  if (!hint.counted) tail = 'Asked again this turn: not counted';
  else if (n <= free) tail = `Help ${n} of ${free} free`;
  else tail = `Help ${n}: this game counts as bot-assisted for you`;
  return `${lead} · ${tail}`;
}

/**
 * The dim local log row (never sent): "Help: Play 9♦ (only you see this)".
 * None for the tutorial's advice (it comes on every decision; its tips
 * have their own rows, state/tutorial.js tipLogLine).
 */
export function assistLogLine(hint) {
  if (isTipHint(hint)) return tipLogLine(hint);
  if (!isAssistHint(hint) || (hint.source === 'tutorial' && hint.kind !== 'status')) return null;
  return `Help: ${hint.headline} (only you see this)`;
}

/**
 * What the screen reader hears: the headline and the main reason (the
 * last one: the first is the contract line when there are two, as the
 * server's plain-text line chooses), and the note.
 */
export function assistAnnouncement(hint) {
  if (!isAssistHint(hint)) return '';
  const end = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
  const parts = [hint.kind === 'status' ? end(hint.headline) : `Suggestion: ${end(hint.headline)}`];
  const main = Array.isArray(hint.reasons) ? hint.reasons[hint.reasons.length - 1] : null;
  if (hint.kind !== 'status' && main) parts.push(end(main));
  if (hint.note) parts.push(end(hint.note));
  return parts.join(' ');
}
