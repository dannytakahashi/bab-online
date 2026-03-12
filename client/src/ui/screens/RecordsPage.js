/**
 * Records Page Screen
 *
 * Modal overlay showing game records (highest score, lowest score, biggest win)
 * across three time periods: All Time, This Year, This Month.
 */

/**
 * Create a single record entry element.
 *
 * @param {string} label - Record label
 * @param {string} color - Label color
 * @param {Object|null} data - Record data
 * @param {string} type - 'score' or 'win'
 * @returns {HTMLElement} Record entry element
 */
function createRecordEntry(label, color, data, type) {
  const entry = document.createElement('div');
  entry.style.marginBottom = '14px';

  const labelEl = document.createElement('div');
  labelEl.innerText = label;
  labelEl.style.fontSize = '13px';
  labelEl.style.fontWeight = 'bold';
  labelEl.style.color = color;
  labelEl.style.marginBottom = '4px';
  entry.appendChild(labelEl);

  if (!data) {
    const noData = document.createElement('div');
    noData.innerText = 'No games yet';
    noData.style.color = '#6b7280';
    noData.style.fontSize = '13px';
    noData.style.fontStyle = 'italic';
    entry.appendChild(noData);
    return entry;
  }

  if (type === 'score') {
    const scoreEl = document.createElement('div');
    scoreEl.innerText = `${data.score} pts`;
    scoreEl.style.fontSize = '20px';
    scoreEl.style.fontWeight = 'bold';
    scoreEl.style.color = '#fff';
    entry.appendChild(scoreEl);

    const playersEl = document.createElement('div');
    playersEl.innerText = data.players.join(' & ');
    playersEl.style.fontSize = '12px';
    playersEl.style.color = '#9ca3af';
    entry.appendChild(playersEl);
  } else if (type === 'bags') {
    const bagsEl = document.createElement('div');
    bagsEl.innerText = `${data.bags} bags`;
    bagsEl.style.fontSize = '20px';
    bagsEl.style.fontWeight = 'bold';
    bagsEl.style.color = '#fff';
    entry.appendChild(bagsEl);

    const playersEl = document.createElement('div');
    playersEl.innerText = data.players.join(' & ');
    playersEl.style.fontSize = '12px';
    playersEl.style.color = '#9ca3af';
    entry.appendChild(playersEl);
  } else if (type === 'win') {
    const marginEl = document.createElement('div');
    marginEl.innerText = `${data.margin} pt margin`;
    marginEl.style.fontSize = '20px';
    marginEl.style.fontWeight = 'bold';
    marginEl.style.color = '#fff';
    entry.appendChild(marginEl);

    const scoresEl = document.createElement('div');
    scoresEl.innerText = `${data.winnerScore} - ${data.loserScore}`;
    scoresEl.style.fontSize = '14px';
    scoresEl.style.color = '#d1d5db';
    scoresEl.style.marginBottom = '2px';
    entry.appendChild(scoresEl);

    const winnerEl = document.createElement('div');
    winnerEl.innerText = `W: ${data.winnerPlayers.join(' & ')}`;
    winnerEl.style.fontSize = '12px';
    winnerEl.style.color = '#4ade80';
    entry.appendChild(winnerEl);

    const loserEl = document.createElement('div');
    loserEl.innerText = `L: ${data.loserPlayers.join(' & ')}`;
    loserEl.style.fontSize = '12px';
    loserEl.style.color = '#f87171';
    entry.appendChild(loserEl);
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
  const box = document.createElement('div');
  box.style.flex = '1';
  box.style.minWidth = '250px';
  box.style.background = 'rgba(0, 0, 0, 0.3)';
  box.style.borderRadius = '8px';
  box.style.padding = '18px';
  box.style.border = '1px solid #4a5568';

  const heading = document.createElement('div');
  heading.innerText = title;
  heading.style.fontSize = '16px';
  heading.style.fontWeight = 'bold';
  heading.style.color = '#60a5fa';
  heading.style.marginBottom = '16px';
  heading.style.textAlign = 'center';
  heading.style.borderBottom = '1px solid #4a5568';
  heading.style.paddingBottom = '10px';
  box.appendChild(heading);

  if (!periodData) {
    const noData = document.createElement('div');
    noData.innerText = 'No games yet';
    noData.style.color = '#6b7280';
    noData.style.fontSize = '14px';
    noData.style.fontStyle = 'italic';
    noData.style.textAlign = 'center';
    noData.style.padding = '20px 0';
    box.appendChild(noData);
    return box;
  }

  box.appendChild(createRecordEntry('Highest Score', '#4ade80', periodData.highestScore, 'score'));
  box.appendChild(createRecordEntry('Lowest Score', '#f87171', periodData.lowestScore, 'score'));
  box.appendChild(createRecordEntry('Biggest Win', '#fbbf24', periodData.biggestWin, 'win'));
  box.appendChild(createRecordEntry('Most Bags', '#fb923c', periodData.mostBags, 'bags'));
  box.appendChild(createRecordEntry('Least Bags', '#a78bfa', periodData.leastBags, 'bags'));

  return box;
}

/**
 * Show the records page.
 *
 * @param {Object} records - Records data with allTime, thisYear, thisMonth
 */
export function showRecordsPage(records, totalGames) {
  // Remove any existing records page
  removeRecordsPage();

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'recordsPageOverlay';
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

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) removeRecordsPage();
  });

  // Create modal container
  const modal = document.createElement('div');
  modal.id = 'recordsPageModal';
  modal.style.background = '#1a1a2e';
  modal.style.color = '#fff';
  modal.style.padding = '25px';
  modal.style.borderRadius = '12px';
  modal.style.border = '2px solid #4a5568';
  modal.style.width = '960px';
  modal.style.maxWidth = '95vw';
  modal.style.maxHeight = '90vh';
  modal.style.boxSizing = 'border-box';
  modal.style.fontFamily = 'Arial, sans-serif';
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  modal.style.overflowY = 'auto';

  // Header
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.marginBottom = '20px';
  headerRow.style.flexShrink = '0';

  const title = document.createElement('div');
  title.innerText = 'Records';
  title.style.fontSize = '24px';
  title.style.fontWeight = 'bold';
  title.style.color = '#4ade80';
  headerRow.appendChild(title);

  const closeBtn = document.createElement('button');
  closeBtn.innerText = 'X';
  closeBtn.style.background = '#ef4444';
  closeBtn.style.border = 'none';
  closeBtn.style.borderRadius = '50%';
  closeBtn.style.width = '32px';
  closeBtn.style.height = '32px';
  closeBtn.style.color = '#fff';
  closeBtn.style.fontSize = '16px';
  closeBtn.style.fontWeight = 'bold';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.lineHeight = '32px';
  closeBtn.style.textAlign = 'center';
  closeBtn.addEventListener('click', removeRecordsPage);
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#dc2626'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = '#ef4444'; });
  headerRow.appendChild(closeBtn);

  modal.appendChild(headerRow);

  // Total games played
  if (totalGames != null) {
    const totalRow = document.createElement('div');
    totalRow.style.textAlign = 'center';
    totalRow.style.marginBottom = '16px';
    totalRow.style.fontSize = '14px';
    totalRow.style.color = '#9ca3af';

    const countSpan = document.createElement('span');
    countSpan.innerText = totalGames.toLocaleString();
    countSpan.style.color = '#e5e7eb';
    countSpan.style.fontWeight = 'bold';

    totalRow.appendChild(countSpan);
    totalRow.appendChild(document.createTextNode(' games played'));
    modal.appendChild(totalRow);
  }

  // Three boxes row
  const boxesRow = document.createElement('div');
  boxesRow.style.display = 'flex';
  boxesRow.style.gap = '16px';
  boxesRow.style.flexWrap = 'wrap';

  boxesRow.appendChild(createPeriodBox('All Time', records.allTime));
  boxesRow.appendChild(createPeriodBox('This Year', records.thisYear));
  boxesRow.appendChild(createPeriodBox('This Month', records.thisMonth));

  modal.appendChild(boxesRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

/**
 * Remove the records page.
 */
export function removeRecordsPage() {
  const overlay = document.getElementById('recordsPageOverlay');
  if (overlay) overlay.remove();
}
