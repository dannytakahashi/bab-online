/**
 * The owner rule's names (2026-11-25: people by player names): a lazy or
 * resigned seat is named by its owner, never the bot playing it, in team
 * names, the hand and game-over lines, the score headers and the score
 * screen, Get Your Bid's per-player lines included. Pure: reads the state
 * it is given (GameState.teamPlayerData is this over the live state).
 */

/**
 * GameState.teamPlayerData for any state shaped like one ({playerData,
 * seatOwners}): each seat named by its owner (a lazy or resigned seat's,
 * never the bot playing it), else the name it shows. Team names, the hand
 * and game-over lines and the score screen read it; the avatars keep
 * playerData. Returns playerData itself when nothing differs.
 */
export function teamPlayerDataOf(state) {
  const pd = state?.playerData;
  if (!pd || !Array.isArray(pd.position) || !Array.isArray(pd.username)) return pd ?? null;
  const owners = state.seatOwners || {};
  let changed = false;
  const names = pd.position.map((pos, i) => {
    const entry = pd.username[i];
    const shown = typeof entry === 'string' ? entry : entry?.username;
    const owner = owners[pos];
    if (typeof owner !== 'string' || !owner || owner === shown) return entry;
    changed = true;
    return entry && typeof entry === 'object' ? { ...entry, username: owner } : { username: owner };
  });
  return changed ? { ...pd, username: names } : pd;
}
