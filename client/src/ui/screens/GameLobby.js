/**
 * Game Lobby Screen
 *
 * Pre-game lobby where players gather, chat, and ready up before starting.
 * Kit classes and tokens only (styles/screens.css, item 18b).
 *
 * Family lobbies (owner 2026-11-16; docs/claude/web-client.md, Game lobby):
 * a lobby holds up to 8 people while every member's app can (`capacity` 8;
 * else 4). The first 4 to tap Ready play and everyone else watches the
 * game, in its chat and voice. Every lobby payload this bundle gets carries
 * `members` (everyone, with `playing` and `reconnecting`), `host`,
 * `settings` {spectatorsCanTalk} and `capacity` next to the frozen 4-entry
 * `players`; a payload without `members` (an older server) renders as
 * before. Spectators always may talk (owner 2026-11-18: the host's
 * "Spectators can talk" switch is gone, `settings` is always on), so the
 * family lobby's voice section is one line saying so.
 *
 * Play again (owner 2026-11-16): a lobby reopened after its game keeps a
 * place for the last game's players who are not back yet. A held row
 * (`members[].returning`) shows "Not back yet"; the older-app players whose
 * place is saved without a row (`expected`) are listed under the rows the
 * same way; the host (anyone present while the host is away) may give
 * either up with "Don't wait" (releaseLobbyHold). Add Bot stays hidden
 * while members + expected fill the table (the server refuses it then).
 * A member back in the lobby whose app still shows the last game's results
 * (`members[].onResults`: no Return to Lobby yet) reads "Still on the
 * results" in the same style, never on one's own row and with no "Don't
 * wait" (they are present and connected, and voice reaches them).
 */

import { generateDistinctColor } from '../../utils/colors.js';
import { el, createButton, createIconButton, createPanel } from '../kit/index.js';
import { chatLine, chatForm, setButtonVariant, appendChatLine, scrollChatToEnd, followChatOnResize } from './common.js';

/** The lobby header's voice slot (VoiceChatUI.js places the voice buttons in it). */
export const LOBBY_VOICE_SLOT_ID = 'lobbyVoiceSlot';

/** The table's size: the first 4 to tap Ready play. */
const TABLE = 4;

/**
 * Module state.
 */
let lobbyUserColors = {};
let currentLobbyId = null;
let isPlayerReady = false;
// Players whose seat the server holds while they reconnect (a reload or a
// short drop: GameManager.LOBBY_SEAT_GRACE_MS). playerReadyUpdate and
// lobbyCreated carry the list while one is held (absent: none);
// lobbyPlayerJoined / lobbyPlayerLeft drop the player who came back or left
let reconnecting = new Set();
// Play again: held rows of the last game's players not back yet
// (members[].returning), and its older-app players with a saved place
// (expected, no row)
let returning = new Set();
let expected = [];
// Members back in the lobby whose app still shows the last game's results
// (members[].onResults)
let onResults = new Set();
// The family-lobby view of the last payload with `members` (null: a payload
// without them, drawn as before): capacity, host, settings, and the counts
// the Ready button reads
let lobbyView = null;
let lastMemberCount = 0;
let tableFullForMe = false;

const REMOVE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';

function colorFor(username) {
  if (!lobbyUserColors[username]) {
    lobbyUserColors[username] = generateDistinctColor(username, Object.values(lobbyUserColors));
  }
  return lobbyUserColors[username];
}

/**
 * The Ready button's look for its state (waiting / table full / ready /
 * not ready). `watching`: the table filled with others first (a family
 * lobby): this member will watch the game.
 */
