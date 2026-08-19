export const MEDIA_TYPES = ['any', 'text_only', 'images', 'video', 'links'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const SORT_ORDERS = ['latest', 'top'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export interface ProxyConfigurationInput {
    useApifyProxy?: boolean | undefined;
    apifyProxyGroups?: string[] | undefined;
    apifyProxyCountry?: string | undefined;
    apifyProxySession?: string | undefined;
}

/**
 * Actor input per the assessment §4. Unspecified filters = "no constraint".
 */
export interface ActorInput {
    fromUsers?: string[];
    tweetIds?: string[];
    searchTerms?: string[];
    hashtags?: string[];
    since?: string;
    until?: string;
    language?: string;
    minLikes?: number;
    minRetweets?: number;
    minReplies?: number;
    onlyVerified?: boolean;
    mediaType?: MediaType;
    includeReplies?: boolean;
    includeRetweets?: boolean;
    sortBy?: SortOrder;
    maxResults?: number;
    proxyConfiguration?: ProxyConfigurationInput;
}

export interface MediaItem {
    type: 'photo' | 'video' | 'animated_gif';
    url: string;
    thumbnail: string | null;
}

export interface Entities {
    hashtags: string[];
    mentions: string[];
    urls: string[];
    media: MediaItem[];
}

export interface Metrics {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    bookmarks: number | null;
    views: number | null;
}

export interface Author {
    id: string;
    username: string;
    name: string;
    verified: boolean;
    followers: number;
    following: number;
}

/**
 * Output item, exactly per the assessment §5.
 * Missing values are null, never omitted and never undefined.
 */
export interface OutputItem {
    id: string;
    url: string;
    text: string;
    lang: string | null;
    createdAt: string;
    conversationId: string | null;
    isReply: boolean;
    isRetweet: boolean;
    isQuote: boolean;
    inReplyToId: string | null;
    quotedTweetId: string | null;
    author: Author;
    metrics: Metrics;
    entities: Entities;
    source: string | null;
    scrapedAt: string;
}

/**
 * The surface being fetched. Maps 1:1 to X GraphQL operations.
 */
export const SURFACES = ['tweetsByAuthor', 'tweetById', 'profileByHandle', 'search'] as const;
export type Surface = (typeof SURFACES)[number];

export const FREE_TIER_CAP = 10;
export const FREE_TIER_REASON = 'free_tier';