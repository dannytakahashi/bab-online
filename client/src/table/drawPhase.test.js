/**
 * The draw for deal on the real page (GameScene, DrawManager and the HUD
 * on testing/fakePhaser.js), as iOS DrawPhaseView shows it (PR 239):
 *
 *   - startDraw: the HUD's column (title, rule, four waiting slots, the
 *     prompt and a "Draw a card" button) over 54 pickable backs, each
 *     drawn where the layout says;
 *   - my click: the card I clicked is the one that flies to MY slot, even
 *     when another player's draw comes in first; the deck and the prompt
 *     close; each slot names its player (mine in primary) and drops its
 *     placeholder, its card face up in it at the hand card's size;
 *   - the auto-draw (youDrew without a click) and the keyboard button close
 *     the deck too, and the button draws once;
 *   - a render mid-draw (a rejoin) draws the same draw from GameState;
 *   - the teams: a panel with each team's avatars (the seats' pictures)
 *     and names, mine marked; the deck fades out, the drawn cards stay;
 *   - reduced motion: the card is in its slot at once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DRAW_SLOTS_KEY, slotFrame, drawSlotFaces } from '../phaser/cards/drawSlotFaces.js';

vi.mock('../vendor.js', () => ({}));
vi.mock('../socket/createSocket.js', () => ({ createSocket: () => globalThis.__fakeSocket }));
vi.mock('../voice/VoiceChatManager.js', () => ({ getVoiceChatManager: () => globalThis.__fakeVoice }));

const ME = 'ios_ann';
let page;
let replay;
let layoutMod;
let motion;
let hudMod;

const hud = () => document.getElementById('table-hud');
const draw = () => hud().querySelector(':scope > .hud-draw');
const slots = () => [...draw().querySelectorAll('.hud-draw__slot')];
const names = () => slots().map((s) => s.querySelector('.hud-draw__name').textContent);
const dm = () => page.scene.drawManager;
const L = () => page.scene.getLayout();
const near = (a, b, label) => expect(Math.abs(a - b), `${label}: ${a} vs ${b}`).toBeLessThan(0.01);
function expectRect(b, r, label) {
  near(b.x, r.x, `${label} x`);
  near(b.y, r.y, `${label} y`);
  near(b.width, r.w, `${label} w`);
  near(b.height, r.h, `${label} h`);
}
const card = (suit, rank) => ({ suit, rank });
const status = () => draw().querySelector('.hud-draw__status');
// a drawn card shows its face from the draw's own frame for its slot
function expectFace(c, faceKey) {
  const i = c.getData('drawOrder') - 1;
  expect([c.texture.key, c.frame.name]).toEqual([DRAW_SLOTS_KEY, slotFrame(i)]);
  expect(c.getData('faceKey')).toBe(faceKey);
  expect(drawSlotFaces(page.scene.textures).faces[i]).toBe(faceKey);
}
const drew = (username, order, c) => page.socket.fire('playerDrew', { username, card: c, drawOrder: order, socketId: `s-${order}` });
const startDraw = () => {
  page.socket.fire('startDraw', { start: true });
  replay.advance(50);
};

beforeAll(async () => {
  replay = await import('../testing/replay.js');
  layoutMod = await import('../phaser/layout/computeTableLayout.js');
  motion = await import('../ui/motion.js');
  hudMod = await import('../ui/drawHud.js');
  page = await replay.realTablePage({ username: ME, socketId: 'ios-h1' });
  page.socket.fire('allPlayersReady', {});
});

afterAll(() => {
  motion.setReducedMotionOverride(null);
  vi.useRealTimers();
});

describe('the draw for deal (iOS DrawPhaseView\'s structure)', () => {
  it('startDraw: title, rule, four waiting slots, the prompt and a Draw a card button over 54 pickable backs', () => {
    startDraw();
    replay.advance(1000); // the deck flies in
    expect(draw()).toBeTruthy();
    expect(draw().querySelector('.hud-draw__title').textContent).toBe('Draw for Deal');
    expect(draw().querySelector('.hud-draw__rules').textContent).toBe('The two highest cards are partners; the highest deals.');
    expect(slots().map((s) => s.dataset.state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
    expect(names()).toEqual(['Waiting', 'Waiting', 'Waiting', 'Waiting']);
    expect(slots().every((s) => s.querySelector('.hud-draw__avatar.is-empty'))).toBe(true);
    expect(draw().querySelector('.hud-draw__prompt').textContent).toBe('Click a card to draw');
    expect(draw().querySelector('button.hud-draw__key').textContent).toBe('Draw a card');
    // the HUD's places are the layout's
    const v = (k) => parseFloat(hud().style.getPropertyValue(k));
    const d = L().draw;
    expect(v('--draw-title-y')).toBeCloseTo(d.title.y, 1);
    expect(v('--draw-av-y')).toBeCloseTo(d.avatar.y, 1);
    expect(v('--draw-card-y')).toBeCloseTo(d.slots[0].y, 1);
    expect(v('--draw-prompt-y')).toBeCloseTo(d.prompt.y, 1);
    // 54 backs, each a button, each drawn at its deck spot
    const deck = dm().deckCards();
    expect(deck).toHaveLength(54);
    for (const { card: c } of deck) {
      expect(c.interactive).toBe(true);
      const p = layoutMod.deckPosition(L(), c.getData('deckIndex'));
      expectRect(c.getBounds(), { x: p.x - d.deck.card.w / 2, y: p.y - d.deck.card.h / 2, w: d.deck.card.w, h: d.deck.card.h }, `deck ${c.getData('deckIndex')}`);
    }
  });

  it('my click: my card flies to MY slot even when another draw comes first; the deck and prompt close; slots name their players', () => {
    const d = L().draw;
    const p = layoutMod.deckPosition(L(), 30);
    page.socket.clearEmits();
    page.scene.pointerDownAt(p.x - d.deck.card.w / 2 + d.deck.overlap / 2, p.y);
    expect(page.socket.emitted('draw')).toHaveLength(1);
    const mine = dm().clickedCardSprite;
    expect(mine.getData('deckIndex')).toBe(30);
    expect(draw().classList.contains('has-drawn')).toBe(true);
    expect(draw().querySelector('.hud-draw__key')).toBeNull();
    expect(dm().deckCards().some(({ card: c }) => c.interactive)).toBe(false);

    // a bot's draw lands before mine: another card flies, not the one I clicked
    drew('🤖 Mary', 1, card('hearts', 'K'));
    expect(dm().drawnCards()).toHaveLength(1);
    expect(dm().drawnCards()[0]).not.toBe(mine);
    // the slot names Mary at once, its placeholder stays while the card is on its way
    expect(slots()[0].dataset.state).toBe('drawn');
    expect(slots()[0].classList.contains('has-card')).toBe(false);
    expect(status().textContent).toBe('🤖 Mary drew the King of Hearts');
    replay.advance(1000);
    expect(slots()[0].classList.contains('has-card')).toBe(true);
    page.socket.fire('youDrew', { card: card('spades', 'Q'), drawOrder: 2 });
    drew(ME, 2, card('spades', 'Q'));
    expect(dm().drawnCards()[1]).toBe(mine);
    expect(status().textContent).toBe('You drew the Queen of Spades');
    drew('🤖 Mike', 3, card('clubs', '7'));
    drew('🤖 Sharon', 4, card('joker', 'HI'));
    replay.advance(1000); // the flips land
    expect(names()).toEqual(['🤖 Mary', ME, '🤖 Mike', '🤖 Sharon']);
    expect(slots().map((s) => s.dataset.state)).toEqual(['drawn', 'drawn', 'drawn', 'drawn']);
    expect(slots().map((s) => s.classList.contains('is-mine'))).toEqual([false, true, false, false]);
    expect(slots()[1].getAttribute('aria-label')).toBe(`${ME}, you: Queen of Spades`);
    // the avatar's initial (a bot's robot is one character)
    expect(slots().map((s) => s.querySelector('.hud-draw__avatar').textContent)).toEqual(['🤖', 'I', '🤖', '🤖']);
    for (const c of dm().drawnCards()) {
      expectFace(c, c.getData('faceKey'));
      expectRect(c.getBounds(), L().draw.slotRects[c.getData('drawOrder') - 1], `drawn ${c.getData('drawOrder')}`);
    }
    expect(dm().drawnCards().map((c) => c.getData('faceKey'))).toEqual(['k_hearts', 'q_spades', '7_clubs', 'hi_joker']);
    expect(slots().every((s) => s.classList.contains('has-card'))).toBe(true);
    // the slot list is not a live region (the status line says each draw once)
    expect(draw().querySelector('.hud-draw__slots').hasAttribute('aria-live')).toBe(false);
    expect([status().getAttribute('role'), status().getAttribute('aria-live')]).toEqual(['status', 'polite']);
    expect(dm().deckCards()).toHaveLength(50);
  });

  it('a render mid-draw (a rejoin) draws the same draw from GameState', () => {
    page.scene.render();
    replay.advance(50);
    expect(names()).toEqual(['🤖 Mary', ME, '🤖 Mike', '🤖 Sharon']);
    expect(slots().map((s) => s.classList.contains('is-mine'))).toEqual([false, true, false, false]);
    expect(draw().classList.contains('has-drawn')).toBe(true);
    const drawn = dm().drawnCards();
    expect(drawn.map((c) => c.getData('faceKey')).sort()).toEqual(['k_hearts', 'q_spades', '7_clubs', 'hi_joker'].sort());
    for (const c of drawn) expectFace(c, c.getData('faceKey'));
    // landed: no placeholders; a rejoin does not re-announce the draws
    expect(slots().every((s) => s.classList.contains('has-card'))).toBe(true);
    expect(status().textContent).toBe('');
    for (const c of drawn) expectRect(c.getBounds(), L().draw.slotRects[c.getData('drawOrder') - 1], `rendered ${c.getData('drawOrder')}`);
    // the deck: the 50 left, none a button (I drew)
    expect(dm().deckCards()).toHaveLength(50);
    expect(dm().deckCards().some(({ card: c }) => c.interactive)).toBe(false);
  });

  it('the teams: a panel with each team\'s avatars (the seats\' pictures) and names, mine marked; the deck fades out, the drawn cards stay', () => {
    page.socket.fire('positionUpdate', {
      positions: [1, 2, 3, 4],
      sockets: ['ios-h1', 's-1', 's-3', 's-4'],
      usernames: [{ username: ME, socketId: 'ios-h1' }, { username: '🤖 Mary', socketId: 's-1' }, { username: '🤖 Mike', socketId: 's-3' }, { username: '🤖 Sharon', socketId: 's-4' }],
      pics: [12, 20, 21, 22],
    });
    page.socket.fire('teamsAnnounced', { team1: [ME, '🤖 Sharon'], team2: ['🤖 Mary', '🤖 Mike'], resumeInMs: 3000 });
    replay.advance(100);
    const teams = hud().querySelector(':scope > .hud-teams');
    expect(teams.classList.contains('is-shown')).toBe(true);
    // a screen reader hears the teams (a status line filled after it is in the page)
    expect(teams.querySelector('.hud-teams__status').textContent).toBe(`Teams: Team 1, ${ME} and 🤖 Sharon; Team 2, 🤖 Mary and 🤖 Mike`);
    expect(teams.querySelector('.hud-teams__panel').hasAttribute('aria-live')).toBe(false);
    expect(teams.querySelector('.hud-teams__scrim')).toBeTruthy();
    const cols = [...teams.querySelectorAll('.hud-teams__team')];
    expect(cols.map((c) => c.querySelector('.hud-teams__label').textContent)).toEqual(['Team 1', 'Team 2']);
    expect(cols.map((c) => c.dataset.team)).toEqual(['a', 'b']);
    expect(cols.map((c) => [...c.querySelectorAll('.hud-teams__name')].map((n) => n.textContent))).toEqual([[ME, '🤖 Sharon'], ['🤖 Mary', '🤖 Mike']]);
    expect([...teams.querySelectorAll('.hud-teams__player.is-mine .hud-teams__name')].map((n) => n.textContent)).toEqual([ME]);
    // the seats' pictures (positionUpdate came first)
    const imgs = [...teams.querySelectorAll('.hud-teams__avatar img')].map((i) => i.getAttribute('src'));
    expect(imgs).toEqual(['assets/avatars/v1/profile12.webp', 'assets/avatars/v1/profile22.webp', 'assets/avatars/v1/profile20.webp', 'assets/avatars/v1/profile21.webp']);
    // the deck fades out in its row (none a button); the drawn cards stay face up in their slots
    replay.advance(1500);
    for (const { card: c } of dm().deckCards()) {
      expect(c.alpha).toBe(0);
      expect(c.interactive).toBe(false);
    }
    for (const c of dm().drawnCards()) expectRect(c.getBounds(), L().draw.slotRects[c.getData('drawOrder') - 1], `kept ${c.getData('drawOrder')}`);
  });

  it('the auto-draw (youDrew without a click) closes the deck and the prompt', () => {
    startDraw();
    replay.advance(1000);
    expect(dm().deckCards().every(({ card: c }) => c.interactive)).toBe(true);
    page.socket.fire('youDrew', { card: card('diamonds', '4'), drawOrder: 1 });
    drew(ME, 1, card('diamonds', '4'));
    expect(dm().deckCards().some(({ card: c }) => c.interactive)).toBe(false);
    expect(draw().classList.contains('has-drawn')).toBe(true);
    expect(slots()[0].classList.contains('is-mine')).toBe(true);
  });

  it('the keyboard button draws once (the middle deck card), then the deck is closed', () => {
    startDraw();
    replay.advance(1000);
    page.socket.clearEmits();
    const key = draw().querySelector('button.hud-draw__key');
    key.focus();
    key.click();
    expect(page.socket.emitted('draw')).toHaveLength(1);
    expect(dm().clickedCardSprite.getData('deckIndex')).toBe(27);
    expect(draw().querySelector('button.hud-draw__key')).toBeNull();
    // the focus goes to the status line, not the page's body
    expect(document.activeElement).toBe(status());
    page.scene.pointerDownAt(layoutMod.deckPosition(L(), 5).x, layoutMod.deckPosition(L(), 5).y);
    expect(page.socket.emitted('draw')).toHaveLength(1);
  });

  it('reduced motion: a drawn card is in its slot at once', () => {
    motion.setReducedMotionOverride(true);
    startDraw();
    drew('🤖 Mary', 1, card('hearts', '2'));
    replay.advance(25);
    const [c] = dm().drawnCards();
    expectFace(c, '2_hearts');
    expect(slots()[0].classList.contains('has-card')).toBe(true);
    expectRect(c.getBounds(), L().draw.slotRects[0], 'reduced');
    motion.setReducedMotionOverride(null);
  });

  it('a long name shrinks (to 0.6) before the ellipsis; a short one stays at size', () => {
    startDraw();
    drew('🤖 Mary', 1, card('hearts', '3'));
    const name = slots()[0].querySelector('.hud-draw__name');
    // the text's width at --name-fit (plus `slack` px: text does not scale exactly with its size)
    const box = (scroll, client, slack = 0) => {
      const fit = () => parseFloat(name.style.getPropertyValue('--name-fit')) || 1;
      Object.defineProperty(name, 'scrollWidth', { configurable: true, get: () => Math.round(scroll * fit() + (fit() < 1 ? slack : 0)) });
      Object.defineProperty(name, 'clientWidth', { configurable: true, get: () => client });
    };
    box(150, 100);
    hudMod.fitDrawNames();
    expect(name.style.getPropertyValue('--name-fit')).toBe('0.66');
    // a name that still spills at the first guess steps down until it fits (live: 152 in 138 px)
    box(152, 138, 3);
    hudMod.fitDrawNames();
    expect(name.style.getPropertyValue('--name-fit')).toBe('0.88');
    expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
    box(400, 100); // shrinks to the floor, then the ellipsis cuts it
    hudMod.fitDrawNames();
    expect(name.style.getPropertyValue('--name-fit')).toBe(String(hudMod.NAME_MIN_SCALE));
    box(80, 100);
    hudMod.fitDrawNames();
    expect(name.style.getPropertyValue('--name-fit')).toBe('');
    // a relayout refits (its boxes changed)
    box(120, 100);
    page.scene.relayout?.();
    dm().relayout();
    expect(name.style.getPropertyValue('--name-fit')).toBe('0.83');
  });
});
