/**
 * Voice Chat UI Components
 *
 * A. Mute button (and the microphone picker beside it): at the table, in
 *    the HUD's voice slot (ui/tableHud.js; under my HSI box, or the table's
 *    bottom-right corner for a spectator), sized by the layout; elsewhere
 *    in the game lobby, in its header's voice slot (the full-window lobby's
 *    chat and Send fill the window's bottom-right corner); with neither, at
 *    the page's bottom right (ui-20: the fallback used to sit under the game
 *    log, and the global 44 px button rule pushed it off centre)
 * B. Tab overlay - player list with speaking indicators and per-player mute
 */

import { getVoiceChatManager } from '../../voice/VoiceChatManager.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { getGameState } from '../../state/GameState.js';
import { hudVoiceSlot, hudLayout } from '../tableHud.js';
import { getClientSession, SCREEN } from '../../state/ClientSession.js';
import { el, createButton, createIconButton, openModal } from '../kit/index.js';
import { LOBBY_VOICE_SLOT_ID } from '../screens/GameLobby.js';

/*
 * The buttons are kit icon buttons (.kit-icon-btn.voice-btn, table.css):
 * drawn at the layout's size in the HUD slot (--voice-btn) with a 44 px hit
 * target, or at the page's bottom right off the table (--voice-right). The
 * mute state is aria-pressed (the red look is CSS).
 */

/** Show the mute state on the button (icon, pressed state, label). */
function showMuted(btn, muted) {
  if (!btn) return;
  btn.innerHTML = getMicIcon(muted);
  btn.setAttribute('aria-pressed', String(!!muted));
  btn.setAttribute('aria-label', muted ? 'Unmute microphone (M)' : 'Mute microphone (M)');
}

/**
 * Put a voice button in the table's voice slot (device first, then mute),
 * else the game lobby header's slot, else the page's bottom right.
 * @returns {boolean} whether it is in the slot
 */
/**
 * At a table (or its score modal): the voice slot is the table's. A layout
 * alone does not say so: GameScene relayouts on every resize and tab
 * return, the lobby too (voice runs there).
 */
function atTable() {
  const screen = getClientSession().screen;
  return screen === SCREEN.TABLE || screen === SCREEN.GAME_END;
}

/** In a slot (a flex row): the device button left of the mute button. */
function orderInSlot(slot) {
  const mute = slot.querySelector('#voice-mute-btn');
  const device = slot.querySelector('#voice-device-btn');
  if (mute && device && device.nextSibling !== mute) slot.insertBefore(device, mute);
}

function placeVoiceButton(btn, { rightOffset }) {
  // only at a table the HUD has laid out (not the lobby)
  const slot = atTable() && hudLayout() ? hudVoiceSlot({ create: true }) : null;
  if (slot) {
    if (btn.parentElement !== slot) slot.appendChild(btn);
    orderInSlot(slot);
    btn.dataset.place = 'hud';
    return true;
  }
  // Off the table, the game lobby's own voice slot (its header, GameLobby.js):
  // the full-window lobby's chat column, and its Send, end in the window's
  // bottom-right corner, and the lobby is a window-sized layer at the same
  // z-index, so a body-level button there would cover Send or be covered
  // (table.css: body > .voice-btn sits at the page's bottom right; kept
  // set in the lobby slot too, for when the lobby goes and they fall back)
  btn.style.setProperty('--voice-right', `${rightOffset}px`);
  const lobbySlot = atTable() ? null : document.getElementById(LOBBY_VOICE_SLOT_ID);
  if (lobbySlot) {
    if (btn.parentElement !== lobbySlot) lobbySlot.appendChild(btn);
    orderInSlot(lobbySlot);
    btn.dataset.place = 'lobby';
    return false;
  }
  if (btn.parentElement !== document.body) document.body.appendChild(btn);
  btn.dataset.place = 'page';
  return false;
}

// ============================================
// Mute Button
// ============================================

/** Show a mute state on the page's mute button (the M key, the overlay). */
export function setMuteButtonState(muted) {
  showMuted(document.getElementById('voice-mute-btn'), muted);
}

/**
 * Create the voice mute toggle button.
 */
export function createMuteButton() {
  removeMuteButton();

  const voiceManager = getVoiceChatManager();
  const btn = createIconButton({ icon: getMicIcon(false), label: 'Mute microphone (M)', className: 'voice-btn', pressed: false });
  btn.id = 'voice-mute-btn';
  btn.title = 'Toggle microphone (M)';

  btn.addEventListener('click', () => {
    showMuted(btn, voiceManager.toggleSelfMute());
  });

  // The table's voice slot, else the page's corner
  _positionMuteButton(btn);

  // Create the device selector button alongside
  createDeviceButton();

  return btn;
}

/**
 * The mute button's place: the table's voice slot, the lobby's, else bottom-right.
 */
function _positionMuteButton(btn) {
  placeVoiceButton(btn, { rightOffset: 20 });
}

/**
 * Reposition the mute button below the HSI box (call after avatar is created or on resize).
 */
