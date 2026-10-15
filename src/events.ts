import { MesubError } from './errors.js';
import { routeMissing } from './subscriptions.js';
import type { RequestOptions, Transport } from './transport.js';
import { eventFrom, eventListFrom } from './validate.js';
import type { EventType, MesubEvent } from './webhooks.js';

/**
 * Your project's subscription events (Mesub-io/backend#482): `GET /v1/events`
 * and `GET /v1/events/:id`, each event the very body its webhooks carry. The
 * types copy the back's `server-events.service.ts`, which stays the source
 * of truth. Snake case, as the API serves it.
 */

/** One page of events, newest first. */
export interface EventList {
    data: MesubEvent[];
    /** Ask for the next page with `starting_after` set to the last id of this one. */
    has_more: boolean;
    /**
     * When Mesub began keeping events in this shape: events before it are
     * never served, whatever the window. Their webhooks carried the older
     * shape, with no event id.
     */
    available_since: string;
}

/** Which events, and which page of them. */
export interface EventListParams {
    /** Only events of this type. */
    type?: EventType;
    /** Only events about this subscription, by its id. */
    subscription?: string;
    /** 1 to 100, 25 by default. */
    limit?: number;
    /** The id of the last event of the previous page. */
    starting_after?: string;
}

export class Events {
    readonly #transport: Transport;

    /** @internal */
    constructor(transport: Transport) {
        this.#transport = transport;
    }

    /**
     * Your project's events of the last 30 days, newest first, one page at a
     * time: each the very body its webhooks carried, the same `id`, `data`
     * and `detail`. Read it to catch up on what an endpoint missed while it
     * was down or turned off. Events before `available_since` are never
     * served, whatever the window.
     *
     * An event is listed a moment after its `created_at`, so one can appear
     * below one already read: when polling for what is new, page on until
     * `created_at` is a minute older than the newest you held, and skip the
     * ids you have seen.
     *
     * Needs a Mesub that serves the route (Mesub-io/backend#482): from an
     * older one it throws a `not_found` whose `apiCode` is null.
     */
    async list(params: EventListParams = {}, options: RequestOptions = {}): Promise<EventList> {
        const { type, subscription, limit, starting_after } = params;

        return eventListFrom(
            await this.#get('/v1/events', { type, subscription, limit, starting_after }, options),
        );
    }

    /**
     * One event, by the `id` its webhook body carries, as `list` serves it.
     * A `not_found` whose `apiCode` is `event_not_found` for an id older than
     * 30 days or than `available_since`, or of another project. A delivery's
     * `webhook-id` is not an event id: read `event.id`, not `delivery_id`.
     */
    async retrieve(id: string, options: RequestOptions = {}): Promise<MesubEvent> {
        return eventFrom(await this.#get(pathOf(id), {}, options));
    }

    async #get(
        path: string,
        query: Record<string, string | number | undefined>,
        options: RequestOptions,
    ): Promise<unknown> {
        try {
            return await this.#transport.get(path, query, options);
        } catch (error) {
            if (!(error instanceof MesubError) || !routeMissing(error)) throw error;

            // Said for what it is, not as a wrong baseUrl.
            throw new MesubError('This Mesub does not serve GET /v1/events yet.', {
                status: 404,
                code: 'not_found',
                body: error.body,
                requestId: error.requestId,
                cause: error,
            });
        }
    }
}

/** An id as Mesub writes them, and the only kind it reads. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function pathOf(id: string): string {
    // `.` and `..` survive encoding and the URL resolves them; an empty one
    // would ask the list. Refused before it is sent.
    if (typeof id !== 'string' || !ID.test(id)) {
        throw new MesubError(
            'An event id is letters, digits, hyphens and underscores, 64 at most.',
            { status: null, code: 'invalid_request' },
        );
    }
    return `/v1/events/${id}`;
}
