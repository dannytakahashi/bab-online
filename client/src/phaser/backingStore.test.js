/**
 * The canvas at the device pixel ratio (item 18a, webclient-12 / ui-15):
 * the backing store is the CSS size times the ratio, the canvas is drawn at
 * its CSS size, the camera zooms by the ratio, and the table layout, the
 * HUD and every game object stay in CSS pixels (one conversion point).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { installFakePhaser, FakeSceneBase } from '../testing/fakePhaser.js';
import { applyBackingStore, cssSize, deviceScale, zoomCamera, MAX_DPR } from './backingStore.js';

vi.mock('../ui/components/VoiceChatUI.js', () => ({ reattachMuteButton: () => {} }));

beforeAll(() => installFakePhaser());

/** A Phaser.Game stand-in: a scale manager whose resize sets the backing store. */
function fakeGame() {
  const scale = {
    width: 0,
    height: 0,
    zoom: 1,
    resized: [],
    resize(w, h) {
      this.width = w;
      this.height = h;
      this.resized.push([w, h]);
      // Phaser styles the canvas from the zoom (rounded): applyBackingStore corrects it
      canvas.style.width = `${Math.floor(w * this.zoom)}px`;
    },
  };
  const canvas = { width: 0, height: 0, style: {} };
  const cam = { originX: 0.5, originY: 0.5, zoom: 1, setOrigin(x, y) { this.originX = x; this.originY = y; return this; }, setZoom(z) { this.zoom = z; return this; } };
  const scene = { cameras: { main: cam }, scale };
  return { scale, canvas, scene: { getScenes: () => [scene] }, cam };
}

describe('the backing store', () => {
  it('at DPR 2 the backing size is the CSS size x 2; the canvas is drawn at its CSS size; the camera zooms by 2', () => {
    const game = fakeGame();
    expect(applyBackingStore(game, 1120, 790, 2)).toBe(true);
    expect([game.scale.width, game.scale.height]).toEqual([2240, 1580]);
    expect(game.scale.zoom).toBe(0.5);
    expect([game.canvas.style.width, game.canvas.style.height]).toEqual(['1120px', '790px']);
    expect([game.cam.originX, game.cam.originY, game.cam.zoom]).toEqual([0, 0, 2]);
    // the one conversion: CSS pixels back out
    expect(cssSize(game.scale)).toEqual({ w: 1120, h: 790, dpr: 2 });
    // the same size again: nothing to do (no resize event, no relayout)
    expect(applyBackingStore(game, 1120, 790, 2)).toBe(false);
    expect(game.scale.resized).toHaveLength(1);
    // a move to a 1x display
    expect(applyBackingStore(game, 1120, 790, 1)).toBe(true);
    expect([game.scale.width, game.scale.height, game.cam.zoom]).toEqual([1120, 790, 1]);
    expect(game.canvas.style.width).toBe('1120px');
  });

  it('a fractional ratio keeps the CSS size exact', () => {
    const game = fakeGame();
    applyBackingStore(game, 1001, 667, 1.5);
    expect([game.scale.width, game.scale.height]).toEqual([1502, 1001]);
    expect(cssSize(game.scale)).toEqual({ w: 1001, h: 667, dpr: 1.5 });
  });

  it('the ratio is the window\'s, clamped to [1, 3]', () => {
    const was = window.devicePixelRatio;
    for (const [d, want] of [[2, 2], [0.5, 1], [4, MAX_DPR], [undefined, 1]]) {
      Object.defineProperty(window, 'devicePixelRatio', { value: d, configurable: true });
      expect(deviceScale()).toBe(want);
    }
    Object.defineProperty(window, 'devicePixelRatio', { value: was, configurable: true });
  });

  it('the game config renders at the ratio (Phaser 3.55 has no working resolution): size x dpr, zoom 1 / dpr, no physics', async () => {
    const { createGameConfig } = await import('./config.js');
    const cfg = createGameConfig({ dpr: 2, cssWidth: 1440, cssHeight: 790 });
    expect([cfg.width, cfg.height]).toEqual([2880, 1580]);
    expect(cfg.scale.zoom).toBe(0.5);
    expect(cfg.scale.mode).toBe(Phaser.Scale.NONE);
    expect(cfg.physics).toBeUndefined();
    // Phaser reads transparent from a `render` block when one exists: keep none
    expect(cfg.render).toBeUndefined();
    expect(cfg).toMatchObject({ transparent: true, pixelArt: false, antialias: true });
  });
});

describe('GameScene at DPR 2', () => {
  it('lays the table out in CSS pixels, zooms its camera and draws the atlas at hand card x 2', async () => {
    const { GameScene } = await import('./scenes/GameScene.js');
    const { cardAtlasInfo } = await import('./cards/CardAtlas.js');
    const { computeTableLayout } = await import('./layout/computeTableLayout.js');
    const scene = new GameScene();
    expect(scene).toBeInstanceOf(FakeSceneBase);
    Object.assign(scene.scale, { width: 3200, height: 2160, babDpr: 2, babCss: { w: 1600, h: 1080 } });
    zoomCamera(scene);
    const L = scene.getLayout();
    expect([L.w, L.h, L.dpr]).toEqual([1600, 1080, 2]);
    expect(L).toEqual(computeTableLayout({ w: 1600, h: 1080, dpr: 2, isSpectator: false, logW: L.logW }));
    expect(scene.cameras.main.zoom).toBe(2);
    // the frame is the hand card in device pixels
    expect(L.cardTexture.h).toBe(Math.ceil(L.card.hand.h * 2));
    expect(cardAtlasInfo(scene.textures).frame).toEqual({ w: L.cardTexture.w, h: L.cardTexture.h });
    // a card drawn at the layout's scale is its CSS size on screen
    const card = scene.add.image(100, 100, 'cards', 'a_spades').setScale(L.card.hand.scale);
    expect(card.getBounds().height).toBeCloseTo(L.card.hand.h, 6);
    expect(card.getBounds().width).toBeCloseTo(L.card.hand.w, 6);
  });
});
