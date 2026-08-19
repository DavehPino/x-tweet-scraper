import { Actor } from 'apify';
import { ENTITLEMENTS_STORE_NAME, FREE_CAP } from './config.js';
import { logger } from './logger.js';

export interface Entitlement {
    isPaid: boolean;
    /** Runner identity from the Apify environment, when resolvable. */
    userId: string | null;
    /** Cap for this run. Free = FREE_CAP, paid = user's maxResults. */
    cap: number;
}

/**
 * Resolve whether the user *running the actor* is paid.
 *
 * Design (assessment §6):
 *  - Source of truth is a server-side Apify named KV store keyed by userId.
 *    Only the actor owner's token can write to it; the runner cannot modify it
 *    through input, env vars or run options.
 *  - Fail-closed: any error / unknown user / missing config resolves to free.
 */
export async function resolveEntitlement(): Promise<Entitlement> {
    const userId = Actor.getEnv().userId ?? null;
    if (!userId) {
        logger.warn({ reason: 'no_user_id' }, 'Entitlement: no userId in env, failing closed to free');
        return { isPaid: false, userId, cap: FREE_CAP };
    }

    try {
        const store = await Actor.openKeyValueStore(ENTITLEMENTS_STORE_NAME);
        const isPaid = (await store.getValue<unknown>(userId)) === true;
        logger.info({ userId, isPaid }, 'Entitlement resolved from server-side KV store');
        return { isPaid, userId, cap: isPaid ? Number.POSITIVE_INFINITY : FREE_CAP };
    } catch (err) {
        logger.warn({ err: String(err), reason: 'entitlement_lookup_failed' }, 'Entitlement lookup failed, failing closed to free');
        return { isPaid: false, userId, cap: FREE_CAP };
    }
}