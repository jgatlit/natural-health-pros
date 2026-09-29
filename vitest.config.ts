import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Node environment, not jsdom: this suite covers server-side money logic — the listing gate and
 * the Whop webhook handler — not React rendering. Prisma and Typesense are mocked per-test, so
 * the whole suite runs with no database, no network, and no Whop credentials.
 */
export default defineConfig({
  // Lets a test render a component with renderToStaticMarkup; tsconfig's `jsx: preserve` is for
  // Next and would otherwise leave JSX untransformed under vitest.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
