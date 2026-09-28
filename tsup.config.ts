import { defineConfig } from 'tsup';

/**
 * One build per entry point, each importing only the core: a project on
 * Express never loads anything written for Next, and the other way round.
 * ESM and CJS both, with their own declaration files, since `require` and
 * `import` resolve types separately.
 */
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        express: 'src/express.ts',
        next: 'src/next.ts',
    },
    format: ['esm', 'cjs'],
    // tsup sets `baseUrl` for its declaration build, which TypeScript 6 calls
    // deprecated and refuses. Silenced here only, never in tsconfig.json.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
    sourcemap: true,
    target: 'node20',
    // Peer dependencies are the merchant's own copy, never bundled.
    external: ['express', 'next'],
});
