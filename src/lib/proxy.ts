import { Actor } from 'apify';
import { type ProxyConfigurationInput } from '../types.js';

interface ProxyConfigLike {
    newUrl(sessionId?: string | number): Promise<string | undefined>;
}

export interface ProxyHandle {
    /** Proxy URL for the given session (nil when no proxy is configured). */
    newUrl(sessionId?: string): Promise<string | undefined>;
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