/**
 * The Phaser loop sleeps off the table (item 18a, cli-23 / webclient-10):
 * the game is created at page load and its requestAnimationFrame loop used
 * to clear and composite a full-window canvas 60 times a second behind the
 * sign-in, main room, lobby and profile screens. The loop now runs only on
 * the screens that show the table (ClientSession TABLE and GAME_END: the
 * score modal sits over the table) and sleeps everywhere else.
 *
 *   - Waking is immediate (enterTable's transition), before any table work
 *     runs: the deal, a rejoin's render, a spectate, a tournament round.
 *   - Sleeping waits for one more rendered frame: an exit's teardown queues
 *     the scene's restart, which Phaser runs on its next step, and the frame
 *     clears the canvas of the old table. Only then does the loop stop, in
 *     a task after that frame: Phaser 3.55's requestAnimationFrame step
 *     requests the next frame AFTER its callback whatever isRunning says, so
 *     a sleep from inside the frame (postrender) would be undone at once.
 *   - Phaser wakes its own loop when a hidden tab comes back (onVisible ->
 *     loop.resume): off the table it is put back to sleep the same way.
 *   - Nothing waits on scene time off the table: the TableDirector's work is
 *     cancelled by the exit (director.reset), and a sleeping loop is only
 *     ever woken by entering a table. A manual loop.step (the hidden-pane
 *     stepping hack) still steps it.
 */
import { SCREEN } from '../state/ClientSession.js';

/** The screens that show the table: the loop runs there. */
export const LOOP_SCREENS = Object.freeze([SCREEN.TABLE, SCREEN.GAME_END]);

/** Phaser's game events (Phaser.Core.Events): after a frame is drawn, and the loop resumed on a tab return. */
const POST_RENDER = 'postrender';
const RESUME = 'resume';

/**
 * Keep a Phaser game's loop running only on the table screens.
 * @param {Object} o
 * @param {import('../state/ClientSession.js').ClientSession} o.session
 * @param {Function} o.getGame - () => Phaser.Game | null
 * @returns {{sync: Function, stats: Object, dispose: Function}}
 */
export function installLoopControl({ session, getGame }) {
  const stats = { sleeps: 0, wakes: 0 };
  let pendingSleep = null; // the postrender handler waiting to sleep
  let boundGame = null;

  const wants = () => LOOP_SCREENS.includes(session.screen);

  const cancelPending = (game) => {
    if (pendingSleep && game?.events?.off) game.events.off(POST_RENDER, pendingSleep);
    pendingSleep = null;
  };

  const sleepNow = (game) => {
    if (!game?.loop) return;
    if (game.loop.running !== false) {
      game.loop.sleep();
      stats.sleeps++;
    }
  };

  const sync = () => {
    const game = getGame();
    if (!game?.loop) return;
    bind(game);
    if (wants()) {
      cancelPending(game);
      if (game.loop.running === false) {
        // a fresh delta: the first frame after a long sleep must not jump
        game.loop.resetDelta?.();
        game.loop.wake();
        stats.wakes++;
      }
      return;
    }
    if (game.loop.running === false || pendingSleep) return;
    if (!game.events?.once) {
      sleepNow(game);
      return;
    }
    // one more frame first (the scene restart, a cleared canvas), then sleep
    // outside the frame callback (see above)
    pendingSleep = () => {
      pendingSleep = null;
      setTimeout(() => {
        if (!wants()) sleepNow(game);
      }, 0);
    };
    game.events.once(POST_RENDER, pendingSleep);
  };

  // Phaser resumes its loop when the tab becomes visible again
  const onResume = () => {
    if (!wants()) sync();
  };
  function bind(game) {
    if (boundGame === game) return;
    boundGame?.events?.off?.(RESUME, onResume);
    boundGame = game;
    game.events?.on?.(RESUME, onResume);
  }

  const off = session.onScreenChange(() => sync());

  return {
    sync,
    stats,
    dispose() {
      off();
      cancelPending(boundGame);
      boundGame?.events?.off?.(RESUME, onResume);
      boundGame = null;
    },
  };
}
