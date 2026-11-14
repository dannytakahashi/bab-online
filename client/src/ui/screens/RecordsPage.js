/**
 * Records Page Screen
 *
 * A kit Modal showing game records (highest score, lowest score, biggest
 * win, most / least bags) across three time periods: All Time, This Year,
 * This Month. Classes from styles/screens.css (item 18b): success / danger /
 * warning by meaning; player names as text. The stats scope control on top
 * (Human games | Bot games | All games, state/statsScope.js) re-asks the
 * server and swaps the body below it in place when the reply comes
 * (main.js updateRecordsPage). In the bot / all scopes a record's players
 * include bot personas ('🤖 Mary'), plain strings like the rest.
 *
 * Game counts (owner 2026-11-14: the one "N games played" line was the
 * all-time count whatever column you read): each box says how many games
 * its period holds, from the reply's periodGames. The overall line is shown
 * only without periodGames (a reply from before it), where it is the
 * all-time count it always was; with them it would only repeat All Time's.
 */

import { el, openModal } from '../kit/index.js';
import { createStatsScopeControl } from '../components/StatsScopeControl.js';
import {
  getStatsScope, setStatsScope, isStatsScope, createScopeRequester, BOT_STATS_EMPTY_NOTE,
} from '../../state/statsScope.js';

let recordsModal = null;
/** The open page's scope, its control and the region swapped on a reply. */
let currentScope = 'human';
let scopeControl = null;
let scopeRegion = null;
let requester = null;

/**
 * Create a single record entry element.
 *
 * @param {string} label - Record label
 * @param {string} tone - Label tone: 'success' | 'danger' | 'warning' | 'neutral'
 * @param {Object|null} data - Record data
 * @param {string} type - 'score', 'bags' or 'win'
 * @returns {HTMLElement} Record entry element
 */
function createRecordEntry(label, tone, data, type) {
  const entry = el('div', { className: 'record' });
  entry.appendChild(el('div', { className: `record__label tone-${tone}`, text: label }));

  if (!data) {
    entry.appendChild(el('div', { className: 'record__none', text: 'No games yet' }));
    return entry;
  }

  if (type === 'score') {
    entry.appendChild(el('div', { className: 'record__value', text: `${data.score} pts` }));
    entry.appendChild(el('div', { className: 'record__sub', text: data.players.join(' & ') }));
  } else if (type === 'bags') {
    entry.appendChild(el('div', { className: 'record__value', text: `${data.bags} bags` }));
    entry.appendChild(el('div', { className: 'record__sub', text: data.players.join(' & ') }));
  } else if (type === 'win') {
    entry.appendChild(el('div', { className: 'record__value', text: `${data.margin} pt margin` }));
    entry.appendChild(el('div', { className: 'record__sub', text: `${data.winnerScore} - ${data.loserScore}` }));
    entry.appendChild(el('div', { className: 'record__sub is-winner', text: `W: ${data.winnerPlayers.join(' & ')}` }));
    entry.appendChild(el('div', { className: 'record__sub is-loser', text: `L: ${data.loserPlayers.join(' & ')}` }));
  }

  return entry;
}

/** A game count as the page writes it: the bold number, then "game(s) played". */
function gamesPlayed(count) {
  return [el('strong', { text: count.toLocaleString() }), document.createTextNode(count === 1 ? ' game played' : ' games played')];
}

