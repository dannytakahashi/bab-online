/**
 * The sound toggle (ui/components/SoundToggle.js): a keyboard-reachable
 * kit icon button whose aria-pressed is the muted state, its name what a
 * press does and its tooltip the state; every copy (the table's, the main
 * room's) follows the one setting; one that left the page stops listening,
 * at the next change or when the next toggle is made.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSoundToggle, placeSoundToggle, TABLE_SOUND_BUTTON_ID } from './SoundToggle.js';
import { SoundManager } from '../../audio/SoundManager.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

let sound;
let storage;

beforeEach(() => {
  document.body.replaceChildren();
  storage = memoryStorage();
  sound = new SoundManager({ AudioContextImpl: null, storage, doc: document });
});

describe('the sound toggle', () => {
  it('is a labelled toggle button, on by default', () => {
    const btn = createSoundToggle({ id: 'x', sound });
    document.body.appendChild(btn);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.disabled).toBe(false);
    expect(btn.tabIndex).toBe(0);
    expect(btn.classList.contains('kit-icon-btn')).toBe(true);
    expect(btn.classList.contains('sound-btn')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Mute sound effects');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Sound on');
    expect(btn.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a press mutes (pressed, "Sound off", saved) and another turns it back on', () => {
    const btn = createSoundToggle({ sound });
    document.body.appendChild(btn);
    btn.click();
    expect(sound.muted).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Sound off');
    expect(JSON.parse(storage.data['bab.sound']).muted).toBe(true);
    btn.click();
    expect(sound.muted).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Sound on');
  });

  it('starts muted when this device muted it', () => {
    sound.setMuted(true);
    const btn = createSoundToggle({ sound });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Sound off');
  });

  it('every copy follows the setting; one that left the page stops listening', () => {
    const a = createSoundToggle({ sound });
    const b = createSoundToggle({ sound });
    document.body.append(a, b);
    a.click();
    expect(b.getAttribute('aria-pressed')).toBe('true');
    b.remove();
    a.click();
    expect(sound._listeners.size).toBe(1);
    expect(a.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles that left the page are dropped when a new one is made, even if the mute is never touched', async () => {
    for (let i = 0; i < 5; i++) {
      // a main room shown again: a fresh header, the old one gone
      document.body.replaceChildren();
      const btn = createSoundToggle({ id: 'mainRoomSoundButton', sound });
      document.body.appendChild(btn);
      await Promise.resolve();
    }
    createSoundToggle({ sound });
    // the connected one and the one just made
    expect(sound._listeners.size).toBe(2);
  });

  it('two toggles made before either is inserted both stay bound', () => {
    const a = createSoundToggle({ sound });
    const b = createSoundToggle({ sound });
    const c = createSoundToggle({ sound });
    document.body.append(a, b, c);
    c.click();
    expect(a.getAttribute('aria-pressed')).toBe('true');
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });

  it('off the table, placeSoundToggle puts nothing anywhere', () => {
    expect(placeSoundToggle()).toBeNull();
    expect(document.getElementById(TABLE_SOUND_BUTTON_ID)).toBeNull();
  });
});
