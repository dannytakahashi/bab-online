/**
 * Third-party libraries, bundled (they used to come from cdn.jsdelivr.net and
 * cdn.socket.io). main.js imports this module FIRST: the scene and manager
 * modules read the Phaser global while they evaluate (class GameScene
 * extends Phaser.Scene), and ES modules evaluate in import order.
 *
 * Phaser stays a global so the modules (and their Vitest stubs, which set
 * globalThis.Phaser) are unchanged. Vite puts both libraries in their own
 * vendor chunk, whose hash only changes when a library does, so a deploy of
 * our code does not make browsers download Phaser again.
 */

// The prebuilt UMD build: the same file the CDN served. Phaser 3.55's
// package entry is its source tree, which expects webpack-defined flags
import Phaser from 'phaser/dist/phaser.min.js';

globalThis.Phaser = Phaser;
