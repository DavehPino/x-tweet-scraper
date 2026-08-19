import { Actor } from 'apify';
import { logger } from '../logger.js';

export const RUN_STATE_KEY = 'RUN_STATE';

export interface RunState {
    /** Global dedup set (ids already collected). */
    seen: string[];
    /** Per-author (or target) last seen cursor, keyed by target id. */
    cursors: Record<string, string>;
}

export function createRunState(): RunState {
    return { seen: [], cursors: {} };
}

/**
 * Loads persisted state from the run's KV store so a resurrected run resumes
 * instead of restarting (assessment §7 "state").
 */
export async function loadRunState(): Promise<RunState> {
    try {
        const store = await Actor.openKeyValueStore();
        const record = await store.getValue<RunState>(RUN_STATE_KEY);
        if (record && (record.seen?.length || Object.keys(record.cursors ?? {}).length)) {
            logger.info({ seen: record.seen.length, cursors: Object.keys(record.cursors).length }, 'Resuming from persisted state');
            return record;
        }
    } catch (err) {
        logger.warn({ err: String(err) }, 'Could not load run state, starting fresh');
    }
    return createRunState();
}

export async function saveRunState(state: RunState): Promise<void> {
    try {
        const store = await Actor.openKeyValueStore();
        await store.setValue(RUN_STATE_KEY, JSON.stringify(state), { contentType: 'application/json' });
    } catch (err) {
        logger.warn({ err: String(err) }, 'Could not persist run state');
    }
}

/** Registers a migration handler that persists state right before the run is resurrected. */
export function registerMigratingHandler(state: RunState): void {
    Actor.on('migrating', () => {
        logger.info({ seen: state.seen.length, cursors: Object.keys(state.cursors).length }, 'Persisting state on migration');
        void saveRunState(state);
    });
}