import type { Customer, PaymentStatus } from './answer.js';
import { customerOf } from './customer.js';
import { MesubError } from './errors.js';
import type { QueryValue, RequestOptions, Transport } from './transport.js';
import {
    serverSubscriptionFrom,
    serverSubscriptionListFrom,
    submitResultFrom,
    subscribeTransactionFrom,
} from './validate.js';

/**
 * Subscribing from your own server, with the API key (Mesub-io/backend#143):
 * `POST /v1/subscriptions`, its submit, and the reads. The types copy the
 * back's `server-subscriptions.service.ts`, which stays the source of truth.
 * Snake case, as the API serves it.
 */

/**
 * A subscription's status. Unlike `/v1/access`, may be `expired`: a checkout
 * nobody signed (Mesub-io/backend#139). Never `none`: a row exists.
 */
export type ServerSubscriptionStatus =
    'pending' | 'active' | 'cancelled' | 'unpaid' | 'stopped' | 'ended' | 'failed' | 'expired';

/** One subscription to your project's plans, as `GET /v1/subscriptions/:id` answers it. */
export interface ServerSubscription {
    id: string;
    status: ServerSubscriptionStatus;
    /** Whether it grants access now, as `/v1/access` answers it. */
    access: boolean;
    /** `paid`, `late` or `none`, as `/v1/access` answers it. */
    payment_status: PaymentStatus;
    /** The plan's slug. */
    plan: string | null;
    wallet: string;
    email: string | null;
    external_id: string | null;
    /** The period paid for last; null before the first. */
    current_period_start: string | null;
    current_period_end: string | null;
    /** The next charge on a running one, the next retry on a late one: never both. */
    next_charge_at: string | null;
    next_retry_at: string | null;
    /** When access ends unless a pull renews it; null while `access` is false. */
    access_until: string | null;
    created_at: string;
    confirmed_at: string | null;
}

/** What subscribing costs in SOL, in lamports, as strings: a u64 does not survive JSON. */
export interface SubscribeCosts {
    /** Given back to the subscriber when the accounts are closed. `authority` is null if it exists. */
    rent: { subscription: string; authority: string | null; total: string };
    /** Spent: the network's fee per signature, the wallet's and Mesub's. */
    fee: { signatures: number; per_signature: string; priority: string; total: string };
    total: string;
}

/** What `create` answers: what the wallet signs, terms first, then the transaction. */
export interface SubscribeTransaction {
    subscription: { id: string; status: ServerSubscriptionStatus };
    /** Base64, signed by nobody: the wallet signs it with signTransaction, without sending it. */
    transaction: string;
    last_valid_block_height: string;
    costs: SubscribeCosts;
    /** Signed as is with the wallet's signMessage, over its UTF-8 bytes, before `expires_at`. */
    terms: { message: string; expires_at: string };
}

/** What `submit` settled on. */
export interface SubmitResult {
    /** `active`, or `cancelled` if the wallet set an end; `pending` or `failed` with a `reason`. */
    subscription: ServerSubscription;
    /** Set when nothing landed (`pending`) or what landed is not Mesub's (`failed`). */
    reason?: string;
}

/** One page of a customer's subscriptions, newest first. */
export interface ServerSubscriptionList {
    data: ServerSubscription[];
    /** Ask for the next page with `starting_after` set to the last id of this one. */
    has_more: boolean;
}

export interface SubscribeParams {
    /** The plan's slug. */
    plan: string;
    /** The wallet that signs and pays. */
    wallet: string;
    /** Where the subscriber's notices go. Not verified by Mesub. */
    email?: string;
    /** Your own id for this customer, handed back as given. */
    external_id?: string;
}

export interface SubmitParams {
    /** The transaction of `create`, signed by the wallet, base64. */
    transaction: string;
    /** The wallet's signMessage over `terms.message`, base58. */
    terms_signature: string;
}

/**
 * Whose subscriptions to list: a `Customer`, named exactly one way and
 * normalised as `access` names them, and what narrows the page.
 */
export type ListParams = Customer & {
    /** Only this plan's, by slug. */
    plan?: string;
    /** 1 to 100, 20 by default. */
    limit?: number;
    /** The id of the last subscription of the previous page. */
    starting_after?: string;
};

/**
 * How long `submit` waits by default. Mesub answers once the transaction
 * landed or its blockhash expired, about 150 blocks: a minute, give or take.
 */
const SUBMIT_TIMEOUT = 90_000;

export class Subscriptions {
    readonly #transport: Transport;

