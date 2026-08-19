import { type SearchCapability } from './types.js';

export interface ErrorCounts {
    [errorType: string]: number;
}

/**
 * Final run summary (see assessment §7 observability).
 * `limited` is set only when the free-tier cap applies.
 */
export interface RunStats {
    requested: number;
    fetched: number;
    pushed: number;
    limited?: boolean;
    reason?: string;
    cap?: number;
    errorCounts: ErrorCounts;
    startedAt: string;
    finishedAt?: string;
    /** Set when searchTerms were requested; reflects what the run observed. */
    searchCapability?: SearchCapability;
}

export function createStats(requested: number, startedAt = new Date().toISOString()): RunStats {
    return {
        requested,
        fetched: 0,
        pushed: 0,
        errorCounts: {},
        startedAt,
    };
}

export function bumpFetched(stats: RunStats, n = 1): void {
    stats.fetched += n;
}

export function bumpPushed(stats: RunStats, n = 1): void {
    stats.pushed += n;
}

export function recordError(stats: RunStats, errorType: string): void {
    stats.errorCounts[errorType] = (stats.errorCounts[errorType] ?? 0) + 1;
}

export function markLimited(stats: RunStats, cap: number, reason: string): void {
    stats.limited = true;
    stats.reason = reason;
    stats.cap = cap;
}

/** Merges a per-session search capability observation into the run summary (best-wins). */
export function setSearchCapability(stats: RunStats, capability: SearchCapability): void {
    const rank: Record<SearchCapability, number> = { supported: 3, rate_limited: 2, walled: 1 };
    if (!stats.searchCapability || rank[capability] > rank[stats.searchCapability]) {
        stats.searchCapability = capability;
    }
}

export function finishStats(stats: RunStats): RunStats {
    stats.finishedAt = new Date().toISOString();
    return stats;
}