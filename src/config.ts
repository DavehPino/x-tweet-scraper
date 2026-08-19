import { FREE_TIER_CAP } from './types.js';

/**
 * Public web bearer token for X's internal API. A well-known constant (the
 * assessment hints it does not rotate like the per-operation query IDs).
 */
export const WEB_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const API_HOSTS = ['api.x.com', 'api.twitter.com'] as const;

/** GraphQL endpoint base. Full URL: <host>/i/api/graphql/{queryId}/{operationName} */
export const GRAPHQL_PATH = '/i/api/graphql';

/** Guest token activation endpoint. */
export const GUEST_ACTIVATE_PATH = '/1.1/guest/activate.json';

/** Free tier cap (see assessment §6). */
export const FREE_CAP = FREE_TIER_CAP;

/** Name of the server-side entitlements KV store. Only the actor owner can write to it. */
export const ENTITLEMENTS_STORE_NAME = 'x-tweet-scraper-entitlements';

/** HTTP retry policy (see assessment §7). */
export const RETRY = {
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 15_000,
    /** Randomize backoff by +/- this fraction. */
    jitter: 0.25,
};

/** Concurrency per author timeline during parallel paging. */
export const CONCURRENCY_PER_TARGET = 4;

/** User-Agent used for guest flows. */
export const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';