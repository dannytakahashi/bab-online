/**
 * The scorecard on the web (ui/components/Scorecard.js): the table's cells
 * and colours, the results modal's "Summary | Scorecard" control (Summary
 * first and shown), and mid-game: the score header becomes the button that
 * opens it in a kit modal, the hand in play last with its bids only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderScorecard, scorecardModelFor, openScorecardModal, closeScorecardModal, refreshScorecardModal, hasScorecard } from './Scorecard.js';
import { showFinalScoreOverlay, removeFinalScoreOverlay } from './ScoreModal.js';
import { buildScorecard } from '../../state/scorecard.js';
import { GameState } from '../../state/GameState.js';
import { createGameLog } from './GameLog.js';

const H = (suit, rank = '7') => ({ suit, rank });
const NAMES = { 1: 'ivy', 2: 'kim', 3: 'hal', 4: 'jon' };
const ROWS = [
  { handNo: 1, handSize: 12, trump: H('hearts'), dealer: 2, bids: ['3', '2', '2', '1'], took: [3, 3, 3, 3], points: [51, 33], scores: [51, 33], faults: [], set: [false, false] },
  { handNo: 2, handSize: 10, trump: H('spades'), dealer: 3, bids: ['2', '3', '2', '2'], took: [3, 1, 2, 2], points: [41, -50], scores: [92, -17], faults: [2], set: [false, true] },
  { handNo: 5, handSize: 4, trump: H('hearts'), dealer: 2, bids: ['B', '0', '0', '0'], took: [4, 0, 0, 0], points: [80, 0], scores: [162, 47], faults: [], set: [false, false] },
  { handNo: 9, handSize: 5, trump: H('diamonds'), dealer: 4, bids: ['1', '2B', '0', '0'], took: [1, 4, 0, 0], points: [10, -200], scores: [182, -143], faults: [], set: [false, true] },
];

function stateWith({ rows = ROWS, position = 1, spectator = false, mode = null } = {}) {
  const gs = new GameState();
  gs.gameId = 'g1';
  gs.position = position;
  gs.isSpectator = spectator;
  gs.mode = mode;
  gs.playerData = { position: [1, 2, 3, 4], username: [1, 2, 3, 4].map((p) => ({ username: NAMES[p] })) };
  gs.scorecard = rows;
  return gs;
}

afterEach(() => {
  closeScorecardModal();
  removeFinalScoreOverlay();
  document.body.replaceChildren();
});

describe('the table', () => {
  it('pairs over their players, a Score column per pair, the cells as the mockup', () => {
    const node = renderScorecard(buildScorecard({ rows: ROWS, me: 1, name: (p) => NAMES[p] }));
    const pairs = [...node.querySelectorAll('.scorecard__pair')].map((n) => [n.textContent, n.className.includes('is-team-a') ? 'a' : 'b']);
    expect(pairs).toEqual([['ivy & hal', 'a'], ['kim & jon', 'b']]);
    expect([...node.querySelectorAll('.scorecard__player')].map((n) => n.textContent)).toEqual(['ivy', 'hal', 'kim', 'jon']);
    const rows = node.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(4);
    // row 1: no delta line; the totals in the pairs' colours
    expect(rows[0].querySelectorAll('.scorecard__delta')).toHaveLength(0);
    expect([...rows[0].querySelectorAll('.scorecard__total')].map((n) => n.textContent)).toEqual(['51', '33']);
    // row 2: the delta ABOVE the total
    const score = rows[1].querySelectorAll('.scorecard__score')[1];
    expect([...score.children].map((n) => [n.className, n.textContent])).toEqual([
      ['scorecard__delta', '−50'], ['scorecard__total is-team-b', '-17'],
    ]);
    // gold extra tricks, the red pill, the green bore, the set bore
    expect(rows[0].querySelectorAll('.scorecard__took.is-extra')).toHaveLength(3);
    const kim = rows[1].querySelectorAll('.scorecard__seat')[2].firstChild;
    expect(kim.className).toBe('scorecard__cell is-fault');
    expect(kim.textContent).toBe('3→1');
    expect(rows[2].querySelector('.scorecard__cell').className).toBe('scorecard__cell is-bore');
    expect(rows[3].querySelectorAll('.scorecard__seat')[2].firstChild.className).toBe('scorecard__cell is-bore is-fault');
    // the hand column: size + suit, red for hearts
    expect(rows[0].querySelector('.scorecard__suit').className).toContain('is-red');
    expect(rows[1].querySelector('.scorecard__suit').className).not.toContain('is-red');
  });

  it('screen readers get one sentence per row; the drawn cells are hidden', () => {
    const node = renderScorecard(buildScorecard({ rows: ROWS, me: 1, name: (p) => NAMES[p] }));
    const row = node.querySelectorAll('tbody tr')[1];
    expect(row.querySelector('.visually-hidden').textContent).toMatch(/^Hand 10, spades\. Dealer hal\. ivy bid 2, took 3, one extra\./);
    expect(node.querySelector('table').getAttribute('role')).toBe('presentation');
    expect(node.querySelector('thead').getAttribute('aria-hidden')).toBe('true');
    for (const td of row.querySelectorAll('td.scorecard__seat > *, td.scorecard__score')) expect(td.getAttribute('aria-hidden')).toBe('true');
  });

  it('names are text, never markup', () => {
    const node = renderScorecard(buildScorecard({ rows: ROWS, me: 1, name: (p) => (p === 1 ? '<b>x</b>' : NAMES[p]) }));
    expect(node.querySelector('b')).toBeNull();
    expect(node.textContent).toContain('<b>x</b>');
  });

  it('no rows yet: says so', () => {
    expect(renderScorecard(buildScorecard({ rows: [], me: 1 })).textContent).toBe('No hands played yet.');
  });

  it('Get Your Bid: no pairs; each player\'s name over its Score column with "Score" under it; the Forbidden Bid under its cell', () => {
    const row = { handNo: 9, handSize: 5, trump: H('clubs'), dealer: 3, bids: ['2', '1', '1'], took: [2, 0, 3], points: [12, 0, 0], scores: [40, 21, 7], faults: [], forbidden: { position: 3, bid: 2 } };
    const node = renderScorecard(buildScorecard({ rows: [row], solo: true, me: 1, name: (p) => (p === 3 ? '🤖 Mary' : NAMES[p]) }));
    expect(node.querySelectorAll('.scorecard__pair')).toHaveLength(0);
    // review of PR #455: the second set of names said nothing about being scores
    expect([...node.querySelectorAll('.scorecard__pairname')].map((n) => [n.textContent, n.className.match(/is-team-(\w)/)[1]])).toEqual([['ivy', 'a'], ['kim', 'b'], ['Mary', 'c']]);
    expect([...node.querySelectorAll('.scorecard__scorehead')].map((n) => n.textContent)).toEqual(['Score', 'Score', 'Score']);
    expect([...node.querySelectorAll('.scorecard__player')].map((n) => n.textContent)).toEqual(['ivy', 'kim', '🤖 Mary']);
    // the Forbidden Bid: under the cell (its own line), never inside the "bid → took" pill
    const cell = node.querySelectorAll('.scorecard__seat')[2].firstChild;
    expect(cell.className).toBe('scorecard__stack');
    expect(cell.querySelector('.scorecard__cell').textContent).toBe('1→3');
    expect(cell.querySelector('.scorecard__cell s')).toBeNull();
    expect(cell.lastChild.tagName).toBe('S');
    expect(cell.lastChild.textContent).toBe('2');
    expect(node.querySelectorAll('.is-fault')).toHaveLength(0);
    expect(node.querySelector('.scorecard__dealer').textContent).toBe('Mary'); // the dealer without the bot mark
  });

  it('a pair\'s names over its Score column can wrap at " & " ("ivy &" / "hal"), without the bot mark', () => {
    const node = renderScorecard(buildScorecard({ rows: ROWS, me: 1, name: (p) => (p === 2 ? '🤖 Mike' : NAMES[p]) }));
    const heads = [...node.querySelectorAll('.scorecard__pairname')];
    expect(heads.map((h) => [...h.querySelectorAll('.scorecard__line')].map((l) => l.textContent))).toEqual([['ivy &', 'hal'], ['Mike &', 'jon']]);
    expect(heads.map((h) => h.textContent)).toEqual(['ivy & hal', 'Mike & jon']);
    expect(node.querySelector('.scorecard__pair.is-team-b').textContent).toBe('🤖 Mike & jon');
  });
});

describe('the results modal', () => {
  it('Summary | Scorecard, Summary first and shown; the Scorecard tab shows the table', () => {
    const gs = stateWith();
    showFinalScoreOverlay({
      teamScore: 182, oppScore: -143, playerStats: null, onReturnToLobby: () => {},
      teamName: 'ivy/hal', oppName: 'kim/jon',
      scorecard: renderScorecard(scorecardModelFor(gs, { current: false })),
    });
    const modal = document.getElementById('finalScoreOverlay');
    const options = [...modal.querySelectorAll('.result-tabs [role="radio"]')];
    expect(options.map((o) => [o.textContent, o.getAttribute('aria-checked')])).toEqual([['Summary', 'true'], ['Scorecard', 'false']]);
    const panel = (k) => modal.querySelector(`[data-panel="${k}"]`);
    expect(panel('summary').hidden).toBe(false);
    expect(panel('scorecard').hidden).toBe(true);
    expect(panel('summary').textContent).toContain('ivy/hal: 182');
    options[1].click();
    expect(panel('scorecard').hidden).toBe(false);
    expect(panel('summary').hidden).toBe(true);
    expect(panel('scorecard').querySelectorAll('tbody tr')).toHaveLength(4);
    // arrow keys move and select
    options[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(panel('summary').hidden).toBe(false);
    // the Return button stays outside the tabs
    expect(modal.querySelector('.kit-modal__actions button').textContent).toBe('Return to Lobby');
    // one width for both tabs (the dialog never jumps between them)
    expect(modal.querySelector('[role="dialog"]').classList.contains('has-scorecard')).toBe(true);
  });

  it('without a scorecard (an older server): no control, the summary as before', () => {
    showFinalScoreOverlay({ teamScore: 10, oppScore: 0, playerStats: null, onReturnToLobby: () => {}, teamName: 'a/b', oppName: 'c/d' });
    expect(document.querySelector('.result-tabs')).toBeNull();
    expect(document.querySelector('.has-scorecard')).toBeNull();
  });

  it('Get Your Bid\'s results get the control too', () => {
    const end = { scores: [40, 21, 7], winners: [1], made: [5, 3, 1], hands: 13 };
    const pd = { position: [1, 2, 3], username: [{ username: 'ivy' }, { username: 'kim' }, { username: 'hal' }] };
    showFinalScoreOverlay({ solo: { end, playerData: pd, myPosition: 1 }, onReturnToLobby: () => {}, scorecard: document.createElement('div') });
    expect(document.querySelectorAll('.result-tabs [role="radio"]')).toHaveLength(2);
  });
});

describe('mid-game: the score header opens it', () => {
  it('the hand indicator is a "Scorecard" button with a "›" only while the server keeps one; the scores stay readable text', () => {
    const log = createGameLog();
    document.body.appendChild(log.container);
    const header = log.container.querySelector('#gameLogScore');
    const hand = header.querySelector('#handIndicator');
    expect(hand.getAttribute('role')).toBeNull();
    let opened = 0;
    log.setScorecard(() => { opened++; });
    // review of PR #455: the whole header as the button hid the scores from screen readers
    expect(header.getAttribute('role')).toBeNull();
    expect(header.getAttribute('aria-label')).toBeNull();
    expect(hand.getAttribute('role')).toBe('button');
    expect(hand.getAttribute('tabindex')).toBe('0');
    expect(hand.getAttribute('aria-label')).toBe('Scorecard');
    const described = hand.getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Hand›', '-']);
    expect(hand.querySelector('.log-hand__more').getAttribute('aria-hidden')).toBe('true');
    expect(header.querySelector('#teamScoreDisplay').closest('[role="button"]')).toBeNull();
    header.click();
    hand.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toBe(2);
    log.setScorecard(null);
    expect(hand.getAttribute('role')).toBeNull();
    expect(hand.getAttribute('aria-describedby')).toBeNull();
    expect(header.querySelector('.log-hand__more')).toBeNull();
    header.click();
    expect(opened).toBe(2);
  });

  it('the modal: the rows so far, the hand in play last with bids only; it redraws; Escape closes it', () => {
    const gs = stateWith({ rows: ROWS.slice(0, 2) });
    gs.applyDeal({ gameId: 'g1', currentHand: 8, dealer: 4, hand: [], trump: H('diamonds'), scorecardRows: 2 });
    gs.bids = { 1: '1' };
    expect(hasScorecard(gs)).toBe(true);
    openScorecardModal(gs);
    const dialog = document.querySelector('#scorecardModal [role="dialog"]');
    expect(dialog.querySelector('.kit-modal__title').textContent).toBe('Scorecard');
    let rows = dialog.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[2].className).toContain('is-current');
    expect(rows[2].querySelectorAll('.scorecard__seat')[0].textContent).toBe('1→–');
    expect(rows[2].querySelectorAll('.scorecard__seat')[1].textContent).toBe('–');
    expect(rows[2].querySelectorAll('.scorecard__score')[0].textContent).toBe('–');
    gs.bids = { 1: '1', 3: '2' };
    refreshScorecardModal();
    rows = document.querySelectorAll('#scorecardModal tbody tr');
    expect(rows[2].querySelectorAll('.scorecard__seat')[1].textContent).toBe('2→–');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('scorecardModal')).toBeNull();
  });

  it('a spectator sees seats 1 and 3 first', () => {
    const gs = stateWith({ spectator: true, position: 1 });
    const m = scorecardModelFor(gs, { current: false });
    expect(m.groups.map((g) => g.label)).toEqual(['ivy & hal', 'kim & jon']);
  });
});
