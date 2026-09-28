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

    it('exposes the core, Express and Next, and nothing else', () => {
        expect(Object.keys(pkg.exports)).toEqual(['.', './express', './next', './package.json']);
    });

    it.each(['.', './express', './next'])(
        'serves %s to import and require, with types',
        (subpath) => {
            const entry = pkg.exports[subpath];

            expect(entry.import.types).toMatch(/\.d\.ts$/);
            expect(entry.import.default).toMatch(/\.js$/);
            expect(entry.require.types).toMatch(/\.d\.cts$/);
            expect(entry.require.default).toMatch(/\.cjs$/);
        },
    );

    // A merchant on Express must not be made to install Next, or the reverse.
    it('asks for Express and Next as optional peers only', () => {
        expect(pkg.dependencies ?? {}).not.toHaveProperty('express');
        expect(pkg.dependencies ?? {}).not.toHaveProperty('next');
        expect(pkg.peerDependenciesMeta.express.optional).toBe(true);
        expect(pkg.peerDependenciesMeta.next.optional).toBe(true);
    });

    it('ships the build and nothing else', () => {
        expect(pkg.files).toEqual(['dist']);
    });
});
