import { API_HOSTS, GRAPHQL_PATH, GUEST_ACTIVATE_PATH, WEB_BEARER } from '../config.js';
import { logger } from '../logger.js';
import { FEATURES, type FeatureSet } from './features.js';
import { HttpClient, httpGetText } from './http.js';
import { resolveQueryId, type Operation } from './query-ids.js';
import {
    type RawSearchTimelineResponse,
    type RawTweetByIdResponse,
    type RawTweetResult,
    type RawUserByScreenNameResponse,
    type RawUserCore,
    type RawUserTweetsResponse,
} from './raw-types.js';
import { RequestErrorLike, withBackoff } from './retry.js';
import { type SearchCapability } from '../types.js';

export interface XClientOptions {
    proxyUrl?: string;
}

interface GuestState {
    token: string;
    cookie: string;
}

const COOKIE_KEY = 'cookie';

/**
 * Browserless client for X's internal GraphQL API.
 *
 * Session flow (verified empirically):
 *  1. warm-up GET x.com/home to collect the Cloudflare + guest cookies;
 *  2. POST api.twitter.com/1.1/guest/activate.json (public web bearer) for a guest token;
 *  3. GET x.com/i/api/graphql/{queryId}/{operation} with browser headers + cookies + guest token.
 * On 403 the guest token is rotated once and the call retried; on 429/5xx a bounded
 * backoff applies. Query IDs are resolved from the live JS bundle with a fallback.
 */
export class XClient {
    private readonly http: HttpClient;
    /** Non-proxied client: the query-ID bundle is a static CDN asset, no proxy needed. */
    private readonly directHttp: HttpClient;
    private guest: GuestState | null = null;
    private readonly queryIds = new Map<Operation, string>();
    private readonly guestHost: string;
    private homepageHtml = '';

    constructor(options: XClientOptions = {}) {
        this.http = new HttpClient(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {});
        this.directHttp = new HttpClient();
        this.guestHost = API_HOSTS[0];
    }

    close(): void {
        this.http.close();
        this.directHttp.close();
    }

    /** Warmed up + guest-activated + query IDs resolved. Idempotent. */
    async init(): Promise<void> {
        if (this.guest) return;
        await this.warmUp();
        await this.activateGuest();
        const ops: Operation[] = ['UserByScreenName', 'UserByRestId', 'UserTweets', 'TweetResultByRestId', 'SearchTimeline'];
        for (const op of ops) {
            this.queryIds.set(op, await resolveQueryId(op, { homepage: this.homepageHtml, fetchBundle: (url) => this.fetchBundle(url) }));
        }
    }

    /**
     * Fetches the query-ID bundle. It lives on the abs.twimg.com CDN and does
     * not need cookies or a proxied IP, so it is fetched direct (fast); on
     * failure we fall back to the proxied client, and only then to known IDs.
     */
    private async fetchBundle(url: string): Promise<string> {
        try {
            return await httpGetText(this.directHttp, url);
        } catch (err) {
            logger.warn({ err: String(err) }, 'Direct bundle fetch failed, falling back to proxied fetch');
            return httpGetText(this.http, url);
        }
    }

    private async warmUp(): Promise<void> {
        const res = await this.http.get('https://x.com/home');
        this.homepageHtml = await res.text();
        const jar: string[] = [];
        for (const cookie of res.headers.getSetCookie?.() ?? []) {
            jar.push(cookie.split(';')[0] ?? '');
        }
        this.guest = { token: '', cookie: jar.join('; ') };
        logger.debug({ cookies: jar.length }, 'Warm-up complete, cookie jar populated');
    }

    private async activateGuest(): Promise<string> {
        const url = `https://${this.guestHost}${GUEST_ACTIVATE_PATH}`;
        const res = await this.http.post(url, {
            headers: { Authorization: `Bearer ${WEB_BEARER}` },
        });
        const body = await res.text();
        if (!res.ok) {
            throw new RequestErrorLike(`Guest activation failed HTTP ${res.status}`, { status: res.status });
        }
        let token: string;
        try {
            token = (JSON.parse(body) as { guest_token?: string }).guest_token ?? '';
        } catch {
            token = '';
        }
        if (!token) {
            throw new RequestErrorLike('Guest activation returned no token', { status: res.status });
        }
        if (this.guest) this.guest.token = token;
        logger.debug('Guest token acquired');
        return token;
    }

    private graphqlUrl(operation: Operation, variables: Record<string, unknown>, features: FeatureSet): string {
        const queryId = this.queryIds.get(operation);
        if (!queryId) throw new Error(`No queryId for ${operation}`);
        const params = new URLSearchParams();
        params.set('variables', JSON.stringify(variables));
        params.set('features', JSON.stringify(FEATURES[features]));
        return `https://x.com${GRAPHQL_PATH}/${queryId}/${operation}?${params.toString()}`;
    }

    private graphqlHeaders(): Record<string, string> {
        const guest = this.guest;
        if (!guest) throw new Error('XClient not initialized');
        const headers: Record<string, string> = {
            Authorization: `Bearer ${WEB_BEARER}`,
            'content-type': 'application/json',
            'x-guest-token': guest.token,
        };
        if (guest.cookie) headers[COOKIE_KEY] = guest.cookie;
        return headers;
    }

