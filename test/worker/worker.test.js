import { fetchGolf, fetchTennis } from '../../worker/src/scores.js';
import { runHealthChecks } from '../../worker/src/health.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  digestNext, digestSchedule, digestScoreboard, fetchTeamSummary, mapTeamSummary, nextStartAt, teamFreshS,
  SPORTS_LIVE_S, SPORTS_IDLE_MAX_S, SPORTS_UNSURE_S,
} from '../../worker/src/sports.js';
import { ESPN_UA } from '../../worker/src/espn.js';
import { env } from 'cloudflare:test';
import worker, { guardFetch } from '../../worker/src/index.js';
import { resetNjtToken, nyDate, fetchNjtSchedule } from '../../worker/src/njt.js';
import { mapRidePath } from '../../worker/src/path.js';
import GtfsRt from 'gtfs-realtime-bindings';
import { mapFerryFeed } from '../../worker/src/ferry.js';
import { mapSubstackPosts } from '../../worker/src/posts.js';
import { mapIcloudAlbum } from '../../worker/src/icloud.js';
import { newsFeedUrl } from '../../worker/src/news.js';
import { parseLegs, siriUrl } from '../../worker/src/bus.js';
import { njtDateToEpoch } from '../../worker/src/njt.js';
import { mapMtaAlerts } from '../../worker/src/alerts.js';
import { resetGraphToken, fetchServiceRows, serviceDigest, SVC_DEADLINE_MS, SERVICES } from '../../worker/src/svcstatus.js';
import STATISTA from './fixtures/statista-cotd.html?raw';
import yahooFx from '../fixtures/yahoo-gspc.json';
import { mapYahooChart, quoteFreshS, nextOpenS, QUOTE_ACTIVE_S, QUOTE_IDLE_MAX_S, QUOTE_UNKNOWN_OPEN_S } from '../../worker/src/markets.js';
import WORKER_SOURCE from '../../worker/src/index.js?raw';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, init, extraEnv = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, init), { ...env, ...extraEnv }, ctx);

const NJT_ENV = { NJT_USER: 'user', NJT_PASS: 'pass' };

// The upstream-proxy cache lives in the Cache API now (not KV). Keys mirror
// cached() in worker/src/index.js: `${origin}/__cache/{fresh,stale,fail}/{key}`,
// with the test origin https://api.test.
const cacheKey = (kind, key) => new Request(`https://api.test/__cache/${kind}/${encodeURIComponent(key)}`);
const clearCache = (key) =>
  Promise.all(['fresh', 'stale', 'fail'].map((kind) => caches.default.delete(cacheKey(kind, key))));

// /markets keeps a fleet-wide per-symbol quote map underneath its per-watchlist
// entries (see sharedmap.js). Cleared after every case, so a quote one case
// fetched can never answer another case's symbol.
const quoteMapKey = new Request('https://api.test/__cache/map/mkt%3Aquotes');
// /services/status keeps the same kind of per-provider row map under its
// per-set entries, cleared after every case for the same reason.
const svcMapKey = new Request('https://api.test/__cache/map/svc%3Arows');

// /njt/departures keys its entry by the New York service day (see the route).
const njtKey = () => `njt:${nyDate()}`;

// Route-based fetch stub: routes = [{match: RegExp, status, body}], each entry
// consumed in order per matching URL; records calls for assertions.
function stubFetch(routes) {
  const calls = [];
  const stub = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    const route = routes.find((r) => r.match.test(url) && (r.times ?? 1) > 0);
    if (!route) throw new Error(`unmocked fetch: ${url}`);
    route.times = (route.times ?? 1) - 1;
    return new Response(
      route.raw ? route.body
        : typeof route.body === 'string' ? route.body : JSON.stringify(route.body),
      {
        status: route.status ?? 200,
        // `ctype` overrides for the feeds that answer 200 with the WRONG type
        // (Microsoft's hosts serve HTML error pages that way).
        // `headers` adds any others a case needs (a 429's Retry-After).
        headers: { 'Content-Type': route.ctype ?? (route.raw ? 'application/x-protobuf' : 'application/json'), ...route.headers },
      },
    );
  });
  vi.stubGlobal('fetch', stub);
  return calls;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await resetNjtToken(env); // clears the KV session token + isolate memo so it can't leak between cases
  await env.CODES.delete('njt:schedule'); // the durable day-timetable store
  await clearCache(njtKey()); // and the route's own cache entry (fresh + backup + backoff)
  await caches.default.delete(quoteMapKey);
  await caches.default.delete(svcMapKey);
  resetGraphToken(); // clears the isolate's Microsoft Graph token memo
});

