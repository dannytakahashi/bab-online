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
 *
 * A failed /avatar URL (429, 503, a 404 after a mid-game picture change)
 * never shows another player's stock animal: the inline copy a room
 * broadcast carried for the same URL (remembered by the fold), else one
 * retry after 3 s, else the neutral assets/default_avatar.png.
 */

export const STOCK_MIN = 1;
export const STOCK_MAX = 82;
const STOCK_WEBP = /avatars\/v1\/profile(\d+)\.webp$/;
/** What a custom picture that cannot load shows (a neutral silhouette, nobody's face). */
export const CUSTOM_FALLBACK = 'assets/default_avatar.png';
export const AVATAR_RETRY_MS = 3000;
const INLINE_MAX = 64;
/** /avatar URL -> the inline data URL a room broadcast carried for it (newest last). */
const inlineByUrl = new Map();

const isStock = (pic) => Number.isInteger(pic) && pic >= STOCK_MIN && pic <= STOCK_MAX;
const isAvatarUrl = (v) => typeof v === 'string' && v.startsWith('/avatar/');
const isDataUrl = (v) => typeof v === 'string' && v.startsWith('data:image');

/** Remember the inline copy of `url` (same version: the URL is content-addressed). */
function rememberInline(url, inline) {
  if (!isAvatarUrl(url) || !isDataUrl(inline)) return;
  inlineByUrl.delete(url);
  inlineByUrl.set(url, inline);
  while (inlineByUrl.size > INLINE_MAX) inlineByUrl.delete(inlineByUrl.keys().next().value);
}

/** The inline copy remembered for an /avatar URL, if any. */
export function inlineFor(url) {
  return inlineByUrl.get(url);
}

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
 * lists), with an error chain: stock WebP -> legacy PNG -> `fallback`;
 * /avatar URL -> its remembered inline copy -> the URL again after 3 s ->
 * CUSTOM_FALLBACK; inline data URL -> CUSTOM_FALLBACK. Setting the same src
 * again is a no-op (no refetch, no flicker).
 */
export function applyAvatarImg(img, src, { lazy = false, fallback = 'assets/profile1.png' } = {}) {
  img.setAttribute('decoding', 'async');
  if (lazy) img.setAttribute('loading', 'lazy');
  // the same src again: keep the image, its error chain and any pending retry
  if (img.__avatarState && img.getAttribute('src') === src) return img;
  // per-request state; a later applyAvatarImg with another src replaces it
  const state = { url: isAvatarUrl(src) ? src : null, inlineTried: false, retried: false };
  img.onerror = () => {
    const cur = img.getAttribute('src') || '';
    const m = STOCK_WEBP.exec(cur);
    if (m) {
      img.setAttribute('src', `assets/profile${m[1]}.png`);
      return;
    }
    if (state.url) {
      if (cur === CUSTOM_FALLBACK) return; // the neutral image itself failed: nothing better to show
      const inline = inlineByUrl.get(state.url);
      if (!state.inlineTried && inline) {
        state.inlineTried = true;
        img.setAttribute('src', inline);
        return;
      }
      img.setAttribute('src', CUSTOM_FALLBACK);
      if (!state.retried) {
        state.retried = true;
        setTimeout(() => {
          if (img.__avatarState === state) img.setAttribute('src', state.url);
        }, AVATAR_RETRY_MS);
      }
      return;
    }
    img.onerror = null;
    const last = isDataUrl(cur) ? CUSTOM_FALLBACK : fallback;
    if (cur !== last) img.setAttribute('src', last);
  };
  img.__avatarState = state;
  img.setAttribute('src', src);
  return img;
}

/**
 * The URL wins over the inline/legacy value (ingress only); an inline value
 * next to it is remembered as the URL's fallback.
 */
export const foldUrls = (pic, url) => {
  if (!isAvatarUrl(url)) return pic;
  rememberInline(url, pic);
  return url;
};

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

/**
 * The clientHello this bundle sends on every connect. `capable` false (no
 * ingress fold possible): caps [] so the server keeps the legacy shape.
 */
export function clientHello(version, build, capable = true) {
  return { client: 'web', version: String(version || '0.0.0').slice(0, 32), build: String(build || '').slice(0, 64), caps: capable ? ['avatarUrl'] : [] };
}

/**
 * Wire the avatar capability onto a socket.io-client socket: the ingress
 * fold (onAny listeners run before every regular listener) and the hello
 * on every connect. Installed while disconnected, the first hello is
 * emitted at once (socket.io buffers it ahead of anything emitted later,
 * e.g. restoreSession) and that first 'connect' sends no second copy.
 */
export function installAvatarSupport(socket, { version, build } = {}) {
  const capable = typeof socket.onAny === 'function';
  if (capable) socket.onAny((event, data) => { foldAvatarPayload(event, data); });
  const sendHello = () => socket.emit('clientHello', clientHello(version, build, capable));
  let buffered = !socket.connected;
  socket.on('connect', () => {
    if (buffered) {
      buffered = false; // the buffered hello is flushed by this connect
      return;
    }
    sendHello();
  });
  sendHello();
  return sendHello;
}
