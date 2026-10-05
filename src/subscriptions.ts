import type { Customer, EndReason, LateReason, PaymentStatus, PullOutcome } from './answer.js';
import { customerOf } from './customer.js';
import { type MesubErrorCode, MesubError, MesubSubmitError } from './errors.js';
import { numberOf } from './options.js';
import { type QueryValue, type RequestOptions, type Transport, sleep } from './transport.js';
import {
    confirmResultFrom,
    serverSubscriptionFrom,
    serverSubscriptionListFrom,
    subscriptionAttemptListFrom,
    submitResultFrom,
    subscribeTransactionFrom,
    walletTransactionFrom,
} from './validate.js';

/**
 * Subscribing from your own server, with the API key (Mesub-io/backend#143):
 * `POST /v1/subscriptions`, its submit, the reads, and what stops one
 * (Mesub-io/backend#276): cancel, resume and close. The types copy the
 * back's `server-subscriptions.service.ts`, which stays the source of truth.
 * Snake case, as the API serves it.
 */

/**
 * A subscription's status. Unlike `/v1/access`, may be `expired`: a checkout
 * nobody signed (Mesub-io/backend#139). `superseded` is a stopped one the
 * wallet came back over (Mesub-io/backend#213): a newer row holds the
 * subscription. Never `none`: a row exists. `cancelled` reads `ended` once
 * its end date passed, as on `/v1/access` (Mesub-io/backend#236).
 */
export type ServerSubscriptionStatus =
    | 'pending'
    | 'active'
    | 'cancelled'
    | 'unpaid'
    | 'stopped'
    | 'ended'
    | 'failed'
    | 'expired'
    | 'superseded';

