import { ProxyAgent } from 'undici';
import { USER_AGENT } from '../config.js';
import { RequestErrorLike, withBackoff } from './retry.js';

export interface HttpResponse {
    status: number;
    ok: boolean;
    headers: Headers;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
}

export interface HttpClientOptions {
    proxyUrl?: string;
    /** Browser-like headers sent on every request (X requires these to pass Cloudflare). */
    headers?: Record<string, string>;
}

const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes',
    origin: 'https://x.com',
    referer: 'https://x.com/',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    accept: '*/*',
};

/**
 * HTTP client over undici (native fetch). Supports an HTTP/HTTPS proxy via
 * undici's ProxyAgent, which integrates Apify Proxy URLs (including the
 * per-session residential rotation).
 */
export class HttpClient {
    private readonly proxyAgent?: ProxyAgent;
    private readonly headers: Record<string, string>;

    constructor(options: HttpClientOptions = {}) {
        if (options.proxyUrl) {
            this.proxyAgent = new ProxyAgent(options.proxyUrl);
        }
        this.headers = { ...BROWSER_HEADERS, ...options.headers };
    }

    close(): void {
        this.proxyAgent?.close();
    }

    async request(method: string, url: string, init: RequestInit = {}): Promise<HttpResponse> {
        const requestInit: RequestInit = {
            ...init,
            method,
            headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
        };
        // ProxyAgent's type differs from undici-types' Dispatcher; the assignment
        // is type-safe at runtime (undici ProxyAgent implements Dispatcher).
        if (this.proxyAgent) {
            (requestInit as { dispatcher?: unknown }).dispatcher = this.proxyAgent;
        }
        const res = await fetch(url, requestInit);
        return {
            status: res.status,
            ok: res.ok,
            headers: res.headers,
            text: () => res.text(),
            json: <T>() => res.json() as Promise<T>,
        };
    }

    async get(url: string, init: RequestInit = {}): Promise<HttpResponse> {
        return this.request('GET', url, init);
    }

    async post(url: string, init: RequestInit = {}): Promise<HttpResponse> {
        return this.request('POST', url, init);
    }
}

/** GET a URL with bounded retries, returning text or throwing a classified error. */
export async function httpGetText(client: HttpClient, url: string, opts: { maxAttempts?: number } = {}): Promise<string> {
    return withBackoff(
        async () => {
            const res = await client.get(url);
            const body = await res.text();
            if (!res.ok) {
                throw new RequestErrorLike(`HTTP ${res.status} for ${url}`, { status: res.status });
            }
            return body;
        },
        {
            ...(opts.maxAttempts !== undefined ? { attempts: opts.maxAttempts } : {}),
            onRetry: (_a, _d, err) => console.warn(`[http] retry after ${String(err)}`),
        },
    );
}