function renderReadyButton(readyBtn, playerCount, { watching = false } = {}) {
  if (!readyBtn) return;
  readyBtn.removeAttribute('title');
  if (playerCount < TABLE) {
    // Not enough players - disable button
    readyBtn.disabled = true;
    setButtonVariant(readyBtn, 'secondary');
    readyBtn.classList.remove('is-on');
    readyBtn.textContent = `Waiting for ${TABLE - playerCount} more...`;
  } else if (watching && !isPlayerReady) {
    readyBtn.disabled = true;
    setButtonVariant(readyBtn, 'secondary');
    readyBtn.classList.remove('is-on');
    readyBtn.textContent = 'Table full — you\'ll watch';
    readyBtn.title = 'The first 4 to tap Ready play; you will watch this game and can join its voice chat';
  } else if (isPlayerReady) {
    readyBtn.disabled = false;
    setButtonVariant(readyBtn, 'secondary');
    readyBtn.classList.add('is-on');
    readyBtn.textContent = 'Ready!';
  } else {
    readyBtn.disabled = false;
    setButtonVariant(readyBtn, 'primary');
    readyBtn.classList.remove('is-on');
    readyBtn.textContent = 'Ready';
  }
  readyBtn.setAttribute('aria-pressed', String(playerCount >= TABLE && isPlayerReady));
}

/**
 * The members a payload lists: `members` (a family lobby: everyone, up to
 * 8), else the frozen `players` (at most 4). Also records the lobby's
 * capacity / host / settings for the header, the rows and the switch.
 */
function membersOf(players, lobby) {
  if (lobby && Array.isArray(lobby.members)) {
    lobbyView = {
      capacity: Number.isInteger(lobby.capacity) ? lobby.capacity : TABLE,
      host: typeof lobby.host === 'string' ? lobby.host : null,
      settings: lobby.settings && typeof lobby.settings === 'object' ? { spectatorsCanTalk: lobby.settings.spectatorsCanTalk !== false } : null,
    };
    // present only while one stands: absent means none
    expected = Array.isArray(lobby.expected) ? lobby.expected.filter((n) => typeof n === 'string' && n) : [];
    return lobby.members;
  }
  lobbyView = null;
  expected = [];
  return Array.isArray(players) ? players : [];
}

/**
 * "Don't wait for <name>" (play again: a held row or an expected player):
 * the host's, or anyone's present while the host is away. The visible
 * label is short (the row names the player); the accessible name is whole.
 */
function releaseButton(username) {
  return createButton({
    label: 'Don\'t wait',
    variant: 'ghost',
    size: 'sm',
    className: 'seat-release',
    attrs: { 'aria-label': `Don't wait for ${username}`, title: `Don't wait for ${username}`, 'data-release-hold': username },
  });
}

/** "Playing" / "Will watch" / "Sitting out" for a family lobby of more than 4; null otherwise. */
function roleOf(member, { wide, tableFull }) {
  if (!wide) return null;
  if (member.isBot && !member.playing) return 'Sitting out';
  if (member.playing && tableFull) return 'Playing';
  if (!member.playing && tableFull) return 'Will watch';
  return null;
}

/**
 * Update the players list in the lobby.
 *
 * @param {HTMLElement|null} container - Container element (or null to find by ID)
 * @param {Array} players - The payload's `players` (the first 4)
 * @param {string} currentUsername - The current player's username
 * @param {Object} [held] - the seats held for a reconnect, and the payload
 * @param {string[]} [held.reconnecting] - the event's list (replaces the one kept)
 * @param {string} [held.returned] - a player back in their held seat
 * @param {Object} [held.lobby] - the whole payload: its members / host / settings / capacity
 */
