import { defineConfig } from 'vitest/config';

// One run, plain output, only this project's tests. No watch mode, no coverage, no browser.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
