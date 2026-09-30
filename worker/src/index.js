// Signage API worker: setup-code exchange (/code), NJ Transit proxy (/njt/*)
// and market indices (/markets). Everything responds with permissive CORS —
// nothing served here is sensitive, and the boards fetch from a static origin.

import { mapYahooChart, quoteFreshS, quoteTrading, QUOTE_ACTIVE_S } from './markets.js';
import { sharedMapGet, freshForEarliest, earliestFreshUntil, FRESH_UNTIL_MS } from './sharedmap.js';
import { getNjtSchedule, fetchNjtAlerts, nyDate } from './njt.js';
import { fetchMtaAlerts } from './alerts.js';
import { fetchBusStops, parseLegs } from './bus.js';
import { fetchNewsFeed, newsFeedUrl } from './news.js';
import { fetchTeamSummary, teamFreshS, LEAGUE_PATHS as SPORTS_LEAGUES } from './sports.js';
import { fetchPathRealtime } from './path.js';
import { fetchFerryDepartures } from './ferry.js';
import { fetchSubstackPosts } from './posts.js';
import { fetchIcloudAlbum } from './icloud.js';
import { fetchGdriveAlbum } from './gdrive.js';
import { fetchServiceRows, serviceDigest, mendServiceStatuses, SERVICES, SVC_DEADLINE_MS } from './svcstatus.js';
import { fetchApod, APOD_TTL_S } from './apod.js';
import { fetchCitibike } from './citibike.js';
import { fetchTfl } from './tfl.js';
import { parseBeacon, beaconDataPoint, deviceModel, originHost, MAX_BODY as BEACON_MAX_BYTES } from './fleet.js';
import { fetchChart, CHART_TOPICS } from './chart.js';
import { fetchF1, mendF1 } from './f1.js';
import { fetchGolf, fetchTennis } from './scores.js';
import { fetchAmtrak } from './amtrak.js';
import { runHealthChecks, notify, alertPlan, nextFailingState, heartbeat } from './health.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Anything a board must not hold on to: the stale fallback and every error.
const NO_STORE = { 'Cache-Control': 'no-store' };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });

// Crockford-style alphabet: no I, L, O, U — unambiguous on a keypad.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
const CODE_TTL_S = 3600;
const MAX_CFG_CHARS = 4096;
// Transport ceiling for the /code body. MAX_CFG_CHARS bounds the cfg FIELD, not
// the request, so it sits comfortably above a MAX_CFG_CHARS cfg even fully
// \u-escaped (~6 bytes/char = ~24 KB) plus envelope. Anything larger is rejected
// before we buffer or parse it, so a huge unrelated field can't sneak past the
// field check by riding a body that was already fully read.
const MAX_CODE_BODY_BYTES = 32 * 1024;

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % 32];
  return code;
}

// Read at most `limit` bytes of the request body, then decode to text. Rejects
// an oversized Content-Length up front and, because that header can lie or be
// absent, also counts the bytes actually streamed and cancels the moment they
// pass the limit — so nothing larger than `limit` is ever buffered or parsed.
// Returns null when the body is too large or unreadable; the caller maps that to
// its own 4xx.
async function readBounded(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  const body = request.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null; // aborted upload or stream error — the sender's problem, not a 1101
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buf);
}

async function postCode(request, env, origin) {
  // Best-effort per-IP throttle (Cache API, not KV) to blunt a code-generation
  // flood against the 1000/day KV write cap. NOTE: caches.default is colo-local
  // and eventually-consistent, so this is a speed bump, not a hard limit — the
  // reliable protection is the try/catch around the KV put below, which returns
  // a clean 503 instead of a raw 500 when the cap is actually hit. A hard limit
  // would need the Rate Limiting binding or a Durable Object counter.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'anon';
  const throttleKey = new Request(`${origin}/__throttle/code/${encodeURIComponent(ip)}`);
  const cache = caches.default;
  if (await cache.match(throttleKey)) return json({ error: 'rate_limited' }, 429);
  // Install the speed bump BEFORE reading or parsing the body. It used to be set
  // only after a request validated, so a flood of malformed or oversized bodies
  // slipped past the throttle entirely and could hammer this route unbounded.
  await cache.put(throttleKey, new Response('1', { headers: { 'Cache-Control': 'max-age=10' } }));

  // Bound the transport read before buffering/parsing: the cfg-length check below
  // only guards the FIELD, so an oversized body (a huge unrelated field, or one
  // with no honest Content-Length) would otherwise be fully allocated and parsed
  // before we could reject it.
  const raw = await readBounded(request, MAX_CODE_BODY_BYTES);
  if (raw === null) return json({ error: 'cfg_too_large' }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof body?.cfg !== 'string' || body.cfg.length === 0) {
    return json({ error: 'missing_cfg' }, 400);
  }
  if (body.cfg.length > MAX_CFG_CHARS) return json({ error: 'cfg_too_large' }, 413);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomCode();
    try {
      if (await env.CODES.get(`code:${code}`)) continue; // collision, retry
      await env.CODES.put(`code:${code}`, body.cfg, { expirationTtl: CODE_TTL_S });
    } catch {
      // KV read/write cap hit or namespace unavailable — clear error, not a raw
      // 500 (the collision probe is a read and can trip the quota too).
      return json({ error: 'code_service_unavailable' }, 503);
    }
    return json({ code, expiresInSeconds: CODE_TTL_S });
  }
  return json({ error: 'code_generation_failed' }, 500);
}

async function getCode(env, code) {
  const key = `code:${code.toUpperCase()}`;
  let cfg;
  try {
    cfg = await env.CODES.get(key);
  } catch {
    // KV read cap hit or namespace unavailable — clean 503, not a raw 500
    // (an unthrottled redemption loop can otherwise drain the read quota).
    return json({ error: 'code_service_unavailable' }, 503);
  }
  if (cfg === null) return json({ error: 'not_found' }, 404);
  // Best-effort single use: KV deletes are eventually consistent (~60 s
  // globally), so a code may be redeemable more than once briefly. Codes
  // carry non-sensitive widget prefs and expire after an hour regardless.
  try { await env.CODES.delete(key); } catch { /* best-effort single-use */ }
  return json({ cfg });
}