/** One subscription to your project's plans, as `GET /v1/subscriptions/:id` answers it. */
export interface ServerSubscription {
    id: string;
    status: ServerSubscriptionStatus;
    /** A seat parked over the project's cap, status unchanged, as `/v1/access` answers it. */
    paused: boolean;
    /** Why it ended, only on `ended`, as `/v1/access` answers it. */
    end_reason: EndReason | null;
    /** Why it is late, only on `unpaid`, as `/v1/access` answers it. */
    late_reason: LateReason | null;
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
    /**
     * Free only, as `/v1/access` answers it (Mesub-io/backend#191): when hand
     * retries close; past it the subscription stops. Read as null from a back
     * that predates it.
     */
    retry_deadline: string | null;
    /**
     * The retry due at `next_retry_at` and how many the missed period gets
     * (Mesub-io/backend#289): 2 and 3 before the second retry of three. Both
     * null unless Mesub retries on its own: not late, paused, stopped, on
     * Free. Read as null from a back that predates them.
     */
    next_retry_number: number | null;
    retries_allowed: number | null;
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

/**
 * What `submit` settled on: what Mesub answered, or, when its answer was lost
 * and the subscription read back is `active` or `cancelled`, that one.
 */
export interface SubmitResult {
    /**
     * `active`, or `cancelled` if the wallet set an end (`ended` once that
     * end passed); `pending` or `failed` with a `reason`.
     */
    subscription: ServerSubscription;
    /**
     * Mesub's own, set when nothing landed (`pending`) or what landed is not
     * Mesub's (`failed`). Never made up by the SDK.
     */
    reason?: string;
}

/**
 * What `cancel`, `resume` and `close` answer: a transaction only the wallet
 * signs, and sends itself. Mesub signs nothing of it.
 */
export interface WalletTransaction {
    /** Base64, signed by nobody: the wallet signs and sends it, then names its signature. */
    transaction: string;
    /** The block height past which it can no longer land. */
    last_valid_block_height: string;
}

/** What the wallet answered when it sent the transaction of `cancel`, `resume` or `close`. */
export interface ConfirmParams {
    /** The transaction's signature, base58. */
    signature: string;
}

/** What `confirmCancel`, `confirmResume` and `confirmClose` settled on. */
export interface ConfirmResult {
    /** The subscription as it is now: moved, or as it was with a `reason`. */
    subscription: ServerSubscription;
    /**
     * Mesub's own, set when nothing changed: the transaction failed, expired
     * before it landed, or the subscription moved on meanwhile.
     */
    reason?: string;
}

/** One page of a customer's subscriptions, newest first. */
export interface ServerSubscriptionList {
    data: ServerSubscription[];
    /** Ask for the next page with `starting_after` set to the last id of this one. */
    has_more: boolean;
}

/**
 * One pull attempt of a subscription, as `GET /v1/subscriptions/:id/attempts`
 * answers it (Mesub-io/backend#289): an attempt of `/v1/access`, with its id,
 * whether it was a retry and the period it was for.
 */
export interface SubscriptionAttempt {
    id: string;
    attempted_at: string;
    /** One of `PullOutcome` today; a newer one is handed on as is. */
    outcome: PullOutcome;
    /** Mesub's short reason, null on a paid one. */
    reason: string | null;
    /**
     * In the mint's smallest unit, as a string. What was asked for; on a
     * `paid` one that is what the transfer moved.
     */
    amount: string;
    /** Null when nothing was sent. */
    signature: string | null;
    /** The subscription had already failed on this period. */
    retry: boolean;
    /**
     * On a retry of the plan's, which one and out of how many, as recorded
     * when it ran: 1 is the first after the missed charge. Both null on a
     * first try, on a hand retry on Dev or Business, on an attempt that kept
     * none, and from a back that does not serve them.
     */
    retry_number: number | null;
    retries_allowed: number | null;
    /** The start of the period it was for; null when Mesub recorded none. */
    period_start: string | null;
}

/** One page of a subscription's attempts, newest first, and what it paid in all. */
export interface SubscriptionAttemptList {
    data: SubscriptionAttempt[];
    /** Ask for the next page with `starting_after` set to the last id of this one. */
    has_more: boolean;
    /**
     * Its `paid` attempts since it began and the sum of what they moved, in
     * the mint's smallest unit: counted by Mesub over all of them, not this page.
     */
    paid: { count: number; amount: string };
}

/** Which page of a subscription's attempts. */
export interface AttemptsParams {
    /** 1 to 100, 20 by default. */
    limit?: number;
    /** The id of the last attempt of the previous page. */
    starting_after?: string;
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

export interface SubmitOptions extends RequestOptions {
    /**
     * Per send, in milliseconds: 90 s by default. Lower it behind a proxy
     * or a function with a shorter limit (Cloudflare cuts at 100 s); a send
     * cut short may still be co-signed and land, so read the subscription
     * back afterwards.
     */
    timeout?: number;
    /**
     * The whole submit in milliseconds, its sends and the waits between
     * them: `timeout` plus 30 s by default, so 120 s. A send is cut at it,
     * and a wait that would outlast it is not waited. Reading the
     * subscription back once it is spent takes 10 s more at most, retries
     * included: 130 s in all by default.
     */
    budget?: number;
}

export interface ConfirmOptions extends RequestOptions {
    /**
     * In milliseconds: 90 s by default. Mesub waits for the transaction to
     * land or its blockhash to expire, about a minute. A confirm cut short
     * changed nothing: send it again with the same signature.
     */
    timeout?: number;
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
 * How long one send of `submit` waits by default. Mesub answers once the
 * transaction landed or its blockhash expired, about 150 blocks: a minute,
 * give or take.
 */
const SUBMIT_TIMEOUT = 90_000;
/**
 * What the whole submit gets beyond its first send's timeout, by default:
 * room for a replay, which Mesub answers from the chain, at once if the
 * blockhash has expired by then.
 */
const REPLAY_ROOM = 30_000;
/** The first send and two replays, at most. */
const MAX_SENDS = 3;
/** The wait before a replay when Mesub named none: what `network_unavailable` asks. */
const REPLAY_WAIT = 10_000;
/**
 * The read back once the sends are done, retries included: a submit never
 * takes longer than its budget plus this.
 */
const READ_BACK_TIME = 10_000;

/** How long a confirm waits by default: as one send of `submit`, for the same chain. */
const CONFIRM_TIMEOUT = SUBMIT_TIMEOUT;

/** What stops, takes back or closes a subscription: each a route, and its `/confirm`. */
type Action = 'cancel' | 'resume' | 'close';

/** How a submit whose outcome is unknown is settled from the subscription read back. */
interface Unsettled {
    sends: number;
    /** The last send's error. */
    cause: MesubError;
    /** Whose status, apiCode, body and retryAfter the error keeps. */
    from: MesubError;
    code: MesubErrorCode;
    retryable: boolean;
    /** What the message says first. */
    lead: string;
}

export class Subscriptions {
    readonly #transport: Transport;
    /**
     * Told of every subscription `submit`, `retrieve` and `list` answer, so
     * the client drops the cached access answers one that landed outdates.
     */
    readonly #seen: (subscription: ServerSubscription) => Promise<void>;

