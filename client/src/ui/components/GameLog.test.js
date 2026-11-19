import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createGameLog, showGameLog } from './GameLog.js';
import { getGameState, resetGameState } from '../../state/GameState.js';
import { readClientFile } from '../../testing/files.js';
import { resetAssistUses, forgetAssistUses, noteAssistUses } from '../../state/assistHint.js';

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

  // Its first labels (before any score header render): the players' names
  // when the seats are known, else empty; never a placeholder (owner
  // 2026-11-17: "Your Team" / "Opponents" flashed before the names)
  const names = () => [...gameLog.container.querySelectorAll('.log-score__names')].map((n) => n.textContent);
  const seat = (state, position) => {
    state.position = position;
    state.setPlayerData({
      positions: [1, 2, 3, 4],
      usernames: ['ann', 'bob', 'cat', 'dan'].map((username) => ({ username })),
    });
  };

  it('first labels, seats not known yet: empty for a player and a spectator', () => {
    resetGameState();
    gameLog = createGameLog();
    expect(names()).toEqual(['', '']);
    gameLog.destroy();
    getGameState().isSpectator = true;
    gameLog = createGameLog();
    expect(names()).toEqual(['', '']);
    resetGameState();
  });

  it('first labels, seated (createUI comes after positionUpdate): a player\'s me/partner and opp1/opp2', () => {
    resetGameState();
    seat(getGameState(), 2);
    gameLog = createGameLog();
    expect(names()).toEqual(['bob/dan', 'cat/ann']);
    resetGameState();
  });

  it('first labels, seated: a spectator\'s seats 1/3 then 2/4', () => {
    resetGameState();
    getGameState().isSpectator = true;
    seat(getGameState(), null);
    gameLog = createGameLog();
    expect(names()).toEqual(['ann/cat', 'bob/dan']);
    resetGameState();
  });

  it('the name lines keep their height while empty (table.css)', () => {
    const css = readClientFile('styles/table.css');
    const rule = css.match(/\.log-score__names\s*\{([^}]*)\}/)?.[1] || '';
    expect(rule).toMatch(/min-height:\s*1lh/);
    expect(rule).toMatch(/min-height:\s*1\.2em/);
  });

  it('updateNames: only the name lines change, the scores stay', () => {
    resetGameState();
    gameLog = createGameLog();
    gameLog.updateFullScore('', '', 10, 20, '3/2', '1/1', 4, 2);
    gameLog.updateNames('ann/cat', 'bob/dan');
    expect(names()).toEqual(['ann/cat', 'bob/dan']);
    expect(gameLog.container.querySelector('#teamScoreDisplay .log-score__value').textContent).toBe('10');
    expect(gameLog.container.querySelector('#oppScoreDisplay .log-score__detail').textContent).toBe('Bids: 1/1 | Tricks: 2');
    gameLog.updateNames('<b>x</b>/y', '');
    expect(gameLog.container.querySelector('#teamScoreDisplay b')).toBeNull();
    expect(names()).toEqual(['<b>x</b>/y', '']);
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

describe('autocomplete after a quick blur and refocus', () => {
  let gameLog;
  afterEach(() => {
    vi.useRealTimers();
    gameLog?.destroy();
    gameLog = null;
    resetGameState();
  });

  it('a focus within the blur wait keeps the list open for the next typing', () => {
    vi.useFakeTimers();
    resetGameState();
    gameLog = createGameLog();
    const input = gameLog.chatInput;
    input.value = '/';
    input.dispatchEvent(new Event('input'));
    const dropdown = gameLog.container.querySelector('.slash-item').parentElement;
    // click away and back within the 150 ms wait, without typing yet
    input.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(50);
    input.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(500);
    expect(dropdown.hidden).toBe(false);
  });

  it('a plain blur still hides it after the wait', () => {
    vi.useFakeTimers();
    resetGameState();
    gameLog = createGameLog();
    const input = gameLog.chatInput;
    input.value = '/';
    input.dispatchEvent(new Event('input'));
    const dropdown = gameLog.container.querySelector('.slash-item').parentElement;
    expect(dropdown.hidden).toBe(false);
    input.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(149);
    expect(dropdown.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(dropdown.hidden).toBe(true);
  });
});

describe('/help in the autocomplete (plan H3)', () => {
  let gameLog;
  const helpFor = (text) => {
    gameLog.chatInput.value = text;
    gameLog.chatInput.dispatchEvent(new Event('input'));
    return [...gameLog.container.querySelectorAll('.slash-item')].map((item) => ({
      cmd: item.querySelector('.slash-item__cmd').textContent,
      desc: item.querySelector('.slash-item__desc').textContent,
    }));
  };
  const hint = (uses, assisted = false) => ({ v: 1, kind: 'card', headline: 'Play 9♦', uses, freeUses: 3, assisted });

  beforeEach(() => {
    resetGameState();
    forgetAssistUses();
  });
  afterEach(() => {
    gameLog?.destroy();
    gameLog = null;
    forgetAssistUses();
    resetGameState();
  });

  it('is first in a seat\'s list, with this game\'s uses read each time the list is drawn', () => {
    gameLog = createGameLog();
    resetAssistUses();
    expect(helpFor('/')[0]).toEqual({ cmd: '/help', desc: 'Suggest a move (0 of 3 free used)' });
    noteAssistUses(hint(1));
    expect(helpFor('/he')).toEqual([{ cmd: '/help', desc: 'Suggest a move (1 of 3 free used)' }]);
    noteAssistUses(hint(3));
    expect(helpFor('/h')).toEqual([{ cmd: '/help', desc: 'Suggest a move (the next one makes this game bot-assisted)' }]);
    noteAssistUses(hint(4, true));
    expect(helpFor('/help')).toEqual([{ cmd: '/help', desc: 'Suggest a move (this game is bot-assisted for you)' }]);
  });

  it('unknown counts (a reload) say the free uses per game', () => {
    gameLog = createGameLog();
    expect(helpFor('/he')).toEqual([{ cmd: '/help', desc: 'Suggest a move (after 3 free, this game counts as bot-assisted)' }]);
  });

  it('a partial /he sends /help; a spectator\'s list has no /help', () => {
    const sent = [];
    gameLog = createGameLog({ onChatSubmit: (m) => { sent.push(m); } });
    gameLog.chatInput.value = '/he';
    gameLog.chatInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter' }));
    expect(sent).toEqual(['/help']);
    gameLog.destroy();
    getGameState().isSpectator = true;
    gameLog = createGameLog();
    expect(helpFor('/h')).toEqual([]);
  });

  it('a private row: dim, the system style, marked is-private', () => {
    gameLog = createGameLog();
    gameLog.addPrivateMessage('Help: Play 9♦ (only you see this)');
    const row = gameLog.container.querySelector('.log-row.is-private');
    expect(row.classList.contains('is-system')).toBe(true);
    expect(row.querySelector('.log-row__text').textContent).toBe('Help: Play 9♦ (only you see this)');
  });

  it('a fault row (the server\'s gameLogEntry with fault): a system row marked is-fault (table.css draws it red); a replay draws only the ones it is given (entry.fault)', () => {
    gameLog = createGameLog();
    gameLog.addFaultMessage('Fault: ann (bid 3, took 1)');
    const row = gameLog.container.querySelector('.log-row.is-fault');
    expect(row.classList.contains('is-system')).toBe(true);
    expect(row.querySelector('.log-row__text').textContent).toBe('Fault: ann (bid 3, took 1)');
    gameLog.replaceMessages([{ message: '--- HAND COMPLETE ---' }]);
    expect(gameLog.container.querySelector('.log-row.is-fault')).toBeNull();
    gameLog.replaceMessages([{ message: '--- HAND COMPLETE ---' }, { message: 'Fault: ann (bid 3, took 1)', fault: true }]);
    const again = [...gameLog.container.querySelectorAll('.log-row.is-fault')];
    expect(again.map((r) => r.querySelector('.log-row__text').textContent)).toEqual(['Fault: ann (bid 3, took 1)']);
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
