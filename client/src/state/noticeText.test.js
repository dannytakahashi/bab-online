import { describe, it, expect } from 'vitest';
import { serverErrorNotice, SERVER_TEXT, NOTICE } from './noticeText.js';

describe('serverErrorNotice: amber refusals, teal information, red real failures', () => {
  it('a refusal is a warning with the server\'s words', () => {
    expect(serverErrorNotice({ type: 'rejected', message: 'Lobby is full', handler: 'joinLobby' })).toEqual({ message: 'Lobby is full', type: 'warning' });
    // untyped (legacy shape) too
    expect(serverErrorNotice({ message: 'Only the host can do this' })).toEqual({ message: 'Only the host can do this', type: 'warning' });
  });

  it('the table-full Ready refusal is information, only for playerReady', () => {
    const msg = "The table is full — you'll watch this game";
    expect(serverErrorNotice({ type: 'rejected', message: msg, handler: 'playerReady' })).toEqual({ message: msg, type: 'info' });
    expect(serverErrorNotice({ type: 'rejected', message: msg, handler: 'joinLobby' }).type).toBe('warning');
  });

  it('validation never shows Joi\'s text', () => {
    const joi = { type: 'validation', message: 'Validation failed: "message" length must be ...' };
    expect(serverErrorNotice({ ...joi, handler: 'lobbyChat' })).toEqual({ message: SERVER_TEXT.CHAT_TOO_LONG, type: 'warning' });
    expect(serverErrorNotice({ ...joi, handler: 'playerBid' })).toEqual({ message: SERVER_TEXT.NOT_ACCEPTED, type: 'warning' });
    expect(serverErrorNotice({ ...joi, type: 'VALIDATION_ERROR', handler: null }).message).not.toMatch(/Validation failed/);
  });

  it('rate limit: a warning; server, auth and an empty refusal: errors', () => {
    expect(serverErrorNotice({ type: 'rateLimit', message: 'x' })).toEqual({ message: SERVER_TEXT.RATE_LIMIT, type: 'warning' });
    expect(serverErrorNotice({ type: 'server', message: 'An error occurred processing your request' })).toEqual({ message: SERVER_TEXT.FALLBACK, type: 'error' });
    expect(serverErrorNotice({ type: 'AUTH_ERROR' })).toEqual({ message: SERVER_TEXT.SIGN_IN_AGAIN, type: 'error' });
    expect(serverErrorNotice({ type: 'rejected' })).toEqual({ message: SERVER_TEXT.FALLBACK, type: 'error' });
    expect(serverErrorNotice(null)).toEqual({ message: SERVER_TEXT.FALLBACK, type: 'error' });
  });

  it('the table notices are iOS\'s words', () => {
    expect(NOTICE).toMatchObject({
      NOT_YOUR_TURN: 'Not your turn.',
      BID_FIRST: 'Bid first.',
      CARD_ON_ITS_WAY: 'Your card is on its way.',
      TRICK_CLEARING: 'Wait for the trick to clear.',
    });
  });
});
