/**
 * Player Search Page Screen
 *
 * A kit Modal with a search input (search as you type) and a results list
 * for finding players; a result is a button that opens that player's
 * profile. With the box empty it lists who is online (the main room's list,
 * owner 2026-11-27, as the iOS Players sheet), each a button that opens the
 * profile too; your own name is just your name. Classes from
 * styles/screens.css (item 18b); usernames as text.
 */

import { profileAvatarSrc, applyAvatarImg } from '../../utils/avatar.js';
import { el, createButton, openModal } from '../kit/index.js';
import { scopePayload } from '../../state/statsScope.js';

let debounceTimer = null;
let currentSocket = null;
let searchModal = null;
/**
 * The query of the latest searchPlayers sent (null: none, or the input was
 * cleared since). Replies can finish out of order (each is a DB query), so
 * one whose echoed query is not this one is stale and dropped.
 */
let latestQuery = null;
/** Who is online (the main room's list, read when drawn) and who I am. */
let onlineSource = { getOnlineUsers: () => [], me: null };

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
 * A profile request for `username`, closing the page first (as a result row).
 */
function openProfile(username) {
  const socket = currentSocket;
  removePlayerSearchPage();
  if (socket) {
    socket.emit('getPlayerProfile', scopePayload({ username }));
  }
}

/**
 * The empty box: "Online now · N" and a row per online player (names only:
 * the online list carries no pictures), or the hint when nobody is listed.
 */
function onlineChildren() {
  const seen = new Set();
  const users = (onlineSource.getOnlineUsers() || []).filter((u) => typeof u === 'string' && u && !seen.has(u) && seen.add(u));
  if (users.length === 0) return [hint('Search for a player by username')];
  const heading = el('div', {
    className: 'room-list__heading search-results__heading',
    attrs: { id: 'playerSearchOnlineHeading', role: 'heading', 'aria-level': '3' },
    text: `Online now \u00B7 ${users.length}`,
  });
  const rows = users.map((username) => {
    const name = el('div', { className: 'search-result__name', text: username });
    if (username === onlineSource.me) {
      // my own profile is the Profile page: my name is just my name
      return el('div', {
        className: 'search-result search-result--me',
        dataset: { username },
        children: [el('div', { className: 'search-result__info', children: [name, el('div', { className: 'search-result__stats', text: 'You' })] })],
      });
    }
    const row = el('button', {
      className: 'search-result',
      attrs: { type: 'button', 'aria-label': `${username}, online` },
      dataset: { username },
      children: [el('div', { className: 'search-result__info', children: [name] })],
    });
    row.addEventListener('click', () => openProfile(username));
    return row;
  });
  return [heading, ...rows];
}

/**
 * Show the player search modal.
 *
 * @param {Object} socket - Socket instance
 * @param {Object} [options]
 * @param {Function} [options.getOnlineUsers] - the main room's online usernames
 * @param {string} [options.me] - the signed-in player
 */
export function showPlayerSearchPage(socket, { getOnlineUsers = () => [], me = null } = {}) {
  removePlayerSearchPage();
  currentSocket = socket;
  onlineSource = { getOnlineUsers, me };

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
      latestQuery = null;
      renderResults([]);
      return;
    }
    latestQuery = query;
    socket.emit('searchPlayers', { query });
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (!query) {
      latestQuery = null;
      renderResults([]);
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
    children: onlineChildren(),
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
      latestQuery = null;
      onlineSource = { getOnlineUsers: () => [], me: null };
    },
  });
}

/**
 * A searchPlayersResponse: show its players unless it answers an older
 * query than the latest one sent (the server echoes `query`, 2026-11-15; a
 * reply without one, from an older server, is shown as before).
 *
 * @param {Array} players - Array of player search results
 * @param {string} [query] - the reply's echoed query
 * @returns {boolean} whether it was shown
 */
export function updatePlayerSearchResults(players, query) {
  if (typeof query === 'string' && query !== latestQuery) return false;
  renderResults(players);
  return true;
}

function renderResults(players) {
  const container = document.getElementById('playerSearchResults');
  if (!container) return;

  container.replaceChildren();

  if (!players || players.length === 0) {
    const input = document.getElementById('playerSearchInput');
    const query = input?.value?.trim();
    if (query) container.appendChild(hint('No players found'));
    else container.replaceChildren(...onlineChildren());
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
    row.addEventListener('click', () => openProfile(player.username));
    container.appendChild(row);
  });
}

/**
 * The main room's online list changed: redraw it if the page shows it (an
 * empty box), keeping focus on the row it was on when that player is still
 * listed.
 */
export function refreshPlayerSearchOnline() {
  const container = document.getElementById('playerSearchResults');
  const input = document.getElementById('playerSearchInput');
  if (!container || !input || input.value.trim()) return;
  const focused = container.contains(document.activeElement) ? document.activeElement?.dataset?.username : null;
  container.replaceChildren(...onlineChildren());
  if (focused) {
    const again = [...container.querySelectorAll('button.search-result')].find((b) => b.dataset.username === focused);
    if (again) again.focus();
    else input.focus();
  }
}

/**
 * Remove the player search modal.
 */
export function removePlayerSearchPage() {
  clearTimeout(debounceTimer);
  latestQuery = null;
  searchModal?.close('api');
  searchModal = null;
  document.getElementById('playerSearchPageOverlay')?.remove();
  currentSocket = null;
}