/** A count the page can show: a non-negative integer, else null (not known). */
function countOrNull(n) {
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Create a time period box.
 *
 * @param {string} title - Box title
 * @param {Object|null} periodData - Record data for this period
 * @param {number|null} games - the period's game count (periodGames), null when not known
 * @returns {HTMLElement} Period box element
 */
function createPeriodBox(title, periodData, games = null) {
  const box = el('section', { className: 'screen-section records-box' });
  const head = el('div', { className: 'records-box__head' });
  head.appendChild(el('h3', { className: 'records-box__title', text: title }));
  if (games != null) head.appendChild(el('p', { className: 'records-box__count', children: gamesPlayed(games) }));
  box.appendChild(head);

  if (!periodData) {
    box.appendChild(el('div', { className: 'muted-note', text: 'No games yet' }));
    return box;
  }

  box.appendChild(createRecordEntry('Highest Score', 'success', periodData.highestScore, 'score'));
  box.appendChild(createRecordEntry('Lowest Score', 'danger', periodData.lowestScore, 'score'));
  box.appendChild(createRecordEntry('Biggest Win', 'warning', periodData.biggestWin, 'win'));
  box.appendChild(createRecordEntry('Most Bags', 'neutral', periodData.mostBags, 'bags'));
  box.appendChild(createRecordEntry('Least Bags', 'neutral', periodData.leastBags, 'bags'));

  return box;
}

/**
 * Each period's game count from the reply's periodGames (null when the
 * reply has none or a count is not a non-negative integer).
 */
export function periodCounts(periodGames) {
  const p = periodGames && typeof periodGames === 'object' ? periodGames : {};
  return {
    allTime: countOrNull(p.allTime),
    thisYear: countOrNull(p.thisYear),
    thisMonth: countOrNull(p.thisMonth),
  };
}

/**
 * The bot-games note when there are none yet, the overall line (only for a
 * reply without periodGames) and the three boxes, each with its count.
 */
function renderRecordsBody(records, totalGames, scope, periodGames) {
  const body = [];
  const counts = periodCounts(periodGames);
  const hasCounts = counts.allTime != null || counts.thisYear != null || counts.thisMonth != null;
  // the scope's all-time count: periodGames.allTime, else totalGames (the same number)
  const allTime = counts.allTime ?? countOrNull(totalGames);

  if (scope === 'bots' && !allTime) {
    body.push(el('p', { className: 'scope-note', text: BOT_STATS_EMPTY_NOTE }));
  }

  // A reply without periodGames: the one all-time total, as before
  if (!hasCounts && allTime != null) {
    body.push(el('div', { className: 'records-total', children: gamesPlayed(allTime) }));
  }

  // Three boxes row
  const periods = records || {};
  body.push(el('div', {
    className: 'records-grid',
    children: [
      createPeriodBox('All Time', periods.allTime, hasCounts ? allTime : null),
      createPeriodBox('This Year', periods.thisYear, counts.thisYear),
      createPeriodBox('This Month', periods.thisMonth, counts.thisMonth),
    ],
  }));
  return body;
}

/**
 * Show the records page.
 *
 * @param {Object} records - Records data with allTime, thisYear, thisMonth
 * @param {number} [totalGames]
 * @param {Object} [socket] - re-asks for another scope
 * @param {string} [scope] - the scope these records are for (default: the device's choice)
 * @param {Object} [periodGames] - {allTime, thisYear, thisMonth} game counts (recordsResponse.periodGames)
 */
export function showRecordsPage(records, totalGames, socket = null, scope = getStatsScope(), periodGames = undefined) {
  // Remove any existing records page
  removeRecordsPage();

  currentScope = isStatsScope(scope) ? scope : 'human';
  const region = el('div', { className: 'scope-region', attrs: { id: 'recordsRegion' } });
  region.replaceChildren(...renderRecordsBody(records, totalGames, currentScope, periodGames));
  scopeRegion = region;
  const send = createScopeRequester((next) => socket?.emit('getRecords', { scope: next }));
  requester = send;
  scopeControl = createStatsScopeControl({
    value: currentScope,
    label: 'Which games the records count',
    onChange: (next) => {
      setStatsScope(next);
      currentScope = next;
      region.setAttribute('aria-busy', 'true');
      send.request(next);
    },
  });
  scopeControl.element.setAttribute('aria-controls', 'recordsRegion');

  recordsModal = openModal({
    title: 'Records',
    closable: true,
    closeLabel: 'Close records',
    id: 'recordsPageOverlay',
    dialogId: 'recordsPageModal',
    className: 'page-modal page-modal--wide',
    body: [scopeControl.element, region],
    onClose: () => {
      recordsModal = null;
      forgetScopeUi();
    },
  });
}

function forgetScopeUi() {
  requester?.cancel();
  requester = null;
  scopeControl = null;
  scopeRegion = null;
}

/**
 * New records for the open page (a scope switch's reply), swapped in below
 * the control; the modal and focus stay.
 *
 * @returns {boolean} false when no records page is open
 */
export function updateRecordsPage(records, totalGames, scope, periodGames = undefined) {
  if (!recordsModal || !scopeRegion) return false;
  if (isStatsScope(scope)) {
    currentScope = scope;
    scopeControl?.setValue(scope);
  }
  scopeRegion.replaceChildren(...renderRecordsBody(records, totalGames, currentScope, periodGames));
  scopeRegion.removeAttribute('aria-busy');
  return true;
}

/** A failed request: the open page stops waiting (the error is a toast). */
export function recordsRequestFailed() {
  scopeRegion?.removeAttribute('aria-busy');
}

/** Whether the records page is open. */
export function isRecordsPageVisible() {
  return document.getElementById('recordsPageOverlay') !== null;
}

/**
 * Remove the records page.
 */
export function removeRecordsPage() {
  recordsModal?.close('api');
  recordsModal = null;
  document.getElementById('recordsPageOverlay')?.remove();
  forgetScopeUi();
}
