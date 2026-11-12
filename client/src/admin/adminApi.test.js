/**
 * The admin api's rate-limit fast path reads `error {type}` today and its
 * `serverError {code}` twin, so it keeps working when phase B drops `error`
 * (V1_REMOVALS #1).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAdminApi } from './adminApi.js';

function fakeSocket() {
  const listeners = new Map();
  return {
    on(e, fn) { listeners.set(e, [...(listeners.get(e) || []), fn]); },
    off(e, fn) { listeners.set(e, (listeners.get(e) || []).filter((f) => f !== fn)); },
    emit: vi.fn(),
    fire(e, d) { for (const fn of [...(listeners.get(e) || [])]) fn(d); },
    count(e) { return (listeners.get(e) || []).length; },
  };
}

afterEach(() => vi.useRealTimers());

describe('adminApi rate limit', () => {
  for (const [label, events] of [
    ['serverError alone (phase B)', [['serverError', { code: 'rateLimit', message: 'Too many requests', handler: 'adminRequest' }]]],
    ['both copies', [['error', { type: 'rateLimit', message: 'Too many requests', handler: 'adminRequest' }], ['serverError', { code: 'rateLimit', message: 'Too many requests', handler: 'adminRequest' }]]],
  ]) {
    it(`${label}: the dropped request fails as rate_limited after the grace`, async () => {
      vi.useFakeTimers();
      const socket = fakeSocket();
      const api = createAdminApi(socket, { timeoutMs: 15000, rateLimitGraceMs: 3000 });
      const p = api.request('listAdmins');
      const outcome = p.then(() => 'resolved', (e) => e.message);
      for (const [e, d] of events) socket.fire(e, d);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await outcome).toBe('rate_limited');
      api.dispose();
    });
  }

  it('another handler\'s rate limit is not the admin request', async () => {
    vi.useFakeTimers();
    const socket = fakeSocket();
    const api = createAdminApi(socket, { timeoutMs: 15000, rateLimitGraceMs: 3000 });
    const outcome = api.request('listAdmins').then(() => 'resolved', (e) => e.message);
    socket.fire('serverError', { code: 'rateLimit', message: 'Too many requests', handler: 'playCard' });
    await vi.advanceTimersByTimeAsync(3000);
    const { requestId } = socket.emit.mock.calls[0][1];
    socket.fire('adminResponse', { requestId, action: 'listAdmins', ok: true });
    expect(await outcome).toBe('resolved');
    api.dispose();
  });

  it('dispose removes both listeners', () => {
    const socket = fakeSocket();
    const api = createAdminApi(socket);
    expect(socket.count('error')).toBe(1);
    expect(socket.count('serverError')).toBe(1);
    api.dispose();
    expect(socket.count('error')).toBe(0);
    expect(socket.count('serverError')).toBe(0);
  });
});
