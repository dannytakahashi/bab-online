/**
 * Game log component for game feed and scores.
 *
 * Displays game events, trick history, and chat messages. Its look is
 * table.css (#gameFeed, .log-*; item 18a: tokens, team A blue / team B
 * coral, tabular numerals for scores); nothing here sets a color inline.
 */

import { getUsernameColor } from '../../utils/colors.js';
import { getGameState } from '../../state/GameState.js';
import { bidTotalsFor } from '../../rules/bids.js';

/** A team's class by game position (team A: seats 1 and 3, team B: 2 and 4). */
const teamOf = (pos) => (Number(pos) % 2 === 1 ? 'a' : 'b');

/** A div with a class and text. */
function line(className, text, id = null) {
  const el = document.createElement('div');
  el.className = className;
  if (id) el.id = id;
  el.textContent = String(text);
  return el;
}

/** Rendered rows are capped (the server keeps 500 log entries). */
export const MAX_LOG_ROWS = 500;

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
  scoreSection.className = 'log-score';

  // My team (team A or B by my seat: setTeams) and the opponents
  const teamScoreDiv = document.createElement('div');
  teamScoreDiv.id = 'teamScoreDisplay';
  teamScoreDiv.className = 'log-score__team is-mine';
  teamScoreDiv.append(line('log-score__names', 'Your Team'), line('log-score__value', '0', 'team-score-value'), line('log-score__detail', 'Tricks: 0', 'team-tricks-value'));

  const oppScoreDiv = document.createElement('div');
  oppScoreDiv.id = 'oppScoreDisplay';
  oppScoreDiv.className = 'log-score__team is-opp';
  oppScoreDiv.append(line('log-score__names', 'Opponents'), line('log-score__value', '0', 'opp-score-value'), line('log-score__detail', 'Tricks: 0', 'opp-tricks-value'));

  // Hand indicator (between the two score displays)
  const handIndicator = document.createElement('div');
  handIndicator.id = 'handIndicator';
  handIndicator.className = 'log-hand';
  handIndicator.append(line('log-hand__label', 'Hand'), line('log-hand__value', '-', 'hand-indicator-value'));

  scoreSection.appendChild(teamScoreDiv);
  scoreSection.appendChild(handIndicator);
  scoreSection.appendChild(oppScoreDiv);
  container.appendChild(scoreSection);

  // Trick indicator (shown during bidding, below score section)
  const trickIndicatorSection = document.createElement('div');
  trickIndicatorSection.className = 'log-tricks';
  trickIndicatorSection.hidden = true;
  const trickIndicatorRow = document.createElement('div');
  trickIndicatorRow.className = 'log-tricks__row';
  trickIndicatorSection.appendChild(trickIndicatorRow);
  container.appendChild(trickIndicatorSection);

  // Message area
  const messageArea = document.createElement('div');
  messageArea.id = 'gameFeedMessages';  // Legacy ID for compatibility
  messageArea.classList.add('chat-messages');  // Legacy class
  container.appendChild(messageArea);

  let trickRects = [];
  let trickHandSize = 0;

  const createTrickRect = () => {
    const rect = document.createElement('div');
    rect.className = 'log-chip';
    return rect;
  };

  const showTrickIndicator = (handSize) => {
    trickHandSize = handSize;
    trickIndicatorRow.replaceChildren();
    trickRects = [];
    for (let i = 0; i < handSize; i++) {
      const rect = createTrickRect();
      trickRects.push(rect);
      trickIndicatorRow.appendChild(rect);
    }
    trickIndicatorSection.hidden = false;
    updateTrickIndicator();
  };

  const hideTrickIndicator = () => {
    trickIndicatorSection.hidden = true;
    trickIndicatorRow.replaceChildren();
    trickRects = [];
    trickHandSize = 0;
  };

  const updateTrickIndicator = () => {
    if (trickRects.length === 0) return;

    const state = getGameState();
    const bids = state.bids || {};
    const isTeam1 = state.position === 1 || state.position === 3;
    // team totals ({team1, team2}) as given; bids by position through
    // rules/bids.js: a bore counts as the whole hand, each team capped at
    // the hand size
    const totals = bids.team1 !== undefined
      ? { team: isTeam1 ? bids.team1 : bids.team2, opp: isTeam1 ? bids.team2 : bids.team1 }
      : bidTotalsFor(bids, state.position, trickHandSize);
    const teamBidCount = totals.team;
    const oppBidCount = totals.opp;

    const totalBid = teamBidCount + oppBidCount;
    const totalNeeded = Math.min(Math.max(totalBid, trickHandSize), 16);

    // Add or remove extra rectangles
    while (trickRects.length < totalNeeded) {
      const rect = createTrickRect();
      trickRects.push(rect);
      trickIndicatorRow.appendChild(rect);
    }
    while (trickRects.length > totalNeeded) {
      const rect = trickRects.pop();
      rect.remove();
    }

    // by absolute team (team A: positions 1 and 3), as the score above is
    const mine = teamOf(state.position);
    for (let i = 0; i < trickRects.length; i++) {
      const rect = trickRects[i];
      const isOverbid = i >= trickHandSize;
      const isTeam = i < teamBidCount;
      const isOpp = i >= teamBidCount && i < totalBid;
      const letter = isTeam ? mine : isOpp ? (mine === 'a' ? 'b' : 'a') : null;

      rect.classList.toggle('is-team', isTeam);
      rect.classList.toggle('is-opp', isOpp);
      rect.classList.toggle('is-team-a', letter === 'a');
      rect.classList.toggle('is-team-b', letter === 'b');
      // past the hand size: an overbid (a static outline, no animation)
      rect.classList.toggle('is-overbid', isOverbid);
    }
  };

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
  autocompleteDropdown.hidden = true;
  autocompleteDropdown.setAttribute('role', 'listbox');

  const updateAutocomplete = (text) => {
    if (!text.startsWith('/')) {
      autocompleteDropdown.hidden = true;
      return;
    }

    const query = text.toLowerCase();
    const matches = getSlashCommands().filter(cmd => cmd.command.startsWith(query));

    if (matches.length === 0) {
      autocompleteDropdown.hidden = true;
      return;
    }

    autocompleteDropdown.replaceChildren(...matches.map((cmd) => {
      // (hover is CSS: .slash-item:hover)
      const item = document.createElement('div');
      item.className = 'slash-item';
      item.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.className = 'slash-item__cmd';
      name.textContent = cmd.command;
      const desc = document.createElement('span');
      desc.className = 'slash-item__desc';
      desc.textContent = cmd.description;
      item.append(name, desc);
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent blur from firing
        chatInput.value = cmd.command;
        autocompleteDropdown.hidden = true;
        submitChat();
      });
      return item;
    }));

    autocompleteDropdown.hidden = false;
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
      autocompleteDropdown.hidden = true;
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
      autocompleteDropdown.hidden = true;
    }, 150);
  });

  chatInput.setAttribute('aria-label', 'Chat message');
  chatSection.appendChild(autocompleteDropdown);
  chatSection.appendChild(chatInput);
  chatSection.appendChild(sendBtn);
  container.appendChild(chatSection);

  // Helper functions
  const addMessage = (username, message, playerPosition = null) => {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'log-row';

    // Add timestamp
    const now = new Date();
    const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-row__time';
    timeSpan.textContent = `[${timestamp}] `;
    msgDiv.appendChild(timeSpan);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${username}: `;

    const textSpan = document.createElement('span');
    textSpan.textContent = message;

    // Team colors when the seat is known (team A blue, team B coral), else
    // the username's own hue (a CSS variable: it is per-name data)
    if (playerPosition !== null) {
      nameSpan.className = `log-row__name log-row__text is-team-${teamOf(playerPosition)}`;
      textSpan.className = `log-row__text is-team-${teamOf(playerPosition)}`;
    } else {
      nameSpan.className = 'log-row__name';
      nameSpan.style.setProperty('color', getUsernameColor(username));
    }

    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);
    messageArea.appendChild(msgDiv);
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  // One log row: [time] text, colored by team / spectator / system
  const timeLabel = (at) => {
    const when = at !== undefined && at !== null && Number.isFinite(Number(at)) ? new Date(Number(at)) : new Date();
    return when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };
  const buildRow = (message, playerPosition = null, at = null) => {
    const msgDiv = document.createElement('div');
    const system = playerPosition === null || playerPosition === undefined;
    msgDiv.className = system ? 'log-row is-system' : 'log-row';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-row__time';
    timeSpan.textContent = `[${timeLabel(at)}] `;
    msgDiv.appendChild(timeSpan);
    const textSpan = document.createElement('span');
    textSpan.textContent = message;
    if (system) {
      textSpan.className = 'log-row__text is-system';
    } else if (playerPosition === 'spectator') {
      textSpan.className = 'log-row__text is-spectator';
    } else {
      // Team 1 (positions 1, 3) = team A blue, Team 2 (positions 2, 4) = team B coral
      textSpan.className = `log-row__text is-team-${teamOf(playerPosition)}`;
    }
    msgDiv.appendChild(textSpan);
    return msgDiv;
  };
  // Live rows: one append and one scroll each; the list is capped
  const append = (row) => {
    messageArea.appendChild(row);
    while (messageArea.childElementCount > MAX_LOG_ROWS) messageArea.firstElementChild.remove();
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  const addSystemMessage = (message, _color = null, at = null) => {
    append(buildRow(message, null, at));
  };

  const addTrickResult = (winner, teamTricks, oppTricks) => {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'log-trick';
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
  const addGameMessage = (message, playerPosition = null, at = null) => {
    append(buildRow(message, playerPosition, at));
  };

  /**
   * Replace every row with `entries` ({message, position, at}; the server
   * log of a snapshot), built off-document and scrolled once (webclient-9:
   * one layout for the whole replay, not one per line).
   */
  const replaceMessages = (entries = []) => {
    const frag = document.createDocumentFragment();
    const rows = entries.slice(-MAX_LOG_ROWS);
    for (const e of rows) {
      frag.appendChild(buildRow(e.message, e.position ?? null, e.at ?? null));
    }
    messageArea.replaceChildren(frag);
    messageArea.scrollTop = messageArea.scrollHeight;
  };

  /** Row count (tests, render checks). */
  const messageCount = () => messageArea.childElementCount;

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

    // Names are usernames, so build with textContent rather than innerHTML
    const fillScore = (div, names, score, bids, tricks) => {
      div.replaceChildren(
        line('log-score__names', names),
        line('log-score__value', score),
        line('log-score__detail', `Bids: ${bids} | Tricks: ${tricks}`),
      );
    };
    // each side in its team's color (my seat's team, the other)
    const pos = getGameState().position;
    if (pos) {
      const mine = teamOf(pos);
      const theirs = mine === 'a' ? 'b' : 'a';
      teamDiv?.classList.remove('is-team-a', 'is-team-b');
      teamDiv?.classList.add(`is-team-${mine}`);
      oppDiv?.classList.remove('is-team-a', 'is-team-b');
      oppDiv?.classList.add(`is-team-${theirs}`);
    }

    if (teamDiv) {
      fillScore(teamDiv, teamNames, teamScore, teamBids, teamTricks);
    }

    if (oppDiv) {
      fillScore(oppDiv, oppNames, oppScore, oppBids, oppTricks);
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
    showTrickIndicator,
    hideTrickIndicator,
    updateTrickIndicator,
    clearMessages,
    replaceMessages,
    messageCount,
    destroy,
    chatInput,
  };
}

/**
 * Show game log and return it: in the table shell's log column (the
 * --log-w grid, styles.css), else on the page (fixed at the right).
 */
export function showGameLog(options) {
  const log = createGameLog(options);
  (document.getElementById('table-shell') || document.body).appendChild(log.container);
  return log;
}
