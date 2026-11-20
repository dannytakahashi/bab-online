import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showAssistCard, hideAssistCard, assistCardHint, syncAssistButton, resetAssistCard, showAssistTips } from './AssistCard.js';

const hint = (over = {}) => ({
  v: 1, source: 'help', kind: 'card', turnKey: '3|PLAYING|1|4|5', headline: 'Play 9♦',
  reasons: ['You and Bob bid 4 and have 1 so far.', 'The 9♦ is the lowest diamond that still follows.'],
  uses: 2, freeUses: 3, assisted: false, counted: true,
  details: ['Carol and Dan need 2 more.', 'A higher diamond wins nothing more.'], confidence: 'clear',
  suggest: { card: { suit: 'diamonds', rank: '9' } }, codes: ['F.low'],
  ...over,
});

const q = (sel) => document.querySelector(sel);

beforeEach(() => {
  resetAssistCard();
  document.body.innerHTML = '<div id="game-container"><div id="table-hud"></div></div>';
});

describe('the /help card', () => {
  it('shows the label, headline, up to 2 reasons, a closed Why? and the footer, in the HUD', () => {
    const card = showAssistCard(hint());
    expect(card.parentElement.id).toBe('table-hud');
    expect(card.getAttribute('role')).toBe('region');
    expect(card.getAttribute('aria-label')).toBe('Suggestion');
    // not a live region: the table's announcer says it (GameScene)
    expect(card.getAttribute('aria-live')).toBeNull();
    expect(q('.assist-card__chip').textContent).toBe('Clear choice');
    expect(q('.assist-card__head').textContent).toBe('Play 9♦');
    expect([...document.querySelectorAll('.assist-card__reasons li')].map((li) => li.textContent)).toEqual(hint().reasons);
    const toggle = q('.assist-card__why-toggle');
    const details = q('.assist-card__details');
    expect(toggle.textContent).toBe('Why?');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(details.id);
    expect(details.hidden).toBe(true);
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play · Help 2 of 3 free');
    expect(assistCardHint()).toEqual(hint());
  });

  it('Why? opens and closes the details', () => {
    showAssistCard(hint());
    const toggle = q('.assist-card__why-toggle');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(q('.assist-card__details').hidden).toBe(false);
    expect([...document.querySelectorAll('.assist-card__details li')].map((li) => li.textContent)).toEqual(hint().details);
    toggle.click();
    expect(q('.assist-card__details').hidden).toBe(true);
  });

  it('no Why? without details; the note (the last free use, the crossing) in its own line', () => {
    showAssistCard(hint({ details: [], uses: 3, note: "That's your 3rd free /help. The next one makes this game count as bot-assisted for you." }));
    expect(q('.assist-card__why')).toBeNull();
    expect(q('.assist-card__note').textContent).toMatch(/^That's your 3rd free \/help/);
  });

  it('the ✕ and Escape dismiss it and call onClose', () => {
    const onClose = vi.fn();
    showAssistCard(hint(), { onClose });
    const close = q('.assist-card__close');
    expect(close.getAttribute('aria-label')).toBe('Dismiss suggestion');
    close.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(q('.hud-assist').hidden).toBe(true);
    expect(assistCardHint()).toBeNull();

    showAssistCard(hint(), { onClose });
    q('.hud-assist').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(q('.hud-assist').hidden).toBe(true);
  });

  it('hide takes it down without the callback', () => {
    const onClose = vi.fn();
    showAssistCard(hint(), { onClose });
    hideAssistCard();
    expect(onClose).not.toHaveBeenCalled();
    expect(q('.hud-assist').hidden).toBe(true);
    expect(q('.hud-assist').childElementCount).toBe(0);
  });

  it('a newer answer replaces the one up (one card)', () => {
    showAssistCard(hint());
    showAssistCard(hint({ headline: 'Play K♣', confidence: 'close' }));
    expect(document.querySelectorAll('.hud-assist')).toHaveLength(1);
    expect(q('.assist-card__head').textContent).toBe('Play K♣');
    expect(q('.assist-card__chip').textContent).toBe('Close call');
  });

  it('a status reply is the headline alone (no chip, reasons, Why? or footer)', () => {
    showAssistCard({ v: 1, source: 'help', kind: 'status', turnKey: 'k', headline: 'Not your turn yet: Carol is bidding.', reasons: ['x'], uses: 0, freeUses: 3, assisted: false, counted: false });
    expect(q('.hud-assist').classList.contains('is-status')).toBe(true);
    expect(q('.assist-card__head').textContent).toBe('Not your turn yet: Carol is bidding.');
    expect(q('.assist-card__chip')).toBeNull();
    expect(q('.assist-card__reasons')).toBeNull();
    expect(q('.assist-card__foot')).toBeNull();
    expect(q('.assist-card__close')).not.toBeNull();
  });

  it('a forced move: "Only legal card", not counted', () => {
    showAssistCard(hint({ confidence: 'only', counted: false, details: [] }));
    expect(q('.assist-card__chip').textContent).toBe('Only legal card');
    expect(q('.assist-card__foot').textContent).toBe('Not counted');
  });

  it('a game with a native bot seat: the footer is just our strongest bot (hint or table), a forced move too', () => {
    showAssistCard(hint({ uses: 5, unlimited: true }));
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    showAssistCard(hint({ counted: false, unlimited: true }));
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    showAssistCard(hint({ confidence: 'only', counted: false, details: [] }), { unlimited: true });
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    // the table knows before the hint says (GameState.nativeBotSeat)
    showAssistCard(hint({ uses: 4, assisted: false }), { unlimited: true });
    expect(q('.assist-card__foot').textContent).toBe('What our strongest bot would play');
    expect(q('.hud-assist').textContent).not.toMatch(/free|unlimited|bot-assisted/i);
  });

  it('refuses what is not a hint', () => {
    expect(showAssistCard({ v: 1, kind: 'tip', headline: 'x' })).toBeNull();
    expect(q('.hud-assist')).toBeNull();
  });

  it('texts are text, never markup', () => {
    showAssistCard(hint({ headline: '<b>x</b>', reasons: ['<img src=x>'] }));
    expect(q('.assist-card__head').textContent).toBe('<b>x</b>');
    expect(q('.hud-assist img')).toBeNull();
  });

  it('never takes focus, but keeps it on the card across a replace and takes it from the "?"', () => {
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    showAssistCard(hint());
    expect(document.activeElement).toBe(other);

    q('.assist-card__close').focus();
    showAssistCard(hint({ headline: 'Play K♣' }));
    expect(document.activeElement).toBe(q('.assist-card__close'));

    hideAssistCard();
    const ask = syncAssistButton({ visible: true, onAsk: () => {} });
    ask.focus();
    showAssistCard(hint());
    expect(document.activeElement).toBe(q('.assist-card__close'));
  });
});

describe('the "?" button', () => {
  it('shows while asked to and sends through onAsk', () => {
    expect(syncAssistButton({ visible: false })).toBeNull();
    expect(q('.hud-assist-ask')).toBeNull();
    const onAsk = vi.fn();
    const btn = syncAssistButton({ visible: true, onAsk });
    expect(btn.parentElement.id).toBe('table-hud');
    expect(btn.getAttribute('aria-label')).toBe('Ask a bot for advice');
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(onAsk).toHaveBeenCalledTimes(1);
    syncAssistButton({ visible: false, onAsk });
    expect(btn.hidden).toBe(true);
    // one button, the newest callback
    const onAsk2 = vi.fn();
    syncAssistButton({ visible: true, onAsk: onAsk2 });
    expect(document.querySelectorAll('.hud-assist-ask')).toHaveLength(1);
    btn.click();
    expect(onAsk2).toHaveBeenCalledTimes(1);
  });

  it('a HUD cleared under it (a table teardown) gets a new one', () => {
    syncAssistButton({ visible: true });
    document.getElementById('table-hud').replaceChildren();
    const btn = syncAssistButton({ visible: true });
    expect(btn.isConnected).toBe(true);
  });
});

describe('the tutorial\'s tips on the card', () => {
  const tip = (over = {}) => ({
    v: 1, source: 'tutorial', kind: 'tip', turnKey: '1|BIDDING|1|1|0', headline: 'Trump',
    reasons: ['Trump this hand is hearts ♥.'], uses: 0, freeUses: 3, assisted: false, counted: false, tipId: 'T.trump', ...over,
  });
  const welcome = () => tip({ tipId: 'T.welcome', headline: 'Tutorial on', reasons: ['Tips will appear above your cards.'], actions: ['keep', 'off'] });
  const sections = () => [...document.querySelectorAll('.hud-assist .assist-tip')];

  it('a tip alone: a neutral section with its title, text and ✕; the card is labelled "Tutorial tip"', () => {
    const root = showAssistTips([tip()]);
    expect(root.hidden).toBe(false);
    expect(root.dataset.kind).toBe('tip');
    expect(root.dataset.place).toBe('hand');
    expect(root.getAttribute('aria-label')).toBe('Tutorial tip');
    expect(root.classList.contains('has-tip')).toBe(true);
    const sec = sections()[0];
    expect(sec.querySelector('.assist-tip__title').textContent).toBe('Trump');
    expect(sec.getAttribute('aria-labelledby')).toBe(sec.querySelector('.assist-tip__title').id);
    expect(sec.querySelector('.assist-tip__text').textContent).toBe('Trump this hand is hearts ♥.');
    expect(sec.querySelector('.assist-tip__close').getAttribute('aria-label')).toBe('Dismiss tip');
    expect(sec.querySelector('.assist-tip__actions')).toBeNull();
    // no advice parts
    expect(q('.assist-card__head')).toBeNull();
  });

  it('above the advice: the tips first, then the advice; hiding the advice keeps the tips', () => {
    showAssistTips([tip()]);
    showAssistCard(hint());
    const root = q('.hud-assist');
    expect(root.firstElementChild.classList.contains('assist-tip')).toBe(true);
    expect(root.querySelector('.assist-card__advice .assist-card__head').textContent).toBe('Play 9♦');
    expect(root.getAttribute('aria-label')).toBe('Suggestion');
    expect(root.dataset.kind).toBe('card');
    hideAssistCard();
    expect(root.hidden).toBe(false);
    expect(sections()).toHaveLength(1);
    expect(q('.assist-card__head')).toBeNull();
    // a new advice keeps them too
    showAssistCard(hint({ headline: 'Play K♣' }));
    expect(sections()).toHaveLength(1);
    showAssistTips([]);
    expect(sections()).toHaveLength(0);
    expect(q('.assist-card__head').textContent).toBe('Play K♣');
    hideAssistCard();
    expect(root.hidden).toBe(true);
  });

  it('a bid answer, or tips alone on my bid turn, sit above the bid sheet', () => {
    showAssistTips([tip()], { place: 'bid' });
    expect(q('.hud-assist').dataset.place).toBe('bid');
    showAssistCard(hint({ kind: 'card' }));
    expect(q('.hud-assist').dataset.place).toBe('hand');
    showAssistCard(hint({ kind: 'bid', headline: 'Bid 3', suggest: { bid: '3' } }));
    expect(q('.hud-assist').dataset.place).toBe('bid');
  });

  it('the welcome\'s Keep / Turn off and the ✕ call back with the tip', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const w = welcome();
    showAssistTips([w, tip()], { onAction, onClose });
    expect(sections().map((s) => s.dataset.tipId)).toEqual(['T.welcome', 'T.trump']);
    const buttons = [...sections()[0].querySelectorAll('.assist-tip__action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Keep', 'Turn off']);
    buttons[0].click();
    buttons[1].click();
    expect(onAction.mock.calls).toEqual([[w, 'keep'], [w, 'off']]);
    sections()[1].querySelector('.assist-tip__close').click();
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ tipId: 'T.trump' }));
  });

  it('without callbacks a ✕ or a button just takes that tip down', () => {
    showAssistTips([welcome(), tip()]);
    sections()[1].querySelector('.assist-tip__close').click();
    expect(sections().map((s) => s.dataset.tipId)).toEqual(['T.welcome']);
    sections()[0].querySelector('.assist-tip__action').click();
    expect(q('.hud-assist').hidden).toBe(true);
  });

  it('Escape closes the whole card: the advice and each tip', () => {
    const onClose = vi.fn();
    const onTip = vi.fn();
    showAssistTips([tip()], { onClose: onTip });
    showAssistCard(hint(), { onClose });
    q('.hud-assist').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onTip).toHaveBeenCalledTimes(1);
  });

  it('at most two tips; never what is not a tip; texts are text', () => {
    showAssistTips([tip({ headline: 'a' }), tip({ headline: 'b' }), tip({ headline: '<b>c</b>' }), { kind: 'tip', headline: 'x' }]);
    expect(sections().map((s) => s.querySelector('.assist-tip__title').textContent)).toEqual(['b', '<b>c</b>']);
    expect(q('.hud-assist b')).toBeNull();
  });

  it('never takes focus; a tip drawn while focus is in the card keeps it there', () => {
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    showAssistTips([tip()]);
    expect(document.activeElement).toBe(other);
    showAssistCard(hint());
    q('.assist-card__close').focus();
    showAssistTips([tip({ headline: 'Leading' })]);
    expect(document.activeElement).toBe(q('.assist-card__close'));
  });
});
