import { logger } from '../logger.js';

/**
 * Per-operation GraphQL query IDs. These change on every X deploy, so the
 * source of truth is the x.com JS bundle, extracted at runtime. The constants
 * below are the fallback when extraction fails.
 */
export const OPERATIONS = ['UserByScreenName', 'UserByRestId', 'UserTweets', 'TweetResultByRestId', 'SearchTimeline'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Fallback IDs extracted from the live bundle (updated whenever they change). */
export const FALLBACK_QUERY_IDS: Record<Operation, string> = {
    UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
    UserByRestId: 'xvmVfRLmnr1alc5f2dib0Q',
    UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
    TweetResultByRestId: 'GZsN2Pc4knAoit6pXa4HSA',
    SearchTimeline: 'hyPfJYJ_XAtDYoslQc-Rgg',
};

let cache: Partial<Record<Operation, string>> = {};
let bundleCache: { url: string; js: string } | null = null;

/** Extracts a queryId for one operation from the main x.com JS bundle. */
export async function resolveQueryId(operation: Operation, fetcher: (url: string) => Promise<string>): Promise<string> {
    const cached = cache[operation];
    if (cached) return cached;

    try {
        if (!bundleCache) {
            bundleCache = { url: await findMainBundleUrl(fetcher), js: '' };
        }
        if (!bundleCache.js) {
            bundleCache.js = await fetcher(bundleCache.url);
        }
        const id = extractQueryId(bundleCache.js, operation);
        if (!id) throw new Error(`queryId not found in bundle for ${operation}`);
        cache[operation] = id;
        logger.info({ operation, queryId: id, source: 'runtime' }, 'Query ID resolved from bundle');
        return id;
    } catch (err) {
        const fallback = FALLBACK_QUERY_IDS[operation];
        cache[operation] = fallback;
        logger.warn({ operation, err: String(err), queryId: fallback }, 'Query ID extraction failed, using fallback');
        return fallback;
    }
}

async function findMainBundleUrl(fetcher: (url: string) => Promise<string>): Promise<string> {
    const html = await fetcher('https://x.com/home');
    const preload = html.match(/<link rel="preload" as="script" href="([^"]+\/main\.[^"]+\.js)"/);
    if (preload?.[1]) return preload[1];
    const script = html.match(/<script[^>]+src="([^"]+\/main\.[^"]+\.js)"/);
    if (script?.[1]) return script[1];
    throw new Error('main JS bundle not found in x.com homepage');
}

function extractQueryId(js: string, operation: Operation): string | undefined {
    const direct = js.match(new RegExp(`queryId:"([^"]+)",operationName:"${operation}"`));
    if (direct?.[1]) return direct[1];
    const reverse = js.match(new RegExp(`operationName:"${operation}",queryId:"([^"]+)"`));
    return reverse?.[1];
}

export function resetQueryIdCache(): void {
    cache = {};
}