    /** @internal */
    constructor(transport: Transport) {
        this.#transport = transport;
    }

    /**
     * Reserves a subscription to that plan for that wallet, and builds what
     * it signs: `terms.message`, then `transaction`. Hand both to your front,
     * then their signatures to `submit`. Called again for the same plan and
     * wallet while nothing landed, it answers the same subscription with a
     * fresh transaction. Sent once, never retried.
     */
    async create(
        params: SubscribeParams,
        options: RequestOptions = {},
    ): Promise<SubscribeTransaction> {
        const { plan, wallet, email, external_id } = params;
        const body = { plan, wallet, email, external_id };

        return subscribeTransactionFrom(
            await this.#transport.post('/v1/subscriptions', body, options),
        );
    }

    /**
     * Relays what the wallet signed. Mesub checks it, co-signs, sends it and
     * waits for the chain, so this takes up to a minute or so: the timeout is
     * 90 s unless `options.timeout` says otherwise.
     *
     * Sent once, never retried: a submit sent again would find its terms
     * spent while the first one lands. When no answer comes back (a timeout,
     * a network error, a 5xx), the subscription is read back once instead,
     * and its real state answered: `active` if it landed, else as it stands
     * with a `reason` saying no answer came. If that read fails too, the
     * submit's own error is thrown.
     */
    async submit(
        id: string,
        params: SubmitParams,
        options: RequestOptions = {},
    ): Promise<SubmitResult> {
        const path = `${pathOf(id)}/submit`;
        const body = { transaction: params.transaction, terms_signature: params.terms_signature };

        try {
            return submitResultFrom(
                await this.#transport.post(path, body, {
                    ...options,
                    timeout: options.timeout ?? SUBMIT_TIMEOUT,
                }),
            );
        } catch (error) {
            if (!unanswered(error)) throw error;

            let subscription: ServerSubscription;
            try {
                subscription = await this.retrieve(id, readBack(options));
            } catch {
                throw error;
            }

            if (subscription.status === 'active' || subscription.status === 'cancelled') {
                return { subscription };
            }
            return {
                subscription,
                reason:
                    `The submit got no answer (${error.message.replace(/\.$/, '')}), ` +
                    `and the subscription read back is ${subscription.status}.`,
            };
        }
    }

    /** One subscription of your project, by id. */
    async retrieve(id: string, options: RequestOptions = {}): Promise<ServerSubscription> {
        return serverSubscriptionFrom(await this.#transport.get(pathOf(id), {}, options));
    }

    /**
     * A customer's subscriptions, newest first, one page at a time; expired
     * checkouts included. `listAll` walks every page.
     *
     * The customer is named as for `access`, and normalised the same way;
     * none or two of `wallet`, `external_id` and `email` throws a TypeError.
     */
    async list(params: ListParams, options: RequestOptions = {}): Promise<ServerSubscriptionList> {
        const { kind, value } = customerOf(params);
        const { plan, limit, starting_after } = params;
        const query: Record<string, QueryValue> = {
            [kind]: value,
            plan,
            limit,
            starting_after,
        };

        return serverSubscriptionListFrom(
            await this.#transport.get('/v1/subscriptions', query, options),
        );
    }

    /**
     * Every subscription `list` would answer, page after page, for `for await`.
     * Each page is one call, made when the previous one is used up.
     */
    async *listAll(
        params: ListParams,
        options: RequestOptions = {},
    ): AsyncGenerator<ServerSubscription, void, undefined> {
        let page = await this.list(params, options);
        yield* page.data;

        while (page.has_more && page.data.length > 0) {
            page = await this.list({ ...params, starting_after: page.data.at(-1)!.id }, options);
            yield* page.data;
        }
    }
}

function pathOf(id: string): string {
    // An empty id would reach the list route and read as a missing customer.
    if (typeof id !== 'string' || id === '') {
        throw new MesubError('A subscription id is required.', {
            status: null,
            code: 'invalid_request',
        });
    }
    return `/v1/subscriptions/${encodeURIComponent(id)}`;
}

/**
 * No answer that says what became of the submit: a timeout, a network error,
 * or a 5xx (a proxy's 502 or 504 among them) after Mesub may have co-signed.
 */
function unanswered(error: unknown): error is MesubError {
    return error instanceof MesubError && (error.status === null || error.status >= 500);
}

/** The read after a submit keeps the caller's signal, and the client's own timeout. */
function readBack({ signal }: RequestOptions): RequestOptions {
    return signal === undefined ? {} : { signal };
}
