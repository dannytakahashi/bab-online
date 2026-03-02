/**
 * Voice Chat UI Components
 *
 * A. Mute button - circular button fixed bottom-right
 * B. Tab overlay - player list with speaking indicators and per-player mute
 */

import { getVoiceChatManager } from '../../voice/VoiceChatManager.js';
import { getSocketManager } from '../../socket/SocketManager.js';
import { getGameState } from '../../state/GameState.js';

// ============================================
// Mute Button
// ============================================

/**
 * Create the voice mute toggle button.
 */
export function createMuteButton() {
  removeMuteButton();

  const voiceManager = getVoiceChatManager();
  const btn = document.createElement('button');
  btn.id = 'voice-mute-btn';
  btn.innerHTML = getMicIcon(false);
  btn.title = 'Toggle microphone (M)';
  btn.style.cssText = `
    position: absolute;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.3);
    background: rgba(30, 30, 50, 0.8);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
    padding: 0;
    z-index: 300;
  `;

  btn.addEventListener('click', () => {
    const muted = voiceManager.toggleSelfMute();
    btn.innerHTML = getMicIcon(muted);
    btn.style.background = muted ? 'rgba(220, 38, 38, 0.8)' : 'rgba(30, 30, 50, 0.8)';
  });

  // Position below the HSI box if it exists, otherwise use fallback
  _positionMuteButton(btn);
  document.body.appendChild(btn);

  // Create the device selector button alongside
  createDeviceButton();

  return btn;
}

/**
 * Position the mute button below the HSI box, or fallback to bottom-right.
 */
function _positionMuteButton(btn) {
  const hsiBox = document.getElementById('player-hsi-box');
  if (hsiBox) {
    const rect = hsiBox.getBoundingClientRect();
    btn.style.left = `${rect.left + rect.width / 2 - 18}px`;
    btn.style.top = `${rect.bottom + 6}px`;
  } else {
    btn.style.bottom = '20px';
    btn.style.right = '20px';
    btn.style.top = '';
    btn.style.left = '';
  }
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

  const btn = document.createElement('button');
  btn.id = 'voice-device-btn';
  btn.innerHTML = getGearIcon();
  btn.title = 'Select microphone';
  btn.style.cssText = `
    position: absolute;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.3);
    background: rgba(30, 30, 50, 0.8);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s;
    padding: 0;
    z-index: 300;
  `;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDevicePopover();
  });

  _positionDeviceButton(btn);
  document.body.appendChild(btn);
  return btn;
}

