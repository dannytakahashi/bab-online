import { defineConfig } from 'vite';
import { readFileSync } from 'fs';
import { NOT_PHONE_MEDIA } from './src/boot/deviceGate.js';

// clientHello (utils/avatar.js): which bundle a socket runs
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const build = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'dev').slice(0, 7);

// The app chunk (src/main.js and its static imports: Phaser and
// socket.io-client) is imported by the entry once the phone gate lets the
// page through (src/boot/). Preload it from the page so a desktop does not
// wait for the entry before starting the download, but only on non-phones
// (media = NOT_PHONE_MEDIA): a gated phone never fetches Phaser
const BOOT_MAX_BYTES = 16 * 1024;
function appChunkPreload() {
  return {
    name: 'bab-app-chunk-preload',
    apply: 'build',
    // The gate path must stay tiny: the entry imports nothing statically
    // (no vendor, no app code) and stays under BOOT_MAX_BYTES
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry);
      if (!entry) this.error('no entry chunk');
      if (entry.imports.length) this.error(`the boot entry imports ${entry.imports.join(', ')} statically: a gated phone would load it`);
      if (entry.code.length > BOOT_MAX_BYTES) this.error(`the boot entry is ${entry.code.length} bytes (max ${BOOT_MAX_BYTES})`);
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const chunks = Object.values(ctx.bundle || {}).filter((c) => c.type === 'chunk');
        const app = chunks.find((c) => c.facadeModuleId?.endsWith('/src/main.js'));
        if (!app) throw new Error('bab-app-chunk-preload: no app chunk (src/main.js)');
        if (app.isEntry) throw new Error('bab-app-chunk-preload: src/main.js must be a dynamic chunk');
        const entry = chunks.find((c) => c.isEntry);
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

  plugins: [appChunkPreload()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The vendor chunk is Phaser's 1.04 MB prebuilt build (+ socket.io-client)
    chunkSizeWarningLimit: 1200,
    // No modulepreload polyfill: it fetch()es every modulepreload link and
    // ignores media, so an old phone browser would download Phaser behind
    // the gate. Browsers without modulepreload just skip the hint
    modulePreload: { polyfill: false },
    // index.html is the input (Vite's default): it gets the hashed entry
    // script and the hashed stylesheets
    rollupOptions: {
      output: {
        // the entry is the boot module (phone gate); the app is main-[hash]
        entryFileNames: 'assets/boot-[hash].js',
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
