// A fleet-wide id -> value map kept in ONE Cache API entry, for routes whose
// cache key is a SET of ids (a board's watchlist, its chosen stations) while the
// upstream is fetched one id at a time. cached() keys on the whole set, so two
// boards that share nine of ten symbols used to fetch all ten twice; this layer
// sits underneath it and remembers each id on its own.
//
// Why one entry and not one per id: the Workers Free plan allows 50 subrequests
// per invocation, and every Cache API match() and put() counts against it
// exactly like a fetch(). Per-id entries would cost a match and a put per id on
// top of the fetches (20 symbols = 40 cache calls before a single quote), while
// one shared entry costs one match per call and one put only when something was
// actually fetched, however many ids there are.
//
// Contract:
//   sharedMapGet(origin, name, ids, fetchMissing, { freshS, retainS, maxEntries })
//     -> Promise<Map<id, { value, fetchedAt, freshUntil }>>
//   - freshS is each value's fresh life in seconds, counted from its fetch:
//     a number for every value alike, or (value, fetchedAtMs) => seconds when
//     the right life depends on what the value says (a quote from a closed
//     market can live longer than one still trading). The function is asked
//     afresh on every read and must depend only on its arguments, so a value's
//     life is fixed the moment it is fetched; a non-number answer counts as 0.
//   - Reads the map once. Every id still inside its fresh life is a hit.
//   - Calls fetchMissing(missingIds) ONLY when some id missed, never with an
//     empty list. It resolves to a Map (or plain object) of id -> value for the
//     ids it could fetch; an id it leaves out is a failure: not stored, not
//     returned, and retried on the next call. If it throws, the throw
//     propagates (nothing is written), so a caller like cached() can serve its
//     own stale fallback.
//   - Writes the map back once, only if something was fetched, after pruning
//     entries older than retainS and keeping at most maxEntries (newest first).
//   - Returns hits plus fresh fetches, keyed by id, each with freshUntil (epoch
//     ms), the end of its fresh life. An expired entry whose refetch failed is
//     NOT returned: this layer never serves stale data, the caller's own cache
//     decides that.
//   - Costs: exactly 1 Cache API match, plus 1 put when fetchMissing ran and
//     returned anything. Budget the fetches inside fetchMissing yourself.
//
// Accepted races: two concurrent misses both read, both fetch, and the last
// put wins, so an id fetched only by the losing writer is simply fetched again
// next time. The Cache API is colo-local and per zone (see cached() in
// index.js), so "fleet-wide" means every board behind one colo on one hostname.
//
// maxEntries bounds CPU as much as size: the entry is parsed on every call and
// re-serialized on every write, inside the 10 ms Free-plan CPU budget. Size a
// caller's cap from its value size (a markets quote with sparklines is ~1.5 KB).
//
// A digest assembled from these values and cached whole (cached() in index.js)
// can be born part-aged: a value reused at t=449 of a 450s life must not be
// served fresh until t=899 because the digest restarted the clock. A caller
// stamps the EARLIEST freshUntil among the values it used on its digest under
// FRESH_UNTIL_MS and hands cached() freshForEarliest(fallbackS) as its ttlS, so
// the digest lives only until its first part expires. With one freshS for every
// value that part is simply the oldest; with per-value lives it need not be (a
// quote fetched a minute ago while trading expires before one fetched ten
// minutes ago from a closed market). A symbol key, because JSON.stringify skips
// it: the served body is unchanged, while stamped()'s spread (and a mend's)
// copies it through to the ttl function.
//
// Should the symbol ever be lost on the way, the fallback is updatedAt (the
// oldest part's fetch, as both callers date their digests) plus fallbackS:
// pass the SHORTEST life a value can have, so the guess never outlives a part.
export const FRESH_UNTIL_MS = Symbol('earliest part freshUntil (ms)');

export const freshForEarliest = (fallbackS) => (digest) => {
  const untilMs = digest[FRESH_UNTIL_MS] ?? (digest.updatedAt + fallbackS) * 1000;
  return (untilMs - Date.now()) / 1000;
};

// The stamp for a digest built from these entries: the first to expire.
export const earliestFreshUntil = (entries) => Math.min(...entries.map((e) => e.freshUntil));

const DAY_S = 24 * 3600;

const mapKey = (origin, name) => new Request(`${origin}/__cache/map/${encodeURIComponent(name)}`);

// Unreadable or absent entry -> empty map. A corrupt entry is not an outage:
// the next write replaces it.
async function readEntries(cache, key) {
  try {
    const hit = await cache.match(key);
    if (!hit) return new Map();
    const parsed = await hit.json();
    const entries = new Map();
    for (const [id, e] of Object.entries(parsed?.entries ?? {})) {
      if (e && Number.isFinite(e.fetchedAt)) entries.set(id, { value: e.value, fetchedAt: e.fetchedAt });
    }
    return entries;
  } catch {
    return new Map();
  }
}

export async function sharedMapGet(origin, name, ids, fetchMissing, {
  freshS, retainS = DAY_S, maxEntries = 200, now = Date.now,
} = {}) {
  const cache = caches.default;
  const key = mapKey(origin, name);
  const entries = await readEntries(cache, key);
  const t = now();
  // End of a value's fresh life (epoch ms). Never before its fetch.
  const lifeOf = typeof freshS === 'function' ? freshS : () => freshS;
  const until = (value, fetchedAt) => {
    const s = lifeOf(value, fetchedAt);
    return fetchedAt + (Number.isFinite(s) ? Math.max(0, s) : 0) * 1000;
  };
  const out = new Map();
  const missing = [];
  for (const id of new Set(ids)) {
    const e = entries.get(id);
    const freshUntil = e && until(e.value, e.fetchedAt);
    if (e && t < freshUntil) out.set(id, { ...e, freshUntil });
    else missing.push(id);
  }
  if (!missing.length) return out;

  const got = await fetchMissing(missing);
  const fetched = got instanceof Map ? got : new Map(Object.entries(got ?? {}));
  let wrote = false;
  for (const id of missing) {
    if (!fetched.has(id)) continue;
    const e = { value: fetched.get(id), fetchedAt: t };
    entries.set(id, e);
    out.set(id, { ...e, freshUntil: until(e.value, t) });
    wrote = true;
  }
  if (!wrote) return out;

  // Prune on the way out: drop what is past retainS, then keep the newest
  // maxEntries so a day of one-off symbols cannot grow the entry without bound.
  const kept = [...entries]
    .filter(([, e]) => t - e.fetchedAt < retainS * 1000)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, maxEntries);
  try {
    await cache.put(key, new Response(JSON.stringify({ entries: Object.fromEntries(kept) }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${retainS}` },
    }));
  } catch {
    // Best effort, like every put in cached(): a lost write costs one refetch.
  }
  return out;
}
