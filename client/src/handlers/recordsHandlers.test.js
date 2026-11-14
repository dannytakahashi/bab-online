/**
 * recordsResponse reaches the page with its records, the all-time total, the
 * scope echo and each period's game count (periodGames, additive 2026-11-14).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRecordsHandlers } from './recordsHandlers.js';

describe('registerRecordsHandlers', () => {
  let handlers;
  const socketManager = { on: (event, fn) => { handlers[event] = fn; } };

  beforeEach(() => {
    handlers = {};
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('passes periodGames through with the records, total and scope', () => {
    const onRecordsReceived = vi.fn();
    registerRecordsHandlers(socketManager, { onRecordsReceived });
    const records = { allTime: null, thisYear: null, thisMonth: null };
    const periodGames = { allTime: 101, thisYear: 40, thisMonth: 12 };
    handlers.recordsResponse({ success: true, records, totalGames: 101, periodGames, scope: 'bots' });
    expect(onRecordsReceived).toHaveBeenCalledWith(records, 101, 'bots', periodGames);
  });

  it('a reply from before periodGames passes undefined (the page keeps the one total line)', () => {
    const onRecordsReceived = vi.fn();
    registerRecordsHandlers(socketManager, { onRecordsReceived });
    handlers.recordsResponse({ success: true, records: {}, totalGames: 3 });
    expect(onRecordsReceived).toHaveBeenCalledWith({}, 3, undefined, undefined);
  });

  it('a failure goes to onRecordsError with the scope echo', () => {
    const onRecordsError = vi.fn();
    registerRecordsHandlers(socketManager, { onRecordsError });
    handlers.recordsResponse({ success: false, message: 'Database error', scope: 'all' });
    expect(onRecordsError).toHaveBeenCalledWith('Database error', 'all');
  });
});
