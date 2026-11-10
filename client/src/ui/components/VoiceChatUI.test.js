import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => ({ toggleSelfMute: () => false }) }));

const { createMuteButton, removeMuteButton, reattachMuteButton } = await import('./VoiceChatUI.js');
const { applyHudLayout, clearHud } = await import('../tableHud.js');
const { computeTableLayout, contains } = await import('../../phaser/layout/computeTableLayout.js');

describe('voice buttons (ui-20)', () => {
  let container;
  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'game-container';
    document.body.appendChild(container);
  });
  afterEach(() => {
    removeMuteButton();
    clearHud();
    container.remove();
  });

  it('at a table: in the HUD voice slot under my HSI (device, then mute), sized by the layout, not the global 44 px rule', () => {
    const L = computeTableLayout({ w: 1120, h: 790 });
    applyHudLayout(L);
    createMuteButton();
    const slot = document.querySelector('#table-hud > .hud-voice');
    expect([...slot.children].map((b) => b.id)).toEqual(['voice-device-btn', 'voice-mute-btn']);
    const hud = document.getElementById('table-hud');
    expect(hud.style.getPropertyValue('--voice-x')).toBe(`${L.voice.rect.x}px`);
    expect(hud.style.getPropertyValue('--voice-y')).toBe(`${L.voice.rect.y}px`);
    // the slot is my box's last row, inside the canvas, clear of the log column
    expect(contains(L.seats.self.block, L.voice.rect)).toBe(true);
    expect(L.voice.rect.x + L.voice.rect.w).toBeLessThanOrEqual(L.w);
    const mute = document.getElementById('voice-mute-btn');
    expect(mute.style.position).toBe('static');
    expect(parseFloat(mute.style.minWidth)).toBe(0);
    expect(parseFloat(mute.style.minHeight)).toBe(0);
  });

  it('a spectator\'s slot is the table\'s bottom-right corner; a relayout moves it', () => {
    applyHudLayout(computeTableLayout({ w: 1120, h: 790, isSpectator: true }));
    createMuteButton();
    const hud = document.getElementById('table-hud');
    const before = hud.style.getPropertyValue('--voice-x');
    const L = computeTableLayout({ w: 800, h: 600, isSpectator: true });
    applyHudLayout(L);
    reattachMuteButton();
    expect(hud.style.getPropertyValue('--voice-x')).not.toBe(before);
    expect(hud.style.getPropertyValue('--voice-x')).toBe(`${L.voice.rect.x}px`);
    expect(document.getElementById('voice-mute-btn').parentElement.className).toBe('hud-voice');
  });

  it('with no table (the lobby): the page\'s bottom-right corner', () => {
    createMuteButton();
    const mute = document.getElementById('voice-mute-btn');
    const device = document.getElementById('voice-device-btn');
    expect(mute.parentElement).toBe(document.body);
    expect([mute.style.bottom, mute.style.right]).toEqual(['20px', '20px']);
    expect([device.style.bottom, device.style.right]).toEqual(['20px', '62px']);
    expect(document.getElementById('table-hud')).toBeNull();
  });
});