function _positionDeviceButton(btn) {
  const muteBtn = document.getElementById('voice-mute-btn');
  if (muteBtn) {
    const rect = muteBtn.getBoundingClientRect();
    btn.style.left = `${rect.left - 42}px`;
    btn.style.top = `${rect.top}px`;
    btn.style.bottom = '';
    btn.style.right = '';
  } else {
    btn.style.bottom = '20px';
    btn.style.right = '62px';
    btn.style.top = '';
    btn.style.left = '';
  }
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

  const popover = document.createElement('div');
  popover.id = 'voice-device-popover';
  popover.style.cssText = `
    position: absolute;
    background: #1a1a2e;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    padding: 6px 0;
    min-width: 200px;
    max-width: 300px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    z-index: 400;
  `;

  for (const device of devices) {
    const item = document.createElement('div');
    const isActive = device.deviceId === activeId;
    item.style.cssText = `
      padding: 8px 14px;
      color: ${isActive ? '#4ade80' : '#fff'};
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 8px;
    `;
    item.innerHTML = `<span style="flex-shrink:0">${isActive ? '&#10003;' : '&nbsp;&nbsp;'}</span><span style="overflow:hidden;text-overflow:ellipsis">${device.label}</span>`;
    item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.1)'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
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

  // Position above the device button, right-aligned so it doesn't overflow left
  const btn = document.getElementById('voice-device-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    popover.style.right = `${window.innerWidth - rect.right}px`;
    popover.style.left = '';
    popover.style.top = '';
    popover.style.bottom = `${window.innerHeight - rect.top + 6}px`;
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

/**
 * Show the voice overlay (called on Tab press).
 */
export function showVoiceOverlay() {
  removeVoiceOverlay();

  const voiceManager = getVoiceChatManager();
  if (!voiceManager.active) return;

  const overlay = document.createElement('div');
  overlay.id = 'voice-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
  `;

  const panel = document.createElement('div');
  panel.style.cssText = `
    background: #1a1a2e;
    border-radius: 12px;
    padding: 24px;
    min-width: 280px;
    max-width: 400px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  `;

  const title = document.createElement('h3');
  title.textContent = 'Voice Chat';
  title.style.cssText = 'margin: 0 0 16px 0; color: #fff; text-align: center;';
  panel.appendChild(title);

  const playerList = document.createElement('div');
  playerList.id = 'voice-overlay-players';
  panel.appendChild(playerList);

  const hint = document.createElement('p');
  hint.textContent = 'Release Tab to close';
  hint.style.cssText = 'margin: 16px 0 0 0; color: #666; text-align: center; font-size: 12px;';
  panel.appendChild(hint);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Initial render + start polling
  updateOverlayPlayers();
  overlayUpdateInterval = setInterval(updateOverlayPlayers, SPEAKING_POLL_UI);
}

const SPEAKING_POLL_UI = 100;

// Track overlay rows so we update in-place instead of recreating
let _overlayRows = new Map(); // id → { row, dot, muteBtn }

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
      // Create row once
      const row = document.createElement('div');
      row.style.cssText = `
        display: flex; align-items: center; padding: 8px 12px;
        margin-bottom: 4px; border-radius: 8px; transition: background 0.15s;
      `;

      const dot = document.createElement('div');
      dot.style.cssText = `
        width: 10px; height: 10px; border-radius: 50%;
        margin-right: 10px; transition: background 0.15s; flex-shrink: 0;
      `;
      row.appendChild(dot);

      const name = document.createElement('span');
      name.textContent = entry.username + (entry.isSelf ? ' (You)' : '');
      name.style.cssText = 'color: #fff; flex: 1; font-size: 14px;';
      row.appendChild(name);

      let slider = null;
      let volLabel = null;
      const entryId = entry.id;
      const isSelf = entry.isSelf;

      // Volume slider for remote peers only
      if (!isSelf) {
        const sliderWrap = document.createElement('div');
        sliderWrap.style.cssText = 'display: flex; align-items: center; margin-right: 8px; flex-shrink: 0;';

        slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '200';
        slider.value = String(Math.round(voiceManager.getPeerVolume(entryId) * 100));
        slider.style.cssText = 'width: 80px; accent-color: #4ade80; cursor: pointer;';

        volLabel = document.createElement('span');
        volLabel.textContent = slider.value + '%';
        volLabel.style.cssText = 'color: #aaa; font-size: 11px; width: 36px; text-align: right; margin-left: 4px;';

        slider.addEventListener('input', () => {
          const pct = Number(slider.value);
          voiceManager.setPeerVolume(entryId, pct / 100);
          volLabel.textContent = pct + '%';
        });

        sliderWrap.appendChild(slider);
        sliderWrap.appendChild(volLabel);
        row.appendChild(sliderWrap);
      }

      const muteBtn = document.createElement('button');
      muteBtn.style.cssText = `
        border: none; border-radius: 6px; color: #fff;
        padding: 4px 8px; cursor: pointer; font-size: 12px; flex-shrink: 0;
      `;
      muteBtn.addEventListener('click', () => {
        if (isSelf) {
          const muted = voiceManager.toggleSelfMute();
          const mainBtn = document.getElementById('voice-mute-btn');
          if (mainBtn) {
            mainBtn.innerHTML = getMicIcon(muted);
            mainBtn.style.background = muted ? 'rgba(220, 38, 38, 0.8)' : 'rgba(30, 30, 50, 0.8)';
          }
        } else {
          if (voiceManager.isPeerMuted(entryId)) {
            voiceManager.unmutePeer(entryId);
          } else {
            voiceManager.mutePeer(entryId);
          }
        }
      });
      row.appendChild(muteBtn);

      container.appendChild(row);
      _overlayRows.set(entry.id, { row, dot, muteBtn, slider, volLabel, isSelf });
    }

    // Update dynamic state (speaking, muted) on existing elements
    const els = _overlayRows.get(entry.id);
    const isSpeaking = voiceManager.isSpeaking(entry.id);
    const isMuted = entry.isSelf ? voiceManager.selfMuted : voiceManager.isPeerMuted(entry.id);

    els.row.style.background = isSpeaking ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255, 255, 255, 0.05)';
    els.dot.style.background = isSpeaking ? '#4ade80' : '#444';
    els.muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    els.muteBtn.style.background = isMuted ? 'rgba(220, 38, 38, 0.6)' : 'rgba(255, 255, 255, 0.1)';

    // Dim slider when muted
    if (els.slider) {
      els.slider.style.opacity = isMuted ? '0.4' : '1';
    }
    if (els.volLabel) {
      els.volLabel.style.opacity = isMuted ? '0.4' : '1';
    }
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
  const existing = document.getElementById('voice-overlay');
  if (existing) existing.remove();
}
