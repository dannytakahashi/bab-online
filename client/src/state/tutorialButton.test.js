/**
 * The Tutorial button's rules (owner 2026-11-21; the view is
 * ui/components/TutorialButton.js): when it is up and usable
 * (state/tutorial.js), when it asks before turning the tutorial on
 * (state/assistHint.js tutorialNeedsConfirm, iOS TutorialRules.needsConfirm),
 * and its words (iOS's confirm exactly).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as t from './tutorial.js';
import { resetAssistUses, forgetAssistUses, noteAssistUses, tutorialNeedsConfirm } from './assistHint.js';

const NAME_LINT = /\bteam ?[12]\b|\bT[12]\b|your team|other team|opponents?/i;
const seat = (over = {}) => ({ gameId: 'g', position: 1, isSpectator: false, isLazy: false, phase: 'playing', ...over });

describe('tutorialButtonVisible: my own seat, the whole game, on or off', () => {
  beforeEach(() => t.resetTutorial('g'));

  it('the draw, bidding and play, with the tutorial off or on; never the game end or off the table', () => {
    for (const phase of ['draw', 'bidding', 'playing']) expect(t.tutorialButtonVisible(seat({ phase }))).toBe(true);
    t.noteTutorialState({ tutorial: true }, 'g');
    for (const phase of ['draw', 'bidding', 'playing']) expect(t.tutorialButtonVisible(seat({ phase }))).toBe(true);
    for (const phase of ['ended', 'lobby', 'none']) expect(t.tutorialButtonVisible(seat({ phase }))).toBe(false);
  });

  it('never for a spectator, a lazy watcher (a bot plays my seat) or no seat', () => {
    expect(t.tutorialButtonVisible(seat({ isSpectator: true }))).toBe(false);
    expect(t.tutorialButtonVisible(seat({ isLazy: true }))).toBe(false);
    expect(t.tutorialButtonVisible(seat({ isSpectator: true, isLazy: true }))).toBe(false);
    expect(t.tutorialButtonVisible(seat({ position: null }))).toBe(false);
    expect(t.tutorialButtonVisible(null)).toBe(false);
  });
});

describe('tutorialButtonDisabled', () => {
  it('during the draw, and while a /tutorial line waits for the server', () => {
    expect(t.tutorialButtonDisabled(seat({ phase: 'draw' }))).toBe(true);
    expect(t.tutorialButtonDisabled(seat())).toBe(false);
    expect(t.tutorialButtonDisabled(seat({ phase: 'bidding' }))).toBe(false);
    expect(t.tutorialButtonDisabled(seat({ phase: 'bidding' }), { pending: true })).toBe(true);
  });
});

describe('tutorialNeedsConfirm (iOS TutorialRules.needsConfirm)', () => {
  beforeEach(() => resetAssistUses('g'));
  const table = (over = {}) => ({ gameId: 'g', nativeBotSeat: false, ...over });

  it('a human-only game not bot-assisted for me yet: asks', () => {
    expect(tutorialNeedsConfirm(table())).toBe(true);
    noteAssistUses({ uses: 2, freeUses: 3, assisted: false }, 'g');
    expect(tutorialNeedsConfirm(table())).toBe(true);
  });

  it('a game with a native bot seat: never (the table before the server says, then its unlimited)', () => {
    expect(tutorialNeedsConfirm(table({ nativeBotSeat: true }))).toBe(false);
    noteAssistUses({ uses: 0, freeUses: 3, assisted: false, unlimited: true }, 'g');
    expect(tutorialNeedsConfirm(table())).toBe(false);
  });

  it('the server already says bot-assisted for me (an assistState with no game id, a hint, viewer.assist): never', () => {
    noteAssistUses({ tutorial: false, uses: 0, freeUses: 3, assisted: true }, null);
    expect(tutorialNeedsConfirm(table())).toBe(false);
    // the next game starts again
    resetAssistUses('g2');
    expect(tutorialNeedsConfirm(table({ gameId: 'g2' }))).toBe(true);
  });

  it('unknown uses (an older server, a reload before its snapshot): asks, unless the table has a native bot seat', () => {
    forgetAssistUses();
    expect(tutorialNeedsConfirm(table())).toBe(true);
    expect(tutorialNeedsConfirm(table({ nativeBotSeat: true }))).toBe(false);
  });
});

describe('the words', () => {
  it('iOS\'s confirm exactly; the button\'s label and state; names only', () => {
    expect(t.TUTORIAL_ON_COMMAND).toBe('/tutorial on');
    expect(t.CONFIRM_TITLE).toBe('Turn on the tutorial?');
    expect(t.CONFIRM_MESSAGE).toBe("You'll get tips and advice on every turn. This game will count as bot-assisted for you: a win goes in your bot-game stats, a loss or tie stays in your human stats.");
    expect([t.CONFIRM_CANCEL, t.CONFIRM_BUTTON]).toEqual(['Cancel', 'Turn on']);
    expect([t.BUTTON_LABEL, t.BUTTON_ON_TEXT, t.BUTTON_OFF_TEXT]).toEqual(['Tutorial', 'Tutorial on', 'Tutorial off']);
    for (const w of [t.CONFIRM_TITLE, t.CONFIRM_MESSAGE, t.BUTTON_ON_TEXT, t.BUTTON_OFF_TEXT, t.BUTTON_ON_HINT, t.BUTTON_OFF_HINT]) expect(w).not.toMatch(NAME_LINT);
  });
});
