import { describe, it, expect } from 'vitest';
import * as serverErrors from './serverErrors.js';

const { failureOf, TABLE_ERROR_HANDLERS } = serverErrors;

describe('failureOf (serverError {code, message, handler})', () => {
  it('the code is the failure type', () => {
    expect(failureOf({ code: 'rateLimit', message: 'Slow down', handler: 'playCard' }))
      .toEqual({ type: 'rateLimit', message: 'Slow down', handler: 'playCard' });
  });

  it('a refusal is code rejected; a missing handler is null', () => {
    expect(failureOf({ code: 'rejected', message: 'Lobby is full', handler: 'joinLobby' })).toEqual({ type: 'rejected', message: 'Lobby is full', handler: 'joinLobby' });
    expect(failureOf({ code: 'server', message: 'x', handler: null }).handler).toBeNull();
    expect(failureOf({ code: 'server', message: 'x' }).handler).toBeNull();
  });

  it('survives garbage', () => {
    expect(failureOf(null)).toEqual({ type: undefined, message: undefined, handler: null });
    expect(failureOf('boom')).toEqual({ type: undefined, message: undefined, handler: null });
    expect(failureOf({ code: 7, message: 3, handler: {} })).toEqual({ type: undefined, message: undefined, handler: null });
  });

  it('the table handlers are the iOS routeTableError set', () => {
    expect([...TABLE_ERROR_HANDLERS]).toEqual(['playCard', 'playerBid', 'requestSnapshot']);
  });

  it('phase B: no second channel and no twin dedupe left (V1_REMOVALS #1)', () => {
    expect(Object.keys(serverErrors).sort()).toEqual(['TABLE_ERROR_HANDLERS', 'failureOf']);
  });
});
