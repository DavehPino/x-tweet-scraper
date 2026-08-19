import { logger } from '../logger.js';
import { type ValidatedInput } from '../validation.js';
import { type OutputItem, type SortOrder } from '../types.js';
import { type FilterOptions, filterOptionsFromInput, matchesFilters } from '../filters.js';
import { XClient, userIdFromProfile, tweetResultFromById } from './x-client.js';
import { createProxyHandle } from './proxy.js';
import { scrapeAuthorTimeline } from './paginator.js';
import { normalizeTweet } from '../normalizer.js';
import { CONCURRENCY_PER_TARGET } from '../config.js';
import { bumpFetched, type RunStats } from '../stats.js';
import { type RunState } from './resumer.js';

/**
 * Fetches all requested surfaces, applying the shared seen-set and filters,
 * returning up to `cap` deduplicated, schema-conforming items.
 */
export async function fetchSurface(
    input: ValidatedInput,
    cap: number,
    _userId: string | null,
    stats: RunStats,
    state: RunState,
): Promise<OutputItem[]> {
    if (input.searchTerms?.length) {
        throw new Error('searchTerms is not implemented yet (bonus surface). Please use fromUsers or tweetIds.');
    }

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
        await scrapeAuthors(input.fromUsers, filters, cap, seen, items, proxy, collect, stats, state);
    }

    if (input.tweetIds?.length) {
        const byIdCap = Math.max(0, cap - items.length);
        await scrapeTweetIds(input.tweetIds.slice(0, byIdCap), proxy, collect, stats);
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
): Promise<void> {
    const targetPerAuthor = Math.ceil(cap / handles.length);
    const pool: Promise<void>[] = [];

    for (const handle of handles) {
        if (items.length >= cap) break;
        pool.push(
            (async () => {
                const sessionId = `author-${handle}`;
                const proxyUrl = await proxy.newUrl(sessionId);
                const client = new XClient(proxyUrl ? { proxyUrl } : {});
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
                        countPerPage: 20,
                        targetCount: Math.min(targetPerAuthor, remaining),
                        filters,
                        seen,
                        onFetched: () => bumpFetched(stats),
                        startCursor: state.cursors[handle],
                        onProgress: (cursor) => {
                            state.cursors[handle] = cursor;
                        },
                    });
                    for (const item of authorItems) collect(item);
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

async function scrapeTweetIds(
    ids: string[],
    proxy: Awaited<ReturnType<typeof createProxyHandle>>,
    collect: (item: OutputItem | null) => void,
    stats: RunStats,
): Promise<void> {
    const pool: Promise<void>[] = [];
    for (const id of ids) {
        pool.push(
            (async () => {
                const sessionId = `tweet-${id}`;
                const proxyUrl = await proxy.newUrl(sessionId);
                const client = new XClient(proxyUrl ? { proxyUrl } : {});
                try {
                    const response = await client.getTweetById(id);
                    const result = tweetResultFromById(response);
                    bumpFetched(stats);
                    collect(normalizeTweet(result ?? { __typename: 'TweetTombstone' }));
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