export function updateLobbyPlayersList(container, players, currentUsername, { reconnecting: list, returned, lobby = null } = {}) {
  const members = membersOf(players, lobby);
  if (lobbyView) {
    // every member carries its own held mark
    reconnecting = new Set(members.filter((m) => m.reconnecting).map((m) => m.username));
    returning = new Set(members.filter((m) => m.returning && !m.isBot).map((m) => m.username));
    onResults = new Set(members.filter((m) => m.onResults && !m.isBot).map((m) => m.username));
  } else {
    returning = new Set();
    onResults = new Set();
    if (Array.isArray(list)) reconnecting = new Set(list);
    if (returned) reconnecting.delete(returned);
  }
  const present = new Set(members.map((p) => p.username));
  for (const name of [...reconnecting]) if (!present.has(name)) reconnecting.delete(name);

  if (!container) {
    container = document.getElementById('lobbyPlayersList');
  }
  if (!container) return;

  container.replaceChildren();

  // Assign colors to new players - existing players keep their color for the session
  members.forEach((player) => colorFor(player.username));

  const wide = !!lobbyView && members.length > TABLE;
  const seated = members.filter((m) => m.playing);
  const tableFull = wide && seated.length >= TABLE;
  const host = lobbyView?.host ?? null;
  // "Don't wait": the host, or anyone present while the host is away
  const hostAway = !host || reconnecting.has(host) || returning.has(host) || !present.has(host);
  const mayRelease = !!currentUsername && (host === currentUsername || hostAway);

  // Header with player count
  if (lobbyView) {
    const ready = Math.min(TABLE, members.filter((m) => m.ready).length);
    container.appendChild(el('div', { className: 'section-label', text: `Players ${members.length}/${lobbyView.capacity} · Ready ${ready}/${TABLE}` }));
  } else {
    container.appendChild(el('div', { className: 'section-label', text: `Players (${members.length}/4):` }));
  }

  // Show existing players
  members.forEach((player) => {
    const row = el('div', { className: 'seat-row' });
    const isHost = !!host && !player.isBot && player.username === host;
    const shown = isHost ? `${player.username} (host)` : player.username;
    row.appendChild(el('span', {
      className: `seat-row__name${player.isBot ? ' is-bot' : ''}${isHost ? ' is-host' : ''}`,
      text: shown,
      attrs: { title: player.username },
    }));

    const side = el('span', { className: 'seat-row__side' });
    const role = roleOf(player, { wide, tableFull });
    if (role) {
      row.dataset.role = role === 'Playing' ? 'playing' : role === 'Will watch' ? 'watching' : 'sittingOut';
      side.appendChild(el('span', { className: `seat-row__role${role === 'Playing' ? ' is-playing' : ''}`, text: role }));
    }
    const away = !player.ready && !player.isBot && reconnecting.has(player.username);
    // play again: a place held for someone not back from the last game
    const notBack = !player.ready && !player.isBot && returning.has(player.username);
    if (notBack) row.dataset.returning = 'true';
    // play again: back in the lobby, still reading the last game's results
    // (never one's own row: this client is on the lobby screen)
    const reading = !player.ready && !player.isBot && !notBack && !away &&
      player.username !== currentUsername && onResults.has(player.username);
    if (reading) row.dataset.onResults = 'true';
    if (role !== 'Sitting out') {
      side.appendChild(el('span', {
        className: `seat-row__status${player.ready ? ' is-ready' : ''}${away || notBack || reading ? ' is-reconnecting' : ''}${notBack || reading ? ' is-returning' : ''}`,
        text: player.ready ? '✓ Ready' : notBack ? 'Not back yet' : away ? 'Reconnecting…' : reading ? 'Still on the results' : 'Waiting...',
      }));
    }

    // Add remove button for bot players, or invisible spacer for alignment
    if (!player.ready) {
      if (notBack && mayRelease && player.username !== currentUsername) {
        side.appendChild(releaseButton(player.username));
      } else if (player.isBot) {
        const removeBtn = createIconButton({ icon: REMOVE_ICON, label: `Remove ${player.username}`, className: 'seat-remove' });
        removeBtn.title = 'Remove bot';
        removeBtn.dataset.botSocketId = player.socketId;
        side.appendChild(removeBtn);
      } else {
        side.appendChild(el('span', { className: 'seat-remove-spacer', attrs: { 'aria-hidden': 'true' } }));
      }
    }

    row.appendChild(side);
    container.appendChild(row);
  });

  // Play again: the last game's older-app players whose place is saved
  // (no row of their own; they come back with Join on the main room's card)
  const saved = expected.filter((name) => !present.has(name));
  if (saved.length > 0) {
    container.appendChild(el('div', { className: 'section-label seat-list__expected', text: 'Expected' }));
    for (const name of saved) {
      const row = el('div', { className: 'seat-row seat-row--expected', attrs: { 'data-expected': 'true' } });
      row.appendChild(el('span', { className: 'seat-row__name', text: name, attrs: { title: name } }));
      const side = el('span', { className: 'seat-row__side' });
      side.appendChild(el('span', { className: 'seat-row__status is-reconnecting is-returning', text: 'Not back yet' }));
      side.appendChild(mayRelease ? releaseButton(name) : el('span', { className: 'seat-remove-spacer', attrs: { 'aria-hidden': 'true' } }));
      row.appendChild(side);
      container.appendChild(row);
    }
  }

  // Show empty slots (a table's 4, less the saved places; a family
  // lobby's further places need no row)
  for (let i = members.length + saved.length; i < TABLE; i++) {
    container.appendChild(el('div', {
      className: 'seat-row seat-row--empty',
      children: [el('span', { className: 'seat-row__name', text: '— Empty Slot —' })],
    }));
  }

  // Sync local ready state with server data
  const myPlayer = members.find((p) => p.username === currentUsername);
  if (myPlayer) {
    isPlayerReady = myPlayer.ready;
  }
  lastMemberCount = members.length;
  tableFullForMe = tableFull && !!myPlayer && !myPlayer.playing;

  // Update Ready button state
  renderReadyButton(document.getElementById('lobbyReadyBtn'), members.length, { watching: tableFullForMe });

  // Update Add Bot button visibility (a bot only fills a table seat; while
  // places are saved for the last game's players, members + saved count)
  const addBotBtn = document.getElementById('lobbyAddBotBtn');
  if (addBotBtn) addBotBtn.hidden = members.length + saved.length >= TABLE;

  renderVoiceSettings();
}

