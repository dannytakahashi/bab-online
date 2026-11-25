import { describe, it, expect, afterEach } from 'vitest';
import { partnersSoFar, pairingLine, pairingSpoken, latestRound, hasPairings, renderPairings, cleanPairings } from './tournamentPairings.js';

// Three rounds of a 6-member tournament: me (ed) with fay, then a bot
// partner, then a sit-out; long names and a 2-member table
const P = [
  { roundNumber: 1, tables: [
    { gameId: 'g1', teams: [['ann', 'bob'], ['ed', 'fay']] },
    { gameId: 'g2', teams: [['cat', null], ['dan', null]] },
  ] },
  { roundNumber: 2, tables: [
    { gameId: 'g3', teams: [['ann', 'fay'], ['bob', 'cat']] },
    { gameId: 'g4', teams: [['ed', null], ['Maximiliana_Quintessence', null]] },
  ] },
  { roundNumber: 3, tables: [
    { gameId: null, teams: [['ann', 'dan'], ['bob', 'fay']] },
  ] },
];

afterEach(() => document.body.replaceChildren());

describe('the words', () => {
  it('pairingLine: my team first as You, a bot as "a bot", two bots as "two bots"', () => {
    expect(pairingLine(P[0].tables[0].teams, 'ed')).toBe('You & fay vs ann & bob');
    expect(pairingLine(P[0].tables[0].teams, 'fay')).toBe('You & ed vs ann & bob');
    expect(pairingLine(P[0].tables[0].teams, null)).toBe('ann & bob vs ed & fay');
    expect(pairingLine(P[0].tables[1].teams, null)).toBe('cat & a bot vs dan & a bot');
    expect(pairingLine([['ed', null], [null, null]], 'ed')).toBe('You & a bot vs two bots');
    expect(pairingSpoken(P[0].tables[0].teams, 'ed')).toBe('you and fay versus ann and bob');
  });

  it('partnersSoFar: a name, a bot, or sat out, round by round', () => {
    expect(partnersSoFar(P, 'ed')).toEqual([
      { roundNumber: 1, partner: 'fay' }, { roundNumber: 2, partner: 'a bot' }, { roundNumber: 3, partner: 'sat out' },
    ]);
    expect(partnersSoFar(P, 'fay').map((p) => p.partner)).toEqual(['ed', 'ann', 'bob']);
  });

  it('never a team number', () => {
    for (const me of [null, 'ed', 'cat']) {
      for (const r of P) for (const t of r.tables) expect(pairingLine(t.teams, me)).not.toMatch(/Team [12]|T[12]\b|Your Team|Opponents/);
    }
  });

  it('latestRound: my table first; hasPairings only with a two-member table; malformed entries dropped', () => {
    expect(latestRound(P, 'bob').tables[0].teams).toEqual([['ann', 'dan'], ['bob', 'fay']]);
    expect(latestRound(P.slice(0, 2), 'ed').tables[0].gameId).toBe('g4');
    expect(hasPairings(P)).toBe(true);
    expect(hasPairings([{ roundNumber: 1, tables: [{ gameId: 'g', teams: [['ed', null], [null, null]] }] }])).toBe(false);
    expect(hasPairings(null)).toBe(false);
    expect(cleanPairings([{ roundNumber: 1, tables: [{ teams: [['a']] }, { gameId: 'g', teams: [['a', 'b'], ['c', 'd']] }] }, { roundNumber: 'x' }, null]))
      .toEqual([{ roundNumber: 1, tables: [{ gameId: 'g', teams: [['a', 'b'], ['c', 'd']] }] }]);
  });
});

describe('renderPairings', () => {
  const box = () => {
    const c = document.createElement('section');
    document.body.appendChild(c);
    return c;
  };

  it('a member: "Round 3 pairings" (mine first; here I sat out) and "Partners so far"', () => {
    const c = box();
    renderPairings(c, { pairings: P, me: 'ed' });
    expect(c.hidden).toBe(false);
    expect([...c.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Round 3 pairings', 'Partners so far']);
    expect([...c.querySelectorAll('.tournament-pairings__row')].map((r) => r.textContent)).toEqual(['ann & dan vs bob & fay']);
    expect([...c.querySelectorAll('.tournament-pairings__partner')].map((r) => r.textContent))
      .toEqual(['Round 1 · fay', 'Round 2 · a bot', 'Round 3 · sat out']);
  });

  it('my table is first and marked; rows are read out with and / versus', () => {
    const c = box();
    renderPairings(c, { pairings: P.slice(0, 2), me: 'ed' });
    const rows = [...c.querySelectorAll('.tournament-pairings__row')];
    expect(rows.map((r) => r.textContent)).toEqual(['You & a bot vs Maximiliana_Quintessence & a bot', 'ann & fay vs bob & cat']);
    expect(rows[0].classList.contains('is-mine')).toBe(true);
    expect(rows[0].getAttribute('aria-label')).toBe('you and a bot versus Maximiliana_Quintessence and a bot');
  });

  it('a spectator: every round\'s tables, newest first, no Partners so far', () => {
    const c = box();
    renderPairings(c, { pairings: P, me: 'zed', spectator: true });
    expect([...c.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Round 3 pairings', 'Round 2 pairings', 'Round 1 pairings']);
    expect(c.querySelectorAll('.tournament-pairings__row')).toHaveLength(5);
    expect(c.querySelector('.tournament-pairings__partners')).toBeNull();
  });

  it('hidden with nothing to show', () => {
    const c = box();
    renderPairings(c, { pairings: [], me: 'ed' });
    expect(c.hidden).toBe(true);
    expect(c.children).toHaveLength(0);
  });
});
