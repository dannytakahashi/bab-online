/**
 * The scorecard table (owner 2026-11-27; the model is state/scorecard.js):
 * one row per completed hand, "bid → took" per player under each pair's
 * names, the pairs' running scores with the hand's points above them.
 *
 * Where it shows:
 *   - the results modal's "Summary | Scorecard" control (ScoreModal.js,
 *     createResultTabs): Summary first and the default, unchanged;
 *   - mid-game: the score header (#gameLogScore) is a button that opens it
 *     in a kit modal (openScorecardModal), the hand in play as its last
 *     row (bids only). Spectators too.
 *
 * Colours (table.css .scorecard): gold for extra tricks (the over-trick
 * pip's --gold), a red pill for a player at fault (--danger-text on its
 * tint), a green outline for a bore (--primary-base), red pill + red
 * outline for a bore that was set; the pairs' names and scores in their
 * team's colour (the score header's, by seat: 1 and 3 blue, 2 and 4 coral),
 * the player cells neutral. Nothing else uses those colours here.
 *
 * Screen readers: the table is presentational; each row is one sentence
 * ("Hand 12, hearts. Dealer kim. ivy bid 3, took 3. ...") in a visually
 * hidden span, the drawn cells hidden from it.
 */

import { el, openModal } from '../kit/index.js';
import { buildScorecard, signed } from '../../state/scorecard.js';
import { teamPlayerDataOf } from '../../state/teamPlayerData.js';

/** A seat's name for the card: its owner (a lazy or resigned seat's), as the score header. */
function nameFn(state) {
  const pd = teamPlayerDataOf(state);
  return (pos) => {
    if (!pd || !Array.isArray(pd.position) || !Array.isArray(pd.username)) return '';
    const i = pd.position.indexOf(pos);
    if (i === -1) return '';
    const e = pd.username[i];
    const n = typeof e === 'string' ? e : e?.username;
    return typeof n === 'string' ? n : '';
  };
}

/** Is this a viewer without a seat of their own (the card is then seen from seat 1)? */
const pureSpectator = (state) => !!state.isSpectator && !state.isLazy && !state.shoulder;

/**
 * The model for the live state (GameState): its rows, the viewer's columns
 * and, while `current`, the hand in play.
 */
export function scorecardModelFor(state, { current = true } = {}) {
  const me = pureSpectator(state) ? null : (state.position || null);
  return buildScorecard({
    rows: state.scorecard || [],
    solo: state.mode === 'gyb',
    me,
    name: nameFn(state),
    current: current && typeof state.scorecardCurrent === 'function' ? state.scorecardCurrent() : null,
  });
}

/** Does the server keep a scorecard for this table (the feature, by its key)? */
export function hasScorecard(state) {
  return Array.isArray(state?.scorecard);
}

const hidden = { 'aria-hidden': 'true' };

function cellNode(c) {
  if (c.bid === null) return el('span', { className: 'scorecard__none', attrs: hidden, text: '–' });
  const classes = ['scorecard__cell'];
  if (c.boreSet) classes.push('is-bore', 'is-fault');
  else if (c.bore) classes.push('is-bore');
  else if (c.fault) classes.push('is-fault');
  const took = c.took === null ? '–' : String(c.took);
  const node = el('span', {
    className: classes.join(' '),
    attrs: hidden,
    children: [
      el('span', { className: 'scorecard__bid', text: c.bid }),
      el('span', { className: 'scorecard__arrow', text: '→' }),
      el('span', { className: `scorecard__took${c.extra ? ' is-extra' : ''}`, text: took }),
    ],
  });
  if (c.forbidden !== null) {
    // Get Your Bid: the last bidder's Forbidden Bid, struck as on the bid
    // sheet, muted (red is the fault's) and under the cell, so it never
    // reads as a took digit
    return el('span', {
      className: 'scorecard__stack',
      attrs: hidden,
      children: [node, el('s', { className: 'scorecard__forbidden', attrs: { title: `Forbidden Bid: ${c.forbidden}` }, text: String(c.forbidden) })],
    });
  }
  return node;
}