// Best-effort per-IP speed bump (Cache API, colo-local — a bound, not a hard
// limit, same caveat as postCode). Records the hit and returns false the first
// time in the window; returns true (reject) for repeats within windowS.
async function ipThrottled(origin, bucket, ip, windowS) {
  const cache = caches.default;
  const key = new Request(`${origin}/__throttle/${bucket}/${encodeURIComponent(ip)}`);
  if (await cache.match(key)) return true;
  try { await cache.put(key, new Response('1', { headers: { 'Cache-Control': `max-age=${windowS}` } })); } catch { /* fail open */ }
  return false;
}

// Fresh-or-stale response cache shared by the upstream-proxy routes. Uses the
// Cache API, NOT KV: KV's free tier caps writes at 1000/day, and the boards
// polling these short-TTL routes exhausted it — which then broke the setup-code
// writes that share the CODES namespace. The Cache API has no such write limit.
// Serves the fresh copy while it is younger than ttlS; otherwise refetches,
// falling back to a longer-lived stale copy (flagged stale) when upstream fails.
// Keys live under the worker's own origin so put() stays same-zone; a second
// day-long entry survives past ttlS to serve as that stale backup.
//
// ttlS is normally a number. A route whose payload can be born part-aged (the
// markets watchlist, assembled from quotes a shared map may have held for most
// of their life) passes a function instead: (digest) => seconds, called once on
// the fetched digest, so the entry's lifetime can be what is LEFT of its oldest
// part's rather than a full TTL restarted at assembly. So does a route whose
// right lifetime depends on what the payload says (a team row: live or idle).
const STALE_TTL_S = 24 * 3600;

// The floor under a function ttlS: a digest whose parts are all but expired
// still caches for a second, never for 0 or less (an unusable max-age). It is
// also the hit path's answer when a function route's entry lacks its stamp.
const MIN_FRESH_S = 1;

// Whole seconds, rounded like the hit path's remainder, never under the floor;
// a non-number (a digest missing what the function reads) gets the floor too.
const freshSeconds = (s) => (Number.isFinite(s) ? Math.max(MIN_FRESH_S, Math.round(s)) : MIN_FRESH_S);

// Stamped on every cache entry so a hit can advertise its REMAINING freshness
// (see below) instead of restarting the clock on the board.
const FRESH_UNTIL = 'X-Fresh-Until';

// Every digest this worker serves carries the same envelope: `updatedAt` (epoch
// seconds) for when the data was obtained, `stale` for whether it is last-good
// rather than current. Plenty reads it: the health monitor pages on a feed that
// is stale and no longer recovering, the board dims that card and prints its "as
// of" clock, mendServiceStatuses weighs a backup row's age before reusing it.
// Remembering to stamp used to be each mapper's job, and forgetting failed
// silently in the worst direction: with no updatedAt the monitor skipped its age
// test entirely and called the feed ok, so the one feed that had lost the plot
// was also the one exempt from being caught. The stamp belongs here instead, at
// the single place that knows a fetch just happened. A fetcher whose updatedAt
// MEANS something (the ferry feed's own header clock, the NJT timetable's fetch
// time) keeps it: the spread order below fills in only what was left unsaid.
const stamped = (digest) =>
  (digest && typeof digest === 'object' && !Array.isArray(digest)
    ? { updatedAt: Math.floor(Date.now() / 1000), stale: false, ...digest }
    : digest);

