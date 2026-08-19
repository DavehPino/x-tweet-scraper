import { pathToFileURL } from 'node:url';
import { Actor } from 'apify';
import { resolveEntitlement } from './entitlement.js';
import { logger } from './logger.js';
import { createStats, finishStats, markLimited, bumpPushed, type RunStats } from './stats.js';
import { FREE_CAP } from './config.js';
import { parseInput, type ValidatedInput } from './validation.js';
import { fetchSurface } from './lib/surfaces.js';
import { loadRunState, registerMigratingHandler, saveRunState } from './lib/resumer.js';
import { type OutputItem } from './types.js';

interface RunContext {
    input: ValidatedInput;
    cap: number;
    isPaid: boolean;
    stats: RunStats;
}

export function makeRunContext(input: ValidatedInput, cap: number, isPaid: boolean): RunContext {
    return { input, cap, isPaid, stats: createStats(isPaid ? cap : FREE_CAP) };
}

/**
 * Enforcement point of the free-tier cap: the push loop.
 * We never clamp `maxResults` up front; we stop pushing at the cap here.
 */
export async function pushResults(dataset: { pushData: (item: OutputItem | OutputItem[]) => Promise<unknown> }, items: OutputItem[], ctx: RunContext): Promise<void> {
    const remaining = ctx.cap - ctx.stats.pushed;
    if (remaining <= 0) return;

    const toPush = items.slice(0, remaining);
    if (toPush.length > 0) {
        await dataset.pushData(toPush);
        bumpPushed(ctx.stats, toPush.length);
    }

    if (!ctx.isPaid && ctx.stats.pushed >= ctx.cap) {
        markLimited(ctx.stats, ctx.cap, 'free_tier');
        logger.warn({ cap: ctx.cap, reason: 'free_tier' }, 'Free-tier cap reached; stopped emitting results');
    }
}

export function effectiveCap(input: ValidatedInput, isPaid: boolean): number {
    const requested = input.maxResults ?? 100;
    return isPaid ? requested : Math.min(requested, FREE_CAP);
}

async function run(): Promise<void> {
    const startedAt = new Date().toISOString();
    const rawInput = (await Actor.getInput<Record<string, unknown>>()) ?? {};
    const input = parseInput(rawInput);

    const entitlement = await resolveEntitlement();
    const cap = effectiveCap(input, entitlement.isPaid);

    const ctx: RunContext = {
        input,
        cap,
        isPaid: entitlement.isPaid,
        stats: createStats(entitlement.isPaid ? cap : FREE_CAP, startedAt),
    };

    logger.info(
        {
            userId: entitlement.userId,
            isPaid: entitlement.isPaid,
            cap,
            surfaces: buildSurfaceSummary(input),
        },
        'Run started',
    );

    const dataset = await Actor.openDataset();
    const state = await loadRunState();
    registerMigratingHandler(state);

    try {
        const items = await fetchSurface(input, ctx.cap, entitlement.userId, ctx.stats, state);
        await pushResults(dataset, items, ctx);
        await saveRunState(state);
        if (input.searchTerms?.length) {
            logger.info({ searchCapability: ctx.stats.searchCapability ?? 'skipped' }, 'Search surface result');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'Run failed');
        throw err;
    } finally {
        const summary = finishStats(ctx.stats);
        logger.info(summary, 'Run finished');
        await Actor.setValue('SUMMARY.json', summary);
    }
}

function buildSurfaceSummary(input: ValidatedInput): Record<string, number> {
    return {
        fromUsers: input.fromUsers?.length ?? 0,
        tweetIds: input.tweetIds?.length ?? 0,
        searchTerms: input.searchTerms?.length ?? 0,
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    Actor.main(run);
}