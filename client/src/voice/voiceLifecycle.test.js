import { describe, it, expect, vi } from 'vitest';
import { createVoiceLifecycle } from './voiceLifecycle.js';

/** A manager like VoiceChatManager: initialize waits for the mic prompt; shutdown bumps its generation. */
function fakeManager() {
  const prompts = [];
  const m = {
    active: false,
    generation: 0,
    initialize: vi.fn(() => {
      const gen = m.generation;
      return new Promise((resolve, reject) => {
        prompts.push({
          allow: () => {
            if (gen === m.generation && !m.active) m.active = true; // else: mic released
            resolve();
          },
          deny: () => reject(new Error('Permission denied')),
        });
      });
    }),
    shutdown: vi.fn(() => {
      m.active = false;
      m.generation++;
    }),
    prompts,
  };
  return m;
}

function setup() {
  const manager = fakeManager();
  const controls = { mute: 0, warnings: 0 };
  const voice = createVoiceLifecycle({
    manager,
    connect: () => manager.initialize(),
    onStarted: () => { controls.mute++; },
    onUnavailable: () => { controls.warnings++; },
    teardown: () => {
      manager.shutdown();
      controls.mute = 0;
    },
  });
  return { manager, controls, voice };
}

describe('voice across the microphone prompt (later #17)', () => {
  it('allowed while still there: the controls appear once', async () => {
    const { manager, controls, voice } = setup();
    const started = voice.start();
    expect(voice.starting).toBe(true);
    manager.prompts[0].allow();
    expect(await started).toBe(true);
    expect(controls.mute).toBe(1);
    expect(voice.starting).toBe(false);
  });

  it('allowed after leaving (stop ran meanwhile): no dead mute button, the mic is released', async () => {
    const { manager, controls, voice } = setup();
    const started = voice.start();
    voice.stop(); // left the lobby / table
    manager.prompts[0].allow();
    expect(await started).toBe(false);
    expect(controls.mute).toBe(0);
    expect(manager.active).toBe(false);
  });

  it('denied after leaving: no "microphone denied" warning on a screen without voice', async () => {
    const { manager, controls, voice } = setup();
    const started = voice.start();
    voice.stop();
    manager.prompts[0].deny();
    expect(await started).toBe(false);
    expect(controls.warnings).toBe(0);
  });

  it('denied while still there: the warning', async () => {
    const { manager, controls, voice } = setup();
    const started = voice.start();
    manager.prompts[0].deny();
    expect(await started).toBe(false);
    expect(controls.warnings).toBe(1);
  });

  it('a second start while the prompt is up asks once', async () => {
    const { manager, controls, voice } = setup();
    const a = voice.start();
    const b = voice.start();
    expect(b).toBe(a);
    expect(manager.initialize).toHaveBeenCalledTimes(1);
    manager.prompts[0].allow();
    await a;
    expect(controls.mute).toBe(1);
  });

  it('left and came back before answering the first prompt: only the new start draws controls', async () => {
    const { manager, controls, voice } = setup();
    const first = voice.start();
    voice.stop();
    const second = voice.start();
    manager.prompts[1].allow();
    manager.prompts[0].allow(); // the old prompt answered last
    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(controls.mute).toBe(1);
    expect(manager.active).toBe(true);
  });

  it('a second start while one is in flight returns that one (one connect)', async () => {
    const manager = { active: false };
    const connect = vi.fn(() => new Promise((resolve) => { manager.resolve = resolve; }));
    const voice = createVoiceLifecycle({ manager, connect, onStarted: () => {}, onUnavailable: () => {}, teardown: () => {} });
    const a = voice.start();
    expect(connect).toHaveBeenCalledWith({});
    const b = voice.start(); // a voiceSettings while the first start waits
    expect(b).toBe(a);
    manager.active = true;
    manager.resolve();
    expect(await a).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('a connect that throws at once is a refusal, and a later start may try again', async () => {
    const manager = { active: false };
    let fail = true;
    const onUnavailable = vi.fn();
    const onStarted = vi.fn();
    const voice = createVoiceLifecycle({
      manager,
      connect: () => {
        if (fail) throw new Error('no WebRTC');
        manager.active = true;
        return Promise.resolve();
      },
      onStarted,
      onUnavailable,
      teardown: () => {},
    });
    expect(await voice.start()).toBe(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(voice.starting).toBe(false);
    fail = false;
    expect(await voice.start()).toBe(true);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });
});
