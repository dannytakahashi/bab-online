import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => ({ toggleSelfMute: () => false }) }));

const { createMuteButton, removeMuteButton, reattachMuteButton } = await import('./VoiceChatUI.js');
const { applyHudLayout, clearHud } = await import('../tableHud.js');
const { computeTableLayout, contains } = await import('../../phaser/layout/computeTableLayout.js');
const { getClientSession, resetClientSession, SCREEN, ROLE } = await import('../../state/ClientSession.js');
const { readClientFile } = await import('../../testing/files.js');
const { showGameLobby, removeGameLobby } = await import('../screens/GameLobby.js');

/** The session at a table (as gameStart / a rejoin leaves it). */
function sitDown(role = ROLE.PLAYER) {
  resetClientSession();
  getClientSession().enterTable(role);
}

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
    resetClientSession();
  });

  it('at a table: in the HUD voice slot under my HSI (device, then mute), sized by the layout, not the global 44 px rule', () => {
    sitDown();
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
    // a kit icon button drawn at the layout's size (--voice-btn: table.css), with a 44 px hit target
    const mute = document.getElementById('voice-mute-btn');
    expect(mute.classList.contains('kit-icon-btn')).toBe(true);
    expect(mute.classList.contains('voice-btn')).toBe(true);
    expect(mute.dataset.place).toBe('hud');
    expect(mute.getAttribute('aria-label')).toBe('Mute microphone (M)');
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    const css = readClientFile('styles/table.css');
    expect(css).toMatch(/\.voice-btn\.kit-icon-btn \{\s*--icon-btn-size: var\(--voice-btn/);
    // positioned (not static), so each button's 44 px hit extension stays on it
    expect(css).toMatch(/\.hud-voice > \.voice-btn \{[^}]*position: relative;/);
    expect(Array.from({ length: mute.style.length }, (_, i) => mute.style[i]).filter((k) => !k.startsWith('--'))).toEqual([]);
  });

  it('a spectator\'s slot is the table\'s bottom-right corner; a relayout moves it', () => {
    sitDown(ROLE.SPECTATOR);
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
    // (table.css: body > .voice-btn at the page's bottom right, --voice-right from the edge)
    expect([mute.dataset.place, mute.style.getPropertyValue('--voice-right')]).toEqual(['page', '20px']);
    expect([device.dataset.place, device.style.getPropertyValue('--voice-right')]).toEqual(['page', '62px']);
    expect(document.getElementById('table-hud')).toBeNull();
  });

  it('in the lobby a relayout (a resize, a tab return) leaves them at the page\'s bottom right', () => {
    // voice runs in the lobby; GameScene.relayout() runs on every resize
    // and tab return whatever the screen, and lays a HUD out
    resetClientSession();
    getClientSession().transition(SCREEN.MAIN_ROOM);
    getClientSession().transition(SCREEN.LOBBY);
    createMuteButton();
    applyHudLayout(computeTableLayout({ w: 1440, h: 900 }));
    reattachMuteButton();
    const mute = document.getElementById('voice-mute-btn');
    const device = document.getElementById('voice-device-btn');
    expect(mute.parentElement).toBe(document.body);
    expect(device.parentElement).toBe(document.body);
    expect([mute.dataset.place, mute.style.getPropertyValue('--voice-right')]).toEqual(['page', '20px']);
    expect([device.dataset.place, device.style.getPropertyValue('--voice-right')]).toEqual(['page', '62px']);
    expect(document.querySelector('.hud-voice')).toBeNull();
    // ...and they move into the slot once the table is up
    getClientSession().enterTable(ROLE.PLAYER);
    reattachMuteButton();
    expect(mute.parentElement.className).toBe('hud-voice');
  });

  it('under the score modal (game end) they stay in the table\'s slot', () => {
    sitDown();
    applyHudLayout(computeTableLayout({ w: 1120, h: 790 }));
    createMuteButton();
    getClientSession().transition(SCREEN.GAME_END);
    applyHudLayout(computeTableLayout({ w: 1000, h: 700 }));
    reattachMuteButton();
    expect(document.getElementById('voice-mute-btn').parentElement.className).toBe('hud-voice');
  });
});

