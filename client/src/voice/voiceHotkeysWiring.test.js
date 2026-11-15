/**
 * main.js wires the voice keys through installVoiceHotkeys, and no Tab
 * handler comes back: the old one preventDefaulted every Tab while voice
 * was on, so keyboard focus never moved (main.js is too big to import here).
 */
import { describe, it, expect } from 'vitest';
import { readClientFile } from '../testing/files.js';

const MAIN = readClientFile('src/main.js');

describe('main.js voice key wiring', () => {
  it('installs the voice hotkeys module', () => {
    expect(MAIN).toMatch(/import \{ installVoiceHotkeys \} from '\.\/voice\/voiceHotkeys\.js'/);
    expect(MAIN).toMatch(/installVoiceHotkeys\(\{/);
  });

  it('has no Tab key handler', () => {
    expect(MAIN).not.toMatch(/key\s*===?\s*['"]Tab['"]/);
    expect(MAIN).not.toMatch(/code\s*===?\s*['"]Tab['"]/);
  });

  it('has no document keydown or keyup listener of its own', () => {
    expect(MAIN).not.toMatch(/document\.addEventListener\(\s*['"]key(down|up)['"]/);
  });
});
