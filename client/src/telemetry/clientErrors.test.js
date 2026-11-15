// @vitest-environment jsdom
/**
 * Client error reports (telemetry/clientErrors.js): window hooks, once per
 * kind, buffered until connected, cut to the server's limits, never throws.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import contract from '../../../contract/index.js';
import {
  createClientErrorReporter, buildReport, stripUrlParts, reportClientError, getClientErrorReporter,
  _resetClientErrorReporter, MAX_BUFFER, MAX_KINDS, FLUSH_DELAY_MS,
} from './clientErrors.js';

function fakeSocket(connected = true) {
  const listeners = {};
  return {
    connected,
    emits: [],
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    emit(ev, data) { this.emits.push([ev, data]); },
    fire(ev) { for (const fn of listeners[ev] || []) fn(); },
    reports() { return this.emits.filter(([e]) => e === 'clientError').map(([, d]) => d); },
  };
}

/** A reporter with a manual clock for the post-connect flush. */
function setup({ connected = true, page = () => 'TABLE' } = {}) {
  const timers = [];
  const schedule = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const reporter = createClientErrorReporter({ build: 'abc1234', page, schedule });
  const socket = fakeSocket(connected);
  reporter.attach(socket);
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  return { reporter, socket, timers, runTimers };
}

// Built from parts: no credential-shaped literal in the repository
const host = ['https://babonline', 'invalid'].join('.');

beforeEach(() => _resetClientErrorReporter());

