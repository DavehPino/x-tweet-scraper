import { XClient, userIdFromProfile } from '../src/lib/x-client.js';
import { logger } from '../src/logger.js';

async function main(): Promise<void> {
    const client = new XClient();
    try {
        const profile = await client.getUserByScreenName('apify');
        const userId = userIdFromProfile(profile);
        if (!userId) {
            logger.error('No userId resolved');
            return;
        }
        logger.info({ userId }, 'profile ok');

        const timeline = await client.getUserTweets(userId, { count: 20 });
        const instructions = timeline?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
        const entries = instructions.flatMap((i) => (i.entry ? [i.entry] : (i.entries ?? [])));
        const tweets = entries.filter((e) => e.content?.itemContent?.tweet_results?.result?.rest_id);
        const cursor = entries.find((e) => e.entryId?.startsWith('cursor-bottom'))?.content?.value;
        logger.info({ tweets: tweets.length, cursor: !!cursor }, 'timeline ok');
        logger.info({ ids: tweets.map((t) => t.content?.itemContent?.tweet_results?.result?.rest_id).slice(0, 3) }, 'sample ids');

        const firstId = tweets[0]?.content?.itemContent?.tweet_results?.result?.rest_id;
        if (firstId) {
            const byId = await client.getTweetById(firstId);
            const legacy = byId?.data?.tweetResult?.result?.legacy;
            logger.info({ id: firstId, text: legacy?.full_text?.slice(0, 50) }, 'tweetById ok');
        }
    } finally {
        client.close();
    }
}

void main().catch((err) => {
    logger.error({ err: String(err) }, 'smoke failed');
    process.exit(1);
});