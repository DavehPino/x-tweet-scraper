import { describe, expect, it } from 'vitest';
import { matchesFilters, type FilterOptions } from '../src/filters.js';
import { type OutputItem } from '../src/types.js';

function item(partial: Partial<OutputItem>): OutputItem {
    return {
        id: '1',
        url: 'https://x.com/a/status/1',
        text: 'hi',
        lang: 'en',
        createdAt: '2026-01-15T10:00:00.000Z',
        conversationId: '1',
        isReply: false,
        isRetweet: false,
        isQuote: false,
        inReplyToId: null,
        quotedTweetId: null,
        author: { id: 'u1', username: 'a', name: 'A', verified: false, followers: 100, following: 10 },
        metrics: { likes: 5, retweets: 2, replies: 1, quotes: 0, bookmarks: 0, views: 100 },
        entities: { hashtags: [], mentions: [], urls: [], media: [] },
        source: null,
        scrapedAt: '2026-01-15T10:00:00.000Z',
        ...partial,
    };
}

const none: FilterOptions = {};

describe('matchesFilters (AND semantics)', () => {
    it('passes everything when no filters are set', () => {
        expect(matchesFilters(item({}), none)).toBe(true);
    });

    it('requires ALL hashtags', () => {
        const withTags = item({ entities: { hashtags: ['buildinpublic', 'typescript'], mentions: [], urls: [], media: [] } });
        expect(matchesFilters(withTags, { hashtags: ['buildinpublic'] })).toBe(true);
        expect(matchesFilters(withTags, { hashtags: ['buildinpublic', 'typescript'] })).toBe(true);
        expect(matchesFilters(withTags, { hashtags: ['buildinpublic', 'missing'] })).toBe(false);
    });

    it('applies the since/until window inclusively', () => {
        expect(matchesFilters(item({}), { since: '2026-01-01' })).toBe(true);
        expect(matchesFilters(item({}), { since: '2026-02-01' })).toBe(false);
        expect(matchesFilters(item({}), { until: '2026-01-16' })).toBe(true);
        expect(matchesFilters(item({}), { until: '2026-01-14' })).toBe(false);
        expect(matchesFilters(item({}), { since: '2026-01-01', until: '2026-01-31' })).toBe(true);
    });

    it('filters by language (case-insensitive)', () => {
        expect(matchesFilters(item({ lang: 'en' }), { language: 'en' })).toBe(true);
        expect(matchesFilters(item({ lang: 'en' }), { language: 'ES' })).toBe(false);
    });

    it('applies engagement floors', () => {
        expect(matchesFilters(item({}), { minLikes: 5 })).toBe(true);
        expect(matchesFilters(item({}), { minLikes: 6 })).toBe(false);
        expect(matchesFilters(item({}), { minRetweets: 2, minReplies: 1 })).toBe(true);
        expect(matchesFilters(item({}), { minRetweets: 3 })).toBe(false);
    });

    it('filters verified authors', () => {
        expect(matchesFilters(item({}), { onlyVerified: true })).toBe(false);
        expect(matchesFilters(item({ author: { id: 'u1', username: 'a', name: 'A', verified: true, followers: 1, following: 1 } }), { onlyVerified: true })).toBe(true);
    });

    it('filters by media type', () => {
        const photo = item({ entities: { hashtags: [], mentions: [], urls: [], media: [{ type: 'photo', url: 'https://pbs/img.jpg', thumbnail: null }] } });
        const video = item({ entities: { hashtags: [], mentions: [], urls: [], media: [{ type: 'video', url: 'https://pbs/v.mp4', thumbnail: 'https://pbs/t.jpg' }] } });
        const link = item({ entities: { hashtags: [], mentions: [], urls: ['https://apify.com'], media: [] } });

        expect(matchesFilters(photo, { mediaType: 'images' })).toBe(true);
        expect(matchesFilters(photo, { mediaType: 'video' })).toBe(false);
        expect(matchesFilters(video, { mediaType: 'video' })).toBe(true);
        expect(matchesFilters(video, { mediaType: 'images' })).toBe(false);
        expect(matchesFilters(link, { mediaType: 'links' })).toBe(true);
        expect(matchesFilters(item({}), { mediaType: 'text_only' })).toBe(true);
        expect(matchesFilters(photo, { mediaType: 'text_only' })).toBe(false);
    });

    it('excludes replies/retweets by default', () => {
        expect(matchesFilters(item({ isReply: true }), { includeReplies: false })).toBe(false);
        expect(matchesFilters(item({ isReply: true }), { includeReplies: true })).toBe(true);
        expect(matchesFilters(item({ isRetweet: true }), { includeRetweets: false })).toBe(false);
        expect(matchesFilters(item({ isRetweet: true }), { includeRetweets: true })).toBe(true);
    });
});