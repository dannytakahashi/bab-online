/**
 * Game log component for game feed and scores.
 *
 * Displays game events, trick history, and chat messages.
 */

import { getUsernameColor } from '../../utils/colors.js';

/**
 * Create game log component.
 *
 * @param {Object} options - Log options
 * @param {Function} options.onChatSubmit - Called with message when chat submitted
 * @returns {Object} { container, addMessage, addSystemMessage, updateScores, destroy }
 */
export function createGameLog({ onChatSubmit } = {}) {
  const container = document.createElement('div');
  container.id = 'game-log';
  container.className = 'game-log';
  container.style.cssText = `
    position: fixed;
    right: 0;
    top: 0;
    width: 300px;
    height: 100vh;
    background: rgba(20, 20, 30, 0.95);
    display: flex;
    flex-direction: column;
    z-index: 100;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
  `;

  // Score section (matches legacy game feed structure)
  const scoreSection = document.createElement('div');
  scoreSection.id = 'score-section';
  scoreSection.style.cssText = `
    padding: 10px;
    border-bottom: 1px solid #333;
    display: flex;
    justify-content: space-around;
    background: rgba(0, 0, 0, 0.3);
    color: white;
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

  scoreSection.appendChild(teamScoreDiv);
  scoreSection.appendChild(oppScoreDiv);
  container.appendChild(scoreSection);

  // Message area
  const messageArea = document.createElement('div');
  messageArea.id = 'game-log-messages';
  messageArea.style.cssText = `
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    font-size: 13px;
    color: #ccc;
  `;
  container.appendChild(messageArea);

  // Chat input section
  const chatSection = document.createElement('div');
  chatSection.style.cssText = `
    padding: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    gap: 8px;
  `;

  const chatInput = document.createElement('input');
  chatInput.type = 'text';
  chatInput.placeholder = 'Type a message...';
  chatInput.style.cssText = `
    flex: 1;
    padding: 8px 12px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    font-size: 13px;
    outline: none;
  `;

  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  sendBtn.style.cssText = `
    padding: 8px 16px;
    border: none;
    border-radius: 6px;
    background: #23782d;
    color: white;
    cursor: pointer;
    font-size: 13px;
  `;

  const submitChat = () => {
    const message = chatInput.value.trim();
    if (message && onChatSubmit) {
      onChatSubmit(message);
      chatInput.value = '';
    }
  };

  sendBtn.onclick = submitChat;
  chatInput.onkeypress = (e) => {
    if (e.key === 'Enter') submitChat();
  };

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

      // Message text with team coloring
      const textSpan = document.createElement('span');
      textSpan.textContent = message;
      // Team 1 (positions 1, 3) = blue, Team 2 (positions 2, 4) = red
      textSpan.style.color = (playerPosition === 1 || playerPosition === 3) ? '#63b3ed' : '#fc8181';
      msgDiv.appendChild(textSpan);

      messageArea.appendChild(msgDiv);
      messageArea.scrollTop = messageArea.scrollHeight;
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
