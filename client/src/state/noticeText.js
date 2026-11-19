/**
 * Words of the table's "you can't do that right now" notices, shared so the
 * card, the bid sheet and the keyboard hand say the same thing (the same
 * words as iOS TableRenderModel.illegalReason).
 */
export const NOTICE = Object.freeze({
  NOT_YOUR_TURN: 'Not your turn.',
  BID_FIRST: 'Bid first.',
  CARD_ON_ITS_WAY: 'Your card is on its way.',
  TRICK_CLEARING: 'Wait for the trick to clear.',
  BOT_PLAYING: 'A bot is playing your seat.',
  // a bid or a card while the socket is down (MyAction's refusal and the
  // card click's own check agree)
  RECONNECTING: 'Reconnecting. Try again in a moment.',
});

/**
 * The text for a serverError the player should see, with its severity
 * (owner 2026-11-19): amber `warning` for a refusal ("Lobby is full", rate
 * limit, a rejected input), teal `info` for information sent as a refusal
 * (the table is full in a bigger lobby: you watch this game), red `error`
 * only for a real failure (the server failed, sign in again).
 *
 * Joi's validation text is never shown (it is developer text):
 * chat → too long; anything else → "That wasn't accepted".
 */
export const SERVER_TEXT = Object.freeze({
  FALLBACK: 'Something went wrong. Try again.',
  RATE_LIMIT: 'Too many requests. Please slow down.',
  SIGN_IN_AGAIN: 'Please sign in again',
  CHAT_TOO_LONG: 'That message is too long (500 characters max).',
  NOT_ACCEPTED: "That wasn't accepted. Try again.",
});

/** Refusals that are information, per handler (the server's exact text). */
export const INFO_REJECTIONS = Object.freeze({
  playerReady: Object.freeze(["The table is full — you'll watch this game"]),
});

/** The c2s chat events (their validation failure is the 500-character limit). */
const CHAT_HANDLERS = new Set(['chatMessage', 'lobbyChat', 'mainRoomChat', 'tournamentChat']);

/**
 * @param {{type?: string, message?: string, handler?: string|null}} failure - failureOf(serverError)
 * @returns {{ message: string, type: 'info'|'warning'|'error' }}
 */
export function serverErrorNotice(failure) {
  const f = failure || {};
  switch (f.type) {
    case 'VALIDATION_ERROR':
    case 'validation':
      return { message: CHAT_HANDLERS.has(f.handler) ? SERVER_TEXT.CHAT_TOO_LONG : SERVER_TEXT.NOT_ACCEPTED, type: 'warning' };
    case 'AUTH_ERROR':
      return { message: SERVER_TEXT.SIGN_IN_AGAIN, type: 'error' };
    case 'RATE_LIMIT_ERROR':
    case 'rateLimit':
      return { message: SERVER_TEXT.RATE_LIMIT, type: 'warning' };
    case 'server':
      return { message: SERVER_TEXT.FALLBACK, type: 'error' };
    default: {
      // Most refusals are untyped ({ message: 'Lobby is full' }, code
      // 'rejected') and their text is meant for the player
      if (!f.message) return { message: SERVER_TEXT.FALLBACK, type: 'error' };
      const info = f.handler && INFO_REJECTIONS[f.handler];
      return { message: f.message, type: info && info.includes(f.message) ? 'info' : 'warning' };
    }
  }
}
