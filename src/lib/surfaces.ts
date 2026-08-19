import { logger } from '../logger.js';
import { type ValidatedInput } from '../validation.js';
import { type OutputItem, type SortOrder } from '../types.js';
import { type FilterOptions, filterOptionsFromInput, matchesFilters } from '../filters.js';
import { XClient, userIdFromProfile, tweetResultFromById } from './x-client.js';
import { createProxyHandle, sessionIdFor } from './proxy.js';
import { scrapeAuthorTimeline } from './paginator.js';
import { normalizeTweet } from '../normalizer.js';
import { CONCURRENCY_PER_TARGET } from '../config.js';
import { bumpFetched, recordError, type RunStats } from '../stats.js';
import { sleep } from './retry.js';
import { type RunState } from './resumer.js';

/** Creates an XClient bound to an optional proxy URL. Injectable for tests. */
export type XClientFactory = (proxyUrl?: string) => XClient;

export const DEFAULT_CLIENT_FACTORY: XClientFactory = (proxyUrl) => new XClient(proxyUrl ? { proxyUrl } : {});

export interface SurfaceOptions {
    clientFactory?: XClientFactory;
    /** Cooldown before re-attempting a rate-limited author on a new session. */
    rotationCooldownMs?: number;
}

/** Rotate the session (new proxy IP + fresh guest token) at most this many times per author. */
const MAX_SESSION_EPOCHS = 5;
/** Default cooldown before re-attempting a rate-limited author on a new session. */
const ROTATION_COOLDOWN_MS = 3_000;

function errorTypeFor(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.match(/HTTP (\d{3})/);
    return status ? `HTTP_${status[1]}` : 'UNKNOWN';
}

function isRateLimited(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('HTTP 429');
}

/**
 * Fetches all requested surfaces, applying the shared seen-set and filters,
 * returning up to `cap` deduplicated, schema-conforming items.
 * Per-target failures degrade gracefully: they are counted in stats.errorCounts
 * and the run continues with the remaining targets instead of crashing.
 */
export async function fetchSurface(
    input: ValidatedInput,
    cap: number,
    _userId: string | null,
    stats: RunStats,
    state: RunState,
    options: SurfaceOptions = {},
): Promise<OutputItem[]> {
    if (input.searchTerms?.length) {
        throw new Error('searchTerms is not implemented yet (bonus surface). Please use fromUsers or tweetIds.');
    }

    const clientFactory = options.clientFactory ?? DEFAULT_CLIENT_FACTORY;
    const rotationCooldownMs = options.rotationCooldownMs ?? ROTATION_COOLDOWN_MS;
    const filters = filterOptionsFromInput(input);
    const seen = new Set(state.seen);
    const items: OutputItem[] = [];
    const proxy = await createProxyHandle(input.proxyConfiguration);

    const collect = (candidate: OutputItem | null): void => {
        if (!candidate) return;
        if (seen.has(candidate.id)) return;
        seen.add(candidate.id);
        state.seen.push(candidate.id);
        if (matchesFilters(candidate, filters)) {
            items.push(candidate);
        }
    };

    if (input.fromUsers?.length) {
        await scrapeAuthors(input.fromUsers, filters, cap, seen, items, proxy, collect, stats, state, clientFactory, rotationCooldownMs);
    }

    if (input.tweetIds?.length) {
        const byIdCap = Math.max(0, cap - items.length);
        await scrapeTweetIds(input.tweetIds.slice(0, byIdCap), proxy, collect, stats, clientFactory);
    }

    applySort(items, input.sortBy);
    return items.slice(0, cap);
}

async function scrapeAuthors(
    handles: string[],
    filters: FilterOptions,
    cap: number,
    seen: Set<string>,
    items: OutputItem[],
    proxy: Awaited<ReturnType<typeof createProxyHandle>>,
    collect: (item: OutputItem | null) => void,
    stats: RunStats,
    state: RunState,
    clientFactory: XClientFactory,
    rotationCooldownMs: number,
): Promise<void> {
    const targetPerAuthor = Math.ceil(cap / handles.length);
    const pool: Promise<void>[] = [];

    for (const handle of handles) {
        if (items.length >= cap) break;
        pool.push(scrapeAuthor(handle, filters, targetPerAuthor, cap, seen, items, proxy, collect, stats, state, clientFactory, rotationCooldownMs));
        if (pool.length >= CONCURRENCY_PER_TARGET) {
            await Promise.all(pool.splice(0));
        }
    }
    if (pool.length) await Promise.all(pool);
}