    /**
     * Told of the subscription a confirm moved, so the client drops every
     * access answer cached for its customer, the yes as well as the no.
     */
    readonly #changed: (subscription: ServerSubscription) => Promise<void>;

    /** @internal */
    constructor(
        transport: Transport,
        seen: (subscription: ServerSubscription) => Promise<void> = async () => {},
        changed: (subscription: ServerSubscription) => Promise<void> = seen,
    ) {
        this.#transport = transport;
        this.#seen = seen;
        this.#changed = changed;
    }

    /**
     * Reserves a subscription to that plan for that wallet, and builds what
     * it signs: `terms.message`, then `transaction`. Hand both to your front,
     * then their signatures to `submit`. Called again for the same plan,
     * wallet and customer (`external_id`, else `email`) while nothing landed,
     * it answers the same subscription with a fresh transaction. Another
     * customer naming that wallet gets a subscription of its own
     * (Mesub-io/backend#311): only the one the wallet signs for lands, and
     * the others then expire. Sent once, never retried.
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
     * waits for the chain, so one send takes up to a minute or so: 90 s
     * unless `options.timeout` says otherwise.
     *
     * When the send gets no answer that says what became of it (a timeout,
     * a network error, a 5xx), or an error Mesub marks `retryable`, the same
     * request, the same body, is sent again, up to twice, after the
     * `Retry-After` Mesub asked for or 10 s, within `options.budget` (120 s
     * by default). That is safe since Mesub-io/backend#190 and #202: Mesub
     * recognises the transaction and the terms signature it already
     * co-signed, signs nothing again, and answers from the chain or from the
     * subscription it settled. Its answer is then returned as if the first
     * send had got it, a `pending` with Mesub's own `reason` included.
     *
     * When no send got an answer, the subscription is read back once, within
     * 10 s: it is returned if `active` or `cancelled` (it landed), and
     * otherwise a `MesubSubmitError` `unavailable` is thrown with it attached
     * as `subscription` (null if that read failed too): the wallet may have
     * paid and the transaction may still land, so read it again with
     * `retrieve` rather than create anew. A 2xx this SDK cannot read is read
     * back the same way, and thrown as `unexpected`; so is a replay refused
     * with `not_awaiting_signature` after a send that got no answer, thrown
     * as that `conflict`.
     *
     * Any other refusal (`terms_expired`, `transaction_expired`, ...) is
     * thrown as is.
     * An abort through `options.signal` stops everything, sends, waits and
     * the read back, and rejects with the signal's reason; a send already out
     * may have been co-signed, so read the subscription back.
     *
     * A subscription returned with `access` (`active`, or `cancelled` before
     * its end) drops the `/v1/access` answers cached for that customer (its
     * wallet, external id and email) that still say no: `hasAccess` right
     * after asks Mesub again.
     */
    async submit(
        id: string,
        params: SubmitParams,
        options: SubmitOptions = {},
    ): Promise<SubmitResult> {
        const result = await this.#submit(id, params, options);

        await this.#seen(result.subscription);
        return result;
    }

