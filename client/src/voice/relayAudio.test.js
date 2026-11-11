import { describe, it, expect, vi } from 'vitest';
import { VoiceChatManager } from './VoiceChatManager.js';

// The PCM relay receiver decodes with new Int16Array(audio). Only a binary
// chunk may reach that: a numeric string or an array-like object would be
// read as a sample count and allocate hundreds of MB.
function relayManager() {
  const vm = new VoiceChatManager();
  const createBuffer = vi.fn((_ch, length, sampleRate) => ({
    duration: length / sampleRate,
    getChannelData: () => new Float32Array(length),
  }));
  vm._audioContext = {
    currentTime: 0,
    createBuffer,
    createBufferSource: () => ({ connect() {}, start() {} }),
  };
  vm._relayedPeers.add('peer');
  vm._relayGainNodes.set('peer', {});
  return { vm, createBuffer };
}

describe('VoiceChatManager relay audio', () => {
  it('plays a binary Int16 chunk', () => {
    const { vm, createBuffer } = relayManager();
    vm._onRelayAudio('peer', new Int16Array(682).buffer);
    expect(createBuffer).toHaveBeenCalledTimes(1);
    expect(createBuffer.mock.calls[0][1]).toBe(682);
  });

  it.each([
    ['a numeric string', '400000000'],
    ['an array-like object', { length: 4e8 }],
    ['an array', [1, 2, 3, 4]],
    ['a number', 400000000],
    ['an empty buffer', new ArrayBuffer(0)],
    ['an odd byte count', new ArrayBuffer(1365)],
    ['a chunk over 64 KB', new ArrayBuffer(64 * 1024 + 2)],
  ])('drops %s without decoding it', (_label, audio) => {
    const { vm, createBuffer } = relayManager();
    const Int16 = globalThis.Int16Array;
    const spy = vi.fn((...args) => new Int16(...args));
    globalThis.Int16Array = spy;
    try {
      expect(() => vm._onRelayAudio('peer', audio)).not.toThrow();
    } finally {
      globalThis.Int16Array = Int16;
    }
    expect(spy).not.toHaveBeenCalled();
    expect(createBuffer).not.toHaveBeenCalled();
  });
});
