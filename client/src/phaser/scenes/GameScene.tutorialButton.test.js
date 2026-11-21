/**
 * GameScene and the Tutorial button in my seat's row (owner 2026-11-21; iOS build
 * 29's corner button): shown by role and phase, on/off from the server's
 * word, the confirm before an on that makes this game bot-assisted for me
 * (skipped in a game with a native bot seat or once the server says
 * `assisted`), Cancel sends nothing, Turn on sends `/tutorial on`, on -> off
 * sends `/tutorial off` and shows off, disabled, until assistState.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

globalThis.Phaser = { Scene: class Scene {} };

vi.mock('../managers/LayoutManager.js', () => ({ LayoutManager: class { update() {} } }));
vi.mock('../managers/CardManager.js', () => ({ CardManager: class {} }));
vi.mock('../managers/OpponentManager.js', () => ({ OpponentManager: class {} }));
vi.mock('../managers/TrickManager.js', () => ({ TrickManager: class {} }));
vi.mock('../managers/EffectsManager.js', () => ({ EffectsManager: class {} }));
vi.mock('../managers/DrawManager.js', () => ({ DrawManager: class {} }));
vi.mock('../managers/BidManager.js', () => ({ BidManager: class {} }));
vi.mock('../../ui/components/VoiceChatUI.js', () => ({ reattachMuteButton: vi.fn() }));

let GameScene;
let TUTORIAL_OFF_WAIT_MS;
let TUTORIAL_ON_WAIT_MS;
let getGameState;
let assist;
let tut;
let btnMod;
let applyHudLayout;
let clearHud;
let layoutForViewport;
let clearToasts;

beforeAll(async () => {
  ({ GameScene, TUTORIAL_OFF_WAIT_MS, TUTORIAL_ON_WAIT_MS } = await import('./GameScene.js'));
  ({ getGameState } = await import('../../state/GameState.js'));
  assist = await import('../../state/assistHint.js');
  tut = await import('../../state/tutorial.js');
  btnMod = await import('../../ui/components/TutorialButton.js');
  ({ applyHudLayout, clearHud } = await import('../../ui/tableHud.js'));
  ({ layoutForViewport } = await import('../layout/computeTableLayout.js'));
  ({ clearToasts } = await import('../../ui/kit/toast.js'));
});

beforeEach(() => {
  document.body.innerHTML = '<div id="game-container"><div id="table-hud"></div></div>';
  // my table with the button's slot in my row (as GameScene's getLayout for my own seat)
  applyHudLayout(layoutForViewport({ vw: 1280, vh: 800, tutorial: true }));
  btnMod.resetTutorialButton();
  assist.resetAssistUses();
  tut.resetTutorial();
  clearToasts();
  window.addPrivateToGameFeed = () => {};
  window.socket = { emit: vi.fn(() => true), connected: true };
});
afterEach(() => {
  vi.useRealTimers();
  btnMod.resetTutorialButton();
  clearHud();
  getGameState().reset();
  tut.forgetTutorial();
  assist.forgetAssistUses();
  delete window.addPrivateToGameFeed;
  delete window.socket;
  clearToasts();
  document.body.innerHTML = '';
});

function mySeat({ phase = 'playing', nativeBotSeat = false } = {}) {
  const state = getGameState();
  state.gameId = 'g1';
  state.position = 1;
  state.currentTurn = 2;
  state.isSpectator = false;
  state.isLazy = false;
  state.isBidding = phase === 'bidding';
  state.phase = phase;
  state.nativeBotSeat = nativeBotSeat;
  const scene = new GameScene();
  scene.state = state;
  scene.callbacks = {};
  return { scene, state };
}

const btn = () => document.getElementById('tutorial-toggle-btn');
const shown = () => !!btn() && !btn().hidden && !!btn().closest('.hud-voice');
const stateWord = () => (btn().dataset.state === 'on' ? 'On' : 'Off');
const pressed = () => btn().getAttribute('aria-pressed');
const disabled = () => btn().getAttribute('aria-disabled') === 'true';
const sent = () => window.socket.emit.mock.calls.filter(([e]) => e === 'chatMessage').map(([, d]) => d.message);
const dialog = () => document.querySelector('#tutorial-confirm [role="dialog"]');
const server = (over = {}) => ({ tutorial: false, auto: false, uses: 0, freeUses: 3, assisted: false, ...over });
/** main.js onAssistState: the tutorial and the uses, then the scene. */
const assistState = (scene, data) => {
  tut.noteTutorialState(data, null);
  assist.noteAssistUses(data, null);
  scene.syncTutorial();
};

