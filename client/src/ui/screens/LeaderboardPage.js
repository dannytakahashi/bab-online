/**
 * Leaderboard Page Screen
 *
 * A kit Modal showing player stats in a sortable table (item 18b: classes
 * from styles/screens.css, usernames as text).
 */

import { profileAvatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { el, openModal } from '../kit/index.js';

/**
 * Module state - tracks current sort configuration.
 */
let currentSort = { column: 'winRate', ascending: false };
let currentLeaderboard = null;
let currentSocket = null;
let leaderboardModal = null;

/**
 * Get the appropriate profile picture source.
 *
 * @param {Object} player - Player data
 * @returns {string} Image source (base64 or URL)
 */
function getProfilePicSrc(player) {
  return profileAvatarSrc(player, 'assets/profile1.png');
}

/**
 * Format a stat value for display.
 *
 * @param {number} value - Raw stat value
 * @param {string} type - Type of stat ('percent', 'decimal', 'ratio')
 * @returns {string} Formatted stat string
 */
function formatStatValue(value, type) {
  if (type === 'integer') {
    return String(value);
  }
  if (type === 'percent') {
    return value.toFixed(1) + '%';
  }
  if (type === 'ratio') {
    return value.toFixed(2);
  }
  return value.toFixed(1);
}

/**
 * Sort the leaderboard data based on current sort settings.
 *
 * @param {Array} data - Leaderboard data
 * @returns {Array} Sorted data
 */
function sortLeaderboard(data) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    const aVal = a[currentSort.column];
    const bVal = b[currentSort.column];
    const diff = currentSort.ascending ? aVal - bVal : bVal - aVal;
    return diff;
  });
  return sorted;
}

/**
 * Column configuration for the leaderboard table (widths: .lb-col--<key>
 * in styles/screens.css).
 */
const COLUMNS = [
  { key: 'rank', label: '#', sortable: false },
  { key: 'player', label: 'Player', sortable: false },
  { key: 'gamesPlayed', label: 'Games', sortable: true, type: 'integer', defaultAscending: false },
  { key: 'winRate', label: 'Win %', sortable: true, type: 'percent', defaultAscending: false },
  { key: 'pointsPerGame', label: 'Pts/Game', sortable: true, type: 'decimal', defaultAscending: false },
  { key: 'bidsPerGame', label: 'Bids/Game', sortable: true, type: 'decimal', defaultAscending: false },
  { key: 'tricksPerBid', label: 'Tricks/Bid', sortable: true, type: 'ratio', defaultAscending: true },
  { key: 'setRate', label: 'Set %', sortable: true, type: 'percent', defaultAscending: true },
  { key: 'drag', label: 'Drag', sortable: true, type: 'decimal', defaultAscending: true },
  { key: 'avgHSI', label: 'HSI', sortable: true, type: 'decimal', defaultAscending: false },
];

/**
 * Create a table header cell. A sortable column's label is a button (a
 * keyboard can sort too); the sorted column carries aria-sort.
 *
 * @param {Object} column - Column configuration
 * @param {Function} onSort - Sort handler
 * @returns {HTMLElement} Header cell element
 */
function createHeaderCell(column, onSort) {
  const th = el('th', {
    className: [`lb-col--${column.key}`, column.key === 'player' ? 'is-left' : '', column.sortable ? '' : 'is-static'].filter(Boolean).join(' '),
    attrs: { scope: 'col' },
  });

  if (column.sortable) {
    const isActive = currentSort.column === column.key;
    if (isActive) th.setAttribute('aria-sort', currentSort.ascending ? 'ascending' : 'descending');
    const btn = el('button', {
      className: 'lb-sort',
      attrs: { type: 'button', title: `Sort by ${column.label}` },
      children: [el('span', { text: column.label })],
    });
    if (isActive) {
      btn.appendChild(el('span', { attrs: { 'aria-hidden': 'true' }, text: currentSort.ascending ? ' ▲' : ' ▼' }));
    }
    btn.addEventListener('click', () => onSort(column.key));
    th.appendChild(btn);
  } else {
    th.textContent = column.label;
  }

  return th;
}

/**
 * Create a table data cell.
 *
 * @param {string|number|Node} value - Cell value (a string goes in as text)
 * @param {string} align - Text alignment
 * @returns {HTMLElement} Data cell element
 */
function createDataCell(value, align = 'center') {
  const td = el('td', { className: align === 'left' ? 'is-left' : '' });
  if (typeof value === 'string' || typeof value === 'number') {
    td.textContent = String(value);
  } else {
    td.appendChild(value);
  }
  return td;
}

/**
 * Create a player cell with avatar and username.
 *
 * @param {Object} player - Player data
 * @returns {HTMLElement} Player cell content
 */