describe('CORS and routing', () => {
  it('handles OPTIONS preflight', async () => {
    const res = await call('/code', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
  it('404s unknown routes with CORS', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

// A board fetching these routes gets a Cache-Control it can act on, so the
// gen1 web engine can skip a round trip it would only have wasted. The rules:
// fresh answers are cacheable for what is LEFT of the colo entry's TTL; the
// stale fallback and every error are no-store, so recovery is never one poll
// late. CORS must survive all of it.
describe('cached() response headers', () => {
  const rss = '<rss><channel><item><title>Hi</title></item></channel></rss>';

  it('sends the route TTL on a fresh answer and the REMAINDER on a hit', async () => {
    await clearCache('news:npr');
    stubFetch([{ match: /feeds\.npr\.org/, body: rss }]);
    const fresh = await call('/news/npr');
    expect(fresh.headers.get('cache-control')).toBe('public, max-age=900');
    expect(fresh.headers.get('access-control-allow-origin')).toBe('*');
    const body = await fresh.json();

    // Second call takes the cache path: the stub is exhausted, so reaching
    // upstream would throw. The body must be byte-identical (it is streamed
    // through now, not re-serialized) and the TTL must not restart.
    const hit = await call('/news/npr');
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual(body);
    expect(hit.headers.get('access-control-allow-origin')).toBe('*');
    expect(hit.headers.get('content-type')).toContain('application/json');
    const maxAge = Number(/max-age=(\d+)/.exec(hit.headers.get('cache-control'))[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(900);
    await clearCache('news:npr');
  });

  it('marks the stale fallback and the 502 no-store', async () => {
    await clearCache('news:npr');
    stubFetch([{ match: /feeds\.npr\.org/, body: rss }]);
    await call('/news/npr'); // populates the 24h stale backup
    await caches.default.delete(cacheKey('fresh', 'news:npr'));

    stubFetch([{ match: /feeds\.npr\.org/, body: 'down', status: 500, times: 2 }]);
    const stale = await call('/news/npr');
    expect((await stale.json()).stale).toBe(true);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expect(stale.headers.get('access-control-allow-origin')).toBe('*');

    await clearCache('news:npr'); // no backup left → hard failure
    const dead = await call('/news/npr');
    expect(dead.status).toBe(502);
    expect(dead.headers.get('cache-control')).toBe('no-store');
    expect(dead.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('caches a PARTIAL digest only briefly, so a flake cannot linger for the route TTL', async () => {
    // Live lesson 2026-08-02: three of Jolpica's four endpoints flaked for a
    // few seconds, and the resulting drivers-only F1 digest was cached at the
    // route's full 3600s — an hour of a drivers-only card on every board
    // behind that colo. A partial answer is served, but remembered for at most
    // 120s so the next poll retries the failed upstreams.
    await clearCache('f1');
    const standings = { MRData: { StandingsTable: { StandingsLists: [{ DriverStandings: [
      { position: '1', points: '219', wins: '6', Driver: { familyName: 'Antonelli', nationality: 'Italian' },
        Constructors: [{ constructorId: 'mercedes' }] },
    ] }] } } };
    stubFetch([
      { match: /next\.json/, body: 'down', status: 500 },
      { match: /last\/results/, body: 'down', status: 500 },
      { match: /driverStandings/, body: standings },
      { match: /constructorStandings/, body: 'down', status: 500 },
    ]);
    const partial = await call('/f1');
    expect(partial.status).toBe(200);
    const digest = await partial.json();
    expect(digest.partial).toBe(true);
    expect(digest.drivers.length).toBe(1); // what survived is served
    expect(partial.headers.get('cache-control')).toBe('public, max-age=120'); // not 3600
    await clearCache('f1');
  });

  it('mends a partial digest from the 24h backup, so one bounced call never guts the card', async () => {
    // Round two of the same incident: the flake was not a flake but Jolpica's
    // burst limit, and while the fetches are serialized now, resilience must
    // not depend on an upstream's manners. A partial digest borrows its missing
    // blocks from the complete 24h backup (F1 data is weekly; a day-old
    // next-race block is the truth), stays partial (short cache, never
    // overwrites the backup it borrowed from) and says it was mended.
    await clearCache('f1');
    const full = (name) => ({ MRData: {
      RaceTable: { Races: [{ raceName: name, date: '2026-08-23', round: '15',
        Circuit: { circuitName: 'Zandvoort', circuitId: 'zandvoort', Location: { country: 'Netherlands' } } }] },
      StandingsTable: { StandingsLists: [{ DriverStandings: [
        { position: '1', points: '219', wins: '6', Driver: { familyName: 'Antonelli', nationality: 'Italian' },
          Constructors: [{ constructorId: 'mercedes' }] },
      ], ConstructorStandings: [
        { position: '1', points: '333', Constructor: { constructorId: 'mercedes', name: 'Mercedes' } },
      ] }] },
    } });
    stubFetch([{ match: /jolpi/, body: full('Dutch Grand Prix'), times: 4 }]);
    await call('/f1'); // healthy pass populates the 24h backup
    await caches.default.delete(cacheKey('fresh', 'f1'));

    const standingsOnly = full('unused');
    delete standingsOnly.MRData.RaceTable; // drivers survive, the rest bounce
    stubFetch([
      { match: /next\.json/, body: 'down', status: 500 },
      { match: /last\/results/, body: 'down', status: 500 },
      { match: /driverStandings/, body: standingsOnly },
      { match: /constructorStandings/, body: 'down', status: 500 },
    ]);
    const res = await call('/f1');
    const digest = await res.json();
    expect(digest.partial).toBe(true);
    expect(digest.mended).toBe(true);
    expect(digest.next?.name).toBe('Dutch Grand Prix'); // borrowed from the backup
    expect(digest.teams?.length).toBe(1); // borrowed too
    expect(digest.drivers?.length).toBe(1); // the live half stays live
    expect(res.headers.get('cache-control')).toBe('public, max-age=120');
    await clearCache('f1');
  });
});

// origin is a parameter because the health monitor's selfFetch dispatches under
// the worker's own hostname, so its throttle entries land in a different bucket
// than a test's own https://api.test calls.
const clearThrottle = (ip = 'anon', origin = 'https://api.test') =>
  Promise.all([
    caches.default.delete(new Request(`${origin}/__throttle/code/${encodeURIComponent(ip)}`)),
    caches.default.delete(new Request(`${origin}/__throttle/getcode/${encodeURIComponent(ip)}`)),
  ]);

describe('/code exchange', () => {
  beforeEach(() => clearThrottle());

  it('stores a config and returns a 6-char single-use code', async () => {
    const post = await call('/code', {
      method: 'POST',
      body: JSON.stringify({ cfg: 'abc123_-' }),
    });
    expect(post.status).toBe(200);
    const { code } = await post.json();
    expect(code).toMatch(/^[A-HJ-NP-TV-Z0-9]{6}$/);

    const get1 = await call(`/code/${code}`);
    expect(get1.status).toBe(200);
    expect((await get1.json()).cfg).toBe('abc123_-');

    // A second client (distinct IP, so the per-IP redemption throttle doesn't
    // mask it) proves the code was consumed, not merely rate-limited.
    const get2 = await call(`/code/${code}`, { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
    expect(get2.status).toBe(404); // single use
  });
  it('is case-insensitive on retrieval', async () => {
    const post = await call('/code', { method: 'POST', body: JSON.stringify({ cfg: 'x' }) });
    const { code } = await post.json();
    const res = await call(`/code/${code.toLowerCase()}`);
    expect(res.status).toBe(200);
  });
  it('rejects bad bodies and oversized configs', async () => {
    // Distinct IPs so the per-IP throttle (now set before the body is read, so
    // malformed requests count too) doesn't mask the second and third response.
    const from = (n) => ({ 'CF-Connecting-IP': `172.16.0.${n}` });
    expect((await call('/code', { method: 'POST', body: 'not json', headers: from(1) })).status).toBe(400);
    expect((await call('/code', { method: 'POST', body: JSON.stringify({}), headers: from(2) })).status).toBe(400);
    const big = JSON.stringify({ cfg: 'x'.repeat(5000) });
    expect((await call('/code', { method: 'POST', body: big, headers: from(3) })).status).toBe(413);
  });
  it('bounds the transport body before parsing (a small cfg behind huge padding is rejected)', async () => {
    // F15: a valid small cfg hidden inside a huge padding field used to be
    // buffered and JSON-parsed in full before the cfg-length check ran, so the
    // field cap was bypassed entirely. The transport cap now rejects the body up
    // front. (Before this fix the small cfg minted a 200.)
    const padded = JSON.stringify({ cfg: 'x', pad: 'p'.repeat(40000) });
    expect((await call('/code', { method: 'POST', body: padded, headers: { 'CF-Connecting-IP': '172.17.0.1' } })).status).toBe(413);
  });
  it('404s unknown codes', async () => {
    expect((await call('/code/ZZZZZZ')).status).toBe(404);
  });
});

// Upstream fixtures in NJT RailData's real response shape (verified against the
// live API 2026-07-14; mapping isolated in njt.js). getStationSchedule returns
// an ARRAY of station objects, departures nested in ITEMS, no live track/status
// (TRACK holds the line name), and includes Amtrak trains + arrivals we drop.
// The station is pinned to New York Penn (NY): departures are "Westbound",
// NY-bound arrivals are "Eastbound" and get dropped by the direction filter.
const TOKEN_RESPONSE = { UserToken: 'tok-1' };
const SCHEDULE_RESPONSE = [
  {
    STATION_2CHAR: 'NY',
    STATIONNAME: 'New York',
    ITEMS: [
      { SCHED_DEP_DATE: '02-Jul-2026 08:15:00 AM', DESTINATION: 'Trenton &#9992', TRACK: 'Northeast Corridor Line', LINE: 'Northeast Corridor Line', TRAIN_ID: '3919', DIRECTION: 'Westbound' }, // NJT departure; airport entity decodes
      { SCHED_DEP_DATE: '02-Jul-2026 08:20:00 AM', DESTINATION: 'Dover', TRACK: 'Morris & Essex Line', LINE: 'Morris & Essex Line', TRAIN_ID: '6621', DIRECTION: 'Westbound' }, // NJT departure
      { SCHED_DEP_DATE: '02-Jul-2026 08:25:00 AM', DESTINATION: 'Washington', TRACK: 'ACELA', LINE: 'ACELA', TRAIN_ID: 'A2151', DIRECTION: 'Westbound' }, // Amtrak (letter id) — dropped
      { SCHED_DEP_DATE: '02-Jul-2026 08:28:00 AM', DESTINATION: 'Baltimore', TRACK: 'Northeast Corridor Line', LINE: 'Northeast Corridor Line', TRAIN_ID: 'A2121', DIRECTION: 'Westbound' }, // Amtrak sharing the NJT line name — dropped by the numeric-id rule
      { SCHED_DEP_DATE: '02-Jul-2026 08:26:00 AM', DESTINATION: 'Long Branch', TRACK: 'North Jersey Coast Line', LINE: 'North Jersey Coast Line', TRAIN_ID: '3244', DIRECTION: 'Eastbound' }, // NJT arrival INTO Penn terminating elsewhere — dropped by DIRECTION (name check would MISS this)
      { SCHED_DEP_DATE: '02-Jul-2026 08:30:00 AM', DESTINATION: 'New York', TRACK: 'North Jersey Coast Line', LINE: 'North Jersey Coast Line', TRAIN_ID: '3288', DIRECTION: 'Eastbound' }, // NJT arrival at NY (terminus literally "New York") — dropped
    ],
  },
];

describe('/njt/departures', () => {
  // A prior-day timetable seed for the KV fallback tests (its one train's epoch
  // is irrelevant to the route — only the mapping/health layers judge upcoming).
  const priorDay = { date: '2020-01-01', vm: { station: 'NY', updatedAt: 1, stale: false, trains: [{ time: 1, dest: 'Old', line: 'X', direction: 'Westbound', track: null, status: '' }] } };

  it('503s when secrets are not configured', async () => {
    const res = await call('/njt/departures');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('njt_not_configured');
  });

  it('fetches, maps, and serves today\'s schedule (durable in KV, not the Cache API)', async () => {
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE },
      { match: /getStationMSG/, body: [] },
    ]);
    const res = await call('/njt/departures', {}, NJT_ENV);
    expect(res.status).toBe(200);
    // It rides cached() like every other feed now, so a board finally gets a
    // Cache-Control it can act on instead of hitting origin on every poll.
    // 180s ≈ 1.5x the card's 2-minute poll (see the route-TTL sweep below).
    expect(res.headers.get('cache-control')).toBe('public, max-age=180');
    const body = await res.json();
    expect(body.station).toBe('NY');
    expect(body.stale).toBe(false);
    // Only the two NJT departures survive: both Amtrak trains (letter ids, one
    // sharing the NJT line name) and both Eastbound arrivals into Penn (one
    // terminating elsewhere, one literally "New York") are filtered out.
    expect(body.trains).toHaveLength(2);
    const dests = body.trains.map((t) => t.dest);
    expect(dests).not.toContain('Washington'); // Amtrak (ACELA) dropped
    expect(dests).not.toContain('Baltimore'); // Amtrak sharing the NJT line name dropped
    expect(dests).not.toContain('New York'); // Eastbound arrival (name match) dropped
    expect(dests).not.toContain('Long Branch'); // Eastbound arrival terminating elsewhere dropped by DIRECTION
    // Every surviving train is a departure (Westbound), never an arrival.
    expect(body.trains.every((t) => t.direction === 'Westbound')).toBe(true);
    const train = body.trains[0];
    expect(train.dest).toContain('Trenton'); // "Trenton ✈" after entity decode
    expect(train.dest).toContain('✈'); // &#9992 decoded to the airport glyph
    expect(train.dest).not.toContain('&#'); // no raw HTML entity leaks to the board
    expect(train.track).toBeNull(); // this endpoint has no real track number
    expect(train.status).toBe(''); // nor a live status
    expect(train.line).toBe('Northeast Corridor Line');
    // 08:15 AM America/New_York on 2026-07-02 is 12:15 UTC (EDT).
    expect(train.time).toBe(Date.UTC(2026, 6, 2, 12, 15, 0) / 1000);

    // The static schedule is durable in KV (survives colo eviction); nothing lands
    // in the old evictable 'njt:NY' Cache-API slot.
    expect(await env.CODES.get('njt:schedule')).toBeTruthy();
    expect(await caches.default.match(cacheKey('fresh', 'njt:NY'))).toBeFalsy();

    // Second same-day call is served from the route's cache entry, with no
    // second getStationSchedule.
    const before = calls.filter((u) => /getStationSchedule/.test(u)).length;
    const res2 = await call('/njt/departures', {}, NJT_ENV);
    expect(res2.status).toBe(200);
    expect((await res2.json()).trains).toHaveLength(2);
    expect(calls.filter((u) => /getStationSchedule/.test(u)).length).toBe(before);
  });

  it('retries once with a fresh token when the schedule call 401s', async () => {
    stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 2 },
      { match: /getStationSchedule/, body: 'expired', status: 401 },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE },
      { match: /getStationMSG/, body: [], times: 2 },
    ]);
    const res = await call('/njt/departures', {}, NJT_ENV);
    expect(res.status).toBe(200);
    expect((await res.json()).trains).toHaveLength(2);
  });

  it('dedupes concurrent cold-cache token mints (getToken fires once)', async () => {
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 5 },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE, times: 5 },
      { match: /getStationMSG/, body: [], times: 5 },
    ]);
    // Two independent fetches race on a cold token cache. Without njtToken's
    // in-flight guard each would read the empty cache and mint its own token —
    // the burst that (was blamed for) draining the 10/day getToken cap.
    await Promise.all([
      call('/njt/departures', {}, NJT_ENV),
      call('/njt/departures', {}, NJT_ENV),
    ]);
    expect(calls.filter((u) => /getToken/.test(u)).length).toBe(1);
  });

  it('dedupes concurrent forced re-auth mints on a shared 401 (getToken fires once)', async () => {
    // A burst of boards all holding the same expired token: each getStationSchedule
    // 401s and forces a re-auth at the same instant. The forced path used to mint
    // per caller, so three concurrent rejections spent three of the 10/day getToken
    // calls; now they share one mint. This stub keys the 401 on the rejected token
    // (not a call count) so the retries succeed regardless of interleaving.
    await resetNjtToken(env);
    await env.CODES.put('njt:token', 'expired'); // the token every caller reads, then has rejected
    const njtEnv = { ...env, ...NJT_ENV };
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = typeof url === 'string' ? url : url.url;
      calls.push(u);
      if (/getToken/.test(u)) {
        return new Response(JSON.stringify({ UserToken: 'fresh' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (/getStationSchedule/.test(u)) {
        const token = new URLSearchParams(String(init?.body ?? '')).get('token');
        if (token === 'expired') return new Response('unauth', { status: 401 });
        return new Response(JSON.stringify(SCHEDULE_RESPONSE), { headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unmocked fetch: ${u}`);
    }));
    const results = await Promise.all([
      fetchNjtSchedule(njtEnv),
      fetchNjtSchedule(njtEnv),
      fetchNjtSchedule(njtEnv),
    ]);
    expect(calls.filter((u) => /getToken/.test(u)).length).toBe(1); // one mint for the whole burst
    for (const r of results) expect(r.trains).toHaveLength(2); // every caller re-authed and got the schedule
  });

  it('serves a prior-day timetable (stale) when today\'s fetch fails', async () => {
    await env.CODES.put('njt:schedule', JSON.stringify(priorDay));
    stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 2 },
      { match: /getStationSchedule/, body: 'err', status: 500, times: 2 },
      { match: /getStationMSG/, body: [], times: 2 },
    ]);
    const res = await call('/njt/departures', {}, NJT_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stale).toBe(true); // could not get today's — flagged for the health check
    expect(body.trains).toHaveLength(1);
  });

  // Mid-outage, every board on every refresh used to arrive at a getStationSchedule
  // that was already timing out: one 10s abort PER REQUEST, stacked with the alerts
  // call behind it and past the board's own 15s fetch timeout, so nothing ever
  // refreshed. The route's cache entry is what ends that now: one attempt per
  // window, and every request in between is answered from it.
  it('attempts the upstream once per cache window while a refresh keeps failing', async () => {
    await env.CODES.put('njt:schedule', JSON.stringify(priorDay));
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 8 },
      { match: /getStationSchedule/, body: 'err', status: 500, times: 8 },
      { match: /getStationMSG/, body: [], times: 8 },
    ]);
    const bodies = [];
    for (let i = 0; i < 4; i += 1) {
      bodies.push(await (await call('/njt/departures', {}, NJT_ENV)).json());
    }
    expect(calls.filter((u) => /getStationSchedule/.test(u)).length).toBe(1);
    // Every request still gets the stored copy, flagged exactly as before.
    for (const body of bodies) {
      expect(body.trains).toHaveLength(1);
      expect(body.stale).toBe(true);
    }
  });

  it('re-attempts once the entry lapses (the fallback never sets)', async () => {
    // The window must not become a second way to serve a stale copy forever:
    // when the entry expires the refresh is back in play, which is what escapes
    // a midnight-rollover snapshot. Expiry is simulated by dropping the fresh
    // entry (the colo cache honors its own clock, not the test's).
    await env.CODES.put('njt:schedule', JSON.stringify(priorDay));
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 8 },
      { match: /getStationSchedule/, body: 'err', status: 500 }, // the outage
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE, times: 4 }, // recovered
      { match: /getStationMSG/, body: [], times: 8 },
    ]);
    await call('/njt/departures', {}, NJT_ENV);
    await call('/njt/departures', {}, NJT_ENV);
    expect(calls.filter((u) => /getStationSchedule/.test(u)).length).toBe(1); // served from the entry
    await caches.default.delete(cacheKey('fresh', njtKey()));
    const body = await (await call('/njt/departures', {}, NJT_ENV)).json();
    expect(calls.filter((u) => /getStationSchedule/.test(u)).length).toBe(2); // tried again
    expect(body.trains).toHaveLength(2); // today's list, not the seeded prior day
    expect(body.stale).toBe(false);
  });

  it('a stale KV date triggers a refetch (service-day rollover)', async () => {
    await env.CODES.put('njt:schedule', JSON.stringify(priorDay));
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE },
      { match: /getStationMSG/, body: [] },
    ]);
    const res = await call('/njt/departures', {}, NJT_ENV);
    expect((await res.json()).trains).toHaveLength(2); // today's fetch, not the seeded prior day
    expect(calls.some((u) => /getStationSchedule/.test(u))).toBe(true);
  });

  it('refreshes a same-day snapshot older than the max age (escapes a midnight-rollover truncation)', async () => {
    // The exact bug: NJT's ~midnight rollover lists only the outgoing day's
    // overnight tail, so the once-daily fetch cached a stub that then served all
    // day. A same-day copy older than the TTL must refetch today's full list.
    const stub = { date: nyDate(), vm: { station: 'NY', updatedAt: Math.floor(Date.now() / 1000) - 40 * 60, stale: false, trains: [{ time: 1, dest: 'Overnight tail', line: 'X', direction: 'Westbound', track: null, status: '' }] } };
    await env.CODES.put('njt:schedule', JSON.stringify(stub));
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE },
      { match: /getStationMSG/, body: [] },
    ]);
    const body = await (await call('/njt/departures', {}, NJT_ENV)).json();
    expect(calls.some((u) => /getStationSchedule/.test(u))).toBe(true); // refetched
    expect(body.trains).toHaveLength(2); // today's fresh list, not the stub
    expect(body.trains.map((t) => t.dest)).not.toContain('Overnight tail');
  });

  it('serves a recent same-day snapshot from KV without refetching', async () => {
    const recent = { date: nyDate(), vm: { station: 'NY', updatedAt: Math.floor(Date.now() / 1000) - 60, stale: false, trains: [{ time: 9999999999, dest: 'Cached', line: 'X', direction: 'Westbound', track: null, status: '' }] } };
    await env.CODES.put('njt:schedule', JSON.stringify(recent));
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE },
      { match: /getStationMSG/, body: [] },
    ]);
    const body = await (await call('/njt/departures', {}, NJT_ENV)).json();
    expect(calls.some((u) => /getStationSchedule/.test(u))).toBe(false); // served from KV
    expect(body.trains).toHaveLength(1);
    expect(body.trains[0].dest).toBe('Cached');
    expect(body.stale).toBe(false);
  });

  it('502s when the schedule fetch fails and there is no stored copy', async () => {
    stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 2 },
      { match: /getStationSchedule/, body: 'err', status: 500, times: 2 },
    ]);
    const res = await call('/njt/departures', {}, NJT_ENV);
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store'); // recovery is never one poll late
  });

  // The hard-failure path is the one that hurt most: nothing cached to answer
  // with, so every board re-opened a 10s abort of its own. cached()'s failure
  // backoff holds the upstream at arm's length for a minute; the reader sees the
  // same 502 either way.
  it('remembers a hard failure briefly instead of re-dialing NJT on every poll', async () => {
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 8 },
      { match: /getStationSchedule/, body: 'err', status: 500, times: 8 },
    ]);
    expect((await call('/njt/departures', {}, NJT_ENV)).status).toBe(502);
    const attempts = calls.filter((u) => /getStationSchedule/.test(u)).length;
    expect(attempts).toBe(1);
    expect((await call('/njt/departures', {}, NJT_ENV)).status).toBe(502);
    expect((await call('/njt/departures', {}, NJT_ENV)).status).toBe(502);
    expect(calls.filter((u) => /getStationSchedule/.test(u)).length).toBe(attempts);
  });

  it('serves alerts separately and empties them (never stale) when getStationMSG fails', async () => {
    stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE },
      { match: /getStationSchedule/, body: SCHEDULE_RESPONSE },
      { match: /getStationMSG/, body: 'boom', status: 500 },
    ]);
    const body = await (await call('/njt/departures', {}, NJT_ENV)).json();
    expect(body.trains).toHaveLength(2); // schedule unaffected
    expect(body.alerts).toEqual([]); // alert fetch failed -> empty, not a stale banner
  });

  // The alerts half used to keep a cache of its own that remembered a SUCCESS for
  // two minutes but let a FAILURE fall straight through to a bare [], so
  // mid-outage every board request re-opened a getStationMSG that was already
  // timing out: 10s of AbortSignal apiece. One entry over the whole digest covers
  // both halves at that same two minutes. The schedule is seeded fresh in KV here
  // so nothing but the alerts call can reach upstream.
  it('attempts the alerts upstream once per window while getStationMSG keeps failing', async () => {
    await env.CODES.put('njt:schedule', JSON.stringify({
      date: nyDate(),
      vm: { ...priorDay.vm, updatedAt: Math.floor(Date.now() / 1000) },
    }));
    const calls = stubFetch([
      { match: /getToken/, body: TOKEN_RESPONSE, times: 8 },
      { match: /getStationMSG/, body: 'boom', status: 500, times: 8 },
    ]);
    const bodies = [];
    for (let i = 0; i < 4; i += 1) {
      bodies.push(await (await call('/njt/departures', {}, NJT_ENV)).json());
    }
    expect(calls.filter((u) => /getStationMSG/.test(u)).length).toBe(1);
    expect(calls.filter((u) => /getStationSchedule/.test(u)).length).toBe(0); // served from KV throughout
    for (const body of bodies) {
      expect(body.alerts).toEqual([]); // still empty every time, never a stale banner
      expect(body.trains).toHaveLength(1);
    }
  });
});

describe('njt token persistence (KV)', () => {
  it('mints once, persists to KV, and reuses without re-authenticating', async () => {
    const calls = stubFetch([
      { match: /getToken/, body: { UserToken: 'tok-1' } },
      { match: /getStationSchedule/, body: [], times: 2 },
      { match: /getStationMSG/, body: [], times: 2 },
    ]);
    const creds = { NJT_USER: 'u', NJT_PASS: 'p' };
    expect((await call('/njt/departures', {}, creds)).status).toBe(200);
    expect((await call('/njt/departures', {}, creds)).status).toBe(200);
    expect(calls.filter((u) => u.includes('getToken'))).toHaveLength(1);
    expect(await env.CODES.get('njt:token')).toBe('tok-1'); // durable, global — the Cache API layer this replaces was colo-local and evictable
  });
});

describe('/alerts', () => {
  const FEED = {
    entity: [
      {
        alert: {
          informed_entity: [{ route_id: '4' }],
          header_text: { translation: [{ text: '[4] Delays at 14 St.', language: 'en' }] },
        },
      },
    ],
  };
  beforeEach(() => clearCache('alerts:subway'));

  it('digests and caches the subway alert feed', async () => {
    const calls = stubFetch([{ match: /subway-alerts\.json/, body: FEED }]);
    const res = await call('/alerts/subway');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alerts).toEqual([{ routes: ['4'], stops: [], kind: 'service', header: 'Delays at 14 St.', body: '' }]);
    const before = calls.length;
    await call('/alerts/subway'); // served from the Cache API inside the TTL
    expect(calls.length).toBe(before);
  });

  it('404s unknown systems', async () => {
    expect((await call('/alerts/bus')).status).toBe(404);
  });
});

describe('/bus/stops', () => {
  it('503s without a key and returns empty stops for missing legs', async () => {
    expect((await call('/bus/stops?legs=550685:MTABC_QM24')).status).toBe(503);
    const empty = await call('/bus/stops', {}, { MTA_BUS_KEY: 'k' });
    expect(empty.status).toBe(200);
    expect((await empty.json()).stops).toEqual([]);
  });
  it('proxies SIRI per stop with LineRef filter', async () => {
    await clearCache('bus:550685:MTABC_QM24');
    stubFetch([{ match: /bustime\.mta\.info/, body: { Siri: { ServiceDelivery: { StopMonitoringDelivery: [{ MonitoredStopVisit: [] }] } } } }]);
    const res = await call('/bus/stops?legs=550685:MTABC_QM24', {}, { MTA_BUS_KEY: 'k' });
    expect(res.status).toBe(200);
    // ~1.5x the card's 60s poll: at 30s the entry expired just before every
    // request, so a single board never once hit its own cache.
    expect(res.headers.get('cache-control')).toBe('public, max-age=90');
    const body = await res.json();
    // Each stop carries its leg's identity (stopId + lineRef) so the page can
    // join results to its own legs by key, not by array position — the cache key
    // for this route is order-insensitive. See mapBus in site/js/widgets/bus.js.
    expect(body.stops).toEqual([{ id: '550685', lineRef: 'MTABC_QM24', name: '', arrivals: [] }]);
  });
});

describe('/sports/team', () => {
  it('validates league and id, composes team + schedule digest', async () => {
    expect((await call('/sports/team?lg=xfl&id=abc')).status).toBe(400);
    await clearCache('sports:mlb:21');
    stubFetch([
      { match: /teams\/21$/, body: { team: { abbreviation: 'NYM', shortDisplayName: 'Mets', logos: [{ href: 'https://a.espncdn.com/i/teamlogos/mlb/500/nym.png' }], record: { items: [{ summary: '48-37' }] }, nextEvent: [] } } },
      { match: /teams\/21\/schedule/, body: { events: [{ competitions: [{ status: { type: { state: 'post', shortDetail: 'Final' } }, competitors: [
        { homeAway: 'away', team: { abbreviation: 'NYM' }, score: { value: 3 } },
        { homeAway: 'home', team: { abbreviation: 'TOR' }, score: { value: 9 } },
      ]}]}]} },
    ]);
    const res = await call('/sports/team?lg=mlb&id=21');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row).toMatchObject({ abbr: 'NYM', record: '48-37', lastLine: 'L 3-9 @ TOR · Final' });
  });
});

describe('golf/tennis digest routes (scores.js)', () => {
  const golfBody = { events: [{ shortName: 'The Open', date: '2026-07-16T06:00Z', competitions: [{
    status: { type: { state: 'in', detail: 'Round 3 - Play Complete' } },
    competitors: [{ order: 1, score: '-10', athlete: { shortName: 'S. Burns' }, linescores: [{ displayValue: '+3' }] }],
  }] }] };
  const tennisBody = { events: [{ id: '306', shortName: 'Nordea Open', groupings: [{
    grouping: { displayName: "Men's Singles" },
    competitions: [{ id: 'm1', date: '2026-07-19T13:00Z', status: { type: { state: 'post', shortDetail: 'Final' } },
      competitors: [
        { athlete: { shortName: 'A' }, winner: true, linescores: [{ value: 6 }] },
        { athlete: { shortName: 'B' }, winner: false, linescores: [{ value: 4 }] },
      ] }],
  }] }] };

  it('fetchGolf digests the scoreboard through the shared mapper', async () => {
    stubFetch([{ match: /golf\/pga\/scoreboard/, body: golfBody }]);
    const d = await fetchGolf();
    expect(d.name).toBe('The Open');
    expect(d.players[0]).toMatchObject({ pos: 1, name: 'S. Burns', score: '-10' });
  });

  it('fetchGolf throws on upstream failure (so cached() serves stale)', async () => {
    stubFetch([{ match: /golf\/pga\/scoreboard/, body: 'nope', status: 503 }]);
    await expect(fetchGolf()).rejects.toThrow('espn golf/pga 503');
  });

  it('fetchTennis serves a partial when one tour fails, throws when both do', async () => {
    stubFetch([
      { match: /tennis\/atp\/scoreboard/, body: tennisBody },
      { match: /tennis\/wta\/scoreboard/, body: 'down', status: 500 },
    ]);
    const d = await fetchTennis();
    expect(d.name).toBe('Nordea Open');
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]).toMatchObject({ tour: 'ATP', winner: 'a', sets: '6-4' });
    // The flag cached() reads to keep the ATP-only digest off the 24h backup.
    expect(d.partial).toBe(true);

    stubFetch([
      { match: /tennis\/atp\/scoreboard/, body: 'down', status: 500 },
      { match: /tennis\/wta\/scoreboard/, body: 'down', status: 500 },
    ]);
    await expect(fetchTennis()).rejects.toThrow('both tours failed');
  });

  it('fetchTennis leaves partial unset when both tours succeed', async () => {
    stubFetch([
      { match: /tennis\/atp\/scoreboard/, body: tennisBody },
      { match: /tennis\/wta\/scoreboard/, body: tennisBody },
    ]);
    const d = await fetchTennis();
    // A complete digest must NOT carry partial, or cached() would refuse to
    // refresh the backup and would cap the TTL at 120s for no reason.
    expect(d.partial).toBeUndefined();
  });
});

// ESPN's edge answers 403 to a request whose User-Agent is missing, a browser
// impostor, or an unknown custom string — it wants a value starting 'curl/'.
// That took My Teams, Golf and Tennis down together on 2026-08-05, and the
// header is invisible in every other test here (they assert URLs, not headers),
// so these assert the header itself. Rationale: worker/src/espn.js.
describe('ESPN User-Agent', () => {
  // Same route matching as stubFetch, but records the outgoing headers so a
  // test can assert what was actually SENT, not just where.
  function stubFetchHeaders(routes) {
    const reqs = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      reqs.push({ url, ua: new Headers(init?.headers ?? {}).get('user-agent') });
      const route = routes.find((r) => r.match.test(url) && (r.times ?? 1) > 0);
      if (!route) throw new Error(`unmocked fetch: ${url}`);
      route.times = (route.times ?? 1) - 1;
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return reqs;
  }

  // nextEvent state 'in' is what makes fetchTeamSummary reach for the league
  // scoreboard, so one call exercises all three of its fetches.
  const TEAM_IN_GAME = { team: {
    id: '10', abbreviation: 'NYY', shortDisplayName: 'Yankees', logos: [],
    nextEvent: [{ id: '401816004', competitions: [{
      status: { type: { state: 'in', shortDetail: 'Mid 5th' } },
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'NYY' }, score: null },
        { homeAway: 'away', team: { abbreviation: 'MIN' }, score: null },
      ],
    }] }],
  } };

  it('rides all three sports.js fetches: team, schedule and the live scoreboard', async () => {
    const reqs = stubFetchHeaders([
      { match: /teams\/10$/, body: TEAM_IN_GAME },
      { match: /teams\/10\/schedule$/, body: { events: [] } },
      { match: /mlb\/scoreboard$/, body: { events: [] } },
    ]);
    // No origin on purpose: cachedSchedLines then skips the Cache API, so the
    // schedule fetch really happens here instead of being served from a hit.
    await fetchTeamSummary('mlb', '10', null);
    expect(reqs).toHaveLength(3);
    expect(reqs.filter((r) => /teams\/10$/.test(r.url))).toHaveLength(1);
    expect(reqs.filter((r) => /schedule$/.test(r.url))).toHaveLength(1);
    expect(reqs.filter((r) => /scoreboard$/.test(r.url))).toHaveLength(1);
    for (const r of reqs) expect(r.ua).toBe(ESPN_UA);
  });

  it('rides the scores.js scoreboard fetch (golf)', async () => {
    const reqs = stubFetchHeaders([{ match: /golf\/pga\/scoreboard/, body: { events: [] } }]);
    await fetchGolf();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].ua).toBe(ESPN_UA);
  });

  it('rides the scores.js scoreboard fetch for BOTH tennis tours', async () => {
    const reqs = stubFetchHeaders([
      { match: /tennis\/atp\/scoreboard/, body: { events: [] } },
      { match: /tennis\/wta\/scoreboard/, body: { events: [] } },
    ]);
    await fetchTennis();
    expect(reqs).toHaveLength(2);
    for (const r of reqs) expect(r.ua).toBe(ESPN_UA);
  });

  it('starts with the curl token, because ESPN matches the PREFIX (tidying the order = 403)', () => {
    // Verified from Cloudflare egress: 'curl/8.7.1 (RoomBoard; ...)' -> 200,
    // but 'RoomBoard/1.0 curl/8.7.1' -> 403. The product name may only follow.
    expect(ESPN_UA.startsWith('curl/')).toBe(true);
    expect(ESPN_UA).toContain('roomboard.app'); // stays honest about who is calling
  });

  it('does NOT leak into svcstatus, whose host wants the opposite (a browser UA)', () => {
    // AWS's CloudFront bounces thin datacenter agents, ESPN bounces browsers.
    // Two hosts, two opposite rules — unifying them breaks one of the two.
    expect(ESPN_UA).not.toContain('Mozilla');
  });
});

describe('eventLine guards', () => {
  it('digestSchedule/digestNext tolerate a competition with no competitors array', () => {
    const sched = { events: [
      { date: '2099-01-01T00:00Z', competitions: [{ status: { type: { state: 'pre', shortDetail: 'TBD' } } }] },
      { date: '2020-01-01T00:00Z', competitions: [{ status: { type: { state: 'post', shortDetail: 'Final' } } }] },
    ] };
    expect(() => digestSchedule(sched, 'NYY')).not.toThrow();
    expect(() => digestNext(sched, 'NYY', 0)).not.toThrow();
  });
});

describe('digestNext (next scheduled game)', () => {
  const NOW = Date.parse('2026-07-19T04:00:00Z');
  const ev = (date, state, opp = 'LAD', home = true) => ({
    date,
    competitions: [{
      status: { type: { state, shortDetail: state === 'pre' ? '7/20 - 7:10 PM EDT' : 'Final' } },
      competitors: [
        { team: { abbreviation: 'NYY' }, homeAway: home ? 'home' : 'away', score: { value: 2 } },
        { team: { abbreviation: opp }, homeAway: home ? 'away' : 'home', score: { value: 1 } },
      ],
    }],
  });
  it('picks the earliest FUTURE pre event', () => {
    const sched = { events: [
      ev('2026-07-25T23:00:00Z', 'pre', 'BOS'),
      ev('2026-07-18T23:00:00Z', 'post'),
      ev('2026-07-20T23:00:00Z', 'pre', 'LAD'),
    ] };
    expect(digestNext(sched, 'NYY', NOW)).toBe('vs LAD · 7/20 - 7:10 PM EDT');
  });
  it('skips postponed games (state pre with a PAST date)', () => {
    const sched = { events: [
      ev('2026-07-18T23:00:00Z', 'pre', 'LAD'), // postponed: pre but already past
      ev('2026-07-21T23:00:00Z', 'pre', 'BAL'),
    ] };
    expect(digestNext(sched, 'NYY', NOW)).toBe('vs BAL · 7/20 - 7:10 PM EDT');
  });
  it('returns null with no future games (offseason)', () => {
    expect(digestNext({ events: [ev('2026-07-18T23:00:00Z', 'post')] }, 'NYY', NOW)).toBeNull();
    expect(digestNext({}, 'NYY', NOW)).toBeNull();
  });
});

describe('mapTeamSummary nextLine passthrough', () => {
  it('carries nextLine onto the row (null default)', () => {
    const teamJson = { team: { abbreviation: 'NYJ', shortDisplayName: 'Jets', logos: [] } };
    expect(mapTeamSummary(teamJson, null, 'nfl', null, 'vs MIA · 10/28').nextLine).toBe('vs MIA · 10/28');
    expect(mapTeamSummary(teamJson, null, 'nfl').nextLine).toBeNull();
  });
});

// sports.js keeps two Cache-API entries of its own beside cached()'s: the
// per-team schedule lines and the per-league scoreboard digest.
const sportsKey = (path) => new Request(`https://api.test/__cache/${path}`);
const resetTeams = (...ids) => Promise.all([
  caches.default.delete(sportsKey('sb/mlb')),
  ...ids.flatMap((id) => [clearCache(`sports:mlb:${id}`), caches.default.delete(sportsKey(`sched3/mlb:${id}`))]),
]);
const seedSched = (id) => caches.default.put(
  sportsKey(`sched3/mlb:${id}`),
  new Response(JSON.stringify({ lastLine: null, nextLine: null }), { headers: { 'Cache-Control': 'max-age=600' } }),
);

describe('/sports/team live scores', () => {
  const TEAM_LIVE = { team: {
    id: '10', abbreviation: 'NYY', shortDisplayName: 'Yankees',
    logos: [{ href: 'https://a.espncdn.com/i/teamlogos/mlb/500-dark/nyy.png', rel: ['full', 'dark'] }],
    record: { items: [{ summary: '48-38' }] },
    nextEvent: [{ id: '401816004', competitions: [{
      status: { type: { state: 'in', shortDetail: 'Mid 5th' } },
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'NYY' }, score: null },
        { homeAway: 'away', team: { abbreviation: 'MIN' }, score: null },
      ],
    }] }],
  } };
  // A second followed team, live in a different game on the same scoreboard.
  const TEAM_LIVE_BOS = { team: {
    id: '2', abbreviation: 'BOS', shortDisplayName: 'Red Sox', logos: [],
    nextEvent: [{ id: '999', competitions: [{
      status: { type: { state: 'in', shortDetail: 'Bot 3rd' } },
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'BOS' }, score: null },
        { homeAway: 'away', team: { abbreviation: 'TB' }, score: null },
      ],
    }] }],
  } };
  const SCOREBOARD = { events: [
    { id: '999', competitions: [{ status: { type: { state: 'in', shortDetail: 'Bot 3rd' } }, competitors: [
      { homeAway: 'home', team: { abbreviation: 'BOS' }, score: '1' },
      { homeAway: 'away', team: { abbreviation: 'TB' }, score: '0' },
    ] }] },
    { id: '401816004', competitions: [{
      status: { type: { state: 'in', shortDetail: 'Mid 5th' } },
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'NYY' }, score: '3' },
        { homeAway: 'away', team: { abbreviation: 'MIN' }, score: '2' },
      ],
    }] },
  ] };

  it('joins live scores from the league scoreboard by event id', async () => {
    await resetTeams('10');
    stubFetch([
      { match: /teams\/10$/, body: TEAM_LIVE },
      { match: /teams\/10\/schedule/, body: { events: [] } },
      { match: /scoreboard/, body: SCOREBOARD },
    ]);
    const res = await call('/sports/team?lg=mlb&id=10');
    const body = await res.json();
    expect(body.row.line).toBe('3-2 vs MIN · Mid 5th');
    expect(body.row.state).toBe('in');
  });

  it('degrades to a scoreless live line when the scoreboard is unavailable', async () => {
    await resetTeams('10');
    stubFetch([
      { match: /teams\/10$/, body: TEAM_LIVE },
      { match: /teams\/10\/schedule/, body: { events: [] } },
      { match: /scoreboard/, body: 'down', status: 500 },
    ]);
    const res = await call('/sports/team?lg=mlb&id=10');
    const body = await res.json();
    expect(body.row.line).toBe('vs MIN · Mid 5th');
    expect(body.row.line).not.toContain('\u2013');
  });

  it('downloads the league scoreboard once for every followed team playing in it', async () => {
    await resetTeams('10', '2');
    await Promise.all([seedSched('10'), seedSched('2')]);
    // One scoreboard response only: a second download would hit an unmocked
    // fetch, and the second team would lose its scores.
    const calls = stubFetch([
      { match: /teams\/10$/, body: TEAM_LIVE },
      { match: /teams\/2$/, body: TEAM_LIVE_BOS },
      { match: /mlb\/scoreboard$/, body: SCOREBOARD },
    ]);
    const nyy = await (await call('/sports/team?lg=mlb&id=10')).json();
    const bos = await (await call('/sports/team?lg=mlb&id=2')).json();
    expect(nyy.row.line).toBe('3-2 vs MIN · Mid 5th');
    expect(bos.row.line).toBe('1-0 vs TB · Bot 3rd');
    expect(calls.filter((u) => /scoreboard$/.test(u))).toHaveLength(1);
    await resetTeams('10', '2');
  });

  it('does not cache a failed scoreboard: the next live team tries again', async () => {
    await resetTeams('10', '2');
    await Promise.all([seedSched('10'), seedSched('2')]);
    stubFetch([
      { match: /teams\/10$/, body: TEAM_LIVE },
      { match: /teams\/2$/, body: TEAM_LIVE_BOS },
      { match: /mlb\/scoreboard$/, body: 'down', status: 500 },
      { match: /mlb\/scoreboard$/, body: SCOREBOARD },
    ]);
    expect((await (await call('/sports/team?lg=mlb&id=10')).json()).row.line).toBe('vs MIN · Mid 5th');
    expect((await (await call('/sports/team?lg=mlb&id=2')).json()).row.line).toBe('1-0 vs TB · Bot 3rd');
    await resetTeams('10', '2');
  });

  // Workers Free allows 50 subrequests per invocation, and every fetch, Cache
  // API match and put counts. The per-league digest adds a match and a put to
  // the scoreboard path, so sports.js takes it only when the schedule lines
  // came from cache; either way one /sports/team call stays at the 8 it cost
  // before the digest existed.
  describe('subrequest budget', () => {
    const cacheProto = Object.getPrototypeOf(caches.default);
    let spies = [];
    const countSubrequests = (fetchCalls) => {
      spies = [vi.spyOn(cacheProto, 'match'), vi.spyOn(cacheProto, 'put')];
      return () => fetchCalls.length + spies.reduce((n, s) => n + s.mock.calls.length, 0);
    };
    afterEach(() => spies.forEach((s) => s.mockRestore()));

    it('spends at most 8 when the schedule lines miss (scoreboard fetched bare)', async () => {
      await resetTeams('10');
      const calls = stubFetch([
        { match: /teams\/10$/, body: TEAM_LIVE },
        { match: /teams\/10\/schedule$/, body: { events: [] } },
        { match: /mlb\/scoreboard$/, body: SCOREBOARD },
      ]);
      const spent = countSubrequests(calls);
      expect((await (await call('/sports/team?lg=mlb&id=10')).json()).row.line).toBe('3-2 vs MIN · Mid 5th');
      expect(spent()).toBeLessThanOrEqual(8);
      spies.forEach((s) => s.mockRestore());
      // This call neither read nor wrote the digest.
      expect(await caches.default.match(sportsKey('sb/mlb'))).toBeFalsy();
      await resetTeams('10');
    });

    it('spends at most 8 when the schedule lines hit and the digest misses', async () => {
      await resetTeams('10');
      await seedSched('10');
      const calls = stubFetch([
        { match: /teams\/10$/, body: TEAM_LIVE },
        { match: /mlb\/scoreboard$/, body: SCOREBOARD },
      ]);
      const spent = countSubrequests(calls);
      expect((await (await call('/sports/team?lg=mlb&id=10')).json()).row.line).toBe('3-2 vs MIN · Mid 5th');
      expect(spent()).toBeLessThanOrEqual(8);
      spies.forEach((s) => s.mockRestore());
      expect(await caches.default.match(sportsKey('sb/mlb'))).toBeTruthy();
      await resetTeams('10');
    });
  });
});

describe('/sports/team team and schedule in parallel', () => {
  const TEAM = { team: { id: '10', abbreviation: 'NYY', shortDisplayName: 'Yankees', logos: [], nextEvent: [] } };
  // The schedule names its own team at the top level, as ESPN's does.
  const SCHED = { team: { id: '10', abbreviation: 'NYY' }, events: [{ competitions: [{
    status: { type: { state: 'post', shortDetail: 'Final' } },
    competitors: [
      { homeAway: 'home', team: { abbreviation: 'NYY' }, score: { value: 5 } },
      { homeAway: 'away', team: { abbreviation: 'TOR' }, score: { value: 2 } },
    ],
  }] }] };

  it('starts the schedule download alongside the team fetch, not after it', async () => {
    // The team answer is held until the schedule is requested, or 200ms pass:
    // run in sequence, the order below comes out team, team, schedule.
    let release;
    const gate = new Promise((resolve) => { release = resolve; setTimeout(resolve, 200); });
    const order = [];
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (/teams\/10$/.test(url)) {
        order.push('team requested');
        await gate;
        order.push('team answered');
        return Response.json(TEAM);
      }
      if (/teams\/10\/schedule$/.test(url)) {
        order.push('schedule requested');
        release();
        return Response.json(SCHED);
      }
      throw new Error(`unmocked fetch: ${url}`);
    }));
    const { row } = await fetchTeamSummary('mlb', '10', null);
    expect(order).toEqual(['team requested', 'schedule requested', 'team answered']);
    expect(row.lastLine).toBe('W 5-2 vs TOR · Final');
  });

  it('still throws on a failed team fetch, and caches the schedule it already downloaded', async () => {
    await resetTeams('10');
    stubFetch([
      { match: /teams\/10$/, body: 'down', status: 503 },
      { match: /teams\/10\/schedule$/, body: SCHED },
    ]);
    await expect(fetchTeamSummary('mlb', '10', 'https://api.test')).rejects.toThrow('espn team 503');

    // Digested against the schedule's own team, so the next call reads it
    // back instead of downloading the schedule again (no stub for it now).
    stubFetch([{ match: /teams\/10$/, body: TEAM }]);
    const { row } = await fetchTeamSummary('mlb', '10', 'https://api.test');
    expect(row.lastLine).toBe('W 5-2 vs TOR · Final');
    await resetTeams('10');
  });
});

describe('/sports/team schedule-lines TTL', () => {
  const TEAM = { team: { id: '10', abbreviation: 'NYY', shortDisplayName: 'Yankees', logos: [], nextEvent: [] } };
  // Runs one summary with the given schedule answer and returns the
  // Cache-Control the schedule lines were stored under.
  const schedLinesTtl = async (schedRoutes) => {
    await resetTeams('10');
    stubFetch([{ match: /teams\/10$/, body: TEAM }, ...schedRoutes]);
    const put = vi.spyOn(Object.getPrototypeOf(caches.default), 'put');
    let calls;
    try {
      await fetchTeamSummary('mlb', '10', 'https://api.test');
      calls = [...put.mock.calls];
    } finally {
      put.mockRestore();
      await resetTeams('10');
    }
    const [, stored] = calls.find(([req]) => req.url.endsWith('/__cache/sched3/mlb:10'));
    return stored.headers.get('cache-control');
  };

  it('holds a failed schedule for a minute, not half an hour', async () => {
    expect(await schedLinesTtl([{ match: /teams\/10\/schedule$/, body: 'down', status: 503 }])).toBe('max-age=60');
    // No schedule route: the stub throws, as a network failure or timeout would.
    expect(await schedLinesTtl([])).toBe('max-age=60');
  });

  it('keeps a real result for half an hour, even one with no games in it', async () => {
    expect(await schedLinesTtl([{ match: /teams\/10\/schedule$/, body: { events: [] } }])).toBe('max-age=1800');
  });
});

// The /sports/team TTL follows the game (teamFreshS in sports.js): a minute
// while anything can change, up to 15 minutes while nothing can. The long TTL
// is the one that can hide a first pitch, so most of these pin when it must
// NOT be given. Dates are ESPN's own shape ("2026-09-24T23:05Z", checked live).
describe('/sports/team TTL by game state', () => {
  const NOW = Date.parse('2026-09-25T18:00:00Z');
  const S = NOW / 1000;
  const MIN = 60;
  const ttl = (row) => teamFreshS({ row }, NOW);

  it('a live game lives a minute', () => {
    expect(ttl({ state: 'in', startsAt: S - 3600, nextStartsAt: S + 86400 })).toBe(SPORTS_LIVE_S);
    expect(SPORTS_LIVE_S).toBe(60);
  });

  it('a pre-game row expires at least 10 minutes before first pitch, however early it was cached', () => {
    // Cached 15 min out: inside the 20-minute window, so it is already live.
    expect(ttl({ state: 'pre', startsAt: S + 15 * MIN })).toBe(60);
    for (const out of [15, 21, 25, 30, 45, 120, 600]) {
      const t = ttl({ state: 'pre', startsAt: S + out * MIN });
      expect(t).toBeGreaterThanOrEqual(60);
      expect(t).toBeLessThanOrEqual(900);
      expect(S + t).toBeLessThanOrEqual(S + (out - 10) * MIN); // gone by start - 10 min
    }
    expect(ttl({ state: 'pre', startsAt: S + 25 * MIN })).toBe(15 * MIN); // start - 10 min exactly
    expect(ttl({ state: 'pre', startsAt: S + 21 * MIN })).toBe(11 * MIN);
    expect(ttl({ state: 'pre', startsAt: S + 3 * 3600 })).toBe(SPORTS_IDLE_MAX_S);
    expect(SPORTS_IDLE_MAX_S).toBe(900);
  });

  it('a game past its start but still pre (a rain delay, a late start) stays live for six hours', () => {
    expect(ttl({ state: 'pre', startsAt: S - 30 * MIN })).toBe(60);
    expect(ttl({ state: 'pre', startsAt: S - (6 * 60 - 1) * MIN })).toBe(60);
  });

  it('a postponed game (pre, dated six hours or more ago) waits on the NEXT game, not its own date', () => {
    const postponed = { state: 'pre', startsAt: S - 7 * 3600 };
    expect(ttl({ ...postponed, nextStartsAt: S + 86400 })).toBe(900);
    expect(ttl({ ...postponed, nextStartsAt: S + 21 * MIN })).toBe(11 * MIN);
    // The next game inside its 20-minute window, or under way: live, as a pre row.
    expect(ttl({ ...postponed, nextStartsAt: S + 20 * MIN })).toBe(60);
    expect(ttl({ ...postponed, nextStartsAt: S + 15 * MIN })).toBe(60);
    expect(ttl({ ...postponed, nextStartsAt: S - 30 * MIN })).toBe(60);
    expect(ttl({ ...postponed, nextStartsAt: null })).toBe(900); // nothing else scheduled
    expect(ttl(postponed)).toBe(SPORTS_UNSURE_S); // the schedule could not be read
  });

  it('a final with a doubleheader to come expires ten minutes before game two, and is live inside its 20-minute window', () => {
    const final = { state: 'post', startsAt: S - 3 * 3600 };
    expect(ttl({ ...final, nextStartsAt: S + 40 * MIN })).toBe(900);
    expect(ttl({ ...final, nextStartsAt: S + 21 * MIN })).toBe(11 * MIN);
    // Inside game two's 20-minute window the final is treated as a pre row
    // would be: live, not left to idle until ten minutes out.
    expect(ttl({ ...final, nextStartsAt: S + 20 * MIN })).toBe(60);
    expect(ttl({ ...final, nextStartsAt: S + 15 * MIN })).toBe(60);
    expect(ttl({ ...final, nextStartsAt: S + 5 * MIN })).toBe(60);
    // Game one ran long past game two's nominal start: game two is due now.
    expect(ttl({ ...final, nextStartsAt: S - 20 * MIN })).toBe(60);
    expect(ttl({ ...final, nextStartsAt: S - (6 * 60 - 1) * MIN })).toBe(60);
    // Same for a team with no game on its row yet.
    expect(ttl({ state: 'none', startsAt: null, nextStartsAt: S + 15 * MIN })).toBe(60);
  });

  it('an idle row with nothing scheduled lives the maximum; one whose schedule failed never does', () => {
    expect(ttl({ state: 'post', startsAt: S - 86400, nextStartsAt: null })).toBe(900);
    expect(ttl({ state: 'none', startsAt: null, nextStartsAt: null })).toBe(900);
    expect(ttl({ state: 'none', startsAt: null, nextStartsAt: S + 2 * 86400 })).toBe(900);
    expect(ttl({ state: 'post', startsAt: S - 86400 })).toBe(SPORTS_UNSURE_S);
    expect(ttl({ state: 'none', startsAt: null })).toBe(SPORTS_UNSURE_S);
    expect(SPORTS_UNSURE_S).toBeLessThan(SPORTS_IDLE_MAX_S);
  });

  it('an unknown state, a missing start or a missing row never gets the long TTL', () => {
    expect(ttl({ state: 'delayed', startsAt: S + 86400, nextStartsAt: null })).toBe(SPORTS_UNSURE_S);
    expect(ttl({ state: 'pre', startsAt: null, nextStartsAt: null })).toBe(SPORTS_UNSURE_S);
    expect(teamFreshS({ row: null }, NOW)).toBe(SPORTS_UNSURE_S);
    expect(teamFreshS(undefined, NOW)).toBe(SPORTS_UNSURE_S);
  });

  it('nextStartAt keeps a doubleheader game two past its nominal time, but not a postponed game', () => {
    const ev = (date, state) => ({ date, competitions: [{ status: { type: { state } } }] });
    const sched = { events: [
      ev('2026-09-24T23:05Z', 'post'),
      ev('2026-09-25T10:05Z', 'pre'), // 8h ago and still pre: postponed
      ev('2026-09-25T17:05Z', 'pre'), // 55 min ago and still pre: game two, due
      ev('2026-09-27T19:20Z', 'pre'),
    ] };
    expect(nextStartAt(sched, NOW)).toBe(Date.parse('2026-09-25T17:05Z') / 1000);
    expect(nextStartAt({ events: [ev('2026-09-25T10:05Z', 'pre'), ev('2026-09-27T19:20Z', 'pre')] }, NOW))
      .toBe(Date.parse('2026-09-27T19:20Z') / 1000);
    expect(nextStartAt({ events: [ev('2026-09-24T23:05Z', 'post')] }, NOW)).toBeNull();
    expect(nextStartAt({}, NOW)).toBeNull();
  });

  it('nextStartAt counts a game the schedule already calls live as starting now', () => {
    const ev = (date, state) => ({ date, competitions: [{ status: { type: { state } } }] });
    // A doubleheader's game two under way in the schedule, game one final:
    // whatever game two's date says, the next start is now.
    const sched = { events: [
      ev('2026-09-25T13:05Z', 'post'),
      ev('2026-09-25T17:05Z', 'in'),
      ev('2026-09-26T17:05Z', 'pre'),
    ] };
    expect(nextStartAt(sched, NOW)).toBe(S);
    // Dated long enough ago to read as postponed were it 'pre', or not dated
    // at all: live all the same.
    expect(nextStartAt({ events: [ev('2026-09-25T08:00Z', 'in')] }, NOW)).toBe(S);
    expect(nextStartAt({ events: [ev(undefined, 'in')] }, NOW)).toBe(S);
    // So the final on the row lives a minute, not until tomorrow's game.
    expect(ttl({ state: 'post', startsAt: S - 5 * 3600, nextStartsAt: nextStartAt(sched, NOW) })).toBe(60);
  });

  describe('on the route', () => {
    // ESPN dates carry minutes, not seconds.
    const iso = (ms) => new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
    const toMinute = (ms) => Math.floor(ms / 60_000) * 60;
    const game = (state, startMs, detail) => ({ id: '77', date: iso(startMs), competitions: [{
      date: iso(startMs),
      status: { type: { state, shortDetail: detail } },
      competitors: [
        { homeAway: 'home', team: { abbreviation: 'NYY' }, score: state === 'pre' ? undefined : { value: 4 } },
        { homeAway: 'away', team: { abbreviation: 'BOS' }, score: state === 'pre' ? undefined : { value: 2 } },
      ],
    }] });
    const team = (ev) => ({ team: { id: '10', abbreviation: 'NYY', shortDisplayName: 'Yankees', logos: [], nextEvent: ev ? [ev] : [] } });
    const maxAge = (res) => Number(/max-age=(\d+)/.exec(res.headers.get('cache-control'))[1]);
    const summary = async (teamBody, schedRoute) => {
      await resetTeams('10');
      stubFetch([
        { match: /teams\/10$/, body: teamBody },
        { match: /teams\/10\/schedule$/, ...schedRoute },
        { match: /mlb\/scoreboard$/, body: { events: [] } },
      ]);
      const res = await call('/sports/team?lg=mlb&id=10');
      const { row } = await res.json();
      await resetTeams('10');
      return { res, row };
    };

    it('serves a live row for a minute and an idle one for fifteen, with its start times on the row', async () => {
      const live = await summary(team(game('in', Date.now() - 3600_000, 'Top 5th')), { body: { events: [] } });
      expect(live.res.headers.get('cache-control')).toBe('public, max-age=60');

      const started = Date.now() - 4 * 3600_000;
      const tomorrow = Date.now() + 86400_000;
      const idle = await summary(team(game('post', started, 'Final')), { body: { events: [game('pre', tomorrow)] } });
      expect(idle.res.headers.get('cache-control')).toBe('public, max-age=900');
      // Additive fields the card ignores.
      expect(idle.row.startsAt).toBe(toMinute(started));
      expect(idle.row.nextStartsAt).toBe(toMinute(tomorrow));
    });

    it('serves a final for a minute while the schedule already has game two under way', async () => {
      // The team endpoint still points at game one's final; the schedule has
      // moved on to game two, live.
      const gameOne = Date.now() - 4 * 3600_000;
      const gameTwo = { ...game('in', Date.now() - 30 * 60_000, 'Top 2nd'), id: '78' };
      const { res, row } = await summary(team(game('post', gameOne, 'Final')), {
        body: { events: [game('post', gameOne, 'Final'), gameTwo, game('pre', Date.now() + 86400_000)] },
      });
      expect(row.state).toBe('post');
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    });

    it('holds a final only until ten minutes before a doubleheader\'s game two', async () => {
      const gameTwo = Date.now() + 25 * 60_000;
      const { res } = await summary(team(game('post', Date.now() - 3 * 3600_000, 'Final')), { body: { events: [game('pre', gameTwo)] } });
      // Minute precision moves game two up to 59s earlier, never later.
      expect(maxAge(res)).toBeLessThanOrEqual(15 * 60);
      expect(maxAge(res)).toBeGreaterThan(14 * 60);
    });

    it('never gives an idle row the long TTL when its schedule could not be read', async () => {
      const { res, row } = await summary(team(game('post', Date.now() - 3 * 3600_000, 'Final')), { body: 'down', status: 503 });
      expect(res.headers.get('cache-control')).toBe(`public, max-age=${SPORTS_UNSURE_S}`);
      expect('nextStartsAt' in row).toBe(false); // unknown, not "nothing scheduled"
    });

    it('stores the next start with the schedule lines, and leaves it off a failure\'s entry', async () => {
      const stored = async (schedRoute) => {
        await resetTeams('10');
        stubFetch([{ match: /teams\/10$/, body: team(null) }, { match: /teams\/10\/schedule$/, ...schedRoute }]);
        await fetchTeamSummary('mlb', '10', 'https://api.test');
        const entry = await (await caches.default.match(sportsKey('sched3/mlb:10'))).json();
        await resetTeams('10');
        return entry;
      };
      const next = Date.now() + 86400_000;
      expect(await stored({ body: { events: [game('pre', next)] } })).toMatchObject({ nextAt: toMinute(next) });
      expect(await stored({ body: { events: [] } })).toMatchObject({ nextAt: null }); // known: nothing ahead
      expect('nextAt' in (await stored({ body: 'down', status: 503 }))).toBe(false); // unknown
    });

    it('keeps the league scoreboard digest for 30s, so a live score is at most ~90s old at the worker', async () => {
      await resetTeams('10');
      await seedSched('10'); // a schedule hit is what lets the scoreboard use its digest
      stubFetch([
        { match: /teams\/10$/, body: team(game('in', Date.now() - 3600_000, 'Top 5th')) },
        { match: /mlb\/scoreboard$/, body: { events: [] } },
      ]);
      const put = vi.spyOn(Object.getPrototypeOf(caches.default), 'put');
      try {
        await call('/sports/team?lg=mlb&id=10');
        const [, stored] = put.mock.calls.find(([req]) => req.url.endsWith('/__cache/sb/mlb'));
        expect(stored.headers.get('cache-control')).toBe('max-age=30');
      } finally {
        put.mockRestore();
        await resetTeams('10');
      }
    });
  });
});

describe('digestScoreboard', () => {
  it('keeps only the fields a row reads, keyed by event id, and leaves pre-game events out', () => {
    const sb = { events: [
      { id: '1', name: 'Twins at Yankees', competitions: [{
        venue: { fullName: 'Yankee Stadium' },
        status: { clock: 0, period: 5, type: { id: '2', state: 'in', shortDetail: 'Mid 5th', detail: 'Middle of the 5th' } },
        competitors: [
          { homeAway: 'home', team: { abbreviation: 'NYY', logo: 'x.png' }, score: '3', linescores: [{ value: 1 }] },
          { homeAway: 'away', team: { abbreviation: 'MIN' }, score: { value: 2 } },
        ],
      }] },
      { id: '2', competitions: [{ status: { type: { state: 'pre', shortDetail: '7:05 PM' } }, competitors: [] }] },
      { id: '3', competitions: [{ status: { type: { state: 'post', shortDetail: 'Final' } } }] },
    ] };
    expect(digestScoreboard(sb)).toEqual({
      1: {
        status: { type: { state: 'in', shortDetail: 'Mid 5th' } },
        competitors: [
          { homeAway: 'home', team: { abbreviation: 'NYY' }, score: '3' },
          { homeAway: 'away', team: { abbreviation: 'MIN' }, score: '2' },
        ],
      },
      3: { status: { type: { state: 'post', shortDetail: 'Final' } }, competitors: [] },
    });
    expect(digestScoreboard(null)).toEqual({});
  });
});

describe('/code rate limiting', () => {
  beforeEach(() => clearThrottle('1.2.3.4'));
  it('429s a second code request from the same IP within the window', async () => {
    const init = { method: 'POST', body: JSON.stringify({ cfg: 'abc123' }), headers: { 'CF-Connecting-IP': '1.2.3.4' } };
    expect((await call('/code', init)).status).toBe(200);
    expect((await call('/code', init)).status).toBe(429);
  });
  it('throttles even after an invalid request (a malformed body cannot skip the speed bump)', async () => {
    // F15: the marker is installed BEFORE the body is read, so a flood of
    // malformed or oversized bodies can no longer slip past the per-IP speed
    // bump. A bad first request still answers 400, but it spends the window.
    const ip = { 'CF-Connecting-IP': '1.2.3.4' };
    expect((await call('/code', { method: 'POST', body: 'nope', headers: ip })).status).toBe(400);
    expect((await call('/code', { method: 'POST', body: JSON.stringify({ cfg: 'ok123' }), headers: ip })).status).toBe(429);
  });
  it('429s a second redemption from the same IP within the window', async () => {
    // Redemption (GET /code/:code) shares the CODES read quota with the NJT
    // token/schedule; a per-IP speed bump keeps a guessing flood from draining it.
    const ip = { 'CF-Connecting-IP': '5.6.7.8' };
    await clearThrottle('5.6.7.8');
    expect((await call('/code/ZZZZZZ', { headers: ip })).status).toBe(404);
    expect((await call('/code/ZZZZZZ', { headers: ip })).status).toBe(429);
  });
});

describe('guardFetch (last-resort error guard)', () => {
  const req = () => new Request('https://api.test/anything', { method: 'GET' });

  it('turns an unhandled throw into CORS-clean JSON 500 instead of an opaque 1101', async () => {
    const res = await guardFetch(() => { throw new Error('boom'); })(req(), {}, {});
    expect(res.status).toBe(500);
    // The CORS header is the whole point: without it the board sees a network
    // error with no diagnosable body.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });
  it('also catches an async rejection', async () => {
    const res = await guardFetch(async () => { throw new Error('async boom'); })(req(), {}, {});
    expect(res.status).toBe(500);
  });
  it('passes a normal response straight through untouched', async () => {
    const ok = new Response('hi', { status: 200 });
    expect(await guardFetch(() => ok)(req(), {}, {})).toBe(ok);
  });
  it('survives an unparseable request url while logging (no throw from the guard itself)', async () => {
    const res = await guardFetch(() => { throw new Error('boom'); })({ method: 'GET', url: 'not a url' }, {}, {});
    expect(res.status).toBe(500);
  });
});

describe('/sports/team prototype-key guard', () => {
  it('rejects inherited-property league names', async () => {
    expect((await call('/sports/team?lg=constructor&id=abc')).status).toBe(400);
    expect((await call('/sports/team?lg=toString&id=abc')).status).toBe(400);
  });
});

describe('/news', () => {
  it('proxies whitelisted feeds and 404s unknown ids', async () => {
    await clearCache('news:npr');
    stubFetch([{ match: /feeds\.npr\.org/, body: '<rss><channel><item><title>Hi</title></item></channel></rss>' }]);
    const res = await call('/news/npr');
    expect(res.status).toBe(200);
    expect((await res.json()).xml).toContain('<title>Hi</title>');
    expect((await call('/news/evil-feed')).status).toBe(404);
  });

  it('resolves the finance feed ids and rejects unknown ids', () => {
    for (const id of ['cnbc', 'marketwatch', 'yahoo-finance', 'seekingalpha']) {
      expect(newsFeedUrl(id)).toMatch(/^https:\/\//);
    }
    expect(newsFeedUrl('not-a-feed')).toBeNull();
  });

  // A hyphenated id has to clear the route pattern as well as the whitelist,
  // which is the half a bare newsFeedUrl() check cannot see.
  it('proxies the hyphenated sports feed ids the Sports News card asks for', async () => {
    for (const id of ['espn', 'cbs-sports', 'yahoo-sports', 'bbc-sport', 'guardian-sport']) {
      expect(newsFeedUrl(id), id).toMatch(/^https:\/\//);
    }
    await clearCache('news:cbs-sports');
    stubFetch([{ match: /cbssports\.com/, body: '<rss><channel><item><title>Trade</title></item></channel></rss>' }]);
    const res = await call('/news/cbs-sports');
    expect(res.status).toBe(200);
    expect((await res.json()).xml).toContain('<title>Trade</title>');
  });
});

describe('/markets', () => {
  const yahoo = (price, prev) => ({
    chart: {
      result: [
        {
          meta: { symbol: '^GSPC', regularMarketPrice: price, chartPreviousClose: prev },
          timestamp: [1, 2, 3],
          indicators: { quote: [{ close: [prev, (price + prev) / 2, price] }] },
        },
      ],
    },
  });

  beforeEach(() => clearCache('markets:^DJI,^GSPC,^IXIC')); // cache key is sorted

  it('serves custom symbols with Yahoo shortName fallback', async () => {
    await clearCache('markets:AAPL');
    const y = yahoo(200, 190);
    y.chart.result[0].meta.symbol = 'AAPL';
    y.chart.result[0].meta.shortName = 'Apple Inc.';
    stubFetch([{ match: /chart\/AAPL/, body: y }]);
    const res = await call('/markets?symbols=aapl');
    const body = await res.json();
    expect(body.indices).toHaveLength(1);
    expect(body.indices[0]).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.' });
  });

  it('recovers the daily change from daily bars when Yahoo rolls the close (LSE evening)', async () => {
    await clearCache('markets:CBG.L');
    // Rolled single-session payload: price === chartPreviousClose → change 0.
    const rolled = yahoo(413.6, 413.6);
    rolled.chart.result[0].meta.symbol = 'CBG.L';
    rolled.chart.result[0].meta.shortName = 'CLOSE BROTHERS GROUP PLC ORD 25';
    rolled.chart.result[0].indicators.quote[0].close = [407.8, 410.1, 413.6];
    const daily = { chart: { result: [{ meta: { symbol: 'CBG.L' },
      indicators: { quote: [{ close: [402.0, 409.4, 413.6] }] } }] } };
    stubFetch([
      { match: /chart\/CBG\.L\?range=2d/, body: rolled },
      { match: /chart\/CBG\.L\?range=5d&interval=1d/, body: daily },
    ]);
    const res = await call('/markets?symbols=CBG.L');
    const body = await res.json();
    expect(body.indices[0].symbol).toBe('CBG.L');
    expect(body.indices[0].change).toBeCloseTo(413.6 - 409.4, 5); // vs prior daily close
    expect(body.indices[0].changePct).toBeCloseTo(((413.6 - 409.4) / 409.4) * 100, 5);
  });

  it('aggregates the three indices', async () => {
    stubFetch([{ match: /query1\.finance\.yahoo\.com/, body: yahoo(100, 90), times: 3 }]);
    const res = await call('/markets');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indices).toHaveLength(3);
    expect(body.indices.map((i) => i.name)).toEqual(['Dow Jones', 'Nasdaq', 'S&P 500']);
    expect(body.indices[0].changePct).toBeCloseTo(11.11, 1);
  });

  it('502s with no cache and failing upstream', async () => {
    stubFetch([{ match: /query1\.finance\.yahoo\.com/, body: 'nope', status: 500, times: 3 }]);
    const res = await call('/markets');
    expect(res.status).toBe(502);
  });

  it('serves 20 symbols and slices the 21st off', async () => {
    // Matches the config cap: a board can follow 20 tickers, and the expand
    // overlay shows all of them, so the route must fetch the whole list.
    const want = Array.from({ length: 20 }, (_, i) => `TK${String(i).padStart(2, '0')}`);
    const key = [...want].sort().join(',');
    await clearCache(`markets:${key}`);
    stubFetch([{ match: /query1\.finance\.yahoo\.com/, body: yahoo(100, 90), times: 21 }]);
    const res = await call(`/markets?symbols=${[...want, 'TK20'].join(',')}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.indices).toHaveLength(20); // the 21st never reached Yahoo
    expect(body.partial).toBeUndefined();
  });

  it('a partial batch serves fresh but never overwrites the complete stale backup', async () => {
    const key = 'markets:AAA,BBB';
    await clearCache(key);
    const y = (sym) => { const b = yahoo(100, 90); b.chart.result[0].meta.symbol = sym; return b; };
    // 1. full success → both fresh + 24h stale hold the complete 2-index list
    stubFetch([{ match: /chart\/AAA/, body: y('AAA') }, { match: /chart\/BBB/, body: y('BBB') }]);
    expect((await (await call('/markets?symbols=aaa,bbb')).json()).indices).toHaveLength(2);
    // 2. expire only the FRESH copy (simulate the TTL lapsing — for the
    //    watchlist entry and, on the same clock, the per-symbol quotes)
    await caches.default.delete(cacheKey('fresh', key));
    await caches.default.delete(quoteMapKey);
    // 3. one symbol now fails → partial fresh payload, flagged
    stubFetch([{ match: /chart\/AAA/, body: y('AAA') }, { match: /chart\/BBB/, body: 'no', status: 500 }]);
    const partial = await (await call('/markets?symbols=aaa,bbb')).json();
    expect(partial.indices).toHaveLength(1);
    expect(partial.partial).toBe(true);
    // 4. expire fresh again; a total outage must serve the FULL backup, not the
    //    crippled partial (the bug: step 3 would have poisoned the stale key)
    await caches.default.delete(cacheKey('fresh', key));
    await caches.default.delete(quoteMapKey);
    stubFetch([{ match: /chart\/(AAA|BBB)/, body: 'no', status: 500, times: 2 }]);
    const served = await (await call('/markets?symbols=aaa,bbb')).json();
    expect(served.stale).toBe(true);
    expect(served.indices).toHaveLength(2);
  });

  // The per-symbol layer (sharedmap.js). The route caches per whole watchlist,
  // so before it a symbol shared by many watchlists was refetched from Yahoo
  // once per distinct list — the largest upstream on the worker's dashboard.
  const ySym = (sym, price = 100, prev = 90) => {
    const b = yahoo(price, prev);
    b.chart.result[0].meta.symbol = sym;
    return b;
  };
  const seedQuotes = (entries) => caches.default.put(quoteMapKey, new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
  }));

  it('fetches a symbol shared by two watchlists from Yahoo once', async () => {
    await Promise.all([clearCache('markets:AAA,BBB'), clearCache('markets:AAA,CCC')]);
    const calls = stubFetch([
      { match: /chart\/AAA/, body: ySym('AAA'), times: 2 },
      { match: /chart\/BBB/, body: ySym('BBB') },
      { match: /chart\/CCC/, body: ySym('CCC') },
    ]);
    const one = await (await call('/markets?symbols=aaa,bbb')).json();
    const two = await (await call('/markets?symbols=ccc,aaa')).json();
    expect(calls.filter((u) => /chart\/AAA/.test(u))).toHaveLength(1);
    expect(one.indices.map((q) => q.symbol)).toEqual(['AAA', 'BBB']);
    expect(two.indices.map((q) => q.symbol)).toEqual(['CCC', 'AAA']); // request order kept
    expect(two.indices[1]).toEqual(one.indices[0]); // the very same quote
    await Promise.all([clearCache('markets:AAA,BBB'), clearCache('markets:AAA,CCC')]);
  });

  it('runs the zero-change daily-bars fallback once per symbol per TTL, not once per watchlist', async () => {
    await Promise.all([clearCache('markets:CBG.L'), clearCache('markets:AAA,CBG.L')]);
    const rolled = ySym('CBG.L', 413.6, 413.6);
    rolled.chart.result[0].indicators.quote[0].close = [407.8, 410.1, 413.6];
    const daily = { chart: { result: [{ meta: { symbol: 'CBG.L' },
      indicators: { quote: [{ close: [402.0, 409.4, 413.6] }] } }] } };
    const calls = stubFetch([
      { match: /chart\/CBG\.L\?range=2d/, body: rolled, times: 2 },
      { match: /chart\/CBG\.L\?range=5d&interval=1d/, body: daily, times: 2 },
      { match: /chart\/AAA/, body: ySym('AAA') },
    ]);
    await call('/markets?symbols=CBG.L');
    const second = await (await call('/markets?symbols=aaa,CBG.L')).json();
    expect(calls.filter((u) => /interval=1d/.test(u))).toHaveLength(1);
    expect(second.indices[1].change).toBeCloseTo(413.6 - 409.4, 5); // the recovered change rides along
    await Promise.all([clearCache('markets:CBG.L'), clearCache('markets:AAA,CBG.L')]);
  });

  it('refetches a quote older than the markets TTL and stamps "as of" with the oldest quote used', async () => {
    await clearCache('markets:AAA,BBB');
    const t = Date.now();
    const kept = { symbol: 'AAA', name: 'AAA', price: 1, change: 0.5, changePct: 1, spark: [], spark2: [], split: 0 };
    await seedQuotes({
      AAA: { value: kept, fetchedAt: t - 200_000 }, // inside a trading quote's 240s: reused
      BBB: { value: { symbol: 'BBB' }, fetchedAt: t - 241_000 }, // past it: refetched
    });
    const calls = stubFetch([{ match: /chart\/BBB/, body: ySym('BBB') }]);
    const res = await (await call('/markets?symbols=aaa,bbb')).json();
    expect(calls).toHaveLength(1); // BBB only
    expect(res.indices[0]).toEqual(kept);
    expect(res.indices[1]).toMatchObject({ symbol: 'BBB', price: 100 });
    // The card prints updatedAt as its "as of" clock: it must not claim the
    // 200s-old AAA quote is from now.
    expect(res.updatedAt).toBe(Math.floor((t - 200_000) / 1000));
    await clearCache('markets:AAA,BBB');
  });

  it('keeps a watchlist fresh only as long as its oldest reused quote, never a full TTL from assembly', async () => {
    // AAA fetched at t=0; the uncached list AAA,BBB assembled around it at
    // t=239. The entry used to restart the clock there, so a board polling at
    // t=478 still got the t=0 quote marked fresh. Now it has AAA's last second.
    // (Neither quote says when its market traded, so both are judged trading:
    // QUOTE_ACTIVE_S each.)
    const key = 'markets:AAA,BBB';
    await clearCache(key);
    const t0 = Date.now() - 239_000;
    const old = { symbol: 'AAA', name: 'AAA', price: 1, change: 0.5, changePct: 1, spark: [], spark2: [], split: 0 };
    await seedQuotes({ AAA: { value: old, fetchedAt: t0 } });
    stubFetch([{ match: /chart\/BBB/, body: ySym('BBB') }]);
    const first = await call('/markets?symbols=aaa,bbb');
    expect((await first.json()).indices[0]).toEqual(old); // reused, as it should be
    expect(first.headers.get('cache-control')).toBe('public, max-age=1'); // what is left of AAA's 240s
    const entry = await caches.default.match(cacheKey('fresh', key));
    expect(Number(entry.headers.get('X-Fresh-Until'))).toBeLessThanOrEqual(t0 + 240_000 + 500); // rounding slop

    // Past t=240 the entry has lapsed with AAA, so AAA comes from Yahoo again
    // instead of the t=0 quote being served as fresh.
    await new Promise((r) => setTimeout(r, 1100));
    const calls = stubFetch([{ match: /chart\/AAA/, body: ySym('AAA', 222, 200) }]);
    const later = await call('/markets?symbols=aaa,bbb');
    const body = await later.json();
    expect(calls).toHaveLength(1); // AAA only; BBB is still fresh in the map
    expect(body.stale).toBe(false);
    expect(body.indices[0]).toMatchObject({ symbol: 'AAA', price: 222 });
    // Now BBB, a second or so old, is the first quote to expire and bounds the list.
    const maxAge = Number(/max-age=(\d+)/.exec(later.headers.get('cache-control'))[1]);
    expect(maxAge).toBeLessThan(240);
    expect(maxAge).toBeGreaterThan(230);
    await clearCache(key);
  });

  it('answers a hit missing its freshness stamp with the 1s floor, since the route TTL is a function', async () => {
    // Every entry cached() writes carries X-Fresh-Until; this guards the
    // fallback for one that does not, where a function ttlS has no digest to be
    // asked with and must not reach the header as source text.
    await clearCache('markets:AAPL');
    await caches.default.put(cacheKey('fresh', 'markets:AAPL'), new Response(
      JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), stale: false, indices: [] }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' } },
    ));
    const res = await call('/markets?symbols=aapl');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=1');
    await clearCache('markets:AAPL');
  });

  it('stays inside the 50-subrequest budget at the worst case: 20 symbols, all needing the fallback', async () => {
    // Free plan: 50 per invocation, fetch() and Cache API match/put counted
    // together. Pinned to the exact tally in the fetchMarkets comment, so a
    // change that spends one more has to update that arithmetic too.
    const want = Array.from({ length: 20 }, (_, i) => `TK${String(i).padStart(2, '0')}`);
    const key = `markets:${[...want].sort().join(',')}`;
    await clearCache(key);
    const calls = stubFetch([
      { match: /range=2d/, body: yahoo(100, 100), times: 20 }, // change 0 → fallback
      { match: /interval=1d/, body: { chart: { result: [{ indicators: { quote: [{ close: [95, 100] }] } }] } }, times: 20 },
    ]);
    const match = vi.spyOn(caches.default, 'match');
    const put = vi.spyOn(caches.default, 'put');
    const res = await call(`/markets?symbols=${want.join(',')}`);
    const spent = calls.length + match.mock.calls.length + put.mock.calls.length;
    match.mockRestore();
    put.mockRestore();
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(40);
    expect(spent).toBe(45);
    expect(spent).toBeLessThan(50);
    await clearCache(key);
  });

  // A quote whose market is closed, fetched `agoS` ago: the next session opens
  // three hours from now, so its life is the 1800s cap (see quoteFreshS).
  const closedQuote = (sym, agoS = 0) => {
    const nowS = Math.floor(Date.now() / 1000);
    return {
      symbol: sym, name: sym, price: 1, change: 0.5, changePct: 1, spark: [], spark2: [], split: 0,
      tradedAt: nowS - agoS - 3 * 3600,
      session: { start: nowS + 3 * 3600, end: nowS + 3 * 3600 + 23_400, gmtoffset: -14400 },
    };
  };

  it('caches a closed market\'s quote until near its next open, capped at 30 minutes', async () => {
    await clearCache('markets:AAPL');
    const nowS = Math.floor(Date.now() / 1000);
    const y = ySym('AAPL');
    Object.assign(y.chart.result[0].meta, {
      regularMarketTime: nowS - 3 * 3600,
      currentTradingPeriod: { regular: { start: nowS + 5 * 3600, end: nowS + 5 * 3600 + 23_400, gmtoffset: -14400 } },
    });
    stubFetch([{ match: /chart\/AAPL/, body: y }]);
    const res = await call('/markets?symbols=aapl');
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${QUOTE_IDLE_MAX_S}`);
    // The quote carries what that was judged from; the card ignores both.
    expect((await res.json()).indices[0]).toMatchObject({ tradedAt: nowS - 3 * 3600, session: { start: nowS + 5 * 3600 } });
    await clearCache('markets:AAPL');
  });

  it('keeps a mixed watchlist only until its FIRST quote expires, not its oldest plus a constant', async () => {
    // AAA: a closed market's quote, fetched 10 min ago, 20 min of life left.
    // BBB: fetched now from a market that is trading, 4 min of life. The list
    // must not hold BBB for AAA's remaining 20 minutes.
    const key = 'markets:AAA,BBB';
    await clearCache(key);
    const t0 = Date.now() - 600_000;
    await seedQuotes({ AAA: { value: closedQuote('AAA', 600), fetchedAt: t0 } });
    const calls = stubFetch([{ match: /chart\/BBB/, body: ySym('BBB') }]);
    const res = await call('/markets?symbols=aaa,bbb');
    const body = await res.json();
    expect(calls).toHaveLength(1); // AAA reused from the map
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control'))[1]);
    expect(maxAge).toBeLessThanOrEqual(QUOTE_ACTIVE_S);
    expect(maxAge).toBeGreaterThan(QUOTE_ACTIVE_S - 10);
    expect(body.updatedAt).toBe(Math.floor(t0 / 1000)); // "as of" is still the oldest quote
    await clearCache(key);

    // Alone, the closed quote's list lives out AAA's own remaining life.
    await clearCache('markets:AAA');
    const alone = await call('/markets?symbols=aaa');
    const aloneAge = Number(/max-age=(\d+)/.exec(alone.headers.get('cache-control'))[1]);
    expect(aloneAge).toBeLessThanOrEqual(1200);
    expect(aloneAge).toBeGreaterThan(1190);
    await clearCache('markets:AAA');
  });
});

// quoteFreshS (markets.js): a quote lives 240s while its market trades and
// until just before the next open (capped at 30 min) while it is closed. The
// session shapes are Yahoo's own: currentTradingPeriod.regular as recorded in
// test/fixtures/yahoo-gspc.json and read live on 2026-09-25 (a Friday).
describe('quote freshness by trading activity', () => {
  const at = (iso) => Date.parse(iso) / 1000;
  const life = (q, iso) => quoteFreshS(q, Date.parse(iso));
  const NY = -14400;
  const NY_FRI = { start: at('2026-09-25T13:30:00Z'), end: at('2026-09-25T20:00:00Z'), gmtoffset: NY };
  const NY_MON = { start: at('2026-09-28T13:30:00Z'), end: at('2026-09-28T20:00:00Z'), gmtoffset: NY };
  const MON_OPEN = NY_MON.start;
  const FRI_CLOSE_PRINT = at('2026-09-25T20:00:05Z');
  const quote = (session, tradedAt) => ({ symbol: '^GSPC', price: 1, session, tradedAt });

  it('carries regularMarketTime and the regular session from the recorded fixture', () => {
    const meta = yahooFx.chart.result[0].meta;
    const q = mapYahooChart(yahooFx, 'S&P 500');
    expect(q.tradedAt).toBe(meta.regularMarketTime);
    expect(q.session).toEqual({
      start: meta.currentTradingPeriod.regular.start,
      end: meta.currentTradingPeriod.regular.end,
      gmtoffset: -14400,
    });
    // Recorded on a Wednesday evening, with Yahoo already naming Thursday's
    // session: five minutes after the last print it still counts as trading,
    // an hour after it the quote may live the full half hour.
    expect(quoteFreshS(q, (meta.regularMarketTime + 300) * 1000)).toBe(QUOTE_ACTIVE_S);
    expect(quoteFreshS(q, (meta.regularMarketTime + 3600) * 1000)).toBe(QUOTE_IDLE_MAX_S);
    // A payload without them (an older quote in the map) is judged trading.
    expect(mapYahooChart({ chart: { result: [{ meta: { symbol: 'X', regularMarketPrice: 1, chartPreviousClose: 1 } }] } }))
      .toMatchObject({ tradedAt: null, session: null });
  });

  it('a trading quote lives 240s, including a 24-hour market and the closing auction', () => {
    expect(QUOTE_ACTIVE_S).toBe(240);
    expect(life(quote(NY_FRI, at('2026-09-25T15:00:00Z')), '2026-09-25T15:00:30Z')).toBe(240);
    const btc = { start: at('2026-09-25T00:00:00Z'), end: at('2026-09-25T23:59:00Z'), gmtoffset: 0 };
    expect(life(quote(btc, at('2026-09-25T13:53:19Z')), '2026-09-25T13:53:30Z')).toBe(240);
    // Past the bell, but the last print is minutes old: still settling.
    expect(life(quote(NY_FRI, FRI_CLOSE_PRINT), '2026-09-25T20:05:00Z')).toBe(240);
  });

  it('Friday\'s close is never served as closed past Monday\'s open, whichever session Yahoo names', () => {
    expect(QUOTE_IDLE_MAX_S).toBe(1800);
    // Friday evening: the full half hour, not a weekend.
    expect(life(quote(NY_FRI, FRI_CLOSE_PRINT), '2026-09-25T20:30:00Z')).toBe(1800);
    for (const session of [NY_FRI, NY_MON]) { // Yahoo not yet rolled over, and rolled
      for (let t = at('2026-09-25T20:16:00Z'); t < MON_OPEN; t += 7 * 60) {
        const l = quoteFreshS(quote(session, FRI_CLOSE_PRINT), t * 1000);
        expect(l).toBeGreaterThanOrEqual(QUOTE_ACTIVE_S);
        expect(l).toBeLessThanOrEqual(QUOTE_IDLE_MAX_S);
        // Gone by the open, or held no longer than a trading quote would be.
        if (l > QUOTE_ACTIVE_S) expect(t + l).toBeLessThanOrEqual(MON_OPEN);
        expect(t + l).toBeLessThanOrEqual(MON_OPEN + QUOTE_ACTIVE_S);
      }
    }
    // Once Monday's session is under way the Friday print is trading data again.
    expect(life(quote(NY_MON, FRI_CLOSE_PRINT), '2026-09-28T13:31:00Z')).toBe(240);
    // Not rolled over: Saturday is idle, Sunday's would-be session hours are
    // judged trading (the price of not knowing which week an exchange keeps),
    // and after them the projection lands on Monday, not Tuesday.
    expect(life(quote(NY_FRI, FRI_CLOSE_PRINT), '2026-09-26T15:00:00Z')).toBe(1800);
    expect(life(quote(NY_FRI, FRI_CLOSE_PRINT), '2026-09-27T15:00:00Z')).toBe(240);
    expect(nextOpenS(NY_FRI, at('2026-09-28T02:00:00Z'))).toBe(MON_OPEN - 3600);
    expect(life(quote(NY_FRI, FRI_CLOSE_PRINT), '2026-09-28T12:00:00Z')).toBe(1800);
  });

  it('a projected session that has opened is trading, not skipped for the next day\'s', () => {
    // Yahoo still names Friday's session on Monday: Monday's open, as projected,
    // has come, so a stale Friday print must not earn the idle half hour.
    const fri = quote(NY_FRI, FRI_CLOSE_PRINT);
    expect(life(fri, '2026-09-28T13:29:00Z')).toBe(240); // inside the projection margin
    expect(life(fri, '2026-09-28T13:30:00Z')).toBe(240); // at the open
    expect(life(fri, '2026-09-28T13:31:00Z')).toBe(240); // just after it
    expect(life(fri, '2026-09-28T17:00:00Z')).toBe(240); // mid-session
    expect(life(fri, '2026-09-28T20:30:00Z')).toBe(240); // an hour's margin past the close
    // Once Monday's session and its margin are over, idle until Tuesday's.
    expect(life(fri, '2026-09-28T21:30:00Z')).toBe(1800);
    expect(nextOpenS(NY_FRI, at('2026-09-28T21:30:00Z'))).toBe(at('2026-09-29T13:30:00Z') - 3600);
    // The session Yahoo names itself, under way, reads as an open already reached.
    expect(nextOpenS(NY_MON, at('2026-09-28T15:00:00Z'))).toBeLessThanOrEqual(at('2026-09-28T15:00:00Z'));
  });

  it('a projected session is trading across a daylight-saving change, either way', () => {
    // Spring-forward: Friday 2027-03-12 opens 14:30Z, closes 21:00Z; Monday
    // 2027-03-15 really opens 13:30Z, closes 20:00Z.
    const spring = quote({ start: at('2027-03-12T14:30:00Z'), end: at('2027-03-12T21:00:00Z'), gmtoffset: -18000 }, at('2027-03-12T21:00:05Z'));
    for (const iso of ['2027-03-15T13:30:00Z', '2027-03-15T14:31:00Z', '2027-03-15T17:00:00Z', '2027-03-15T19:59:00Z']) {
      expect(life(spring, iso)).toBe(240);
    }
    // Fall-back: Friday 2026-10-30 opens 13:30Z, closes 20:00Z; Monday
    // 2026-11-02 really opens 14:30Z, closes 21:00Z. The projection says
    // 13:30Z-20:00Z, so the real session's last hour rides on the margin.
    const fall = quote({ start: at('2026-10-30T13:30:00Z'), end: at('2026-10-30T20:00:00Z'), gmtoffset: -14400 }, at('2026-10-30T20:00:05Z'));
    for (const iso of ['2026-11-02T14:30:00Z', '2026-11-02T14:31:00Z', '2026-11-02T17:00:00Z', '2026-11-02T20:30:00Z', '2026-11-02T20:59:00Z']) {
      expect(life(fall, iso)).toBe(240);
    }
    expect(life(fall, '2026-11-02T21:05:00Z')).toBe(1800);
  });

  it('a Sunday-to-Thursday market reopens on Sunday (Tadawul, 10:00-15:00 local, UTC+3)', () => {
    // Thursday 2026-09-24's session, as Yahoo would still name it on Sunday.
    const thu = { start: at('2026-09-24T07:00:00Z'), end: at('2026-09-24T12:00:00Z'), gmtoffset: 10800 };
    const q = quote(thu, at('2026-09-24T12:00:05Z'));
    const SUN_OPEN = at('2026-09-27T07:00:00Z');
    expect(nextOpenS(thu, at('2026-09-26T12:00:00Z'))).toBe(SUN_OPEN - 3600); // Saturday: Sunday, not Monday
    expect(life(q, '2026-09-26T12:00:00Z')).toBe(1800);
    expect(life(q, '2026-09-27T05:00:00Z')).toBe(1800); // gone by 05:30Z, before the open
    expect(life(q, '2026-09-27T06:55:00Z')).toBe(240); // five minutes before the open
    expect(life(q, '2026-09-27T07:05:00Z')).toBe(240);
    // Its would-be Friday session hours are judged trading: the cost of
    // keeping no exchange table, paid on the fresh side.
    expect(life(q, '2026-09-25T09:00:00Z')).toBe(240);
  });

  it('projects across a daylight-saving change without landing after the real open', () => {
    // Friday 2027-03-12 New York opens 14:30Z (EST); Monday 2027-03-15, after
    // spring-forward, 13:30Z. A Friday session projected by whole days says
    // 14:30Z Monday: an hour late, which the projection margin absorbs.
    const fri = { start: at('2027-03-12T14:30:00Z'), end: at('2027-03-12T21:00:00Z'), gmtoffset: -18000 };
    const realOpen = at('2027-03-15T13:30:00Z');
    // Each fetch is more than a trading quote's life before the real open, so
    // each must be gone by it.
    for (const iso of ['2027-03-15T11:00:00Z', '2027-03-15T12:45:00Z', '2027-03-15T13:05:00Z']) {
      const l = life(quote(fri, at('2027-03-12T21:00:05Z')), iso);
      expect(l).toBeGreaterThanOrEqual(QUOTE_ACTIVE_S);
      expect(at(iso) + l).toBeLessThanOrEqual(realOpen);
    }
    // Friday evening, the same projection still earns the full half hour.
    expect(life(quote(fri, at('2027-03-12T21:00:05Z')), '2027-03-12T22:00:00Z')).toBe(QUOTE_IDLE_MAX_S);
  });

  it('projects the next open when Yahoo still names the finished session (Tokyo, live 2026-09-25)', () => {
    // 13:52Z Friday, seven hours after Tokyo closed, the session read Friday's.
    const tokyo = { start: at('2026-09-25T00:00:00Z'), end: at('2026-09-25T06:30:00Z'), gmtoffset: 32400 };
    // Saturday is skipped; Sunday stays a possible session day (see nextOpenS),
    // so the projection is Sunday's 00:00Z, less the margin.
    expect(nextOpenS(tokyo, at('2026-09-25T13:52:00Z'))).toBe(at('2026-09-27T00:00:00Z') - 3600);
    expect(life(quote(tokyo, at('2026-09-25T06:45:03Z')), '2026-09-25T13:52:00Z')).toBe(1800);
    // A session Yahoo already names as next is taken as stated, less a minute.
    expect(nextOpenS(NY_MON, at('2026-09-26T12:00:00Z'))).toBe(MON_OPEN - 60);
  });

  it('a quote that cannot say enough is judged trading, and an unforeseeable open gets 900s', () => {
    expect(life({ symbol: 'OLD' }, '2026-09-26T12:00:00Z')).toBe(QUOTE_ACTIVE_S); // from before these fields
    expect(life(quote(null, null), '2026-09-26T12:00:00Z')).toBe(QUOTE_ACTIVE_S);
    expect(life(quote(null, at('2026-09-25T20:00:05Z')), '2026-09-26T12:00:00Z')).toBe(QUOTE_UNKNOWN_OPEN_S);
    expect(QUOTE_UNKNOWN_OPEN_S).toBe(900);
  });
});

describe('/path/realtime', () => {
  const RIDEPATH = {
    results: [
      {
        consideredStation: '33S',
        destinations: [
          {
            label: 'ToNJ',
            messages: [
              { target: '33S', secondsToArrival: '120', arrivalTimeMessage: '2 min', lineColor: 'FF9900', headSign: 'Journal Square', lastUpdated: '2026-07-03T20:04:57-04:00' },
              { target: '33S', secondsToArrival: '45', arrivalTimeMessage: '0 min', lineColor: '4D92FB,FF9900', headSign: 'Hoboken', lastUpdated: '2026-07-03T20:04:57-04:00' },
            ],
          },
          { label: 'ToNY', messages: [] },
        ],
      },
    ],
  };
  beforeEach(() => clearCache('path'));

  it('maps the feed into a per-station, per-direction digest with projected epochs', () => {
    const digest = mapRidePath(RIDEPATH, 1000);
    const st = digest.stations['33S'];
    expect(st.ToNY).toEqual([]);
    expect(st.ToNJ).toHaveLength(2);
    // Sorted by projected time: the 45 s Hoboken train first.
    expect(st.ToNJ[0]).toEqual({ t: 1045, headSign: 'Hoboken', lineColors: ['4D92FB', 'FF9900'] });
    expect(st.ToNJ[1]).toEqual({ t: 1120, headSign: 'Journal Square', lineColors: ['FF9900'] });
  });

  it('drops malformed rows and bad colors instead of failing', () => {
    const digest = mapRidePath({ results: [{ consideredStation: 'WTC', destinations: [{ label: 'ToNJ', messages: [
      { secondsToArrival: 'soon', headSign: 'Newark', lineColor: 'D93A30' },
      { secondsToArrival: '60', headSign: 'Newark', lineColor: 'red;evil' },
    ] }] }] }, 0);
    expect(digest.stations.WTC.ToNJ).toEqual([{ t: 60, headSign: 'Newark', lineColors: [] }]);
  });

  it('serves and caches the digest', async () => {
    const calls = stubFetch([{ match: /ridepath\.json/, body: RIDEPATH }]);
    const res = await call('/path/realtime');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stations['33S'].ToNJ).toHaveLength(2);
    const before = calls.length;
    await call('/path/realtime'); // Cache API hit inside the 90 s TTL
    expect(calls.length).toBe(before);
  });
});

describe('/ferry/departures', () => {
  const { FeedMessage } = GtfsRt.transit_realtime;
  const FERRY_BUF = FeedMessage.encode(
    FeedMessage.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1783123914 },
      entity: [
        { id: '1', tripUpdate: { trip: { tripId: '52' }, stopTimeUpdate: [
          { stopId: '88', departure: { time: 1783123756 } },
          { stopId: '118', arrival: { time: 1783126301 } },
        ] } },
        { id: '2', tripUpdate: { trip: { tripId: '96' }, stopTimeUpdate: [] } }, // no stops -> dropped
      ],
    }),
  ).finish();
  beforeEach(() => clearCache('ferry'));

  it('decodes the protobuf and returns a JSON trip digest', async () => {
    stubFetch([{ match: /gtfsrealtime\.aspx/, body: FERRY_BUF, raw: true }]);
    const res = await call('/ferry/departures');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updatedAt).toBe(1783123914);
    expect(body.trips).toEqual([
      { tripId: '52', stops: [{ stopId: '88', t: 1783123756 }, { stopId: '118', t: 1783126301 }] },
    ]);
  });

  it('mapFerryFeed prefers departure over arrival and drops timeless stops', () => {
    const out = mapFerryFeed({ timestamp: null, trips: [
      { tripId: '9', routeId: '', stops: [
        { stopId: '4', arrival: 100, departure: 110 },
        { stopId: '8', arrival: null, departure: null },
      ] },
    ] }, 500);
    expect(out.updatedAt).toBe(500); // header timestamp fallback
    expect(out.trips).toEqual([{ tripId: '9', stops: [{ stopId: '4', t: 110 }] }]);
  });
});