export function reattachMuteButton() {
  const btn = document.getElementById('voice-mute-btn');
  if (!btn) return;
  _positionMuteButton(btn);
  reattachDeviceButton();
}

export function removeMuteButton() {
  const existing = document.getElementById('voice-mute-btn');
  if (existing) existing.remove();
  removeDeviceButton();
}

// ============================================
// Device Selector Button + Popover
// ============================================

export function createDeviceButton() {
  removeDeviceButton();

  const btn = createIconButton({ icon: getGearIcon(), label: 'Select microphone', className: 'voice-btn' });
  btn.id = 'voice-device-btn';
  btn.setAttribute('aria-haspopup', 'menu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDevicePopover();
  });

  _positionDeviceButton(btn);
  return btn;
}

function _positionDeviceButton(btn) {
  // left of the mute button (42 px: one button and a gap)
  placeVoiceButton(btn, { rightOffset: 62 });
}

export function reattachDeviceButton() {
  const btn = document.getElementById('voice-device-btn');
  if (!btn) return;
  _positionDeviceButton(btn);
}

function removeDeviceButton() {
  removeDevicePopover();
  const existing = document.getElementById('voice-device-btn');
  if (existing) existing.remove();
}

async function toggleDevicePopover() {
  if (document.getElementById('voice-device-popover')) {
    removeDevicePopover();
    return;
  }

  const voiceManager = getVoiceChatManager();
  const devices = await voiceManager.getAudioDevices();
  if (devices.length === 0) return;

  const activeId = voiceManager.getActiveDeviceId();

  const popover = el('div', { className: 'voice-popover', attrs: { id: 'voice-device-popover', role: 'menu' } });

  for (const device of devices) {
    const isActive = device.deviceId === activeId;
    // (hover is CSS: .voice-popover__item:hover)
    const item = el('div', {
      className: `voice-popover__item${isActive ? ' is-active' : ''}`,
      attrs: { role: 'menuitemradio', 'aria-checked': String(isActive), tabindex: '0' },
      children: [
        el('span', { className: 'voice-popover__mark', text: isActive ? '\u2713' : '' }),
        // Device labels come from hardware names (e.g. Bluetooth), so not markup
        el('span', { className: 'voice-popover__label', text: device.label }),
      ],
    });
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!isActive) {
        try {
          await voiceManager.switchAudioDevice(device.deviceId);
        } catch (err) {
          console.warn('[Voice] switchAudioDevice failed:', err.message);
        }
      }
      removeDevicePopover();
    });
    popover.appendChild(item);
  }

  // Divider
  popover.appendChild(el('div', { className: 'voice-popover__divider' }));

  // Speaker test button
  const testBtn = el('div', { className: 'voice-popover__item is-muted', attrs: { role: 'menuitem', tabindex: '0' } });
  const speaker = el('span', { className: 'voice-popover__mark' });
  speaker.innerHTML = getSpeakerIcon();
  testBtn.append(speaker, el('span', { text: 'Test Speakers' }));
  testBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    voiceManager.playTestTone();
  });
  popover.appendChild(testBtn);

  // Position above the device button, right-aligned so it doesn't overflow left
  const btn = document.getElementById('voice-device-btn');
  if (btn) {
    // its anchor (dynamic geometry: CSS variables, table.css .voice-popover)
    const rect = btn.getBoundingClientRect();
    popover.style.setProperty('--pop-right', `${window.innerWidth - rect.right}px`);
    if (btn.dataset.place === 'lobby') {
      // the lobby's slot is in its header, at the top: open downwards
      popover.classList.add('voice-popover--below');
      popover.style.setProperty('--pop-top', `${rect.bottom + 6}px`);
    } else {
      popover.style.setProperty('--pop-bottom', `${window.innerHeight - rect.top + 6}px`);
    }
  }

  document.body.appendChild(popover);

  // Close on outside click
  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target.id !== 'voice-device-btn') {
      removeDevicePopover();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function removeDevicePopover() {
  const existing = document.getElementById('voice-device-popover');
  if (existing) existing.remove();
}

function getGearIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>`;
}

function getSpeakerIcon() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
  </svg>`;
}

