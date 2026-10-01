import type { AccessAnswer } from './answer.js';
import { type Decision, Mesub } from './client.js';
import { MesubError } from './errors.js';
import { type HeaderSource, tokenFrom, type VerifiedToken } from './tokens.js';

/** Why a request was turned away, and what it answers by default. */
export type DenialReason = 'unauthenticated' | 'no_access' | 'unavailable';

/**
 * Where a guard takes the wallet from instead of a Mesub access token: the
 * merchant's own verified session. `null` or `undefined` means nobody is
 * signed in, answered 401.
 */
export type WalletResolver<Args extends unknown[]> = (...args: Args) => WalletResult;

export type WalletResult = string | null | undefined | Promise<string | null | undefined>;

/** Who a guard decided about. `userId` only when a Mesub access token said it. */
export interface Subscriber {
    userId: string | null;
    wallet: string;
}

export type GuardOutcome =
    | { allowed: true; subscriber: Subscriber; decision: Decision }
    | { allowed: false; reason: DenialReason; decision?: Decision };

/** Who is asking and what Mesub answered, as a guarded route receives it. */
export interface MesubAccess {
    /**
     * The Mesub user behind the access token. `null` when the wallet came
     * from your own auth, through the `wallet` option.
     */
    userId: string | null;
    wallet: string;
    answer: AccessAnswer | null;
    /** The answer came from the outage fallback. */
    stale: boolean;
}

/** A refusal, as `onDenied` receives it. */
export interface Denial {
    reason: DenialReason;
    /** 401, 402 or 503: what would be answered without `onDenied`. */
    status: number;
    answer: AccessAnswer | null;
}

/** What a guard answers by default for each refusal. */
export const DENIAL_STATUS: Record<DenialReason, number> = {
    unauthenticated: 401,
    no_access: 402,
    unavailable: 503,
};

/** Seconds a client should wait before asking again when Mesub is unreachable. */
export const UNAVAILABLE_RETRY_AFTER_S = 30;

let shared: Mesub | undefined;

/** The client a middleware uses when given none: built once, from MESUB_API_KEY. */
export function defaultClient(): Mesub {
    shared ??= new Mesub();

    return shared;
}

/**
 * The shape of every Solana address, as the back checks it: base58 without
 * the four ambiguous characters, 32 to 44 of them.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The one decision every middleware makes: who is asking, then whether they
 * have access.
 *
 * Who is asking comes from one place only. With `resolveWallet`, the
 * merchant's own verified session, and the access token is never read.
 * Without it, the Mesub access token, and never anything the request names.
 *
 * - no token, one that fails verification, or a resolver answering null or
 *   undefined: `unauthenticated`
 * - the keys or the project id could not be fetched: `unavailable`, since
 *   nobody can be identified, so not even the outage fallback can apply
 * - the fallback of `hasAccess` otherwise, through `decide`
 *
 * An integration error (a bad API key, an unknown plan, a resolver returning
 * something that is not an address, or throwing) is thrown.
 */
export async function guard(
    client: Mesub,
    headers: HeaderSource,
    plan: string,
    resolveWallet?: () => WalletResult,
): Promise<GuardOutcome> {
    const subscriber = resolveWallet
        ? await fromResolver(resolveWallet)
        : await fromToken(client, headers);

    if ('reason' in subscriber) return { allowed: false, reason: subscriber.reason };

    const decision = await client.decide(subscriber.wallet, plan);

    return decision.access
        ? { allowed: true, subscriber, decision }
        : { allowed: false, reason: 'no_access', decision };
}

async function fromToken(
    client: Mesub,
    headers: HeaderSource,
): Promise<Subscriber | { reason: DenialReason }> {
    const token = tokenFrom({ headers });

    if (!token) return { reason: 'unauthenticated' };

    try {
        const verified: VerifiedToken = await client.verifyToken(token);

        return { userId: verified.userId, wallet: verified.wallet };
    } catch (error) {
        if (error instanceof MesubError && error.code === 'invalid_token') {
            return { reason: 'unauthenticated' };
        }
        if (error instanceof MesubError && error.code === 'unavailable') {
            return { reason: 'unavailable' };
        }

        throw error;
    }
}

/**
 * The wallet from the merchant's resolver. Nothing is a 401; something that
 * is not an address is a bug in their integration (the user id or the email
 * returned instead of the wallet), thrown rather than turned into a 401 that
 * would look like a sign-in problem. The value is left out of the message: it
 * may be an email.
 */
async function fromResolver(
    resolveWallet: () => WalletResult,
): Promise<Subscriber | { reason: DenialReason }> {
    const wallet: unknown = await resolveWallet();

    if (wallet === null || wallet === undefined) return { reason: 'unauthenticated' };

    if (typeof wallet !== 'string' || !BASE58_ADDRESS.test(wallet)) {
        const what = typeof wallet === 'string' ? 'a string' : `a ${typeof wallet}`;

        throw new MesubError(
            `The \`wallet\` option returned ${what} that is not a base58 Solana address.`,
            { status: null, code: 'invalid_request' },
        );
    }

    return { userId: null, wallet };
}

/** The body a refusal answers with. `status` only when there is an answer to read it from. */
export function denialBody(outcome: Extract<GuardOutcome, { allowed: false }>) {
    return {
        access: false,
        reason: outcome.reason,
        ...(outcome.decision?.answer ? { status: outcome.decision.answer.status } : {}),
    };
}

export function accessOf(outcome: Extract<GuardOutcome, { allowed: true }>): MesubAccess {
    return {
        userId: outcome.subscriber.userId,
        wallet: outcome.subscriber.wallet,
        answer: outcome.decision.answer,
        stale: outcome.decision.stale,
    };
}

export function denialOf(outcome: Extract<GuardOutcome, { allowed: false }>): Denial {
    return {
        reason: outcome.reason,
        status: DENIAL_STATUS[outcome.reason],
        answer: outcome.decision?.answer ?? null,
    };
}
