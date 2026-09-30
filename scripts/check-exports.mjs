/**
 * Loads every entry point of the built package the way a merchant would, by
 * its public name, through both `import` and `require`, and checks each has
 * its declaration file. A wrong path in `exports` builds and tests fine, and
 * only breaks in somebody else's project: this is where it breaks instead.
 *
 * Run after `pnpm build`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
const failures = [];

for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    if (subpath === './package.json') continue;

    const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;

    for (const condition of ['import', 'require']) {
        const { types, default: file } = conditions[condition];

        for (const path of [types, file]) {
            if (!existsSync(new URL(`../${path}`, import.meta.url))) {
                failures.push(`${specifier} (${condition}): ${path} was not built`);
            }
        }
    }

    try {
        await import(specifier);
    } catch (error) {
        failures.push(`import ${specifier}: ${error.message}`);
    }

    try {
        require(specifier);
    } catch (error) {
        failures.push(`require ${specifier}: ${error.message}`);
    }
}

// One MesubError across entries. Without shared chunks each CJS entry inlines
// its own copy, and `instanceof MesubError` fails on an error thrown by
// `@mesub/node/express`: builds and tests fine, breaks in a merchant's catch.
const core = { import: (await import(pkg.name)).MesubError, require: require(pkg.name).MesubError };

for (const subpath of Object.keys(pkg.exports)) {
    if (subpath === '.' || subpath === './package.json') continue;

    const specifier = `${pkg.name}/${subpath.slice(2)}`;
    const loaded = { import: await import(specifier), require: require(specifier) };

    for (const condition of ['import', 'require']) {
        const theirs = loaded[condition].MesubError;
        if (theirs !== undefined && theirs !== core[condition]) {
            failures.push(`${specifier} (${condition}): its MesubError is not the core's`);
        }
    }
}

if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
}

console.log(
    `${Object.keys(pkg.exports).length - 1} entry points resolve through import and require.`,
);
