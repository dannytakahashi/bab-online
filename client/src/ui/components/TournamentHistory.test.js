/**
 * The profile's Tournaments section (owner 2026-11-25): played / won / Cut
 * for a buck wins, the recent results by name and place, nothing for a
 * player without a finished tournament (or a server without the fields),
 * user text as text; on both profiles, and a stats scope reply leaves it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createTournamentHistorySection, resultLabel, ordinal, TOURNAMENT_HISTORY_COPY as C } from './TournamentHistory.js';
import {
  showProfilePage, showPlayerProfilePage, removeProfilePage, removePlayerProfilePage, updatePlayerProfileStats,
} from '../screens/ProfilePage.js';
import { _resetStatsScopeForTests } from '../../state/statsScope.js';

const result = (over = {}) => ({
  id: 't1', name: 'Friday Cup', completedAt: '2026-11-25T20:00:00.000Z', totalRounds: 4, players: 6,
  place: 2, won: false, winners: ['kim'], cutWinner: null, ...over,
});

const profile = (over = {}) => ({
  username: 'dan', profilePic: 3, customProfilePic: null, stats: {},
  tournaments: { played: 5, won: 2, recent: [result({ id: 'a', won: true, place: 1, winners: ['dan'], cutWinner: 'dan' }), result({ id: 'b', cutWinner: 'kim' }), result({ id: 'c', won: true, place: 1, winners: ['dan', 'bo'] })] },
  cutForABuck: { wins: 1, played: 3 },
  ...over,
});

function mount(p, id = 'th') {
  const { nodes } = createTournamentHistorySection(p, id);
  document.body.replaceChildren(...nodes);
  return nodes[0] || null;
}

const statTexts = (root) => [...root.querySelectorAll('.stat')].map((s) => [s.querySelector('.stat__label').textContent, s.querySelector('.stat__value').textContent]);

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), clear: () => map.clear() };
}

beforeEach(() => {
  _resetStatsScopeForTests();
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  removeProfilePage();
  removePlayerProfilePage();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('createTournamentHistorySection', () => {
  it('shows played, won and Cut for a buck "wins of played", then the recent results newest first', () => {
    const root = mount(profile());
    expect(root.getAttribute('aria-labelledby')).toBe('thTitle');
    expect(root.querySelector('h3').textContent).toBe(C.title);
    expect(statTexts(root)).toEqual([[C.played, '5'], [C.won, '2'], [C.cut, '1 of 3']]);
    const items = [...root.querySelectorAll('ol > li')];
    expect(root.querySelector('ol').getAttribute('aria-labelledby')).toBe('thRecent');
    expect(items).toHaveLength(3);
    expect(items[0].querySelector('.tournament-history__name').textContent).toBe('Friday Cup');
    expect(items[0].querySelector('.tournament-history__result').textContent).toBe('Won');
    expect(items[0].querySelector('.tournament-history__result').classList.contains('is-win')).toBe(true);
    expect(items[0].querySelector('.tournament-history__cut').textContent).toBe(C.wonCut);
    expect(items[0].querySelector('.tournament-history__meta').textContent).toMatch(/6 players · 4 rounds$/);
    expect(items[1].querySelector('.tournament-history__result').textContent).toBe('2nd of 6');
    expect(items[1].querySelector('.tournament-history__cut').textContent).toBe('Cut for a buck: kim');
    expect(items[2].querySelector('.tournament-history__result').textContent).toBe('Won (tied)');
    expect(items[2].querySelector('.tournament-history__cut')).toBeNull();
  });

  it('nothing for a player with no finished tournament, or a server without the fields', () => {
    expect(createTournamentHistorySection(profile({ tournaments: { played: 0, won: 0, recent: [] }, cutForABuck: { wins: 0, played: 0 } }), 'x').nodes).toEqual([]);
    expect(createTournamentHistorySection({ username: 'dan', stats: {} }, 'x').nodes).toEqual([]);
    expect(createTournamentHistorySection(null, 'x').nodes).toEqual([]);
  });

  it('no cut played: no Cut for a buck stat; no recent list: no list', () => {
    const root = mount(profile({ tournaments: { played: 1, won: 0, recent: [] }, cutForABuck: { wins: 0, played: 0 } }));
    expect(statTexts(root)).toEqual([[C.played, '1'], [C.won, '0']]);
    expect(root.querySelector('ol')).toBeNull();
  });

  it('names are text, never markup; [deleted] shows as is', () => {
    const root = mount(profile({ tournaments: { played: 1, won: 0, recent: [result({ name: '<img src=x onerror=alert(1)>', cutWinner: '[deleted]' })] } }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.tournament-history__name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('.tournament-history__cut').textContent).toBe('Cut for a buck: [deleted]');
  });

  it('labels: places and ordinals, a missing place, a 1-round tournament', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th']);
    expect(resultLabel(result({ place: null }))).toBe('Finished');
    expect(resultLabel(result({ place: 3, players: 0 }))).toBe('3rd');
    const root = mount(profile({ tournaments: { played: 1, won: 1, recent: [result({ totalRounds: 1, players: 2, won: true, completedAt: null })] } }));
    expect(root.querySelector('.tournament-history__meta').textContent).toBe('2 players · 1 round');
  });
});

describe('on the profiles', () => {
  const socket = () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() });

  it('the own profile shows it after the statistics', () => {
    showProfilePage(profile(), socket());
    const modal = document.getElementById('profilePageModal');
    const section = modal.querySelector('#profileTournaments');
    expect(section).not.toBeNull();
    const titles = [...modal.querySelectorAll('h3.section-title')].map((h) => h.textContent);
    // after the statistics (and after Badges, #408, when that section is there)
    expect(titles.indexOf('Tournaments')).toBeGreaterThan(titles.indexOf('Statistics'));
    if (titles.includes('Badges')) expect(titles.indexOf('Tournaments')).toBe(titles.indexOf('Badges') + 1);
  });

  it("another player's profile shows it; a stats scope reply leaves it in place", () => {
    showPlayerProfilePage(profile({ username: 'kim' }), socket(), { scope: 'human' });
    const section = document.querySelector('#playerProfileTournaments');
    expect(section).not.toBeNull();
    expect(updatePlayerProfileStats(profile({ username: 'kim', stats: { gamesPlayed: 3 } }), 'bots')).toBe(true);
    expect(document.querySelector('#playerProfileTournaments')).toBe(section);
  });

  it('a profile without a tournament has no section', () => {
    showProfilePage({ username: 'new', profilePic: 1, stats: {} }, socket());
    expect(document.querySelector('#profileTournaments')).toBeNull();
  });
});
