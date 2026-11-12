import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { NOT_PHONE_MEDIA } from './src/boot/deviceGate.js';

// clientHello (utils/avatar.js): which bundle a socket runs
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const build = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'dev').slice(0, 7);

// Phaser 3.55's prebuilt build finds the global object webpack-style:
// `(function(){return this})()`, which is undefined in our strict ES
// module, then `new Function("return this")()`, which the page CSP (no
// 'unsafe-eval', server/middleware/csp.js) refuses with a console
// violation before Phaser falls back to window. Use globalThis instead, so
// the page needs no 'unsafe-eval'. Fails the build if the pattern moves
// (a Phaser upgrade): check the new build for eval before changing it
const PHASER_EVAL = 'new Function("return this")()';
function phaserNoEval() {
  return {
    name: 'bab-phaser-no-eval',
    transform(code, id) {
      if (!/\/node_modules\/phaser\/dist\/phaser(\.min)?\.js$/.test(id)) return null;
      const hits = code.split(PHASER_EVAL).length - 1;
      if (hits !== 1) this.error(`expected 1 "${PHASER_EVAL}" in ${id}, found ${hits}`);
      return { code: code.replace(PHASER_EVAL, 'globalThis'), map: null };
    },
  };
}

// The app chunk (src/main.js and its static imports: Phaser and
// socket.io-client) is imported by the entry once the phone gate lets the
// page through (src/boot/). Preload it from the page so a desktop does not
// wait for the entry before starting the download, but only on non-phones
// (media = NOT_PHONE_MEDIA): a gated phone never fetches Phaser
const BOOT_MAX_BYTES = 16 * 1024;
// The reset page's entry (reset.html, a player's one-time link, opened on
// phones): it may share the kit's small chunk with the app, but never
// imports the app, the vendor chunk or the boot gate, and stays small
const RESET_MAX_BYTES = 24 * 1024;
// An html input's entry chunk has the page as its facade module
const facade = (c) => c.facadeModuleId || '';
const isResetFacade = (id) => /\/(reset\.html|src\/reset\/resetEntry\.js)$/.test(id || '');
const isBootEntry = (c) => c.isEntry && /\/(index\.html|src\/entry\.js)$/.test(facade(c));
const isResetEntry = (c) => c.isEntry && isResetFacade(facade(c));
function appChunkPreload() {
  return {
    name: 'bab-app-chunk-preload',
    apply: 'build',
    // The gate path must stay tiny: the entry imports nothing statically
    // (no vendor, no app code) and stays under BOOT_MAX_BYTES
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
      const entry = chunks.find(isBootEntry);
      if (!entry) this.error('no entry chunk');
      if (entry.imports.length) this.error(`the boot entry imports ${entry.imports.join(', ')} statically: a gated phone would load it`);
      if (entry.code.length > BOOT_MAX_BYTES) this.error(`the boot entry is ${entry.code.length} bytes (max ${BOOT_MAX_BYTES})`);
      const reset = chunks.find(isResetEntry);
      if (!reset) this.error('no reset entry chunk (reset.html)');
      const byName = new Map(chunks.map((c) => [c.fileName, c]));
      const seen = new Set();
      const walk = (c) => {
        for (const f of [...c.imports, ...c.dynamicImports]) {
          if (seen.has(f)) continue;
          seen.add(f);
          const dep = byName.get(f);
          if (!dep) continue;
          if (/(^|\/)(vendor|main|boot)-/.test(f) || dep.facadeModuleId?.endsWith('/src/main.js')) {
            this.error(`the reset page imports ${f}: it must load neither the app, the vendor chunk nor the gate`);
          }
          walk(dep);
        }
      };
      walk(reset);
      const size = reset.code.length + [...seen].reduce((n, f) => n + (byName.get(f)?.code.length || 0), 0);
      if (size > RESET_MAX_BYTES) this.error(`the reset page's scripts are ${size} bytes (max ${RESET_MAX_BYTES})`);
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        // the reset page preloads nothing (it never loads the app)
        if (ctx.filename?.endsWith('reset.html') || ctx.path?.endsWith('reset.html')) return [];
        const chunks = Object.values(ctx.bundle || {}).filter((c) => c.type === 'chunk');
        const app = chunks.find((c) => c.facadeModuleId?.endsWith('/src/main.js'));
        if (!app) throw new Error('bab-app-chunk-preload: no app chunk (src/main.js)');
        if (app.isEntry) throw new Error('bab-app-chunk-preload: src/main.js must be a dynamic chunk');
        const entry = chunks.find(isBootEntry);
        const files = [app.fileName, ...app.imports.filter((f) => f !== entry?.fileName)];
        return files.map((f) => ({
          tag: 'link',
          attrs: { rel: 'modulepreload', crossorigin: true, href: `/dist/${f}`, media: NOT_PHONE_MEDIA },
          injectTo: 'head',
        }));
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: '.',
  // Built pages load everything from /dist/ (client/dist on disk; Express
  // serves /dist/assets immutable). The dev server serves from /
  base: command === 'build' ? '/dist/' : '/',
  publicDir: false, // Don't copy public files (we serve from Express)

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(build),
  },

  // Production bundles drop console.log/console.debug (the client logs on
  // every event); console.warn/error stay. esbuild keeps any side effects
  // of the arguments
  esbuild: command === 'build' ? { pure: ['console.log', 'console.debug'] } : {},

  plugins: [phaserNoEval(), appChunkPreload()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The vendor chunk is Phaser's 1.04 MB prebuilt build (+ socket.io-client)
    chunkSizeWarningLimit: 1200,
    // No modulepreload polyfill: it fetch()es every modulepreload link and
    // ignores media, so an old phone browser would download Phaser behind
    // the gate. Browsers without modulepreload just skip the hint
    modulePreload: { polyfill: false },
    // Two pages: index.html (the app behind the phone gate) and reset.html
    // (the one-time password link page, no gate, no app). Each gets its
    // hashed entry script and hashed stylesheets
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        reset: fileURLToPath(new URL('./reset.html', import.meta.url)),
      },
      output: {
        // the entry is the boot module (phone gate); the app is main-[hash];
        // the reset page's entry is reset-[hash]
        entryFileNames: (chunk) => (isResetFacade(chunk.facadeModuleId) ? 'assets/reset-[hash].js' : 'assets/boot-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Phaser and socket.io-client in their own chunk: its hash only
        // changes with a library version, so deploys don't re-download it
        manualChunks(id) {
          if (id.includes('/node_modules/')) return 'vendor';
          return undefined;
        },
      },
    },
  },

  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      },
      // custom avatars over HTTP (server/routes/avatar.js)
      '/avatar': 'http://localhost:3000'
    }
  },

  resolve: {
    alias: {
      '@': '/src'
    }
  },

  test: {
    globals: true,
    environment: 'jsdom',
    root: './client',
    include: ['src/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/**/*.test.js']
    }
  }
}));
