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

  // Score section
  const scoreSection = document.createElement('div');
  scoreSection.id = 'score-section';
  scoreSection.style.cssText = `
    padding: 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    color: white;
  `;
  scoreSection.innerHTML = `
    <div style="font-size: 14px; font-weight: bold; margin-bottom: 8px;">SCORES</div>
    <div id="team-score" style="display: flex; justify-content: space-between; margin-bottom: 4px;">
      <span>Your Team:</span>
      <span id="team-score-value">0</span>
    </div>
    <div id="opp-score" style="display: flex; justify-content: space-between;">
      <span>Opponents:</span>
      <span id="opp-score-value">0</span>
    </div>
  `;
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
  const addMessage = (username, message) => {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      margin-bottom: 8px;
      word-wrap: break-word;
    `;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${username}: `;
    nameSpan.style.cssText = `
      font-weight: bold;
      color: ${getUsernameColor(username)};
    `;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;

    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);
    messageArea.appendChild(msgDiv);
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  const addSystemMessage = (message, color = '#888') => {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
      margin-bottom: 8px;
      color: ${color};
      font-style: italic;
    `;
    msgDiv.textContent = message;
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
    // Could add a tricks display if needed
  };

  const clearMessages = () => {
    messageArea.innerHTML = '';
  };

  const destroy = () => {
    container.remove();
  };

  return {
    container,
    addMessage,
    addSystemMessage,
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
