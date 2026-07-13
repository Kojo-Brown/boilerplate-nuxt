import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['composables/**', 'stores/**', 'utils/**', 'middleware/**', 'server/utils/**'],
      exclude: ['**/*.d.ts', '**/*.config.*'],
      reporter: ['text', 'json', 'html'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
    reporters: ['verbose'],
    typecheck: {
      enabled: false,
    },
  },
})
