# AGENTS.md — x-tweet-scraper

Developer and agent guide for the `x-tweet-scraper` Apify Actor.

## Overview

A browserless X (Twitter) scraper that talks directly to X's internal GraphQL API over plain HTTP using guest tokens. It collects public tweets with rich filtering and ships a server-authoritative, tamper-proof free-tier limit.

## Stack

- Node.js ≥ 20 / TypeScript strict (no `any` across public boundaries), Apify SDK v3 (`Actor`)
- HTTP: `undici` (native fetch, `ProxyAgent` for Apify Proxy); browser-like headers + Cloudflare cookie warm-up
- Input validation: `zod`; Logs: `pino`; Tests: `vitest`
- No browser automation of any kind (build fails if one is added)
- Docker: `apify/actor-node:22`

## Surfaces

Guest-reachable (required):

- Tweets by author — `UserTweets` (cursor-paginated profile timeline)
- Single hydrated tweet — `TweetResultByRestId`
- Profile by handle — `UserByScreenName`

Bonus (auto-detected, fails closed): free-text search — `SearchTimeline`. X walls it
for guests (404 on datacenter IPs, verified live Aug 2026); each run probes it from
its own session/IP (`probeSearch` in x-client.ts) and either pages results or records
`SEARCH_WALLED` in the summary and skips the term. Never silently empty.

No personal credentials. Guest tokens only.

## Architecture

```
src/
  main.ts            Actor.main(): validate input → entitlement → surface → push dataset → summary
  types.ts           Input, OutputItem, enums
  validation.ts      zod input schema (boundary)
  config.ts          constants (web bearer, endpoints, retry, cap)
  lib/
    x-client.ts      guest-token lifecycle + GraphQL calls (api.twitter.com / api.x.com fallback)
    query-ids.ts     runtime extraction of queryIds from the x.com JS bundle + known fallback
    retry.ts         exponential backoff + jitter; retryable (429/5xx) vs fatal (400/auth)
    proxy.ts         per-session Apify Proxy URL
    paginator.ts     cursor handling, seen-set, dedup, concurrent paging per author + search terms
    resumer.ts       Actor.on('migrating') + persisted RUN_STATE (cursors + seen-set)
  normalizer.ts      raw GraphQL tweet → exact output contract (null, never omitted)
  filters.ts         post-filters with AND semantics
  entitlement.ts     named KV store (x-tweet-scraper-entitlements) keyed by userId; fail-closed → free
  stats.ts           run summary {requested, fetched, pushed, limited?, errorCounts}
test/                filters, normalizer (fixtures), entitlement cap (free + maxResults:1000 → 10)
```

## Key decisions

- **Query IDs** change on every X deploy. They live in the x.com web bundle
  (`https://abs.twimg.com/responsive-web/client-web/main.<hash>.js`) as `{ queryId:"...", operationName:"..." }`.
  Extract at runtime with the regex `queryId:"...",operationName:"<Operation>"`; fall back to
  community-documented IDs if extraction fails. The web bearer is a known public constant; the query IDs are not.
- **Guest token**: `POST api.twitter.com/1.1/guest/activate.json` with the public web bearer; rotate on 403.
  Empirically verified in 2026 (web bearer works; some Android-era bearers are dead).
- **Free-tier gate**: server-side entitlement via a named Apify KV store keyed by `Actor.getEnv().userId`
  (only the owner writes). Fail-closed (error/unknown → free). Enforced in the push loop, not by clamping
  `maxResults`. Free = exactly 10 items + `{limited: true, reason: "free_tier", cap: 10}` in the summary.
- **Anti-fork**: the source of truth is the server-side KV store pointing at the real runner userId.
  Removing the check in a fork does not help — the product runs the published version, and the attacker
  is still free under their own account.
- **Performance (grade A < 30 s)**: concurrent paging across authors, one cached bundle fetch for query IDs,
  tight normalization (no redundant hydration calls for timeline tweets).
- **Resilience**: backoff + jitter, bounded retries, no hard crash on 429/403, rotatable residential proxy,
  resume after migration.

## Commands

- `npm run lint` — `tsc --noEmit` (strict typecheck)
- `npm run build` — `tsc -p tsconfig.build.json`
- `npm test` — vitest
- `npm run dev` — run locally (tsx src/main.ts)
- `npx tsx scripts/smoke-client.ts` — live client smoke test
- `npx tsx scripts/smoke-search.ts` — live search-capability probe (re-verify on residential IPs)
- `npx tsx scripts/benchmark.ts` — local time-to-100 benchmark
- Local run without an Apify token:

  ```bash
  npm run build
  CRAWLEE_STORAGE_DIR="$(pwd)/test-data" node dist/main.js
  ```

  Input goes in `test-data/key_value_stores/default/INPUT.json`; output lands in `test-data/datasets/default/`.

- Deploy: `npx apify-cli push`

## Testing

Vitest; run with `npm test`. Suites cover input validation, the exact output contract (with fixtures),
AND filter semantics, the free-tier cap proof (free user with `maxResults: 1000` still receives 10),
and the search surface (supported probe collects, walled probe fails closed, rate-limited rotation).

## Status

- Phase 0 scaffolding — done
- Phase 1 X client (guest token, runtime query IDs, 3 surfaces) — done, verified live
- Phase 2 normalizer + filters — done
- Phase 3 free-tier gate — done in code (live KV verification pending deploy)
- Phase 4 resilience/scale (retry, proxy, paginator, resumer) — done; local time-to-100 22.1 s
- Phase 5 tests (37) — done
- Phase 6 search bonus — done in code + tests + live probe (Aug 2026: walled 404 on datacenter; auto-detects per run, fails closed)
- Phase 7 README + deploy + benchmark — README done; deploy pending

## Notes

- Never hard-code credentials; guest tokens only, for the required paths only.
- Keep `test-data/`, `dist/`, `node_modules/` and `.apify/` out of git.
- The public web bearer in `src/config.ts` is a well-known constant documented publicly by X; it is not a secret.