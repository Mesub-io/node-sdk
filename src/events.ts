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
