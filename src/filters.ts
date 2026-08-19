import { type MediaType, type OutputItem } from './types.js';
import { type ValidatedInput } from './validation.js';

export interface FilterOptions {
    hashtags?: string[] | undefined;
    since?: string | undefined;
    until?: string | undefined;
    language?: string | undefined;
    minLikes?: number | undefined;
    minRetweets?: number | undefined;
    minReplies?: number | undefined;
    onlyVerified?: boolean | undefined;
    mediaType?: MediaType | undefined;
    includeReplies?: boolean | undefined;
    includeRetweets?: boolean | undefined;
}

export function filterOptionsFromInput(input: ValidatedInput): FilterOptions {
    return {
        hashtags: input.hashtags,
        since: input.since,
        until: input.until,
        language: input.language,
        minLikes: input.minLikes,
        minRetweets: input.minRetweets,
        minReplies: input.minReplies,
        onlyVerified: input.onlyVerified,
        mediaType: input.mediaType,
        includeReplies: input.includeReplies,
        includeRetweets: input.includeRetweets,
    };
}

/** All filters combine with AND semantics; unset filters are "no constraint". */
export function matchesFilters(item: OutputItem, filters: FilterOptions): boolean {
    if (filters.hashtags?.length) {
        const present = new Set(item.entities.hashtags.map((h) => h.toLowerCase()));
        for (const tag of filters.hashtags) {
            if (!present.has(tag.toLowerCase())) return false;
        }
    }

    if (filters.since && item.createdAt < toComparable(filters.since)) return false;
    if (filters.until && item.createdAt > toComparable(filters.until)) return false;

    if (filters.language && item.lang !== filters.language.toLowerCase()) return false;

    if ((filters.minLikes ?? 0) > item.metrics.likes) return false;
    if ((filters.minRetweets ?? 0) > item.metrics.retweets) return false;
    if ((filters.minReplies ?? 0) > item.metrics.replies) return false;

    if (filters.onlyVerified && !item.author.verified) return false;

    if (filters.mediaType && filters.mediaType !== 'any') {
        if (!mediaTypeMatches(item, filters.mediaType)) return false;
    }

    if (filters.includeReplies === false && item.isReply) return false;
    if (filters.includeRetweets === false && item.isRetweet) return false;

    return true;
}

function mediaTypeMatches(item: OutputItem, mediaType: MediaType): boolean {
    const media = item.entities.media;
    switch (mediaType) {
        case 'text_only':
            return media.length === 0;
        case 'images':
            return media.some((m) => m.type === 'photo');
        case 'video':
            return media.some((m) => m.type === 'video' || m.type === 'animated_gif');
        case 'links':
            return item.entities.urls.length > 0;
        default:
            return true;
    }
}

/** Normalizes an ISO date (YYYY-MM-DD or full) for string comparison. */
function toComparable(iso: string): string {
    return iso.length === 10 ? `${iso}T00:00:00.000Z` : new Date(iso).toISOString();
}