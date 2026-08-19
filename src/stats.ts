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

export function finishStats(stats: RunStats): RunStats {
    stats.finishedAt = new Date().toISOString();
    return stats;
}