describe('reports', () => {
  test('a report is the contract payload: kind, message, stack, where, build, page', () => {
    const { reporter, socket } = setup();
    const err = new TypeError('x is undefined');
    err.stack = `TypeError: x is undefined\n    at f (${host}/dist/assets/main-AbCd1234.js:1:234)`;
    reporter.report('error', err, { where: 'main-AbCd1234.js:1:234' });
    const [r] = socket.reports();
    expect(r).toEqual({ kind: 'error', message: 'TypeError: x is undefined', stack: err.stack, where: 'main-AbCd1234.js:1:234', build: 'abc1234', page: 'TABLE' });
    expect(contract.validateC2S('clientError', r).ok).toBe(true);
  });

  test('once per kind per page load; another kind still goes', () => {
    const { reporter, socket } = setup();
    reporter.report('error', new Error('a'));
    reporter.report('error', new Error('b'));
    reporter.report('seqGap', 'cardPlayed: expected 4, got 6');
    expect(socket.reports().map((r) => [r.kind, r.message])).toEqual([['error', 'a'], ['seqGap', 'cardPlayed: expected 4, got 6']]);
    expect(reporter.stats.deduped).toBe(1);
  });

  test(`at most ${MAX_KINDS} kinds`, () => {
    const { reporter, socket } = setup();
    for (let i = 0; i < MAX_KINDS + 5; i++) reporter.report(`k${i}`, 'x');
    expect(socket.reports()).toHaveLength(MAX_KINDS);
  });

  test('a kind the server would refuse is never sent', () => {
    const { reporter, socket } = setup();
    expect(reporter.report('bad kind!', 'x')).toBe(false);
    expect(reporter.report('', 'x')).toBe(false);
    expect(socket.reports()).toEqual([]);
  });

  test('fields are cut to the server limits, URL queries and fragments stripped, a bad page dropped', () => {
    const r = buildReport('error', 'm'.repeat(2000), { stack: Array(40).fill(`at x (${host}/p?token=abc#f)`).join('\n'), where: `${host}/a.js?v=1:1:2`, build: 'b'.repeat(100), page: '<a/b>' });
    expect(r.message.length).toBeLessThanOrEqual(300);
    expect(r.stack.split('\n')).toHaveLength(12);
    expect(r.stack).not.toMatch(/token|#f/);
    expect(r.where).toBe(`${host}/a.js`);
    expect(r.build.length).toBe(64);
    expect(r.page).toBe('ab');
    expect(contract.validateC2S('clientError', r).ok).toBe(true);
  });

  test('a thrown object is named by its type, never its contents', () => {
    expect(buildReport('unhandledrejection', { secret: 'chat line' }).message).toBe('[object Object]');
    expect(buildReport('unhandledrejection', undefined).message).toBe('undefined');
    expect(buildReport('unhandledrejection', '').message).toBe('(no message)');
  });

  test('stripUrlParts keeps scheme, host and path', () => {
    expect(stripUrlParts(`load ${host}/reset.html?token=abc#x failed`)).toBe(`load ${host}/reset.html failed`);
    expect(stripUrlParts('GET /avatar/x?v=1 404')).toBe('GET /avatar/x 404');
  });
});

describe('connection', () => {
  test(`while disconnected: up to ${MAX_BUFFER} wait, then go ${FLUSH_DELAY_MS} ms after the next connect`, () => {
    const { reporter, socket, timers, runTimers } = setup({ connected: false });
    for (let i = 0; i < MAX_BUFFER + 2; i++) reporter.report(`k${i}`, 'x');
    expect(socket.reports()).toEqual([]);
    expect(reporter.pending).toBe(MAX_BUFFER);
    expect(reporter.stats.dropped).toBe(2);
    socket.connected = true;
    socket.fire('connect');
    expect(timers[0].ms).toBe(FLUSH_DELAY_MS);
    expect(socket.reports()).toEqual([]); // the session restore goes first
    runTimers();
    expect(socket.reports().map((r) => r.kind)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
    expect(reporter.pending).toBe(0);
  });

  test('a report made during the post-connect wait queues behind the buffer (order kept)', () => {
    const { reporter, socket, runTimers } = setup({ connected: false });
    reporter.report('a', 'x');
    socket.connected = true;
    socket.fire('connect');
    reporter.report('b', 'x');
    runTimers();
    expect(socket.reports().map((r) => r.kind)).toEqual(['a', 'b']);
  });

  test('dropped again before the flush: the buffer waits for the connect after', () => {
    const { reporter, socket, runTimers } = setup({ connected: false });
    reporter.report('a', 'x');
    socket.connected = true;
    socket.fire('connect');
    socket.connected = false;
    runTimers();
    expect(socket.reports()).toEqual([]);
    socket.connected = true;
    socket.fire('connect');
    runTimers();
    expect(socket.reports().map((r) => r.kind)).toEqual(['a']);
  });
});

describe('never throws', () => {
  test('a throwing emit, page getter or socket is swallowed', () => {
    const reporter = createClientErrorReporter({ page: () => { throw new Error('no screen'); } });
    reporter.attach({ connected: true, on() { throw new Error('stub'); }, emit() { throw new Error('closed'); } });
    expect(() => reporter.report('error', new Error('x'))).not.toThrow();
    expect(() => reportClientError('director', new Error('y'))).not.toThrow();
  });

  test('an error raised while sending a report is not reported (no loop)', () => {
    const reporter = createClientErrorReporter();
    const socket = fakeSocket(true);
    socket.emit = vi.fn(() => { reporter.report('nested', 'x'); });
    reporter.attach(socket);
    reporter.report('error', 'x');
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  test('reportClientError uses the shared reporter, which buffers until main.js attaches it', () => {
    reportClientError('seqGap', 'gap');
    const shared = getClientErrorReporter();
    expect(shared.pending).toBe(1);
    const socket = fakeSocket(false);
    shared.attach(socket);
    socket.connected = true;
    vi.useFakeTimers();
    try {
      socket.fire('connect');
      vi.advanceTimersByTime(FLUSH_DELAY_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(socket.reports().map((r) => r.kind)).toEqual(['seqGap']);
  });
});

describe('window hooks', () => {
  test("'error' and 'unhandledrejection' are reported with the file position; removed by the returned function", () => {
    const { reporter, socket } = setup();
    const remove = reporter.installWindowHooks(window);
    const err = new RangeError('bad index');
    window.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message, filename: `${host}/dist/assets/main-AbCd1234.js?x=1`, lineno: 1, colno: 99 }));
    const rejection = new Event('unhandledrejection');
    rejection.reason = new Error('fetch failed');
    window.dispatchEvent(rejection);
    expect(socket.reports().map(({ kind, message, where }) => ({ kind, message, where }))).toEqual([
      { kind: 'error', message: 'RangeError: bad index', where: 'main-AbCd1234.js:1:99' },
      { kind: 'unhandledrejection', message: 'fetch failed', where: undefined },
    ]);
    // a second error reaches the hook (deduped); after remove() nothing does
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('again'), message: 'again', filename: 'x.js' }));
    expect(reporter.stats.deduped).toBe(1);
    const removed = vi.spyOn(window, 'removeEventListener');
    remove();
    expect(removed.mock.calls.map(([ev]) => ev).sort()).toEqual(['error', 'unhandledrejection']);
    removed.mockRestore();
  });

  test('a cross-origin "Script error." with nothing else is skipped', () => {
    const { reporter, socket } = setup();
    const remove = reporter.installWindowHooks(window);
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    expect(socket.reports()).toEqual([]);
    remove();
  });

  test('a hook never throws, whatever the event', () => {
    const { reporter } = setup();
    const remove = reporter.installWindowHooks(window);
    const weird = new Event('unhandledrejection');
    Object.defineProperty(weird, 'reason', { get() { throw new Error('getter'); } });
    expect(() => window.dispatchEvent(weird)).not.toThrow();
    remove();
  });
});
