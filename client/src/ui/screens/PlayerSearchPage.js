/**
 * Player Search Page Screen
 *
 * Modal overlay with search input and results list for finding players.
 */

let debounceTimer = null;
let currentSocket = null;

/**
 * Get the appropriate profile picture source.
 *
 * @param {Object} player - Player data with profilePic/customProfilePic
 * @returns {string} Image source
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
 * Show the player search modal.
 *
 * @param {Object} socket - Socket instance
 */
export function showPlayerSearchPage(socket) {
  removePlayerSearchPage();
  currentSocket = socket;

  const overlay = document.createElement('div');
  overlay.id = 'playerSearchPageOverlay';
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

  const modal = document.createElement('div');
  modal.style.background = 'rgba(26, 26, 46, 0.98)';
  modal.style.color = '#fff';
  modal.style.padding = '30px';
  modal.style.borderRadius = '12px';
  modal.style.border = '2px solid #4a5568';
  modal.style.width = '450px';
  modal.style.maxWidth = '95vw';
  modal.style.maxHeight = '80vh';
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  modal.style.boxSizing = 'border-box';
  modal.style.fontFamily = 'Arial, sans-serif';

  // Header
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  headerRow.style.justifyContent = 'space-between';
  headerRow.style.alignItems = 'center';
  headerRow.style.marginBottom = '20px';

  const title = document.createElement('div');
  title.innerText = 'Search Players';
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
  closeBtn.addEventListener('click', removePlayerSearchPage);
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#dc2626'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = '#ef4444'; });
  headerRow.appendChild(closeBtn);

  modal.appendChild(headerRow);

  // Search row (input + button)
  const searchRow = document.createElement('div');
  searchRow.style.display = 'flex';
  searchRow.style.gap = '10px';
  searchRow.style.marginBottom = '15px';

  const searchInput = document.createElement('input');
  searchInput.id = 'playerSearchInput';
  searchInput.type = 'text';
  searchInput.placeholder = 'Type a username...';
  searchInput.style.flex = '1';
  searchInput.style.padding = '12px';
  searchInput.style.borderRadius = '6px';
  searchInput.style.border = '1px solid #4a5568';
  searchInput.style.background = '#2d3748';
  searchInput.style.color = '#fff';
  searchInput.style.fontSize = '16px';
  searchInput.style.boxSizing = 'border-box';

  function doSearch() {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (!query) {
      updatePlayerSearchResults([]);
      return;
    }
    console.log('Emitting searchPlayers with query:', query);
    socket.emit('searchPlayers', { query });
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (!query) {
      updatePlayerSearchResults([]);
      return;
    }
    debounceTimer = setTimeout(doSearch, 300);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      doSearch();
    }
  });
  searchRow.appendChild(searchInput);

  const searchBtn = document.createElement('button');
  searchBtn.innerText = 'Search';
  searchBtn.style.padding = '12px 20px';
  searchBtn.style.borderRadius = '6px';
  searchBtn.style.border = 'none';
  searchBtn.style.background = '#3b82f6';
  searchBtn.style.color = '#fff';
  searchBtn.style.fontSize = '16px';
  searchBtn.style.fontWeight = 'bold';
  searchBtn.style.cursor = 'pointer';
  searchBtn.addEventListener('click', doSearch);
  searchBtn.addEventListener('mouseenter', () => { searchBtn.style.background = '#2563eb'; });
  searchBtn.addEventListener('mouseleave', () => { searchBtn.style.background = '#3b82f6'; });
  searchRow.appendChild(searchBtn);

  modal.appendChild(searchRow);

  // Results container
  const results = document.createElement('div');
  results.id = 'playerSearchResults';
  results.style.flex = '1';
  results.style.overflowY = 'auto';
  results.style.display = 'flex';
  results.style.flexDirection = 'column';
  results.style.gap = '6px';

  const hint = document.createElement('div');
  hint.style.color = '#9ca3af';
  hint.style.fontStyle = 'italic';
  hint.style.textAlign = 'center';
  hint.style.padding = '20px';
  hint.innerText = 'Search for a player by username';
  results.appendChild(hint);

  modal.appendChild(results);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) removePlayerSearchPage();
  });

  document.body.appendChild(overlay);

  // Auto-focus
  setTimeout(() => searchInput.focus(), 0);
}

/**
 * Update search results list.
 *
 * @param {Array} players - Array of player search results
 */
export function updatePlayerSearchResults(players) {
  const container = document.getElementById('playerSearchResults');
  if (!container) return;

  container.innerHTML = '';

  if (!players || players.length === 0) {
    const input = document.getElementById('playerSearchInput');
    const query = input?.value?.trim();
    const msg = document.createElement('div');
    msg.style.color = '#9ca3af';
    msg.style.fontStyle = 'italic';
    msg.style.textAlign = 'center';
    msg.style.padding = '20px';
    msg.innerText = query ? 'No players found' : 'Search for a player by username';
    container.appendChild(msg);
    return;
  }

  players.forEach((player) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '12px';
    row.style.padding = '10px 12px';
    row.style.background = 'rgba(0, 0, 0, 0.3)';
    row.style.borderRadius = '6px';
    row.style.cursor = 'pointer';
    row.style.transition = 'background 0.15s';
    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(59, 130, 246, 0.2)'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'rgba(0, 0, 0, 0.3)'; });
    row.addEventListener('click', () => {
      if (currentSocket) {
        currentSocket.emit('getPlayerProfile', { username: player.username });
      }
      removePlayerSearchPage();
    });

    // Avatar
    const avatar = document.createElement('img');
    avatar.src = getProfilePicSrc(player);
    avatar.style.width = '40px';
    avatar.style.height = '40px';
    avatar.style.borderRadius = '50%';
    avatar.style.objectFit = 'cover';
    avatar.style.border = '2px solid #4a5568';
    avatar.style.flexShrink = '0';
    row.appendChild(avatar);

    // Info
    const info = document.createElement('div');
    info.style.flex = '1';
    info.style.minWidth = '0';

    const name = document.createElement('div');
    name.innerText = player.username;
    name.style.fontWeight = 'bold';
    name.style.color = '#fff';
    name.style.fontSize = '15px';
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';
    name.style.whiteSpace = 'nowrap';
    info.appendChild(name);

    const statsLine = document.createElement('div');
    statsLine.style.fontSize = '12px';
    statsLine.style.color = '#9ca3af';
    const gp = player.gamesPlayed || 0;
    const winRate = gp > 0 ? ((player.wins / gp) * 100).toFixed(0) : '0';
    statsLine.innerText = `${gp} games | ${winRate}% win rate`;
    info.appendChild(statsLine);

    row.appendChild(info);
    container.appendChild(row);
  });
}

/**
 * Remove the player search modal.
 */
export function removePlayerSearchPage() {
  clearTimeout(debounceTimer);
  const overlay = document.getElementById('playerSearchPageOverlay');
  if (overlay) overlay.remove();
  currentSocket = null;
}
