import { defineConfig } from 'vite';
import { resolve } from 'path';

// The renderer is plain vanilla TS (copied from the Electron version);
// it lives at src/ with index.html at the root and modules in src/src/.
// `approval.html` is the always-on-top overlay window (agent PermissionRequests),
// built as a second page just like the main one.
export default defineConfig({
  base: './',
  root: 'src',
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: '../out/renderer',
    emptyOutDir: true,
    target: 'es2022',
    /* Shiki grammars are already dynamic imports (one chunk per language),
       but without manualChunks Vite inlines the small ones into main and
       leaves chunk naming to hashes. Keep langs as named lazy chunks so
       the initial main.js only pays for the highlighter core (~100 KB)
       and each grammar fetches on first diff view of that language. */
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        approval: resolve(__dirname, 'src/approval.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('@shikijs/langs/')) {
            const m = id.match(/langs\/dist\/([^.]+)\.mjs$/);
            if (m) return 'shiki-lang-' + m[1];
          }
          /* keep the core out of the initial graph: it is only imported
             from inside getHighlighter(), so it must stay lazy. Only the
             JS-regex engine + shiki/core land here, never eagerly. */
          if (id.includes('@shikijs/engine-javascript') || id.includes('shiki/dist/core')) return 'shiki-core';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/src'),
    },
  },
});
