import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'));

// Fills the %APP_VERSION% placeholder in index.html's <title> from
// package.json, so the title can't drift out of sync with the version
// (as the hardcoded string it replaced did).
function htmlVersionPlugin(): Plugin {
  return {
    name: 'html-version',
    transformIndexHtml(html) {
      return html.replace('%APP_VERSION%', pkg.version);
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), htmlVersionPlugin()],
  base: './',
  build: {
    outDir: 'dist-react',
  },
  server: {
    port: 5123,
    strictPort: true,
  },
});
