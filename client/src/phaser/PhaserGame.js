/**
 * Phaser game initialization.
 *
 * Creates the Phaser game instance with GameScene.
 * This replaces the game initialization in legacy game.js.
 */

import { createGameConfig } from './config.js';
import { GameScene } from './scenes/GameScene.js';

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

  const config = createGameConfig({
    parent: containerId,
    scene: GameScene,
  });

  gameInstance = new Phaser.Game(config);

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
