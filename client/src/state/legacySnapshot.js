/**
 * A snapshot-v2-shaped table view built from a v1 table payload
 * (rejoinSuccess / restorePlayerState / the spectator full state:
 * getClientState / spectatorJoinState), for a payload that carries no
 * `snapshot` (an older server, a test payload). The real v2 snapshot is
 * always preferred: GameState.applySnapshot takes either.
 *
 * What v1 does not say is derived: the cards left in each hand are the
 * deal's size minus the tricks played minus a card already in the current
 * trick (webclient-8: v1's currentHand is the deal size, not what is left);
 * the trick is put in play order from its lead. `seq` is null (no baseline).
 */

const normBid = (b) => (b === undefined || b === null || b === '' ? null : String(b).toUpperCase());

export function playOrder(playedCards, leadPosition) {
  if (!Array.isArray(playedCards)) return [];
  let lead = leadPosition;
  if (!lead) {
    const first = playedCards.findIndex((c) => !!c);
    if (first === -1) return [];
    lead = first + 1;
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const pos = ((lead - 1 + i) % 4) + 1;
    const card = playedCards[pos - 1];
    if (card) out.push({ position: pos, card: { suit: card.suit, rank: card.rank } });
  }
  return out;
}

/**
 * @param {Object} data - a v1 table payload
 * @param {Object} [opts]
 * @param {string} [opts.role] - 'seat' | 'lazyWatcher' | 'spectator' (default from data)
 */
export function snapshotFromLegacy(data, { role } = {}) {
  const d = data || {};
  const viewerRole = role || (d.isLazy ? 'lazyWatcher' : (d.position ? 'seat' : 'spectator'));
  const position = viewerRole === 'spectator' ? null : (d.position || null);
  const bidding = d.isBidding !== undefined ? !!d.isBidding : !!d.bidding;
  const handSize = d.currentHand || (Array.isArray(d.hand) ? d.hand.length : 0);
  const tricks = d.tricks && typeof d.tricks === 'object'
    ? { team1: d.tricks.team1 || 0, team2: d.tricks.team2 || 0 }
    : { team1: 0, team2: 0 };
  const played = tricks.team1 + tricks.team2;
  const cards = bidding ? [] : playOrder(d.playedCards, d.leadPosition);
  const inTrick = new Set(cards.map((c) => c.position));
  const hand = viewerRole === 'spectator' ? null : (Array.isArray(d.hand) ? d.hand.map((c) => ({ suit: c.suit, rank: c.rank })) : []);
  const byPosition = [0, 1, 2, 3].map((i) => normBid(d.playerBids?.[i]));
  const dealt = !!d.trump;
  const turnPos = d.currentTurn || null;
  const stage = !dealt ? 'TEAMS_ANNOUNCED' : (bidding ? 'BIDDING' : (cards.length === 4 ? 'TRICK_RESOLVING' : 'PLAYING'));
  const seats = Array.isArray(d.players) && d.players.length === 4
    ? [1, 2, 3, 4].map((pos) => {
      const p = d.players.find((x) => x.position === pos) || {};
      const mine = position === pos && hand;
      return {
        position: pos,
        username: p.username ?? null,
        pic: typeof p.pic === 'number' ? p.pic : null,
        hasCustomPic: typeof p.pic === 'string',
        customPic: typeof p.pic === 'string' ? p.pic : null,
        ownerUsername: p.username ?? null,
        controller: 'human',
        presence: 'connected',
        isBot: false,
        lazy: false,
        offered: false,
        graceDeadline: null,
        resignableAt: null,
        cardsInHand: mine ? hand.length : Math.max(0, handSize - played - (inTrick.has(pos) ? 1 : 0)),
      };
    })
    : [];
  const myBid = position ? byPosition[position - 1] : null;
  const canAct = viewerRole === 'seat' && !!turnPos && turnPos === position &&
    (bidding ? myBid === null : !inTrick.has(position));
  const hsi = d.hsiValues ? [1, 2, 3, 4].map((p) => (typeof d.hsiValues[p] === 'number' ? d.hsiValues[p] : null)) : null;
  return {
    v: 2,
    gameId: d.gameId || null,
    seq: null,
    serverTime: null,
    stage,
    partial: ['customPics'],
    viewer: { role: viewerRole, position, ownerView: null, canAct },
    hand,
    deal: dealt ? { handNo: d.handNo || null, handSize, dealer: d.dealer ?? null, bidder: null, dealSeq: null } : null,
    trump: d.trump || null,
    trumpBroken: !!(d.trumpBroken ?? d.isTrumpBroken),
    turn: turnPos && (stage === 'BIDDING' || stage === 'PLAYING') ? { position: turnPos, action: bidding ? 'bid' : 'play' } : null,
    bids: { byPosition, order: [1, 2, 3, 4], teamBids: null, mults: { team1: 1, team2: 1 } },
    trick: { number: dealt && !bidding ? played + 1 : null, leadPosition: cards[0]?.position ?? null, cards },
    tricks,
    tricksByPosition: [0, 0, 0, 0],
    score: { team1: d.score?.team1 || 0, team2: d.score?.team2 || 0 },
    rainbows: { team1: 0, team2: 0 },
    hsi,
    seats,
    entrants: null,
    draw: null,
    spectatorCount: 0,
    tournament: null,
    log: Array.isArray(d.gameLog)
      ? d.gameLog.map((e) => ({
        message: e.message,
        type: e.type || (e.playerPosition == null ? 'system' : 'chat'),
        position: e.playerPosition ?? e.position ?? null,
        at: e.timestamp ?? e.at ?? null,
      }))
      : [],
    resume: null,
  };
}
