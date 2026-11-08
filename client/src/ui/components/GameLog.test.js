import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGameLog, showGameLog } from './GameLog.js';

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

  it('destroy removes container', () => {
    gameLog = createGameLog();
    document.body.appendChild(gameLog.container);

    expect(document.getElementById('gameFeed')).toBeTruthy();

    gameLog.destroy();
    gameLog = null;

    expect(document.getElementById('gameFeed')).toBeFalsy();
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