/**
 * Scrapes one author's timeline. On persistent rate limiting the session is
 * rotated (new proxy IP + fresh guest token) and paging resumes from the last
 * persisted cursor. Never throws: failures are logged and counted, so a bad
 * author cannot sink the whole run.
 */
async function scrapeAuthor(
    handle: string,
    filters: FilterOptions,
    targetPerAuthor: number,
    cap: number,
    seen: Set<string>,
    items: OutputItem[],
    proxy: Awaited<ReturnType<typeof createProxyHandle>>,
    collect: (item: OutputItem | null) => void,
    stats: RunStats,
    state: RunState,
    clientFactory: XClientFactory,
    rotationCooldownMs: number,
): Promise<void> {
    for (let epoch = 0; epoch < MAX_SESSION_EPOCHS; epoch += 1) {
        const sessionId = sessionIdFor(`author_${handle}_e${epoch}`);
        const proxyUrl = await proxy.newUrl(sessionId);
        const client = clientFactory(proxyUrl);
        try {
            const profile = await client.getUserByScreenName(handle);
            const userId = userIdFromProfile(profile);
            if (!userId) {
                logger.warn({ handle }, 'No userId resolved for handle');
                return;
            }
            const remaining = Math.max(0, cap - items.length);
            if (remaining <= 0) return;
            const authorItems = await scrapeAuthorTimeline(client, userId, {
                countPerPage: 40,
                targetCount: Math.min(targetPerAuthor, remaining),
                filters,
                seen,
                onFetched: () => bumpFetched(stats),
                onItem: (item) => collect(item),
                startCursor: state.cursors[handle],
                onProgress: (cursor) => {
                    state.cursors[handle] = cursor;
                },
            });
            if (authorItems.length > 0) {
                logger.debug({ handle, epoch, items: authorItems.length }, 'Author timeline collected');
            }
            return;
        } catch (err) {
            const errorType = errorTypeFor(err);
            recordError(stats, errorType);
            if (isRateLimited(err) && epoch < MAX_SESSION_EPOCHS - 1) {
                logger.warn({ handle, epoch, errorType }, 'Author rate-limited; rotating session and retrying');
                await sleep(rotationCooldownMs);
                continue;
            }
            logger.warn({ handle, errorType, err: String(err) }, 'Author scrape failed, skipping');
            return;
        } finally {
            client.close();
        }
    }
}

async function scrapeTweetIds(
    ids: string[],
    proxy: Awaited<ReturnType<typeof createProxyHandle>>,
    collect: (item: OutputItem | null) => void,
    stats: RunStats,
    clientFactory: XClientFactory,
): Promise<void> {
    const pool: Promise<void>[] = [];
    for (const id of ids) {
        pool.push(
            (async () => {
                const sessionId = sessionIdFor(`tweet-${id}`);
                const proxyUrl = await proxy.newUrl(sessionId);
                const client = clientFactory(proxyUrl);
                try {
                    const response = await client.getTweetById(id);
                    const result = tweetResultFromById(response);
                    bumpFetched(stats);
                    collect(normalizeTweet(result ?? { __typename: 'TweetTombstone' }));
                } catch (err) {
                    recordError(stats, errorTypeFor(err));
                    logger.warn({ id, err: String(err) }, 'TweetById failed, skipping');
                } finally {
                    client.close();
                }
            })(),
        );
        if (pool.length >= CONCURRENCY_PER_TARGET) {
            await Promise.all(pool.splice(0));
        }
    }
    if (pool.length) await Promise.all(pool);
}

function applySort(items: OutputItem[], sortBy: SortOrder | undefined): void {
    const order = sortBy ?? 'latest';
    if (order === 'latest') {
        items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    } else {
        items.sort((a, b) => b.metrics.likes - a.metrics.likes);
    }
}