/**
 * The lobby's voice line (a family-lobby payload only): everyone who does
 * not get a seat watches the game and is in its voice chat, and may talk
 * (owner 2026-11-18: no host switch).
 */
function renderVoiceSettings() {
  const section = document.getElementById('lobbyVoiceSettings');
  if (!section) return;
  if (!lobbyView || !lobbyView.settings) {
    section.hidden = true;
    section.replaceChildren();
    return;
  }
  section.hidden = false;
  if (!section.querySelector('#lobbyVoiceHint')) {
    section.replaceChildren(el('p', { className: 'lobby-voice-hint', attrs: { id: 'lobbyVoiceHint' } }));
  }
  section.querySelector('#lobbyVoiceHint').textContent = 'The first 4 to tap Ready play; everyone else watches and can talk.';
}

/**
 * Show the game lobby screen.
 *
 * @param {Object} lobbyData - Lobby data (lobbyId, players, messages; members, host, settings, capacity)
 * @param {Object} socket - Socket instance
 * @param {string} username - Current player's username
 */
export function showGameLobby(lobbyData, socket, username) {
  console.log('Showing game lobby...', lobbyData);
  currentLobbyId = lobbyData.lobbyId;
  isPlayerReady = false;

  // Remove any existing game lobby (a re-render: a reconnect's lobbyJoined
  // keeps the voice running, so its buttons move to the new header)
  const oldGameLobby = document.getElementById('gameLobbyContainer');
  const voiceButtons = oldGameLobby ? [...(oldGameLobby.querySelector(`#${LOBBY_VOICE_SLOT_ID}`)?.children || [])] : [];
  // A re-render (the server's lobbyCreated for its own member: a reconnect,
  // the play-again re-entry) keeps where the keyboard was and a chat draft
  const active = oldGameLobby && oldGameLobby.contains(document.activeElement) ? document.activeElement : null;
  const keepFocus = active ? (active.id || 'lobbyReadyBtn') : null;
  const chatDraft = oldGameLobby?.querySelector('#lobbyChatInput')?.value || '';
  if (oldGameLobby) oldGameLobby.remove();

  const container = createPanel({ elevation: 3, className: 'screen screen--full screen--lobby' });
  container.id = 'gameLobbyContainer';

  // The voice slot (VoiceChatUI.js puts the mute and microphone buttons in
  // it while voice runs): in the header, clear of the chat's Send in the
  // window's bottom-right corner
  const voiceSlot = el('div', { className: 'lobby-voice', attrs: { id: LOBBY_VOICE_SLOT_ID, role: 'group', 'aria-label': 'Voice chat' } });
  voiceSlot.append(...voiceButtons);
  container.appendChild(el('header', {
    className: 'screen-header',
    children: [el('h1', { className: 'screen-title screen-title--brand', text: 'Game Lobby' }), voiceSlot],
  }));

  // The window's two columns (styles/screens.css .screen--full): the seats
  // and Ready / Add Bot / Leave on the left, the lobby chat full height on
  // the right (as on iOS). Reading and focus order follow it.
  const mainColumn = el('section', { className: 'screen-main', attrs: { 'aria-label': 'Seats' } });
  container.appendChild(mainColumn);

  // Players list
  const playersDiv = el('div', { className: 'screen-section seat-list', attrs: { id: 'lobbyPlayersList' } });
  // The family lobby's voice line, under the seats (hidden without one)
  const voiceSettings = el('div', { className: 'screen-section lobby-voice-settings', attrs: { id: 'lobbyVoiceSettings', role: 'note', 'aria-label': 'Voice' } });
  voiceSettings.hidden = true;
  // Delegated click handler for bot remove buttons and "Don't wait"
  playersDiv.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-bot-socket-id]');
    if (removeBtn) {
      socket.emit('removeBot', { botSocketId: removeBtn.dataset.botSocketId });
      return;
    }
    const releaseBtn = e.target.closest('[data-release-hold]');
    if (releaseBtn && !releaseBtn.disabled) {
      // once: the server's update removes the row (or puts it back on a refusal)
      releaseBtn.disabled = true;
      socket.emit('releaseLobbyHold', { username: releaseBtn.dataset.releaseHold });
    }
  });
  mainColumn.appendChild(playersDiv);
  mainColumn.appendChild(voiceSettings);

  // Right column - the lobby chat
  const chatPanel = el('section', { className: 'screen-chat screen-section', attrs: { 'aria-label': 'Lobby chat' } });
  chatPanel.appendChild(el('h2', { className: 'section-title', text: 'Lobby Chat' }));
  const chatArea = el('div', { className: 'chat-log', attrs: { id: 'lobbyChatArea', role: 'log', 'aria-live': 'polite' } });

  // Add any existing messages
  if (lobbyData.messages) {
    // Pre-populate colors for historical message authors
    lobbyData.messages.forEach((msg) => colorFor(msg.username));
    lobbyData.messages.forEach((msg) => {
      chatArea.appendChild(chatLine({ username: msg.username, message: msg.message, color: lobbyUserColors[msg.username] }));
    });
  }
  chatPanel.appendChild(chatArea);

  const { row: chatInputRow, input: chatInput } = chatForm({
    inputId: 'lobbyChatInput',
    label: 'Message the lobby',
    onSend: (message) => socket.emit('lobbyChat', { message }),
  });
  if (chatDraft) chatInput.value = chatDraft;
  chatPanel.appendChild(chatInputRow);

  // Button row (under the seats)
  const buttonRow = el('div', { className: 'screen-actions' });

  const readyBtn = createButton({ label: 'Ready', variant: 'primary', size: 'lg' });
  readyBtn.id = 'lobbyReadyBtn';

  readyBtn.addEventListener('click', () => {
    if (readyBtn.disabled) return;

    if (!isPlayerReady) {
      socket.emit('playerReady');
      isPlayerReady = true;
    } else {
      socket.emit('playerUnready');
      isPlayerReady = false;
    }
    renderReadyButton(readyBtn, lastMemberCount, { watching: tableFullForMe });
  });
  buttonRow.appendChild(readyBtn);

  // Add Bot button (hidden once the table's 4 places are taken)
  const addBotBtn = createButton({ label: '+ Add Bot', variant: 'secondary', size: 'lg', onClick: () => socket.emit('addBot') });
  addBotBtn.id = 'lobbyAddBotBtn';
  buttonRow.appendChild(addBotBtn);

  buttonRow.appendChild(createButton({ label: 'Leave', variant: 'secondary', size: 'lg', onClick: () => socket.emit('leaveLobby') }));
  mainColumn.appendChild(buttonRow);
  container.appendChild(chatPanel);

  document.body.appendChild(container);
  // The seats, the Ready / Add Bot state and the voice section, from the payload
  updateLobbyPlayersList(playersDiv, lobbyData.players, username, { reconnecting: lobbyData.reconnecting || [], lobby: lobbyData });
  // Open on the newest message and stay there through resizes
  scrollChatToEnd(chatArea);
  followChatOnResize(chatArea);
  if (keepFocus) {
    const target = document.getElementById(keepFocus);
    if (target && container.contains(target) && !target.disabled && !target.hidden) target.focus();
    else focusLobbyStart();
  }
}