describe('/posts/substack', () => {
  const SUB = [
    { title: 'The AI Superforecasters', subtitle: 'Are here', canonical_url: 'https://acx.substack.com/p/the-ai-superforecasters', post_date: '2026-07-02T12:00:00.000Z' },
    { title: 'Untitled draftish', subtitle: null, canonical_url: 'javascript:alert(1)', post_date: null },
  ];
  beforeEach(() => clearCache('sub:acx'));
  it('digests the publication API', async () => {
    stubFetch([{ match: /acx\.substack\.com\/api\/v1\/posts/, body: SUB }]);
    const res = await call('/posts/substack?pub=acx');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.posts[0]).toEqual({ title: 'The AI Superforecasters', subtitle: 'Are here', url: 'https://acx.substack.com/p/the-ai-superforecasters', t: Math.floor(Date.parse('2026-07-02T12:00:00.000Z') / 1000) });
    expect(body.posts[1].t).toBe(0);
    expect(body.posts[1].url).toBe(''); // non-http(s) canonical_url rejected (no js: in the QR)
    expect(mapSubstackPosts(null).posts).toEqual([]);
  });
  it('rejects bad slugs', async () => {
    expect((await call('/posts/substack?pub=Not%20A%20Slug')).status).toBe(400);
    expect((await call('/posts/substack')).status).toBe(400);
  });
});

