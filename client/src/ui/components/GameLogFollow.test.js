/**
 * The game log follows the newest row only while the reader is at its end
 * (later #17): it used to jump to the bottom on every event, so a player
 * scrolled up to read back lost their place on each card played.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createGameLog } from './GameLog.js';

let gameLog;
afterEach(() => {
  gameLog?.destroy();
  gameLog = null;
});

/** jsdom lays nothing out: give the row area a size (100 px tall, 20 px a row). */
function sized(log) {
  const area = log.container.querySelector('#gameFeedMessages');
  Object.defineProperty(area, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => area.childElementCount * 20 });
  return area;
}

const fill = (log, n = 10) => {
  for (let i = 0; i < n; i++) log.addGameMessage(`row ${i}`, 1);
};

describe('the game log\'s scroll', () => {
  it('at the end: each new row keeps the newest in view', () => {
    gameLog = createGameLog();
    const area = sized(gameLog);
    fill(gameLog);
    expect(area.scrollTop).toBe(200);
    gameLog.addSystemMessage('more');
    expect(area.scrollTop).toBe(220);
  });

  it('scrolled up to read back: new rows (play, chat, trick result, a replay) never move it', () => {
    gameLog = createGameLog();
    const area = sized(gameLog);
    fill(gameLog);
    area.scrollTop = 40; // reading the third row
    gameLog.addGameMessage('bob played the 5', 2);
    gameLog.addSystemMessage('trick');
    gameLog.addMessage('bob', 'hi', 2);
    gameLog.addTrickResult('bob', 1, 0);
    expect(area.scrollTop).toBe(40);
    gameLog.replaceMessages(Array.from({ length: 15 }, (_, i) => ({ message: `r${i}`, position: 1 })));
    expect(area.scrollTop).toBe(40);
  });

  it('back at the end (within the slack): it follows again', () => {
    gameLog = createGameLog();
    const area = sized(gameLog);
    fill(gameLog);
    area.scrollTop = area.scrollHeight - 100 - 10;
    gameLog.addSystemMessage('next');
    expect(area.scrollTop).toBe(area.scrollHeight);
  });

  it('a replay from the end lands on the newest row', () => {
    gameLog = createGameLog();
    const area = sized(gameLog);
    gameLog.replaceMessages(Array.from({ length: 12 }, (_, i) => ({ message: `r${i}`, position: 1 })));
    expect(area.scrollTop).toBe(240);
  });
});

describe('sending from the game log', () => {
  it('my own line goes back to the end; a refused send (offline) keeps the draft and the place', () => {
    let accept = true;
    const onChatSubmit = vi.fn(() => (accept ? undefined : false));
    gameLog = createGameLog({ onChatSubmit });
    const area = sized(gameLog);
    fill(gameLog);
    area.scrollTop = 0;
    gameLog.chatInput.value = 'good game';
    gameLog.chatInput.onkeypress({ key: 'Enter' });
    expect(onChatSubmit).toHaveBeenCalledWith('good game');
    expect(gameLog.chatInput.value).toBe('');
    expect(area.scrollTop).toBe(area.scrollHeight);
    accept = false;
    area.scrollTop = 0;
    gameLog.chatInput.value = 'not sent';
    gameLog.chatInput.onkeypress({ key: 'Enter' });
    expect(gameLog.chatInput.value).toBe('not sent');
    expect(area.scrollTop).toBe(0);
  });
});
