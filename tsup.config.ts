import { defineConfig } from 'tsup';

/**
 * One build per entry point, each importing only the core: a project on
 * Express never loads anything written for Next or Nest, and so on.
 * ESM and CJS both, with their own declaration files, since `require` and
 * `import` resolve types separately.
 */
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        express: 'src/express.ts',
        next: 'src/next.ts',
        nest: 'src/nest.ts',
        // The fake Mesub, for merchants' tests: loaded only by its own entry.
        testing: 'src/testing.ts',
    },
    format: ['esm', 'cjs'],
    // Shared chunks in CJS too: without them each entry inlines its own copy
    // of the core, and a MesubError thrown by `@mesub/node/express` would fail
    // `instanceof MesubError` against the one from `@mesub/node`.
    splitting: true,
    // tsup sets `baseUrl` for its declaration build, which TypeScript 6 calls
    // deprecated and refuses. Silenced here only, never in tsconfig.json.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
    sourcemap: true,
    target: 'node22',
    // Peer dependencies are the merchant's own copy, never bundled.
    external: ['express', 'next', '@nestjs/common'],
});
