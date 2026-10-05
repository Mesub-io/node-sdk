import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * The package's shape, checked without building. That every path actually
 * resolves is `scripts/check-exports.mjs`, run on the build in CI.
 */
describe('package.json', () => {
    it('is published as @mesub/node', () => {
        expect(pkg.name).toBe('@mesub/node');
    });

    it('exposes the core, Express, Next, Nest, the fake Mesub and the situations, and nothing else', () => {
        expect(Object.keys(pkg.exports)).toEqual([
            '.',
            './express',
            './next',
            './nest',
            './testing',
            './situations',
            './package.json',
        ]);
    });

    it.each(['.', './express', './next', './nest', './testing', './situations'])(
        'serves %s to import and require, with types',
        (subpath) => {
            const entry = pkg.exports[subpath];

            expect(entry.import.types).toMatch(/\.d\.ts$/);
            expect(entry.import.default).toMatch(/\.js$/);
            expect(entry.require.types).toMatch(/\.d\.cts$/);
            expect(entry.require.default).toMatch(/\.cjs$/);
        },
    );

    // A merchant on Express must not be made to install Next or Nest, and so on.
    it.each(['express', 'next', '@nestjs/common'])(
        'asks for %s as an optional peer only',
        (peer) => {
            expect(pkg.dependencies ?? {}).not.toHaveProperty(peer);
            expect(pkg.peerDependencies).toHaveProperty(peer);
            expect(pkg.peerDependenciesMeta[peer].optional).toBe(true);
        },
    );

    it('ships the build and nothing else', () => {
        expect(pkg.files).toEqual(['dist']);
    });
});
