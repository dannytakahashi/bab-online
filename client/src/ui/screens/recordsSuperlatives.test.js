/**
 * Superlatives on the Records page (owner-approved 2026-11-20): each period
 * box ends with records.<period>.superlatives drawn generically (title,
 * names joined with ", ", detail), unknown ids the same way; nothing for
 * an absent or empty list; names are text, never markup; a scope switch's
 * reply swaps them in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showRecordsPage, updateRecordsPage, removeRecordsPage, drawableSuperlatives } from './RecordsPage.js';
import { readClientFile } from '../../testing/files.js';
import { _resetStatsScopeForTests } from '../../state/statsScope.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}
const fakeSocket = () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() });

const rec = { score: 300, players: ['Ann', 'Cat'] };
const base = { highestScore: rec, lowestScore: rec, biggestWin: null, mostBags: null, leastBags: null };
const SUPERLATIVES = [
  { id: 'bagBoy', title: 'Bag Boy', names: ['Ann'], detail: '2.4 bags a game' },
  { id: 'luckyDuck', title: 'Lucky Duck', names: ['Ben', 'Cat'], detail: '141.2 avg HSI' },
  { id: 'cursed', title: 'Cursed', names: ['Dan'], detail: '98.7 avg HSI' },
  { id: 'botFriends', title: 'Some of my best friends are bots', names: ['Eve'], detail: '23 solo games' },
  { id: 'helpFromFriends', title: 'A little help from my friends', names: ['Ann', 'Ben', 'Cat'], detail: '37 /help uses (+2 more)' },
  { id: 'anchor', title: 'Anchor', names: ['Dan'], detail: '31% of hands set' },
];

const boxes = () => [...document.querySelectorAll('#recordsRegion .records-box')];
const drawn = (box) => [...box.querySelectorAll('.records-superlatives .superlative')].map((li) => ({
  id: li.dataset.id ?? null,
  title: li.querySelector('.record__label').textContent,
  names: li.querySelector('.superlative__names').textContent,
  detail: li.querySelector('.record__sub')?.textContent ?? null,
}));

beforeEach(() => {
  _resetStatsScopeForTests();
  vi.stubGlobal('localStorage', memoryStorage());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  removeRecordsPage();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  _resetStatsScopeForTests();
});

describe('Superlatives in each period box', () => {
  it('title, the names joined with ", " and the detail, in the server\'s order, after the team records', () => {
    showRecordsPage({ allTime: { ...base, superlatives: SUPERLATIVES }, thisYear: null, thisMonth: null }, 10, fakeSocket(), 'all');
    const [all] = boxes();
    const section = all.querySelector('.records-superlatives');
    expect(section.querySelector('.records-superlatives__title').textContent).toBe('Superlatives');
    expect(section.querySelector('.records-superlatives__title').tagName).toBe('H4');
    expect(drawn(all)).toEqual([
      { id: 'bagBoy', title: 'Bag Boy', names: 'Ann', detail: '2.4 bags a game' },
      { id: 'luckyDuck', title: 'Lucky Duck', names: 'Ben, Cat', detail: '141.2 avg HSI' },
      { id: 'cursed', title: 'Cursed', names: 'Dan', detail: '98.7 avg HSI' },
      { id: 'botFriends', title: 'Some of my best friends are bots', names: 'Eve', detail: '23 solo games' },
      { id: 'helpFromFriends', title: 'A little help from my friends', names: 'Ann, Ben, Cat', detail: '37 /help uses (+2 more)' },
      { id: 'anchor', title: 'Anchor', names: 'Dan', detail: '31% of hands set' },
    ]);
    // a list (one entry per title), the last thing in the box
    expect(section.querySelector('ul.records-superlatives__list').children).toHaveLength(6);
    expect(all.lastElementChild).toBe(section);
    expect(all.querySelectorAll('.record')).toHaveLength(5);
  });

  it('an unknown id (a later title) is drawn the same way; no id at all too', () => {
    const later = [{ id: 'nightOwl', title: 'Night Owl', names: ['Fay'], detail: '40 games after midnight' }, { title: 'No Id', names: ['Gus'], detail: 'x' }];
    showRecordsPage({ allTime: { ...base, superlatives: later }, thisYear: null, thisMonth: null }, 10, fakeSocket(), 'human');
    expect(drawn(boxes()[0])).toEqual([
      { id: 'nightOwl', title: 'Night Owl', names: 'Fay', detail: '40 games after midnight' },
      { id: null, title: 'No Id', names: 'Gus', detail: 'x' },
    ]);
  });

  it('nothing for an absent, empty or non-array list; a period without games shows only its note', () => {
    showRecordsPage({
      allTime: { ...base },
      thisYear: { ...base, superlatives: [] },
      thisMonth: null,
    }, 10, fakeSocket(), 'human');
    for (const box of boxes()) expect(box.querySelector('.records-superlatives')).toBeNull();
    updateRecordsPage({ allTime: { ...base, superlatives: 'nope' }, thisYear: { ...base, superlatives: { bagBoy: 1 } }, thisMonth: null }, 10, 'human');
    for (const box of boxes()) expect(box.querySelector('.records-superlatives')).toBeNull();
    expect(boxes()[2].textContent).toContain('No games yet');
  });

  it('an entry without a title or a name is skipped; a missing detail draws no detail line', () => {
    showRecordsPage({
      allTime: {
        ...base,
        superlatives: [
          { id: 'a', title: '', names: ['Ann'], detail: 'd' },
          { id: 'b', title: 'B', names: [], detail: 'd' },
          { id: 'c', title: 'C', names: [5, null, ''], detail: 'd' },
          null,
          { id: 'd', title: 'Kept', names: ['Ann', 7, 'Ben'] },
        ],
      },
      thisYear: null,
      thisMonth: null,
    }, 10, fakeSocket(), 'human');
    expect(drawn(boxes()[0])).toEqual([{ id: 'd', title: 'Kept', names: 'Ann, Ben', detail: null }]);
    // only skipped entries: no section at all
    expect(drawableSuperlatives([{ title: '', names: ['x'] }, { title: 'T', names: [] }])).toEqual([]);
    expect(drawableSuperlatives(undefined)).toEqual([]);
  });

  it('names and titles are text, never markup', () => {
    const EVIL = '<img src=x onerror=alert(1)>';
    showRecordsPage({ allTime: { ...base, superlatives: [{ id: 'x', title: EVIL, names: [EVIL], detail: EVIL }] }, thisYear: null, thisMonth: null }, 10, fakeSocket(), 'human');
    const box = boxes()[0];
    expect(box.querySelector('img')).toBeNull();
    expect(drawn(box)).toEqual([{ id: 'x', title: EVIL, names: EVIL, detail: EVIL }]);
  });

  it('each period draws its own list; a scope switch\'s reply swaps them in place', () => {
    const month = [{ id: 'bagBoy', title: 'Bag Boy', names: ['Cat'], detail: '3.0 bags a game' }];
    showRecordsPage({
      allTime: { ...base, superlatives: SUPERLATIVES },
      thisYear: { ...base, superlatives: SUPERLATIVES.slice(0, 2) },
      thisMonth: { ...base, superlatives: month },
    }, 10, fakeSocket(), 'human');
    expect(boxes().map((b) => drawn(b).length)).toEqual([6, 2, 1]);
    expect(drawn(boxes()[2])[0].names).toBe('Cat');
    updateRecordsPage({
      allTime: { ...base, superlatives: [{ id: 'botFriends', title: 'Some of my best friends are bots', names: ['Eve'], detail: '5 solo games' }] },
      thisYear: { ...base },
      thisMonth: null,
    }, 5, 'bots');
    expect(boxes().map((b) => drawn(b).length)).toEqual([1, 0, 0]);
    expect(drawn(boxes()[0])[0]).toEqual({ id: 'botFriends', title: 'Some of my best friends are bots', names: 'Eve', detail: '5 solo games' });
  });
});

describe('Superlatives styles', () => {
  it('on tokens: the section, its title, the list and the names have rules in screens.css', () => {
    const css = readClientFile('styles/screens.css');
    for (const sel of ['.records-superlatives {', '.records-superlatives__title {', '.records-superlatives__list {', '.superlative {', '.superlative__names {']) {
      expect(css).toContain(sel);
    }
    const names = css.slice(css.indexOf('.superlative__names {'));
    const rule = names.slice(0, names.indexOf('}'));
    // long names wrap at phone width instead of widening the box
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toMatch(/color: var\(--text-primary\)/);
  });
});
