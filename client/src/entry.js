/**
 * The page's entry (index.html; the legacy /dist/main.js shim imports it
 * too): the phone gate decides, then the app chunk (main.js) loads, or the
 * gate shows and the app chunk is never fetched (src/boot/boot.js).
 */
import { runBoot } from './boot/boot.js';

runBoot({ win: window, loadApp: () => import('./main.js') });
