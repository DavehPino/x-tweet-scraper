import { logger } from '../logger.js';
import { type XClient } from './x-client.js';
import { type RawInstruction } from './raw-types.js';
import { normalizeTweet } from '../normalizer.js';
import { matchesFilters, type FilterOptions } from '../filters.js';
import { type OutputItem } from '../types.js';

export interface AuthorTimelineOptions {
    countPerPage?: number;
    /** Stop collecting once this many items have been collected. */
    targetCount: number;
    filters: FilterOptions;
    /** Global dedup set (across all targets). */
    seen: Set<string>;
    /** Called once per normalized candidate (before filters). */
    onFetched?: () => void;
    /** Resume paging from a persisted cursor. */
    startCursor?: string | undefined;
    /** Persist progress (cursor + seen) so a migrated run resumes. */
    onProgress?: (cursor: string) => void;
    /** Stream each collected item as it is found (survives mid-pagination errors). */
    onItem?: (item: OutputItem) => void;
}

/** Flattens a timeline's instructions into ordered entries. Shared by author and search timelines. */
export function flattenEntries(instructions: RawInstruction[] | undefined): NonNullable<RawInstruction['entry']>[] {
    const out: NonNullable<RawInstruction['entry']>[] = [];
    for (const instruction of instructions ?? []) {
        if (instruction.entry) out.push(instruction.entry);
        for (const entry of instruction.entries ?? []) out.push(entry);
    }
    return out;
}

/**
 * Pages through a single author's timeline until targetCount conforming,
 * deduplicated items are collected (or the timeline is exhausted).
 * Cursor-based, no duplicates across pages.
 */
export async function scrapeAuthorTimeline(
    client: XClient,
    userId: string,
    options: AuthorTimelineOptions,
): Promise<OutputItem[]> {
    const seen = options.seen;
    const collected: OutputItem[] = [];
    const localSeen = new Set<string>();
    const countPerPage = options.countPerPage ?? 20;
    let cursor: string | undefined = options.startCursor;

    for (let page = 0; page < 200; page += 1) {
        if (collected.length >= options.targetCount) break;

        const response = await client.getUserTweets(userId, {
            count: countPerPage,
            ...(cursor ? { cursor } : {}),
        });
        const instructions = response?.data?.user?.result?.timeline?.timeline?.instructions;
        if (!instructions?.length) break;

        const entries = flattenEntries(instructions);
        if (entries.length === 0) break;

        cursor = entries.find((e) => e.entryId?.startsWith('cursor-bottom'))?.content?.value;
        const reachedEnd = entries.some((e) => e.entryId?.startsWith('cursor-bottom') && e.content?.value === undefined);

        for (const entry of entries) {
            if (collected.length >= options.targetCount) break;
            const isTweetEntry = entry.entryId?.startsWith('tweet-') || entry.entryId?.startsWith('profile-conversation-');
            if (!isTweetEntry) continue;

            const result = entry.content?.itemContent?.tweet_results?.result;
            if (!result?.rest_id) continue;
            if (localSeen.has(result.rest_id)) continue;
            if (seen.has(result.rest_id)) continue;

            const item = normalizeTweet(result);
            if (!item) continue;

            localSeen.add(item.id);
            options.onFetched?.();
            if (!matchesFilters(item, options.filters)) continue;

            collected.push(item);
            options.onItem?.(item);
        }

        if (reachedEnd || !cursor) break;
        options.onProgress?.(cursor);
    }

    logger.info({ userId, collected: collected.length }, 'Author timeline scraped');
    return collected;
}

export interface SearchTimelineOptions extends Omit<AuthorTimelineOptions, 'onProgress'> {
    /** Search product: Latest | Top | People | Photos | Videos. */
    product?: string;
    /** Persist the search cursor so a migrated run resumes per term. */
    onProgress?: (cursor: string) => void;
}

/**
 * Pages through SearchTimeline results for a raw query until targetCount
 * conforming, deduplicated items are collected. Same cursor/seen handling as
 * the author timeline; the operation is the bonus surface (see probeSearch).
 */
export async function scrapeSearchTimeline(
    client: XClient,
    rawQuery: string,
    options: SearchTimelineOptions,
): Promise<OutputItem[]> {
    const seen = options.seen;
    const collected: OutputItem[] = [];
    const localSeen = new Set<string>();
    const countPerPage = options.countPerPage ?? 20;
    const product = options.product ?? 'Latest';
    let cursor: string | undefined = options.startCursor;

    for (let page = 0; page < 200; page += 1) {
        if (collected.length >= options.targetCount) break;

        const response = await client.searchTimeline(rawQuery, { count: countPerPage, product, ...(cursor ? { cursor } : {}) });
        const instructions = response?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
        if (!instructions?.length) break;

        const entries = flattenEntries(instructions);
        if (entries.length === 0) break;

        cursor = entries.find((e) => e.entryId?.startsWith('cursor-bottom'))?.content?.value;
        const reachedEnd = entries.some((e) => e.entryId?.startsWith('cursor-bottom') && e.content?.value === undefined);

        for (const entry of entries) {
            if (collected.length >= options.targetCount) break;
            const isTweetEntry = entry.entryId?.startsWith('tweet-') || entry.entryId?.startsWith('profile-conversation-');
            if (!isTweetEntry) continue;

            const result = entry.content?.itemContent?.tweet_results?.result;
            if (!result?.rest_id) continue;
            if (localSeen.has(result.rest_id)) continue;
            if (seen.has(result.rest_id)) continue;

            const item = normalizeTweet(result);
            if (!item) continue;

            localSeen.add(item.id);
            options.onFetched?.();
            if (!matchesFilters(item, options.filters)) continue;

            collected.push(item);
            options.onItem?.(item);
        }

        if (reachedEnd || !cursor) break;
        options.onProgress?.(cursor);
    }

    logger.info({ rawQuery, product, collected: collected.length }, 'Search timeline scraped');
    return collected;
}