describe('/icloud/album', () => {
  const WS = { photos: [
    { photoGuid: 'g1', dateCreated: '2026-02-24T12:00:00Z', caption: 'Beach', width: '2049', height: '1537',
      derivatives: { 342: { checksum: 'cA', fileSize: '41233', width: '342', height: '257' },
                     2049: { checksum: 'cB', fileSize: '660318', width: '2049', height: '1537' } } },
    { photoGuid: 'g2', dateCreated: '2026-03-01T09:00:00Z', caption: '', width: '2049', height: '2049',
      derivatives: { 2049: { checksum: 'cC', fileSize: '9000000', width: '2049', height: '2049' } } },
  ] };
  const AU = { items: {
    cB: { url_location: 'cvws.icloud-content.com', url_path: '/S/x/1.JPG?a=1' },
    cA: { url_location: 'cvws.icloud-content.com', url_path: '/S/x/1t.JPG?a=1' },
  } };

  it('maps to newest-first photos, largest derivative under the byte cap, joined URLs', () => {
    const out = mapIcloudAlbum(WS, AU, 3_000_000);
    expect(out.photos).toHaveLength(1);
    expect(out.photos[0]).toEqual({
      url: 'https://cvws.icloud-content.com/S/x/1.JPG?a=1',
      w: 2049, h: 1537, ar: expect.closeTo(1.333, 2), caption: 'Beach', date: '2026-02-24T12:00:00Z',
    });
  });

  it('rejects a bad token at the route', async () => {
    expect((await call('/icloud/album?token=short')).status).toBe(400);
    expect((await call('/icloud/album')).status).toBe(400);
  });

  it('follows the 330 partition redirect and returns the digest', async () => {
    stubFetch([
      { match: /p\d+-sharedstreams.*webstream/, status: 330, body: { 'X-Apple-MMe-Host': 'p110-sharedstreams.icloud.com' } },
      { match: /p110-sharedstreams.*webstream/, body: WS },
      { match: /p110-sharedstreams.*webasseturls/, body: AU },
    ]);
    await clearCache('icloud:B1m5fk75vLWwX');
    const res = await call('/icloud/album?token=B1m5fk75vLWwX');
    expect(res.status).toBe(200);
    expect((await res.json()).photos).toHaveLength(1);
  });
});

