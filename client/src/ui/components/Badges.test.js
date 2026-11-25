/**
 * Badges on the web (ui/components/Badges.js, the profile pages, the
 * badgesAwarded handler): only what the server sent is drawn, below the
 * statistics; the client holds no catalog; the toast names what was earned.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanBadges, createBadgesSection, badgesEarnedText, badgesEarnedArt, badgeArtSrc, BADGES_CAP } from './Badges.js';
import { showProfilePage, showPlayerProfilePage, removeProfilePage, removePlayerProfilePage } from '../screens/ProfilePage.js';
import { registerProfileHandlers } from '../../handlers/profileHandlers.js';
import { clientHello } from '../../utils/avatar.js';
import { readClientFile } from '../../testing/files.js';

const FELTED = { id: 'felted', name: 'Felted', description: 'Ended a game with a negative score.', at: '2026-11-20T10:00:00.000Z' };
const FIVE = { id: 'five-hundred', name: '500', description: 'Scored 500 points in a game.' };
const profile = { username: 'Ann', profilePic: 3, stats: { gamesPlayed: 4, wins: 2, losses: 2 } };
const names = (root) => [...root.querySelectorAll('.badge-item__name')].map((n) => n.textContent);

afterEach(() => {
  removeProfilePage();
  removePlayerProfilePage();
  document.body.replaceChildren();
});

describe('Badges', () => {
  it('the page announces the cap', () => {
    expect(clientHello('1.0.0', 'abc').caps).toContain(BADGES_CAP);
  });

  it('cleanBadges keeps well-formed entries, each id once', () => {
    expect(cleanBadges([FELTED, FELTED, null, { id: '../x', name: 'Bad' }, { id: 'ok' }, { id: 'UPPER', name: 'No' }, FIVE])).toEqual([
      { id: 'felted', name: 'Felted', description: 'Ended a game with a negative score.' },
      { id: 'five-hundred', name: '500', description: 'Scored 500 points in a game.' },
    ]);
    expect(cleanBadges(undefined)).toEqual([]);
  });

  it('the section: a heading and one item per earned badge, art by id, text only', () => {
    const section = createBadgesSection([FELTED, { id: 'exact-tie', name: '<b>Tie</b>', description: '' }], 'r');
    document.body.append(...section.nodes);
    expect(section.nodes[0].textContent).toBe('Badges');
    expect(names(document.body)).toEqual(['Felted', '<b>Tie</b>']);
    const img = document.querySelector('[data-badge="felted"] img');
    expect(img.getAttribute('src')).toBe(badgeArtSrc('felted'));
    expect(img.getAttribute('src')).toBe('assets/badges/felted.svg');
    expect(document.querySelector('[data-badge="felted"] .badge-item__desc').textContent).toBe(FELTED.description);
    expect(document.querySelector('[data-badge="exact-tie"] .badge-item__desc')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('art this bundle does not have: the picture hides, the words stay', () => {
    const section = createBadgesSection([{ id: 'from-the-future', name: 'New One', description: 'Later.' }], 'r');
    document.body.append(...section.nodes);
    const img = document.querySelector('img');
    img.dispatchEvent(new Event('error'));
    expect(img.hidden).toBe(true);
    expect(names(document.body)).toEqual(['New One']);
  });

  it('no badges: a short note, and never a list of what could be earned', () => {
    const section = createBadgesSection([], 'r');
    document.body.append(...section.nodes);
    expect(document.querySelector('#r').textContent).toBe('No badges yet.');
    expect(document.querySelector('.badge-item')).toBeNull();
    section.update([FIVE]);
    expect(names(document.body)).toEqual(['500']);
  });

  it('the client holds no catalog: no badge name or id is in the bundle sources', () => {
    for (const file of ['src/ui/components/Badges.js', 'src/ui/screens/ProfilePage.js', 'src/handlers/profileHandlers.js', 'src/main.js']) {
      const text = readClientFile(file);
      for (const word of ['Comeback Kid', 'comeback-kid', 'Choke Artist', 'hammer-time', 'Lost the Farm', 'child-labor']) {
        expect(text.includes(word), `${file} names ${word}`).toBe(false);
      }
    }
  });

  it('the toast names what was earned', () => {
    expect(badgesEarnedText([FELTED])).toBe('Badge earned: Felted');
    expect(badgesEarnedText([FIVE, FELTED])).toBe('Badges earned: 500, Felted');
    expect(badgesEarnedText([])).toBe('');
    expect(badgesEarnedText([{ id: 'x' }])).toBe('');
    // and shows their pictures
    expect(badgesEarnedArt([FIVE, FELTED, { id: '../x', name: 'Bad' }])).toEqual(['assets/badges/five-hundred.svg', 'assets/badges/felted.svg']);
    expect(badgesEarnedArt(undefined)).toEqual([]);
  });
});

describe('the profile pages', () => {
  it('the own profile lists the earned badges below the statistics', () => {
    showProfilePage(profile, { emit: vi.fn() }, 'human', [FELTED, FIVE]);
    const modal = document.getElementById('profilePageModal');
    expect(names(modal)).toEqual(['Felted', '500']);
    const stats = modal.querySelector('#profileStatsRegion');
    const region = modal.querySelector('#profileBadgesRegion');
    expect(stats.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and above Sign Out
    const signOut = modal.querySelector('.profile-signout');
    expect(region.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a profile opened without badges (an older server) still opens', () => {
    showProfilePage(profile, { emit: vi.fn() });
    expect(document.querySelector('#profileBadgesRegion').textContent).toBe('No badges yet.');
  });

  it('another player\'s profile lists that player\'s badges below the statistics', () => {
    showPlayerProfilePage({ ...profile, username: 'Ben' }, { emit: vi.fn() }, { badges: [FIVE] });
    const modal = document.getElementById('playerProfilePageModal');
    expect(names(modal)).toEqual(['500']);
    const stats = modal.querySelector('#playerProfileStatsRegion');
    const region = modal.querySelector('#playerProfileBadgesRegion');
    expect(stats.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the handlers', () => {
  function wire(callbacks) {
    const listeners = {};
    registerProfileHandlers({ on: (event, fn) => { listeners[event] = fn; } }, callbacks);
    return listeners;
  }

  it('profile replies pass their badges on', () => {
    const onProfileReceived = vi.fn();
    const onPlayerProfileReceived = vi.fn();
    const l = wire({ onProfileReceived, onPlayerProfileReceived });
    l.profileResponse({ success: true, profile, scope: 'human', badges: [FELTED] });
    expect(onProfileReceived).toHaveBeenCalledWith(profile, 'human', [FELTED]);
    l.playerProfileResponse({ success: true, profile, badges: [FIVE] });
    expect(onPlayerProfileReceived).toHaveBeenCalledWith(profile, undefined, [FIVE]);
  });

  it('badgesAwarded reaches the toast callback only with badges', () => {
    const onBadgesAwarded = vi.fn();
    const l = wire({ onBadgesAwarded });
    l.badgesAwarded({ gameId: 'g-1', badges: [FELTED] });
    expect(onBadgesAwarded).toHaveBeenCalledWith([FELTED], 'g-1');
    l.badgesAwarded({ gameId: 'g-1', badges: [] });
    l.badgesAwarded(undefined);
    expect(onBadgesAwarded).toHaveBeenCalledTimes(1);
  });
});
