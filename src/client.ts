import { Transport } from './transport.js';

export interface MesubOptions {
    /** Secret API key. Defaults to `process.env.MESUB_API_KEY`. */
    apiKey?: string;
    /** Defaults to `https://api.mesub.io`. */
    baseUrl?: string;
    /** A custom `fetch`, e.g. one bound to your own agent. Defaults to the global one. */
    fetch?: typeof fetch;
    /** Per attempt, in milliseconds. Defaults to 5000. */
    timeout?: number;
    /** Retries after the first attempt. Defaults to 2. */
    maxRetries?: number;
}

const DEFAULT_BASE_URL = 'https://api.mesub.io';

export class Mesub {
    /** @internal */
    protected readonly transport: Transport;

    constructor(options: MesubOptions = {}) {
        const apiKey = options.apiKey || process.env['MESUB_API_KEY'];
        if (!apiKey) {
            throw new Error(
                'Missing Mesub API key: pass `new Mesub({ apiKey })` or set MESUB_API_KEY.',
            );
        }

        this.transport = new Transport({
            apiKey,
            baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
            // Resolved per call so a fetch patched after construction is still used.
            fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
            timeout: options.timeout ?? 5_000,
            maxRetries: options.maxRetries ?? 2,
        });
    }
}
