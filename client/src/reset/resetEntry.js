/**
 * The reset page's entry (client/reset.html -> assets/reset-[hash].js).
 * Imports only the page and the kit's element factories: never the boot
 * gate, the app (main.js) or the vendor chunk (vite.config.js checks).
 */
import { renderResetPage } from './resetPage.js';

renderResetPage({ root: document.getElementById('reset-root') });
