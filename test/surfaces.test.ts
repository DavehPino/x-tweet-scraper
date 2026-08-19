import { describe, expect, it } from 'vitest';
import fixture from './fixtures/tweet.json' with { type: 'json' };
import { fetchSurface, type XClientFactory } from '../src/lib/surfaces.js';
import {
    type RawEntry,
    type RawTweetByIdResponse,
    type RawTweetResult,
    type RawUserByScreenNameResponse,
    type RawUserTweetsResponse,
} from '../src/lib/raw-types.js';
import { type XClient } from '../src/lib/x-client.js';
import { createStats } from '../src/stats.js';
import { createRunState } from '../src/lib/resumer.js';
import { type ValidatedInput } from '../src/validation.js';

function makeTweet(id: string): RawTweetResult {
    const t = JSON.parse(JSON.stringify(fixture)) as RawTweetResult & {
        legacy?: { id_str: string; conversation_id_str: string; full_text: string };
    };
    t.rest_id = id;
    if (t.legacy) {
        t.legacy.id_str = id;
        t.legacy.conversation_id_str = id;
        t.legacy.full_text = `tweet ${id}`;
    }
    return t;
}

function makePage(tweetIds: string[], cursor: string | undefined): RawUserTweetsResponse {
    const entries: RawEntry[] = tweetIds.map((id) => ({
        entryId: `tweet-${id}`,
        content: { itemContent: { tweet_results: { result: makeTweet(id) } } },
    }));
    entries.push({ entryId: 'cursor-bottom-1', content: { cursorType: 'Bottom', ...(cursor !== undefined ? { value: cursor } : {}) } });
    return {
        data: {
            user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } },
        },
    };
}

function makeProfile(userId: string, screenName: string): RawUserByScreenNameResponse {
    return {
        data: {
            user: {
                result: {
                    rest_id: userId,
                    core: { name: screenName, screen_name: screenName },
                    relationship_counts: { followers: 1, following: 1 },
                    verification: { verified: false },
                },
            },
        },
    };
}

class FakeXClient {
    closeCalls = 0;
    constructor(
        private readonly profile: RawUserByScreenNameResponse,
        private readonly pages: RawUserTweetsResponse[],
    ) {}

    async getUserByScreenName(): Promise<RawUserByScreenNameResponse> {
        return this.profile;
    }

    async getUserTweets(): Promise<RawUserTweetsResponse> {
        const page = this.pages.shift();
        if (!page) throw new Error('GraphQL UserTweets failed HTTP 500');
        return page;
    }

    async getTweetById(): Promise<RawTweetByIdResponse> {
        throw new Error('GraphQL TweetResultByRestId failed HTTP 404');
    }

    close(): void {
        this.closeCalls += 1;
    }
}

/** Builds a factory whose timeline calls fail with 429 a shared number of times before succeeding. */
function makeFactory(opts: { profile: RawUserByScreenNameResponse; pages: RawUserTweetsResponse[]; shared429s?: number; always429?: boolean }) {
    const clients: FakeXClient[] = [];
    let shared429s = opts.shared429s ?? 0;

    const factory: XClientFactory = () => {
        const client = new FakeXClient(opts.profile, [...opts.pages]);
        const origTweets = client.getUserTweets.bind(client);
        client.getUserTweets = async () => {
            if (opts.always429 || shared429s > 0) {
                if (shared429s > 0) shared429s -= 1;
                throw new Error('GraphQL UserTweets failed HTTP 429');
            }
            return origTweets();
        };
        clients.push(client);
        return client as unknown as XClient;
    };

    return { factory, clients };
}

async function run(input: ValidatedInput, cap: number, factory: XClientFactory) {
    const stats = createStats(cap);
    const state = createRunState();
    const items = await fetchSurface(input, cap, null, stats, state, factory);
    return { items, stats, state };
}

describe('fetchSurface (resilience)', () => {
    it('collects items from a healthy author', async () => {
        const { factory } = makeFactory({ profile: makeProfile('ug', 'good'), pages: [makePage(['111', '222'], undefined)] });
        const { items, stats } = await run({ fromUsers: ['good'] }, 4, factory);

        expect(items).toHaveLength(2);
        expect(items.map((i) => i.id)).toEqual(['111', '222']);
        expect(stats.errorCounts).toEqual({});
    });

    it('degrades gracefully when an author is persistently rate-limited (no crash, errors counted)', async () => {
        const { factory, clients } = makeFactory({ profile: makeProfile('ub', 'bad'), pages: [], always429: true });
        const { items, stats } = await run({ fromUsers: ['bad'] }, 4, factory);

        expect(items).toHaveLength(0);
        expect(stats.errorCounts.HTTP_429).toBe(3);
        expect(clients).toHaveLength(3);
        expect(clients.every((c) => c.closeCalls === 1)).toBe(true);
    });

    it('rotates the session and resumes after a transient 429', async () => {
        const { factory, clients } = makeFactory({
            profile: makeProfile('ug', 'good'),
            pages: [makePage(['111', '222'], undefined)],
            shared429s: 1,
        });
        const { items, stats } = await run({ fromUsers: ['good'] }, 4, factory);

        expect(items).toHaveLength(2);
        expect(stats.errorCounts.HTTP_429).toBe(1);
        expect(clients).toHaveLength(2);
    });

    it('skips a failed tweetById instead of failing the run', async () => {
        const { factory } = makeFactory({ profile: makeProfile('ug', 'good'), pages: [] });
        const { items, stats } = await run({ tweetIds: ['999'] }, 4, factory);

        expect(items).toHaveLength(0);
        expect(stats.errorCounts.HTTP_404).toBe(1);
    });
});