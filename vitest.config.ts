import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Nest's parameter decorators exist only in TypeScript's legacy flavour.
    oxc: { decorator: { legacy: true } },
    test: {
        globals: true,
        include: ['test/**/*.spec.ts'],
        // `pnpm test:coverage` only. What ships, not the tests nor the build.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
            // A floor, not a goal: about 99% today, so only a module landing
            // mostly untested trips it. What the tests miss is behaviour more
            // than lines, a malformed cookie on a line already run.
            thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
        },
    },
});
