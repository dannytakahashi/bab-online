/**
 * Game log component for game feed and scores.
 *
 * Displays game events, trick history, and chat messages.
 */

import { getUsernameColor } from '../../utils/colors.js';
import { getGameState } from '../../state/GameState.js';

/**
 * Create game log component.
 *
 * @param {Object} options - Log options
 * @param {Function} options.onChatSubmit - Called with message when chat submitted
 * @returns {Object} { container, addMessage, addSystemMessage, updateScores, destroy }
 */
export function createGameLog({ onChatSubmit } = {}) {
  const container = document.createElement('div');
  container.id = 'gameFeed';  // Legacy ID for compatibility
  container.classList.add('chat-container', 'ui-element');  // Legacy classes

  // Header
  const header = document.createElement('div');
  header.classList.add('chat-header');
  header.innerText = 'Game Log';
  container.appendChild(header);

  // Score section (matches legacy game feed structure)
  const scoreSection = document.createElement('div');
  scoreSection.id = 'gameLogScore';  // Legacy ID
  scoreSection.style.cssText = `
    padding: 10px;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-around;
    background: rgba(0, 0, 0, 0.3);
  `;

  const teamScoreDiv = document.createElement('div');
  teamScoreDiv.id = 'teamScoreDisplay';
  teamScoreDiv.style.cssText = `text-align: center; color: #4ade80;`;
  teamScoreDiv.innerHTML = `
    <div style="font-size: 12px; color: #888;">Your Team</div>
    <div id="team-score-value" style="font-size: 20px; font-weight: bold;">0</div>
    <div id="team-tricks-value" style="font-size: 11px; color: #aaa;">Tricks: 0</div>
  `;

  const oppScoreDiv = document.createElement('div');
  oppScoreDiv.id = 'oppScoreDisplay';
  oppScoreDiv.style.cssText = `text-align: center; color: #f87171;`;
  oppScoreDiv.innerHTML = `
    <div style="font-size: 12px; color: #888;">Opponents</div>
    <div id="opp-score-value" style="font-size: 20px; font-weight: bold;">0</div>
    <div id="opp-tricks-value" style="font-size: 11px; color: #aaa;">Tricks: 0</div>
  `;

  // Hand indicator (between the two score displays)
  const handIndicator = document.createElement('div');
  handIndicator.id = 'handIndicator';
  handIndicator.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  `;
  handIndicator.innerHTML = `
    <div style="font-size: 10px; color: #888; margin-bottom: 2px;">Hand</div>
    <div id="hand-indicator-value" style="
      background: #1a1a1a;
      color: #b0b0b0;
      font-size: 18px;
      font-weight: bold;
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    ">-</div>
  `;

  scoreSection.appendChild(teamScoreDiv);
  scoreSection.appendChild(handIndicator);
  scoreSection.appendChild(oppScoreDiv);
  container.appendChild(scoreSection);

  // Message area
  const messageArea = document.createElement('div');
  messageArea.id = 'gameFeedMessages';  // Legacy ID for compatibility
  messageArea.classList.add('chat-messages');  // Legacy class
  container.appendChild(messageArea);

  // Chat input section
  const chatSection = document.createElement('div');
  chatSection.classList.add('chat-input-container');  // Legacy class

  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.id = 'chatInput';  // Legacy ID
  chatInput.classList.add('chat-input');  // Legacy class
  chatInput.placeholder = 'Type a message...';

  const sendBtn = document.createElement('button');
  sendBtn.classList.add('chat-send');  // Legacy class
  sendBtn.textContent = 'Send';

  // Slash command autocomplete
  const ALL_SLASH_COMMANDS = [
    { command: '/lazy', description: 'Have a bot play for you' },
    { command: '/active', description: 'Take back control from bot' },
    { command: '/leave', description: 'Leave the game (bot finishes for you)' },
  ];
  const SPECTATOR_SLASH_COMMANDS = [
    { command: '/leave', description: 'Exit spectating' },
  ];
  const getSlashCommands = () => {
    const gameState = getGameState();
    if (gameState.isSpectator && !gameState.isLazy) {
      return SPECTATOR_SLASH_COMMANDS;
    }
    return ALL_SLASH_COMMANDS;
  };

  const autocompleteDropdown = document.createElement('div');
  autocompleteDropdown.className = 'slash-autocomplete';
  autocompleteDropdown.style.cssText = `
    display: none;
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    background: #1a1a2e;
    border: 1px solid #333;
    border-radius: 6px;
    margin-bottom: 4px;
    overflow: hidden;
    z-index: 200;
  `;

  const updateAutocomplete = (text) => {
    if (!text.startsWith('/')) {
      autocompleteDropdown.style.display = 'none';
      return;
    }

    const query = text.toLowerCase();
    const matches = getSlashCommands().filter(cmd => cmd.command.startsWith(query));

    if (matches.length === 0) {
      autocompleteDropdown.style.display = 'none';
      return;
    }

    autocompleteDropdown.innerHTML = '';
    matches.forEach(cmd => {
      const item = document.createElement('div');
      item.style.cssText = `
        padding: 8px 12px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
      `;
      item.innerHTML = `
        <span style="color: #4ade80; font-weight: bold;">${cmd.command}</span>
        <span style="color: #888; font-size: 12px; margin-left: 12px;">${cmd.description}</span>
      `;
      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(74, 222, 128, 0.1)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent blur from firing
        chatInput.value = cmd.command;
        autocompleteDropdown.style.display = 'none';
        submitChat();
      });
      autocompleteDropdown.appendChild(item);
    });

    autocompleteDropdown.style.display = 'block';
  };

  const submitChat = () => {
    let message = chatInput.value.trim();
    if (message && onChatSubmit) {
      // If typing a partial slash command with a single match, submit the full command
      if (message.startsWith('/') && message !== '/') {
        const query = message.toLowerCase();
        const matches = getSlashCommands().filter(cmd => cmd.command.startsWith(query));
        if (matches.length === 1) {
          message = matches[0].command;
        }
      }
      onChatSubmit(message);
      chatInput.value = '';
      autocompleteDropdown.style.display = 'none';
    }
  };

  sendBtn.onclick = submitChat;
  chatInput.onkeypress = (e) => {
    if (e.key === 'Enter') submitChat();
  };
  chatInput.addEventListener('input', () => {
    updateAutocomplete(chatInput.value);
  });
  chatInput.addEventListener('blur', () => {
    // Small delay so click events on autocomplete items fire first
    setTimeout(() => {
      autocompleteDropdown.style.display = 'none';
    }, 150);
  });

  chatSection.style.position = 'relative';
  chatSection.appendChild(autocompleteDropdown);
  chatSection.appendChild(chatInput);
  chatSection.appendChild(sendBtn);
  container.appendChild(chatSection);

  // Helper functions
  const addMessage = (username, message, playerPosition = null) => {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      margin-bottom: 8px;
      word-wrap: break-word;
    `;

    // Add timestamp
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span');
    timeSpan.textContent = `[${timestamp}] `;
    timeSpan.style.cssText = `
      color: #888;
      font-size: 11px;
      margin-right: 4px;
    `;
    msgDiv.appendChild(timeSpan);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${username}: `;

    // Use team-based colors if position provided, otherwise use username color
    let nameColor = getUsernameColor(username);
    if (playerPosition !== null) {
      // Team 1 (positions 1, 3) = blue, Team 2 (positions 2, 4) = red
      nameColor = (playerPosition === 1 || playerPosition === 3) ? '#63b3ed' : '#fc8181';
    }

    nameSpan.style.cssText = `
      font-weight: bold;
      color: ${nameColor};
    `;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;

    // Color the message text based on team if position provided
    if (playerPosition !== null) {
      textSpan.style.color = (playerPosition === 1 || playerPosition === 3) ? '#63b3ed' : '#fc8181';
    }

    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);
    messageArea.appendChild(msgDiv);
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  const addSystemMessage = (message, color = '#888') => {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      margin-bottom: 8px;
      font-style: italic;
    `;

    // Add timestamp
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span');
    timeSpan.textContent = `[${timestamp}] `;
    timeSpan.style.cssText = `
      color: #888;
      font-size: 11px;
      margin-right: 4px;
    `;
    msgDiv.appendChild(timeSpan);

    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    textSpan.style.color = color;
    msgDiv.appendChild(textSpan);

    messageArea.appendChild(msgDiv);
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  const addTrickResult = (winner, teamTricks, oppTricks) => {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      margin-bottom: 8px;
      padding: 8px;
      background: rgba(35, 120, 45, 0.2);
      border-radius: 6px;
      color: #4CAF50;
    `;
    msgDiv.textContent = `${winner} won the trick! (${teamTricks}-${oppTricks})`;
    messageArea.appendChild(msgDiv);
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  const updateScores = (teamScore, oppScore) => {
    const teamEl = container.querySelector('#team-score-value');
    const oppEl = container.querySelector('#opp-score-value');
    if (teamEl) teamEl.textContent = teamScore.toString();
    if (oppEl) oppEl.textContent = oppScore.toString();
  };

  const updateTricks = (teamTricks, oppTricks) => {
    const teamEl = container.querySelector('#team-tricks-value');
    const oppEl = container.querySelector('#opp-tricks-value');
    if (teamEl) teamEl.textContent = `Tricks: ${teamTricks}`;
    if (oppEl) oppEl.textContent = `Tricks: ${oppTricks}`;
  };

  const clearMessages = () => {
    messageArea.innerHTML = '';
  };

  const updateHandIndicator = (handSize) => {
    const el = container.querySelector('#hand-indicator-value');
    if (el) el.textContent = handSize.toString();
  };

  const destroy = () => {
    container.remove();
  };

  /**
   * Add a game message with player position color coding.
   * This matches the legacy addToGameFeed API.
   *
   * @param {string} message - The full message (may include "username: text" format)
   * @param {number|null} playerPosition - Player position (1-4) for color coding, or null for system messages
   */
  const addGameMessage = (message, playerPosition = null) => {
    if (playerPosition === null) {
      addSystemMessage(message);
    } else {
      // Message is already formatted, add it with position coloring
      const msgDiv = document.createElement('div');
      msgDiv.style.cssText = `
        margin-bottom: 8px;
        word-wrap: break-word;
      `;

      // Add timestamp
      const now = new Date();
      const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const timeSpan = document.createElement('span');
      timeSpan.textContent = `[${timestamp}] `;
      timeSpan.style.cssText = `
        color: #888;
        font-size: 11px;
        margin-right: 4px;
      `;
      msgDiv.appendChild(timeSpan);

      // Message text with team/spectator coloring
      const textSpan = document.createElement('span');
      textSpan.textContent = message;
      if (playerPosition === 'spectator') {
        textSpan.style.color = '#4ade80'; // Green for spectators
      } else {
        // Team 1 (positions 1, 3) = blue, Team 2 (positions 2, 4) = red
        textSpan.style.color = (playerPosition === 1 || playerPosition === 3) ? '#63b3ed' : '#fc8181';
      }
      msgDiv.appendChild(textSpan);

      messageArea.appendChild(msgDiv);
      messageArea.scrollTop = messageArea.scrollHeight;
    }
  };

  /**
   * Update full score display (matches legacy updateGameLogScore signature).
   * @param {string} teamNames - Team player names (e.g., "Player1/Player2")
   * @param {string} oppNames - Opponent player names
   * @param {number} teamScore - Team score
   * @param {number} oppScore - Opponent score
   * @param {string} teamBids - Team bids display (e.g., "3/2")
   * @param {string} oppBids - Opponent bids display
   * @param {number} teamTricks - Team tricks won
   * @param {number} oppTricks - Opponent tricks won
   */
  const updateFullScore = (teamNames, oppNames, teamScore, oppScore, teamBids = '-/-', oppBids = '-/-', teamTricks = 0, oppTricks = 0) => {
    const teamDiv = container.querySelector('#teamScoreDisplay');
    const oppDiv = container.querySelector('#oppScoreDisplay');

    if (teamDiv) {
      teamDiv.innerHTML = `
        <div style="font-size:12px;color:#888;">${teamNames}</div>
        <div style="font-size:20px;font-weight:bold;">${teamScore}</div>
        <div style="font-size:11px;color:#aaa;">Bids: ${teamBids} | Tricks: ${teamTricks}</div>
      `;
    }

    if (oppDiv) {
      oppDiv.innerHTML = `
        <div style="font-size:12px;color:#888;">${oppNames}</div>
        <div style="font-size:20px;font-weight:bold;">${oppScore}</div>
        <div style="font-size:11px;color:#aaa;">Bids: ${oppBids} | Tricks: ${oppTricks}</div>
      `;
    }
  };

  return {
    container,
    addMessage,
    addSystemMessage,
    addGameMessage,
    addTrickResult,
    updateScores,
    updateTricks,
    updateFullScore,
    updateHandIndicator,
    clearMessages,
    destroy,
    chatInput,
  };
}

/**
 * Show game log and return it.
 */
export function showGameLog(options) {
  const log = createGameLog(options);
  document.body.appendChild(log.container);
  return log;
}
