import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the project at /space/ (repo name); local dev stays at /.
  base: process.env.GITHUB_ACTIONS ? '/space/' : '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173 },
  build: { target: 'es2022', sourcemap: false },
});
