/**
 * Leaderboard Page Screen
 *
 * Modal overlay showing player stats in a sortable table.
 */

/**
 * Module state - tracks current sort configuration.
 */
let currentSort = { column: 'winRate', ascending: false };
let currentLeaderboard = null;
let currentSocket = null;

/**
 * Get the appropriate profile picture source.
 *
 * @param {Object} player - Player data
 * @returns {string} Image source (base64 or URL)
 */
function getProfilePicSrc(player) {
  if (player.customProfilePic) {
    return player.customProfilePic;
  }
  if (player.profilePic) {
    return `assets/profile${player.profilePic}.png`;
  }
  return 'assets/profile1.png';
}

/**
 * Format a stat value for display.
 *
 * @param {number} value - Raw stat value
 * @param {string} type - Type of stat ('percent', 'decimal', 'ratio')
 * @returns {string} Formatted stat string
 */
function formatStatValue(value, type) {
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
 * Column configuration for the leaderboard table.
 */
const COLUMNS = [
  { key: 'rank', label: '#', width: '40px', sortable: false },
  { key: 'player', label: 'Player', width: '140px', sortable: false },
  { key: 'winRate', label: 'Win %', width: '65px', sortable: true, type: 'percent', defaultAscending: false },
  { key: 'pointsPerGame', label: 'Pts/Game', width: '75px', sortable: true, type: 'decimal', defaultAscending: false },
  { key: 'bidsPerGame', label: 'Bids/Game', width: '80px', sortable: true, type: 'decimal', defaultAscending: false },
  { key: 'tricksPerBid', label: 'Tricks/Bid', width: '80px', sortable: true, type: 'ratio', defaultAscending: true },
  { key: 'setRate', label: 'Set %', width: '60px', sortable: true, type: 'percent', defaultAscending: true },
  { key: 'drag', label: 'Drag', width: '55px', sortable: true, type: 'decimal', defaultAscending: true },
  { key: 'avgHSI', label: 'HSI', width: '55px', sortable: true, type: 'decimal', defaultAscending: false },
];

/**
 * Create a table header cell.
 *
 * @param {Object} column - Column configuration
 * @param {Function} onSort - Sort handler
 * @returns {HTMLElement} Header cell element
 */
function createHeaderCell(column, onSort) {
  const th = document.createElement('th');
  th.style.padding = '12px 8px';
  th.style.textAlign = column.key === 'player' ? 'left' : 'center';
  th.style.fontWeight = 'bold';
  th.style.fontSize = '13px';
  th.style.textTransform = 'uppercase';
  th.style.borderBottom = '2px solid #4a5568';
  th.style.position = 'sticky';
  th.style.top = '0';
  th.style.background = '#1a1a2e';
  th.style.zIndex = '10';
  th.style.width = column.width;

  if (column.sortable) {
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.style.transition = 'color 0.2s';

    const isActive = currentSort.column === column.key;
    th.style.color = isActive ? '#4ade80' : '#9ca3af';

    const labelSpan = document.createElement('span');
    labelSpan.innerText = column.label;
    th.appendChild(labelSpan);

    if (isActive) {
      const arrow = document.createElement('span');
      arrow.innerText = currentSort.ascending ? ' \u25B2' : ' \u25BC';
      arrow.style.fontSize = '10px';
      th.appendChild(arrow);
    }

    th.addEventListener('mouseenter', () => {
      if (!isActive) th.style.color = '#60a5fa';
    });
    th.addEventListener('mouseleave', () => {
      th.style.color = isActive ? '#4ade80' : '#9ca3af';
    });
    th.addEventListener('click', () => {
      onSort(column.key);
    });
  } else {
    th.style.color = '#9ca3af';
    th.innerText = column.label;
  }

  return th;
}

/**
 * Create a table data cell.
 *
 * @param {string|number} value - Cell value
 * @param {string} align - Text alignment
 * @returns {HTMLElement} Data cell element
 */
function createDataCell(value, align = 'center') {
  const td = document.createElement('td');
  td.style.padding = '10px 8px';
  td.style.textAlign = align;
  td.style.borderBottom = '1px solid #2d3748';
  td.style.color = '#e5e7eb';
  td.style.fontSize = '14px';

  if (typeof value === 'string' || typeof value === 'number') {
    td.innerText = value;
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
  const container = document.createElement('div');
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.gap = '8px';
  container.style.maxWidth = '100%';
  container.style.overflow = 'hidden';

  const avatar = document.createElement('img');
  avatar.src = getProfilePicSrc(player);
  avatar.style.width = '24px';
  avatar.style.height = '24px';
  avatar.style.borderRadius = '50%';
  avatar.style.objectFit = 'cover';
  avatar.style.flexShrink = '0';
  avatar.alt = player.username;
  container.appendChild(avatar);

  const username = document.createElement('span');
  username.innerText = player.username;
  username.style.overflow = 'hidden';
  username.style.textOverflow = 'ellipsis';
  username.style.whiteSpace = 'nowrap';
  username.style.minWidth = '0';
  container.appendChild(username);

  return container;
}

/**
 * Render the table body with sorted data.
 *
 * @param {HTMLElement} tbody - Table body element
 * @param {Array} data - Leaderboard data
 */
function renderTableBody(tbody, data) {
  tbody.innerHTML = '';

  const sortedData = sortLeaderboard(data);

  sortedData.forEach((player, index) => {
    const tr = document.createElement('tr');
    tr.style.transition = 'background 0.2s';
    tr.addEventListener('mouseenter', () => {
      tr.style.background = 'rgba(255, 255, 255, 0.05)';
    });
    tr.addEventListener('mouseleave', () => {
      tr.style.background = 'transparent';
    });

    // Rank
    tr.appendChild(createDataCell(index + 1));

    // Player (avatar + username)
    tr.appendChild(createDataCell(createPlayerCell(player), 'left'));

    // Stats columns
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
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = COLUMNS.length;
    td.style.padding = '40px';
    td.style.textAlign = 'center';
    td.style.color = '#9ca3af';
    td.style.fontStyle = 'italic';
    td.innerText = 'No players have completed games yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

/**
 * Show the leaderboard page.
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

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'leaderboardPageOverlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.right = '0';
  overlay.style.bottom = '0';
  overlay.style.background = 'rgba(0, 0, 0, 0.7)';
  overlay.style.zIndex = '2000';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';

  // Create modal container
  const modal = document.createElement('div');
  modal.id = 'leaderboardPageModal';
  modal.style.background = '#1a1a2e';
  modal.style.color = '#fff';
  modal.style.padding = '25px';
  modal.style.borderRadius = '12px';
  modal.style.border = '2px solid #4a5568';
  modal.style.width = '900px';
  modal.style.maxWidth = '95vw';
  modal.style.maxHeight = '90vh';
  modal.style.boxSizing = 'border-box';
  modal.style.fontFamily = 'Arial, sans-serif';
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';

  // Header
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.marginBottom = '20px';
  headerRow.style.flexShrink = '0';

  const title = document.createElement('div');
  title.innerText = 'Leaderboard';
  title.style.fontSize = '24px';
  title.style.fontWeight = 'bold';
  title.style.color = '#4ade80';
  headerRow.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.innerText = 'X';
  closeBtn.style.background = '#ef4444';
  closeBtn.style.border = 'none';
  closeBtn.style.borderRadius = '50%';
  closeBtn.style.width = '36px';
  closeBtn.style.height = '36px';
  closeBtn.style.color = '#fff';
  closeBtn.style.fontSize = '18px';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontWeight = 'bold';
  closeBtn.addEventListener('click', () => {
    removeLeaderboardPage();
  });
  closeBtn.addEventListener('mouseenter', () => {
    closeBtn.style.background = '#dc2626';
  });
  closeBtn.addEventListener('mouseleave', () => {
    closeBtn.style.background = '#ef4444';
  });
  headerRow.appendChild(closeBtn);

  modal.appendChild(headerRow);

  // Table container with vertical scroll only
  const tableContainer = document.createElement('div');
  tableContainer.style.flex = '1';
  tableContainer.style.overflowY = 'auto';
  tableContainer.style.overflowX = 'hidden';
  tableContainer.style.maxHeight = '500px';
  tableContainer.style.borderRadius = '8px';
  tableContainer.style.border = '1px solid #2d3748';

  // Create table
  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.style.tableLayout = 'fixed';

  // Create table header
  const thead = document.createElement('thead');
  const headerTr = document.createElement('tr');

  // Reference to tbody for re-rendering on sort
  const tbody = document.createElement('tbody');

  // Sort handler
  const handleSort = (columnKey) => {
    if (currentSort.column === columnKey) {
      currentSort.ascending = !currentSort.ascending;
    } else {
      currentSort.column = columnKey;
      // Use column's preferred default sort direction
      const column = COLUMNS.find(c => c.key === columnKey);
      currentSort.ascending = column?.defaultAscending ?? false;
    }

    // Re-render header to update sort indicators
    headerTr.innerHTML = '';
    COLUMNS.forEach((col) => {
      headerTr.appendChild(createHeaderCell(col, handleSort));
    });

    // Re-render table body with new sort
    renderTableBody(tbody, currentLeaderboard);
  };

  // Build header
  COLUMNS.forEach((col) => {
    headerTr.appendChild(createHeaderCell(col, handleSort));
  });
  thead.appendChild(headerTr);
  table.appendChild(thead);

  // Build body
  renderTableBody(tbody, leaderboard);
  table.appendChild(tbody);

  tableContainer.appendChild(table);
  modal.appendChild(tableContainer);

  overlay.appendChild(modal);

  // Close on overlay click (but not modal click)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      removeLeaderboardPage();
    }
  });

  document.body.appendChild(overlay);
}

/**
 * Remove the leaderboard page.
 */
export function removeLeaderboardPage() {
  const overlay = document.getElementById('leaderboardPageOverlay');
  if (overlay) overlay.remove();
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
