/**
 * The tournament voice room's over-cap notice (2026-11-25, s2c
 * tournamentVoiceStatus): the voice module passes a well-formed payload to
 * the page and drops anything else.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const voice = vi.hoisted(() => ({}));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => voice }));

const { registerVoiceHandlers } = await import('./voiceHandlers.js');

describe('registerVoiceHandlers: tournamentVoiceStatus', () => {
  let handlers;
  const socketManager = { on: (event, fn) => { handlers[event] = fn; } };

  beforeEach(() => {
    handlers = {};
  });

  it('passes {admitted, cap} to onTournamentVoiceStatus', () => {
    const onTournamentVoiceStatus = vi.fn();
    registerVoiceHandlers(socketManager, { onTournamentVoiceStatus });
    handlers.tournamentVoiceStatus({ admitted: false, cap: 12 });
    handlers.tournamentVoiceStatus({ admitted: true, cap: 12 });
    expect(onTournamentVoiceStatus.mock.calls).toEqual([[{ admitted: false, cap: 12 }], [{ admitted: true, cap: 12 }]]);
  });

  it('drops a malformed payload, and works without the callback', () => {
    const onTournamentVoiceStatus = vi.fn();
    registerVoiceHandlers(socketManager, { onTournamentVoiceStatus });
    for (const bad of [null, undefined, 'full', {}, { admitted: 'no', cap: 8 }]) handlers.tournamentVoiceStatus(bad);
    expect(onTournamentVoiceStatus).not.toHaveBeenCalled();
    registerVoiceHandlers(socketManager, {});
    expect(() => handlers.tournamentVoiceStatus({ admitted: false, cap: 8 })).not.toThrow();
  });
});

// One call per player after a reconnect (docs/claude/voice.md): voicePeerJoined
// lets the manager move or close a call to that player on an older socket id
describe('registerVoiceHandlers: voicePeerJoined', () => {
  it('hands the player and the new socket id to the manager, then to the page', () => {
    const handlers = {};
    voice.peerJoined = vi.fn();
    const onVoicePeers = vi.fn();
    registerVoiceHandlers({ on: (event, fn) => { handlers[event] = fn; } }, { onVoicePeers });
    handlers.voicePeerJoined({ socketId: 'b2', username: 'bob' });
    expect(voice.peerJoined).toHaveBeenCalledWith('b2', 'bob');
    expect(onVoicePeers).toHaveBeenCalledWith('joined', { socketId: 'b2', username: 'bob' });
    delete voice.peerJoined;
  });
});