describe('bus legs', () => {
  it('parses stopId:lineRef pairs (decoded)', () => {
    expect(parseLegs('550789:MTABC_QM24,504123:MTA%20NYCT_X27')).toEqual([
      { stopId: '550789', lineRef: 'MTABC_QM24' },
      { stopId: '504123', lineRef: 'MTA NYCT_X27' }]);
    expect(parseLegs('')).toEqual([]);
  });
  it('caps at 2 legs even when more are supplied', () => {
    const result = parseLegs('1:A,2:B,3:C');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ stopId: '1', lineRef: 'A' });
    expect(result[1]).toEqual({ stopId: '2', lineRef: 'B' });
  });
  it('builds a StopMonitoring URL with a LineRef filter', () => {
    const u = siriUrl('KEY', { stopId: '550789', lineRef: 'MTA NYCT_X27' });
    expect(u).toContain('MonitoringRef=550789');
    expect(u).toContain('LineRef=MTA%20NYCT_X27');
    expect(u).toContain('key=KEY');
  });
});

import { mapGdriveAlbum } from '../../worker/src/gdrive.js';
import gdriveFixture from './fixtures/gdrive-files.json';

describe('mapGdriveAlbum', () => {
  it('maps the drive listing to the photo digest', () => {
    const out = mapGdriveAlbum(gdriveFixture);
    expect(out.photos).toHaveLength(3); // no-thumb + no-dims entries skipped
    expect(out.photos[0]).toEqual({
      url: 'https://lh3.googleusercontent.com/drive-storage/FAKE1=s2048',
      w: 2000, h: 1123, ar: 1.781, caption: '', date: '2026-07-09T18:00:00.000Z',
    });
    expect(out.photos[1].url).toContain('FAKE2=s2048');
    expect(out.photos[2].url).toContain('FAKE5=s2048');
    // Drive has no real captions, only filenames — never show those on a board.
    expect(out.photos.every((p) => p.caption === '')).toBe(true);
  });
  it('caps at 60 and preserves the API order (already newest-first)', () => {
    const many = { files: Array.from({ length: 80 }, (_, i) => ({
      name: `p${i}.jpg`, mimeType: 'image/jpeg', createdTime: `t${i}`,
      thumbnailLink: `https://lh3.example/x${i}=s220`, imageMediaMetadata: { width: 100, height: 100 } })) };
    const out = mapGdriveAlbum(many);
    expect(out.photos).toHaveLength(60);
    expect(out.photos[0].url).toContain('x0=s2048');
  });
});

