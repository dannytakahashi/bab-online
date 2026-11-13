import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGameLog, showGameLog } from './GameLog.js';
import { getGameState, resetGameState } from '../../state/GameState.js';
import { readClientFile } from '../../testing/files.js';

describe('createGameLog', () => {
  let gameLog;

  afterEach(() => {
    if (gameLog) {
      gameLog.destroy();
      gameLog = null;
    }
  });

  it('creates game log container', () => {
    gameLog = createGameLog();
    expect(gameLog.container).toBeDefined();
    expect(gameLog.container.id).toBe('gameFeed');
  });

  it('has score section', () => {
    gameLog = createGameLog();
    const scoreSection = gameLog.container.querySelector('#gameLogScore');
    expect(scoreSection).toBeTruthy();
  });

  it('has hand indicator', () => {
    gameLog = createGameLog();
    const handIndicator = gameLog.container.querySelector('#handIndicator');
    expect(handIndicator).toBeTruthy();
    const handValue = gameLog.container.querySelector('#hand-indicator-value');
    expect(handValue).toBeTruthy();
    expect(handValue.textContent).toBe('-');
  });

  it('has chat input', () => {
    gameLog = createGameLog();
    expect(gameLog.chatInput).toBeDefined();
    expect(gameLog.chatInput.type).toBe('text');
  });

  it('addMessage adds chat message', () => {
    gameLog = createGameLog();
    const messageArea = gameLog.container.querySelector('#gameFeedMessages');

    gameLog.addMessage('Alice', 'Hello!');

    expect(messageArea.textContent).toContain('Alice:');
    expect(messageArea.textContent).toContain('Hello!');
  });

  it('addSystemMessage adds system message', () => {
    gameLog = createGameLog();
    const messageArea = gameLog.container.querySelector('#gameFeedMessages');

    gameLog.addSystemMessage('Game started');

    expect(messageArea.textContent).toContain('Game started');
  });

  it('updateScores updates score display', () => {
    gameLog = createGameLog();
    document.body.appendChild(gameLog.container);

    gameLog.updateScores(50, 30);

    expect(gameLog.container.querySelector('#team-score-value').textContent).toBe('50');
    expect(gameLog.container.querySelector('#opp-score-value').textContent).toBe('30');
  });

  it('updateHandIndicator updates hand display', () => {
    gameLog = createGameLog();
    document.body.appendChild(gameLog.container);

    gameLog.updateHandIndicator(12);

    expect(gameLog.container.querySelector('#hand-indicator-value').textContent).toBe('12');
  });

  it('updateHandIndicator handles single digit hands', () => {
    gameLog = createGameLog();
    document.body.appendChild(gameLog.container);

    gameLog.updateHandIndicator(1);

    expect(gameLog.container.querySelector('#hand-indicator-value').textContent).toBe('1');
  });

  it('calls onChatSubmit when message sent', () => {
    const onChatSubmit = vi.fn();
    gameLog = createGameLog({ onChatSubmit });

    gameLog.chatInput.value = 'Test message';
    const sendBtn = gameLog.container.querySelector('button');
    sendBtn.click();

    expect(onChatSubmit).toHaveBeenCalledWith('Test message');
    expect(gameLog.chatInput.value).toBe('');
  });

  it('sends message on Enter key', () => {
    const onChatSubmit = vi.fn();
    gameLog = createGameLog({ onChatSubmit });

    gameLog.chatInput.value = 'Enter test';
    const enterEvent = new KeyboardEvent('keypress', { key: 'Enter' });
    gameLog.chatInput.dispatchEvent(enterEvent);

    expect(onChatSubmit).toHaveBeenCalledWith('Enter test');
  });

  it('does not send empty message', () => {
    const onChatSubmit = vi.fn();
    gameLog = createGameLog({ onChatSubmit });

    gameLog.chatInput.value = '   ';
    const sendBtn = gameLog.container.querySelector('button');
    sendBtn.click();

    expect(onChatSubmit).not.toHaveBeenCalled();
  });

  it('clearMessages clears message area', () => {
    gameLog = createGameLog();
    const messageArea = gameLog.container.querySelector('#gameFeedMessages');

    gameLog.addMessage('Test', 'message');
    expect(messageArea.textContent).toContain('Test');

    gameLog.clearMessages();
    expect(messageArea.textContent).toBe('');
  });

  it('updateFullScore renders usernames as text, not markup', () => {
    gameLog = createGameLog();

    gameLog.updateFullScore('<b>x</b>/Bob', '<img src=x>/Eve', 120, -40, '3/2', '1/1', 4, 2);

    const teamDiv = gameLog.container.querySelector('#teamScoreDisplay');
    const oppDiv = gameLog.container.querySelector('#oppScoreDisplay');
    expect(teamDiv.querySelector('b')).toBeNull();
    expect(oppDiv.querySelector('img')).toBeNull();
    expect(teamDiv.textContent).toContain('<b>x</b>/Bob');
    expect(teamDiv.textContent).toContain('120');
    expect(teamDiv.textContent).toContain('Bids: 3/2 | Tricks: 4');
    expect(oppDiv.textContent).toContain('<img src=x>/Eve');
    expect(oppDiv.textContent).toContain('-40');
  });

  it('the trick chips are in the absolute team colors, as the score above them is', () => {
    resetGameState();
    const state = getGameState();
    state.position = 4; // team B
    state.bids = { 1: '2', 2: '3', 3: '1', 4: '2' };
    gameLog = createGameLog();
    gameLog.showTrickIndicator(13);
    const chips = [...gameLog.container.querySelectorAll('.log-chip')];
    const n = (cls) => chips.filter((c) => c.classList.contains(cls)).length;
    expect([n('is-team'), n('is-opp')]).toEqual([5, 3]);
    expect(chips.slice(0, 5).every((c) => c.classList.contains('is-team-b'))).toBe(true);
    expect(chips.slice(5, 8).every((c) => c.classList.contains('is-team-a'))).toBe(true);
    // the score's "my team" is the same letter
    gameLog.updateFullScore('Me/Pal', 'Them/Too', 10, 20);
    expect(gameLog.container.querySelector('#teamScoreDisplay').classList.contains('is-team-b')).toBe(true);
    // after the bidding (team totals) at seat 1: mine blue
    state.position = 1;
    state.bids = { team1: 4, team2: 6 };
    gameLog.updateTrickIndicator();
    expect(chips.slice(0, 4).every((c) => c.classList.contains('is-team-a') && !c.classList.contains('is-team-b'))).toBe(true);
    expect(chips.slice(4, 10).every((c) => c.classList.contains('is-team-b'))).toBe(true);
    const css = readClientFile('styles/table.css');
    expect(css).toMatch(/\.log-chip\.is-team-a \{ background: var\(--team-a\); \}/);
    expect(css).toMatch(/\.log-chip\.is-team-b \{ background: var\(--team-b\); \}/);
    expect(css).not.toMatch(/\.log-chip\.is-(team|opp) \{/);
    resetGameState();
  });

  it('a bore fills the hand for its team (rules/bids.js), not 0', () => {
    resetGameState();
    const state = getGameState();
    state.position = 1;
    state.bids = { 1: '1', 2: 'B', 3: '1', 4: '0' };
    gameLog = createGameLog();
    gameLog.showTrickIndicator(4);
    const chips = [...gameLog.container.querySelectorAll('.log-chip')];
    const n = (cls) => chips.filter((c) => c.classList.contains(cls)).length;
    expect(chips).toHaveLength(6);
    expect([n('is-team'), n('is-opp'), n('is-overbid')]).toEqual([2, 4, 2]);
    resetGameState();
  });

  it('destroy removes container', () => {
    gameLog = createGameLog();
    document.body.appendChild(gameLog.container);

    expect(document.getElementById('gameFeed')).toBeTruthy();

    gameLog.destroy();
    gameLog = null;

    expect(document.getElementById('gameFeed')).toBeFalsy();
  });
});

describe('slash command help for /leave', () => {
  let gameLog;
  const helpFor = (text) => {
    gameLog.chatInput.value = text;
    gameLog.chatInput.dispatchEvent(new Event('input'));
    return [...gameLog.container.querySelectorAll('.slash-item')].map((item) => ({
      cmd: item.querySelector('.slash-item__cmd').textContent,
      desc: item.querySelector('.slash-item__desc').textContent,
    }));
  };

  afterEach(() => {
    gameLog?.destroy();
    gameLog = null;
    resetGameState();
  });

  it('at a seat names both outcomes: a bot takes over, or the game ends when no one else is here', () => {
    resetGameState();
    gameLog = createGameLog();
    const [leave] = helpFor('/le');
    expect(leave.cmd).toBe('/leave');
    // The server ends the game when the leaver was the only player (maybeAbort)
    expect(leave.desc).toMatch(/bot takes over/);
    expect(leave.desc).toMatch(/ends it if you're the only player/);
    expect(leave.desc).not.toMatch(/bot finishes for you\)$/);
  });

  it('for a pure spectator it only exits spectating', () => {
    resetGameState();
    getGameState().isSpectator = true;
    gameLog = createGameLog();
    expect(helpFor('/')).toEqual([{ cmd: '/leave', desc: 'Exit spectating' }]);
  });
});

describe('showGameLog', () => {
  afterEach(() => {
    document.getElementById('gameFeed')?.remove();
  });

  it('appends game log to body', () => {
    const log = showGameLog();

    expect(document.getElementById('gameFeed')).toBeTruthy();

    log.destroy();
  });
});
