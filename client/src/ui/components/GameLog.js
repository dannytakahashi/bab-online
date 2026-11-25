/**
 * Game log component for game feed and scores.
 *
 * Displays game events, trick history, and chat messages. Its look is
 * table.css (#gameFeed, .log-*; item 18a: tokens, team A blue / team B
 * coral, tabular numerals for scores); nothing here sets a color inline.
 */

import { getUsernameColor } from '../../utils/colors.js';
import { getGameState, teamPlayerDataOf } from '../../state/GameState.js';
import { bidTotalsFor, bidTricks } from '../../rules/bids.js';
import { seatLetter } from '../../utils/positions.js';
import { soloHeaderRows } from '../../state/gyb.js';
import { isChatAtEnd, scrollChatToEnd } from '../screens/common.js';
import { scoreHeaderNames } from './ScoreModal.js';
import { isPureSpectator } from '../../state/shoulder.js';
import { helpDescription, helpIsUnlimited, HELP_COMMAND } from '../../state/assistHint.js';
import { tutorialDescription, tutorialIsOn, TUTORIAL_COMMAND } from '../../state/tutorial.js';

/**
 * A seat's colour class by game position (team A: seats 1 and 3, team B: 2
 * and 4; at a three-seat table, Get Your Bid, each seat its own: a / b / c).
 */
const teamOf = (pos) => seatLetter(pos, getGameState().seatCount);
const TEAM_CLASSES = ['is-team-a', 'is-team-b', 'is-team-c'];

/**
 * The seat the log is read from: a seat's (a lazy watcher's too) own; a
 * spectator's seat 1 (a watcher's, the watched seat's: the over-the-shoulder
 * view draws the table from it), as the score header's names are (seats 1/3 on the
 * left: scoreHeaderNames) and rules/bids.js bidTotalsFor reads it. Never
 * null: with no seat, teamOf(null) gave seats 1/3's bids team B's colour
 * while bidTotalsFor counted them from seat 1.
 */
