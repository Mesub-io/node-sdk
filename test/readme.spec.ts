import type { Request } from 'express';

import { requirePlan } from '../src/express.js';
import { type MesubRequest, RequirePlan } from '../src/nest.js';
import { FakeMesub } from '../src/testing.js';

/**
 * The README's "your own login" snippets, compiled: they read `req.user`,
 * which neither Express's request nor ours declares. If one stops
 * typechecking, `pnpm typecheck` fails here before a merchant copies it.
 */

/** What a merchant's own login leaves on an Express request. */
type WithUser = Request & { user?: { id: string } };

/** The request as a merchant's own Nest guard leaves it. */
interface AuthedRequest extends MesubRequest {
    user?: { id: string };
}

describe('the README snippets for your own login', () => {
    const client = new FakeMesub().client();

    it('builds the Express guard from req.user', () => {
        const guard = requirePlan('pro', {
            client,
            customer: (req) => {
                const { user } = req as WithUser;

                return user ? { external_id: user.id } : null;
            },
        });

        expect(guard).toBeTypeOf('function');
    });

    it('builds the Nest guard from a request typed by the merchant, with no cast', () => {
        const guard = RequirePlan<AuthedRequest>('pro', {
            client,
            customer: (req) => (req.user ? { external_id: req.user.id } : null),
            onDenied: (_denial, req) => req.user?.id,
        });

        expect(guard).toBeTypeOf('function');
    });

    it('still takes a guard with no request type named', () => {
        expect(RequirePlan('pro', { client, customer: () => null })).toBeTypeOf('function');
    });
});
