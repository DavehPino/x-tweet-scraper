import { type MediaItem, type OutputItem } from './types.js';
import {
    type RawMedia,
    type RawTweetLegacy,
    type RawTweetResult,
    type RawUserCore,
} from './lib/raw-types.js';

const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const CREATED_AT_RE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4}) (\d{4})$/;

/**
 * X's legacy `created_at` ("Wed Aug 12 16:12:32 +0000 2026") is not ISO parseable
 * by every JS engine, so parse it explicitly and return ISO-8601 UTC.
 */
export function parseTwitterDate(value: string): string {
    const m = CREATED_AT_RE.exec(value);
    if (!m) return new Date(value).toISOString();
    const month = m[1] ? MONTHS[m[1]] : undefined;
    const day = m[2] ? Number(m[2]) : NaN;
    const hour = m[3] ? Number(m[3]) : NaN;
    const minute = m[4] ? Number(m[4]) : NaN;
    const second = m[5] ? Number(m[5]) : NaN;
    const offset = m[6] ? Number(m[6]) : NaN;
    const year = m[7] ? Number(m[7]) : NaN;
    if (month === undefined || Number.isNaN(day + hour + minute + second + offset + year)) {
        return new Date(value).toISOString();
    }
    const offsetHours = Math.trunc(offset / 100);
    const offsetMinutes = offset % 100;
    const utc = Date.UTC(year, month, day, hour - offsetHours, minute - offsetMinutes, second);
    return new Date(utc).toISOString();
}

/** Replaces t.co short links with their expanded URLs in the tweet text. */
function expandLinks(text: string, legacy: RawTweetLegacy): string {
    let out = text;
    for (const u of legacy.entities?.urls ?? []) {
        if (u.expanded_url && out.includes('https://t.co/')) {
            // Replace the short url token (handle trailing "…" which X appends).
            out = out.replace(new RegExp(`https://t\\.co/[A-Za-z0-9]+(?:…)?`, 'g'), u.expanded_url);
        }
    }
    return out;
}

function normalizeMedia(legacy: RawTweetLegacy): MediaItem[] {
    const media = legacy.extended_entities?.media ?? legacy.entities?.media ?? [];
    return media
        .filter((m: RawMedia) => m.media_url_https || m.expanded_url)
        .map((m: RawMedia): MediaItem => {
            const url = m.media_url_https ?? m.expanded_url ?? '';
            if (m.type === 'video' || m.type === 'animated_gif') {
                return { type: m.type, url, thumbnail: m.media_url_https ?? null };
            }
            return { type: 'photo', url, thumbnail: null };
        });
}

function normalizeAuthor(core: RawUserCore | undefined, fallbackUserId: string | undefined): OutputItem['author'] {
    const legacy = core?.legacy;
    const username = core?.core?.screen_name ?? legacy?.screen_name ?? '';
    return {
        id: core?.rest_id ?? legacy?.id_str ?? fallbackUserId ?? '',
        username,
        name: core?.core?.name ?? legacy?.name ?? '',
        verified: core?.is_blue_verified ?? core?.verification?.verified ?? legacy?.verified ?? false,
        followers: core?.relationship_counts?.followers ?? legacy?.followers_count ?? 0,
        following: core?.relationship_counts?.following ?? legacy?.friends_count ?? 0,
    };
}

/** Resolves the effective legacy/core for Tweet vs TweetWithVisibilityResults. */
function unwrap(result: RawTweetResult): { legacy: RawTweetLegacy | undefined; core: RawUserCore | undefined; views: string | undefined } {
    if (result.tweet) {
        return {
            legacy: result.tweet.legacy,
            core: result.tweet.core?.user_results?.result,
            views: result.views?.count,
        };
    }
    return {
        legacy: result.legacy,
        core: result.core?.user_results?.result,
        views: result.views?.count,
    };
}

/**
 * Maps a raw GraphQL tweet result to the exact §5 output schema.
 * Returns null for tombstones / malformed payloads (never a malformed item).
 */
export function normalizeTweet(result: RawTweetResult, scrapedAt = new Date().toISOString()): OutputItem | null {
    if (!result || result.__typename === 'TweetTombstone' || result.__typename === 'TweetUnavailable') return null;
    const { legacy, core, views } = unwrap(result);
    if (!legacy?.full_text || !result.rest_id) return null;

    const id = result.rest_id;
    const author = normalizeAuthor(core, legacy.user_id_str);
    const media = normalizeMedia(legacy);

    const quoted = result.quoted_status_result?.result;
    const isReply = legacy.in_reply_to_status_id_str != null && legacy.in_reply_to_status_id_str !== id;

    return {
        id,
        url: `https://x.com/${author.username}/status/${id}`,
        text: expandLinks(legacy.full_text, legacy),
        lang: legacy.lang ?? null,
        createdAt: parseTwitterDate(legacy.created_at),
        conversationId: legacy.conversation_id_str ?? null,
        isReply,
        isRetweet: legacy.retweeted_status_result != null,
        isQuote: legacy.is_quote_status === true || quoted != null,
        inReplyToId: legacy.in_reply_to_status_id_str ?? null,
        quotedTweetId: quoted?.rest_id ?? null,
        author,
        metrics: {
            likes: legacy.favorite_count ?? 0,
            retweets: legacy.retweet_count ?? 0,
            replies: legacy.reply_count ?? 0,
            quotes: legacy.quote_count ?? 0,
            bookmarks: legacy.bookmark_count ?? null,
            views: views != null ? Number(views) : null,
        },
        entities: {
            hashtags: (legacy.entities?.hashtags ?? []).map((h) => h.text),
            mentions: (legacy.entities?.user_mentions ?? []).map((m) => m.screen_name),
            urls: (legacy.entities?.urls ?? []).map((u) => u.expanded_url).filter(Boolean),
            media,
        },
        source: legacy.source ?? null,
        scrapedAt,
    };
}