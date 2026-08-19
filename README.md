# x-tweet-scraper

A production-grade, **browserless** X (Twitter) scraper running as an [Apify Actor](https://apify.com/). It speaks directly to X's **internal GraphQL API** over HTTP using guest tokens — no Playwright, no Puppeteer, no browser engine of any kind.

Built for the Puente Talent / OPUS Senior Full-Stack assessment (v2).

## Highlights

- **Guest-reachable surfaces** (required): tweets by author (`UserTweets`), single hydrated tweet (`TweetResultByRestId`), profile by handle (`UserByScreenName`).
- **Search bonus (`searchTerms`)**: implemented with **runtime auto-detection** — each run probes whether `SearchTimeline` is guest-reachable from its IP/session and either pages results or fails closed with a clear error (never silently empty).
- **Browserless HTTP**: undici (native fetch) with browser-like headers and Cloudflare cookie warm-up.
- **Self-healing query IDs**: per-operation GraphQL `queryId`s are extracted at runtime from the x.com JS bundle, with a hard-coded fallback.
- **Rich filtering**: hashtags, since/until, language, engagement floors, verified-only, media type, replies/retweets, sorting.
- **Tamper-proof free-tier gate**: server-authoritative entitlement check, fail-closed, enforced at the push loop. Free users never get more than 10 results.
- **Resilience**: exponential backoff + jitter, guest-token rotation on 403, per-session proxy rotation, cross-page dedup, resume-after-migration.
- **Performance**: local time-to-100 measured at **22.1 s** (grade A, < 30 s).

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture & data flow](#architecture--data-flow)
3. [The no-browser approach](#the-no-browser-approach)
   - [Finding the guest-reachable surfaces](#finding-the-guest-reachable-surfaces)
   - [Query IDs: where they live and why they change](#query-ids-where-they-live-and-why-they-change)
4. [Input schema](#input-schema)
5. [Output schema](#output-schema)
6. [Free-tier protection (the most important part)](#free-tier-protection-the-most-important-part)
   - [Anti-bypass reasoning](#anti-bypass-reasoning)
   - [Anti-fork reasoning](#anti-fork-reasoning)
7. [Engineering requirements](#engineering-requirements)
8. [Performance & benchmark](#performance--benchmark)
9. [Cost awareness](#cost-awareness)
10. [How to run locally](#how-to-run-locally)
11. [How to deploy on Apify](#how-to-deploy-on-apify)
12. [Testing](#testing)
13. [Known limitations](#known-limitations)
14. [ToS / robots considerations](#tos--robots-considerations)

---

## What it does

Given a set of targets and filters (see [input schema](#input-schema)), the actor fetches matching **public tweets** from X using HTTP requests only, normalizes each one to an exact output contract, and pushes it to the Apify dataset. Every run honors the free-tier cap server-side.

Implemented surfaces (all guest-reachable):

| Surface | X internal operation | Input |
|---|---|---|
| Tweets by author | `UserTweets` (profile timeline, cursor-paginated) | `fromUsers` |
| Single tweet by id | `TweetResultByRestId` (fully hydrated) | `tweetIds` |
| User profile by handle | `UserByScreenName` | used to resolve author timelines |
| Free-text search (bonus) | `SearchTimeline` (cursor-paginated) | `searchTerms` |

`searchTerms` (free-text search) is implemented with runtime auto-detection: the run probes `SearchTimeline` from its own session/IP. When reachable (observed with guest auth on residential IPs), it pages results through the same dedup/filter/cap pipeline; when X walls it (measured on a datacenter IP in Aug 2026: 404 across all products while `UserTweets` returned 200 in the same session), the surface fails closed with a clear error and the run summary records `searchCapability: "walled"` — it never silently returns nothing (see [Known limitations](#known-limitations)).

---

## Architecture & data flow

```
INPUT_SCHEMA.json ──► validation.ts (zod, boundary)
                          │
                          ▼
                     main.ts  ──► entitlement.ts (KV store, fail-closed)
                          │
                          ▼
                     lib/surfaces.ts  (dispatch, concurrency, global seen-set)
                          │
                          ├──► lib/x-client.ts   (guest token + GraphQL, query-id resolution)
                          ├──► lib/paginator.ts  (cursor paging, dedup)
                          ├──► lib/proxy.ts      (per-session Apify Proxy URL)
                          └──► normalizer.ts + filters.ts
                          │
                          ▼
                     pushResults()  (free-tier enforcement point)
                          │
                          ▼
                     dataset ──► SUMMARY.json (requested/fetched/pushed, limited flag)
```

```
src/
  main.ts              Actor.main: input → entitlement → surface → push → summary
  types.ts             Input, OutputItem (§5), enums
  validation.ts        zod schema for the input boundary
  config.ts            constants (web bearer, endpoints, retry, cap)
  normalizer.ts        raw GraphQL tweet → exact §5 output item
  filters.ts           post-filters with AND semantics
  entitlement.ts       KV-store entitlement resolution (fail-closed → free)
  stats.ts             run summary + error counters
  lib/
    x-client.ts        guest-token lifecycle + GraphQL calls
    query-ids.ts       runtime extraction of query IDs from the x.com bundle
    features.ts        per-operation GraphQL feature flags (verified empirically)
    retry.ts           exponential backoff + jitter, retryable vs fatal
    proxy.ts           Actor.createProxyConfiguration() → per-session URL
    paginator.ts       cursor handling, seen-set, page dedup
    resumer.ts         Actor.on('migrating') + persisted RUN_STATE
    http.ts            undici client (proxy via ProxyAgent, browser headers)
    raw-types.ts       typed views over the raw GraphQL JSON
  scripts/             dev-only smoke + benchmark scripts
test/                  vitest suites + fixtures
```

**Run flow**

1. Validate the input at the boundary with zod (reject malformed input).
2. Resolve entitlement from `Actor.getEnv().userId` against the server-side KV store. **Fail-closed**: anything unknown = free.
3. Compute the effective cap: `paid ? maxResults : min(maxResults, 10)`.
4. For each `fromUsers` handle: resolve the user id (`UserByScreenName`), then page the profile timeline (`UserTweets`) with cursor handling, normalizing and filtering each tweet. Authors are scraped concurrently (pool of 4). Each author uses its own session (own proxy IP when configured).
5. For each `tweetIds`: hydrate via `TweetResultByRestId`, normalize, filter.
6. For each `searchTerms`: probe `SearchTimeline` from the term's own session; if reachable, page results (product `Latest`/`Top` per `sortBy`); if walled/rate-limited, log + count it and move on (fail-closed, never silently empty).
7. A **global seen-set** de-duplicates across pages, terms and overlapping targets.
8. Push results through `pushResults()`, which stops at the entitlement cap and flags the run when the free tier applied.
9. Emit `SUMMARY.json` with requested / fetched / pushed, error counts, the `searchCapability` flag, and the `limited` flag.

---

## The no-browser approach

All requests are plain HTTP via **undici / native fetch**. We deliberately chose undici over `got-scraping`: got-scraping is ESM-only and undici gives first-class HTTP/S proxy support through its `ProxyAgent`, which integrates Apify Proxy URLs directly (including per-session residential rotation). This is one of the options the assessment explicitly allows.

### Finding the guest-reachable surfaces

The assessment's key hint: *the public web bearer is a well-known constant; the per-operation query identifiers are not — think about where they live and how they change.*

Empirical findings (verified live):

1. **Guest token**: `POST https://api.twitter.com/1.1/guest/activate.json` with the public web bearer
   `AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`
   returns a `guest_token`. This still works in 2026 for the **web** bearer (some Android-era bearers reported dead; the web bearer is the supported path).
2. **Host matters**: the GraphQL endpoint `x.com/i/api/graphql/{queryId}/{operation}` only exists on the **web host** `x.com`. The API hosts (`api.twitter.com` / `api.x.com`) answer `/1.1/*` but return **404** for `/i/api/graphql/*`.
3. **Cloudflare**: the GraphQL endpoint sits behind Cloudflare. A bare request 403s; you must first **warm up** `https://x.com/home` to collect the Cloudflare (`__cf_bm`) and guest cookies, then replay them on every GraphQL call together with browser-like headers (`sec-ch-ua`, `sec-fetch-*`, `origin`, `referer`, `x-twitter-client-language`, `x-twitter-active-user`).
4. **Three operations are guest-reachable** and cover all required surfaces: `UserByScreenName`, `UserTweets`, `TweetResultByRestId`.
5. **`SearchTimeline` (search) is probed at runtime**, not assumed. A live probe (Aug 2026) from a datacenter IP returned **404 for every product** (Latest/Top/People/Photos/Videos) while `UserTweets` returned 200 in the same session — X hides auth-walled operations behind 404. Community reports (2026) indicate the operation does open to guests from residential IPs but is restricted (recent window, small caps). The actor probes per run and fails closed when walled (see [Known limitations](#known-limitations)).

### Query IDs: where they live and why they change

Every X deploy ships a new JS bundle and the GraphQL operation IDs inside it change. The IDs live in the web client bundle at:

```
https://abs.twimg.com/responsive-web/client-web/main.<hash>.js
```

matching the module shape `{ queryId:"...", operationName:"..." }`. Rather than hard-coding IDs that will rot, `query-ids.ts`:

1. fetches the x.com homepage, finds the `main.*.js` bundle URL (cached for the whole run),
2. extracts each needed `queryId` with the regex `queryId:"...",operationName:"<Operation>"`,
3. falls back to community-documented IDs (`fa0311/TwitterInternalAPIDocument` style) if extraction fails.

The GraphQL **feature flags** per operation are empirical constants (they drift far less often than query IDs) and are kept in `lib/features.ts`.

**2026 response shape** (changed from older guides): timelines live under `result.timeline.timeline.instructions`, where each instruction carries `entry` (single) or `entries` (array), including `cursor-bottom` entries for pagination. The user object no longer has `legacy`; the author fields now live in `core.{name, screen_name}`, `relationship_counts`, `verification` and `is_blue_verified`.

---

## Input schema

Full JSON Schema in `.actor/INPUT_SCHEMA.json`; validated with zod at the boundary. At least one of `fromUsers`, `tweetIds` or `searchTerms` is required. Filters combine with **AND** semantics; unspecified filters mean "no constraint".

| Field | Type | Meaning |
|---|---|---|
| `fromUsers` | `string[]` | Handles (no `@`) whose tweets to scrape |
| `tweetIds` | `string[]` | Specific tweet IDs to hydrate |
| `searchTerms` | `string[]` | Free-text queries — auto-detected at runtime; fails closed with a clear error when X walls the search surface for guests |
| `hashtags` | `string[]` | Must contain these hashtags (no `#`) |
| `since` / `until` | ISO date | Inclusive window on tweet creation time |
| `language` | ISO-639-1 | Detected tweet language |
| `minLikes` / `minRetweets` / `minReplies` | int | Engagement floors |
| `onlyVerified` | boolean | Only tweets from verified authors |
| `mediaType` | enum | `any` / `text_only` / `images` / `video` / `links` |
| `includeReplies` / `includeRetweets` | boolean | Whether replies / retweets count as results (retweets default `false`) |
| `sortBy` | enum | `latest` / `top` |
| `maxResults` | int | Requested cap (subject to the free-tier limit) |
| `proxyConfiguration` | object | Standard Apify proxy object (groups, country) |

Example:

```json
{
  "fromUsers": ["apify", "elonmusk"],
  "hashtags": ["buildinpublic"],
  "since": "2025-01-01",
  "language": "en",
  "minLikes": 25,
  "mediaType": "any",
  "includeReplies": false,
  "includeRetweets": false,
  "sortBy": "latest",
  "maxResults": 500,
  "proxyConfiguration": { "useApifyProxy": true, "apifyProxyGroups": ["RESIDENTIAL"] }
}
```

---

## Output schema

Every dataset item conforms exactly to the assessment §5 contract. Missing values are `null` (never omitted, never `undefined`); timestamps are ISO-8601 UTC; counts are integers; `id` is a string, never a JS number.

```json
{
  "id": "string",
  "url": "https://x.com/<user>/status/<id>",
  "text": "string",
  "lang": "string | null",
  "createdAt": "ISO-8601 UTC",
  "conversationId": "string | null",
  "isReply": "boolean",
  "isRetweet": "boolean",
  "isQuote": "boolean",
  "inReplyToId": "string | null",
  "quotedTweetId": "string | null",
  "author": {
    "id": "string",
    "username": "string",
    "name": "string",
    "verified": "boolean",
    "followers": "number",
    "following": "number"
  },
  "metrics": {
    "likes": "number",
    "retweets": "number",
    "replies": "number",
    "quotes": "number",
    "bookmarks": "number | null",
    "views": "number | null"
  },
  "entities": {
    "hashtags": ["string"],
    "mentions": ["string"],
    "urls": ["string"],
    "media": [{ "type": "photo|video|animated_gif", "url": "string", "thumbnail": "string | null" }]
  },
  "source": "string | null",
  "scrapedAt": "ISO-8601 UTC"
}
```

Notes on the normalization (`src/normalizer.ts`):

- `text` is the full text with `t.co` short links **expanded** to their `expanded_url`.
- `created_at` ("Wed Aug 12 16:12:32 +0000 2026") is parsed explicitly (not all JS engines parse it) into ISO-8601 UTC.
- `isReply` / `isRetweet` / `isQuote` are derived from `in_reply_to_status_id_str`, `retweeted_status_result` and `is_quote_status` / `quoted_status_result`.
- Tombstones (`TweetTombstone` / `TweetUnavailable`) and malformed payloads are dropped, never pushed.

---

## Free-tier protection (the most important part)

This is weighted most heavily by the assessment, so the design is deliberately server-authoritative.

**Entitlement resolution** (`src/entitlement.ts`)

- Runner identity comes from the Apify environment: `Actor.getEnv().userId`.
- The source of truth is a **server-side Apify named KV store** (`x-tweet-scraper-entitlements`) keyed by `userId`. Only the actor owner's credentials can write to that store; the runner cannot touch it through input, env vars or run options.
- The owner marks a user as paid by setting `store.setValue(userId, true)`. Everything else is free.
- **Fail-closed**: any error, unknown user, or missing env identity resolves to free. A network blip can never accidentally un-cap a user.

**Enforcement point** (`src/main.ts` → `pushResults`)

- The cap is applied where results are emitted — the push loop / pagination — **not** by clamping `maxResults` at the top. A free run with `maxResults: 1000` still fetches and pushes exactly 10.
- When the cap applies, the run pushes exactly 10 items, logs a clear warning, and sets the flag in the run summary: `{ "limited": true, "reason": "free_tier", "cap": 10 }`.

**Transparency**: `SUMMARY.json` is written to the default key-value store at the end of every run.

### Anti-bypass reasoning

A user cannot lift the cap because:

- `maxResults` is never trusted for free users — the effective cap is computed from the entitlement, and the enforcement happens at emission time, so even adding undocumented input fields does not help.
- The check does not read anything the user can set. It reads the **runner's userId from the Apify run environment** (server-provided) and compares it against a **store the user cannot write to**.
- Editing the input JSON, environment variables or run options only changes things the user controls; the entitlement source is outside their reach.

### Anti-fork reasoning

A user can fork the source and delete the check — but that does not defeat the protection:

- The product that runs for clients is the **published actor version** (the one we deploy and the assessment runs), not the fork.
- If a forker runs their fork under their own Apify account, their `userId` is not in the entitlements store, so they are still free. Removing the check in their own fork only gives *them* an uncapped scraper under their own account — it does not change what paying users receive.
- The source of truth (the KV store) is keyed to the **real runner userId** server-side; there is no client-side-only check to discover and exploit by reading the README or source.

This is the assessment's "acceptable simplification": no real billing system, but an authoritative, server-side, fail-closed, input-impenetrable gate.

---

## Engineering requirements

- **Pagination** — cursor handling on `cursor-bottom` entries, cross-page dedup via a per-author `localSeen` plus a global seen-set. No duplicates across pages (verified).
- **Guest-token lifecycle** — acquire on init, cache per session, **rotate on 403** (a 403 triggers one re-activation + single retry). Retryable (429/5xx) vs fatal (400/auth) are distinguished.
- **Resilience** — exponential backoff with full jitter (`lib/retry.ts`), bounded retries, no hard crash on 429/403, graceful degradation (a failed author logs and moves on).
- **Concurrency & politeness** — bounded author pool (default 4), one proxy session per author so a residential proxy rotates IPs instead of hammering one.
- **State** — `Actor.on('migrating')` persists `RUN_STATE` (global seen-set + per-author cursors) to the KV store; a resurrected run resumes from its cursor instead of restarting (`lib/resumer.ts`).
- **Observability** — pino structured logs; final `SUMMARY.json` with requested / fetched / pushed, the `limited` flag, and per-error-type counters.
- **Types & validation** — TypeScript strict (no `any` leaking through public boundaries), zod at the input boundary, `exactOptionalPropertyTypes` on.
- **Tests** — see [Testing](#testing), including the required proof that a free user with `maxResults: 1000` still gets 10.

---

## Performance & benchmark

The assessment benchmarks wall-clock time to collect 100 valid results end-to-end (first outbound request → 100th item pushed), paid user, latest sort, residential proxy.

**Measured locally (no proxy, `scripts/benchmark.ts`):**

```
time-to-100: 22.1 s   (fetched 164 → pushed 100 after filters)
```

That lands in **grade A (< 30 s)**, leaving headroom for residential-proxy latency on the Apify benchmark run (to be confirmed after deploy). What keeps it fast:

- Query IDs resolved from a single cached bundle fetch (not one download per operation).
- Concurrency across authors (the benchmark target is a single author, so paging is the bottleneck: ~5 pages of 20).
- Tight normalization — no redundant hydration requests for timeline tweets (the author is already embedded).

The same benchmark as a **free** run fetches ~18 items and pushes 10.

---

## Cost awareness

Rough request budget per 1k results on a single-author timeline (paid user, `includeReplies=false`, `includeRetweets=false`):

| Item | Requests |
|---|---|
| Warm-up + guest activation (one session) | 2 |
| Query-ID bundle fetch (cached) | 2 |
| Profile resolution (`UserByScreenName`) | 1 |
| Timeline pages (~20 tweets/page, ~1.4x fetch for filtering) | ~70 |
| **Total** | **~75 requests per 1k results** |

Cost drivers: Apify compute (small, Node 22, sub-minute runs) + Apify Proxy traffic (residential units are the dominant line item — lower by reusing one session/IP per author and batching 20 tweets per request). Exact figures depend on the Apify plan; at current rates this is in the low single-digit USD per 10k results, dominated by residential proxy units.

---

## How to run locally

Requires Node.js ≥ 20 (developed on Node 22) and the Apify CLI (`apify-cli`, installed as a dev dependency).

```bash
npm install

# Build the TypeScript
npm run build

# Type-check (strict)
npm run lint

# Unit tests
npm test
```

To run the actor locally with local storage emulation:

1. Create an input file at `test-data/key_value_stores/default/INPUT.json`:
   ```json
   { "fromUsers": ["apify"], "maxResults": 50, "includeReplies": false, "includeRetweets": false }
   ```
2. Run with local storage pointing at that directory (no Apify token needed):
   ```bash
   CRAWLEE_STORAGE_DIR="$(pwd)/test-data" node dist/main.js
   ```
3. Results land in `test-data/datasets/default/`, and `SUMMARY.json` in the default KV store.

You can also use the Apify CLI locally (`apify run`) once the CLI is configured; the storage-directory approach above works without any token.

Dev-only helpers:

```bash
npx tsx scripts/smoke-client.ts   # live check of profile/timeline/tweetById
npx tsx scripts/benchmark.ts      # local time-to-100
```

---

## How to deploy on Apify

1. Create an account at [apify.com](https://apify.com) and log in with the CLI:
   ```bash
   npx apify-cli login
   ```
2. From the project root, push the actor:
   ```bash
   npx apify-cli push
   ```
   This builds the Docker image (`apify/actor-node:22`) and deploys `x-tweet-scraper`.
3. **Enable the paid entitlement for yourself** (the owner). In the Apify console, open the named key-value store `x-tweet-scraper-entitlements` for this actor and set a record `{ "<your userId>": true }`. Your userId is shown in the actor run environment (or from `Actor.getEnv().userId` in a test run log). Every other userId stays free (fail-closed).
4. Run the actor with the example input above. The default run returns valid items; as a free user it will be capped at 10 with `limited: true`.

---

## Testing

```bash
npm test   # vitest
```

Suites (37 tests):

| File | Covers |
|---|---|
| `test/validation.test.ts` | boundary validation: targets required, unknown fields rejected, since ≤ until |
| `test/normalizer.test.ts` | exact §5 mapping, t.co link expansion, date parsing, tombstones, `TweetWithVisibilityResults` |
| `test/filters.test.ts` | AND semantics for hashtags, window, language, engagement, verified, mediaType, replies/retweets |
| `test/entitlement.test.ts` | **required cap proof**: free user with `maxResults: 1000` still gets 10; paid run uncapped; enforcement at the push loop with the `limited` flag |
| `test/surfaces.test.ts` | resilience (429 rotation, graceful degradation) + **search bonus**: supported probe collects, walled probe fails closed, rotation on rate-limited probe, mixed surfaces |

---

## Known limitations

- **`searchTerms` is implemented with runtime auto-detection and fails closed.** Verified live (Aug 2026): from a datacenter IP, `SearchTimeline` returns **404 for every product** (Latest/Top/People/Photos/Videos) while the guest-reachable surfaces return 200 in the same session — X serves 404 to hide auth-walled operations. Community reports indicate the operation does open to guests from residential IPs, but restricted to a recent window (~7 days) and a small result cap, and it is aggressively rate-limited. The actor therefore probes the operation on every run from its own session/IP: if reachable, `searchTerms` pages results through the normal dedup/filter/cap pipeline; if not, the term is skipped with a logged + counted `SEARCH_WALLED` error and the summary records `searchCapability: "walled"`. With only `searchTerms` in the input and search walled, the run returns zero items with an explicit error — never a silent empty dataset. Run `npx tsx scripts/smoke-search.ts "<term>"` on a residential session to re-verify when one is available. The `/2/tweets/search/*` official API requires paid developer credentials and stays out of scope for a guest-token-only actor.
- **Guest rate limits.** Guest tokens are rate-limited; the retry/backoff and token rotation keep runs clean, but very large paid runs may need multiple sessions/proxy IPs. The benchmark target (100 items) is well within limits.
- **Query IDs and feature flags drift** when X deploys. The runtime bundle extraction handles query IDs automatically; feature flags are empirical constants that are updated in `lib/features.ts` on change (documented in the code).
- **Pinned/highlighted tweets** may repeat across pages; the global seen-set removes them.
- **Protected, suspended or deleted accounts** return no timeline or a tombstone and are skipped gracefully (logged).
- **`sortBy: "top"`** is approximated by sorting collected items by likes; the timeline API returns latest order. For single-author recent-tweet scraping this is the honest limit of the surface.

---

## ToS / robots considerations

Before running this in production for a client, we'd raise:

- **X terms of service** prohibit automated scraping of public data in some jurisdictions and ToS definitions; the assessment itself states these endpoints are used "strictly for public data and assessment purposes." Production use should be legal-reviewed for the target jurisdiction.
- **robots.txt / robots meta**: `x.com/robots.txt` and X's bot-management measures (Cloudflare) indicate automated access is restricted. The actor deliberately stays gentle — bounded concurrency, backoff, per-session IP rotation — to avoid tripping bans, but that is compliance-by-politeness, not a legal green light.
- **Public data only**: this actor uses guest tokens only and never a personal logged-in session; no credentials are hard-coded, and private/protected content is not accessible or targeted.
- **PII / content reuse**: tweets are public, but republishing content (especially images and profiles) can implicate copyright and privacy; the client contract should define how collected data may be stored and used.

---

## Trade-offs & key decisions (short note)

1. **undici over got-scraping** — got-scraping is ESM-only and undici ships first-class proxy support; both are allowed by the assessment. Trade-off: we hand-roll browser headers instead of using got-scraping's header generator.
2. **Runtime query-ID extraction** — more moving parts than hard-coded IDs, but immune to X deploys; this directly answers the assessment's hint about where IDs live and how they change.
3. **Server-side KV store entitlement** — the simplest authoritative gate that satisfies the anti-bypass/anti-fork bar without standing up a billing service; fail-closed by design.
4. **Search as an auto-detected bonus surface** — instead of hard-coding "search is walled", the actor probes `SearchTimeline` per run/session and only claims the surface when it actually opens. This is honest scoping backed by a live measurement (Aug 2026: 404 for guests on datacenter, working per community reports on residential), and it fails closed — a walled probe never produces a silent empty result. If a future X change makes guest search broadly reachable, no code change is needed.
5. **Per-session proxies over a shared pool** — one residential session per author keeps a single IP per scrape stream (politeness) while rotating across authors (scale).