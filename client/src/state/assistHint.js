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
 *
 * Names only in every text (never team numbers, "your team", "opponents");
 * the hint's own texts come from the server, which lints them.
 */

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

// ------------------------------------------------------------ this game's uses

let uses = { gameId: null, known: false, uses: 0, freeUses: DEFAULT_FREE_USES, assisted: false };

const count = (v, d = 0) => (Number.isSafeInteger(v) && v >= 0 ? v : d);

/** A new game started (createUI): no /help used yet. */
export function resetAssistUses(gameId = null) {
  uses = { gameId: gameId || null, known: true, uses: 0, freeUses: DEFAULT_FREE_USES, assisted: false };
}

/** Forget the counts (left the table, tests): unknown until the next hint. */
export function forgetAssistUses() {
  uses = { gameId: null, known: false, uses: 0, freeUses: DEFAULT_FREE_USES, assisted: false };
}

/** A hint (or a snapshot's viewer.assist) arrived: its counts are this game's. */
export function noteAssistUses(hint, gameId = null) {
  if (!hint || typeof hint !== 'object') return;
  uses = {
    gameId: gameId || uses.gameId || null,
    known: true,
    uses: count(hint.uses),
    freeUses: count(hint.freeUses, DEFAULT_FREE_USES),
    assisted: hint.assisted === true,
  };
}

/**
 * This game's /help uses as known, or null when unknown (none seen since a
 * reload, or the counts are another game's).
 */
export function assistUses(gameId = null) {
  if (!uses.known) return null;
  if (gameId && uses.gameId && gameId !== uses.gameId) return null;
  return { uses: uses.uses, freeUses: uses.freeUses, assisted: uses.assisted };
}

/**
 * The /help line in the chat autocomplete, from this game's uses:
 *   "Suggest a move (1 of 3 free used)"
 *   "Suggest a move (the next one makes this game bot-assisted)"
 *   "Suggest a move (this game is bot-assisted for you)"
 *   "Suggest a move (after 3 free, this game counts as bot-assisted)"
 *        (unknown: no hint or snapshot with viewer.assist yet; the warning
 *        stays, since the uses so far may be spent)
 */
export function helpDescription(gameId = null) {
  const u = assistUses(gameId);
  if (!u) return `Suggest a move (after ${DEFAULT_FREE_USES} free, this game counts as bot-assisted)`;
  if (u.assisted || u.uses > u.freeUses) return 'Suggest a move (this game is bot-assisted for you)';
  if (u.uses >= u.freeUses) return 'Suggest a move (the next one makes this game bot-assisted)';
  return `Suggest a move (${u.uses} of ${u.freeUses} free used)`;
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
 * to suggest right now.": the log is still up); else null.
 * @param {{isAtTable: boolean, hasTable: boolean}} session
 */
export function assistHintRoute(session, hint) {
  if (!isAssistHint(hint) || !session) return null;
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
 *   "Only legal card · Not counted"            (forced: nothing to guess)
 *   "What our strongest bot would play · Asked again this turn: not counted"
 *   "Quick suggestion: rules only, the server is busy. · Help 1 of 3 free"
 * null for a status reply.
 */
export function assistFooter(hint) {
  if (!isAssistHint(hint) || hint.kind === 'status') return null;
  const free = count(hint.freeUses, DEFAULT_FREE_USES);
  const n = count(hint.uses);
  if (hint.confidence === 'only') return 'Not counted';
  const lead = hint.confidence === 'quick' ? FOOTER_QUICK : FOOTER_BOT;
  let tail;
  if (!hint.counted) tail = 'Asked again this turn: not counted';
  else if (n <= free) tail = `Help ${n} of ${free} free`;
  else tail = `Help ${n}: this game counts as bot-assisted for you`;
  return `${lead} · ${tail}`;
}

/** The dim local log row (never sent): "Help: Play 9♦ (only you see this)". */
export function assistLogLine(hint) {
  return isAssistHint(hint) ? `Help: ${hint.headline} (only you see this)` : null;
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