async function cached(origin, key, ttlS, fetcher, { mend, failBackoffS = 0 } = {}) {
  const cache = caches.default;
  const freshKey = new Request(`${origin}/__cache/fresh/${encodeURIComponent(key)}`);
  const staleKey = new Request(`${origin}/__cache/stale/${encodeURIComponent(key)}`);
  // Where the failure backoff remembers that the fetcher just threw (see below).
  const failKey = new Request(`${origin}/__cache/fail/${encodeURIComponent(key)}`);
  const hit = await cache.match(freshKey);
  if (hit) {
    // Stream the stored bytes straight through — the old parse-then-restringify
    // round-trip produced the identical body at the cost of a JSON parse on
    // every board request. Headers are rebuilt so CORS rides along.
    //
    // max-age is what is LEFT of this entry's colo lifetime, not a fresh ttlS:
    // a board that caches for a full TTL on top of a nearly-expired colo copy
    // would show data ~2x the intended age, which on a departure board reads as
    // wrong minutes rather than as stale.
    // Every entry written below carries the stamp; the fallback is for one that
    // somehow does not, and a function ttlS has no digest here to be asked with.
    const until = Number(hit.headers.get(FRESH_UNTIL));
    const fallbackS = typeof ttlS === 'function' ? MIN_FRESH_S : ttlS;
    const remaining = until > 0 ? Math.max(0, Math.round((until - Date.now()) / 1000)) : fallbackS;
    return new Response(hit.body, {
      headers: {
        'Content-Type': 'application/json',
        ...CORS,
        'Cache-Control': `public, max-age=${remaining}`,
      },
    });
  }
  // The answer when there is no fresh payload to give: last-good if a backup
  // survives, the error otherwise. Both are no-store, so the next poll reaches
  // the worker and gets the real thing back the moment upstream recovers.
  const lastGoodOrError = async (detail) => {
    const stale = await cache.match(staleKey);
    if (stale) return json({ ...(await stale.json()), stale: true }, 200, NO_STORE);
    return json({ error: 'upstream_failed', detail }, 502, NO_STORE);
  };
  // Failure backoff, off unless a route asks for it. A fetcher that fails SLOWLY
  // (NJ Transit aborts at 10s) otherwise pays that stall on every board poll for
  // as long as the outage lasts: a failure leaves nothing in the fresh entry, so
  // the next request queues behind the same timing-out upstream, and the board's
  // own 15s fetch timeout starts expiring first, so nothing refreshes at all.
  // Remembering the failure for a few seconds costs the reader nothing (the
  // answer inside the window is the one they would have got anyway, last-good or
  // the error) and hands the upstream one attempt per window instead of one per
  // poll. Deliberately NOT logged again here: the failure that opened the window
  // already logged itself below.
  if (failBackoffS) {
    const failed = await cache.match(failKey);
    if (failed) return lastGoodOrError(await failed.text());
  }
  try {
    let fresh = stamped(await fetcher());
    // A route may hand in a mend(): when the fetch came back partial and a
    // complete 24h backup exists, the backup fills the holes. The mended
    // payload keeps partial: true, so it still caches briefly and still never
    // overwrites the backup it borrowed from.
    if (fresh?.partial && mend) {
      const backup = await cache.match(staleKey);
      if (backup) fresh = mend(fresh, await backup.json());
    }
    const body = JSON.stringify(fresh);
    const entry = (ttl) =>
      new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${ttl}`,
          [FRESH_UNTIL]: String(Date.now() + ttl * 1000),
        },
      });
    // A partial answer must also not LINGER: serve it fresh, but cache it only
    // briefly so the next poll soon retries the failed upstreams instead of
    // reading a mostly-empty digest for the route's whole TTL. Live lesson
    // 2026-08-02: a seconds-long Jolpica flake became an HOUR of a drivers-only
    // F1 card on every board behind that colo, because the partial digest was
    // cached at the route's full 3600s.
    //
    // A function ttlS is resolved here, once, on the digest actually being
    // served (after any mend), and floored at MIN_FRESH_S.
    const ttl = typeof ttlS === 'function' ? freshSeconds(ttlS(fresh)) : ttlS;
    const freshTtl = fresh?.partial ? Math.min(ttl, 120) : ttl;
    try {
      // A `partial` payload (some upstreams failed) is fine to serve fresh, but
      // must NOT overwrite the complete 24h stale backup.
      await Promise.all([
        cache.put(freshKey, entry(freshTtl)),
        ...(fresh?.partial ? [] : [cache.put(staleKey, entry(STALE_TTL_S))]),
      ]);
    } catch {
      // Caching is best-effort — a put failure must not drop the fresh payload
      // we already fetched.
    }
    return json(fresh, 200, { 'Cache-Control': `public, max-age=${freshTtl}` });
  } catch (err) {
    // Observability: log which upstream failed and why (visible in `wrangler
    // tail` / Workers logs), so a silent stale-serve (e.g. NJT returning 500s)
    // is diagnosable without deploying a one-off debug probe.
    console.warn(`[cached] ${key} upstream failed, serving stale if available: ${String(err?.message ?? err)}`);
    if (failBackoffS) {
      try {
        await cache.put(failKey, new Response(String(err), { headers: { 'Cache-Control': `max-age=${failBackoffS}` } }));
      } catch {
        // Best effort, like every other put here: a failed write just means the
        // next request tries the upstream again.
      }
    }
    return lastGoodOrError(String(err));
  }
}

// /njt/departures rides cached() like every other feed. The TTL is the advisory
// cadence: the alerts half is the dynamic one (the timetable half keeps its own,
// longer refresh clock inside getNjtSchedule). 180s is ~1.5x the card's 2-minute
// poll; at 120s the entry expired just before every poll, so a board alone on
// the route missed about half the time (see the services route for the rule).
// 60s of failure backoff, short enough that recovery costs at most one board
// poll and long enough that a dead NJT is not re-dialed by every board on every
// refresh.
const NJT_TTL_S = 180;
const NJT_FAIL_BACKOFF_S = 60;

// Per system, because the cards poll at different rates: Subway Status every
// 2 minutes (180s ≈ 1.5x), while LIRR and Metro-North fetch their banner on
// every 60s departures refresh, where 120s is already twice the poll and a
// shorter TTL would only refetch more often.
const ALERTS_TTL_S = { subway: 180, lirr: 120, mnr: 120 };

const YAHOO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const INDEX_NAMES = { '^DJI': 'Dow Jones', '^IXIC': 'Nasdaq', '^GSPC': 'S&P 500' };
const DEFAULT_SYMBOLS = Object.keys(INDEX_NAMES);

// /markets freshness is per QUOTE, counted from its Yahoo fetch, and set by
// whether its market is trading (quoteFreshS in markets.js): 240s while it
// trades, fresher than the card's 5-minute poll on purpose, and up to 30 min
// while it is closed and nothing on the card can move. The shared quote map
// below reuses a quote for its life, and a watchlist entry built from quotes
// lives only until the first of them expires (marketsFreshS). Without that
// second half, a list assembled at t=239 around a quote fetched at t=0 would
// restart the clock and serve the t=0 quote as fresh until t=479, and a list
// mixing a closed market with an open one would hold the open one's quote for
// the closed one's half hour.
//
// cached()'s ttlS for /markets: what remains until that first expiry, read from
// the FRESH_UNTIL_MS stamp fetchMarkets leaves on the digest (see sharedmap.js).
// cached() rounds it and floors it at MIN_FRESH_S.
const marketsFreshS = freshForEarliest(QUOTE_ACTIVE_S);

// Fleet-wide per-symbol layer under the per-watchlist cached() entry (see
// sharedmap.js). The route caches per whole sorted watchlist, so before this a
// symbol common to many watchlists was refetched from Yahoo once per distinct
// list; now each symbol is fetched at most once per quote life per colo, and so
// is its zero-change daily-bars fallback. 200 entries at ~1.5 KB a quote
// (the sparklines) keeps the parse and re-serialize well inside the CPU budget.
const MARKETS_MAP = 'mkt:quotes';
const MARKETS_MAP_MAX = 200;

