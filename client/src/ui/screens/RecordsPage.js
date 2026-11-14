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

/**
 * Create a time period box.
 *
 * @param {string} title - Box title
 * @param {Object|null} periodData - Record data for this period
 * @returns {HTMLElement} Period box element
 */
function createPeriodBox(title, periodData) {
  const box = el('section', { className: 'screen-section records-box' });
  box.appendChild(el('h3', { className: 'records-box__title', text: title }));

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

/** The total line, the bot-games note when there are none yet, and the three boxes. */
function renderRecordsBody(records, totalGames, scope) {
  const body = [];

  if (scope === 'bots' && !totalGames) {
    body.push(el('p', { className: 'scope-note', text: BOT_STATS_EMPTY_NOTE }));
  }

  // Total games played
  if (totalGames != null) {
    body.push(el('div', {
      className: 'records-total',
      children: [el('strong', { text: totalGames.toLocaleString() }), document.createTextNode(' games played')],
    }));
  }

  // Three boxes row
  const periods = records || {};
  body.push(el('div', {
    className: 'records-grid',
    children: [
      createPeriodBox('All Time', periods.allTime),
      createPeriodBox('This Year', periods.thisYear),
      createPeriodBox('This Month', periods.thisMonth),
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
 */
export function showRecordsPage(records, totalGames, socket = null, scope = getStatsScope()) {
  // Remove any existing records page
  removeRecordsPage();

  currentScope = isStatsScope(scope) ? scope : 'human';
  const region = el('div', { className: 'scope-region', attrs: { id: 'recordsRegion' } });
  region.replaceChildren(...renderRecordsBody(records, totalGames, currentScope));
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
export function updateRecordsPage(records, totalGames, scope) {
  if (!recordsModal || !scopeRegion) return false;
  if (isStatsScope(scope)) {
    currentScope = scope;
    scopeControl?.setValue(scope);
  }
  scopeRegion.replaceChildren(...renderRecordsBody(records, totalGames, currentScope));
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