describe('/gdrive/album route', () => {
  const FOLDER = '1RHow60mcBwzMturimQSbziK3hqCvP2lz';
  it('503s without GDRIVE_KEY', async () => {
    const res = await call(`/gdrive/album?folder=${FOLDER}`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('gdrive_not_configured');
  });
  it('400s on a malformed folder id', async () => {
    const res = await call('/gdrive/album?folder=nope!', undefined, { GDRIVE_KEY: 'k' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_folder');
  });
  it('serves the digest from the listing (key + ordering on the wire)', async () => {
    await clearCache(`gdrive:${FOLDER}`);
    const calls = stubFetch([{ match: /googleapis\.com\/drive\/v3\/files/, body: gdriveFixture }]);
    const res = await call(`/gdrive/album?folder=${FOLDER}`, undefined, { GDRIVE_KEY: 'testkey' });
    expect(res.status).toBe(200);
    const digest = await res.json();
    expect(digest.photos).toHaveLength(3);
    expect(digest.photos[0].url).toContain('=s2048');
    expect(calls[0]).toContain('key=testkey');
    expect(calls[0]).toContain('orderBy=createdTime');
  });
});

import { mapStatuspage, mapSlack, mapGoogle, mapWebex, mapAws } from '../../worker/src/svcstatus.js';
import { mapM365, mapM365Consumer, mapM365Mirror, mapM365Graph, mendServiceStatuses } from '../../worker/src/svcstatus.js';
import spOk from './fixtures/svc-statuspage-ok.json';
import spBad from './fixtures/svc-statuspage-degraded.json';
import slackFx from './fixtures/svc-slack.json';
import claudeFx from './fixtures/svc-claude.json';
import openaiFx from './fixtures/svc-openai.json';
// Both halves of the Microsoft row, recorded live 2026-08-02. The consumer feed
// was all-green that day; the mirror caught a real multi-workload incident
// (Exchange, Teams and the M365 suite degraded, Purview investigating), which
// is why the degraded cases below are fixture-driven rather than invented.
import m365Fx from './fixtures/svc-m365.json';
import m365MirrorFx from './fixtures/svc-m365-mirror.json';
// The mirror is only believed for 6 hours, so every test that wants it BELIEVED
// must reckon from the moment it was generated, not from the wall clock.
const MIRROR_NOW = Date.parse(m365MirrorFx.generated_at) + 60e3;
// The recorded mirror's four open issues are all ADVISORIES, which is what
// Microsoft's backlog genuinely looks like on an ordinary day (measured
// 2026-08-27: 14 of 15 open, oldest 58 days). Only incidents set the row's
// state now, so a test about the core/non-core rule promotes them first,
// keeping that rule's coverage independent of the classification split below.
const mirrorAllIncidents = () => ({
  ...m365MirrorFx,
  issues: m365MirrorFx.issues.map((i) => ({ ...i, classification: 'incident' })),
});
// The optional third source: a tenant's OWN Graph healthOverviews answer. This
// one is HAND-BUILT from Microsoft's reference docs, not recorded — the repo
// ships no credentials to record with (its _provenance field says so too). It
// deliberately disagrees with the mirror: Teams is degraded there and healthy
// here, which is how the tests below tell which source spoke.
import m365GraphFx from './fixtures/svc-m365-graph.json';
const greenGraph = () => ({
  ...m365GraphFx,
  value: m365GraphFx.value.map((r) => ({ ...r, status: 'ServiceOperational', issues: [] })),
});
import googleFx from './fixtures/svc-google.json';
import webexFx from './fixtures/svc-webex.json';
import awsFx from './fixtures/svc-aws.json';
import { decodeBomJson } from '../../worker/src/svcstatus.js';
import { htmlToText } from '../../worker/src/htmltext.js';

describe('htmlToText (feed markup -> readable text)', () => {
  it('turns <p> into paragraph breaks and <br> into line breaks', () => {
    expect(htmlToText('<p>first</p><p>second</p>')).toBe('first\n\nsecond');
    expect(htmlToText('one<br>two<br/>three')).toBe('one\ntwo\nthree');
  });
  it('strips nested and unknown tags, keeping the words', () => {
    expect(htmlToText('<div><span class="x">A <b>bold</b> <em>word</em></span></div>')).toBe('A bold word');
    expect(htmlToText('<madeup data-x="1">text</madeup>')).toBe('text');
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('one\ntwo');
    expect(htmlToText('<script>alert(1)</script>after')).toBe('after');
  });
  it('decodes entities (named, decimal, hex) and leaves unknown refs alone', () => {
    expect(htmlToText('Tom &amp; Jerry &mdash; &quot;quoted&quot; &#39;apos&#39; &#x27;hex&#x27;'))
      .toBe('Tom & Jerry — "quoted" \'apos\' \'hex\'');
    // A named ref needs its semicolon, so a bare ampersand in prose survives.
    expect(htmlToText('AT&T and R&D')).toBe('AT&T and R&D');
    // Feeds that entity-ENCODE their markup are only strippable after a decode.
    expect(htmlToText('&lt;p&gt;encoded markup&lt;/p&gt;')).toBe('encoded markup');
  });
  it('collapses whitespace and trims, but leaves plain text alone', () => {
    expect(htmlToText('All systems operational')).toBe('All systems operational');
    expect(htmlToText('**Gmail delays**\nmore detail')).toBe('**Gmail delays**\nmore detail');
    expect(htmlToText('  <p>  padded   text  </p>  ')).toBe('padded text');
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
    expect(htmlToText(null)).toBe('');
  });
  it('leaves arithmetic prose intact (a bare < is not a tag)', () => {
    expect(htmlToText('latency a < b and c > d')).toBe('latency a < b and c > d');
  });

  // The sanitizer's LAST operation has to be the strip. When it was the decode,
  // this payload walked straight out the other side: pass 0 decoded the
  // once-encoded <p> (keeping the loop alive) and half-decoded the rest, pass 1
  // stripped the <p> and then decoded "&lt;script&gt;" into a live tag with no
  // strip behind it — htmlToText returned "<script>alert(1)</script>" verbatim.
  it('never returns a tag, even when the encoding depths are mixed', () => {
    const out = htmlToText('&lt;p&gt;&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
    expect(out).not.toMatch(/<\/?[a-z]/i);
    expect(out).not.toContain('alert(1)'); // the whole script element is gone, not just its tags
  });

  it('keeps stripping as each encoding layer peels off (triple-encoded markup)', () => {
    // Live tags wrapping once-encoded tags wrapping twice-encoded tags: three
    // decode/strip rounds, and the words in the middle survive all of them.
    expect(htmlToText('<p>&lt;b&gt;&amp;lt;i&amp;gt;deep&amp;lt;/i&amp;gt;&lt;/b&gt;</p>')).toBe('deep');
  });

  it('terminates on adversarially nested encoding, and still hands back no tag', () => {
    // Twelve layers, each one escaping the last. The pass cap stops the work;
    // what it stops on is text whose remaining markup is still ENCODED (inert),
    // never a tag the board would have to print.
    let deep = 'x';
    for (let i = 0; i < 12; i += 1) {
      deep = `<b>${deep.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>`;
    }
    const out = htmlToText(deep);
    expect(out).not.toMatch(/<\/?[a-z]/i);
    expect(out).toContain('&lt;b&gt;'); // the surviving layers stayed encoded
  });

  // The encoded twin above was covered; the RAW one was not. Stripping a tag
  // splices its neighbours into a new one, so "<<<<script>script>script>script>"
  // sheds one layer per sweep, and the sweep cap is three. The fourth layer
  // walked out as a whole <script>, which is the same latent hole as the old
  // decode-last ordering: a renderer that ever trusted "the vm stores plain
  // text" would be handed executable markup.
  it('hands back no tag when raw splice-nesting outlasts the sweep cap', () => {
    for (let depth = 1; depth <= 8; depth += 1) {
      const out = htmlToText('<'.repeat(depth) + 'script>'.repeat(depth) + 'alert(1)');
      expect(out, `depth ${depth}`).not.toMatch(/<\/?[a-z][a-z0-9]*[^>]*>/i);
    }
  });

  it('leaves a lone "<" that no tag could open with alone', () => {
    // The neutralizer only fires on text that still holds a WHOLE tag, so
    // arithmetic prose and the half-spliced leftovers keep their characters.
    expect(htmlToText('latency a < b')).toBe('latency a < b');
    expect(htmlToText('&lt;&lt;p&gt;p&gt;')).toBe('<\n\np>');
  });
});

// The bug from the board: Slack publishes incident notes as HTML, the widget
// escapes at render, so the tags printed literally in the full-screen reader.
describe('service status adapters: HTML-bodied feeds render as text', () => {
  it('slack: the live "receipt of emails" incident round-trips to clean text', () => {
    const out = mapSlack({
      status: 'active',
      active_incidents: [{
        id: 1533,
        date_created: '2026-07-27T22:13:00-07:00',
        title: 'Feature Degradation Affecting the Receipt of Emails in Slack',
        type: 'incident',
        notes: [{
          body: '<p>We&#39;re currently investigating an issue affecting the receipt of emails in Slack. '
            + 'Some messages sent to a Slack email address may not arrive.</p>'
            + '<p>We&#39;ll share an update as soon as we know more. Thanks for your patience!</p>',
        }],
      }],
    });
    expect(out.state).toBe('minor');
    expect(out.incidents[0].title).toBe('Feature Degradation Affecting the Receipt of Emails in Slack');
    expect(out.incidents[0].update).toBe(
      "We're currently investigating an issue affecting the receipt of emails in Slack. "
      + 'Some messages sent to a Slack email address may not arrive.\n\n'
      + "We'll share an update as soon as we know more. Thanks for your patience!",
    );
    // Nothing tag-shaped or entity-shaped survives into the vm.
    expect(out.incidents[0].update).not.toMatch(/[<>]|&#|&amp;/);
    expect(out.note).not.toMatch(/[<>]/);
  });
  it('statuspage: HTML title, note and body all arrive as text', () => {
    const out = mapStatuspage({
      status: { indicator: 'minor', description: 'Partially Degraded Service &mdash; API' },
      incidents: [{
        name: 'Elevated <b>error rates</b> on the API',
        started_at: '2026-07-27T10:00:00Z',
        incident_updates: [{ body: '<p>We&#39;re investigating.</p><p>Next update in 30 minutes.</p>' }],
      }],
    });
    expect(out.note).toBe('Partially Degraded Service — API');
    expect(out.incidents[0].title).toBe('Elevated error rates on the API');
    expect(out.incidents[0].update).toBe("We're investigating.\n\nNext update in 30 minutes.");
  });
  it('microsoft / webex / aws: names, messages and summaries are sanitized too', () => {
    const ms = mapM365([{
      ServiceDisplayName: 'Outlook<i>.com</i>', Status: 'Service degradation',
      Title: 'Mail delays', Message: '<p>Mailbox access is degraded.</p><p>Mitigation in progress.</p>',
    }], null, Date.now());
    expect(ms.note).toBe('Outlook.com: service degradation');
    expect(ms.incidents[0].title).toBe('Outlook.com: service degradation');
    expect(ms.incidents[0].update).toBe('Mailbox access is degraded.\n\nMitigation in progress.');

    const wx = mapWebex({ unResolvedIncidents: [{ incidentName: 'Meetings <b>join</b> failures', impact: 'major', createTime: 'x' }] });
    expect(wx.note).toBe('Meetings join failures');
    expect(wx.incidents[0].title).toBe('Meetings join failures');

    const nowMs = Date.now();
    const aws = mapAws([{
      date: String(Math.floor(nowMs / 1000)), region_name: 'US East (N. Virginia)', service_name: 'Amazon EC2',
      summary: '<span class="yellowfont">Increased Error Rates</span>',
      event_log: [{ message: 'We are investigating increased error rates.<br>Updates to follow.' }],
    }], nowMs);
    expect(aws.note).toBe('Amazon EC2: Increased Error Rates');
    expect(aws.incidents[0].title).toBe('Amazon EC2 (US East (N. Virginia)): Increased Error Rates');
    expect(aws.incidents[0].update).toBe('We are investigating increased error rates.\nUpdates to follow.');
  });
  it('google: an HTML-wrapped update still yields a clean first line', () => {
    const out = mapGoogle([{ begin: '2026-07-27T00:00:00Z', external_desc: '<p>**Gmail delays**</p><p>We are investigating.</p>' }], Date.now());
    expect(out.note).toBe('Gmail delays');
    // Google's own markdown emphasis is left as it always was (firstLine drops
    // it for the one-line note); only the HTML wrapper is removed here.
    expect(out.incidents[0].update).toBe('**Gmail delays**\n\nWe are investigating.');
  });
  it('sanitizes before the 500-char clamp, so the budget buys real words', () => {
    const body = `<p>${'x'.repeat(400)}</p><p>${'y'.repeat(400)}</p>`;
    const out = mapStatuspage({ status: { indicator: 'minor' }, incidents: [{ name: 'n', incident_updates: [{ body }] }] });
    expect(out.incidents[0].update).toHaveLength(500);
    expect(out.incidents[0].update.startsWith('x'.repeat(400))).toBe(true);
  });
});

describe('service status adapters', () => {
  it('statuspage: ok and degraded (live Cloudflare sample)', () => {
    expect(mapStatuspage(spOk).state).toBe('ok');
    const bad = mapStatuspage(spBad);
    expect(bad.state).toBe('minor');
    expect(bad.note).toBe('Minor Service Outage');
    expect(bad.incidents.length).toBeGreaterThan(0);
    expect(bad.incidents[0].title.length).toBeGreaterThan(0);
    expect(bad.incidents[0].update.length).toBeLessThanOrEqual(500);
  });
  it('slack: ok fixture, synthesized outage is major', () => {
    expect(mapSlack(slackFx).state).toBe('ok');
    const out = mapSlack({ status: 'active', active_incidents: [{ title: 'API errors', type: 'outage', date_created: 'x', notes: [{ body: 'working on it' }] }] });
    expect(out.state).toBe('major');
    expect(out.incidents[0].update).toBe('working on it');
  });
  it('m365 consumer: all-operational fixture is ok, a degraded row names the service', () => {
    expect(mapM365Consumer(m365Fx).state).toBe('ok');
    const out = mapM365Consumer([
      { ServiceDisplayName: 'Outlook.com', Status: 'Service degradation', Title: '', Message: 'Mail is slow.' },
      { ServiceDisplayName: 'OneDrive', Status: 'Operational', Title: '', Message: '' },
    ]);
    expect(out.state).toBe('minor');
    expect(out.note).toBe('Outlook.com: service degradation');
    expect(out.incidents).toHaveLength(1); // only the degraded workload
  });

  it('m365 mirror: core workloads set the state, back-office ones only add incidents', () => {
    // The recorded incident: Exchange, Teams and the M365 suite degraded (all
    // core), Defender and Purview also unhappy (neither is core).
    const out = mapM365Mirror(mirrorAllIncidents(), MIRROR_NOW);
    expect(out.state).toBe('minor');
    expect(out.note).toBe('Exchange Online: service degradation');
    // Every degraded workload is listed, core or not, so the ledger shows the
    // whole picture even though only the core ones coloured the row.
    const titles = out.incidents.map((i) => i.title);
    expect(titles).toContain('Exchange Online: service degradation');
    expect(titles).toContain('Microsoft Defender XDR: service degradation'); // non-core
    expect(titles).toContain('Microsoft Purview: investigating');
    expect(titles.some((t) => t.startsWith('SharePoint Online'))).toBe(false); // operational
    // The workload the NOTE names must be the first thing a tap reveals, and
    // the back-office ones sink below the core ones a reader came to check.
    expect(titles[0]).toBe('Exchange Online: service degradation');
    const lastCore = Math.max(titles.indexOf('Exchange Online: service degradation'),
      titles.indexOf('Microsoft Teams: service degradation'));
    expect(titles.indexOf('Microsoft Purview: investigating')).toBeGreaterThan(lastCore);
    expect(titles.indexOf('Microsoft Defender XDR: service degradation')).toBeGreaterThan(lastCore);
    // Prose and start time come from the matching open issue.
    const exchange = out.incidents.find((i) => i.title.startsWith('Exchange Online'));
    expect(exchange.since).toBe(m365MirrorFx.issues.find((i) => i.service === 'Exchange Online').start_time);
    expect(exchange.feature).toBe('Performance degradation'); // Microsoft's own feature name rides along
    expect(exchange.update.length).toBeGreaterThan(0);
  });

  it('m365 mirror: a degraded NON-core workload alone leaves the row green', () => {
    const backOfficeOnly = {
      ...m365MirrorFx,
      services: m365MirrorFx.services.map((s) => (
        s.service === 'Microsoft Defender XDR' ? s : { ...s, status: 'serviceOperational' })),
    };
    const out = mapM365Mirror(backOfficeOnly, MIRROR_NOW);
    expect(out.state).toBe('ok'); // Defender is not something the office feels
    expect(out.incidents.map((i) => i.title)).toEqual(['Microsoft Defender XDR: service degradation']);
  });

  it('m365 mirror: serviceInterruption on a core workload is major', () => {
    const down = {
      ...m365MirrorFx,
      services: m365MirrorFx.services.map((s) => (
        s.service === 'Microsoft Teams' ? { ...s, status: 'serviceInterruption' } : s)),
    };
    const out = mapM365Mirror(down, MIRROR_NOW);
    expect(out.state).toBe('major');
    expect(out.note).toBe('Microsoft Teams: service interruption');
  });

  it('m365 mirror: stale or unparsable generated_at makes the source ABSENT, never green', () => {
    // Six hours is several missed publishing runs. A frozen copy must not claim
    // the outage that started after it is not happening.
    expect(mapM365Mirror(m365MirrorFx, MIRROR_NOW + 7 * 3600e3)).toBeNull();
    expect(mapM365Mirror({ ...m365MirrorFx, generated_at: 'not a date' }, MIRROR_NOW)).toBeNull();
    expect(mapM365Mirror({ ...m365MirrorFx, generated_at: undefined }, MIRROR_NOW)).toBeNull();
    // ...and an absent mirror does not drag the row down: the consumer half
    // still answers on its own.
    const composed = mapM365(m365Fx, m365MirrorFx, MIRROR_NOW + 7 * 3600e3);
    expect(composed.state).toBe('ok');
    expect(composed.note).toBe('All systems operational');
  });

  it('m365: schema confusion makes a source absent, and unknown is never blank', () => {
    // The two feeds have OPPOSITE top-level shapes (consumer is an array, mirror
    // is an object). Handed the wrong one, each must decline rather than guess.
    expect(mapM365Consumer(m365MirrorFx)).toBeNull(); // object where an array belongs
    expect(mapM365Mirror(m365Fx, MIRROR_NOW)).toBeNull(); // array where an object belongs
    expect(mapM365Consumer([])).toBeNull();
    expect(mapM365Consumer([{ nothing: 'recognizable' }])).toBeNull();
    // Both gone: unknown, and it always SAYS why (a blank note drew an empty
    // amber line on the card).
    const dead = mapM365(null, null, Date.now());
    expect(dead).toMatchObject({ state: 'unknown', note: 'Status unavailable', incidents: [] });
    expect(mapM365({ Services: [] }, 'garbage', Date.now()).note).toBe('Status unavailable');
  });

  it('m365: the composed row takes the WORST of the two halves and both sets of incidents', () => {
    const consumerDown = [
      { ServiceDisplayName: 'Outlook.com', Status: 'Service interruption', Title: '', Message: 'Cannot sign in.' },
    ];
    // Mirror says minor (degradation), consumer says major (interruption).
    const out = mapM365(consumerDown, mirrorAllIncidents(), MIRROR_NOW);
    expect(out.state).toBe('major');
    expect(out.note).toBe('Outlook.com: service interruption'); // the more severe finding speaks
    expect(out.incidents.some((i) => i.title.startsWith('Outlook.com'))).toBe(true);
    expect(out.incidents.some((i) => i.title.startsWith('Exchange Online'))).toBe(true);
    expect(out.incidents.length).toBeLessThanOrEqual(6);

    // Equal severity: the enterprise half wins the note, because the workload an
    // office actually feels is the more useful sentence to put on the wall.
    const consumerMinor = [
      { ServiceDisplayName: 'Outlook.com', Status: 'Service degradation', Title: '', Message: '' },
    ];
    expect(mapM365(consumerMinor, mirrorAllIncidents(), MIRROR_NOW).note).toBe('Exchange Online: service degradation');

    // All green on both halves reads as one plain sentence, not a service name.
    const allGood = mapM365(m365Fx, {
      ...m365MirrorFx,
      services: m365MirrorFx.services.map((s) => ({ ...s, status: 'serviceOperational' })),
    }, MIRROR_NOW);
    expect(allGood).toMatchObject({ state: 'ok', note: 'All systems operational' });
  });

  // ---- Microsoft's advisory/incident split (Sean's pick 2026-08-27) ----
  // The row used to read amber more or less forever, because Microsoft keeps a
  // standing backlog of long-running low-impact advisories and we graded them
  // like live outages. serviceHealthIssue.classification is Microsoft's own
  // answer to which is which, and only 'incident' colours the row now.

  it('m365 advisories: a workload whose only open issues are advisories leaves the row green', () => {
    // The recorded fixture as-is: four open issues, every one an advisory.
    const out = mapM365Mirror(m365MirrorFx, MIRROR_NOW);
    expect(out.state).toBe('ok');
    expect(out.note).toBe('All systems operational');
    // Green, but not silent: the backlog is still there for the tap to show,
    // carrying Microsoft's own feature name and the date it opened.
    const services = out.advisories.map((a) => a.service);
    expect(services).toContain('Exchange Online');
    expect(services).toContain('Microsoft Teams');
    expect(out.advisories.find((a) => a.service === 'Microsoft Teams')).toMatchObject({
      feature: 'Teams and Channels', since: '2026-06-30T07:00:00+00:00',
    });
    // ...and it must not be smuggled into the incident list.
    expect(out.incidents.some((i) => i.title.startsWith('Exchange Online'))).toBe(false);
  });

  it('m365 advisories: one incident among advisories still colours the workload', () => {
    const mixed = {
      ...m365MirrorFx,
      issues: m365MirrorFx.issues.map((i) => (
        i.service === 'Exchange Online' ? { ...i, classification: 'incident' } : i)),
    };
    const out = mapM365Mirror(mixed, MIRROR_NOW);
    expect(out.state).toBe('minor');
    expect(out.note).toBe('Exchange Online: service degradation');
    // Teams and the suite are advisory-only, so they leave the incident list.
    expect(out.incidents.map((i) => i.title)).toContain('Exchange Online: service degradation');
    expect(out.advisories.map((a) => a.service)).toContain('Microsoft Teams');
  });

  it('m365 advisories: an unrecognized classification is an INCIDENT, never green', () => {
    // A status board must never fake green: a missing value, a word Microsoft
    // adds later, and the documented 'unknownFutureValue' all report.
    for (const classification of [undefined, null, '', 'unknownFutureValue', 'somethingNew']) {
      const odd = {
        ...m365MirrorFx,
        issues: m365MirrorFx.issues.map((i) => (
          i.service === 'Exchange Online' ? { ...i, classification } : i)),
      };
      expect(mapM365Mirror(odd, MIRROR_NOW).state).toBe('minor');
    }
    // Only the literal word buys silence, and casing does not matter (Graph
    // serves it PascalCase live and camelCase in its docs).
    for (const classification of ['advisory', 'Advisory']) {
      const quiet = {
        ...m365MirrorFx,
        issues: m365MirrorFx.issues.map((i) => ({ ...i, classification })),
      };
      expect(mapM365Mirror(quiet, MIRROR_NOW).state).toBe('ok');
    }
  });

  it('m365 advisories: a MAJOR workload is never hushed by its classification', () => {
    // serviceInterruption means users cannot reach the service. No advisory
    // label outranks that.
    const down = {
      ...m365MirrorFx,
      services: m365MirrorFx.services.map((s) => (
        s.service === 'Microsoft Teams' ? { ...s, status: 'serviceInterruption' } : s)),
    };
    const out = mapM365Mirror(down, MIRROR_NOW);
    expect(out.state).toBe('major');
    expect(out.note).toBe('Microsoft Teams: service interruption');
    expect(out.advisories.some((a) => a.service === 'Microsoft Teams')).toBe(false);
  });

  it('m365 advisories: the composed row caps the backlog and survives a source with none', () => {
    const many = {
      ...m365MirrorFx,
      services: Array.from({ length: 12 }, (_, k) => ({ service: `Workload ${k}`, status: 'serviceDegradation' })),
      issues: Array.from({ length: 12 }, (_, k) => ({
        service: `Workload ${k}`, classification: 'advisory', is_resolved: false,
        start_time: '2026-07-01T00:00:00Z', impact: 'x', feature: 'F',
      })),
    };
    const out = mapM365(m365Fx, many, MIRROR_NOW, null);
    expect(out.state).toBe('ok'); // none of them are core, and all are advisories
    expect(out.advisories.length).toBeLessThanOrEqual(8);
    // The consumer half has no notion of an advisory and must not break the shape.
    expect(Array.isArray(mapM365(m365Fx, null, MIRROR_NOW, null).advisories)).toBe(true);
  });

  it('m365 graph: a tenant grades exactly like the mirror, and only OPEN issues speak', () => {
    const out = mapM365Graph(m365GraphFx);
    expect(out.state).toBe('minor');
    expect(out.note).toBe('Exchange Online: service degradation'); // same sentence as the mirror path
    // One INCIDENT (Exchange) and one ADVISORY (Intune, investigating): only the
    // incident is an incident row, and only it could have set the state.
    expect(out.incidents).toHaveLength(1);
    const [first] = out.incidents;
    expect(first.title).toBe('Exchange Online: service degradation'); // core workload leads
    expect(first.since).toBe('2026-08-02T09:14:00Z'); // the OPEN issue's start, not the resolved one's
    expect(first.update).toContain('delays of several minutes');
    // $expand hands back resolved history alongside the news; it must not speak.
    expect(first.update).not.toContain('migrate');
    // Non-core trouble still reaches the ledger, now under the advisory group.
    expect(out.advisories).toHaveLength(1);
    expect(out.advisories[0]).toMatchObject({ service: 'Microsoft Intune', feature: 'Reporting' });
  });

  it('m365 graph: a degraded workload with no open issue still gets its verdict row', () => {
    const noIssues = { ...m365GraphFx, value: m365GraphFx.value.map((r) => ({ ...r, issues: [] })) };
    const out = mapM365Graph(noIssues);
    expect(out.state).toBe('minor');
    expect(out.incidents[0]).toMatchObject({
      title: 'Exchange Online: service degradation', since: '', update: '',
    });
  });

  it('m365 graph: an answer we do not understand is ABSENT, never green', () => {
    expect(mapM365Graph(null)).toBeNull();
    expect(mapM365Graph({})).toBeNull();
    expect(mapM365Graph({ value: [] })).toBeNull();
    expect(mapM365Graph(m365Fx)).toBeNull(); // the consumer feed's array
    expect(mapM365Graph(m365MirrorFx)).toBeNull(); // the mirror's object
    // A shape we recognize saying words we don't: no signal, not "fine".
    expect(mapM365Graph({ value: [{ service: 'Exchange Online', status: 'SomethingBrandNew' }] })).toBeNull();
  });

  it('m365: a tenant answer RETIRES the mirror rather than arguing with it', () => {
    // Own tenant degraded, consumer green: the row follows the reader's own
    // Microsoft. Teams is degraded in the mirror and healthy here, so the
    // mirror's finding must not appear at all.
    const own = mapM365(m365Fx, m365MirrorFx, MIRROR_NOW, m365GraphFx);
    expect(own.state).toBe('minor');
    expect(own.note).toBe('Exchange Online: service degradation');
    expect(own.incidents.some((i) => i.title.startsWith('Microsoft Teams'))).toBe(false);
    expect(own.advisories.some((a) => a.service === 'Microsoft Intune')).toBe(true);

    // Own tenant healthy: a stranger's outage does not amber a row about YOUR
    // Microsoft, even though the mirror is fresh and degraded.
    const calm = mapM365(m365Fx, m365MirrorFx, MIRROR_NOW, greenGraph());
    expect(calm).toMatchObject({ state: 'ok', note: 'All systems operational' });
    expect(calm.incidents).toHaveLength(0);

    // No tenant configured, or its fetch failed: the mirror speaks, exactly as
    // it did before any of this existed.
    const fallback = mapM365(m365Fx, mirrorAllIncidents(), MIRROR_NOW, null);
    expect(fallback.note).toBe('Exchange Online: service degradation');
    expect(fallback.incidents.some((i) => i.title.startsWith('Microsoft Teams'))).toBe(true);
  });

  it('google: all-ended fixture is ok, active incident is minor', () => {
    expect(mapGoogle(googleFx, Date.now()).state).toBe('ok');
    expect(mapGoogle([], Date.now()).state).toBe('ok'); // a genuinely empty array is all-clear
    const out = mapGoogle([{ begin: '2026-07-11T00:00:00Z', external_desc: '**Gmail delays**\ndetail here' }], Date.now());
    expect(out.state).toBe('minor');
    expect(out.note).toBe('Gmail delays');
  });
  it('webex: maintenance-only fixture is ok, real incident degrades', () => {
    expect(mapWebex(webexFx).state).toBe('ok'); // 3 unresolved, all maintenance
    expect(mapWebex({ unResolvedIncidents: [] }).state).toBe('ok'); // no open incidents is all-clear
    const out = mapWebex({ unResolvedIncidents: [{ incidentName: 'Meetings join failures', impact: 'major', createTime: 'x' }] });
    expect(out.state).toBe('major');
    expect(out.note).toBe('Meetings join failures');
  });
  it('aws: stale events are ok now, recent event degrades', () => {
    expect(mapAws(awsFx, Date.now()).state).toBe('ok'); // events months old
    expect(mapAws([], Date.now()).state).toBe('ok'); // empty array is all-clear
    const evDate = Number(awsFx[0].date) * 1000;
    const out = mapAws(awsFx, evDate + 3600e3); // one hour after the event
    expect(out.state).toBe('minor');
    expect(out.note).toContain('Increased Error Rates');
  });
  it('malformed envelope is NEVER green: the three array feeds throw on a non-array body', () => {
    // A provider that answers 200 with an error object or a changed JSON shape
    // used to coerce to [] and report "All systems operational". Each mapper now
    // throws instead, which fetchOne turns into an unknown row (partial digest,
    // cached() serves the stale backup) rather than a fabricated green.
    expect(() => mapGoogle({}, Date.now())).toThrow(/expected an incidents array/);
    expect(() => mapAws({}, Date.now())).toThrow(/expected an events array/);
    expect(() => mapWebex({})).toThrow(/expected an unResolvedIncidents array/);
    expect(() => mapWebex({ unResolvedIncidents: 'nope' })).toThrow(/expected an unResolvedIncidents array/);
  });
});

describe('/services/status route', () => {
  it('400s with no valid ids', async () => {
    expect((await call('/services/status')).status).toBe(400);
    expect((await call('/services/status?ids=bogus,nope')).status).toBe(400);
  });
  it('serves the digest and sorts the cache key', async () => {
    await clearCache('svc:cloudflare,zoom');
    stubFetch([
      { match: /status\.zoom\.us/, body: spOk },
      { match: /cloudflarestatus/, body: spBad },
    ]);
    const res = await call('/services/status?ids=zoom,cloudflare');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=480'); // ~1.5x the 5-min poll
    const digest = await res.json();
    expect(digest.services).toHaveLength(2);
    expect(digest.services[0]).toMatchObject({ id: 'zoom', state: 'ok' });
    expect(digest.services[1]).toMatchObject({ id: 'cloudflare', state: 'minor' });
    // permuted ids hit the same cache entry (no upstream stubs left)
    const res2 = await call('/services/status?ids=cloudflare,zoom');
    expect((await res2.json()).services).toHaveLength(2);
  });
  it('reports unknown for a failed service without failing the batch', async () => {
    await clearCache('svc:github,slack');
    stubFetch([
      { match: /githubstatus/, body: 'nope', status: 500 },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const digest = await (await call('/services/status?ids=github,slack')).json();
    expect(digest.services.find((s) => s.id === 'github').state).toBe('unknown');
    expect(digest.services.find((s) => s.id === 'slack').state).toBe('ok');
  });
  // The recorded mirror carries its REAL generated_at, which the freshness gate
  // would eventually reject — so route tests that want it believed re-stamp it.
  // These route tests are about WHICH source answers (fallback, caching,
  // mending), not about Microsoft's advisory/incident split, and they need the
  // mirror to actually report trouble. The recorded issues are all advisories,
  // which now grade green, so the route helper promotes them; the split itself
  // is covered by the adapter tests above.
  const freshMirror = (extra = {}) => ({
    ...mirrorAllIncidents(), generated_at: new Date().toISOString(), ...extra,
  });
  const allGreenMirror = () => freshMirror({
    services: m365MirrorFx.services.map((s) => ({ ...s, status: 'serviceOperational' })), issues: [],
  });

  it('retries a flapping source before reporting unknown', async () => {
    // The mirror is down too, so the row stands or falls on the consumer
    // feed's retry: a 5xx is a server having a bad moment, worth a second ask.
    await clearCache('svc:m365');
    const calls = stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'busy', status: 503, times: 1 },
      { match: /status\.cloud\.microsoft/, body: m365Fx },
      { match: /aguidetocloud/, body: 'down', status: 500, times: 3 },
    ]);
    const digest = await (await call('/services/status?ids=m365')).json();
    expect(digest.services[0]).toMatchObject({ id: 'm365', state: 'ok' });
    expect(calls.filter((u) => /status\.cloud\.microsoft/.test(u))).toHaveLength(2);
    await clearCache('svc:m365');
  });

  // A 4xx is the server's considered answer and a retry 250 ms later draws the
  // same one. Microsoft's consumer feed answered ~40% 4xx to Cloudflare egress,
  // and every one of those used to be asked three times.
  it.each([403, 404, 429])('asks once, not three times, when a feed answers %i', async (status) => {
    await clearCache('svc:m365');
    const calls = stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'no', status, times: 3 },
      { match: /aguidetocloud/, body: allGreenMirror() },
    ]);
    const digest = await (await call('/services/status?ids=m365')).json();
    expect(digest.services[0].state).toBe('ok'); // the mirror still carries the row
    expect(calls.filter((u) => /status\.cloud\.microsoft/.test(u))).toHaveLength(1);
    await clearCache('svc:m365');
  });

  it('still retries a 408, the one 4xx a second ask can fix', async () => {
    await clearCache('svc:m365');
    const calls = stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'slow', status: 408, times: 1 },
      { match: /status\.cloud\.microsoft/, body: m365Fx },
      { match: /aguidetocloud/, body: 'down', status: 500, times: 3 },
    ]);
    const digest = await (await call('/services/status?ids=m365')).json();
    expect(digest.services[0].state).toBe('ok');
    expect(calls.filter((u) => /status\.cloud\.microsoft/.test(u))).toHaveLength(2);
    await clearCache('svc:m365');
  });

  it('logs which host answered which status, never the body', async () => {
    // Workers Logs are the only place to tell a WAF 403 from a rate-limit 429.
    await clearCache('svc:github,m365');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'SECRET-BODY-TEXT', status: 429, headers: { 'Retry-After': '30' } },
      { match: /aguidetocloud/, body: allGreenMirror() },
      { match: /githubstatus/, body: 'OTHER-BODY-TEXT', status: 503, times: 3 },
    ]);
    await call('/services/status?ids=github,m365');
    const logged = warn.mock.calls.flat().map(String).join('\n');
    warn.mockRestore();
    expect(logged).toContain('[svcstatus] m365 source status.cloud.microsoft failed after 1 attempt: HTTP 429 (retry-after 30)');
    expect(logged).toContain('[svcstatus] github www.githubstatus.com failed after 3 attempts: HTTP 503');
    expect(logged).not.toContain('BODY-TEXT');
    await clearCache('svc:github,m365');
  });

  it('a 200 that is not JSON is retried and logged without quoting the body', async () => {
    // The parser's own error quotes what it choked on (`Unexpected token 'S',
    // "SECRET-BODY-TEXT" is not valid JSON`), and that message used to ride
    // straight into the log line. GitHub takes the res.json() path, AWS the
    // UTF-16 decodeBomJson one; both must say only what kind of body it was.
    await clearCache('svc:github,aws,slack');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = stubFetch([
      { match: /githubstatus/, body: 'SECRET-BODY-TEXT', times: 3 },
      { match: /status\.aws\.amazon\.com/, body: 'SECRET-BODY-TEXT', times: 3 },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const text = await (await call('/services/status?ids=github,aws,slack')).text();
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
    warn.mockRestore();
    error.mockRestore();
    // Still a failed attempt like any other: three asks each, then unknown.
    expect(calls.filter((u) => /githubstatus/.test(u))).toHaveLength(3);
    expect(calls.filter((u) => /status\.aws\.amazon\.com/.test(u))).toHaveLength(3);
    expect(JSON.parse(text).services.find((s) => s.id === 'github').state).toBe('unknown');
    expect(logged).toContain('[svcstatus] github www.githubstatus.com failed after 3 attempts: invalid JSON body (application/json)');
    expect(logged).toContain('[svcstatus] aws status.aws.amazon.com failed after 3 attempts: invalid JSON body (application/json)');
    expect(logged).not.toContain('SECRET-BODY-TEXT');
    expect(text).not.toContain('SECRET-BODY-TEXT');
    await clearCache('svc:github,aws,slack');
  });

  it('m365 reads both feeds and reports the outage an office would feel', async () => {
    await clearCache('svc:m365');
    stubFetch([
      { match: /status\.cloud\.microsoft/, body: m365Fx },
      { match: /aguidetocloud/, body: freshMirror() },
    ]);
    const digest = await (await call('/services/status?ids=m365')).json();
    // Consumer green, enterprise degraded: the row follows the worse half.
    expect(digest.services[0]).toMatchObject({ id: 'm365', label: 'Microsoft 365', state: 'minor' });
    expect(digest.services[0].note).toBe('Exchange Online: service degradation');
    expect(digest.services[0].incidents.length).toBeGreaterThan(1);
    expect(digest.partial).toBeUndefined(); // a degraded row is an ANSWER, not a failure
    await clearCache('svc:m365');
  });

  it('one dead half still answers: the surviving feed carries the row', async () => {
    await clearCache('svc:m365');
    stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'gone', status: 404, times: 3 },
      { match: /aguidetocloud/, body: freshMirror() },
    ]);
    const digest = await (await call('/services/status?ids=m365')).json();
    expect(digest.services[0].state).toBe('minor'); // mirror alone is enough
    expect(digest.partial).toBeUndefined();
    await clearCache('svc:m365');
  });

  // ---- Optional: the operator's own tenant, via Microsoft Graph -------------
  // Three secrets turn the enterprise half from a stranger's tenant into the
  // reader's own. None of these values is real; the point of several of these
  // cases is that none of them reaches a log either.
  const MS_ENV = {
    MS_TENANT_ID: 'contoso.onmicrosoft.com',
    MS_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
    MS_CLIENT_SECRET: 'never-print-this-secret',
  };
  const tenantStubs = (extra = []) => stubFetch([
    ...extra,
    { match: /login\.microsoftonline\.com/, body: { access_token: 'tenant-bearer-token', expires_in: 3599 }, times: 9 },
    { match: /graph\.microsoft\.com/, body: m365GraphFx, times: 9 },
    { match: /status\.cloud\.microsoft/, body: m365Fx, times: 9 },
    { match: /aguidetocloud/, body: allGreenMirror(), times: 9 },
  ]);
  const loginCalls = (calls) => calls.filter((u) => /login\.microsoftonline\.com/.test(u));
  const graphCalls = (calls) => calls.filter((u) => /graph\.microsoft\.com/.test(u));

  it('a configured tenant carries the row, and is asked for a token only once', async () => {
    await clearCache('svc:m365');
    const calls = tenantStubs();
    const first = await (await call('/services/status?ids=m365', undefined, MS_ENV)).json();
    // Consumer green and mirror green: minor can only have come from the tenant.
    expect(first.services[0]).toMatchObject({ id: 'm365', state: 'minor' });
    expect(first.services[0].note).toBe('Exchange Online: service degradation');
    expect(first.partial).toBeUndefined();

    // The next poll after the TTL: the per-set entry and the row map both lapse.
    await clearCache('svc:m365');
    await caches.default.delete(svcMapKey);
    const second = await (await call('/services/status?ids=m365', undefined, MS_ENV)).json();
    expect(second.services[0].state).toBe('minor');
    // Two polls, two Graph reads, ONE token: the memo survives between them.
    expect(loginCalls(calls)).toHaveLength(1);
    expect(graphCalls(calls)).toHaveLength(2);
    await clearCache('svc:m365');
  });

  it('a token inside its last five minutes is re-minted, not reused', async () => {
    // expires_in shorter than the early-refresh window, so the memo exists but
    // is already too old to trust — a token must never die mid-request.
    await clearCache('svc:m365');
    const calls = stubFetch([
      { match: /login\.microsoftonline\.com/, body: { access_token: 'about-to-expire', expires_in: 60 }, times: 9 },
      { match: /graph\.microsoft\.com/, body: m365GraphFx, times: 9 },
      { match: /status\.cloud\.microsoft/, body: m365Fx, times: 9 },
      { match: /aguidetocloud/, body: allGreenMirror(), times: 9 },
    ]);
    await call('/services/status?ids=m365', undefined, MS_ENV);
    await clearCache('svc:m365');
    await caches.default.delete(svcMapKey);
    await call('/services/status?ids=m365', undefined, MS_ENV);
    expect(loginCalls(calls)).toHaveLength(2);
    await clearCache('svc:m365');
  });

  it('a tenant that rejects the credentials falls back to the mirror, and logs no secret', async () => {
    await clearCache('svc:m365');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch([
      {
        match: /login\.microsoftonline\.com/,
        body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' },
        status: 401,
        times: 9,
      },
      { match: /status\.cloud\.microsoft/, body: m365Fx, times: 9 },
      { match: /aguidetocloud/, body: freshMirror(), times: 9 },
    ]);
    const digest = await (await call('/services/status?ids=m365', undefined, MS_ENV)).json();
    // The mirror's own finding, unblocked: Teams is degraded there.
    expect(digest.services[0].state).toBe('minor');
    expect(digest.services[0].incidents.some((i) => i.title.startsWith('Microsoft Teams'))).toBe(true);
    expect(digest.partial).toBeUndefined(); // a failed tenant is not a failed row
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('[svcstatus] m365 graph token HTTP 401');
    expect(logged).toContain('invalid_client'); // the failure CLASS, so an operator can act
    expect(logged).not.toContain(MS_ENV.MS_CLIENT_SECRET);
    expect(logged).not.toContain(MS_ENV.MS_CLIENT_ID);
    expect(logged).not.toContain(MS_ENV.MS_TENANT_ID); // no URL in the line either
    expect(logged).not.toContain('Bearer');
    warn.mockRestore();
    await clearCache('svc:m365');
  });

  // Same rule for the tenant's two calls: a 200 that will not parse names its
  // media type, never its content (a token answer's body is where a credential
  // would be sitting). An AAD error that is prose, not a code, stays out too.
  it.each([
    ['token', [{ match: /login\.microsoftonline\.com/, body: 'SECRET-BODY-TEXT', times: 9 }]],
    ['health', [{ match: /graph\.microsoft\.com/, body: 'SECRET-BODY-TEXT', times: 9 }]],
    ['token HTTP 400', [{ match: /login\.microsoftonline\.com/, body: { error: 'SECRET-BODY-TEXT here' }, status: 400, times: 9 }]],
  ])('a tenant %s failure logs no body text', async (label, extra) => {
    await clearCache('svc:m365');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tenantStubs(extra);
    const text = await (await call('/services/status?ids=m365', undefined, MS_ENV)).text();
    const logged = warn.mock.calls.flat().map(String).join(' ');
    warn.mockRestore();
    expect(JSON.parse(text).services[0].state).toBe('ok'); // the public feeds carry the row
    expect(logged).toContain(label.includes('HTTP')
      ? '[svcstatus] m365 graph token HTTP 400'
      : `[svcstatus] m365 graph ${label} invalid JSON body (application/json)`);
    expect(logged).not.toContain('SECRET-BODY-TEXT');
    expect(text).not.toContain('SECRET-BODY-TEXT');
    await clearCache('svc:m365');
  });

  it('a tenant answering a shape we do not understand is ABSENT, not green', async () => {
    await clearCache('svc:m365');
    stubFetch([
      { match: /login\.microsoftonline\.com/, body: { access_token: 't', expires_in: 3599 }, times: 9 },
      { match: /graph\.microsoft\.com/, body: { value: [{ service: 'Exchange Online', status: 'SomethingBrandNew' }] }, times: 9 },
      { match: /status\.cloud\.microsoft/, body: m365Fx, times: 9 },
      { match: /aguidetocloud/, body: freshMirror(), times: 9 },
    ]);
    const digest = await (await call('/services/status?ids=m365', undefined, MS_ENV)).json();
    expect(digest.services[0].state).toBe('minor');
    expect(digest.services[0].incidents.some((i) => i.title.startsWith('Microsoft Teams'))).toBe(true);
    await clearCache('svc:m365');
  });

  it('with no tenant secrets the row never reaches Microsoft login', async () => {
    // The contract an open-source fork is owed: unconfigured behaves exactly as
    // it did before the tenant source existed. The stub throws on any unmocked
    // URL, and the assertion pins it explicitly besides.
    await clearCache('svc:m365');
    const calls = stubFetch([
      { match: /status\.cloud\.microsoft/, body: m365Fx, times: 9 },
      { match: /aguidetocloud/, body: freshMirror(), times: 9 },
    ]);
    const digest = await (await call('/services/status?ids=m365')).json();
    expect(digest.services[0].state).toBe('minor'); // the mirror, same as always
    expect(calls.some((u) => /login\.microsoftonline\.com|graph\.microsoft\.com/.test(u))).toBe(false);

    // Two of three secrets is a half-finished setup, not a tenant: it stays
    // keyless rather than 401ing against Microsoft every poll.
    await clearCache('svc:m365');
    await caches.default.delete(svcMapKey);
    const half = stubFetch([
      { match: /status\.cloud\.microsoft/, body: m365Fx, times: 9 },
      { match: /aguidetocloud/, body: freshMirror(), times: 9 },
    ]);
    await call('/services/status?ids=m365', undefined, { MS_TENANT_ID: 'contoso', MS_CLIENT_ID: 'abc', MS_CLIENT_SECRET: '  ' });
    expect(half.some((u) => /login\.microsoftonline\.com|graph\.microsoft\.com/.test(u))).toBe(false);
    await clearCache('svc:m365');
  });

  it('a 200 carrying HTML is RETRIED, not swallowed, and still says why it failed', async () => {
    // The defect this pins: the JSON parse used to sit outside the retry loop,
    // so Microsoft answering 200 with an HTML error page threw once and became
    // a silent unknown without a single retry.
    await clearCache('svc:m365,slack');
    const calls = stubFetch([
      // Wrong content-type AND an unparseable body: both routes into the loop.
      { match: /status\.cloud\.microsoft/, body: '<html><body>Error</body></html>', ctype: 'text/html', times: 9 },
      { match: /aguidetocloud/, body: '<!doctype html><h1>502</h1>', times: 9 },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const res = await call('/services/status?ids=m365,slack');
    const digest = await res.json();
    const m365 = digest.services.find((s) => s.id === 'm365');
    expect(m365.state).toBe('unknown');
    expect(m365.note).toBe('Status unavailable'); // never blank
    // Three attempts per source, two sources.
    expect(calls.filter((u) => /status\.cloud\.microsoft/.test(u))).toHaveLength(3);
    expect(calls.filter((u) => /aguidetocloud/.test(u))).toHaveLength(3);
    await clearCache('svc:m365,slack');
  });

  it('an unknown row makes the digest PARTIAL: brief cache, and the backup survives', async () => {
    // Same lesson the F1 and markets routes learned: a digest with a hole must
    // not sit in the cache for the full TTL, and must never overwrite the 24h
    // backup — which is the only copy the mend below has to borrow from.
    await clearCache('svc:m365,slack');
    stubFetch([
      { match: /status\.cloud\.microsoft/, body: m365Fx },
      { match: /aguidetocloud/, body: allGreenMirror() },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const healthy = await call('/services/status?ids=m365,slack');
    expect(healthy.headers.get('cache-control')).toBe('public, max-age=480');
    expect((await healthy.json()).partial).toBeUndefined();

    // Expire the fresh copy and, on the same clock, the per-provider rows.
    await caches.default.delete(cacheKey('fresh', 'svc:m365,slack'));
    await caches.default.delete(svcMapKey);
    stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'down', status: 500, times: 3 },
      { match: /aguidetocloud/, body: 'down', status: 500, times: 3 },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const res = await call('/services/status?ids=m365,slack');
    const digest = await res.json();
    expect(digest.partial).toBe(true);
    expect(res.headers.get('cache-control')).toBe('public, max-age=120'); // not 480

    // The backup still holds the COMPLETE digest, not the crippled one.
    const backup = await caches.default.match(cacheKey('stale', 'svc:m365,slack'));
    expect((await backup.json()).services.find((s) => s.id === 'm365').state).toBe('ok');
    await clearCache('svc:m365,slack');
  });

  it('mends an unknown row from the backup, so one dead provider never greys the card', async () => {
    await clearCache('svc:m365,slack');
    stubFetch([
      { match: /status\.cloud\.microsoft/, body: m365Fx },
      { match: /aguidetocloud/, body: freshMirror() },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    await call('/services/status?ids=m365,slack'); // populates the 24h backup
    await caches.default.delete(cacheKey('fresh', 'svc:m365,slack'));
    await caches.default.delete(svcMapKey);

    stubFetch([
      { match: /status\.cloud\.microsoft/, body: 'down', status: 500, times: 3 },
      { match: /aguidetocloud/, body: 'down', status: 500, times: 3 },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const res = await call('/services/status?ids=m365,slack');
    const digest = await res.json();
    expect(digest.mended).toBe(true);
    expect(digest.partial).toBe(true); // still short-cached, still no backup write
    const m365 = digest.services.find((s) => s.id === 'm365');
    expect(m365.state).toBe('minor'); // borrowed from the backup, not greyed out
    expect(m365.note).toBe('Exchange Online: service degradation');
    expect(digest.services.find((s) => s.id === 'slack').state).toBe('ok'); // the live half stays live
    expect(res.headers.get('cache-control')).toBe('public, max-age=120');
    await clearCache('svc:m365,slack');
  });

  it('does not borrow a row old enough to be fiction', () => {
    // A day-old "operational" is not last-known-good, it is a guess about a
    // window in which an outage could have come and gone. Unknown is honest.
    const fresh = { services: [{ id: 'm365', label: 'Microsoft 365', state: 'unknown', note: 'Status unavailable', incidents: [] }], partial: true };
    const old = { updatedAt: Math.floor(Date.now() / 1000) - 6 * 3600, services: [{ id: 'm365', state: 'ok', note: 'All systems operational', incidents: [] }] };
    expect(mendServiceStatuses(fresh, old).services[0].state).toBe('unknown');
    expect(mendServiceStatuses(fresh, {}).services[0].state).toBe('unknown');
    const recent = { ...old, updatedAt: Math.floor(Date.now() / 1000) - 60 };
    expect(mendServiceStatuses(fresh, recent).services[0].state).toBe('ok');
  });
  it('serves Claude and OpenAI (openai: incident.io compat feed, no incidents key)', async () => {
    await clearCache('svc:claude,openai');
    stubFetch([
      { match: /status\.claude\.com/, body: claudeFx },
      { match: /status\.openai\.com/, body: openaiFx },
    ]);
    const digest = await (await call('/services/status?ids=claude,openai')).json();
    expect(digest.services[0]).toMatchObject({ id: 'claude', label: 'Claude', state: 'ok' });
    expect(digest.services[1]).toMatchObject({ id: 'openai', label: 'OpenAI', state: 'ok' });
    expect(digest.services[1].incidents).toEqual([]);
  });

  // The per-provider layer (sharedmap.js). The route caches per sorted id set,
  // so before it a provider common to many sets was downloaded and parsed once
  // per distinct set, the heavy feeds (Google ~410 KB, AWS ~231 KB) included.
  const svcRows = async () => (await (await caches.default.match(svcMapKey))?.json())?.entries ?? {};
  const seedSvcRows = (entries) => caches.default.put(svcMapKey, new Response(JSON.stringify({ entries }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
  }));

  it('fetches a provider shared by two id sets once, and keeps only its digested row', async () => {
    await Promise.all([clearCache('svc:github,zoom'), clearCache('svc:github,slack')]);
    const calls = stubFetch([
      { match: /githubstatus/, body: spBad, times: 2 },
      { match: /status\.zoom\.us/, body: spOk },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const one = await (await call('/services/status?ids=github,zoom')).json();
    const two = await (await call('/services/status?ids=slack,github')).json();
    expect(calls.filter((u) => /githubstatus/.test(u))).toHaveLength(1);
    expect(two.services.map((s) => s.id)).toEqual(['slack', 'github']); // request order kept
    expect(two.services[1]).toEqual(one.services[0]); // the very same row
    // What the map keeps is the mapped row alone: no raw upstream body, and no
    // id or label (the digest adds those from the registry).
    const { id, label, ...row } = one.services[0];
    expect((await svcRows()).github.value).toEqual(row);
    await Promise.all([clearCache('svc:github,zoom'), clearCache('svc:github,slack')]);
  });

  it('never stores a failed or unknown row, so the next set asks that provider again', async () => {
    await Promise.all([clearCache('svc:github,slack,zoom'), clearCache('svc:github,zoom')]);
    stubFetch([
      { match: /githubstatus/, body: 'down', status: 500, times: 3 },
      // Zoom answers, but in a vocabulary the mapper doesn't know: unknown.
      { match: /status\.zoom\.us/, body: { status: { indicator: 'brand-new', description: 'Hmm' } } },
      { match: /status\.slack\.com/, body: slackFx },
    ]);
    const first = await (await call('/services/status?ids=github,slack,zoom')).json();
    expect(first.partial).toBe(true);
    expect(first.services.find((s) => s.id === 'github')).toMatchObject({ state: 'unknown', note: 'Status unavailable' });
    // The unknown row still reads as its mapper said it, exactly as before.
    expect(first.services.find((s) => s.id === 'zoom')).toMatchObject({ state: 'unknown', note: 'Hmm' });
    expect(Object.keys(await svcRows())).toEqual(['slack']);

    const calls = stubFetch([
      { match: /githubstatus/, body: spOk },
      { match: /status\.zoom\.us/, body: spOk },
    ]);
    const second = await (await call('/services/status?ids=zoom,github')).json();
    expect(calls).toHaveLength(2); // both asked again, neither served from the map
    expect(second.partial).toBeUndefined();
    expect(second.services.map((s) => s.state)).toEqual(['ok', 'ok']);
    await Promise.all([clearCache('svc:github,slack,zoom'), clearCache('svc:github,zoom')]);
  });

  it('keeps a set fresh only as long as its oldest reused row, and dates it by that row', async () => {
    // GitHub's row fetched at t=0 by some other set; this uncached set is
    // assembled around it at t=479. Without the cap the entry would restart the
    // clock and serve the t=0 row as fresh until t=959.
    const key = 'svc:github,slack';
    await clearCache(key);
    const t0 = Date.now() - 479_000;
    const old = { state: 'ok', note: 'All Systems Operational', incidents: [] };
    await seedSvcRows({ github: { value: old, fetchedAt: t0 } });
    const calls = stubFetch([{ match: /status\.slack\.com/, body: slackFx }]);
    const res = await call('/services/status?ids=github,slack');
    const digest = await res.json();
    expect(calls).toHaveLength(1); // Slack only
    expect(digest.services[0]).toEqual({ id: 'github', label: 'GitHub', ...old });
    expect(res.headers.get('cache-control')).toBe('public, max-age=1'); // what is left of GitHub's 480s
    const entry = await caches.default.match(cacheKey('fresh', key));
    expect(Number(entry.headers.get('X-Fresh-Until'))).toBeLessThanOrEqual(t0 + 480_000 + 500); // rounding slop
    // "as of" is the oldest row's fetch, which is also the age the mend weighs
    // the 24h backup by: a backup dated at assembly would let a row past
    // MEND_MAX_AGE_S be lent out for up to a TTL longer.
    expect(digest.updatedAt).toBe(Math.floor(t0 / 1000));
    const backup = await caches.default.match(cacheKey('stale', key));
    expect((await backup.json()).updatedAt).toBe(Math.floor(t0 / 1000));
    await clearCache(key);
  });

  // Free plan: 50 subrequests per invocation, fetch() and Cache API match/put
  // counted together. Pinned to the exact tally in the fetchServices comment
  // (index.js), so a change that spends one more has to update that arithmetic.
  describe('subrequest budget, worst case: all 11 providers, a tenant, every attempt spent', () => {
    const ALL = Object.keys(SERVICES);
    const FEEDS = [
      [/status\.zoom\.us/, spOk], [/status\.ui\.com/, spOk], [/cloudflarestatus/, spOk],
      [/githubstatus/, spOk], [/status\.slack\.com/, slackFx], [/google\.com\/appsstatus/, googleFx],
      [/service-status\.webex\.com/, webexFx], [/status\.aws\.amazon\.com/, awsFx],
      [/status\.claude\.com/, claudeFx], [/status\.openai\.com/, openaiFx],
    ];
    const count = async (routes) => {
      await clearCache(`svc:${[...ALL].sort().join(',')}`);
      const calls = stubFetch(routes);
      const match = vi.spyOn(caches.default, 'match');
      const put = vi.spyOn(caches.default, 'put');
      const res = await call(`/services/status?ids=${ALL.join(',')}`, undefined, MS_ENV);
      const spent = calls.length + match.mock.calls.length + put.mock.calls.length;
      match.mockRestore();
      put.mockRestore();
      await clearCache(`svc:${[...ALL].sort().join(',')}`);
      return { res, calls, spent };
    };
    // Two failures, then the answer: every retry spent, and nothing lost.
    const lastTry = (match, body, fails = 2) => [{ match, body: 'down', status: 500, times: fails }, { match, body }];
    // A function, not a shared table: stubFetch spends each route's `times` in place.
    const tenantOnSecondTry = () => [
      ...lastTry(/login\.microsoftonline\.com/, { access_token: 't', expires_in: 3599 }, 1),
      ...lastTry(/graph\.microsoft\.com/, m365GraphFx, 1),
    ];

    it('a complete digest: every provider answers on its last attempt', async () => {
      const { res, calls, spent } = await count([
        ...FEEDS.flatMap(([m, body]) => lastTry(m, body)),
        ...lastTry(/status\.cloud\.microsoft/, m365Fx),
        ...lastTry(/aguidetocloud/, allGreenMirror()),
        ...tenantOnSecondTry(),
      ]);
      const digest = await res.json();
      expect(digest.services).toHaveLength(11);
      expect(digest.partial).toBeUndefined();
      expect(calls).toHaveLength(40);
      expect(spent).toBe(45);
      expect(spent).toBeLessThan(50);
    });

    it('a partial digest: every public feed dead, the tenant alone carrying Microsoft', async () => {
      const dead = (match) => ({ match, body: 'down', status: 500, times: 3 });
      const { res, calls, spent } = await count([
        ...FEEDS.map(([m]) => dead(m)),
        dead(/status\.cloud\.microsoft/),
        dead(/aguidetocloud/),
        ...tenantOnSecondTry(),
      ]);
      const digest = await res.json();
      expect(digest.partial).toBe(true);
      expect(digest.services.find((s) => s.id === 'm365').state).toBe('minor');
      expect(calls).toHaveLength(40);
      expect(spent).toBe(45); // the stale put becomes the mend's stale match
    });
  });

  it('abandons a hung provider at the deadline so the answered rows still ship (F13)', async () => {
    // Slack answers instantly; GitHub hangs forever and ignores its abort signal.
    // Before the overall deadline, the fan-out waited on the slowest
    // source, so one hung provider held the whole digest past the board's 15s
    // fetch and health's 13s probe and failed the entire card. Now the fan-out
    // returns at SVC_DEADLINE_MS with GitHub marked unknown (=> partial) and
    // Slack's answer intact. Fake time so the test doesn't spend the real budget.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (/status\.slack\.com/.test(url)) {
          return Promise.resolve(new Response(JSON.stringify(slackFx), { headers: { 'Content-Type': 'application/json' } }));
        }
        return new Promise(() => {}); // github: never resolves, never honours the abort
      }));
      const pending = fetchServiceRows(['slack', 'github'], env);
      await vi.advanceTimersByTimeAsync(SVC_DEADLINE_MS + 1000);
      const rows = await pending;
      expect([...rows.keys()]).toEqual(['slack']); // the abandoned provider is simply absent
      const digest = serviceDigest(['slack', 'github'], (id) => rows.get(id));
      expect(digest.services.find((s) => s.id === 'slack').state).toBe('ok');
      expect(digest.services.find((s) => s.id === 'github').state).toBe('unknown');
      expect(digest.partial).toBe(true); // a provider that didn't finish makes the digest partial
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('decodeBomJson (AWS UTF-16 quirk)', () => {
  const encode = (str, be) => {
    const bom = be ? [0xFE, 0xFF] : [0xFF, 0xFE];
    const bytes = [...bom];
    for (const ch of str) { const c = ch.charCodeAt(0);
      if (be) bytes.push((c >> 8) & 0xff, c & 0xff); else bytes.push(c & 0xff, (c >> 8) & 0xff); }
    return new Uint8Array(bytes).buffer;
  };
  it('parses big-endian (what AWS actually serves)', () => {
    expect(decodeBomJson(encode('[{"a":1}]', true))).toEqual([{ a: 1 }]);
  });
  it('parses little-endian too', () => {
    expect(decodeBomJson(encode('[{"a":1}]', false))).toEqual([{ a: 1 }]);
  });
  it('falls back to utf-8 with no BOM', () => {
    expect(decodeBomJson(new TextEncoder().encode('[1,2,3]').buffer)).toEqual([1, 2, 3]);
  });
});

import { mapApod, fetchApod } from '../../worker/src/apod.js';
import apodWindow from './fixtures/apod-window.json'; // 7 days, 2019-05-06 is video

describe('apod adapter', () => {
  it('mapApod picks the newest image (array is date-ascending)', () => {
    const d = mapApod(apodWindow);
    expect(d.photo.date).toBe('2019-05-11');
    expect(d.photo.url).toMatch(/^https?:/);
    expect(d.photo.title.length).toBeGreaterThan(0);
    expect(typeof d.photo.explanation).toBe('string');
  });
  it('mapApod skips a trailing video day', () => {
    const d = mapApod(apodWindow.slice(0, 2)); // [05-05 image, 05-06 video]
    expect(d.photo.date).toBe('2019-05-05');
  });
  it('mapApod returns photo:null when the window is all videos', () => {
    const d = mapApod([{ date: '2019-05-06', media_type: 'video', url: 'x' }]);
    expect(d.photo).toBeNull();
  });
  it('mapApod trims the copyright credit', () => {
    const d = mapApod([{ date: '1', media_type: 'image', url: 'u', title: 't', copyright: '  Jane Doe\n' }]);
    expect(d.photo.credit).toBe('Jane Doe');
  });
  it('fetchApod retries with yesterday on a 400 (today not posted yet)', async () => {
    const img = [{ date: '2019-05-05', media_type: 'image', url: 'u', title: 't' }];
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('no data', { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(img), { status: 200 }));
    const d = await fetchApod({ NASA_KEY: 'K' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(d.photo.date).toBe('2019-05-05');
    spy.mockRestore();
  });
  it('/apod route serves the digest and caches under "apod"', async () => {
    await clearCache('apod');
    stubFetch([{ match: /api\.nasa\.gov/, body: apodWindow }]);
    const res = await call('/apod');
    expect(res.status).toBe(200);
    const digest = await res.json();
    expect(digest.photo.date).toBe('2019-05-11');
    await clearCache('apod');
  });
});

import { mapCitibike, fetchCitibike } from '../../worker/src/citibike.js';
import cbStatus from './fixtures/citibike-status.json';
const CB_IDS = ['66dc7c31-0aca-11e7-82f6-3863bb44ef7c', '66dc51e9-0aca-11e7-82f6-3863bb44ef7c', '1869743938848725856'];

describe('citibike adapter', () => {
  it('maps counts and ok, preserving requested order', () => {
    const d = mapCitibike(cbStatus, CB_IDS);
    expect(d.stations.map((s) => s.id)).toEqual(CB_IDS);
    const s = d.stations[2];
    expect(s.bikes).toBe(22);
    expect(s.ebikes).toBe(17);
    expect(s.docks).toBe(70);
    expect(s.ok).toBe(true);
  });
  it('marks a non-renting station ok:false', () => {
    expect(mapCitibike(cbStatus, CB_IDS).stations[0].ok).toBe(false);
  });
  it('omits ids absent from the feed', () => {
    const d = mapCitibike(cbStatus, [...CB_IDS, 'nope-id']);
    expect(d.stations.find((s) => s.id === 'nope-id')).toBeUndefined();
    expect(d.stations).toHaveLength(3);
  });
  it('/citibike/status 400s with no ids and serves the digest otherwise', async () => {
    expect((await call('/citibike/status')).status).toBe(400);
    await clearCache('citibike:' + [...CB_IDS].sort().join(','));
    stubFetch([{ match: /station_status/, body: cbStatus }]);
    const res = await call(`/citibike/status?ids=${CB_IDS.join(',')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=90'); // ~1.5x the 60s poll
    expect((await res.json()).stations).toHaveLength(3);
    await clearCache('citibike:' + [...CB_IDS].sort().join(','));
  });
});

import { mapTfl, fetchTfl } from '../../worker/src/tfl.js';
import tflStatus from './fixtures/tfl-status.json';

describe('tfl adapter', () => {
  it('maps a disrupted line with its status and reason', () => {
    const d = mapTfl(tflStatus);
    const district = d.lines.find((l) => l.id === 'district');
    expect(district.ok).toBe(false);
    expect(district.status).not.toBe('Good Service');
    expect(district.reason.length).toBeGreaterThan(0);
  });
  it('maps a good-service line as ok', () => {
    const central = mapTfl(tflStatus).lines.find((l) => l.id === 'central');
    expect(central.ok).toBe(true);
  });
  it('returns all 19 lines', () => {
    expect(mapTfl(tflStatus).lines).toHaveLength(19);
  });
  it('/tfl/status serves the digest and caches under "tfl"', async () => {
    await clearCache('tfl');
    stubFetch([{ match: /api\.tfl\.gov\.uk/, body: tflStatus }]);
    const res = await call('/tfl/status');
    expect(res.status).toBe(200);
    expect((await res.json()).lines).toHaveLength(19);
    await clearCache('tfl');
  });
});

describe('review batch-2 worker fixes', () => {
  it('njtDateToEpoch is correct across the spring-forward morning (two-pass offset)', () => {
    // 03:30 EDT on 2026-03-08 (clocks sprang forward at 2AM) → 07:30 UTC.
    expect(njtDateToEpoch('08-Mar-2026 03:30:00 AM')).toBe(Date.UTC(2026, 2, 8, 7, 30, 0) / 1000);
    // a normal EDT day is unchanged: 08:15 EDT → 12:15 UTC.
    expect(njtDateToEpoch('02-Jul-2026 08:15:00 AM')).toBe(Date.UTC(2026, 6, 2, 12, 15, 0) / 1000);
    // a normal EST day: 08:15 EST → 13:15 UTC.
    expect(njtDateToEpoch('02-Jan-2026 08:15:00 AM')).toBe(Date.UTC(2026, 0, 2, 13, 15, 0) / 1000);
  });
  it('parseLegs never throws on malformed input and drops colon-less pairs', () => {
    expect(parseLegs('a%zz:b')).toEqual([]);        // bad %-escape → dropped, no URIError
    expect(parseLegs('400123')).toEqual([]);         // no colon → dropped
    expect(parseLegs('40012:MTA%20NYCT_BM1')).toEqual([{ stopId: '40012', lineRef: 'MTA NYCT_BM1' }]);
  });
  it('mapTfl reports the most-severe status when a line has several', () => {
    const d = mapTfl([{ id: 'x', name: 'X', modeName: 'tube', lineStatuses: [
      { statusSeverity: 10, statusSeverityDescription: 'Good Service' },
      { statusSeverity: 6, statusSeverityDescription: 'Severe Delays', reason: 'signal failure' },
      { statusSeverity: 9, statusSeverityDescription: 'Minor Delays' },
    ] }]);
    expect(d.lines[0].status).toBe('Severe Delays');
    expect(d.lines[0].ok).toBe(false);
  });
  it('mapMtaAlerts unions routes for entities sharing a header instead of dropping one', () => {
    const feed = { entity: [
      { alert: { informed_entity: [{ route_id: 'A' }], header_text: { translation: [{ language: 'en', text: 'Delays in both directions.' }] } } },
      { alert: { informed_entity: [{ route_id: 'C' }], header_text: { translation: [{ language: 'en', text: 'Delays in both directions.' }] } } },
    ] };
    const out = mapMtaAlerts(feed, 1000);
    expect(out).toHaveLength(1);
    expect(out[0].routes.sort()).toEqual(['A', 'C']);
  });
});

// The envelope is a property of having FETCHED, not of a mapper having
// remembered, so it has to hold for every feed route rather than for the ones
// whose test happened to check. Each row is a route, its cache key, and the
// least upstream that still gets a 200 back; the assertion is only ever the
// envelope. A route added without a stamp fails here on its first run.
describe('every feed route carries the digest envelope', () => {
  const YAHOO = { chart: { result: [{
    meta: { symbol: 'AAPL', regularMarketPrice: 200, chartPreviousClose: 190 },
    timestamp: [1, 2], indicators: { quote: [{ close: [190, 200] }] },
  }] } };
  // A header-only feed: its timestamp is a SEMANTIC updatedAt and has to survive
  // the chokepoint rather than be overwritten with "now".
  const FERRY = GtfsRt.transit_realtime.FeedMessage.encode(
    GtfsRt.transit_realtime.FeedMessage.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1783123914 }, entity: [],
    }),
  ).finish();
  const TEAM = { team: { abbreviation: 'NYY', shortDisplayName: 'Yankees', record: { items: [{ summary: '48-37' }] }, nextEvent: [] } };
  const STATUSPAGE = { status: { indicator: 'none', description: 'All Systems Operational' } };
  // One catch-all stub per route: these cases are about the envelope, not the
  // mapping, so every upstream a route touches may answer with the same body.
  const any = (body, extra = {}) => [{ match: /./, body, times: 12, ...extra }];

  const ROUTES = [
    ['/markets?symbols=aapl', 'markets:AAPL', any(YAHOO), {}],
    ['/path/realtime', 'path', any({}), {}],
    ['/ferry/departures', 'ferry', any(FERRY, { raw: true }), {}],
    ['/posts/substack?pub=acx', 'sub:acx', any([]), {}],
    ['/services/status?ids=zoom', 'svc:zoom', any(STATUSPAGE), {}],
    ['/golf', 'golf', any({}), {}],
    ['/tennis', 'tennis', any({}), {}],
    ['/f1', 'f1', any({}), {}],
    ['/amtrak/departures', 'amtrak', any({}), {}],
    ['/chart', 'chart', any(STATISTA), {}],
    ['/apod', 'apod', any([]), {}],
    ['/citibike/status?ids=4703', 'citibike:4703', any({}), {}],
    ['/tfl/status', 'tfl', any([]), {}],
    ['/gdrive/album?folder=testfolder123', 'gdrive:testfolder123', any({ files: [] }), { GDRIVE_KEY: 'k' }],
    ['/icloud/album?token=B0dGe1KmGE7CVj', 'icloud:B0dGe1KmGE7CVj', any({}), {}],
    ['/alerts/subway', 'alerts:subway', any({ entity: [] }), {}],
    ['/sports/team?lg=mlb&id=nyy', 'sports:mlb:nyy', any(TEAM), {}],
    ['/news/npr', 'news:npr', any('<rss><channel></channel></rss>'), {}],
    ['/bus/stops?legs=550789:MTA%20NYCT_X27', 'bus:550789:MTA NYCT_X27', any({}), { MTA_BUS_KEY: 'k' }],
    ['/njt/departures', njtKey(), [
      { match: /getToken/, body: TOKEN_RESPONSE, times: 2 },
      { match: /getStation/, body: [], times: 4 },
    ], NJT_ENV],
  ];

  it.each(ROUTES)('%s', async (path, key, routes, extraEnv) => {
    await clearCache(key);
    stubFetch(routes);
    const res = await call(path, {}, extraEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Number.isInteger(body.updatedAt)).toBe(true);
    expect(typeof body.stale).toBe('boolean');
    await clearCache(key);
  });

  it('sweeps every route that goes through cached(), with none left out', () => {
    // The value of the sweep is that it is exhaustive: a feed route added
    // without a row above would otherwise slip past it in silence.
    expect(ROUTES).toHaveLength([...WORKER_SOURCE.matchAll(/cached\(url\.origin,/g)].length);
  });
});

// A TTL at or under the card's poll interval expires just before every poll:
// the board's scheduler awaits the fetch, THEN waits interval ±15%, so a board
// alone on a route found the entry gone about half the time and every one of
// those polls cost an upstream fetch. Each row is a route, its cache key, the
// least upstream that gets a 200, and the TTL it must advertise: ~1.5x the
// poller's meta.refreshMs (named per row; the widget files are the source).
describe('route TTLs sit above the card poll interval', () => {
  const YAHOO = { chart: { result: [{
    meta: { symbol: 'AAPL', regularMarketPrice: 200, chartPreviousClose: 190 },
    timestamp: [1, 2], indicators: { quote: [{ close: [190, 200] }] },
  }] } };
  const FERRY = GtfsRt.transit_realtime.FeedMessage.encode(
    GtfsRt.transit_realtime.FeedMessage.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1783123914 }, entity: [],
    }),
  ).finish();
  const TEAM = { team: { abbreviation: 'NYY', shortDisplayName: 'Yankees', record: { items: [{ summary: '48-37' }] }, nextEvent: [] } };
  const any = (body, extra = {}) => [{ match: /./, body, times: 12, ...extra }];

  const TTLS = [
    // [path, cache key, upstream, env, TTL] — poller and its refreshMs alongside
    ['/amtrak/departures', 'amtrak', any({}), {}, 90], // amtrak.js 60s
    ['/ferry/departures', 'ferry', any(FERRY, { raw: true }), {}, 90], // ferry.js 60s
    ['/path/realtime', 'path', any({}), {}, 90], // path.js 60s
    // markets.js 5 min. A quote that cannot say its market is closed is judged
    // trading: 240s, UNDER the poll on purpose. See 'quote freshness by trading'.
    ['/markets?symbols=aapl', 'markets:AAPL', any(YAHOO), {}, 240],
    ['/golf', 'golf', any({}), {}, 450], // golf.js 5 min
    ['/tennis', 'tennis', any({}), {}, 450], // tennis.js 5 min
    ['/tfl/status', 'tfl', any([]), {}, 180], // tfl.js 2 min
    ['/alerts/subway', 'alerts:subway', any({ entity: [] }), {}, 180], // subway.js 2 min
    ['/alerts/lirr', 'alerts:lirr', any({ entity: [] }), {}, 120], // lirr.js 60s (already 2x)
    ['/alerts/mnr', 'alerts:mnr', any({ entity: [] }), {}, 120], // mnr.js 60s (already 2x)
    // sports.js 2 min. This row is idle (no game, nothing scheduled). A live
    // row is 60s, UNDER the poll on purpose: see '/sports/team TTL by game state'.
    ['/sports/team?lg=mlb&id=nyy', 'sports:mlb:nyy', any(TEAM), {}, 900],
    ['/njt/departures', njtKey(), [
      { match: /getToken/, body: TOKEN_RESPONSE, times: 2 },
      { match: /getStation/, body: [], times: 4 },
    ], NJT_ENV, 180], // njt.js 2 min
  ];

  it.each(TTLS)('%s', async (path, key, routes, extraEnv, ttl) => {
    await clearCache(key);
    stubFetch(routes);
    const res = await call(path, {}, extraEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(`public, max-age=${ttl}`);
    await clearCache(key);
  });
});

// A CODES stand-in with the KV surface the setup-code routes touch, recording
// every write. Overrides break exactly one operation for a single case.
const mockCodes = (over = {}) => {
  const store = new Map();
  const puts = [];
  const deletes = [];
  return {
    store, puts, deletes,
    get: over.get ?? ((k) => Promise.resolve(store.has(k) ? store.get(k) : null)),
    put: over.put ?? ((k, v) => { puts.push(k); store.set(k, v); return Promise.resolve(); }),
    delete: over.delete ?? ((k) => { deletes.push(k); store.delete(k); return Promise.resolve(); }),
  };
};

// Mint and redeem go through the REAL route handlers, exactly as the monitor's
// selfFetch does in production. worker.fetch is the guarded entry, which changes
// only how an unexpected throw is reported (a 500 rather than a rejection).
const selfFetchWith = (e) => (p, init) => worker.fetch(new Request(`https://api.test${p}`, init), e, ctx);

describe('setup-code canary: write cycle (cron only)', () => {
  // Every check but the canary needs the network, and the network is dead here
  // on purpose: only the `code` row is under test, and a dead upstream lets the
  // rest of the report resolve immediately.
  beforeEach(async () => {
    stubFetch([]);
    await clearThrottle();
  });

  // The canary waits out the /code throttle window before its one retry (see
  // codeWriteCycle). Tests hand it a stub in place of that 11 s sleep: the
  // default is a no-op, so the window is still shut when the retry mints, and a
  // case that wants the window to have REOPENED clears the throttle inside it.
  const canary = async (codes, sleep = async () => {}) => {
    const e = { ...env, CODES: codes };
    const report = await runHealthChecks(e, selfFetchWith(e), fetch, { writeCycle: true, sleep });
    return report.results.find((r) => r.name === 'code');
  };

  it('mints, redeems, and confirms the cfg came back, for two writes', async () => {
    const codes = mockCodes();
    expect(await canary(codes)).toMatchObject({ ok: true, detail: 'ok (mint+redeem)' });
    expect(codes.puts).toHaveLength(1);
    expect(codes.puts[0]).toMatch(/^code:[ABCDEFGHJKMNPQRSTVWXYZ0-9]{6}$/);
    expect(codes.deletes).toEqual(codes.puts); // single use: the canary leaves nothing behind
    expect(codes.store.size).toBe(0);
    expect(codes.store.has('code:HEALTH')).toBe(false); // the read-mode key is never written
  });

  it('fails as mint HTTP 503 when the namespace refuses the write (the 1000/day cap)', async () => {
    const result = await canary(mockCodes({ put: () => Promise.reject(new Error('KV PUT failed: 429')) }));
    expect(result).toMatchObject({ ok: false, detail: 'mint HTTP 503' });
  });

  it('fails as redeem HTTP 404 when the minted code cannot be read back', async () => {
    // The half of the pairing flow a mint-only check would call healthy.
    const result = await canary(mockCodes({ get: () => Promise.resolve(null) }));
    expect(result).toMatchObject({ ok: false, detail: 'redeem HTTP 404' });
  });

  it('fails as cfg mismatch when the payload does not round-trip', async () => {
    const store = new Map();
    const codes = {
      get: (k) => Promise.resolve(store.has(k) ? store.get(k) : null),
      put: (k) => { store.set(k, '{"canary":false}'); return Promise.resolve(); }, // stored, but not what was minted
      delete: (k) => { store.delete(k); return Promise.resolve(); },
    };
    expect(await canary(codes)).toMatchObject({ ok: false, detail: 'cfg mismatch' });
  });

  it('waits out a throttled mint and retries once — the duplicate-cron case', async () => {
    // The 2026-08-21 page. Cron delivery is at-least-once; both twins mint with
    // no CF-Connecting-IP, so both land in the 'anon' bucket and the second is
    // rejected by the first. Nothing is wrong, so the retry (once the 10 s
    // window has passed, here the sleep stub clearing it) must succeed — and say
    // so, or a duplicate that starts firing every run becomes invisible.
    const codes = mockCodes();
    expect((await canary(codes)).ok).toBe(true); // the first twin
    const sleep = vi.fn(() => clearThrottle()); // the window reopening
    expect(await canary(codes, sleep)).toMatchObject({
      ok: true,
      detail: 'ok (mint+redeem, after throttle retry)',
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(10000); // past the 10 s window
    expect(codes.puts).toHaveLength(2); // one code per successful cycle, no more
  });

  it('still fails when the retry is throttled too (one retry, never a loop)', async () => {
    // The default no-op sleep leaves the window shut, so the retry draws the
    // same 429 — which is now a real signal that something else is holding the
    // bucket, and it pages.
    const codes = mockCodes();
    expect((await canary(codes)).ok).toBe(true);
    expect(await canary(codes)).toMatchObject({ ok: false, detail: 'mint HTTP 429' });
    expect(codes.puts).toHaveLength(1); // the first cycle's; neither retry minted
  });

  it('never retries a non-429: a 503 mint fails at once, with no wait', async () => {
    // The retry is a throttle affordance, not a general one. A 500/503/timeout
    // is the outage signal this canary exists for and must not be softened by
    // an 11-second second chance.
    const attempts = [];
    const sleep = vi.fn(async () => {});
    const codes = mockCodes({
      put: (k) => { attempts.push(k); return Promise.reject(new Error('KV PUT failed: 429')); },
    });
    expect(await canary(codes, sleep)).toMatchObject({ ok: false, detail: 'mint HTTP 503' });
    expect(sleep).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(1); // one mint attempt, not two
  });
});

describe('the setup-code write budget stays off the public path', () => {
  // /health is public and unauthenticated: an external pinger may poll it as
  // fast as it likes, and KV writes are capped at 1000/day, a cap whose
  // exhaustion has already broken setup codes once. So the public route spends
  // zero writes while the cron, at 72 runs a day, spends two per run.
  it('GET /health writes NOTHING to CODES; a cron run puts one code and deletes it', async () => {
    stubFetch([]);
    await clearThrottle('anon', 'https://api.roomboard.app'); // the monitor's own selfFetch origin
    const codes = mockCodes();
    const e = { ...env, CODES: codes };

    const res = await worker.fetch(new Request('https://api.test/health'), e, ctx);
    const row = (await res.json()).results.find((r) => r.name === 'code');
    expect(row).toMatchObject({ ok: true, detail: 'ok (read)' });
    expect(codes.puts).toEqual([]);
    expect(codes.deletes).toEqual([]);

    const waits = [];
    await worker.scheduled({}, e, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.all(waits);
    // The cycle's own two writes. The cron's other KV write, the alert state,
    // is counted separately below: it only spends a write when the failing set
    // CHANGES, which this first-ever run does (empty → the dead network's set).
    expect(codes.puts.filter((k) => k.startsWith('code:'))).toHaveLength(1);
    expect(codes.deletes).toHaveLength(1);
    expect(codes.puts.filter((k) => k === 'health:laststate')).toHaveLength(1);
  });
});

describe('the health alert state lives in KV, because the Cache API is colo-local', () => {
  // The 2026-08-19 weather red and the 2026-08-21 code red both went out and
  // never cleared. The alert state (which checks were failing last run) sat in
  // the Cache API, which is per-colo: the run that saw the recovery landed
  // somewhere else, read no prior state, saw all green, concluded nothing had
  // changed and swallowed the all-clear forever. KV is global, so the recovering
  // run finds the red no matter which colo it woke up in.
  const SLACK = 'https://hooks.slack.com/services/T/B/x';
  const STATE_KEY = 'health:laststate';
  const SELF_ORIGIN = 'https://api.roomboard.app'; // selfFetch's own hostname (see index.js)
  const stateKeys = (codes) => codes.puts.filter((k) => k === STATE_KEY);

  // Every feed route rides cached(), so a seeded fresh entry answers its check
  // without the route dialing an upstream at all — which is the only sane way to
  // get a wholly green report (the alerts and ferry feeds are protobuf). gdrive
  // and njt need no seed: with no GDRIVE_KEY and no NJT credentials both answer
  // 503 *_not_configured, which the monitor scores as a skip, not an outage.
  const GREEN_FEEDS = [
    ['markets:^DJI,^GSPC,^IXIC', { indices: [{ symbol: '^DJI', price: 52376.73 }] }],
    ['amtrak', { station: 'New York Penn', departures: [] }],
    ['svc:m365', { services: [{ id: 'm365', state: 'ok' }] }],
    ['sports:mlb:nyy', { row: { lg: 'mlb', abbr: 'NYY' } }],
    ['path', { stations: { NWK: { ToNY: [], ToNJ: [] } } }],
    ['alerts:subway', { alerts: [] }],
    ['ferry', { trips: [] }],
  ];
  const feedKey = (key) => new Request(`${SELF_ORIGIN}/__cache/fresh/${encodeURIComponent(key)}`);
  const seedGreenFeeds = () => Promise.all(GREEN_FEEDS.map(([key, body]) => caches.default.put(
    feedKey(key),
    new Response(JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), stale: false, ...body }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=300',
        'X-Fresh-Until': String(Date.now() + 300000),
      },
    }),
  )));
  // The seeds are this describe's alone; anything left behind would quietly
  // green another file's report.
  afterEach(() => Promise.all(GREEN_FEEDS.map(([key]) => caches.default.delete(feedKey(key)))));

  // The green network: the six externally-probed origins. Built fresh per run —
  // stubFetch consumes a route's `times` in place, so a shared table would run
  // dry partway through the file.
  const greenNet = () => [
    { match: /roomboard\.app\/version\.json/, body: { version: '2026.08.21-abc1234' } },
    { match: /unsleep\.app\/version\.json/, body: { version: '2026.08.21-abc1234' } },
    { match: /idlescreen\.app\/version\.json/, body: { version: '2026.08.21-abc1234' } },
    { match: /unsleep\.io\/data\/changelog\.json/, body: [{ date: 'August 18', items: [] }] },
    { match: /idlescreen\.io\/data\/changelog\.json/, body: [{ date: 'August 18', items: [] }] },
    { match: /api\.open-meteo\.com/, body: { hourly: { temperature_2m: [70, 71] } } },
  ];
  const slackRoute = () => ({ match: /hooks\.slack\.com/, times: 3, body: { ok: true } });

  // One cron run. `env` is rebuilt every time and the Cache API is left to
  // whatever the last run did, so the ONLY thing two runs share deliberately is
  // the KV mock — the different-colo simulation. Returns the messages that
  // actually went out, since the text is what an operator sees.
  const cron = async (codes, routes = [], extraEnv = {}) => {
    const posted = [];
    stubFetch([...routes, slackRoute()]); // a case's own route wins the match
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('hooks.slack.com')) posted.push(JSON.parse(init.body).text);
      return inner(input, init);
    });
    await clearThrottle('anon', SELF_ORIGIN); // the canary's own bucket, per run
    const e = { ...env, CODES: codes, ALERT_WEBHOOK: SLACK, ...extraEnv };
    const waits = [];
    await worker.scheduled({}, e, { waitUntil: (p) => waits.push(p), passThroughOnException() {} });
    await Promise.all(waits);
    return posted;
  };

  it('the red pages, the recovery pages too — across a fresh isolate and a cold cache', async () => {
    // The exact sequence that broke twice. Run one is red (the network is dead),
    // run two is wholly green; nothing carries between them but the KV.
    const codes = mockCodes();
    const red = await cron(codes);
    expect(red).toHaveLength(1);
    expect(red[0]).toContain('🔴 idlescreen health:');
    expect(JSON.parse(codes.store.get(STATE_KEY)).failing.length).toBeGreaterThan(0);

    // Wake up in another colo: the entry the alert state USED to live in is
    // gone. (Only that entry — a real cold colo would also miss the feed caches
    // seeded below, but those are scenery here; the alert state is the subject.)
    await caches.default.delete(new Request(`${SELF_ORIGIN}/__health/laststate`));
    await seedGreenFeeds();
    const clear = await cron(codes, greenNet());
    expect(clear).toHaveLength(1);
    expect(clear[0]).toContain('✅ idlescreen health: all clear');
    expect(clear[0]).toContain('recovered:');
    expect(JSON.parse(codes.store.get(STATE_KEY))).toEqual({ failing: [] });
  });

  it('never touches the Cache API key it used to live under', async () => {
    // The old mechanism, named so a revert is loud: a colo-local state entry is
    // precisely what swallowed the all-clear.
    const codes = mockCodes();
    await cron(codes);
    expect(await caches.default.match(new Request(`${SELF_ORIGIN}/__health/laststate`))).toBeFalsy();
    expect(codes.store.has(STATE_KEY)).toBe(true);
  });

  it('writes only when the failing set CHANGES (the 1000/day cap)', async () => {
    // 72 runs a day through a namespace that broke setup codes once when its
    // write cap was drained. An ongoing outage must cost nothing.
    const codes = mockCodes();
    await cron(codes);
    expect(stateKeys(codes)).toHaveLength(1); // [] → the dead network's set
    const silent = await cron(codes);
    expect(silent).toEqual([]); // unchanged, so no page
    expect(stateKeys(codes)).toHaveLength(1); // and no second write
    await cron(codes);
    expect(stateKeys(codes)).toHaveLength(1);
  });

  it('reserves a key no minted code can collide with, and lets it expire', async () => {
    const codes = mockCodes();
    const puts = [];
    codes.put = (k, v, opts) => { puts.push([k, v, opts]); codes.store.set(k, v); return Promise.resolve(); };
    await cron(codes);
    const [key, , opts] = puts.find(([k]) => k === STATE_KEY);
    expect(key.startsWith('code:')).toBe(false); // real codes are code: + 6 CODE_ALPHABET chars
    expect(opts.expirationTtl).toBe(7 * 24 * 3600); // an abandoned deployment evaporates
  });

  it('degrades to no-prior-state when the KV read fails, without throwing', async () => {
    // A read error must look like a first run (one duplicate page at worst),
    // never an exception out of the scheduled handler — that would skip the
    // heartbeat and make a healthy cron look dead.
    const codes = mockCodes({ get: (k) => (k === 'health:laststate'
      ? Promise.reject(new Error('KV GET failed: 429 daily limit'))
      : Promise.resolve(null)) });
    const posted = await cron(codes);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('🔴');
  });

  it('survives a KV write failure: the page still goes out', async () => {
    const codes = mockCodes({ put: (k, v) => (k === 'health:laststate'
      ? Promise.reject(new Error('KV PUT failed: 429'))
      : (codes.store.set(k, v), Promise.resolve())) });
    const posted = await cron(codes);
    expect(posted).toHaveLength(1); // the alert is what matters; the state is best-effort
  });

  it('re-pages next run when the alert was NOT delivered (at-least-once, unregressed)', async () => {
    // A Slack blip must not advance the state, or the only page for that outage
    // is lost. The undelivered run also writes nothing: the set it would store
    // is the one already there.
    const codes = mockCodes();
    const dead = { match: /hooks\.slack\.com/, times: 3, status: 500, body: { error: 'nope' } };
    const posted = await cron(codes, [dead]);
    expect(posted).toHaveLength(1); // attempted
    expect(stateKeys(codes)).toHaveLength(0); // but not remembered
    const again = await cron(codes);
    expect(again).toHaveLength(1); // so the next run pages again
    expect(again[0]).toContain('🔴');
  });
});
