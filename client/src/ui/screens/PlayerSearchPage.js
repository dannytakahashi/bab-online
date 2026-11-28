/**
 * Player Search Page Screen
 *
 * A kit Modal with a search input (search as you type) and a results list
 * for finding players; a result is a button that opens that player's
 * profile. With the box empty it lists who is online (the main room's list,
 * owner 2026-11-27, as the iOS Players sheet), each a button that opens the
 * profile too; your own name is just your name. The online rows show each
 * player's picture as a result row does: the online list is names only, so
 * the page asks for the shown names' cards (c2s playerCards ->
 * playerCardsResponse, the search rows of those players) and draws the
 * initial until a card is known. Classes from styles/screens.css (item 18b);
 * usernames as text.
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
 * Player cards for the online list's pictures (2026-11-27): username ->
 * {profilePic, customProfilePic} (a playerCardsResponse or search row, its
 * avatarUrls already folded in), kept for the page's session so a reopened
 * page draws the known pictures at once while it asks again.
 */
const cards = new Map();
/**
 * The names asked for since the page opened: each at most once per opening,
 * so a server that never answers (one from before playerCards) costs one
 * request per change of the list, never a retry loop. Cleared on open, which
 * refreshes every listed card.
 */
const cardsAsked = new Set();
/**
 * The names a reply has brought back since the page opened (a name with no
 * account never comes back: it counts as unanswered). Two cases ask a name
 * again within an opening (review of PR 454): a refused request (the rate
 * limit, during a burst of joins), once per name after the server's window
 * (cardsRetried), and a new session (a reconnect's mainRoomJoined).
 */
const cardsAnswered = new Set();
const cardsRetried = new Set();
let cardsTimer = null;
/** After a refusal nothing is asked until this timer runs (the server's window). */
let cardsRetryTimer = null;
/** The server's limit per playerCards request (profileHandlers PLAYER_CARDS_MAX). */
export const PLAYER_CARDS_MAX = 100;
/** The pause after a change of the online list before asking (the search's 300 ms). */
export const PLAYER_CARDS_DEBOUNCE_MS = 300;
/** The pause after a refused playerCards (the server's window: 20 per 10 s). */
export const PLAYER_CARDS_RETRY_MS = 10000;

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

/** The online list's names: strings, each once, in the server's order. */
function onlineUsernames() {
  const seen = new Set();
  return (onlineSource.getOnlineUsers() || []).filter((u) => typeof u === 'string' && u && !seen.has(u) && seen.add(u));
}

/**
 * An online row's picture: the search results' <img> once the player's card
 * is known, else their initial in a circle of the same size (no layout jump
 * when the picture arrives). Decorative: the row's label names the player.
 */
function onlineAvatar(username) {
  const card = cards.get(username);
  if (card) {
    const img = el('img', { attrs: { alt: '' } });
    applyAvatarImg(img, getProfilePicSrc(card), { lazy: true });
    return img;
  }
  return el('span', { className: 'search-result__initial', attrs: { 'aria-hidden': 'true' }, text: [...username][0]?.toUpperCase() || '' });
}

/** Point an existing online row's picture at its card (a no-op when it already shows it). */
function syncOnlineAvatar(row) {
  const username = row.dataset.username;
  const current = row.firstElementChild;
  const card = cards.get(username);
  if (card && current?.tagName === 'IMG') {
    applyAvatarImg(current, getProfilePicSrc(card), { lazy: true });
  } else if (card || current?.tagName !== 'SPAN') {
    const next = onlineAvatar(username);
    if (current && (current.tagName === 'IMG' || current.tagName === 'SPAN')) current.replaceWith(next);
    else row.prepend(next);
  }
}

/** A new online row: avatar, name ("You" under mine, which is not a button). */
function onlineRow(username) {
  const name = el('div', { className: 'search-result__name', text: username });
  if (username === onlineSource.me) {
    // my own profile is the Profile page: my name is just my name
    return el('div', {
      className: 'search-result search-result--me',
      dataset: { username },
      children: [onlineAvatar(username), el('div', { className: 'search-result__info', children: [name, el('div', { className: 'search-result__stats', text: 'You' })] })],
    });
  }
  const row = el('button', {
    className: 'search-result',
    attrs: { type: 'button', 'aria-label': `${username}, online` },
    dataset: { username },
    children: [onlineAvatar(username), el('div', { className: 'search-result__info', children: [name] })],
  });
  row.addEventListener('click', () => openProfile(username));
  return row;
}