describe('the Tutorial button: who sees it, when', () => {
  it('my own seat, off or on, in bidding and play: "Off" / "On" and aria-pressed', () => {
    const { scene } = mySeat({ phase: 'bidding' });
    scene.syncTutorial();
    expect(shown()).toBe(true);
    expect(stateWord()).toBe('Off');
    expect(pressed()).toBe('false');
    expect(disabled()).toBe(false);
    assistState(scene, server({ tutorial: true, assisted: true }));
    expect(stateWord()).toBe('On');
    expect(pressed()).toBe('true');
  });

  it('the draw: shown, disabled (a click sends nothing)', () => {
    const { scene } = mySeat({ phase: 'draw' });
    scene.syncTutorial();
    expect(shown()).toBe(true);
    expect(disabled()).toBe(true);
    btn().click();
    expect(sent()).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it('a spectator, a lazy watcher, the game end: hidden', () => {
    const { scene, state } = mySeat();
    scene.syncTutorial();
    expect(shown()).toBe(true);
    state.isLazy = true;
    scene.syncTutorial();
    expect(shown()).toBe(false);
    state.isLazy = false;
    state.isSpectator = true;
    scene.syncTutorial();
    expect(shown()).toBe(false);
    state.isSpectator = false;
    state.phase = 'ended';
    scene.syncTutorial();
    expect(shown()).toBe(false);
  });

  it('the table goes (cleanup): hidden, a confirm up goes too', () => {
    const { scene } = mySeat();
    scene.syncTutorial();
    btn().click();
    expect(dialog()).not.toBeNull();
    scene.cardManager = { clearAll: vi.fn() };
    scene.cleanup();
    expect(shown()).toBe(false);
    expect(dialog()).toBeNull();
    expect(sent()).toEqual([]);
  });
});

describe('the Tutorial button: off -> on', () => {
  it('a human-only game: asks first; Cancel sends nothing', () => {
    const { scene } = mySeat();
    scene.syncTutorial();
    btn().click();
    expect(dialog().querySelector('.kit-modal__title').textContent).toBe('Turn on the tutorial?');
    expect(sent()).toEqual([]);
    document.getElementById('tutorial-confirm-cancel').click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual([]);
    expect(stateWord()).toBe('Off');
    // Escape is Cancel too
    btn().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    expect(sent()).toEqual([]);
  });

  it('Turn on sends /tutorial on once; the button waits (Off, disabled) for assistState, then On', () => {
    const { scene } = mySeat();
    scene.syncTutorial();
    btn().click();
    document.getElementById('tutorial-confirm-ok').click();
    expect(sent()).toEqual(['/tutorial on']);
    expect(stateWord()).toBe('Off');
    expect(disabled()).toBe(true);
    btn().click();
    expect(sent()).toEqual(['/tutorial on']);
    assistState(scene, server({ tutorial: true, assisted: true }));
    expect(stateWord()).toBe('On');
    expect(disabled()).toBe(false);
  });

  it('no answer: enabled again after the wait', () => {
    vi.useFakeTimers();
    const { scene } = mySeat();
    scene.syncTutorial();
    btn().click();
    document.getElementById('tutorial-confirm-ok').click();
    expect(disabled()).toBe(true);
    vi.advanceTimersByTime(TUTORIAL_ON_WAIT_MS);
    expect(disabled()).toBe(false);
    expect(stateWord()).toBe('Off');
  });

  it('a game with a native bot seat: no question, /tutorial on at once (no bot-assisted words anywhere)', () => {
    const { scene } = mySeat({ nativeBotSeat: true });
    scene.syncTutorial();
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual(['/tutorial on']);
    expect(document.body.textContent).not.toMatch(/bot-assisted/);
  });

  it('the server\'s unlimited (a hint or assistState) wins: no question', () => {
    const { scene } = mySeat();
    assistState(scene, server({ unlimited: true }));
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual(['/tutorial on']);
  });

  it('already bot-assisted for me (assistState assisted: the tutorial on earlier, more than 3 /help): no question', () => {
    const { scene } = mySeat();
    assistState(scene, server({ tutorial: false, assisted: true }));
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual(['/tutorial on']);
  });

  it('a confirm left up: the server turning it on (a typed /tutorial) takes it down unsent', () => {
    const { scene } = mySeat();
    scene.syncTutorial();
    btn().click();
    expect(dialog()).not.toBeNull();
    assistState(scene, server({ tutorial: true, assisted: true }));
    expect(dialog()).toBeNull();
    expect(sent()).toEqual([]);
  });

  it('offline: the reconnecting notice, nothing sent, not waiting', () => {
    const { scene } = mySeat({ nativeBotSeat: true });
    window.socket.connected = false;
    scene.syncTutorial();
    btn().click();
    expect(sent()).toEqual([]);
    expect(disabled()).toBe(false);
  });
});

describe('the Tutorial button: on -> off', () => {
  it('sends /tutorial off at once (never asks), shows Off and waits; assistState off: enabled', () => {
    const { scene } = mySeat();
    assistState(scene, server({ tutorial: true, assisted: true }));
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual(['/tutorial off']);
    expect(stateWord()).toBe('Off');
    expect(pressed()).toBe('false');
    expect(disabled()).toBe(true);
    btn().click();
    expect(sent()).toEqual(['/tutorial off']);
    assistState(scene, server({ tutorial: false, assisted: true }));
    expect(stateWord()).toBe('Off');
    expect(disabled()).toBe(false);
    // on again: this game is bot-assisted for me already, so no question
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual(['/tutorial off', '/tutorial on']);
  });

  it('no answer: back to On after the wait (the server still says on)', () => {
    vi.useFakeTimers();
    const { scene } = mySeat();
    assistState(scene, server({ tutorial: true, assisted: true }));
    btn().click();
    expect(stateWord()).toBe('Off');
    vi.advanceTimersByTime(TUTORIAL_OFF_WAIT_MS);
    expect(stateWord()).toBe('On');
    expect(disabled()).toBe(false);
  });

  it('the welcome\'s Turn off and the button share the wait; no in-hand chip anywhere', () => {
    const { scene } = mySeat();
    assistState(scene, server({ tutorial: true, auto: true }));
    expect(document.querySelector('.hud-tutorial')).toBeNull();
    const welcome = {
      v: 1, source: 'tutorial', kind: 'tip', turnKey: '1|PLAYING|1|4|0', headline: 'Tutorial on', tipId: 'T.welcome', actions: ['keep', 'off'],
      reasons: ['Tips will appear above your cards. Only you see them. Close one with ×, or choose Turn off to stop them.'],
      uses: 0, freeUses: 3, assisted: false, counted: false,
    };
    scene.handleAssistHint(welcome);
    scene.tipAction(welcome, 'off');
    expect(sent()).toEqual(['/tutorial off']);
    expect(stateWord()).toBe('Off');
    expect(disabled()).toBe(true);
    btn().click();
    expect(sent()).toEqual(['/tutorial off']);
  });
});

describe('the Tutorial button follows a snapshot\'s viewer.assist (the real page: table/tutorialButton.test.js)', () => {
  it('viewer.assist.tutorial: On; without the key: Off; its assisted skips the question', () => {
    const { scene } = mySeat();
    // the snapshot's tutorial and uses, as tableSync applies them
    const view = { uses: 0, freeUses: 3, assisted: true, tutorial: true };
    assist.noteAssistUses(view, 'g1');
    tut.noteTutorialState(view, 'g1');
    scene.syncTutorial();
    expect(stateWord()).toBe('On');
    tut.noteTutorialState({ uses: 0, freeUses: 3, assisted: true }, 'g1');
    scene.syncTutorial();
    expect(stateWord()).toBe('Off');
    btn().click();
    expect(dialog()).toBeNull();
    expect(sent()).toEqual(['/tutorial on']);
  });

});
