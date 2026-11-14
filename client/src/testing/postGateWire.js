/**
 * Test harness: the wire as the server will send it once iOS 1.1.0 is gated
 * and the removals the web is ready for have run (contract/V1_REMOVALS.md),
 * applied to a recorded game. One transform per entry, named after it, so a
 * replay through the real page shows that the web needs no change for any
 * of them. Read-only: the recordings are never rewritten.
 *
 *   #1 phase B  no `error` (its `serverError` twin stays); done on the
 *               server, so recordings made since have none (the transform
 *               stays for older recordings)
 *   #5          gameStart without `playerInfo` (the web keeps the names and
 *               pictures positionUpdate, the seat events and the
 *               snapshots gave; GameState.applyDeal still reads it when
 *               present)
 *   #6          gameStart without `players` (seat socket ids)
 *   #7          no `playerAssigned`
 *   #9          rejoinSuccess / restorePlayerState / the spectator full
 *               state carry only {snapshot} (and rejoinSuccess's
 *               tournamentId, kept while web reads it)
 *   #14         no socket ids in positionUpdate (`sockets`,
 *               `usernames[].socketId`) or playerDrew (`socketId`)
 *
 * Not applied, because the web still needs it: the lobby players' socketId
 * (removeBot), and the voice signaling's own socket ids (voiceOffer
 * targetSocketId / fromSocketId), which #14 does not remove.
 */

const pick = (data, keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));

export const POST_GATE = {
  '#1B': (event) => (event === 'error' ? null : undefined),
  '#7': (event) => (event === 'playerAssigned' ? null : undefined),
  '#5': (event, data) => {
    if (event !== 'gameStart') return undefined;
    const { playerInfo, ...rest } = data;
    return rest;
  },
  '#6': (event, data) => {
    if (event !== 'gameStart') return undefined;
    const { players, ...rest } = data;
    return rest;
  },
  '#14': (event, data) => {
    if (event === 'positionUpdate') {
      const { sockets, ...rest } = data;
      return { ...rest, usernames: (rest.usernames || []).map((u) => ({ username: u?.username ?? u })) };
    }
    if (event === 'playerDrew') {
      const { socketId, ...rest } = data;
      return rest;
    }
    return undefined;
  },
  '#9': (event, data) => {
    if (event === 'rejoinSuccess') return pick(data, ['snapshot', 'tournamentId']);
    if (event === 'restorePlayerState') return pick(data, ['snapshot']);
    if (event === 'spectatorJoined' && data.snapshot) return pick(data, ['snapshot']);
    return undefined;
  },
};

/** postGateEvent's answer for an event the post-gate server does not send. */
export const NOT_SENT = Symbol('notSent');

/**
 * One recorded s2c event as the post-gate server sends it.
 * @returns {*} the payload, or NOT_SENT
 */
export function postGateEvent(event, data, removals = Object.keys(POST_GATE)) {
  let d = data;
  for (const id of removals) {
    const out = POST_GATE[id](event, d);
    if (out === null) return NOT_SENT;
    if (out !== undefined) d = out;
  }
  return d;
}

/** A viewer's log on the post-gate wire (entries keep their `i`, so checkpoints still line up). */
export function postGateLog(log, removals) {
  const out = [];
  for (const e of log) {
    if (e.dir !== 's2c') {
      out.push(e);
      continue;
    }
    const data = postGateEvent(e.event, JSON.parse(JSON.stringify(e.data ?? null)), removals);
    if (data !== NOT_SENT) out.push({ ...e, data });
  }
  return out;
}

/** The recording with every viewer's log on the post-gate wire. */
export function postGateRecording(rec, removals) {
  return { ...rec, logs: Object.fromEntries(Object.entries(rec.logs).map(([k, log]) => [k, postGateLog(log, removals)])) };
}
