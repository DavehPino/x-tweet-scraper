import { XClient, probeSearch, userIdFromProfile } from '../src/lib/x-client.js';
import { scrapeSearchTimeline } from '../src/lib/paginator.js';
import { logger } from '../src/logger.js';
import { filterOptionsFromInput } from '../src/filters.js';

/**
 * Live probe of the search bonus surface. On a datacenter IP the probe is
 * expected to report `walled` (SearchTimeline returns 404 for guests). Re-run
 * through an Apify residential proxy session to check whether the surface
 * opens there:
 *
 *   npx tsx scripts/smoke-search.ts "buildinpublic"
 */
async function main(): Promise<void> {
    const term = process.argv[2] ?? 'buildinpublic';
    const client = new XClient();
    try {
        const capability = await probeSearch(client);
        logger.info({ capability }, 'search capability probe');

        if (capability !== 'supported') {
            logger.info(
                { capability, hint: 'Try again with Apify Proxy residential (see README) — on datacenter IPs the search surface is usually walled.' },
                'search not available here',
            );
            return;
        }

        const profile = await client.getUserByScreenName('apify');
        const userId = userIdFromProfile(profile);
        const items = await scrapeSearchTimeline(client, term, {
            countPerPage: 40,
            targetCount: 20,
            product: 'Latest',
            filters: filterOptionsFromInput({}),
            seen: new Set(),
        });
        logger.info({ term, items: items.length, sample: items.slice(0, 3).map((i) => i.id) }, 'search ok');
    } finally {
        client.close();
    }
}

void main().catch((err) => {
    logger.error({ err: String(err) }, 'smoke failed');
    process.exit(1);
});