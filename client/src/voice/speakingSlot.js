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

import { team, rotate } from '../utils/positions.js';

/**
 * @param {Object} args
 * @param {string|null} args.username - the speaking peer's username
 * @param {string} args.socketId - the speaking peer's socket id
 * @param {Object|null} args.playerData - GameState.playerData ({position[], socket[], username[]})
 * @param {number|null} args.myPosition
 * @param {Object} [args.owners] - GameState.seatOwners ({position: username})
 * @returns {'partner'|'opp1'|'opp2'|null}
 */
export function speakingSlotFor({ username, socketId, playerData, myPosition, owners = null }) {
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

  if (pos === myPosition) return null;
  if (pos === team(myPosition)) return 'partner';
  if (pos === rotate(myPosition)) return 'opp1';
  if (pos === rotate(rotate(rotate(myPosition)))) return 'opp2';
  return null;
}