    async #submit(id: string, params: SubmitParams, options: SubmitOptions): Promise<SubmitResult> {
        const path = `${pathOf(id)}/submit`;
        // Built once: every send carries exactly this body.
        const body = { transaction: params.transaction, terms_signature: params.terms_signature };
        const { signal } = options;
        // Checked here too: the budget is worked out from it.
        const timeout = numberOf('timeout', options.timeout, SUBMIT_TIMEOUT, { delay: true });
        const budget = options.budget ?? timeout + REPLAY_ROOM;
        if (!Number.isFinite(budget) || budget <= 0) {
            throw new TypeError(`budget must be a positive number of ms, not ${budget}.`);
        }
        const deadline = Date.now() + budget;
        /** Whether a send got no answer that says what became of it. */
        let lost = false;
        /** The last send's error that came with a response. */
        let responded: MesubError | null = null;

        for (let sent = 1; ; sent++) {
            let error: MesubError;
            try {
                const answer = await this.#transport.post(path, body, {
                    timeout,
                    deadline,
                    ...(signal !== undefined && { signal }),
                });
                return submitResultFrom(answer);
            } catch (caught) {
                // The caller's abort, as is: nothing more is sent nor read.
                if (!(caught instanceof MesubError)) throw caught;
                error = caught;
            }

            const lostBefore = lost;
            if (unanswered(error)) lost = true;
            if (error.status !== null) responded = error;
            const unsettled = { sends: sent, cause: error, from: error, lead: error.message };