function getMicIcon(muted) {
  if (muted) {
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"></line>
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
      <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>`;
  }
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line x1="12" y1="19" x2="12" y2="23"></line>
    <line x1="8" y1="23" x2="16" y2="23"></line>
  </svg>`;
}

// ============================================
// Tab Overlay
// ============================================

let overlayUpdateInterval = null;

/** The voice overlay's modal (kit). */
let voiceModal = null;

/**
 * Show the voice overlay (called on Tab press): a kit modal (Escape closes
 * it too; focus comes back where it was).
 */
export function showVoiceOverlay() {
  removeVoiceOverlay();

  const voiceManager = getVoiceChatManager();
  if (!voiceManager.active) return;

  const playerList = el('div', { attrs: { id: 'voice-overlay-players' } });
  const hint = el('p', { className: 'voice-overlay__hint', text: 'Release Tab to close' });
  voiceModal = openModal({
    id: 'voice-overlay',
    title: 'Voice Chat',
    body: [playerList, hint],
    dismissible: true,
    className: 'voice-overlay-panel',
    onClose: () => {
      voiceModal = null;
      removeVoiceOverlay();
    },
  });
  voiceModal.backdrop.classList.add('voice-overlay');

  // Initial render + start polling
  updateOverlayPlayers();
  overlayUpdateInterval = setInterval(updateOverlayPlayers, SPEAKING_POLL_UI);
}

const SPEAKING_POLL_UI = 100;

// Track overlay rows so we update in-place instead of recreating
let _overlayRows = new Map(); // id → { row, muteBtn, slider, unavailableBadge }

function updateOverlayPlayers() {
  const container = document.getElementById('voice-overlay-players');
  if (!container) return;

  const voiceManager = getVoiceChatManager();
  const socketManager = getSocketManager();
  const gameState = getGameState();

  // Build current entry list
  const entries = [];
  entries.push({
    id: 'self',
    username: gameState.username || socketManager.username || 'You',
    isSelf: true
  });
  for (const peer of voiceManager.getPeers()) {
    entries.push({ id: peer.socketId, username: peer.username, isSelf: false });
  }

  // Create rows for new entries, remove stale ones
  const currentIds = new Set(entries.map(e => e.id));
  for (const [id, els] of _overlayRows) {
    if (!currentIds.has(id)) {
      els.row.remove();
      _overlayRows.delete(id);
    }
  }

  for (const entry of entries) {
    if (!_overlayRows.has(entry.id)) {
      // Create row once (its states are classes: table.css .voice-row)
      const row = el('div', { className: 'voice-row' });
      row.appendChild(el('div', { className: 'voice-row__dot' }));

      const name = el('span', { className: 'voice-row__name', text: entry.username + (entry.isSelf ? ' (You)' : '') });
      // Shown when the connection failed for good (after its one restart)
      const unavailableBadge = el('span', {
        className: 'voice-row__unavailable',
        text: 'voice unavailable',
        attrs: { title: 'Voice could not connect to this player' },
      });
      name.appendChild(unavailableBadge);
      row.appendChild(name);

      let slider = null;
      const entryId = entry.id;
      const isSelf = entry.isSelf;

      // Volume slider for remote peers only
      if (!isSelf) {
        slider = el('input', { className: 'voice-row__slider', attrs: { type: 'range', min: '0', max: '200', 'aria-label': `${entry.username} volume` } });
        slider.value = String(Math.round(voiceManager.getPeerVolume(entryId) * 100));
        const volLabel = el('span', { className: 'voice-row__pct', text: `${slider.value}%` });
        slider.addEventListener('input', () => {
          const pct = Number(slider.value);
          voiceManager.setPeerVolume(entryId, pct / 100);
          volLabel.textContent = pct + '%';
        });
        row.appendChild(el('div', { className: 'voice-row__volume', children: [slider, volLabel] }));
      }

      const muteBtn = createButton({ label: 'Mute', variant: 'secondary', size: 'sm' });
      muteBtn.addEventListener('click', () => {
        if (isSelf) {
          showMuted(document.getElementById('voice-mute-btn'), voiceManager.toggleSelfMute());
        } else if (voiceManager.isPeerMuted(entryId)) {
          voiceManager.unmutePeer(entryId);
        } else {
          voiceManager.mutePeer(entryId);
        }
      });
      row.appendChild(muteBtn);

      container.appendChild(row);
      _overlayRows.set(entry.id, { row, muteBtn, slider, unavailableBadge, isSelf });
    }

    // Update dynamic state (speaking, muted) on existing elements
    const els = _overlayRows.get(entry.id);
    const isSpeaking = voiceManager.isSpeaking(entry.id);
    const isMuted = entry.isSelf ? voiceManager.selfMuted : voiceManager.isPeerMuted(entry.id);

    els.row.classList.toggle('is-speaking', !!isSpeaking);
    els.row.classList.toggle('is-muted', !!isMuted);
    els.muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    els.muteBtn.classList.toggle('kit-btn--danger', !!isMuted);
    els.muteBtn.classList.toggle('kit-btn--secondary', !isMuted);

    const unavailable = !entry.isSelf && !!voiceManager.isUnavailable?.(entry.id);
    els.row.classList.toggle('is-unavailable', unavailable);
    els.unavailableBadge.classList.toggle('is-on', unavailable);
  }
}

/**
 * Remove the voice overlay (called on Tab release).
 */
export function removeVoiceOverlay() {
  if (overlayUpdateInterval) {
    clearInterval(overlayUpdateInterval);
    overlayUpdateInterval = null;
  }
  _overlayRows.clear();
  if (voiceModal) {
    const m = voiceModal;
    voiceModal = null;
    m.close('api');
  }
  const existing = document.getElementById('voice-overlay');
  if (existing) existing.remove();
}