describe('voice buttons in the full-window game lobby (its header, clear of Send)', () => {
  const socket = { emit: () => {} };
  const openLobby = () => showGameLobby({ lobbyId: 'L1', players: [{ username: 'me', ready: false }], messages: [] }, socket, 'me');
  const ids = (node) => [...node.children].map((b) => b.id);
  beforeEach(() => {
    resetClientSession();
    getClientSession().transition(SCREEN.MAIN_ROOM);
    getClientSession().transition(SCREEN.LOBBY);
  });
  afterEach(() => {
    removeMuteButton();
    removeGameLobby();
    clearHud();
    document.body.replaceChildren();
    resetClientSession();
  });

  it('voice started in the lobby: in the lobby header\'s slot (device, then mute), not the window corner over the chat\'s Send', () => {
    openLobby();
    createMuteButton(); // startVoice resolves after the lobby is shown
    const slot = document.querySelector('#gameLobbyContainer > .screen-header > #lobbyVoiceSlot');
    expect(slot).not.toBeNull();
    expect(ids(slot)).toEqual(['voice-device-btn', 'voice-mute-btn']);
    expect(document.querySelector('body > .voice-btn')).toBeNull();
    expect(document.getElementById('voice-mute-btn').dataset.place).toBe('lobby');
    // nowhere near the chat column (and so its Send)
    expect(document.querySelector('#gameLobbyContainer .screen-chat .voice-btn')).toBeNull();
    // a relayout (GameScene runs it on every resize) leaves them there
    applyHudLayout(computeTableLayout({ w: 1440, h: 900 }));
    reattachMuteButton();
    expect(ids(slot)).toEqual(['voice-device-btn', 'voice-mute-btn']);
  });

  it('a re-render (a reconnect\'s lobbyJoined) carries them into the new lobby, not behind it', () => {
    openLobby();
    createMuteButton();
    const mute = document.getElementById('voice-mute-btn');
    openLobby();
    const containers = document.querySelectorAll('#gameLobbyContainer');
    expect(containers.length).toBe(1);
    expect(ids(document.getElementById('lobbyVoiceSlot'))).toEqual(['voice-device-btn', 'voice-mute-btn']);
    expect(document.getElementById('voice-mute-btn')).toBe(mute);
    expect(containers[0].contains(mute)).toBe(true);
  });

  it('the lobby gives way to its game: they outlive it and move into the table\'s HUD slot', () => {
    openLobby();
    createMuteButton();
    removeGameLobby(); // the LOBBY exit hook; voice carries on into the game
    const mute = document.getElementById('voice-mute-btn');
    const device = document.getElementById('voice-device-btn');
    expect([mute?.parentElement, device?.parentElement]).toEqual([document.body, document.body]);
    expect([mute.style.getPropertyValue('--voice-right'), device.style.getPropertyValue('--voice-right')]).toEqual(['20px', '62px']);
    const table = document.createElement('div');
    table.id = 'game-container';
    document.body.appendChild(table);
    getClientSession().enterTable(ROLE.PLAYER);
    applyHudLayout(computeTableLayout({ w: 1120, h: 790 }));
    reattachMuteButton();
    expect(ids(document.querySelector('#table-hud > .hud-voice'))).toEqual(['voice-device-btn', 'voice-mute-btn']);
  });

  it('table.css: the slot\'s buttons sit in the header row (not the window-corner absolute rule)', () => {
    const css = readClientFile('styles/table.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const slotRule = css.match(/\.lobby-voice > \.voice-btn\s*\{([^}]*)\}/)?.[1] || '';
    expect(slotRule).toMatch(/position:\s*relative/);
    expect(css).toMatch(/\.lobby-voice\s*\{[^}]*display:\s*flex/);
  });
});
