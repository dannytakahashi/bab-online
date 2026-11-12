import { describe, it, expect } from 'vitest';
import { ServerErrorDeduper, failureOf, CHANNEL, DEDUPE_WINDOW_MS, TABLE_ERROR_HANDLERS } from './serverErrors.js';

const { ERROR, SERVER_ERROR } = CHANNEL;

function clock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('failureOf', () => {
  it('reads a v1 error and its serverError twin as the same failure', () => {
    expect(failureOf(ERROR, { type: 'rateLimit', message: 'Slow down', handler: 'playCard' }))
      .toEqual({ type: 'rateLimit', message: 'Slow down', handler: 'playCard' });
    expect(failureOf(SERVER_ERROR, { code: 'rateLimit', message: 'Slow down', handler: 'playCard' }))
      .toEqual({ type: 'rateLimit', message: 'Slow down', handler: 'playCard' });
  });

  it('a refusal: no type on error, code rejected on serverError; a missing handler is null', () => {
    expect(failureOf(ERROR, { message: 'Lobby is full', handler: 'joinLobby' })).toEqual({ type: undefined, message: 'Lobby is full', handler: 'joinLobby' });
    expect(failureOf(SERVER_ERROR, { code: 'rejected', message: 'Lobby is full', handler: 'joinLobby' })).toEqual({ type: 'rejected', message: 'Lobby is full', handler: 'joinLobby' });
    expect(failureOf(ERROR, { message: 'x' }).handler).toBeNull();
    expect(failureOf(SERVER_ERROR, { code: 'server', message: 'x', handler: null }).handler).toBeNull();
  });

  it('survives garbage', () => {
    expect(failureOf(ERROR, null)).toEqual({ type: undefined, message: undefined, handler: null });
    expect(failureOf(SERVER_ERROR, 'boom')).toEqual({ type: undefined, message: undefined, handler: null });
    expect(failureOf(SERVER_ERROR, { code: 7, message: 3, handler: {} })).toEqual({ type: undefined, message: undefined, handler: null });
  });

  it('the table handlers are the iOS routeTableError set', () => {
    expect([...TABLE_ERROR_HANDLERS]).toEqual(['playCard', 'playerBid', 'requestSnapshot']);
  });
});

describe('ServerErrorDeduper (iOS 1.2 ServerErrorDeduper)', () => {
  it('drops the other channel\'s copy with an equal handler, in either order', () => {
    for (const [a, b] of [[ERROR, SERVER_ERROR], [SERVER_ERROR, ERROR]]) {
      const c = clock();
      const d = new ServerErrorDeduper({ now: c.now });
      expect(d.accept(a, { message: 'Lobby is full', handler: 'joinLobby' })).toBe(true);
      c.advance(1);
      expect(d.accept(b, { message: 'Lobby is full', handler: 'joinLobby' })).toBe(false);
    }
  });

  it('one twin per failure: a third copy is a new failure', () => {
    const d = new ServerErrorDeduper({ now: clock().now });
    expect(d.accept(ERROR, { message: 'm', handler: 'playCard' })).toBe(true);
    expect(d.accept(SERVER_ERROR, { message: 'm', handler: 'playCard' })).toBe(false);
    expect(d.accept(ERROR, { message: 'm', handler: 'playCard' })).toBe(true);
    expect(d.accept(SERVER_ERROR, { message: 'm', handler: 'playCard' })).toBe(false);
  });

  it('the same channel twice is two failures (two rate-limited plays)', () => {
    const d = new ServerErrorDeduper({ now: clock().now });
    expect(d.accept(SERVER_ERROR, { message: 'm', handler: 'playCard' })).toBe(true);
    expect(d.accept(SERVER_ERROR, { message: 'm', handler: 'playCard' })).toBe(true);
  });

  it('another handler, or outside the window, is another failure', () => {
    const c = clock();
    const d = new ServerErrorDeduper({ now: c.now });
    expect(d.accept(ERROR, { message: 'm', handler: 'playCard' })).toBe(true);
    expect(d.accept(SERVER_ERROR, { message: 'm', handler: 'playerBid' })).toBe(true);
    c.advance(DEDUPE_WINDOW_MS);
    expect(d.accept(ERROR, { message: 'm', handler: 'playerBid' })).toBe(true);
  });

  it('no handler on either: the message must match too', () => {
    const d = new ServerErrorDeduper({ now: clock().now });
    expect(d.accept(ERROR, { message: 'a', handler: null })).toBe(true);
    expect(d.accept(SERVER_ERROR, { message: 'b', handler: null })).toBe(true);
    expect(d.accept(ERROR, { message: 'b', handler: null })).toBe(false);
  });

  it('phase B (serverError only): every failure is handled', () => {
    const c = clock();
    const d = new ServerErrorDeduper({ now: c.now });
    for (let i = 0; i < 5; i++) {
      expect(d.accept(SERVER_ERROR, { message: 'Lobby is full', handler: 'joinLobby' })).toBe(true);
      c.advance(10);
    }
  });
});