// One symbol, one or two Yahoo subrequests. Throws on a failed chart fetch or a
// malformed payload; the daily-bars fallback never throws.
async function fetchQuote(symbol) {
  // 2d, not 1d: once a foreign market closes, Yahoo rolls the session into
  // chartPreviousClose (price === prev → the card showed 0.00 daily change
  // for LSE tickers all evening). With two days of bars, mapYahooChart
  // takes the daily baseline from the prior session's last close itself.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=15m`;
  const res = await fetch(url, { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const out = mapYahooChart(await res.json(), INDEX_NAMES[symbol]);
  // Yahoo doesn't reliably honor range=2d from Cloudflare egress (it can
  // return a single session with the close already rolled — change 0.00),
  // even though the same request from a browser gets two days. When the
  // change computes to zero, pull the true prior close from a tiny
  // daily-bars request; a genuinely flat day just recomputes to zero.
  if (out.change === 0) {
    try {
      const r2 = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
        { headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(10000) },
      );
      if (r2.ok) {
        const daily = ((await r2.json())?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
          .filter(Number.isFinite);
        const prior = daily.length >= 2 ? daily[daily.length - 2] : null;
        if (Number.isFinite(prior) && prior !== 0) {
          out.change = out.price - prior;
          out.changePct = ((out.price - prior) / prior) * 100;
        }
      }
    } catch { /* keep the zero-change mapping */ }
  }
  return out;
}

// Subrequest budget for one /markets miss, worst case (Free plan: 50, fetch()
// and Cache API calls counted together):
//   cached(): fresh match                                   1
//   quote map: match                                        1
//   20 symbols (the route cap) x chart + daily-bars        40
//   quote map: put                                          1
//   cached(): fresh put + stale put                         2
//                                                         ----
//                                                          45
// A total wipeout instead costs 1 + 1 + 20 + the stale match = 23. Raising the
// symbol cap past 20 breaks this budget: re-count before touching it.
async function fetchMarkets(origin, symbols) {
  // One unresolvable symbol shouldn't 502 the whole batch (and, without a
  // negative cache, re-hit Yahoo for the good symbols on every retry). Drop
  // the failures; only a total wipeout throws (so cached() serves stale/502).
  const quotes = await sharedMapGet(origin, MARKETS_MAP, symbols, async (missing) => {
    const settled = await Promise.allSettled(missing.map(fetchQuote));
    return new Map(missing.flatMap((symbol, i) => (settled[i].status === 'fulfilled' ? [[symbol, settled[i].value]] : [])));
  }, { freshS: quoteFreshS, maxEntries: MARKETS_MAP_MAX });
  const held = symbols.filter((s) => quotes.has(s)).map((s) => quotes.get(s));
  if (!held.length) throw new Error('yahoo: all symbols failed');
  // Each quote says whether its market is trading NOW (quoteTrading, the rule
  // its freshness was judged by, asked at assembly) and when it was fetched
  // (epoch seconds), so the card can date its clock from the open quotes alone
  // and mark a closed one. A reused quote carries its own map fetch time.
  const nowS = Date.now() / 1000;
  const indices = held.map((q) => ({
    ...q.value,
    open: quoteTrading(q.value, nowS),
    fetchedAt: Math.floor(q.fetchedAt / 1000),
  }));
  // Mark an incomplete batch so cached() won't promote it over a complete 24h
  // stale backup (a later total outage should serve the full list, not this).
  const partial = indices.length < symbols.length;
  // updatedAt is the OLDEST quote's fetch time, not this assembly's: a
  // watchlist built partly from the shared map can carry a quote fetched a
  // whole quote life ago. The card now dates its clock from the open quotes'
  // own fetchedAt, and falls back to this stamp for a payload without them.
  // How long cached() keeps the list fresh is a separate instant, its first
  // quote's expiry.
  const updatedAt = Math.floor(Math.min(...held.map((q) => q.fetchedAt)) / 1000);
  return { updatedAt, indices, ...(partial && { partial: true }), [FRESH_UNTIL_MS]: earliestFreshUntil(held) };
}

// /services/status TTL: 480s ≈ 1.5x the card's 5-minute poll (a TTL at or under
// the poll expires just before every request, so a lone board never hit the
// cache). It is one ROW's whole fresh life, counted from its upstream fetch:
// the shared row map reuses a provider's row for that long, and a per-set entry
// built from it stays fresh only until its first row expires (svcFreshS), which
// with one life for every row is the oldest row.
const SVC_TTL_S = 480;
const svcFreshS = freshForEarliest(SVC_TTL_S);

// Fleet-wide per-provider layer under the per-set cached() entry (see
// sharedmap.js). The route caches per sorted id set, so a board following
// {github, aws} and one following {github, slack} each downloaded githubstatus,
// and every distinct set re-parsed the heavy feeds (Google's incidents.json is
// ~410 KB, AWS's UTF-16 data.json ~231 KB). Now each provider is fetched at most
// once per SVC_TTL_S per colo, whatever sets it appears in.
// The map holds the DIGESTED rows, never upstream bodies: measured from the
// recorded fixtures a row is 60 B to 1.3 KB, and a pathological one (three
// incidents at every clamp, or Microsoft's six incidents plus eight advisories)
// about 10 KB. One entry per provider, so the cap is the registry's size and
// never evicts a live provider. Even eleven pathological rows (~110 KB) are a
// quarter of the one Google body a miss used to parse; a real entry is a few KB.
const SVC_MAP = 'svc:rows';
const SVC_MAP_MAX = Object.keys(SERVICES).length;

// Subrequest budget for one /services/status miss, worst case (Free plan: 50,
// fetch() and Cache API calls counted together). Every one of the 11 providers
// (the route cap, and the whole registry) missing the row map, each succeeding
// only on its last attempt. Only a 5xx, a network error or a 200 with the wrong
// body spends a retry; a 4xx ends a source after one request (see fetchJson),
// so a feed that 403s or 429s costs 1 here, not 3:
//   cached(): fresh match                                         1
//   row map: match                                                1
//   10 single-feed providers x 3 attempts                        30
//   m365: consumer feed + mirror, x 3 attempts each               6
//   m365 tenant, only with the MS_* secrets set: token x 2
//     + health x 2 (a warm isolate reuses its token: 2)           4
//   row map: put                                                  1
//   cached(): fresh put + stale put (a complete digest), or
//     mend's stale match + fresh put (a partial one)              2
//                                                               ----
//                                                                45
// A total wipeout instead costs 1 + 1 + 40 + the stale match = 43 (nothing to
// put in the map). Adding a provider, an attempt or a source breaks this
// budget: re-count before touching any of them.
async function fetchServices(origin, ids, env) {
  // Started before the map read, so the fan-out's deadline covers it too.
  const deadline = Date.now() + SVC_DEADLINE_MS;
  // A provider that answered but could only say 'unknown' (a mapper that did
  // not recognize the payload) is shown as it said so, exactly as before the
  // map existed, but is not stored: the map holds good rows only, so the next
  // request retries it rather than reusing a non-answer for a whole TTL.
  const unknown = new Map();
  const held = await sharedMapGet(origin, SVC_MAP, ids, async (missing) => {
    const rows = await fetchServiceRows(missing, env, deadline);
    for (const [id, row] of rows) {
      if (row.state === 'unknown') {
        unknown.set(id, row);
        rows.delete(id);
      }
    }
    return rows;
  }, { freshS: SVC_TTL_S, maxEntries: SVC_MAP_MAX });
  // A provider that failed outright is absent from both and renders as the
  // unknown row, which marks the digest partial: the per-set entry then caches
  // briefly, never replaces its 24h backup, and gets mended from it.
  // serviceDigest throws when every row is unknown, so past it at least one row
  // was held, and the oldest of them is the digest's "as of".
  const digest = serviceDigest(ids, (id) => held.get(id)?.value ?? unknown.get(id));
  const rows = [...held.values()];
  const oldestMs = Math.min(...rows.map((e) => e.fetchedAt));
  return { updatedAt: Math.floor(oldestMs / 1000), ...digest, [FRESH_UNTIL_MS]: earliestFreshUntil(rows) };
}

// In-process dispatcher for the health monitor. A Worker fetching its OWN
// custom domain over the network loops (Cloudflare returns 522), so the health
// checks reach the worker's own routes by calling this handler directly instead
// of via fetch(). The hostname is arbitrary — only the path drives routing.
// `init` is optional and rides straight into the Request, so a check can POST:
// the setup-code canary mints through the real route (see codeCanary).
const selfFetch = (env) => (routePath, init) =>
  handlers.fetch(new Request('https://api.roomboard.app' + routePath, init), env);

// Last-alerted failing-check set, so the cron only alerts on a CHANGE (see
// alertPlan). Lives in the CODES KV, which is GLOBAL — the Cache API this
// replaces is colo-local, and that lost the all-clear twice (the weather 503 of
// 2026-08-19, the code 429 of 2026-08-21): the recovering run landed in a
// different colo than the red one, read empty state, saw all green, concluded
// nothing had changed, and the recovery notice was swallowed forever. A red that
// never clears is the worst failure a monitor can have, since it teaches an
// operator to distrust the channel.
//
// KV writes are the thing to be careful with here: the namespace is capped at
// 1000/day and draining it broke setup-code minting outright once already (see
// postCode). So this writes ONLY when the set actually changes. The cron runs 72
// times a day; a quiet day spends ZERO writes, and even a bad day is a handful
// (one per transition), against the ~144/day the code canary already costs. The
// 72 reads/run land on the far higher read cap and are not worth counting.
//
// The key carries no `code:` prefix, so it cannot collide with a minted code by
// construction (those are `code:` + six CODE_ALPHABET characters), and nothing
// in this worker ever lists the namespace by prefix. 7-day TTL so an abandoned
// deployment's state evaporates on its own; a read after expiry just re-pages an
// ongoing outage once, which is the harmless direction.
const HEALTH_STATE_KEY = 'health:laststate';
const HEALTH_STATE_TTL_S = 7 * 24 * 3600;
async function readHealthFailing(env) {
  try {
    const raw = await env?.CODES?.get(HEALTH_STATE_KEY);
    if (raw) return JSON.parse(raw).failing ?? [];
  } catch { /* first run / KV unavailable — treat as no prior failures */ }
  return [];
}
async function writeHealthFailing(env, failing, prevFailing = []) {
  // Write-on-change only, per the cap note above. Order-insensitive, matching
  // alertPlan's own comparison, so a reshuffled CHECKS list can't spend a write.
  const same = failing.length === prevFailing.length && failing.every((n) => prevFailing.includes(n));
  if (same) return;
  try {
    await env?.CODES?.put(HEALTH_STATE_KEY, JSON.stringify({ failing }), { expirationTtl: HEALTH_STATE_TTL_S });
  } catch { /* best effort — a lost write costs one duplicate page next run */ }
}

// /health must stay public (external uptime monitors hit it), which leaves the
// manual ?test=alert channel-check open to whoever finds the URL. Rate-limit it
// so a leaked URL can't flood the ops channel and drown a real alert: one test
// ping per colo per 10 min. Colo-local + best-effort (fails open — a stray test
// message is loud but harmless); costs no operator config, unlike a shared
// secret the runbook would have to carry.
const TEST_ALERT_GATE = new Request('https://api.roomboard.app/__health/testgate');
async function testAlertAllowed() {
  try {
    if (await caches.default.match(TEST_ALERT_GATE)) return false;
    await caches.default.put(TEST_ALERT_GATE, new Response('1', { headers: { 'Cache-Control': 'max-age=600' } }));
  } catch { /* cache unavailable — fail open */ }
  return true;
}

const handlers = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (path === '/code' && request.method === 'POST') return postCode(request, env, url.origin);

    if (path === '/fleet' && request.method === 'POST') {
      // Anonymous usage heartbeat → Analytics Engine (see fleet.js). No KV,
      // no caching. A missing ANALYTICS binding (self-host without metrics)
      // accepts and drops so boards never see an error. readBounded caps the
      // transport read at parseBeacon's own ceiling, so an oversized upload is
      // rejected without buffering it (and an aborted upload just reads null —
      // the sender's problem, not a 1101).
      const raw = await readBounded(request, BEACON_MAX_BYTES);
      const parsed = raw === null ? null : parseBeacon(raw);
      if (!parsed) return json({ error: 'bad_beacon' }, 400);
      // Country is edge-derived (request.cf.country, CF-IPCountry header at the
      // edge); model is parsed from the RoomOS WebEngine User-Agent; origin is
      // the hostname of the Origin header — the board sends none of them.
      // fleet.js validates/defaults all three.
      const geo = request.cf?.country ?? request.headers.get('CF-IPCountry');
      const model = deviceModel(request.headers.get('User-Agent'));
      const origin = originHost(request.headers.get('Origin'));
      try {
        env.ANALYTICS?.writeDataPoint(beaconDataPoint({ ...parsed, country: geo, model, origin }));
      } catch {
        // Metrics are best-effort — never fail the board over a write error.
      }
      return new Response(null, { status: 204, headers: CORS });
    }

    const codeMatch = /^\/code\/([A-Za-z0-9]{6})$/.exec(path);
    if (codeMatch && request.method === 'GET') {
      // Speed-bump redemption per IP (colo-local, mirrors postCode) so a
      // code-guessing flood can't drain the CODES read quota that the NJT
      // token/schedule share; getCode's try/catch is the reliable backstop. A 3s
      // window is invisible to a human re-typing a mistyped code.
      const ip = request.headers.get('CF-Connecting-IP') ?? 'anon';
      if (await ipThrottled(url.origin, 'getcode', ip, 3)) return json({ error: 'rate_limited' }, 429);
      return getCode(env, codeMatch[1]);
    }

    if (path === '/njt/departures' && request.method === 'GET') {
      if (!env.NJT_USER || !env.NJT_PASS) return json({ error: 'njt_not_configured' }, 503);
      // Pinned to New York Penn (the widget filters by line client-side). Two
      // upstreams behind one digest: the day's static timetable, which lives in
      // KV because the Cache API is colo-local and evicts (see getNjtSchedule),
      // and the live advisory banner. The catch below is the banner's rule: a
      // failed alerts fetch EMPTIES the alerts rather than keeping the last ones,
      // because a delay that has since been resolved must not linger on a wall.
      //
      // That rule survives cached()'s 24h backup because the key carries the New
      // York service day. The backup is only ever reached when the fetcher
      // throws; the fetcher only throws when KV holds no timetable at all; and a
      // backup under today's key implies a successful fetch today, which implies
      // a timetable in KV. So a banner cannot outlive the day it was published.
      return cached(url.origin, `njt:${nyDate()}`, NJT_TTL_S, async () => {
        // Sequential, never Promise.all: the first call is the one that mints the
        // RailData session token (capped at 10 a DAY), and two concurrent
        // cold-token calls can both read an empty cache before either publishes
        // its in-flight mint, spending two of them for one request.
        const schedule = await getNjtSchedule(env);
        const alerts = await fetchNjtAlerts(env).catch(() => []);
        return { ...schedule, alerts };
      }, { failBackoffS: NJT_FAIL_BACKOFF_S });
    }

    if (path === '/markets' && request.method === 'GET') {
      const requested = (url.searchParams.get('symbols') ?? '')
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter((t) => /^[\^A-Z0-9.\-]{1,10}$/.test(t))
        // Matches the config cap (site/js/config.js, TICKER_MAX in
        // settings/pickers.js): a board may follow 20 tickers and the expand
        // overlay shows all of them, so all 20 must be fetched. Each symbol is
        // up to two Yahoo subrequests; see fetchMarkets for the whole budget.
        .slice(0, 20);
      // Dedupe for the fetch, but keep request order for display; the cache
      // key is sorted so AAPL,MSFT and MSFT,AAPL coalesce to one entry.
      const symbols = [...new Set(requested.length ? requested : DEFAULT_SYMBOLS)];
      const cacheKey = [...symbols].sort().join(',');
      // The entry stays fresh until its first quote expires, never a full
      // quote life from assembly (see marketsFreshS).
      return cached(url.origin, `markets:${cacheKey}`, marketsFreshS, () => fetchMarkets(url.origin, symbols));
    }

    if (path === '/path/realtime' && request.method === 'GET') {
      // 90s ≈ 1.5x the card's 60s poll. Trains ride as projected epochs the card
      // counts down against its own clock (see path.js), so an older digest still
      // reads the right minutes; what ages is only the upstream's estimate.
      return cached(url.origin, 'path', 90, () => fetchPathRealtime());
    }

    if (path === '/ferry/departures' && request.method === 'GET') {
      // 90s ≈ 1.5x the card's 60s poll; stop times are absolute epochs the card
      // counts down locally, so an older digest still reads right.
      return cached(url.origin, 'ferry', 90, () => fetchFerryDepartures());
    }

    if (path === '/posts/substack' && request.method === 'GET') {
      const pub = url.searchParams.get('pub') ?? '';
      if (!/^[a-z0-9-]{2,64}$/.test(pub)) return json({ error: 'bad_pub' }, 400);
      return cached(url.origin, `sub:${pub}`, 600, () => fetchSubstackPosts(pub));
    }

    if (path === '/services/status' && request.method === 'GET') {
      const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').filter((id) => Object.hasOwn(SERVICES, id)))].slice(0, 11);
      if (!ids.length) return json({ error: 'bad_ids' }, 400);
      // Sorted ids in the key so permutations share one cache entry, whose
      // fresh lifetime is its oldest row's remaining one (see SVC_TTL_S), with
      // each provider fetched once per TTL fleet-wide underneath it.
      // mend: one provider's dead endpoint leaves an unknown row and marks the
      // digest partial; the backup fills that row back in rather than showing a
      // grey card (see mendServiceStatuses for the age bound on that).
      // env rides along for the optional MS_* tenant secrets (see the Graph
      // block in svcstatus.js); with none set the fetch is byte-identical to
      // the keyless one this route shipped with.
      return cached(url.origin, `svc:${[...ids].sort().join(',')}`, svcFreshS, () => fetchServices(url.origin, ids, env), { mend: mendServiceStatuses });
    }

    // Golf and Tennis: 450s ≈ 1.5x the cards' 5-minute poll.
    if (path === '/golf' && request.method === 'GET') {
      return cached(url.origin, 'golf', 450, () => fetchGolf());
    }

    if (path === '/tennis' && request.method === 'GET') {
      return cached(url.origin, 'tennis', 450, () => fetchTennis());
    }

    if (path === '/f1' && request.method === 'GET') {
      // One global digest (next race + last podium + standings) from Jolpica,
      // fanned out and merged in fetchF1. 1h TTL — F1 data changes weekly.
      return cached(url.origin, 'f1', 3600, () => fetchF1(), { mend: mendF1 });
    }

    if (path === '/amtrak/departures' && request.method === 'GET') {
      // NYP (Moynihan) Amtrak departure board from the keyless Amtraker feed,
      // filtered to NYP and cached fleet-wide 90s (≈ 1.5x the card's 60s poll;
      // departures are absolute epochs the card counts down locally). Filtering
      // by destination is client-side (each departure carries its downstream
      // stops).
      return cached(url.origin, 'amtrak', 90, () => fetchAmtrak());
    }

    if (path === '/chart' && request.method === 'GET') {
      // Statista Chart of the Day — scraped from the listing page (see chart.js),
      // 1h TTL; new charts post weekdays. `?topic=` re-points the scrape at a
      // per-topic page — validated against the curated CHART_TOPICS allowlist so
      // an unknown slug can't blank the card. No topic → the global cache key
      // (one fleet-wide entry); a valid topic → `chart:<topic>`.
      const topic = url.searchParams.get('topic') ?? '';
      if (topic && !CHART_TOPICS.some(([, slug]) => slug === topic)) {
        return json({ error: 'bad_topic' }, 400);
      }
      const chartKey = topic ? `chart:${topic}` : 'chart';
      return cached(url.origin, chartKey, 3600, () => fetchChart(topic));
    }

    if (path === '/apod' && request.method === 'GET') {
      // Single global daily image — one cache key, 1h TTL (APOD changes once a
      // day). Read from NASA's public RSS feed, so no key (see apod.js).
      return cached(url.origin, 'apod', APOD_TTL_S, () => fetchApod(env));
    }

    if (path === '/citibike/status' && request.method === 'GET') {
      // Bound each id (GBFS station ids are short word-chars/UUIDs) so an
      // attacker can't mint giant arbitrary cache keys; dedupe, cap at 6.
      const ids = [...new Set(
        (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => /^[\w-]{1,48}$/.test(s)),
      )].slice(0, 6);
      if (!ids.length) return json({ error: 'bad_ids' }, 400);
      // GBFS publishes on a 60s ttl; cache 90s (~1.5x the card's 60s poll) so a
      // single board actually hits the entry instead of expiring it every time.
      // Sorted ids so permutations share a key.
      return cached(url.origin, `citibike:${[...ids].sort().join(',')}`, 90, () => fetchCitibike(ids));
    }

    if (path === '/tfl/status' && request.method === 'GET') {
      // One fleet-wide digest of all 19 lines; the widget filters to the chosen
      // set. 180s ≈ 1.5x the TfL card's 2-minute poll.
      return cached(url.origin, 'tfl', 180, () => fetchTfl(env));
    }

    if (path === '/gdrive/album' && request.method === 'GET') {
      if (!env.GDRIVE_KEY) return json({ error: 'gdrive_not_configured' }, 503);
      const folder = url.searchParams.get('folder') ?? '';
      if (!/^[-\w]{10,80}$/.test(folder)) return json({ error: 'bad_folder' }, 400);
      // 1800 s: thumbnailLink URLs are short-lived (order of hours), so the
      // digest regenerates well before they expire — the /icloud/album pattern.
      return cached(url.origin, `gdrive:${folder}`, 1800, () => fetchGdriveAlbum(env, folder));
    }

    if (path === '/icloud/album' && request.method === 'GET') {
      const token = url.searchParams.get('token') ?? '';
      if (!/^[A-Za-z0-9]{8,25}$/.test(token)) return json({ error: 'bad_token' }, 400);
      return cached(url.origin, `icloud:${token}`, 1800, () => fetchIcloudAlbum(token));
    }

    const alertsMatch = /^\/alerts\/(subway|lirr|mnr)$/.exec(path);
    if (alertsMatch && request.method === 'GET') {
      const system = alertsMatch[1];
      return cached(url.origin, `alerts:${system}`, ALERTS_TTL_S[system], () => fetchMtaAlerts(system));
    }

    if (path === '/sports/team' && request.method === 'GET') {
      const lg = url.searchParams.get('lg');
      const id = (url.searchParams.get('id') ?? '').toLowerCase();
      // Object.hasOwn, not truthiness — 'constructor'/'toString' inherit from
      // the prototype and would otherwise pass the whitelist check.
      if (!Object.hasOwn(SPORTS_LEAGUES, lg ?? '') || !/^[a-z0-9]{1,8}$/.test(id)) {
        return json({ error: 'bad_team' }, 400);
      }
      // TTL by game state (teamFreshS): 60s while the game is live or about to
      // start, fresher than the card's 2-minute poll on purpose; up to 15 min
      // while nothing can change, so boards answer most polls from their own
      // cache. A failed fetch serves last-good no-store, as every route does.
      return cached(url.origin, `sports:${lg}:${id}`, teamFreshS, () => fetchTeamSummary(lg, id, url.origin));
    }

    const newsMatch = /^\/news\/([a-z0-9-]{1,24})$/.exec(path);
    if (newsMatch && request.method === 'GET') {
      if (!newsFeedUrl(newsMatch[1])) return json({ error: 'unknown_feed' }, 404);
      // 900s ≈ 1.5x the card's 10-minute poll (600s expired on every request).
      return cached(url.origin, `news:${newsMatch[1]}`, 900, () => fetchNewsFeed(newsMatch[1]));
    }

    if (path === '/bus/stops' && request.method === 'GET') {
      if (!env.MTA_BUS_KEY) return json({ error: 'bus_not_configured' }, 503);
      const legs = parseLegs(url.searchParams.get('legs') ?? '');
      if (!legs.length) return json({ stops: [] });
      // Key on the normalized parsed legs (sorted) so aliased/reordered raw
      // query strings share one entry instead of minting duplicates.
      const busKey = `bus:${legs.map((l) => `${l.stopId}:${l.lineRef}`).sort().join(',')}`;
      // 90s ≈ 1.5x the card's 60s poll. Bus rows are absolute arrival times the
      // card counts down locally, so a slightly older digest still reads right.
      return cached(url.origin, busKey, 90, () => fetchBusStops(env, legs));
    }

    // On-demand health probe (same checks the cron runs). Returns 200 when all
    // green, 503 when any check fails — so an external uptime pinger can watch
    // this one URL as a belt-and-suspenders to the self-hosted cron.
    // /health?test=alert forces a synthetic alert so an operator can confirm the
    // ALERT_WEBHOOK channel actually delivers — an unverified alert path is
    // worthless. No-ops (like any alert) when the secret is unset.
    if (path === '/health' && request.method === 'GET') {
      const report = await runHealthChecks(env, selfFetch(env));
      if (url.searchParams.get('test') === 'alert' && await testAlertAllowed()) {
        await notify(env, `🔴 idlescreen health: test (manual channel-wiring check, not a real outage), ${report.at}`);
      }
      return json(report, report.ok ? 200 : 503);
    }

    return json({ error: 'not_found' }, 404);
  },

  // Cron Trigger (see [triggers] in wrangler.toml): probe the key endpoints and
  // alert (ALERT_WEBHOOK) if any fail. waitUntil keeps the alert POST alive past
  // the handler return. A monitor living in the api worker still runs its checks
  // even when a bad deploy breaks the routes — the scheduled handler is separate
  // from fetch — so it catches route regressions, not just upstream outages.
  async scheduled(event, env, ctx) {
    // writeCycle is the cron's alone: it runs the setup-code canary all the way
    // through mint and redeem, which costs KV writes against a 1000/day cap.
    // The public /health route above must never ask for it (see codeCanary).
    const report = await runHealthChecks(env, selfFetch(env), fetch, { writeCycle: true });
    // Dead-man ping AFTER the checks complete: it certifies the whole run, so
    // a cron that stops firing OR a run that hangs/throws both go silent and
    // trip the external check (see heartbeat in health.js).
    ctx.waitUntil(heartbeat(env));
    // Alert only when the failing set changes (see alertPlan), so an ongoing
    // outage doesn't page every 20 min.
    const prevFailing = await readHealthFailing(env);
    const plan = alertPlan(report, prevFailing);
    if (plan.changed && plan.text) {
      // At-least-once: only advance the persisted set once the page is actually
      // delivered (nextFailingState holds prevFailing on a delivery failure so
      // the next run re-pages instead of silently swallowing the alert). Handing
      // prevFailing to the write is what lets it skip a put that would store
      // what is already there — an undelivered page lands here too.
      ctx.waitUntil(notify(env, plan.text).then((ok) => writeHealthFailing(env, nextFailingState(plan, prevFailing, ok), prevFailing)));
    } else {
      ctx.waitUntil(writeHealthFailing(env, nextFailingState(plan, prevFailing, true), prevFailing));
    }
  },
};

