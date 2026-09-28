import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

it('sends the version of package.json in the User-Agent', () => {
    expect(VERSION).toBe(pkg.version);
});
