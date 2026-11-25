/**
 * Which opponent avatar glows when a voice peer speaks.
 *
 * Keyed by the peer's username (VoiceChatManager keeps it per peer, from
 * voicePeerList / voiceOffer, both named by the server): socket ids change
 * on every reconnect, while playerData.socket is only refreshed by
 * positionUpdate, so a socket-id lookup lit the wrong seat or none after
 * anyone reconnected. The seat's OWNER is matched first (GameState
 * seatOwners: a lazy or resigned owner still talking lights the seat their
 * bot plays, as iOS 1.2's TableRenderModel.seat(forVoicePeer:username:)
 * matches ownerUsername), then the name the seat shows, and the socket id
 * only as the fallback for a peer whose username is unknown, so the glow
 * needs no socket id on the wire (V1_REMOVALS #6 / #14).
 */

import { slotOf } from '../utils/positions.js';

/**
 * @param {Object} args
 * @param {string|null} args.username - the speaking peer's username
 * @param {string} args.socketId - the speaking peer's socket id
 * @param {Object|null} args.playerData - GameState.playerData ({position[], socket[], username[]})
 * @param {number|null} args.myPosition
 * @param {Object} [args.owners] - GameState.seatOwners ({position: username})
 * @param {boolean} [args.spectator] - I watch (the view from seat 1, whose
 *   player sits in the 'bottom' slot, OpponentManager's spectator seat): a
 *   peer at myPosition is that player, never me
 * @param {number} [args.seats=4] - seats at the table (3: Get Your Bid)
 * @returns {'partner'|'opp1'|'opp2'|'bottom'|null}
 */
export function speakingSlotFor({ username, socketId, playerData, myPosition, owners = null, spectator = false, seats = 4 }) {
  if (!myPosition) return null;

  let pos = null;
  if (username && owners) {
    const hit = Object.entries(owners).find(([, name]) => name === username);
    if (hit) pos = Number(hit[0]);
  }
  if (pos === null && playerData && Array.isArray(playerData.position)) {
    let idx = -1;
    if (username && Array.isArray(playerData.username)) {
      idx = playerData.username.findIndex((u) => (u?.username ?? u) === username);
    }
    if (idx === -1 && socketId && Array.isArray(playerData.socket)) {
      idx = playerData.socket.indexOf(socketId);
    }
    if (idx !== -1) pos = playerData.position[idx];
  }
  if (!pos) return null;

  if (pos === myPosition) return spectator ? 'bottom' : null;
  return slotOf(pos, myPosition, seats);
}

/**
 * Is this talking voice peer a spectator, whose ring is the spectator
 * badge's (the eye; owner 2026-11-22: "the eye glows green while any
 * spectator other than me talks")? Seated players never light it (their
 * seat glows), and my own voice never does (my mic shows it): `id 'self'`
 * never comes here.
 *
 * - A named peer counts when it is a listed spectator (watching.spectators)
 *   that owns no seat (GameState.seatOwners: a lazy or /leave'd owner
 *   watching keeps its seat's ring) or shows at one (playerData.username)
 *   and is not me (a second tab of mine).
 *   A named peer not on the list is not placed (an entrant before the
 *   seating, the list's 250 ms coalescing window): nothing lights.
 * - A nameless peer (no username from voicePeerList / voiceOffer) counts
 *   when the table is seated and its socket id is no seat's
 *   (playerData.socket): a voice member that is not at a seat is a voice
 *   spectator. Before the seating it may be an entrant: nothing lights.
 *
 * @param {Object} args
 * @param {string|null} args.username - the peer's username (VoiceChatManager peers)
 * @param {string} args.socketId - the peer's socket id
 * @param {string|null} [args.me] - my username
 * @param {Object|null} [args.owners] - GameState.seatOwners ({position: username})
 * @param {Object|null} [args.playerData] - GameState.playerData ({position[], socket[], username[]})
 * @param {{spectators?: Array<{username: string}>}|null} [args.watching] - GameState.watching
 * @returns {{username: string}|{peerId: string}|null} the badge's key, or null when not a spectator
 */
export function spectatorSpeakerFor({ username, socketId, me = null, owners = null, playerData = null, watching = null }) {
  const ownerNames = Object.values(owners || {});
  if (username) {
    if (username === me || ownerNames.includes(username)) return null;
    const seatNames = Array.isArray(playerData?.username) ? playerData.username.map((u) => u?.username ?? u) : [];
    if (seatNames.includes(username)) return null;
    const listed = (watching?.spectators || []).some((s) => s?.username === username);
    return listed ? { username } : null;
  }
  if (!socketId || socketId === 'self') return null;
  const sockets = Array.isArray(playerData?.socket) ? playerData.socket : [];
  if (sockets.includes(socketId)) return null;
  const positions = Array.isArray(playerData?.position) ? playerData.position.filter(Boolean) : [];
  if (ownerNames.length === 0 && positions.length === 0) return null;
  return { peerId: socketId };
}
