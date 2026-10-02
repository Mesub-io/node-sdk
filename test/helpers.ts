import { STATUS_CODES } from 'node:http';

import { vi } from 'vitest';

export type FetchCall = { url: URL; init: RequestInit };

/** A `fetch` answering from a list, one entry per call, recording what it was sent. */
export function mockFetch(...answers: Array<Response | Error | 'hang'>) {
    const calls: FetchCall[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: new URL(String(input)), init: init ?? {} });
        const answer = answers.shift();
        if (answer === undefined) throw new Error('mockFetch: no answer left');
        if (answer instanceof Error) throw answer;
        if (answer === 'hang') {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            });
        }
        return answer;
    });
    return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

export function nest(status: number, message: string | string[], error = 'Error') {
    return json(status, { message, error, statusCode: status });
}

/** The back's error body since its error codes (#180): Nest's, plus `code` and `retryable`. */
export function coded(
    status: number,
    code: string,
    message: string,
    retryable = false,
    headers: Record<string, string> = {},
) {
    return json(
        status,
        { statusCode: status, error: STATUS_CODES[status], message, code, retryable },
        headers,
    );
}
