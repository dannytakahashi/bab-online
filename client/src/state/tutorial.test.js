import { describe, it, expect, beforeEach } from 'vitest';
import {
  TUTORIAL_CAP, TUTORIAL_COMMAND, resetTutorial, forgetTutorial, noteTutorialState, tutorialIsOn, tutorialIsAuto,
  tutorialDescription, chipVisible, isTipHint, tipText, isWelcomeTip, tipActions, tipActionCommand, tipLogLine,
  tipAnnouncement, isRowOnlyTip, CHIP_LABEL, CHIP_OFF_LABEL, TIP_ACTION_LABEL,
} from './tutorial.js';

const NAME_LINT = /\bteam ?[12]\b|\bT[12]\b|your team|other team|opponents?/i;

/** A tip as the server sends it (assistHandlers.sendTip). */
const tip = (over = {}) => ({
  v: 1, source: 'tutorial', kind: 'tip', turnKey: '1|BIDDING|2|1|0', headline: 'Trump',
  reasons: ['Trump this hand is hearts ♥. Any heart beats any card of another suit, and the two jokers are the highest trumps.'],
  uses: 0, freeUses: 3, assisted: false, counted: false, tipId: 'T.trump', ...over,
});
const welcome = () => tip({
  headline: 'Tutorial on', tipId: 'T.welcome', actions: ['keep', 'off'],
  reasons: ['Tips will appear above your cards. Only you see them. Close one with ×, or choose Turn off to stop them.'],
});
const seat = (over = {}) => ({ gameId: 'g', position: 1, isSpectator: false, isLazy: false, phase: 'playing', ...over });

beforeEach(() => forgetTutorial());

describe('the cap and the command', () => {
  it('asks for tips with the cap tutorial; the command is /tutorial', () => {
    expect(TUTORIAL_CAP).toBe('tutorial');
    expect(TUTORIAL_COMMAND).toBe('/tutorial');
  });

  it('the chat line: on offer while off, "Turn off the tutorial" while on', () => {
    expect(tutorialDescription()).toBe('Tutorial: tips and advice every turn');
    noteTutorialState({ tutorial: true, auto: false });
    expect(tutorialDescription()).toBe('Turn off the tutorial');
  });

  it('the welcome\'s buttons and what they send', () => {
    expect(tipActions(welcome())).toEqual(['keep', 'off']);
    expect(tipActions(tip({ actions: ['off', 'keep', 'nope', 'off'] }))).toEqual(['keep', 'off']);
    expect(tipActions(tip())).toEqual([]);
    expect(TIP_ACTION_LABEL).toEqual({ keep: 'Keep', off: 'Turn off' });
    expect(tipActionCommand('keep')).toBe('/tutorial keep');
    expect(tipActionCommand('off')).toBe('/tutorial off');
    expect(tipActionCommand('x')).toBeNull();
  });
});

describe('on or off', () => {
  it('off until the server says; assistState or a snapshot turns it on, and off again', () => {
    expect(tutorialIsOn()).toBe(false);
    noteTutorialState({ tutorial: true, auto: true, uses: 0, freeUses: 3, assisted: false });
    expect(tutorialIsOn()).toBe(true);
    expect(tutorialIsAuto()).toBe(true);
    noteTutorialState({ tutorial: false, auto: false });
    expect(tutorialIsOn()).toBe(false);
    expect(tutorialIsAuto()).toBe(false);
    // a snapshot's viewer.assist without the key: off
    noteTutorialState({ uses: 1, freeUses: 3, assisted: false }, 'g');
    expect(tutorialIsOn('g')).toBe(false);
  });

  it('auto only while on', () => {
    noteTutorialState({ tutorial: false, auto: true });
    expect(tutorialIsAuto()).toBe(false);
  });

  it('an assistState between createUI and the deal (no game id yet) counts for the game that follows', () => {
    resetTutorial();
    noteTutorialState({ tutorial: true, auto: true }, null);
    expect(tutorialIsOn('the-new-game')).toBe(true);
  });

  it('a snapshot binds it to its game: another game\'s state is not this one\'s', () => {
    noteTutorialState({ tutorial: true }, 'g1');
    expect(tutorialIsOn('g1')).toBe(true);
    expect(tutorialIsOn('g2')).toBe(false);
    // a new game (createUI) resets it
    resetTutorial();
    expect(tutorialIsOn('g1')).toBe(false);
  });

  it('ignores what is not a payload', () => {
    noteTutorialState({ tutorial: true });
    noteTutorialState(null);
    noteTutorialState('on');
    expect(tutorialIsOn()).toBe(true);
  });
});

