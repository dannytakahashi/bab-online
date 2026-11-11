/**
 * The page's entry (index.html): the phone gate decides, then the app
 * chunk (main.js) loads, or the gate shows and the app chunk is never
 * fetched (src/boot/boot.js).
 */
import { runBoot } from './boot/boot.js';

runBoot({ win: window, loadApp: () => import('./main.js') });
