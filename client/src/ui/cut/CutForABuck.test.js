/**
 * Cut for a buck's view (ui/cut/CutForABuck.js): a click on the deck sends
 * {round, slot}, the keyboard draws, the cards flip together, the out
 * players dim after the verdict, a redraw keeps everyone, a reshuffle sends
 * the cards back, the winner, the intro (and its reduced-motion variant),
 * spectators, the list view, speaking rings, the sounds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCutView, fanGeometry, fanIndexAt, fanAngle, freeSlots, TIMING, isCutShowing } from './CutForABuck.js';
import { cutReduce, cutFromWire, STAGE } from '../../state/cutForABuck.js';
import { setReducedMotionOverride } from '../motion.js';

function fakeSocket() {
  const sent = [];
  return { sent, emit: vi.fn((event, data) => sent.push([event, data])), emitted: (e) => sent.filter(([n]) => n === e).map(([, d]) => d) };
}
function fakeSound() {
  const played = [];
  const sound = { played, muted: false, play: vi.fn((name) => { played.push(name); return true; }), toggleMuted() {}, onChange: () => () => {} };
  return sound;
}

const PLAYERS = ['al', 'me', 'bo', 'cy'];
const players = PLAYERS.map((username) => ({ username, pic: 3, connected: true }));
const T0 = 1_000_000;

function started(now = T0) {
  return cutReduce(null, 'start', { candidates: PLAYERS, startsInMs: 15000, deckCount: 54 }, now);
}
function round(s, n = 1, { deckCount = 54, reshuffled = false, alive = PLAYERS } = {}) {
  return cutReduce(s, 'round', { round: n, participants: PLAYERS, alive, deckCount, reshuffled, closesInMs: 15000 }, T0);
}
const card = (rank, suit = 'clubs') => ({ suit, rank });

let clock;
let socket;
let sound;
let view;

function mount(opts = {}) {
  view = createCutView({ me: 'me', socket, players, sound, now: () => clock, ...opts });
  document.body.appendChild(view.element);
  return view;
}
const seatEl = (u) => view.element.querySelector(`.cut-seat[data-username="${u}"]`);

beforeEach(() => {
  vi.useFakeTimers();
  clock = T0;
  socket = fakeSocket();
  sound = fakeSound();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  setReducedMotionOverride(false);
});

afterEach(() => {
  view?.destroy();
  view = null;
  setReducedMotionOverride(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('the ring', () => {
  it('me first in reading order (6 o\'clock), then clockwise; "you" for me; a list of players', () => {
    mount();
    view.update(round(started()));
    const ring = view.element.querySelector('.cut-ring');
    expect(ring.getAttribute('role')).toBe('list');
    expect([...ring.children].map((c) => c.dataset.username)).toEqual(['me', 'bo', 'cy', 'al']);
    expect(seatEl('me').querySelector('.cut-seat__name').textContent).toBe('you');
    expect(seatEl('al').getAttribute('aria-label')).toBe('al, still to draw');
    expect(isCutShowing()).toBe(true);
  });

  it('the round line, the deck caption, the status', () => {
    mount();
    view.update(round(started()));
    expect(view.element.querySelector('#cutRoundLine').textContent).toBe('Round 1 · 4 of 4 left');
    expect(view.element.querySelector('#cutDeckCaption').textContent).toBe('54 cards left');
    expect(view.element.querySelector('#cutStatus').textContent).toBe('Click the deck to draw');
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('Auto-draw in 15');
    clock += 8000;
    vi.advanceTimersByTime(300);
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('Auto-draw in 7');
  });

  it('the reminder sound 5 s before my auto-draw, once', () => {
    mount();
    view.update(round(started()));
    clock += 10_500;
    vi.advanceTimersByTime(500);
    clock += 1000;
    vi.advanceTimersByTime(500);
    expect(sound.played.filter((n) => n === 'turn')).toHaveLength(1);
  });
});

describe('drawing', () => {
  it('a click on the deck sends {round, slot} of the card under the pointer, once', () => {
    mount();
    const s = round(started(), 3, { deckCount: 40 });
    view.update(s);
    const deck = view.element.querySelector('#cutDeck');
    expect(deck.tagName).toBe('BUTTON');
    expect(deck.getAttribute('aria-label')).toBe('Draw a card');
    view.drawFree(5);
    expect(socket.emitted('cutForABuckDraw')).toEqual([{ round: 3, slot: 5 }]);
    expect(sound.played).toContain('draw');
    // a second click draws nothing
    deck.click();
    view.drawFree(2);
    expect(socket.emitted('cutForABuckDraw')).toHaveLength(1);
    // my card shows face down at once; the status waits for the others
    expect(view.element.querySelector('#cutStatus').textContent).toBe('Waiting for al, bo and cy');
  });

  it('the keyboard: Enter (a click with no pointer) draws a random card (slot null), arrows pick one', () => {
    mount();
    view.update(round(started()));
    const deck = view.element.querySelector('#cutDeck');
    deck.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    deck.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    const sent = socket.emitted('cutForABuckDraw');
    expect(sent).toHaveLength(1);
    expect(Number.isInteger(sent[0].slot)).toBe(true);
    view.destroy();
    socket = fakeSocket();
    mount();
    view.update(round(started()));
    view.element.querySelector('#cutDeck').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(socket.emitted('cutForABuckDraw')).toEqual([{ round: 1, slot: null }]);
  });

  it('no draw for a player who is out, nor before the round opens', () => {
    mount();
    view.update(started());
    view.drawFree(0);
    let s = round(started(), 2, { alive: ['al', 'bo', 'cy'] });
    s = { ...s, out: { me: { round: 1 } } };
    view.update(s);
    view.drawFree(0);
    expect(socket.emitted('cutForABuckDraw')).toEqual([]);
    expect(view.element.querySelector('#cutStatus').textContent).toBe("You're out. Watching the rest");
  });

  it('drawn for at the open (away): a tap still goes out once, so the server waits for me next round', () => {
    mount();
    let s = round(started(), 3);
    s = cutReduce(s, 'drew', { round: 3, username: 'me', slot: 0, auto: true }, T0);
    view.update(s);
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('We drew a card for you');
    const deck = view.element.querySelector('#cutDeck');
    deck.click();
    expect(socket.emitted('cutForABuckDraw')).toEqual([{ round: 3, slot: null }]);
    // once a round; no draw sound, my card stays the server's
    deck.click();
    view.drawFree(2);
    expect(socket.emitted('cutForABuckDraw')).toHaveLength(1);
    expect(sound.played).not.toContain('draw');
    expect(view.getState().drawn.me).toEqual({ slot: 0, auto: true });
    // the list view's button does the same
    view.destroy();
    socket = fakeSocket();
    mount();
    view.update(s);
    view.element.querySelector('[data-view="list"]').click();
    const draw = view.element.querySelector('#cutListDraw');
    expect(draw.disabled).toBe(false);
    draw.click();
    expect(socket.emitted('cutForABuckDraw')).toEqual([{ round: 3, slot: null }]);
    expect(view.element.querySelector('#cutListDraw').disabled).toBe(true);
    // my own draw (not the server's): nothing more to send
    view.destroy();
    socket = fakeSocket();
    mount();
    view.update(cutReduce(round(started(), 4), 'drew', { round: 4, username: 'me', slot: 1, auto: false }, T0));
    view.element.querySelector('#cutDeck').click();
    expect(socket.emitted('cutForABuckDraw')).toEqual([]);
  });

  it('another player\'s draw: a back flies to them; never a card', () => {
    mount();
    let s = round(started());
    view.update(s);
    s = cutReduce(s, 'drew', { round: 1, username: 'bo', slot: 7, auto: false }, T0);
    view.update(s);
    expect(seatEl('bo').getAttribute('aria-label')).toBe('bo, drawn');
    s = cutReduce(s, 'drew', { round: 1, username: 'cy', slot: 9, auto: true }, T0);
    view.update(s);
    expect(seatEl('cy').querySelector('.cut-seat__caption').textContent).toBe('auto');
    expect(view.element.querySelectorAll('.cut-card').length).toBe(2);
    expect(view.element.querySelectorAll('.cut-card.is-face').length).toBe(0);
  });
});

function revealRound(s, n, pairs, { eliminated, redraw = false, alive }) {
  for (const [u] of pairs) s = cutReduce(s, 'drew', { round: n, username: u, slot: pairs.findIndex((p) => p[0] === u), auto: false }, T0);
  return { drawn: s, revealed: cutReduce(s, 'reveal', { round: n, draws: pairs.map(([username, c], i) => ({ username, slot: i, card: c })), eliminated, redraw, alive, nextInMs: 4000 }, T0) };
}

describe('the reveal', () => {
  it('flips every card together (staggered), then the verdict at +1.2 s: the out players dim, the losing card outlined', () => {
    mount();
    const { drawn, revealed } = revealRound(round(started()), 1, [['al', card('9')], ['me', card('K')], ['bo', card('3')], ['cy', card('3', 'hearts')]], { eliminated: ['bo', 'cy'], alive: ['al', 'me'] });
    view.update(drawn);
    vi.advanceTimersByTime(20);
    view.update(revealed);
    vi.advanceTimersByTime(20);
    const flipping = [...view.element.querySelectorAll('.cut-card.is-flipping')];
    expect(flipping).toHaveLength(4);
    // the draws' order (the server's participant order), 40 ms apart
    expect(flipping.map((c) => c.style.getPropertyValue('--flip-delay')).sort()).toEqual(['300ms', '340ms', '380ms', '420ms']);
    expect(sound.played).toContain('card');
    // before the verdict nobody looks out
    expect(seatEl('bo').classList.contains('is-out')).toBe(false);
    expect(view.element.querySelector('#cutStatus').textContent).toBe('Turning the cards over');
    // the list view waits for the verdict too
    view.element.querySelector('[data-view="list"]').click();
    const row = (u) => view.element.querySelector(`.cut-list__row[data-username="${u}"]`);
    expect(row('bo').classList.contains('is-out')).toBe(false);
    expect(row('bo').querySelector('.cut-list__status').textContent).toBe('');
    vi.advanceTimersByTime(TIMING.verdict);
    expect(row('bo').classList.contains('is-out')).toBe(true);
    expect(row('bo').querySelector('.cut-list__status').textContent).toBe('Out · round 1');
    view.element.querySelector('[data-view="ring"]').click();
    expect(seatEl('bo').classList.contains('is-out')).toBe(true);
    expect(seatEl('cy').classList.contains('is-out')).toBe(true);
    expect(seatEl('bo').querySelector('.cut-seat__caption').textContent).toBe('Out · round 1');
    expect(seatEl('al').classList.contains('is-out')).toBe(false);
    expect(view.element.querySelectorAll('.cut-card.is-losing')).toHaveLength(2);
    expect(view.element.querySelector('#cutStatus').textContent).toBe("You're safe with a king");
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('bo and cy are out with 3s');
    expect(sound.played).toContain('set');
    expect(view.element.querySelector('#cutLive').textContent).toBe("Round 1: al 9 of clubs, you king of clubs, bo 3 of clubs, cy 3 of hearts. You're safe with a king. bo and cy are out with 3s.");
  });

  it('I am out: the sad sound and my verdict', () => {
    mount();
    const { drawn, revealed } = revealRound(round(started()), 1, [['al', card('9')], ['me', card('2')], ['bo', card('5')], ['cy', card('A')]], { eliminated: ['me'], alive: ['al', 'bo', 'cy'] });
    view.update(drawn);
    view.update(revealed);
    vi.advanceTimersByTime(TIMING.verdict);
    expect(sound.played).toContain('gameend-lose');
    expect(view.element.querySelector('#cutStatus').textContent).toBe("You're out with a 2");
  });

  it('a redraw keeps everyone in; the next round rings them again', () => {
    mount();
    const { drawn, revealed } = revealRound(round(started()), 1, [['al', card('7')], ['me', card('7', 'hearts')], ['bo', card('7', 'spades')], ['cy', card('7', 'diamonds')]], { eliminated: [], redraw: true, alive: PLAYERS });
    view.update(drawn);
    view.update(revealed);
    vi.advanceTimersByTime(TIMING.verdict);
    expect(view.element.querySelectorAll('.cut-seat.is-out')).toHaveLength(0);
    expect(view.element.querySelector('#cutStatus').textContent).toBe('Everyone tied on 7s. Redraw!');
    view.update(round(revealed, 2, { deckCount: 50 }));
    expect(view.element.querySelectorAll('.cut-seat.is-waiting')).toHaveLength(4);
    // the old cards stay on the table (no reshuffle): one face each
    expect(view.element.querySelectorAll('.cut-card.is-face')).toHaveLength(4);
  });

  it('a reshuffle sends the table\'s cards back to the deck', () => {
    mount();
    const { drawn, revealed } = revealRound(round(started(), 1, { deckCount: 5 }), 1, [['al', card('7')], ['me', card('8')], ['bo', card('9')], ['cy', card('10')]], { eliminated: ['al'], alive: ['me', 'bo', 'cy'] });
    view.update(drawn);
    view.update(revealed);
    vi.advanceTimersByTime(TIMING.verdict);
    expect(view.element.querySelectorAll('.cut-card')).toHaveLength(4);
    view.update(round(revealed, 2, { deckCount: 54, reshuffled: true, alive: ['me', 'bo', 'cy'] }));
    vi.advanceTimersByTime(TIMING.flight + 300);
    expect(view.element.querySelectorAll('.cut-card')).toHaveLength(0);
    expect(view.element.querySelector('#cutLive').textContent).toBe('Not enough cards left. Shuffling them back in.');
  });

  it('older cards: up to 3 behind the newest, then "+n"', () => {
    mount();
    let s = round(started());
    s = { ...s, table: { me: [card('2'), card('3'), card('4'), card('5'), card('6'), card('7')] } };
    view.update(s);
    const shown = [...view.element.querySelectorAll('.cut-card')].filter((c) => !c.hidden);
    expect(shown).toHaveLength(4);
    expect(view.element.querySelector('.cut-seat__more:not([hidden])').textContent).toBe('+2');
  });
});

describe('the winner', () => {
  it('glides to the centre with the buck; the winner sound for the winner, the end sound for the others', () => {
    mount();
    let s = round(started(), 4, { alive: ['me', 'bo'] });
    const { drawn, revealed } = revealRound(s, 4, [['me', card('A')], ['bo', card('4')]], { eliminated: ['bo'], alive: ['me'] });
    view.update(drawn);
    view.update(revealed);
    s = cutReduce(revealed, 'winner', { winner: 'me', participants: PLAYERS, rounds: 4 }, T0);
    view.update(s);
    expect(view.element.querySelector('#cutWinner')).toBeNull();
    vi.advanceTimersByTime(TIMING.verdict);
    const w = view.element.querySelector('#cutWinner');
    expect(w.querySelector('.cut-winner__line').textContent).toBe('You win cut for a buck!');
    expect(w.querySelector('.cut-winner__sub')).toBeNull();
    expect(w.textContent).not.toMatch(/bragging/i);
    expect(w.querySelector('.cut-winner__buck svg')).not.toBeNull();
    expect(sound.played).toContain('gameend-win');
    expect(view.element.querySelector('#cutLiveWinner').textContent).toBe('You win cut for a buck!');
    expect(seatEl('me').classList.contains('is-winner')).toBe(true);
  });

  it('another winner: the end sound', () => {
    mount();
    const s = cutReduce(round(started(), 4, { alive: ['al', 'bo'] }), 'winner', { winner: 'al', participants: PLAYERS, rounds: 4 }, T0);
    view.update(s);
    expect(view.element.querySelector('.cut-winner__line').textContent).toBe('al wins cut for a buck!');
    expect(sound.played).toContain('gameend');
  });
});

describe('the intro', () => {
  it('"Cut for a buck!", the deck riffle and the avatars sliding in, gone in under 3 s', () => {
    mount();
    view.update(started(), { intro: true });
    expect(view.element.classList.contains('is-intro')).toBe(true);
    expect(view.element.querySelector('.cut-intro__title').textContent).toBe('Cut for a buck!');
    expect(view.element.querySelectorAll('.cut-seat.is-entering')).toHaveLength(4);
    expect(seatEl('bo').style.getPropertyValue('--i')).toBe('1');
    expect(TIMING.intro).toBeLessThan(3000);
    vi.advanceTimersByTime(TIMING.intro);
    expect(view.element.classList.contains('is-intro')).toBe(false);
    expect(view.element.querySelector('.cut-intro')).toBeNull();
    expect(view.element.querySelectorAll('.cut-seat.is-entering')).toHaveLength(0);
  });

  it('reduced motion: crossfades only (no sliding seats), the verdict sooner', () => {
    setReducedMotionOverride(true);
    mount();
    view.update(started(), { intro: true });
    expect(view.element.classList.contains('is-intro-reduced')).toBe(true);
    expect(view.element.querySelectorAll('.cut-seat.is-entering')).toHaveLength(0);
    vi.advanceTimersByTime(TIMING.intro);
    const { drawn, revealed } = revealRound(round(started()), 1, [['al', card('9')], ['me', card('K')], ['bo', card('3')], ['cy', card('Q')]], { eliminated: ['bo'], alive: ['al', 'me', 'cy'] });
    view.update(drawn);
    view.update(revealed);
    expect(view.element.querySelectorAll('.cut-card.is-flipping')).toHaveLength(0);
    vi.advanceTimersByTime(TIMING.reducedVerdict);
    expect(seatEl('bo').classList.contains('is-out')).toBe(true);
  });

  it('the gather\'s countdown', () => {
    mount();
    view.update(started());
    expect(view.element.querySelector('#cutStatus').textContent).toBe('Cut for a buck starts in 15');
  });
});

describe('spectators, restore, list, voice', () => {
  it('a spectator: the deck is not a button, "Watching cut for a buck", the ring in the players\' order', () => {
    mount({ me: 'zed', spectator: true });
    view.update(round(started()));
    expect(view.element.querySelector('#cutDeck').tagName).toBe('DIV');
    expect(view.element.querySelector('#cutStatus').textContent).toBe('Watching cut for a buck');
    expect([...view.element.querySelector('.cut-ring').children].map((c) => c.dataset.username)).toEqual(PLAYERS);
    view.drawFree(0);
    expect(socket.emitted('cutForABuckDraw')).toEqual([]);
  });

  it('a player who is out keeps watching every later round live, like a spectator, to the winner', () => {
    // owner 2026-11-25: out in round 1, me still sees round 2's draws,
    // flips and eliminations, then round 3 and the winner
    mount();
    let { revealed: s } = revealRound(round(started()), 1, [['al', card('9')], ['me', card('3')], ['bo', card('K')], ['cy', card('Q')]], { eliminated: ['me'], alive: ['al', 'bo', 'cy'] });
    view.update(s);
    vi.advanceTimersByTime(TIMING.verdict);
    expect(view.element.querySelector('#cutStatus').textContent).toBe("You're out with a 3");
    expect(seatEl('me').classList.contains('is-out')).toBe(true);
    // round 2 opens: the stage stays, the deck is not mine to draw
    s = round(s, 2, { alive: ['al', 'bo', 'cy'], deckCount: 50 });
    view.update(s);
    expect(view.element.querySelector('#cutStage').hidden).toBe(false);
    expect(view.element.querySelector('#cutStatus').textContent).toBe("You're out. Watching the rest");
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('Waiting for al, bo and cy');
    expect(view.element.querySelector('#cutRoundLine').textContent).toBe('Round 2 · 3 of 4 left');
    view.drawFree(0);
    expect(socket.emitted('cutForABuckDraw')).toEqual([]);
    // their draws come in one by one, face down
    s = cutReduce(s, 'drew', { round: 2, username: 'al', slot: 0, auto: false }, T0);
    view.update(s);
    expect(seatEl('al').getAttribute('aria-label')).toMatch(/^al, drawn/);
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('Waiting for bo and cy');
    s = cutReduce(s, 'drew', { round: 2, username: 'bo', slot: 1, auto: false }, T0);
    s = cutReduce(s, 'drew', { round: 2, username: 'cy', slot: 2, auto: true }, T0);
    view.update(s);
    // the flip and the verdict (al out)
    s = cutReduce(s, 'reveal', { round: 2, draws: [{ username: 'al', slot: 0, card: card('5') }, { username: 'bo', slot: 1, card: card('J') }, { username: 'cy', slot: 2, card: card('8') }], eliminated: ['al'], redraw: false, alive: ['bo', 'cy'], nextInMs: 4000 }, T0);
    view.update(s);
    expect(view.element.querySelectorAll('.cut-card.is-flipping').length).toBeGreaterThan(0);
    vi.advanceTimersByTime(TIMING.verdict);
    expect(view.element.querySelector('#cutStatus').textContent).toBe('al is out with a 5');
    expect(seatEl('al').classList.contains('is-out')).toBe(true);
    expect(seatEl('al').querySelector('.cut-seat__caption').textContent).toBe('Out · round 2');
    // round 3 and the winner
    s = round(s, 3, { alive: ['bo', 'cy'], deckCount: 47 });
    view.update(s);
    expect(view.element.querySelector('#cutStatusSub').textContent).toBe('Waiting for bo and cy');
    s = cutReduce(s, 'drew', { round: 3, username: 'bo', slot: 0, auto: false }, T0);
    s = cutReduce(s, 'drew', { round: 3, username: 'cy', slot: 1, auto: false }, T0);
    s = cutReduce(s, 'reveal', { round: 3, draws: [{ username: 'bo', slot: 0, card: card('A') }, { username: 'cy', slot: 1, card: card('2') }], eliminated: ['cy'], redraw: false, alive: ['bo'], nextInMs: 6000 }, T0);
    view.update(s);
    s = cutReduce(s, 'winner', { winner: 'bo', participants: PLAYERS, rounds: 3 }, T0);
    view.update(s);
    vi.advanceTimersByTime(TIMING.verdict);
    expect(view.element.querySelector('.cut-winner__line').textContent).toBe('bo wins cut for a buck!');
    expect(seatEl('bo').classList.contains('is-winner')).toBe(true);
    expect(seatEl('cy').querySelector('.cut-seat__caption').textContent).toBe('Out · round 3');
    expect(sound.played).toContain('gameend');
  });

  it('a static render from tournamentJoined.cut: faces already up, out players dim, no sounds', () => {
    mount();
    const s = cutFromWire({ stage: 'drawing', inMs: 9000, round: 3, participants: PLAYERS, alive: ['me', 'al'], out: [{ username: 'bo', round: 2 }, { username: 'cy', round: 1, left: true }], table: [{ username: 'me', cards: [card('9')] }, { username: 'bo', cards: [card('3')] }], drawn: [{ username: 'al', slot: 4 }], deckCount: 50 }, clock);
    view.update(s);
    expect(view.element.querySelectorAll('.cut-card.is-face.no-anim')).toHaveLength(2);
    expect(seatEl('bo').classList.contains('is-out')).toBe(true);
    expect(seatEl('cy').querySelector('.cut-seat__caption').textContent).toBe('Left');
    expect(seatEl('al').getAttribute('aria-label')).toBe('al, drawn');
    expect(sound.played).toEqual([]);
  });

  it('Ring | List: the list rows, in ring order', () => {
    mount();
    view.update(round(started()));
    const list = view.element.querySelector('[data-view="list"]');
    list.click();
    expect(view.element.dataset.view).toBe('list');
    expect(view.element.querySelector('#cutStage').hidden).toBe(true);
    const rows = [...view.element.querySelectorAll('.cut-list__row')];
    expect(rows.map((r) => r.dataset.username)).toEqual(['me', 'bo', 'cy', 'al']);
    expect(rows[0].querySelector('.cut-list__name').textContent).toBe('you');
    // the list has no deck: its own Draw a card (a random card)
    const draw = view.element.querySelector('#cutListDraw');
    expect(draw.hidden).toBe(false);
    draw.click();
    expect(socket.emitted('cutForABuckDraw')).toEqual([{ round: 1, slot: null }]);
    expect(view.element.querySelector('#cutListDraw').disabled).toBe(true);
    view.element.querySelector('[data-view="ring"]').click();
    expect(view.element.querySelector('#cutStage').hidden).toBe(false);
  });

  it('speaking rings by username, and a disconnected player', () => {
    mount();
    view.update(round(started()));
    view.setTalking('bo', true);
    expect(seatEl('bo').classList.contains('is-talking')).toBe(true);
    expect(seatEl('bo').getAttribute('aria-label')).toBe('bo, still to draw, talking');
    view.setPlayers(players.map((p) => (p.username === 'cy' ? { ...p, connected: false } : p)));
    expect(seatEl('cy').classList.contains('is-disconnected')).toBe(true);
    expect(seatEl('cy').querySelector('.cut-seat__caption').textContent).toBe('reconnecting…');
  });

  it('an avatar\'s popover: the cards this deck and View Profile', () => {
    const onViewProfile = vi.fn();
    mount({ onViewProfile });
    view.update({ ...round(started()), table: { bo: [card('9', 'hearts'), card('3', 'spades')] } });
    seatEl('bo').querySelector('.cut-seat__avatar').click();
    const pop = view.element.querySelector('.cut-popover');
    expect(pop.hidden).toBe(false);
    expect(pop.textContent).toContain('Cards this deck: 9♥, 3♠');
    [...pop.querySelectorAll('button')].find((b) => b.textContent === 'View Profile').click();
    expect(onViewProfile).toHaveBeenCalledWith('bo');
    expect(pop.hidden).toBe(true);
  });

  it('Leave', () => {
    mount();
    view.update(round(started()));
    view.element.querySelector('#cutLeaveBtn').click();
    expect(socket.emitted('leaveTournament')).toHaveLength(1);
  });
});

describe('the fan', () => {
  it('narrows as the deck empties and maps a point to the nearest card', () => {
    const full = fanGeometry(200, 120, 54, 54);
    const few = fanGeometry(200, 120, 10, 54);
    expect(full.half).toBeCloseTo((50 * Math.PI) / 180, 6);
    expect(few.half).toBeLessThan(full.half);
    // the pointer straight above the pivot: the middle card
    expect(fanIndexAt(full.px, 10, full, 54)).toBe(Math.round(53 / 2));
    // far left / right: the ends
    expect(fanIndexAt(0, full.py - 10, full, 54)).toBe(0);
    expect(fanIndexAt(200, full.py - 10, full, 54)).toBe(53);
    expect(fanAngle(0, 54, full.half)).toBeCloseTo(-full.half, 6);
  });

  it('free slots skip the drawn ones during a round', () => {
    let s = round(started(), 1, { deckCount: 6 });
    s = cutReduce(s, 'drew', { round: 1, username: 'al', slot: 2, auto: false }, T0);
    expect(freeSlots(s)).toEqual([0, 1, 3, 4, 5]);
    expect(STAGE.DRAWING).toBe('drawing');
  });
});