const viewerSeat = (state) => (isPureSpectator(state) ? 1 : (Number(state.position) || 1));

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
 * @param {Function} options.onChatSubmit - Called with message when chat submitted; false keeps the draft
 * @returns {Object} { container, addMessage, addSystemMessage, updateScores, updateFullScore, updateNames, destroy }
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

  // My team (team A or B by my seat: setTeams) and the opponents, by the
  // players' names as soon as the seats are known (the log comes up at
  // createUI, after positionUpdate), else an empty line of the same height
  // until the score header is drawn: never a "Your Team" / "Opponents"
  // placeholder (owner 2026-11-17)
  const state = getGameState();
  const placeholder = scoreHeaderNames(state.position, teamPlayerDataOf(state), { spectator: isPureSpectator(state) });
  const teamScoreDiv = document.createElement('div');
  teamScoreDiv.id = 'teamScoreDisplay';
  teamScoreDiv.className = 'log-score__team is-mine';
  teamScoreDiv.append(line('log-score__names', placeholder.teamName), line('log-score__value', '0', 'team-score-value'), line('log-score__detail', 'Tricks: 0', 'team-tricks-value'));

  const oppScoreDiv = document.createElement('div');
  oppScoreDiv.id = 'oppScoreDisplay';
  oppScoreDiv.className = 'log-score__team is-opp';
  oppScoreDiv.append(line('log-score__names', placeholder.oppName), line('log-score__value', '0', 'opp-score-value'), line('log-score__detail', 'Tricks: 0', 'opp-tricks-value'));

  // Hand indicator (between the two score displays)
  const handIndicator = document.createElement('div');
  handIndicator.id = 'handIndicator';
  handIndicator.className = 'log-hand';
  handIndicator.append(line('log-hand__label', 'Hand'), line('log-hand__value', '-', 'hand-indicator-value'));

  // A three-seat table's third player (Get Your Bid: updateSoloScore): in
  // the header only at such a table, so every other table's is as it was
  const opp2ScoreDiv = document.createElement('div');
  opp2ScoreDiv.id = 'opp2ScoreDisplay';
  opp2ScoreDiv.className = 'log-score__team is-opp';

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

  /**
   * The row for a deal of `handSize` cards (every role: a spectator's deal
   * has no hand, so callers pass the deal's currentHand, never
   * hand.length). No hand size (0, unknown): the row is hidden, never an
   * empty bar.
   */
  const showTrickIndicator = (handSize) => {
    const n = Number(handSize);
    if (!Number.isInteger(n) || n <= 0) {
      hideTrickIndicator();
      return;
    }
    handSize = Math.min(n, 13);
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
    if (trickHandSize <= 0) return;

    const state = getGameState();
    const bids = state.bids || {};
    const seat = viewerSeat(state);
    if (state.isSolo) {
      // each seat's bid in its own colour: the viewer's, then the next in turn
      const runs = soloHeaderRows(state, { spectator: isPureSpectator(state) })
        .map((r) => ({ letter: r.letter, mine: r.mine, n: bidTricks(bids[r.position], trickHandSize) ?? 0 }));
      const total = runs.reduce((n, r) => n + r.n, 0);
      const needed = Math.min(Math.max(total, trickHandSize), 16);
      while (trickRects.length < needed) {
        const rect = createTrickRect();
        trickRects.push(rect);
        trickIndicatorRow.appendChild(rect);
      }
      while (trickRects.length > needed) trickRects.pop().remove();
      const owner = [];
      for (const r of runs) for (let k = 0; k < r.n; k++) owner.push(r);
      trickRects.forEach((rect, i) => {
        const r = owner[i] || null;
        rect.classList.toggle('is-team', !!r && r.mine);
        rect.classList.toggle('is-opp', !!r && !r.mine);
        for (const c of TEAM_CLASSES) rect.classList.toggle(c, !!r && c === `is-team-${r.letter}`);
        rect.classList.toggle('is-overbid', i >= trickHandSize);
      });
      return;
    }
    const isTeam1 = seat % 2 === 1;
    // team totals ({team1, team2}) as given; bids by position through
    // rules/bids.js: a bore counts as the whole hand, each team capped at
    // the hand size
    const totals = bids.team1 !== undefined
      ? { team: isTeam1 ? bids.team1 : bids.team2, opp: isTeam1 ? bids.team2 : bids.team1 }
      : bidTotalsFor(bids, seat, trickHandSize);
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
    const mine = teamOf(seat);
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

  // Slash command autocomplete. /leave: a bot keeps the seat while another
  // player is at the table (or may come back); when no one is, the server
  // ends the game (seatLifecycle.maybeAbort: "All players left"). The web
  // does not track the other seats' presence, so the text names both.
  // /help (a suggested bid or card, private; state/assistHint.js): its line
  // says this game's uses, read when the list is drawn ("Ask a bot for
  // advice (1 of 3 free used)"; after the free ones "the next one makes
  // this game bot-assisted"; just "Ask a bot for advice" in a game with a
  // native bot seat: helpIsUnlimited). /tutorial (state/tutorial.js):
  // "Tutorial: tips and advice every turn", or while it is on "Turn off the
  // tutorial" (the plain /tutorial toggles)
  const ALL_SLASH_COMMANDS = [
    {
      command: HELP_COMMAND,
      description: () => {
        const gs = getGameState();
        return helpDescription(gs.gameId, { unlimited: helpIsUnlimited(gs), tutorial: tutorialIsOn(gs.gameId) });
      },
    },
    { command: TUTORIAL_COMMAND, description: () => tutorialDescription(getGameState().gameId) },
    { command: '/lazy', description: 'Have a bot play for you' },
    { command: '/active', description: 'Take back control from bot' },
    { command: '/leave', description: "Leave the game (a bot takes over; ends it if you're the only player)" },
  ];
  const SPECTATOR_SLASH_COMMANDS = [
    { command: '/leave', description: 'Exit spectating' },
  ];
  const getSlashCommands = () => {
    const gameState = getGameState();
    if (gameState.isSpectator && !gameState.isLazy) {
      return SPECTATOR_SLASH_COMMANDS;
    }
    // (no /help and no tutorial at a Get Your Bid table)
    if (gameState.isSolo) return ALL_SLASH_COMMANDS.filter((c) => c.command !== HELP_COMMAND && c.command !== TUTORIAL_COMMAND);
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
      desc.textContent = typeof cmd.description === 'function' ? cmd.description() : cmd.description;
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
      // false: not sent (offline, the emit gate): the draft stays
      if (onChatSubmit(message) === false) return;
      chatInput.value = '';
      // My own line: back to the newest rows, so its echo shows
      scrollChatToEnd(messageArea);
      autocompleteDropdown.hidden = true;
    }
  };

  sendBtn.onclick = submitChat;
  chatInput.onkeypress = (e) => {
    if (e.key === 'Enter') submitChat();
  };
  // The blur's hide waits so a click on an autocomplete item fires first; focus or typing
  // within that wait cancels it, or the list would vanish under a fast click-away-and-back
  let blurHideTimer = null;
  const cancelBlurHide = () => {
    if (blurHideTimer !== null) clearTimeout(blurHideTimer);
    blurHideTimer = null;
  };
  chatInput.addEventListener('input', () => {
    cancelBlurHide();
    updateAutocomplete(chatInput.value);
  });
  chatInput.addEventListener('focus', cancelBlurHide);
  chatInput.addEventListener('blur', () => {
    cancelBlurHide();
    blurHideTimer = setTimeout(() => {
      blurHideTimer = null;
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
    appendFollowing(msgDiv);
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
  // Live rows: one append each, the list capped. The log follows the
  // newest row only while the reader is at (about) the end; scrolled up to
  // read back, a new row keeps their place (common.js isChatAtEnd)
  const appendFollowing = (row) => {
    const atEnd = isChatAtEnd(messageArea);
    messageArea.appendChild(row);
    while (messageArea.childElementCount > MAX_LOG_ROWS) messageArea.firstElementChild.remove();
    if (atEnd) scrollChatToEnd(messageArea);
  };
  const append = appendFollowing;

  const addSystemMessage = (message, _color = null, at = null) => {
    append(buildRow(message, null, at));
  };

  /**
   * A dim row only this page shows (never sent, never stored: a replay of
   * the server's log drops it), e.g. "Help: Play 9♦ (only you see this)".
   */
  const addPrivateMessage = (message) => {
    const row = buildRow(message, null);
    row.classList.add('is-private');
    append(row);
  };

  /**
   * A red fault row after a set hand's lines ("Fault: ann (bid 3, took 1)"):
   * the server's stored gameLogEntry that carries `fault` (main.js
   * onGameLogEntry); a replay of the snapshot log (replaceMessages, an
   * entry's `fault`) draws it again, in place.
   */
  const addFaultMessage = (message) => {
    const row = buildRow(message, null);
    row.classList.add('is-fault');
    append(row);
  };

  /**
   * The /help room notice ("ann used /help."): the server's stored
   * gameLogEntry that carries `help` (main.js onGameLogEntry), drawn in the
   * suggestion's gold so the table sees it (owner 2026-11-23: the gray line
   * was hard to see); a replay (replaceMessages, an entry's `help`) draws
   * it again, in place.
   */
  const addHelpMessage = (message, at = null) => {
    const row = buildRow(message, null, at);
    row.classList.add('is-help');
    append(row);
  };

  /**
   * The tutorial's room lines ("ann turned on the tutorial.", "ann is
   * playing with the tutorial.", "ann turned off the tutorial.", "This game
   * now counts as bot-assisted for ann."): the server's gameLogEntry that
   * carries `tutorial` (main.js onGameLogEntry), drawn like the /help
   * notice in the avatar cap's green (owner 2026-11-23: "a tutorial note in
   * the log for parity"); a replay (replaceMessages, an entry's
   * `tutorial`) draws it again, in place.
   */
  const addTutorialMessage = (message, at = null) => {
    const row = buildRow(message, null, at);
    row.classList.add('is-tutorial');
    append(row);
  };

  const addTrickResult = (winner, teamTricks, oppTricks) => {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'log-trick';
    msgDiv.textContent = `${winner} won the trick! (${teamTricks}-${oppTricks})`;
    appendFollowing(msgDiv);
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
      const row = buildRow(e.message, e.position ?? null, e.at ?? null);
      // a hand's fault line (the server's log item carries `fault`)
      if (e.fault) row.classList.add('is-fault');
      // the /help room notice (the log item carries `help`)
      else if (e.help) row.classList.add('is-help');
      // the tutorial's room lines (the log item carries `tutorial`)
      else if (e.tutorial) row.classList.add('is-tutorial');
      frag.appendChild(row);
    }
    // A replay (rejoin, resync) shows the same story: the reader keeps
    // their place unless they were at the end
    const atEnd = isChatAtEnd(messageArea);
    const top = messageArea.scrollTop;
    messageArea.replaceChildren(frag);
    if (atEnd) scrollChatToEnd(messageArea);
    else messageArea.scrollTop = top;
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
    // (two sides: a three-seat table's third cell and grid go)
    scoreSection.classList.remove('is-solo');
    opp2ScoreDiv.remove();
    teamDiv?.classList.remove('is-me');

    // Names are usernames, so build with textContent rather than innerHTML
    const fillScore = (div, names, score, bids, tricks) => {
      div.replaceChildren(
        line('log-score__names', names),
        line('log-score__value', score),
        line('log-score__detail', `Bids: ${bids} | Tricks: ${tricks}`),
      );
    };
    // each side in its team's color (my seat's team, the other)
    const gs = getGameState();
    if (gs.position || gs.isSpectator) {
      const mine = teamOf(viewerSeat(gs));
      const theirs = mine === 'a' ? 'b' : 'a';
      teamDiv?.classList.remove(...TEAM_CLASSES);
      teamDiv?.classList.add(`is-team-${mine}`);
      oppDiv?.classList.remove(...TEAM_CLASSES);
      oppDiv?.classList.add(`is-team-${theirs}`);
    }

    if (teamDiv) {
      fillScore(teamDiv, teamNames, teamScore, teamBids, teamTricks);
    }

    if (oppDiv) {
      fillScore(oppDiv, oppNames, oppScore, oppBids, oppTricks);
    }
  };

  /**
   * The score header of a three-seat table (Get Your Bid, owner
   * 2026-11-24: "the game log header ... now needs to show 3 scores"): one
   * cell per player, the viewer's first (state/gyb.js soloHeaderRows), each
   * the name, the score and "Bid n | Won m" in the seat's own colour; the
   * hand indicator moves to its own row under them (table.css
   * .log-score.is-solo).
   * @param {Array<{name, score, bid, tricks, letter, mine}>} rows - three
   */
  const updateSoloScore = (rows = []) => {
    const cells = [teamScoreDiv, oppScoreDiv, opp2ScoreDiv];
    scoreSection.classList.add('is-solo');
    // the three players, then the hand indicator on its own row
    if (!opp2ScoreDiv.isConnected) scoreSection.append(teamScoreDiv, oppScoreDiv, opp2ScoreDiv, handIndicator);
    cells.forEach((cell, i) => {
      const r = rows[i];
      cell.hidden = !r;
      if (!r) return;
      cell.classList.remove(...TEAM_CLASSES);
      cell.classList.add(`is-team-${r.letter}`);
      cell.classList.toggle('is-me', !!r.mine);
      cell.replaceChildren(
        line('log-score__names', r.name ?? ''),
        line('log-score__value', r.score ?? 0),
        line('log-score__detail', `Bid ${r.bid ?? '-'} | Won ${r.tricks ?? 0}`),
      );
    });
  };

  /**
   * Only the two name lines (the seats became known: positionUpdate while
   * the log is already up, a spectator's draw); the scores stay.
   * @param {string} teamNames - my side's names ('' while not known)
   * @param {string} oppNames - the other side's
   */
  const updateNames = (teamNames, oppNames) => {
    const set = (id, text) => {
      const names = container.querySelector(`#${id} .log-score__names`);
      if (names) names.textContent = String(text ?? '');
    };
    set('teamScoreDisplay', teamNames);
    set('oppScoreDisplay', oppNames);
  };

  return {
    container,
    addMessage,
    addSystemMessage,
    addPrivateMessage,
    addFaultMessage,
    addHelpMessage,
    addTutorialMessage,
    updateSoloScore,
    addGameMessage,
    addTrickResult,
    updateScores,
    updateTricks,
    updateFullScore,
    updateNames,
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
