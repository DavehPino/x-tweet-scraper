import { describe, expect, it } from 'vitest';
import { effectiveCap, makeRunContext, pushResults } from '../src/main.js';
import { FREE_CAP } from '../src/config.js';
import { type OutputItem } from '../src/types.js';

function item(i: number): OutputItem {
    return {
        id: String(i),
        url: `https://x.com/a/status/${i}`,
        text: 'x',
        lang: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        conversationId: null,
        isReply: false,
        isRetweet: false,
        isQuote: false,
        inReplyToId: null,
        quotedTweetId: null,
        author: { id: 'u', username: 'a', name: 'A', verified: false, followers: 0, following: 0 },
        metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: null, views: null },
        entities: { hashtags: [], mentions: [], urls: [], media: [] },
        source: null,
        scrapedAt: '2026-01-01T00:00:00.000Z',
    };
}

describe('free-tier cap', () => {
    it('free user with maxResults=1000 still gets exactly 10', () => {
        const cap = effectiveCap({ maxResults: 1000 }, false);
        expect(cap).toBe(FREE_CAP);
        expect(cap).toBe(10);
    });

    it('paid user gets their requested maxResults', () => {
        const cap = effectiveCap({ maxResults: 500 }, true);
        expect(cap).toBe(500);
    });

    it('free user with no maxResults is capped at 10', () => {
        const cap = effectiveCap({}, false);
        expect(cap).toBe(10);
    });

    it('enforcement happens at the push loop: 1000 items, free cap → only 10 pushed + limited flag', async () => {
        const ctx = makeRunContext({ maxResults: 1000 }, FREE_CAP, false);
        const pushed: OutputItem[][] = [];
        const dataset = { pushData: async (x: OutputItem | OutputItem[]) => pushed.push(Array.isArray(x) ? x : [x]) };

        const thousand = Array.from({ length: 1000 }, (_, i) => item(i));
        await pushResults(dataset, thousand, ctx);

        const total = pushed.flat().length;
        expect(total).toBe(10);
        expect(ctx.stats.pushed).toBe(10);
        expect(ctx.stats.limited).toBe(true);
        expect(ctx.stats.reason).toBe('free_tier');
        expect(ctx.stats.cap).toBe(10);
    });

    it('paid run pushes all requested items without the limited flag', async () => {
        const ctx = makeRunContext({ maxResults: 5 }, 5, true);
        const pushed: OutputItem[][] = [];
        const dataset = { pushData: async (x: OutputItem | OutputItem[]) => pushed.push(Array.isArray(x) ? x : [x]) };

        await pushResults(dataset, Array.from({ length: 5 }, (_, i) => item(i)), ctx);

        expect(pushed.flat().length).toBe(5);
        expect(ctx.stats.limited).toBeUndefined();
    });
});