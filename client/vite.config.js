import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: false, // Don't copy public files (we serve from Express)

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
      }
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