// Last-resort guard. An unexpected throw anywhere in the route table would
// otherwise surface to the board as an opaque CORS/network error (the raw 1101
// error page carries no Access-Control-Allow-Origin), which is the hardest
// failure to diagnose on a device with no console. Wrap the handler so every
// response is CORS-clean JSON, and log the cause to Workers Logs.
// NOTE: `handlers.fetch` stays the in-process entry for selfFetch (health
// probes), which want the raw throw — probe() already classifies failures.
// Last-resort guard around the whole route table. An unexpected throw would
// otherwise reach the board as an opaque CORS/network error — Cloudflare's raw
// 1101 error page carries no Access-Control-Allow-Origin — which is the hardest
// failure to diagnose on a device with no console. This turns any such throw
// into CORS-clean JSON 500 and logs the method + path to Workers Logs.
// NOTE: selfFetch (health probes) deliberately calls the UNGUARDED handlers.fetch
// so probe() still classifies a raw throw itself.
export function guardFetch(inner) {
  return async (request, env, ctx) => {
    try {
      return await inner(request, env, ctx);
    } catch (err) {
      let path = '?';
      try { path = new URL(request.url).pathname; } catch { /* unparseable — keep '?' */ }
      console.error('[worker] unhandled error', request?.method, path, err);
      return json({ error: 'internal_error' }, 500);
    }
  };
}

export default { ...handlers, fetch: guardFetch(handlers.fetch) };