/**
 * The empty box: "Online now · N" and a row per online player (its picture
 * from its card, else its initial), or the hint when nobody is listed. Rows
 * in `reuse` (username -> row) are kept as they are, so a redraw on a join
 * or a leave never reloads a picture.
 */
function onlineChildren(reuse = new Map()) {
  const users = onlineUsernames();
  if (users.length === 0) return [hint('Search for a player by username')];
  const heading = el('div', {
    className: 'room-list__heading search-results__heading',
    attrs: { id: 'playerSearchOnlineHeading', role: 'heading', 'aria-level': '3' },
    text: `Online now \u00B7 ${users.length}`,
  });
  const rows = users.map((username) => {
    const kept = reuse.get(username);
    if (!kept) return onlineRow(username);
    syncOnlineAvatar(kept);
    return kept;
  });
  return [heading, ...rows];
}

/** Ask for the cards of the listed names not asked for since the page opened, 100 a request. */
function askForCards() {
  clearTimeout(cardsTimer);
  cardsTimer = null;
  const socket = currentSocket;
  if (!socket || cardsRetryTimer || !onlineListShown()) return;
  const names = onlineUsernames().filter((u) => !cardsAsked.has(u) && !cardsAnswered.has(u));
  for (let i = 0; i < names.length; i += PLAYER_CARDS_MAX) {
    const usernames = names.slice(i, i + PLAYER_CARDS_MAX);
    usernames.forEach((u) => cardsAsked.add(u));
    socket.emit('playerCards', { usernames });
  }
}

/** The online list is on screen (the page is open and its box empty). */
function onlineListShown() {
  const input = document.getElementById('playerSearchInput');
  return !!(currentSocket && input && !input.value.trim());
}

/** The online list changed or came back: ask for the new names' cards after the pause. */
function scheduleCards() {
  if (cardsRetryTimer) return; // the refusal's timer asks
  clearTimeout(cardsTimer);
  cardsTimer = setTimeout(askForCards, PLAYER_CARDS_DEBOUNCE_MS);
}

/** End a refusal's hold (a new opening, a new session, the page closed). */
function endCardsHold() {
  clearTimeout(cardsRetryTimer);
  cardsRetryTimer = null;
}

/**
 * A playerCards refused (serverError with handler playerCards: the rate
 * limit, a refused payload; main.js shows no toast for it). The names asked
 * and not answered (the refused request's among them: the server does not
 * say which it was) are asked once more after PLAYER_CARDS_RETRY_MS, with
 * whatever joined meanwhile, in one request; a name already asked again
 * after a refusal is not, so it is one retry, never a loop.
 */
export function playerCardsRefused() {
  if (!currentSocket) return;
  for (const u of cardsAsked) {
    if (!cardsAnswered.has(u) && !cardsRetried.has(u)) {
      cardsAsked.delete(u);
      cardsRetried.add(u);
    }
  }
  if (cardsRetryTimer) return;
  clearTimeout(cardsTimer);
  cardsTimer = null;
  cardsRetryTimer = setTimeout(() => {
    cardsRetryTimer = null;
    askForCards();
  }, PLAYER_CARDS_RETRY_MS);
}

