/** Loose, typed views over X's internal GraphQL JSON. */

export interface RawMedia {
    type: string;
    media_url_https?: string;
    expanded_url?: string;
}

export interface RawUserLegacy {
    id_str: string;
    screen_name: string;
    name: string;
    verified?: boolean;
    followers_count?: number;
    friends_count?: number;
}

export interface RawUserCore {
    __typename?: string;
    rest_id: string;
    is_blue_verified?: boolean;
    legacy?: RawUserLegacy;
    /** New (2026) shape: name + handle moved out of legacy. */
    core?: { created_at?: string; name?: string; screen_name?: string };
    relationship_counts?: { followers?: number; following?: number };
    verification?: { verified?: boolean; verified_type?: string };
    profile_bio?: { description?: string };
}

export interface RawTweetLegacy {
    created_at: string;
    full_text: string;
    id_str: string;
    conversation_id_str: string;
    in_reply_to_status_id_str: string | null;
    lang: string | null;
    favorite_count: number;
    retweet_count: number;
    reply_count: number;
    quote_count: number;
    bookmark_count: number;
    is_quote_status: boolean;
    user_id_str: string;
    source: string | null;
    entities?: {
        hashtags?: { text: string }[];
        user_mentions?: { screen_name: string }[];
        urls?: { expanded_url: string }[];
        media?: RawMedia[];
    };
    extended_entities?: { media?: RawMedia[] };
    retweeted_status_result?: { result?: RawTweetResult };
}

export interface RawTweetResult {
    __typename?: string;
    rest_id?: string;
    core?: { user_results?: { result?: RawUserCore } };
    legacy?: RawTweetLegacy;
    /** Wrapper used by TweetWithVisibilityResults. */
    tweet?: { legacy?: RawTweetLegacy; core?: { user_results?: { result?: RawUserCore } } };
    views?: { count?: string };
    quoted_status_result?: { result?: RawTweetResult };
}

export interface RawEntry {
    entryId?: string;
    content?: {
        __typename?: string;
        itemContent?: { tweet_results?: { result?: RawTweetResult } };
        value?: string;
        cursorType?: string;
    };
}

export interface RawInstruction {
    type?: string;
    entry?: RawEntry;
    entries?: RawEntry[];
}

export interface RawUserTweetsResponse {
    data?: {
        user?: {
            result?: {
                timeline?: {
                    timeline?: { instructions?: RawInstruction[] };
                };
            };
        };
    };
}

export interface RawUserByScreenNameResponse {
    data?: { user?: { result?: RawUserCore } };
}

export interface RawTweetByIdResponse {
    data?: { tweetResult?: { result?: RawTweetResult } };
}

export interface RawSearchTimelineResponse {
    data?: {
        search_by_raw_query?: {
            search_timeline?: {
                timeline?: { instructions?: RawInstruction[] };
            };
        };
    };
}