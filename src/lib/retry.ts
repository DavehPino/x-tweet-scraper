import { RETRY } from '../config.js';

/** HTTP statuses that are safe to retry. */
const RETRYABLE_STATUS = new Set([408, 413, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number | undefined): boolean {
    return status === undefined || RETRYABLE_STATUS.has(status);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BackoffOptions {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/**
 * Retry loop with exponential backoff and full jitter.
 * Distinguishes retryable (network error / 429 / 5xx) from fatal errors.
 */
export async function withBackoff<T>(fn: () => Promise<T>, options: BackoffOptions = {}): Promise<T> {
    const attempts = options.attempts ?? RETRY.maxAttempts;
    const baseDelayMs = options.baseDelayMs ?? RETRY.baseDelayMs;
    const maxDelayMs = options.maxDelayMs ?? RETRY.maxDelayMs;
    const jitter = options.jitter ?? RETRY.jitter;

    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            return await fn();
        } catch (err) {
            const retryable = err instanceof RequestErrorLike ? err.retryable : true;
            if (!retryable || attempt >= attempts) {
                throw err;
            }
            const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const min = exponential * (1 - jitter);
            const max = exponential * (1 + jitter);
            const delay = min + Math.random() * (max - min);
            options.onRetry?.(attempt, delay, err);
            await sleep(delay);
        }
    }
}

/** Minimal error shape so retry logic does not depend on a concrete HTTP library. */
export class RequestErrorLike extends Error {
    status?: number;
    retryable: boolean;
    constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
        super(message);
        if (opts.status !== undefined) this.status = opts.status;
        this.retryable = opts.retryable ?? isRetryableStatus(opts.status);
    }
}