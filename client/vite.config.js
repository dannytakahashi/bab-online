import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// clientHello (utils/avatar.js): which bundle a socket runs
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const build = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'dev').slice(0, 7);

// Pages cached before the build was hashed load /dist/main.js (index.html
// used to be cached for a day). Keep that path as a two-line module that
// loads the current hashed entry; Express serves it no-cache
// (server/staticAssets.js). Remove once no such page can be left.
function legacyEntryShim() {
  return {
    name: 'bab-legacy-entry-shim',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry);
      if (!entry) this.error('no entry chunk');
      this.emitFile({
        type: 'asset',
        fileName: 'main.js',
        source: `// Legacy entry for pages cached before hashed builds\nimport './${entry.fileName}';\n`,
      });
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

  plugins: [legacyEntryShim()],

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The vendor chunk is Phaser's 1.04 MB prebuilt build (+ socket.io-client)
    chunkSizeWarningLimit: 1200,
    // index.html is the input (Vite's default): it gets the hashed entry
    // script and the hashed stylesheets
    rollupOptions: {
      output: {
        entryFileNames: 'assets/main-[hash].js',
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
