/**
 * Player Search Page Screen
 *
 * A kit Modal with a search input (search as you type) and a results list
 * for finding players; a result is a button that opens that player's
 * profile. Classes from styles/screens.css (item 18b); usernames as text.
 */

import { profileAvatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { el, createButton, openModal } from '../kit/index.js';

let debounceTimer = null;
let currentSocket = null;
let searchModal = null;

/**
 * Get the appropriate profile picture source.
 *
 * @param {Object} player - Player data with profilePic/customProfilePic
 * @returns {string} Image source
 */
function getProfilePicSrc(player) {
  return profileAvatarSrc(player, 'assets/profile1.png');
}

function hint(text) {
  return el('div', { className: 'muted-note', text });
}

/**
 * Show the player search modal.
 *
 * @param {Object} socket - Socket instance
 */
export function showPlayerSearchPage(socket) {
  removePlayerSearchPage();
  currentSocket = socket;

  // Search row (input + button)
  const searchInput = el('input', {
    className: 'kit-input',
    attrs: {
      id: 'playerSearchInput', type: 'search', placeholder: 'Type a username...', 'aria-label': 'Search players by username',
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-controls': 'playerSearchResults',
    },
  });

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

  const searchRow = el('div', {
    className: 'search-row',
    attrs: { role: 'search' },
    children: [searchInput, createButton({ label: 'Search', variant: 'primary', onClick: doSearch })],
  });

  // Results container
  const results = el('div', {
    className: 'search-results',
    attrs: { id: 'playerSearchResults', 'aria-live': 'polite' },
    children: [hint('Search for a player by username')],
  });

  searchModal = openModal({
    title: 'Search Players',
    closable: true,
    closeLabel: 'Close player search',
    id: 'playerSearchPageOverlay',
    dialogId: 'playerSearchPageModal',
    className: 'page-modal',
    body: [searchRow, results],
    initialFocus: searchInput,
    onClose: () => {
      clearTimeout(debounceTimer);
      searchModal = null;
      currentSocket = null;
    },
  });
}

/**
 * Update search results list.
 *
 * @param {Array} players - Array of player search results
 */
export function updatePlayerSearchResults(players) {
  const container = document.getElementById('playerSearchResults');
  if (!container) return;

  container.replaceChildren();

  if (!players || players.length === 0) {
    const input = document.getElementById('playerSearchInput');
    const query = input?.value?.trim();
    container.appendChild(hint(query ? 'No players found' : 'Search for a player by username'));
    return;
  }

  players.forEach((player) => {
    const gp = player.gamesPlayed || 0;
    const winRate = gp > 0 ? ((player.wins / gp) * 100).toFixed(0) : '0';

    const avatar = el('img', { attrs: { alt: '' } });
    applyAvatarImg(avatar, getProfilePicSrc(player), { lazy: true });

    const row = el('button', {
      className: 'search-result',
      attrs: { type: 'button' },
      dataset: { username: player.username },
      children: [
        avatar,
        el('div', {
          className: 'search-result__info',
          children: [
            el('div', { className: 'search-result__name', text: player.username }),
            el('div', { className: 'search-result__stats', text: `${gp} games | ${winRate}% win rate` }),
          ],
        }),
      ],
    });
    row.addEventListener('click', () => {
      const socket = currentSocket;
      removePlayerSearchPage();
      if (socket) {
        socket.emit('getPlayerProfile', { username: player.username });
      }
    });
    container.appendChild(row);
  });
}

/**
 * Remove the player search modal.
 */
export function removePlayerSearchPage() {
  clearTimeout(debounceTimer);
  searchModal?.close('api');
  searchModal = null;
  document.getElementById('playerSearchPageOverlay')?.remove();
  currentSocket = null;
}
