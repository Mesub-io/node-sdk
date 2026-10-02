/**
 * The client's options, checked once at `new Mesub()`: a wrong one throws a
 * TypeError there, never a 401 or a 1 ms timeout on every call later.
 */

/** The longest delay `setTimeout` keeps: beyond it, it fires at once. */
const MAX_DELAY = 2_147_483_647;

/** Hosts reached over plain http without sending the key across a network. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The secret API key: the one given, else `MESUB_API_KEY`. Refuses none, and
 * the publishable key, which every route would answer 401.
 */
export function apiKeyOf(given: unknown): string {
    if (given !== undefined && typeof given !== 'string') {
        throw new TypeError('apiKey must be a string.');
    }

    const apiKey = given || envKey();

    if (!apiKey) {
        throw new TypeError(
            typeof process === 'undefined'
                ? 'Missing Mesub API key: there is no process.env here (an edge runtime such as ' +
                      'Cloudflare Workers), so pass it: `new Mesub({ apiKey: env.MESUB_API_KEY })`.'
                : 'Missing Mesub API key: pass `new Mesub({ apiKey })` or set MESUB_API_KEY.',
        );
    }

    if (apiKey.startsWith('PUB_')) {
        throw new TypeError(
            'That is the publishable key (PUB_...), the one for @mesub/react in the browser. ' +
                'The server needs the secret API key (SUB_...), from the same dashboard page.',
        );
    }

    return apiKey;
}

/** `MESUB_API_KEY`, where there is a `process.env` to read it from. */
function envKey(): string | undefined {
    return typeof process === 'undefined' ? undefined : process.env?.['MESUB_API_KEY'];
}

/**
 * The base URL, without its trailing slashes: https, or http to this machine
 * only, since every call carries the API key.
 */
export function baseUrlOf(given: unknown, fallback: string): string {
    if (given === undefined) return fallback;
    if (typeof given !== 'string') throw new TypeError('baseUrl must be a string.');

    let url: URL;
    try {
        url = new URL(given);
    } catch {
        throw new TypeError(`baseUrl must be an absolute URL, not ${JSON.stringify(given)}.`);
    }

    const local = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
    if (url.protocol !== 'https:' && !local) {
        throw new TypeError(
            `baseUrl must be https (http only to localhost or 127.0.0.1), not ${url.protocol}//${url.host}: ` +
                'every call carries the API key.',
        );
    }

    return given.replace(/\/+$/, '');
}

/**
 * A number of milliseconds or of retries, when given: finite, and positive,
 * or at least 0 when 0 means something (no retry, no fallback).
 */
export function numberOf(
    name: string,
    given: unknown,
    fallback: number,
    rule: { zero?: boolean; integer?: boolean; delay?: boolean } = {},
): number {
    if (given === undefined) return fallback;

    const ok =
        typeof given === 'number' &&
        Number.isFinite(given) &&
        (rule.zero ? given >= 0 : given > 0) &&
        (!rule.integer || Number.isInteger(given)) &&
        (!rule.delay || given <= MAX_DELAY);

    if (!ok) {
        const what = rule.integer ? 'an integer' : 'a number of milliseconds';
        const range = rule.zero ? '0 or more' : 'above 0';
        const cap = rule.delay ? `, ${MAX_DELAY} at most` : '';
        const shown = typeof given === 'string' ? JSON.stringify(given) : String(given);
        throw new TypeError(`${name} must be ${what}, ${range}${cap}, not ${shown}.`);
    }

    return given;
}
