import { Actor } from 'apify';
import { type ProxyConfigurationInput } from '../types.js';

interface ProxyConfigLike {
    newUrl(sessionId?: string | number): Promise<string | undefined>;
}

export interface ProxyHandle {
    /** Proxy URL for the given session (nil when no proxy is configured). */
    newUrl(sessionId?: string): Promise<string | undefined>;
}

const SESSION_ID_INVALID = /[^\w._~]/g;

/**
 * Sanitize a label into a valid Apify Proxy session ID.
 * Apify validates sessionId with /^[\w._~]+$/ — no hyphens, spaces, etc.
 * The mapping is deterministic so each author always gets the same session/IP.
 */
export function sessionIdFor(label: string): string {
    return label.replace(SESSION_ID_INVALID, '_').slice(0, 50);
}

/**
 * Builds an Apify Proxy handle from the input's proxyConfiguration.
 * Falls back to no proxy when Apify Proxy is disabled or unavailable
 * (local runs).
 */
export async function createProxyHandle(input?: ProxyConfigurationInput): Promise<ProxyHandle> {
    const useApifyProxy = input?.useApifyProxy ?? true;
    if (!useApifyProxy) return { newUrl: async () => undefined };

    try {
        const config: ProxyConfigLike | undefined = await Actor.createProxyConfiguration({
            useApifyProxy: true,
            ...(input?.apifyProxyGroups ? { groups: input.apifyProxyGroups } : {}),
            ...(input?.apifyProxyCountry ? { countryCode: input.apifyProxyCountry } : {}),
        });
        if (!config) return { newUrl: async () => undefined };
        return {
            newUrl: async (sessionId) => (sessionId ? config.newUrl(sessionId) : config.newUrl()),
        };
    } catch (err) {
        // Local runs without Apify Proxy return undefined (direct connection).
        return { newUrl: async () => undefined };
    }
}