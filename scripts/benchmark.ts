import { fetchSurface } from '../src/lib/surfaces.js';
import { createRunState } from '../src/lib/resumer.js';
import { createStats } from '../src/stats.js';
import { logger } from '../src/logger.js';

/** Local time-to-100 benchmark (paid simulation, no entitlement gate). */
async function main(): Promise<void> {
    const input = { fromUsers: ['apify'], sortBy: 'latest', maxResults: 100, includeReplies: false, includeRetweets: false };
    const stats = createStats(100);
    const state = createRunState();
    const start = Date.now();
    const items = await fetchSurface(input, 100, null, stats, state);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info({ elapsedSec: Number(elapsed), items: items.length, fetched: stats.fetched }, 'time-to-100 benchmark');
}

void main().catch((err) => {
    logger.error({ err: String(err) }, 'benchmark failed');
    process.exit(1);
});