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
}

export function removeMuteButton() {
  const existing = document.getElementById('voice-mute-btn');
  if (existing) existing.remove();
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

      const muteBtn = document.createElement('button');
      muteBtn.style.cssText = `
        border: none; border-radius: 6px; color: #fff;
        padding: 4px 8px; cursor: pointer; font-size: 12px; flex-shrink: 0;
      `;
      const entryId = entry.id;
      const isSelf = entry.isSelf;
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
      _overlayRows.set(entry.id, { row, dot, muteBtn, isSelf: entry.isSelf });
    }

    // Update dynamic state (speaking, muted) on existing elements
    const els = _overlayRows.get(entry.id);
    const isSpeaking = voiceManager.isSpeaking(entry.id);
    const isMuted = entry.isSelf ? voiceManager.selfMuted : voiceManager.isPeerMuted(entry.id);

    els.row.style.background = isSpeaking ? 'rgba(74, 222, 128, 0.15)' : 'rgba(255, 255, 255, 0.05)';
    els.dot.style.background = isSpeaking ? '#4ade80' : '#444';
    els.muteBtn.textContent = isMuted ? 'Unmute' : 'Mute';
    els.muteBtn.style.background = isMuted ? 'rgba(220, 38, 38, 0.6)' : 'rgba(255, 255, 255, 0.1)';
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
