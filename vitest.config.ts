import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Nest's parameter decorators exist only in TypeScript's legacy flavour.
    oxc: { decorator: { legacy: true } },
    test: {
        globals: true,
        include: ['test/**/*.spec.ts'],
    },
});
