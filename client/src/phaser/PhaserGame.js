/**
 * Phaser game initialization.
 *
 * Creates the Phaser game instance with GameScene.
 * This replaces the game initialization in legacy game.js.
 */

import { createGameConfig } from './config.js';
import { GameScene } from './scenes/GameScene.js';
import { deviceScale } from './backingStore.js';

let gameInstance = null;

/**
 * Create and initialize the Phaser game.
 *
 * @param {string} containerId - Parent element ID for the game canvas
 * @returns {Phaser.Game} The Phaser game instance
 */
export function createPhaserGame(containerId = 'game-container') {
  if (gameInstance) {
    console.warn('Phaser game already exists');
    return gameInstance;
  }

  console.log('🎮 Creating Phaser game...');

  // The backing store at the device pixel ratio (backingStore.js); main.js
  // keeps it on #game-container's size from then on
  const dpr = deviceScale();
  const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
  const cssWidth = container?.clientWidth || window.innerWidth;
  const cssHeight = container?.clientHeight || window.innerHeight;
  const config = createGameConfig({
    parent: containerId,
    scene: GameScene,
    dpr,
    cssWidth,
    cssHeight,
  });

  gameInstance = new Phaser.Game(config);
  if (gameInstance.scale) {
    gameInstance.scale.babDpr = dpr;
    gameInstance.scale.babCss = { w: cssWidth, h: cssHeight };
  }

  console.log('🎮 Phaser game created');

  return gameInstance;
}

/**
 * Get the current Phaser game instance.
 *
 * @returns {Phaser.Game|null} The game instance or null if not created
 */
export function getPhaserGame() {
  return gameInstance;
}

/**
 * Destroy the Phaser game instance.
 * Used for cleanup or hot reload.
 */
export function destroyPhaserGame() {
  if (gameInstance) {
    gameInstance.destroy(true);
    gameInstance = null;
    console.log('🎮 Phaser game destroyed');
  }
}
