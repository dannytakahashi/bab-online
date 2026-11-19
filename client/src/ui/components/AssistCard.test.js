import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showAssistCard, hideAssistCard, assistCardHint, syncAssistButton, resetAssistCard } from './AssistCard.js';

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
    expect(btn.getAttribute('aria-label')).toBe('Suggest a move');
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
