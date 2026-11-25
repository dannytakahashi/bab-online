/**
 * Every tournament event reaches its page callback through registerAllHandlers
 * (handlers/index.js passes each callback by name: a callback missing there
 * is silently never called, as tournamentSettingsUpdated's was in the
 * 2026-11-25 live check).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAllHandlers } from './index.js';
import { SERVER_EVENTS } from '../constants/events.js';

const TOURNAMENT_EVENTS = {
  tournamentCreated: 'onTournamentCreated',
  tournamentJoined: 'onTournamentJoined',
  tournamentPlayerJoined: 'onTournamentPlayerJoined',
  tournamentPlayerLeft: 'onTournamentPlayerLeft',
  tournamentReadyUpdate: 'onTournamentReadyUpdate',
  tournamentSettingsUpdated: 'onTournamentSettingsUpdated',
  tournamentMessage: 'onTournamentMessage',
  tournamentRoundStart: 'onTournamentRoundStart',
  tournamentGameAssignment: 'onTournamentGameAssignment',
  tournamentGameComplete: 'onTournamentGameComplete',
  tournamentRoundComplete: 'onTournamentRoundComplete',
  tournamentComplete: 'onTournamentComplete',
  tournamentLeft: 'onTournamentLeft',
  tournamentCancelled: 'onTournamentCancelled',
  // the over-cap notice (#406): registered by voiceHandlers.js, still through registerAllHandlers
  tournamentVoiceStatus: 'onTournamentVoiceStatus',
};

describe('tournament events through registerAllHandlers', () => {
  let handlers;
  const record = (event, fn) => { (handlers[event] ||= []).push(fn); };
  const socketManager = { on: record, onGame: record, emit: () => {} };

  beforeEach(() => {
    handlers = {};
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('every tournament server event calls its callback with the payload', () => {
    const callbacks = Object.fromEntries(Object.values(TOURNAMENT_EVENTS).map((name) => [name, vi.fn()]));
    registerAllHandlers(socketManager, callbacks);
    for (const [event, name] of Object.entries(TOURNAMENT_EVENTS)) {
      expect(Object.values(SERVER_EVENTS)).toContain(event);
      // the voice handler drops a malformed notice, so it gets a real one
      const payload = event === 'tournamentVoiceStatus' ? { admitted: false, cap: 8 } : { probe: event };
      for (const fn of handlers[event] || []) fn(payload);
      expect(callbacks[name], `${event} -> ${name}`).toHaveBeenCalledWith(payload);
    }
  });

  it('every tournament* server event in the contract is listed here', () => {
    const tournamentEvents = Object.values(SERVER_EVENTS).filter((e) => e.startsWith('tournament'));
    expect(tournamentEvents.sort()).toEqual(Object.keys(TOURNAMENT_EVENTS).sort());
  });
});