describe('the chip', () => {
  it('shows only while on, for my own seat past the draw', () => {
    expect(chipVisible(seat())).toBe(false);
    noteTutorialState({ tutorial: true }, 'g');
    expect(chipVisible(seat())).toBe(true);
    expect(chipVisible(seat({ phase: 'bidding' }))).toBe(true);
    expect(chipVisible(seat({ phase: 'draw' }))).toBe(false);
    expect(chipVisible(seat({ isSpectator: true }))).toBe(false);
    expect(chipVisible(seat({ isLazy: true, isSpectator: true }))).toBe(false);
    expect(chipVisible(seat({ isLazy: true }))).toBe(false);
    expect(chipVisible(seat({ position: null }))).toBe(false);
    expect(chipVisible(seat({ gameId: 'other' }))).toBe(false);
    expect(chipVisible(null)).toBe(false);
  });

  it('its words', () => {
    expect(CHIP_LABEL).toBe('Tutorial on');
    expect(CHIP_OFF_LABEL).toBe('Turn off the tutorial');
  });
});

describe('tips', () => {
  it('knows a tip it can show', () => {
    expect(isTipHint(tip())).toBe(true);
    expect(isTipHint(tip({ source: 'help' }))).toBe(false);
    expect(isTipHint(tip({ kind: 'card' }))).toBe(false);
    expect(isTipHint(tip({ v: 2 }))).toBe(false);
    expect(isTipHint(tip({ headline: '' }))).toBe(false);
    expect(isTipHint(tip({ reasons: [] }))).toBe(false);
    expect(isTipHint(tip({ reasons: [''] }))).toBe(false);
    expect(isTipHint(null)).toBe(false);
  });

  it('its text, its row, its announcement (once: the scene says it on arrival)', () => {
    expect(tipText(tip())).toMatch(/^Trump this hand is hearts ♥\./);
    expect(tipLogLine(tip())).toBe(`Tip: ${tip().reasons[0]}`);
    expect(tipAnnouncement(tip())).toBe(`Tip: Trump. ${tip().reasons[0]}`);
    expect(tipLogLine({ kind: 'card' })).toBeNull();
    expect(tipAnnouncement({})).toBe('');
  });

  it('the welcome (by id or by its actions) and the game-end tip (a row only)', () => {
    expect(isWelcomeTip(welcome())).toBe(true);
    expect(isWelcomeTip(tip({ actions: ['keep'] }))).toBe(true);
    expect(isWelcomeTip(tip())).toBe(false);
    expect(isRowOnlyTip(tip({ tipId: 'T.done', headline: 'Tutorial complete', reasons: ['Thanks for playing with the tutorial. Type /help any time for a suggestion.'] }))).toBe(true);
    expect(isRowOnlyTip(tip())).toBe(false);
  });

  it('names no team in any text it makes', () => {
    noteTutorialState({ tutorial: true });
    const texts = [tutorialDescription(), CHIP_LABEL, CHIP_OFF_LABEL, tipLogLine(tip()), tipAnnouncement(welcome()), ...Object.values(TIP_ACTION_LABEL)];
    forgetTutorial();
    texts.push(tutorialDescription());
    for (const t of texts) expect(t).not.toMatch(NAME_LINT);
  });
});
