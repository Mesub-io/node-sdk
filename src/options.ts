import { API_VERSION_HEADER } from './version.js';

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

    // Every path is appended to it: a query or a fragment would swallow them.
    if (url.search !== '' || url.hash !== '' || given.includes('?') || given.includes('#')) {
        throw new TypeError(
            `baseUrl must have no query nor fragment, not ${JSON.stringify(given)}.`,
        );
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

/**
 * What the access tokens' `iss` must be: the Mesub API's own public URL,
 * which is the base URL unless a proxy stands in front of it.
 */
export function issuerOf(given: unknown, baseUrl: string): string {
    if (given === undefined) return baseUrl;
    if (typeof given !== 'string' || given === '') {
        throw new TypeError('issuer must be a non-empty string: the Mesub API URL tokens name.');
    }

    return given;
}

/** Headers the SDK sets itself, and no extra header may replace. */
const OWN_HEADERS = new Set([
    'authorization',
    'user-agent',
    'accept',
    'content-type',
    API_VERSION_HEADER.toLowerCase(),
]);

/**
 * Extra headers for every call, the JWKS included: for a proxy or an access
 * gateway in front of Mesub. Valid names and values only, and none of the
 * SDK's own, so the API key can never be swapped for another.
 */
export function headersOf(given: unknown): Record<string, string> {
    if (given === undefined) return {};
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
        throw new TypeError('headers must be an object of header names to string values.');
    }

    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(given)) {
        if (typeof value !== 'string') {
            throw new TypeError(`headers.${name} must be a string.`);
        }
        if (OWN_HEADERS.has(name.toLowerCase())) {
            throw new TypeError(`headers cannot set ${name}: the SDK sets it itself.`);
        }
        try {
            new Headers([[name, value]]);
        } catch {
            throw new TypeError(`headers.${name} is not a valid header name and value.`);
        }
        headers[name] = value;
    }

    return headers;
}
