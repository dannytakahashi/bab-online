/**
 * Avatar pictures (roadmap item 10; docs/avatars.md). The ONLY place that
 * knows how a pic value becomes an <img> src.
 *
 * A pic is one of:
 *   - a stock number 1-82  -> assets/avatars/v1/profile<N>.webp (256 px,
 *     immutable), falling back to assets/profile<N>.png if WebP fails
 *   - a data:image URL      -> as is (legacy inline pictures; the server
 *     still sends them to sockets that did not say clientHello)
 *   - an /avatar/... URL    -> as is (same origin, cached by the browser)
 *   - anything else         -> the caller's fallback
 *
 * This bundle says clientHello caps ['avatarUrl'] (main.js), so the server
 * may send null custom-picture slots plus avatarUrls / avatarUrl.
 * foldAvatarPayload() folds those URLs back into the existing pic fields
 * as each message ARRIVES (socket.onAny runs before every listener), so
 * every existing reader keeps reading one pic field. Capable or not, every
 * shape above renders (invariant I6): a payload the server built before
 * our hello was handled is just bigger, never broken.
 */

export const STOCK_MIN = 1;
export const STOCK_MAX = 82;
const STOCK_WEBP = /avatars\/v1\/profile(\d+)\.webp$/;

const isStock = (pic) => Number.isInteger(pic) && pic >= STOCK_MIN && pic <= STOCK_MAX;
const isAvatarUrl = (v) => typeof v === 'string' && v.startsWith('/avatar/');

/** A custom picture value (inline data URL or avatar URL). */
export function isCustomPic(pic) {
  return typeof pic === 'string' && (pic.startsWith('data:image') || isAvatarUrl(pic));
}

/** Can avatarSrc render this pic without falling back? */
export function isAvatarPic(pic) {
  return isStock(pic) || isCustomPic(pic);
}

/** The <img> src for a pic value. Numeric strings are never coerced. */
export function avatarSrc(pic, fallback = 'assets/profile1.png') {
  if (isStock(pic)) return `assets/avatars/v1/profile${pic}.webp`;
  if (isCustomPic(pic)) return pic;
  return fallback;
}

/** src for a profile-like row {customProfilePic, profilePic}. */
export function profileAvatarSrc({ customProfilePic, profilePic } = {}, fallback = 'assets/profile1.png') {
  return customProfilePic ? avatarSrc(customProfilePic, fallback) : avatarSrc(profilePic, fallback);
}

/**
 * Point `img` at `src`: decoded off the main thread, optionally lazy (long
 * lists), with the WebP -> legacy PNG -> fallback chain on error. Setting
 * the same src again is a no-op (no refetch, no flicker).
 */
export function applyAvatarImg(img, src, { lazy = false, fallback = 'assets/profile1.png' } = {}) {
  img.setAttribute('decoding', 'async');
  if (lazy) img.setAttribute('loading', 'lazy');
  img.onerror = () => {
    const m = STOCK_WEBP.exec(img.getAttribute('src') || '');
    if (m) {
      img.setAttribute('src', `assets/profile${m[1]}.png`);
      return;
    }
    img.onerror = null;
    if (img.getAttribute('src') !== fallback) img.setAttribute('src', fallback);
  };
  if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  return img;
}

/** The URL wins over the inline/legacy value (ingress only). */
export const foldUrls = (pic, url) => (isAvatarUrl(url) ? url : pic);

const foldPlayers = (players, urls) => {
  if (!Array.isArray(players) || !urls) return;
  for (const p of players) if (p && typeof p === 'object') p.pic = foldUrls(p.pic, urls[p.position]);
};
const foldRows = (rows, urls) => {
  if (!Array.isArray(rows) || !urls) return;
  for (const r of rows) if (r && typeof r === 'object') r.customProfilePic = foldUrls(r.customProfilePic, urls[r.username]);
};

/**
 * Fold avatarUrls / avatarUrl of an incoming payload into its existing pic
 * fields, in place (socket.onAny in main.js). Unknown events and payloads
 * without avatar keys are untouched.
 */
export function foldAvatarPayload(event, data) {
  if (!data || typeof data !== 'object') return data;
  const urls = data.avatarUrls && typeof data.avatarUrls === 'object' ? data.avatarUrls : null;
  switch (event) {
    case 'positionUpdate':
      if (urls && Array.isArray(data.pics) && Array.isArray(data.positions)) {
        data.pics = data.pics.map((p, i) => foldUrls(p, urls[data.positions[i]]));
      }
      break;
    case 'gameStart':
      foldPlayers(data.playerInfo, urls);
      break;
    case 'rejoinSuccess':
    case 'restorePlayerState':
    case 'spectatorJoined':
      foldPlayers(data.players, urls);
      break;
    case 'playerActiveMode':
      data.pic = foldUrls(data.pic, data.avatarUrl);
      break;
    case 'leaderboardResponse':
      foldRows(data.leaderboard, urls);
      break;
    case 'searchPlayersResponse':
      foldRows(data.players, urls);
      break;
    case 'profileResponse':
    case 'playerProfileResponse':
      if (data.profile && typeof data.profile === 'object') {
        data.profile.customProfilePic = foldUrls(data.profile.customProfilePic, data.avatarUrl);
      }
      break;
    case 'profilePicUploadResponse':
      data.customProfilePic = foldUrls(data.customProfilePic, data.avatarUrl);
      break;
    default:
      break;
  }
  return data;
}

/** The clientHello this bundle sends on every connect. */
export function clientHello(version, build) {
  return { client: 'web', version: String(version || '0.0.0').slice(0, 32), build: String(build || '').slice(0, 64), caps: ['avatarUrl'] };
}

/**
 * Wire the avatar capability onto a socket.io-client socket: the ingress
 * fold (onAny listeners run before every regular listener) and the hello,
 * sent now (buffered ahead of anything emitted later while disconnected)
 * and on every (re)connect.
 */
export function installAvatarSupport(socket, { version, build } = {}) {
  if (typeof socket.onAny === 'function') socket.onAny((event, data) => { foldAvatarPayload(event, data); });
  const sendHello = () => socket.emit('clientHello', clientHello(version, build));
  socket.on('connect', sendHello);
  sendHello();
  return sendHello;
}