/**
 * Put the keyboard where a lobby starts: the Ready button, or the chat
 * input while Ready is disabled (waiting for players, the table full).
 * Play again: Return to Lobby lands here (the score modal's button, which
 * had focus, is gone with the table).
 * @returns {boolean} something took focus
 */
export function focusLobbyStart() {
  const ready = document.getElementById('lobbyReadyBtn');
  const target = ready && !ready.disabled ? ready : document.getElementById('lobbyChatInput');
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

/**
 * This member will watch the next game: a family lobby of more than 4
 * whose table is already full with others (the Ready button reads "Table
 * full — you'll watch"). From the last rendered payload.
 */
export function isLobbyTableFullForMe() {
  return tableFullForMe;
}

/**
 * Add a chat message to the lobby.
 *
 * @param {string} username - Message author
 * @param {string} message - Message content
 */
export function addLobbyChatMessage(username, message) {
  const chatArea = document.getElementById('lobbyChatArea');
  if (!chatArea) return;

  // Assign distinct color if new user
  colorFor(username);

  // Follows the newest message unless the reader scrolled up
  appendChatLine(chatArea, chatLine({ username, message, color: lobbyUserColors[username] }));
}

/**
 * Remove the game lobby screen.
 */
export function removeGameLobby() {
  const gameLobby = document.getElementById('gameLobbyContainer');
  if (gameLobby) {
    // Lobby voice carries on into its game: its buttons outlive the lobby
    // (back to the page, until the table's HUD slot takes them, or stopVoice
    // removes them)
    const voiceSlot = gameLobby.querySelector(`#${LOBBY_VOICE_SLOT_ID}`);
    if (voiceSlot) {
      for (const btn of [...voiceSlot.children]) {
        btn.dataset.place = 'page';
        document.body.appendChild(btn);
      }
    }
    gameLobby.remove();
  }
  currentLobbyId = null;
  isPlayerReady = false;
  lobbyUserColors = {};
  reconnecting = new Set();
  returning = new Set();
  onResults = new Set();
  expected = [];
  lobbyView = null;
  lastMemberCount = 0;
  tableFullForMe = false;
}

/**
 * Get the current lobby ID.
 *
 * @returns {string|null} Current lobby ID
 */
export function getCurrentLobbyId() {
  return currentLobbyId;
}

/**
 * Check if the player is ready.
 *
 * @returns {boolean} Ready status
 */
export function getIsPlayerReady() {
  return isPlayerReady;
}

/**
 * Get the lobby user colors map (for external access).
 *
 * @returns {Object} Map of username to color
 */
export function getLobbyUserColors() {
  return lobbyUserColors;
}
