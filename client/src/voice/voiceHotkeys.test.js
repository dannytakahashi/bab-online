import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real overlay below runs against a fake voice manager with one peer
const fakeVoice = {
  active: true,
  selfMuted: false,
  getPeers: () => [{ socketId: 'peer-1', username: 'Alice' }],
  getPeerVolume: () => 1,
  setPeerVolume: () => {},
  isPeerMuted: () => false,
  mutePeer: () => {},
  unmutePeer: () => {},
  isSpeaking: () => false,
  isUnavailable: () => false,
  toggleSelfMute: () => false,
};
vi.mock('./VoiceChatManager.js', () => ({ getVoiceChatManager: () => fakeVoice }));

const { installVoiceHotkeys, isTypingTarget } = await import('./voiceHotkeys.js');
const { showVoiceOverlay, removeVoiceOverlay } = await import('../ui/components/VoiceChatUI.js');
const { openModalCount } = await import('../ui/kit/modal.js');

/** Dispatch a key event on the focused element (as a browser does); returns it. */
function key(type, init, target = document.activeElement || document.body) {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
const BACKQUOTE = { key: '`', code: 'Backquote' };
const TAB = { key: 'Tab', code: 'Tab' };

describe('voice hotkeys (unit)', () => {
  let active;
  let show;
  let hide;
  let toggleMute;
  let uninstall;
  let btn;

  beforeEach(() => {
    active = true;
    show = vi.fn();
    hide = vi.fn();
    toggleMute = vi.fn();
    uninstall = installVoiceHotkeys({ isActive: () => active, show, hide, toggleMute });
    btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = '';
  });

  it('Tab is never prevented and never opens the overlay while voice is on', () => {
    expect(key('keydown', TAB).defaultPrevented).toBe(false);
    expect(key('keydown', { ...TAB, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key('keyup', TAB).defaultPrevented).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
  });

  it('backquote down opens (prevented), up closes', () => {
    const down = key('keydown', BACKQUOTE);
    expect(down.defaultPrevented).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    key('keyup', BACKQUOTE);
    expect(hide).toHaveBeenCalledTimes(1);
    // a second press opens it again
    key('keydown', BACKQUOTE);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('a layout whose Backquote key types another character still opens it by code', () => {
    key('keydown', { key: '^', code: 'Backquote' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('auto-repeat while held stays prevented and does not reopen', () => {
    key('keydown', BACKQUOTE);
    const rep = key('keydown', { ...BACKQUOTE, repeat: true });
    expect(rep.defaultPrevented).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('a lone repeat keydown (key held from before) does not open', () => {
    const rep = key('keydown', { ...BACKQUOTE, repeat: true });
    expect(rep.defaultPrevented).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    ['contenteditable', () => { const d = document.createElement('div'); d.setAttribute('contenteditable', 'true'); d.tabIndex = 0; return d; }],
  ])('typing in a %s: ` types (not prevented, no overlay) and m does not mute', (_name, make) => {
    const field = make();
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(key('keydown', BACKQUOTE).defaultPrevented).toBe(false);
    key('keyup', BACKQUOTE);
    key('keydown', { key: 'm', code: 'KeyM' });
    expect(show).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    expect(toggleMute).not.toHaveBeenCalled();
  });

  it('a child of a contenteditable counts as typing; contenteditable="false" does not', () => {
    const host = document.createElement('div');
    host.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    host.appendChild(child);
    document.body.appendChild(host);
    expect(isTypingTarget(child)).toBe(true);
    const off = document.createElement('div');
    off.setAttribute('contenteditable', 'false');
    expect(isTypingTarget(off)).toBe(false);
    expect(isTypingTarget(btn)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it.each(['ctrlKey', 'metaKey', 'altKey'])('with %s held nothing happens', (mod) => {
    expect(key('keydown', { ...BACKQUOTE, [mod]: true }).defaultPrevented).toBe(false);
    key('keydown', { key: 'm', code: 'KeyM', [mod]: true });
    expect(show).not.toHaveBeenCalled();
    expect(toggleMute).not.toHaveBeenCalled();
  });

  it('voice off: nothing (not prevented, no overlay, no mute)', () => {
    active = false;
    expect(key('keydown', BACKQUOTE).defaultPrevented).toBe(false);
    key('keyup', BACKQUOTE);
    key('keydown', { key: 'm', code: 'KeyM' });
    expect(show).not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled();
    expect(toggleMute).not.toHaveBeenCalled();
  });

  it('window blur closes a held overlay, once; the later keyup does nothing more', () => {
    key('keydown', BACKQUOTE);
    window.dispatchEvent(new Event('blur'));
    expect(hide).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('blur'));
    key('keyup', BACKQUOTE);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('blur and a stray keyup with nothing held do nothing', () => {
    window.dispatchEvent(new Event('blur'));
    key('keyup', BACKQUOTE);
    expect(hide).not.toHaveBeenCalled();
  });

  it('m toggles mute outside text fields', () => {
    key('keydown', { key: 'm', code: 'KeyM' });
    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it('uninstall removes every listener', () => {
    uninstall();
    key('keydown', BACKQUOTE);
    key('keydown', { key: 'm', code: 'KeyM' });
    expect(show).not.toHaveBeenCalled();
    expect(toggleMute).not.toHaveBeenCalled();
    uninstall = () => {};
  });
});

describe('voice hotkeys with the real overlay (kit modal)', () => {
  let uninstall;
  let lobbyBtn;

  beforeEach(() => {
    fakeVoice.active = true;
    uninstall = installVoiceHotkeys({
      isActive: () => fakeVoice.active, show: showVoiceOverlay, hide: removeVoiceOverlay, toggleMute: () => {},
    });
    lobbyBtn = document.createElement('button');
    lobbyBtn.textContent = 'Ready';
    document.body.appendChild(lobbyBtn);
    lobbyBtn.focus();
  });
  afterEach(() => {
    uninstall();
    removeVoiceOverlay();
    document.body.innerHTML = '';
  });

  it('Tab with voice on leaves the overlay closed and the page\'s focus handling alone', () => {
    expect(key('keydown', TAB).defaultPrevented).toBe(false);
    expect(document.getElementById('voice-overlay')).toBeNull();
  });

  it('hold ` opens it with its hint; focus moves in, keyup on the focused control still closes it and focus comes back', () => {
    key('keydown', BACKQUOTE);
    const overlay = document.getElementById('voice-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.voice-overlay__hint').textContent).toBe('Release ` to close');
    // the modal took focus (a control in the peer row: here the volume slider, an INPUT)
    const focused = document.activeElement;
    expect(overlay.contains(focused)).toBe(true);
    // auto-repeat lands on that input: still ours, not typed into it
    expect(key('keydown', { ...BACKQUOTE, repeat: true }).defaultPrevented).toBe(true);
    expect(openModalCount()).toBe(1);
    // keyup reaches the document from inside the dialog
    key('keyup', BACKQUOTE);
    expect(document.getElementById('voice-overlay')).toBeNull();
    expect(openModalCount()).toBe(0);
    expect(document.activeElement).toBe(lobbyBtn);
  });

  it('Escape closes it while held; the keyup after is harmless; the next press opens it again', () => {
    key('keydown', BACKQUOTE);
    key('keydown', { key: 'Escape', code: 'Escape' });
    expect(document.getElementById('voice-overlay')).toBeNull();
    key('keyup', BACKQUOTE);
    expect(openModalCount()).toBe(0);
    key('keydown', BACKQUOTE);
    expect(document.getElementById('voice-overlay')).not.toBeNull();
  });

  it('window blur closes it and removeVoiceOverlay stays idempotent', () => {
    key('keydown', BACKQUOTE);
    window.dispatchEvent(new Event('blur'));
    expect(document.getElementById('voice-overlay')).toBeNull();
    expect(() => { removeVoiceOverlay(); removeVoiceOverlay(); }).not.toThrow();
    expect(openModalCount()).toBe(0);
    expect(document.activeElement).toBe(lobbyBtn);
  });
});
