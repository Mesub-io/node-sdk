/** Kept in step with package.json by `test/version.spec.ts`. */
export const VERSION = '0.1.0';

/**
 * The version of the Mesub API this release was written against, sent in
 * the `Mesub-Version` header of every call, so the API can change its
 * answers for newer releases without breaking this one. Moved only with a
 * release, never by a merchant.
 */
export const API_VERSION = '2026-10-02';

/** The header `API_VERSION` is sent in. */
export const API_VERSION_HEADER = 'Mesub-Version';