function createPlayerCell(player) {
  const avatar = el('img', { attrs: { alt: '' } });
  applyAvatarImg(avatar, getProfilePicSrc(player), { lazy: true });
  return el('div', { className: 'lb-player', children: [avatar, el('span', { text: player.username })] });
}

/**
 * Render the table body with sorted data.
 *
 * @param {HTMLElement} tbody - Table body element
 * @param {Array} data - Leaderboard data
 */
function renderTableBody(tbody, data) {
  tbody.replaceChildren();

  const sortedData = sortLeaderboard(data);

  let rank = 0;
  sortedData.forEach((player) => {
    const isPopulation = player.isPopulation;
    if (!isPopulation) rank++;

    const tr = el('tr', { className: `lb-row${isPopulation ? ' lb-row--population' : ''}` });

    // Rank
    tr.appendChild(createDataCell(isPopulation ? '—' : rank));

    // Player (avatar + username, or "Population" label)
    tr.appendChild(createDataCell(isPopulation ? el('span', { text: 'Population' }) : createPlayerCell(player), 'left'));

    // Stats columns
    tr.appendChild(createDataCell(formatStatValue(player.gamesPlayed, 'integer')));
    tr.appendChild(createDataCell(formatStatValue(player.winRate, 'percent')));
    tr.appendChild(createDataCell(formatStatValue(player.pointsPerGame, 'decimal')));
    tr.appendChild(createDataCell(formatStatValue(player.bidsPerGame, 'decimal')));
    tr.appendChild(createDataCell(formatStatValue(player.tricksPerBid, 'ratio')));
    tr.appendChild(createDataCell(formatStatValue(player.setRate, 'percent')));
    tr.appendChild(createDataCell(formatStatValue(player.drag, 'decimal')));
    tr.appendChild(createDataCell(formatStatValue(player.avgHSI, 'decimal')));

    tbody.appendChild(tr);
  });

  // If no players, show message
  if (sortedData.length === 0) {
    const td = el('td', { className: 'lb-empty', attrs: { colspan: COLUMNS.length }, text: 'No players have completed games yet.' });
    tbody.appendChild(el('tr', { children: [td] }));
  }
}

/**
 * Show the leaderboard page (a kit Modal: Escape and the close button
 * close it, focus comes back to the Leaderboard button).
 *
 * @param {Array} leaderboard - Leaderboard data
 * @param {Object} socket - Socket instance
 */
export function showLeaderboardPage(leaderboard, socket) {
  console.log('Showing leaderboard page...', leaderboard.length, 'players');

  // Remove any existing leaderboard page
  removeLeaderboardPage();

  currentLeaderboard = leaderboard;
  currentSocket = socket;
  currentSort = { column: 'winRate', ascending: false };

  // Table container with vertical scroll only
  const tableContainer = el('div', { className: 'lb-scroll' });
  const table = el('table', { className: 'lb-table' });

  const thead = el('thead');
  const headerTr = el('tr');
  const tbody = el('tbody');

  // Sort handler
  const handleSort = (columnKey) => {
    if (currentSort.column === columnKey) {
      currentSort.ascending = !currentSort.ascending;
    } else {
      currentSort.column = columnKey;
      // Use column's preferred default sort direction
      const column = COLUMNS.find((c) => c.key === columnKey);
      currentSort.ascending = column?.defaultAscending ?? false;
    }

    // Re-render header to update sort indicators (focus stays on the column)
    headerTr.replaceChildren(...COLUMNS.map((col) => createHeaderCell(col, handleSort)));
    headerTr.querySelector(`.lb-col--${columnKey} .lb-sort`)?.focus();

    // Re-render table body with new sort
    renderTableBody(tbody, currentLeaderboard);
  };

  // Build header
  COLUMNS.forEach((col) => headerTr.appendChild(createHeaderCell(col, handleSort)));
  thead.appendChild(headerTr);
  table.appendChild(thead);

  // Build body
  renderTableBody(tbody, leaderboard);
  table.appendChild(tbody);

  tableContainer.appendChild(table);

  leaderboardModal = openModal({
    title: 'Leaderboard',
    closable: true,
    closeLabel: 'Close leaderboard',
    id: 'leaderboardPageOverlay',
    dialogId: 'leaderboardPageModal',
    className: 'page-modal page-modal--wide',
    body: tableContainer,
    onClose: () => {
      leaderboardModal = null;
      currentLeaderboard = null;
    },
  });
}

/**
 * Remove the leaderboard page.
 */
export function removeLeaderboardPage() {
  leaderboardModal?.close('api');
  leaderboardModal = null;
  document.getElementById('leaderboardPageOverlay')?.remove();
  currentLeaderboard = null;
}

/**
 * Check if leaderboard page is currently visible.
 *
 * @returns {boolean} True if leaderboard page is visible
 */
export function isLeaderboardPageVisible() {
  return document.getElementById('leaderboardPageOverlay') !== null;
}
