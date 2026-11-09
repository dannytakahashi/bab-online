import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// clientHello (utils/avatar.js): which bundle a socket runs
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const build = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'dev').slice(0, 7);

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: false, // Don't copy public files (we serve from Express)

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(build),
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.js',
      external: ['phaser', 'socket.io-client'],
      output: {
        format: 'es',
        entryFileNames: 'main.js',
        globals: {
          'phaser': 'Phaser',
          'socket.io-client': 'io'
        }
      }
    }
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
});