    private async graphql<T>(operation: Operation, variables: Record<string, unknown>, features: FeatureSet): Promise<T> {
        await this.init();
        const url = this.graphqlUrl(operation, variables, features);

        const attempt = async (): Promise<T> => {
            const res = await this.http.get(url, { headers: this.graphqlHeaders() });
            const body = await res.text();
            if (res.status === 429) {
                // A rate-limited token is burned: rotating it now means the next
                // retry (and the catch below) uses a fresh token instead of
                // hammering the same one for the whole backoff budget.
                logger.warn({ operation }, 'GraphQL 429, rotating guest token mid-retry');
                await this.activateGuest();
                throw new RequestErrorLike(`GraphQL ${operation} failed HTTP 429`, { status: 429 });
            }
            if (!res.ok) {
                throw new RequestErrorLike(`GraphQL ${operation} failed HTTP ${res.status}`, { status: res.status });
            }
            return JSON.parse(body) as T;
        };

        // Same-token retries are kept small: 429 (rate limit) and 403 (auth) are
        // resolved by rotating the token / session, not by burning the backoff
        // budget on a dead token. The surfaces layer rotates the whole session
        // (new IP + fresh token) when this still fails.
        return withBackoff(attempt, {
            attempts: 2,
            onRetry: (attemptNo, delayMs, err) =>
                logger.warn({ operation, attempt: attemptNo, delayMs, err: String(err) }, 'GraphQL retry'),
        }).catch(async (err: unknown) => {
            const status = err instanceof RequestErrorLike ? err.status : undefined;
            if (status === 403) {
                logger.warn({ operation }, 'GraphQL 403, rotating guest token and retrying once');
                await this.activateGuest();
                return attempt();
            }
            throw err;
        });
    }

    /** Profile for a handle. */
    async getUserByScreenName(screenName: string): Promise<RawUserByScreenNameResponse> {
        return this.graphql<RawUserByScreenNameResponse>(
            'UserByScreenName',
            { screen_name: screenName, withSafetyModeUserFields: true, withSuperFollowsUserFields: true },
            'profile',
        );
    }

    /** Timeline for a user (optionally paging from a cursor). */
    async getUserTweets(userId: string, options: { count?: number; cursor?: string } = {}): Promise<RawUserTweetsResponse> {
        return this.graphql<RawUserTweetsResponse>(
            'UserTweets',
            {
                userId,
                count: options.count ?? 20,
                cursor: options.cursor ?? '',
                includePromotedContent: false,
                withQuickPromoteEligibilityTweetFields: true,
                withSuperFollowsUserFields: true,
                withDownvotePerspective: false,
                withReactionsMetadata: false,
                withReactionsPerspective: false,
                withSuperFollowsTweetFields: true,
                withVoice: true,
                withV2Timeline: true,
            },
            'timeline',
        );
    }

    /** Fully hydrated tweet by id. */
    async getTweetById(tweetId: string): Promise<RawTweetByIdResponse> {
        return this.graphql<RawTweetByIdResponse>(
            'TweetResultByRestId',
            {
                tweetId,
                includePromotedContent: true,
                withVoice: true,
                withCommunity: true,
                withQuickPromoteEligibilityTweetFields: true,
                withBirdwatchNotes: false,
                withReactionsMetadata: false,
                withReactionsPerspective: false,
                withSuperFollowsTweetFields: true,
                withArticleRichContentState: true,
                withGrokAnalyze: false,
            },
            'tweetById',
        );
    }

    /** Free-text search timeline (bonus surface). Guests are frequently walled (404). */
    async searchTimeline(rawQuery: string, options: { product?: string; count?: number; cursor?: string } = {}): Promise<RawSearchTimelineResponse> {
        return this.graphql<RawSearchTimelineResponse>(
            'SearchTimeline',
            {
                rawQuery,
                count: options.count ?? 20,
                cursor: options.cursor ?? '',
                querySource: 'typed_query',
                product: options.product ?? 'Latest',
                includePromotedContent: false,
            },
            'search',
        );
    }
}

/**
 * Probes whether SearchTimeline is guest-reachable from the current session/IP.
 * X hides auth-walled operations behind 404 (rather than 401), so any non-200
 * response other than rate limiting is treated as walled (fail-closed).
 */
export async function probeSearch(client: XClient): Promise<SearchCapability> {
    try {
        const response = await client.searchTimeline('x', { count: 1, product: 'Latest' });
        const instructions = response?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
        return Array.isArray(instructions) ? 'supported' : 'walled';
    } catch (err) {
        const status = err instanceof RequestErrorLike ? err.status : undefined;
        if (status === 429) return 'rate_limited';
        return 'walled';
    }
}

/** Extracts the tweet result from the by-id response, guarding tombstones. */
export function tweetResultFromById(response: RawTweetByIdResponse): RawTweetResult | null {
    const result = response.data?.tweetResult?.result;
    if (!result || result.__typename === 'TweetTombstone' || result.__typename === 'TweetUnavailable') return null;
    return result;
}

/** Resolves userId from a profile response (rest_id or legacy id_str). */
export function userIdFromProfile(response: RawUserByScreenNameResponse): string | null {
    const result = response.data?.user?.result as RawUserCore | undefined;
    return result?.rest_id ?? result?.legacy?.id_str ?? null;
}