/** Remember a row's picture fields (a card or a search result). */
function rememberCard(player) {
  if (!player || typeof player.username !== 'string' || !player.username) return;
  cards.set(player.username, { profilePic: player.profilePic, customProfilePic: player.customProfilePic ?? null });
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
  // a new opening asks again for every listed card (the known pictures show meanwhile)
  cardsAsked.clear();
  cardsAnswered.clear();
  cardsRetried.clear();
  endCardsHold();

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
      scheduleCards();
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
      scheduleCards();
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

  // Results container. Not a live region: the online list redraws on every
  // join and leave, and a screen reader would read it all out each time. A
  // search's answer is announced by the status line alone ("3 players found").
  const results = el('div', {
    className: 'search-results',
    attrs: { id: 'playerSearchResults' },
    children: onlineChildren(),
  });
  const status = el('div', {
    className: 'visually-hidden',
    attrs: { id: 'playerSearchStatus', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
  });

  searchModal = openModal({
    title: 'Search Players',
    closable: true,
    closeLabel: 'Close player search',
    id: 'playerSearchPageOverlay',
    dialogId: 'playerSearchPageModal',
    className: 'page-modal',
    body: [searchRow, status, results],
    initialFocus: searchInput,
    onClose: () => {
      clearTimeout(debounceTimer);
      clearTimeout(cardsTimer);
      cardsTimer = null;
      endCardsHold();
      searchModal = null;
      currentSocket = null;
      latestQuery = null;
      onlineSource = { getOnlineUsers: () => [], me: null };
    },
  });
  // the list's pictures: at once for what the page opened on
  askForCards();
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
  // a result row is a card too (the same row shape): the online list can use it
  if (Array.isArray(players)) players.forEach(rememberCard);
  if (typeof query === 'string' && query !== latestQuery) return false;
  renderResults(players);
  return true;
}

/** The visually hidden status line: what a search found, or nothing. */
function announce(text) {
  const status = document.getElementById('playerSearchStatus');
  if (status && status.textContent !== text) status.textContent = text;
}

function renderResults(players) {
  const container = document.getElementById('playerSearchResults');
  if (!container) return;

  container.replaceChildren();

  if (!players || players.length === 0) {
    const input = document.getElementById('playerSearchInput');
    const query = input?.value?.trim();
    if (query) {
      container.appendChild(hint('No players found'));
      announce('No players found');
    } else {
      container.replaceChildren(...onlineChildren());
      announce('');
    }
    return;
  }
  announce(players.length === 1 ? '1 player found' : `${players.length} players found`);

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
 * A playerCardsResponse (the search rows of the online names asked for,
 * avatarUrls folded in by utils/avatar.js): remembered, and the rows on
 * screen get their pictures in place. A failure reply changes nothing (the
 * initials stay); nothing is asked again until the list changes, a new
 * session or the page reopens.
 *
 * @param {Array} players - the reply's rows
 */
export function updatePlayerCards(players) {
  if (!Array.isArray(players) || players.length === 0) return;
  players.forEach(rememberCard);
  if (currentSocket) {
    players.forEach((p) => { if (typeof p?.username === 'string') cardsAnswered.add(p.username); });
  }
  const container = document.getElementById('playerSearchResults');
  if (!container || !onlineListShown()) return;
  for (const row of container.querySelectorAll('.search-result[data-username]')) {
    if (players.some((p) => p?.username === row.dataset.username)) syncOnlineAvatar(row);
  }
}

/**
 * The main room's online list changed: redraw it if the page shows it (an
 * empty box), keeping focus on the row it was on when that player is still
 * listed, and the rows of the players still listed as they are; the new
 * names' cards are asked for after the pause. With `rejoined` (the main
 * room's mainRoomJoined: a reconnect's restore) the names sent and never
 * answered are asked again too, since their reply was lost with the old
 * connection, and a refusal's hold ends (the server's limit is per socket).
 *
 * @param {Object} [options]
 * @param {boolean} [options.rejoined]
 */
export function refreshPlayerSearchOnline({ rejoined = false } = {}) {
  if (rejoined && currentSocket) {
    for (const u of cardsAsked) if (!cardsAnswered.has(u)) cardsAsked.delete(u);
    endCardsHold();
  }
  const container = document.getElementById('playerSearchResults');
  const input = document.getElementById('playerSearchInput');
  if (!container || !input || input.value.trim()) return;
  const focused = container.contains(document.activeElement) ? document.activeElement?.dataset?.username : null;
  const reuse = new Map([...container.querySelectorAll('.search-result[data-username]')].map((r) => [r.dataset.username, r]));
  container.replaceChildren(...onlineChildren(reuse));
  scheduleCards();
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
  clearTimeout(cardsTimer);
  cardsTimer = null;
  endCardsHold();
  latestQuery = null;
  searchModal?.close('api');
  searchModal = null;
  document.getElementById('playerSearchPageOverlay')?.remove();
  currentSocket = null;
}

/** Tests: forget every card and request (the cache lives for the page's session). */
export function _resetPlayerCardsForTests() {
  cards.clear();
  cardsAsked.clear();
  cardsAnswered.clear();
  cardsRetried.clear();
  clearTimeout(cardsTimer);
  cardsTimer = null;
  endCardsHold();
}