            // Mesub answered, and this SDK cannot read what: the row says.
            if (error.status !== null && error.status < 300) {
                return this.#settle(id, signal, {
                    ...unsettled,
                    code: 'unexpected',
                    retryable: false,
                });
            }
            // The row moved on (failed, expired) since a send that got no
            // answer, which may have been co-signed: the row says what it is.
            if (lostBefore && error.apiCode === 'not_awaiting_signature') {
                return this.#settle(id, signal, {
                    ...unsettled,
                    code: error.code,
                    retryable: error.retryable,
                });
            }

            const replay = error.status === null || error.retryable;
            const wait = error.retryAfter ?? REPLAY_WAIT;
            if (!replay || sent >= MAX_SENDS || Date.now() + wait >= deadline) {
                // A refusal is Mesub's word on the request, whatever was lost
                // before. A send that got no answer, or a retryable refusal
                // after one, leaves it to the row.
                if (!lost || (!unanswered(error) && !error.retryable)) throw error;
                return this.#settle(id, signal, {
                    ...unsettled,
                    from: responded ?? error,
                    code: 'unavailable',
                    retryable: true,
                    lead:
                        `Mesub never said what became of the submit, sent ${sent} ` +
                        `${sent === 1 ? 'time' : 'times'}: ${error.message}`,
                });
            }

            await sleep(wait, signal);
        }
    }

    /**
     * A submit whose outcome is unknown, settled from the subscription read
     * back: returned if it landed, thrown with it otherwise.
     */
    async #settle(
        id: string,
        signal: AbortSignal | undefined,
        { sends, cause, from, code, retryable, lead }: Unsettled,
    ): Promise<SubmitResult> {
        const subscription = await this.#readBack(id, signal);

        if (subscription?.status === 'active' || subscription?.status === 'cancelled') {
            return { subscription };
        }

        const then =
            subscription === null
                ? 'Reading the subscription back failed too'
                : `The subscription read back is ${subscription.status}`;

        throw new MesubSubmitError(
            `${lead} ${then}: read it again with retrieve before creating anew.`,
            {
                status: from.status,
                code,
                apiCode: from.apiCode,
                retryable,
                body: from.body,
                retryAfter: from.retryAfter,
                cause,
                subscription,
                sends,
            },
        );
    }

    /**
     * The subscription after a submit, within `READ_BACK_TIME`: no attempt
     * nor retry wait goes past it. Null when it cannot be read; the caller's
     * abort is thrown as is.
     */
    async #readBack(
        id: string,
        signal: AbortSignal | undefined,
    ): Promise<ServerSubscription | null> {
        try {
            const body = await this.#transport.get(
                pathOf(id),
                {},
                {
                    deadline: Date.now() + READ_BACK_TIME,
                    ...(signal !== undefined && { signal }),
                },
            );
            return serverSubscriptionFrom(body);
        } catch (error) {
            if (signal?.aborted) throw error;
            return null;
        }
    }

    /**
     * Builds the transaction that cancels an `active`, `unpaid` or `stopped`
     * subscription. Hand it to your front: the subscription's wallet signs
     * and sends it, then `confirmCancel` takes the signature. Nothing is
     * cancelled until then. Sent once, never retried.
     *
     * One paid up keeps its access to the end of its period; a late or
     * stopped one has none, and its missed period is never collected.
     */
    async cancel(id: string, options: RequestOptions = {}): Promise<WalletTransaction> {
        return this.#build('cancel', id, options);
    }

    /**
     * Settles a cancellation the wallet sent, by the signature it answered:
     * `cancelled`, or the subscription as it was with a `reason` when nothing
     * landed. Mesub waits for the chain, so up to a minute or so: 90 s unless
     * `options.timeout` says otherwise. Sent once, never retried; the same
     * confirm sent again is answered the same.
     *
     * Settled without a `reason`, it drops every `/v1/access` answer cached
     * for that customer on that plan: `access` right after asks Mesub again.
     */
    async confirmCancel(
        id: string,
        params: ConfirmParams,
        options: ConfirmOptions = {},
    ): Promise<ConfirmResult> {
        return this.#confirm('cancel', id, params, options);
    }

    /**
     * Builds the transaction that takes a `cancelled` subscription back,
     * before the period it paid for is over. Hand it to your front: the
     * wallet signs and sends it, then `confirmResume` takes the signature.
     * Sent once, never retried.
     */
    async resume(id: string, options: RequestOptions = {}): Promise<WalletTransaction> {
        return this.#build('resume', id, options);
    }

    /** As `confirmCancel`, for a resume: `active` again, or a `reason`. */
    async confirmResume(
        id: string,
        params: ConfirmParams,
        options: ConfirmOptions = {},
    ): Promise<ConfirmResult> {
        return this.#confirm('resume', id, params, options);
    }

    /**
     * Builds the transaction that closes the wallet's authorisation on a
     * subscription that is over, a cancelled or stopped one past its end:
     * its rent goes back to the wallet. Hand it to your front: the wallet
     * signs and sends it, then `confirmClose` takes the signature. Sent once,
     * never retried.
     */
    async close(id: string, options: RequestOptions = {}): Promise<WalletTransaction> {
        return this.#build('close', id, options);
    }

    /** As `confirmCancel`, for a close: `ended` with `end_reason` `closed`, or a `reason`. */
    async confirmClose(
        id: string,
        params: ConfirmParams,
        options: ConfirmOptions = {},
    ): Promise<ConfirmResult> {
        return this.#confirm('close', id, params, options);
    }

    async #build(action: Action, id: string, options: RequestOptions): Promise<WalletTransaction> {
        const path = `${pathOf(id)}/${action}`;

        // No body: the wallet is the subscription's own.
        return walletTransactionFrom(
            await this.#transport.post(path, undefined, options),
            `POST /v1/subscriptions/:id/${action}`,
        );
    }

    async #confirm(
        action: Action,
        id: string,
        params: ConfirmParams,
        options: ConfirmOptions,
    ): Promise<ConfirmResult> {
        const path = `${pathOf(id)}/${action}/confirm`;
        const result = confirmResultFrom(
            await this.#transport.post(
                path,
                { signature: params.signature },
                { ...options, timeout: options.timeout ?? CONFIRM_TIMEOUT },
            ),
            `POST /v1/subscriptions/:id/${action}/confirm`,
        );

        // A reason says nothing moved: only a cached no may be outdated then.
        await (result.reason === undefined ? this.#changed : this.#seen)(result.subscription);
        return result;
    }

    /**
     * One subscription of your project, by id. Found with `access`, it drops
     * the access answers cached that still say no, as `submit` does.
     */
    async retrieve(id: string, options: RequestOptions = {}): Promise<ServerSubscription> {
        const subscription = serverSubscriptionFrom(
            await this.#transport.get(pathOf(id), {}, options),
        );

        await this.#seen(subscription);
        return subscription;
    }

    /**
     * A customer's subscriptions, newest first, one page at a time; expired
     * checkouts included. `listAll` walks every page.
     *
     * The customer is named as for `access`, and normalised the same way;
     * none or two of `wallet`, `external_id` and `email` throws a TypeError.
     * Each one with `access` drops the access answers cached that still say
     * no, as `submit` does.
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

        const page = serverSubscriptionListFrom(
            await this.#transport.get('/v1/subscriptions', query, options),
        );

        for (const subscription of page.data) await this.#seen(subscription);
        return page;
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

    /**
     * That subscription's own pull attempts, newest first, one page at a
     * time, and `paid`: what it paid since it began, whatever the page.
     * `allAttempts` walks every page.
     *
     * The id asked and no other: a subscription the wallet came back over
     * (`superseded`) keeps its own payments, and the one that replaced it
     * starts from its first pull. Needs a Mesub that serves the route
     * (Mesub-io/backend#289): from an older one it throws a `not_found`
     * whose `apiCode` is null, where an id it does not hold is a `not_found`
     * whose `apiCode` is `subscription_not_found`.
     */
    async attempts(
        id: string,
        params: AttemptsParams = {},
        options: RequestOptions = {},
    ): Promise<SubscriptionAttemptList> {
        const { limit, starting_after } = params;

        const path = `${pathOf(id)}/attempts`;

        try {
            return subscriptionAttemptListFrom(
                await this.#transport.get(path, { limit, starting_after }, options),
            );
        } catch (error) {
            if (!(error instanceof MesubError) || !routeMissing(error)) throw error;

            // Said for what it is, not as a wrong baseUrl.
            throw new MesubError(
                'This Mesub does not serve GET /v1/subscriptions/:id/attempts yet.',
                { status: 404, code: 'not_found', body: error.body, cause: error },
            );
        }
    }

    /**
     * Every attempt `attempts` would answer, page after page, for `for await`.
     * Each page is one call, made when the previous one is used up.
     */
    async *allAttempts(
        id: string,
        params: AttemptsParams = {},
        options: RequestOptions = {},
    ): AsyncGenerator<SubscriptionAttempt, void, undefined> {
        let page = await this.attempts(id, params, options);
        yield* page.data;

        while (page.has_more && page.data.length > 0) {
            page = await this.attempts(
                id,
                { ...params, starting_after: page.data.at(-1)!.id },
                options,
            );
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

/** Mesub's own 404 for a route it does not have: `Cannot GET /v1/...`, never a subscription's. */
function routeMissing(error: MesubError): boolean {
    const { message } = (error.body ?? {}) as { message?: unknown };

    return (
        error.status === 404 &&
        error.apiCode === null &&
        typeof message === 'string' &&
        message.startsWith('Cannot GET /')
    );
}

/**
 * No answer that says what became of the submit: a timeout, a network error,
 * or a 5xx (a proxy's 502 or 504 among them) after Mesub may have co-signed.
 */
function unanswered(error: MesubError): boolean {
    return error.status === null || error.status >= 500;
}
