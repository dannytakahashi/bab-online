/**
 * Records Page Screen
 *
 * A kit Modal showing game records (highest score, lowest score, biggest
 * win, most / least bags) across three time periods: All Time, This Year,
 * This Month. Classes from styles/screens.css (item 18b): success / danger /
 * warning by meaning; player names as text.
 */

import { el, openModal } from '../kit/index.js';

let recordsModal = null;

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

/**
 * Show the records page.
 *
 * @param {Object} records - Records data with allTime, thisYear, thisMonth
 * @param {number} [totalGames]
 */
export function showRecordsPage(records, totalGames) {
  // Remove any existing records page
  removeRecordsPage();

  const body = [];

  // Total games played
  if (totalGames != null) {
    body.push(el('div', {
      className: 'records-total',
      children: [el('strong', { text: totalGames.toLocaleString() }), document.createTextNode(' games played')],
    }));
  }

  // Three boxes row
  body.push(el('div', {
    className: 'records-grid',
    children: [
      createPeriodBox('All Time', records.allTime),
      createPeriodBox('This Year', records.thisYear),
      createPeriodBox('This Month', records.thisMonth),
    ],
  }));

  recordsModal = openModal({
    title: 'Records',
    closable: true,
    closeLabel: 'Close records',
    id: 'recordsPageOverlay',
    dialogId: 'recordsPageModal',
    className: 'page-modal page-modal--wide',
    body,
    onClose: () => {
      recordsModal = null;
    },
  });
}

/**
 * Remove the records page.
 */
export function removeRecordsPage() {
  recordsModal?.close('api');
  recordsModal = null;
  document.getElementById('recordsPageOverlay')?.remove();
}
