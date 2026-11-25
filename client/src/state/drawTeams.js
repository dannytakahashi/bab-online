/**
 * A tournament table's planned teams as the web keeps them (2026-11-25):
 * startDraw.teams and snapshot v2 draw.teams (contract $defs
 * plannedTeamPlayer): exactly two teams of two players, each with a
 * non-empty string username (isBot read as `=== true`), else null. A
 * malformed key is dropped, never an error: the draw then shows as a casual
 * one. ui/drawCopy.js words it.
 */
export function validTeams(teams) {
  if (!Array.isArray(teams) || teams.length !== 2) return null;
  for (const t of teams) {
    if (!Array.isArray(t) || t.length !== 2) return null;
    for (const p of t) {
      if (!p || typeof p !== 'object' || typeof p.username !== 'string' || !p.username) return null;
    }
  }
  return teams.map((t) => t.map((p) => ({ username: p.username, isBot: p.isBot === true })));
}
