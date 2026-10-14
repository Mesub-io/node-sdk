import { MesubError } from './errors.js';
import type { RequestOptions, Transport } from './transport.js';
import { planFrom, planListFrom } from './validate.js';

/** A plan a subscriber can hold: taking new ones (`active`), or ending (`sunset`). */
export type PlanStatus = 'active' | 'sunset';

/**
 * What Mesub knows of a plan's token, resolved by its mint: never from the
 * merchant nor the client. A symbol is free text on chain and a fake "USDC"
 * is a known scam: show an unverified token as unverified, with its mint.
 */
export interface PlanToken {
    /** Null when Mesub found none, and on an unverified token named like a vouched stablecoin. */
    symbol: string | null;
    name: string | null;
    logo_url: string | null;
    /** True for a mint Mesub vouches for, or one Jupiter marks verified. */
    verified: boolean;
}

/** A plan of your project, as a pricing page needs it. */
export interface Plan {
    /** What `access`, the guards and `subscriptions.create` name it by. */
    slug: string;
    /** The plan's name, or its slug when none was given. */
    name: string;
    description: string | null;
    project_name: string;
    logo_url: string | null;
    /** The price in the token's base units, a string: a u64 does not survive a float. */
    amount: string;
    /** The price as a person counts it: `"9.99"`. */
    amount_display: string;
    /**
     * The plan's amount in dollars at the latest price Mesub knows, a decimal
     * string such as `"9.99"`: an estimate to show beside the amount, never
     * what is charged. Null when Mesub knows no price, and from a Mesub that
     * predates it.
     */
    amount_usd: string | null;
    decimals: number;
    /** Set only for a mint Mesub vouches for (USDC, USDT, PYUSD), null for any other. */
    symbol: string | null;
    /**
     * The token's symbol, name and logo for any mint, and whether it is
     * verified: when it is not, say so and keep `mint` visible. All null and
     * unverified from a Mesub that predates it.
     */
    token: PlanToken;
    mint: string;
    period_hours: number;
    network: 'devnet' | 'mainnet-beta';
    status: PlanStatus;
    /** Whether it takes new subscribers now: show "Subscribe" only when true. */
    available: boolean;
    /**
     * When the plan ends, null when it has no end: nobody has access past
     * it, and the last period before it is charged in full.
     */
    ends_at: string | null;
}

/** `mesub.plans`: the plans of your project, for a pricing page. */
export class Plans {
    readonly #transport: Transport;

    /** @internal */
    constructor(transport: Transport) {
        this.#transport = transport;
    }

    /**
     * Every plan of your project a subscriber can hold, sorted by slug: the
     * active ones, and the ones ending (`sunset`, `available: false`). Never
     * cached: call it where you render, and cache it your way.
     */
    async list(options: RequestOptions = {}): Promise<Plan[]> {
        return planListFrom(await this.#transport.get('/v1/plans', {}, options));
    }

    /** One plan by its slug. A slug your project lacks throws `plan_not_found`. */
    async retrieve(slug: string, options: RequestOptions = {}): Promise<Plan> {
        return planFrom(await this.#transport.get(pathOf(slug), {}, options));
    }
}

/**
 * A slug as Mesub writes them: lowercase letters, digits and single hyphens,
 * with at least one letter, so a slug never reads as a number.
 */
const SLUG = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/;

function pathOf(slug: string): string {
    // Anything else would reach another route, or the list: refused before it is sent.
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
        throw new MesubError(
            'A plan slug is lowercase letters, digits and hyphens, with at least one letter.',
            { status: null, code: 'invalid_request' },
        );
    }
    return `/v1/plans/${slug}`;
}
