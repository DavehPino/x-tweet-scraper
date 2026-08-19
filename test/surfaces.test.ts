import { describe, expect, it } from 'vitest';
import fixture from './fixtures/tweet.json' with { type: 'json' };
import { fetchSurface, type XClientFactory } from '../src/lib/surfaces.js';
import {
    type RawEntry,
    type RawSearchTimelineResponse,
    type RawTweetByIdResponse,
    type RawTweetResult,
    type RawUserByScreenNameResponse,
    type RawUserTweetsResponse,
} from '../src/lib/raw-types.js';
import { type XClient } from '../src/lib/x-client.js';
import { RequestErrorLike } from '../src/lib/retry.js';
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

function makeSearchPage(tweetIds: string[], cursor: string | undefined): RawSearchTimelineResponse {
    const entries: RawEntry[] = tweetIds.map((id) => ({
        entryId: `tweet-${id}`,
        content: { itemContent: { tweet_results: { result: makeTweet(id) } } },
    }));
    entries.push({ entryId: 'cursor-bottom-1', content: { cursorType: 'Bottom', ...(cursor !== undefined ? { value: cursor } : {}) } });
    return {
        data: {
            search_by_raw_query: {
                search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } },
            },
        },
    };
}

type SearchMode = 'supported' | 'walled';

class FakeXClient {
    closeCalls = 0;
    constructor(
        private readonly profile: RawUserByScreenNameResponse,
        private readonly pages: RawUserTweetsResponse[],
        private readonly emptyBehavior: '500' | '429' = '500',
        private readonly searchMode: SearchMode = 'walled',
        private readonly searchPages: RawSearchTimelineResponse[] = [],
    ) {}

    async getUserByScreenName(): Promise<RawUserByScreenNameResponse> {
        return this.profile;
    }

    async getUserTweets(): Promise<RawUserTweetsResponse> {
        const page = this.pages.shift();
        if (!page) throw new Error(`GraphQL UserTweets failed HTTP ${this.emptyBehavior === '429' ? 429 : 500}`);
        return page;
    }

    async searchTimeline(_rawQuery: string, options?: { count?: number; cursor?: string }): Promise<RawSearchTimelineResponse> {
        if (this.searchMode === 'walled') throw new Error('GraphQL SearchTimeline failed HTTP 404');
        // The capability probe is the only caller with count=1 and no cursor.
        if ((options?.count ?? 20) === 1 && !options?.cursor) {
            return { data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } } };
        }
        const page = this.searchPages.shift();
        if (!page) throw new Error('GraphQL SearchTimeline failed HTTP 500');
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
function makeFactory(opts: {
    profile: RawUserByScreenNameResponse;
    pages: RawUserTweetsResponse[];
    shared429s?: number;
    always429?: boolean;
    emptyBehavior?: '500' | '429';
    searchMode?: SearchMode;
    searchPages?: RawSearchTimelineResponse[];
}) {
    const clients: FakeXClient[] = [];
    let shared429s = opts.shared429s ?? 0;

    const factory: XClientFactory = () => {
        const client = new FakeXClient(opts.profile, [...opts.pages], opts.emptyBehavior ?? '500', opts.searchMode ?? 'walled', [...(opts.searchPages ?? [])]);
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
    const items = await fetchSurface(input, cap, null, stats, state, { clientFactory: factory, rotationCooldownMs: 0 });
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
        expect(stats.errorCounts.HTTP_429).toBe(5);
        expect(clients).toHaveLength(5);
        expect(clients.every((c) => c.closeCalls === 1)).toBe(true);
    });

    it('keeps items already collected when a later page hits 429 (incremental streaming)', async () => {
        const { factory, clients } = makeFactory({
            profile: makeProfile('ug', 'good'),
            pages: [makePage(['111', '222'], 'cursor-2')],
            emptyBehavior: '429',
        });
        const { items, stats } = await run({ fromUsers: ['good'] }, 4, factory);

        expect(items).toHaveLength(2);
        expect(items.map((i) => i.id)).toEqual(['111', '222']);
        expect(stats.errorCounts.HTTP_429).toBe(5);
        expect(clients).toHaveLength(5);
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

describe('fetchSurface (search bonus)', () => {
    it('collects search results when SearchTimeline is guest-reachable', async () => {
        const { factory } = makeFactory({
            profile: makeProfile('ug', 'good'),
            pages: [],
            searchMode: 'supported',
            searchPages: [makeSearchPage(['111', '222'], undefined)],
        });
        const { items, stats } = await run({ searchTerms: ['buildinpublic'] }, 4, factory);

        expect(items.map((i) => i.id)).toEqual(['111', '222']);
        expect(stats.searchCapability).toBe('supported');
    });

    it('records SEARCH_WALLED and returns nothing when the probe finds the surface walled', async () => {
        const { factory } = makeFactory({ profile: makeProfile('ug', 'good'), pages: [], searchMode: 'walled', searchPages: [] });
        const { items, stats } = await run({ searchTerms: ['buildinpublic'] }, 4, factory);

        expect(items).toHaveLength(0);
        expect(stats.errorCounts.SEARCH_WALLED).toBe(1);
        expect(stats.searchCapability).toBe('walled');
    });

    it('a walled search does not sink a run that also scrapes authors', async () => {
        const { factory } = makeFactory({
            profile: makeProfile('ug', 'good'),
            pages: [makePage(['111', '222'], undefined)],
            searchMode: 'walled',
            searchPages: [],
        });
        const { items, stats } = await run({ fromUsers: ['good'], searchTerms: ['x'] }, 4, factory);

        expect(items.map((i) => i.id)).toEqual(['111', '222']);
        expect(stats.errorCounts.SEARCH_WALLED).toBe(1);
        expect(stats.searchCapability).toBe('walled');
    });

    it('rotates the session when the search probe is rate-limited, then collects', async () => {
        let remaining429 = 1;
        const clients: FakeXClient[] = [];
        const factory: XClientFactory = () => {
            const client = new FakeXClient(makeProfile('ug', 'good'), [], '500', 'supported', [makeSearchPage(['111', '222'], undefined)]);
            const origSearch = client.searchTimeline.bind(client);
            client.searchTimeline = async (rawQuery: string, options?: { count?: number; cursor?: string }) => {
                if (remaining429 > 0) {
                    remaining429 -= 1;
                    throw new RequestErrorLike('GraphQL SearchTimeline failed HTTP 429', { status: 429 });
                }
                return origSearch(rawQuery, options);
            };
            clients.push(client);
            return client as unknown as XClient;
        };
        const { items, stats } = await run({ searchTerms: ['x'] }, 4, factory);

        expect(items.map((i) => i.id)).toEqual(['111', '222']);
        expect(stats.searchCapability).toBe('supported');
        expect(clients).toHaveLength(2);
        expect(clients.every((c) => c.closeCalls === 1)).toBe(true);
    });

    it('rejects searchTerms with other targets skipped when every term is walled but does not crash', async () => {
        const { factory } = makeFactory({ profile: makeProfile('ug', 'good'), pages: [], searchMode: 'walled', searchPages: [] });
        const { items, stats } = await run({ searchTerms: ['a', 'b'] }, 4, factory);

        expect(items).toHaveLength(0);
        expect(stats.errorCounts.SEARCH_WALLED).toBe(2);
    });
});