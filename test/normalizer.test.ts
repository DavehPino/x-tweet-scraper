import { describe, expect, it } from 'vitest';
import { normalizeTweet, parseTwitterDate } from '../src/normalizer.js';
import { type RawTweetResult } from '../src/lib/raw-types.js';
import fixture from './fixtures/tweet.json' with { type: 'json' };

describe('parseTwitterDate', () => {
    it('converts X legacy created_at to ISO-8601 UTC', () => {
        expect(parseTwitterDate('Wed Aug 12 16:12:32 +0000 2026')).toBe('2026-08-12T16:12:32.000Z');
    });

    it('applies a non-zero timezone offset', () => {
        expect(parseTwitterDate('Wed Aug 12 16:12:32 -0500 2026')).toBe('2026-08-12T21:12:32.000Z');
    });
});

describe('normalizeTweet', () => {
    it('maps a raw tweet to the exact output schema', () => {
        const item = normalizeTweet(fixture as RawTweetResult);
        expect(item).not.toBeNull();
        expect(item!.id).toBe('2087572956683567110');
        expect(item!.url).toBe('https://x.com/apify/status/2087572956683567110');
        expect(item!.createdAt).toBe('2026-08-12T16:12:32.000Z');
        expect(item!.lang).toBe('en');
        expect(item!.isReply).toBe(false);
        expect(item!.isRetweet).toBe(false);
        expect(item!.isQuote).toBe(false);
        expect(item!.inReplyToId).toBeNull();
        expect(item!.quotedTweetId).toBeNull();
        expect(item!.source).toBe('Twitter Web App');
        expect(item!.author).toEqual({
            id: '3510729917',
            username: 'apify',
            name: 'Apify',
            verified: false,
            followers: 12043,
            following: 296,
        });
        expect(item!.metrics).toEqual({
            likes: 25,
            retweets: 3,
            replies: 2,
            quotes: 1,
            bookmarks: 5,
            views: 546,
        });
        expect(item!.entities.hashtags).toEqual(['buildinpublic']);
        expect(item!.entities.mentions).toEqual(['elonmusk']);
        expect(item!.entities.urls).toEqual(['https://apify.com']);
        // short link expanded in the text
        expect(item!.text).toContain('https://apify.com');
        expect(item!.text).not.toContain('t.co');
    });

    it('returns null for tombstones', () => {
        expect(normalizeTweet({ __typename: 'TweetTombstone' })).toBeNull();
        expect(normalizeTweet({ __typename: 'TweetUnavailable' })).toBeNull();
    });

    it('returns null for malformed payloads without rest_id/text', () => {
        expect(normalizeTweet({ __typename: 'Tweet' })).toBeNull();
    });

    it('handles TweetWithVisibilityResults (wrapped legacy)', () => {
        const wrapped: RawTweetResult = {
            __typename: 'TweetWithVisibilityResults',
            rest_id: '123',
            views: { count: '10' },
            tweet: {
                legacy: {
                    created_at: 'Wed Aug 12 16:12:32 +0000 2026',
                    full_text: 'hello',
                    id_str: '123',
                    conversation_id_str: '123',
                    in_reply_to_status_id_str: null,
                    lang: 'en',
                    favorite_count: 0,
                    retweet_count: 0,
                    reply_count: 0,
                    quote_count: 0,
                    bookmark_count: 0,
                    is_quote_status: false,
                    user_id_str: '99',
                    source: null,
                },
                core: { user_results: { result: { rest_id: '99', core: { name: 'Bob', screen_name: 'bob' } } } },
            },
        };
        const item = normalizeTweet(wrapped);
        expect(item!.text).toBe('hello');
        expect(item!.author.username).toBe('bob');
        expect(item!.metrics.views).toBe(10);
    });
});