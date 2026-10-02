import type { Customer } from './answer.js';

/** Who a call is about, normalised as Mesub reads it. */
export interface Asked {
    kind: 'wallet' | 'external_id' | 'email';
    value: string;
}

const CUSTOMER_KINDS = ['wallet', 'external_id', 'email'] as const;

/**
 * The one customer a call names, normalised the way Mesub normalises the
 * query (#157), so `Ada@Example.com ` and `ada@example.com` share an answer and
 * a cache key: an email trimmed and lowercased, an external id trimmed. A
 * wallet is left as given: Mesub refuses one that is not an address.
 *
 * None or two of them, or one that is not a string, throws a TypeError: a
 * broken integration, never a question to send. What the value holds (an
 * email that is not one, an external id too long) is Mesub's to refuse, with
 * a MesubError `invalid_request`.
 */
export function customerOf(customer: Customer | string): Asked {
    if (typeof customer === 'string') return { kind: 'wallet', value: customer };

    const named = CUSTOMER_KINDS.filter(
        (kind) => (customer as Record<string, unknown> | null)?.[kind] !== undefined,
    );
    const kind = named[0];
    const value: unknown = kind && (customer as Record<string, unknown>)[kind];

    if (named.length !== 1 || !kind || typeof value !== 'string') {
        throw new TypeError('Ask about exactly one of wallet, external_id or email, as a string.');
    }

    if (kind === 'email') return { kind, value: value.trim().toLowerCase() };
    if (kind === 'external_id') return { kind, value: value.trim() };

    return { kind, value };
}
