import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 600_000, // E2E Docker deploy + compiler download can take 5+ min
    fileParallelism: false,
    pool: 'forks',
    include: ['**/*.test.ts', '**/*.spec.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/node_modules/**',
      'test/ping.test.ts', // standalone script, not a Vitest suite (run with npx tsx)
    ],
  },
});
