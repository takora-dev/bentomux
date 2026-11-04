import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/* The renderer's tests run in a DOM, not in node: the views under src/src/
 * build real elements through dom.ts and assert on what a person would see.
 * Kept separate from vite.config.ts because that one builds the two app pages
 * and must not carry test-only settings into the bundle. */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/src'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/src/**/*.test.ts'],
    /* the shared/ tests are plain node:test files run by `npm run test:ts`;
     * vitest would try to re-run them with a different runner */
    exclude: ['src/shared/**', 'node_modules/**', 'out/**'],
    reporters: 'default',
  },
});