/**
 * The table for a model (buildScorecard / scorecardModelFor).
 * @returns {HTMLElement}
 */
export function renderScorecard(model) {
  const wrap = el('div', { className: `scorecard${model.solo ? ' is-solo' : ''}`, attrs: { 'data-testid': 'scorecard' } });
  if (!model.rows.length) {
    wrap.appendChild(el('p', { className: 'scorecard__empty', text: 'No hands played yet.' }));
    return wrap;
  }
  const table = el('table', { className: 'scorecard__table', attrs: { role: 'presentation' } });
  const colgroup = el('colgroup');
  colgroup.append(el('col', { className: 'scorecard__col-hand' }), el('col', { className: 'scorecard__col-dealer' }));
  for (let i = 0; i < model.players.length; i++) colgroup.appendChild(el('col'));
  for (let i = 0; i < model.scores.length; i++) colgroup.appendChild(el('col', { className: 'scorecard__col-score' }));
  table.appendChild(colgroup);

  const thead = el('thead', { attrs: hidden });
  // the pairs over their players (Get Your Bid: nothing, its players' names
  // head their bid columns), then over each Score column its names, with
  // "Score" under them in the next row, both modes
  const grp = el('tr', { className: 'scorecard__groups' });
  grp.append(el('th'), el('th'));
  if (model.solo) {
    grp.appendChild(el('th', { attrs: { colspan: String(model.players.length) } }));
  } else {
    for (const g of model.groups) {
      grp.appendChild(el('th', { className: `scorecard__pair is-team-${g.letter}`, attrs: { colspan: '2', title: g.label }, text: g.label }));
    }
  }
  for (const s of model.scores) {
    grp.appendChild(el('th', { className: `scorecard__pairname is-team-${s.letter}`, attrs: { title: s.label }, children: scoreNames(s) }));
  }
  thead.appendChild(grp);
  const head = el('tr', { className: 'scorecard__head' });
  head.append(el('th', { className: 'scorecard__hand', text: 'Hand' }), el('th', { className: 'scorecard__dealerhead', text: 'Dealer' }));
  for (const p of model.players) {
    head.appendChild(el('th', { className: `scorecard__player is-team-${p.letter}${p.mine ? ' is-me' : ''}`, attrs: { title: p.name }, text: p.name }));
  }
  for (let i = 0; i < model.scores.length; i++) head.appendChild(el('th', { className: 'scorecard__scorehead', text: 'Score' }));
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const r of model.rows) {
    const tr = el('tr', { className: `scorecard__row${r.current ? ' is-current' : ''}`, dataset: { hand: String(r.hand.size) } });
    const handCell = el('td', { className: 'scorecard__hand' });
    handCell.appendChild(el('span', { className: 'visually-hidden', text: r.spoken }));
    const label = el('span', { attrs: hidden, children: [el('span', { text: String(r.hand.size) })] });
    if (r.hand.symbol) {
      label.appendChild(el('span', { className: `scorecard__suit${r.hand.red ? ' is-red' : ''}${r.hand.joker ? ' is-joker' : ''}`, text: r.hand.symbol }));
    }
    handCell.appendChild(label);
    tr.appendChild(handCell);
    tr.appendChild(el('td', { className: 'scorecard__dealer', attrs: { ...hidden, title: r.dealerName }, text: r.dealerName }));
    for (const c of r.cells) tr.appendChild(el('td', { className: 'scorecard__seat', children: [cellNode(c)] }));
    r.scores.forEach((sc, i) => {
      const td = el('td', { className: 'scorecard__score', attrs: hidden });
      if (!sc) {
        td.appendChild(el('span', { className: 'scorecard__none', text: '–' }));
      } else {
        // the change above the new total: a ledger (owner 2026-11-27);
        // none on the first hand, where it would equal the total
        if (sc.showDelta) td.appendChild(el('div', { className: 'scorecard__delta', text: signed(sc.delta) }));
        td.appendChild(el('div', { className: `scorecard__total is-team-${model.scores[i].letter}`, text: String(sc.total) }));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** A Score column's names: one line, wrapping at " & " where the column is narrow ("ivy &" / "hal"). */
function scoreNames(s) {
  const lines = Array.isArray(s.lines) && s.lines.length ? s.lines : [s.label];
  const children = [];
  lines.forEach((line, i) => {
    if (i) children.push(document.createTextNode(' '));
    children.push(el('span', { className: 'scorecard__line', text: line }));
  });
  return children;
}

/** The scorecard modal open mid-game (one at a time). */
let open = null;

/**
 * The scorecard as a kit modal (the score header's tap): closable, Escape
 * and a backdrop click close it; main.js syncScorecard redraws it while
 * open (refreshScorecardModal: a bid, a hand's end, a snapshot).
 * @param {Object} state - GameState
 * @returns {{close: Function}}
 */
export function openScorecardModal(state) {
  if (open) return open;
  const body = el('div', { className: 'scorecard-modal__body' });
  const draw = () => body.replaceChildren(renderScorecard(scorecardModelFor(state)));
  draw();
  const modal = openModal({
    id: 'scorecardModal',
    title: 'Scorecard',
    body,
    closable: true,
    dismissible: true,
    initialFocus: 'dialog',
    className: 'scorecard-modal',
    onClose: () => {
      open = null;
    },
  });
  open = { close: () => modal.close('api'), modal, redraw: draw };
  return open;
}

/** Redraw the open mid-game scorecard from the state (no-op when closed). */
export function refreshScorecardModal() {
  open?.redraw();
}

/** Close the mid-game scorecard if it is open (leaving the table, the game's end). */
export function closeScorecardModal() {
  open?.close();
}

/**
 * The results modal's "Summary | Scorecard" control (a WAI-ARIA radio
 * group, the scope controls' look): Summary first and selected; each
 * choice shows its panel and hides the other.
 * @param {HTMLElement[]} summary - the summary's nodes (unchanged)
 * @param {HTMLElement} card - the scorecard
 * @returns {HTMLElement[]} the control, then both panels
 */
export function createResultTabs(summary, card) {
  const keys = ['summary', 'scorecard'];
  const labels = { summary: 'Summary', scorecard: 'Scorecard' };
  const group = el('div', { className: 'scope-control result-tabs', attrs: { role: 'radiogroup', 'aria-label': 'Results view' } });
  const panels = {
    summary: el('div', { className: 'result-tabs__panel', dataset: { panel: 'summary' }, children: summary }),
    scorecard: el('div', { className: 'result-tabs__panel', dataset: { panel: 'scorecard' }, children: [card] }),
  };
  const buttons = {};
  let current = 'summary';
  const render = () => {
    for (const k of keys) {
      buttons[k].setAttribute('aria-checked', String(k === current));
      buttons[k].tabIndex = k === current ? 0 : -1;
      panels[k].hidden = k !== current;
    }
  };
  const choose = (k, { focus = false } = {}) => {
    if (focus) buttons[k].focus();
    current = k;
    render();
  };
  for (const k of keys) {
    buttons[k] = el('button', {
      className: 'scope-control__option',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1' },
      dataset: { tab: k },
      text: labels[k],
    });
    buttons[k].addEventListener('click', () => choose(k));
    group.appendChild(buttons[k]);
  }
  group.addEventListener('keydown', (e) => {
    const i = keys.indexOf(current);
    let next = null;
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) next = keys[(i + 1) % 2];
    else if (e.key === 'Home') next = keys[0];
    else if (e.key === 'End') next = keys[1];
    if (next) {
      e.preventDefault();
      choose(next, { focus: true });
    }
  });
  render();
  return [group, panels.summary, panels.scorecard];
}
