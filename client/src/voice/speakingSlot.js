/**
 * Which opponent avatar glows when a voice peer speaks.
 *
 * Keyed by the peer's username (VoiceChatManager keeps it per peer): socket
 * ids change on every reconnect, while playerData.socket is only refreshed
 * by positionUpdate, so a socket-id lookup lit the wrong seat or none after
 * anyone reconnected. The socket id is the fallback for a peer whose
 * username is unknown.
 */

import { team, rotate } from '../utils/positions.js';

/**
 * @param {Object} args
 * @param {string|null} args.username - the speaking peer's username
 * @param {string} args.socketId - the speaking peer's socket id
 * @param {Object|null} args.playerData - GameState.playerData ({position[], socket[], username[]})
 * @param {number|null} args.myPosition
 * @returns {'partner'|'opp1'|'opp2'|null}
 */
export function speakingSlotFor({ username, socketId, playerData, myPosition }) {
  if (!playerData || !myPosition || !Array.isArray(playerData.position)) return null;

  let idx = -1;
  if (username && Array.isArray(playerData.username)) {
    idx = playerData.username.findIndex((u) => (u?.username ?? u) === username);
  }
  if (idx === -1 && socketId && Array.isArray(playerData.socket)) {
    idx = playerData.socket.indexOf(socketId);
  }
  if (idx === -1) return null;

  const pos = playerData.position[idx];
  if (pos === myPosition) return null;
  if (pos === team(myPosition)) return 'partner';
  if (pos === rotate(myPosition)) return 'opp1';
  if (pos === rotate(rotate(rotate(myPosition)))) return 'opp2';
  return null;
}
