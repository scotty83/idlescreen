import { describe, it, expect, vi, afterEach } from 'vitest';
import { sharedMapGet, freshForEarliest, earliestFreshUntil, FRESH_UNTIL_MS } from '../../worker/src/sharedmap.js';

// The contract a later caller (per-provider service status, Citi Bike) builds
// on, pinned against the real Cache API: one read, a write only when something
// was fetched, failures never stored, the entry pruned by age and by count.
const ORIGIN = 'https://api.test';
const NAME = 'test:map';
const KEY = new Request(`${ORIGIN}/__cache/map/${encodeURIComponent(NAME)}`);
const T = Date.parse('2026-09-24T12:00:00Z');
const now = () => T;

const seed = (entries) => caches.default.put(KEY, new Response(JSON.stringify({ entries }), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
}));
const stored = async () => (await (await caches.default.match(KEY))?.json())?.entries ?? null;
const values = (m) => Object.fromEntries([...m].map(([id, e]) => [id, e.value]));

afterEach(() => caches.default.delete(KEY));

describe('sharedMapGet', () => {
  it('fetches only what is missing or expired, and stores it with its fetch time', async () => {
    await seed({
      a: { value: 'a-fresh', fetchedAt: T - 60_000 },
      b: { value: 'b-old', fetchedAt: T - 301_000 },
    });
    const fetchMissing = vi.fn(async (ids) => new Map(ids.map((id) => [id, `${id}-new`])));
    const got = await sharedMapGet(ORIGIN, NAME, ['a', 'b', 'c'], fetchMissing, { freshS: 300, now });
    expect(fetchMissing).toHaveBeenCalledTimes(1);
    expect(fetchMissing).toHaveBeenCalledWith(['b', 'c']); // a is inside freshS
    expect(values(got)).toEqual({ a: 'a-fresh', b: 'b-new', c: 'c-new' });
    expect(got.get('a').fetchedAt).toBe(T - 60_000); // a hit keeps its real age
    expect(await stored()).toEqual({
      a: { value: 'a-fresh', fetchedAt: T - 60_000 },
      b: { value: 'b-new', fetchedAt: T },
      c: { value: 'c-new', fetchedAt: T },
    });
  });

  it('never calls fetchMissing, or writes, when every id is fresh', async () => {
    await seed({ a: { value: 1, fetchedAt: T - 1000 } });
    const put = vi.spyOn(caches.default, 'put');
    const fetchMissing = vi.fn();
    const got = await sharedMapGet(ORIGIN, NAME, ['a', 'a'], fetchMissing, { freshS: 300, now });
    expect(fetchMissing).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(values(got)).toEqual({ a: 1 });
    put.mockRestore();
  });

  it('leaves a failed id out of both the answer and the entry, so it retries next call', async () => {
    await seed({ a: { value: 'a-old', fetchedAt: T - 999_000 } });
    const got = await sharedMapGet(ORIGIN, NAME, ['a', 'b'], async () => ({ b: 'b-new' }), { freshS: 300, now });
    // The expired a is NOT served as a fallback: staleness is the caller's call.
    expect(values(got)).toEqual({ b: 'b-new' });
    const entries = await stored();
    expect(entries.a).toEqual({ value: 'a-old', fetchedAt: T - 999_000 }); // untouched, still expired
    expect(entries.b.fetchedAt).toBe(T);
  });

  it('skips the write when nothing was fetched', async () => {
    const put = vi.spyOn(caches.default, 'put');
    const got = await sharedMapGet(ORIGIN, NAME, ['a'], async () => new Map(), { freshS: 300, now });
    expect(got.size).toBe(0);
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });

  it('lets a fetchMissing throw propagate and writes nothing', async () => {
    await seed({ a: { value: 1, fetchedAt: T - 1000 } });
    await expect(sharedMapGet(ORIGIN, NAME, ['a', 'b'], async () => { throw new Error('upstream down'); }, { freshS: 300, now }))
      .rejects.toThrow('upstream down');
    expect(await stored()).toEqual({ a: { value: 1, fetchedAt: T - 1000 } });
  });

  it('prunes entries past retainS and keeps only the newest maxEntries', async () => {
    await seed({
      ancient: { value: 0, fetchedAt: T - 25 * 3600_000 }, // past the 24h default
      old: { value: 1, fetchedAt: T - 3 * 3600_000 },
      mid: { value: 2, fetchedAt: T - 2 * 3600_000 },
    });
    await sharedMapGet(ORIGIN, NAME, ['new'], async () => ({ new: 3 }), { freshS: 300, maxEntries: 2, now });
    expect(Object.keys(await stored()).sort()).toEqual(['mid', 'new']);
  });

  it('treats an unreadable entry as empty instead of failing', async () => {
    await caches.default.put(KEY, new Response('not json', { headers: { 'Cache-Control': 'max-age=60' } }));
    const got = await sharedMapGet(ORIGIN, NAME, ['a'], async () => ({ a: 1 }), { freshS: 300, now });
    expect(values(got)).toEqual({ a: 1 });
    expect(await stored()).toEqual({ a: { value: 1, fetchedAt: T } });
  });

  it('hands back each value\'s freshUntil: fetch time plus a numeric freshS', async () => {
    await seed({ a: { value: 1, fetchedAt: T - 60_000 } });
    const got = await sharedMapGet(ORIGIN, NAME, ['a', 'b'], async () => ({ b: 2 }), { freshS: 300, now });
    expect(got.get('a').freshUntil).toBe(T - 60_000 + 300_000);
    expect(got.get('b').freshUntil).toBe(T + 300_000);
    expect(await stored()).toEqual({ // freshUntil is derived on read, never stored
      a: { value: 1, fetchedAt: T - 60_000 },
      b: { value: 2, fetchedAt: T },
    });
  });

  // A quote from a closed market can live far longer than one still trading, so
  // freshS may be a function of the value, judged from its own fetch time.
  describe('per-value freshS', () => {
    const lifeOf = vi.fn((v) => v.life);
    const freshS = (value, fetchedAt) => lifeOf(value, fetchedAt);

    it('gives each value its own life, counted from its own fetch', async () => {
      lifeOf.mockClear();
      await seed({
        long: { value: { life: 1800 }, fetchedAt: T - 600_000 }, // 10 min into 30: a hit
        short: { value: { life: 240 }, fetchedAt: T - 300_000 }, // 5 min into 4: expired
      });
      const fetchMissing = vi.fn(async (ids) => new Map(ids.map((id) => [id, { life: 240 }])));
      const got = await sharedMapGet(ORIGIN, NAME, ['long', 'short'], fetchMissing, { freshS, now });
      expect(fetchMissing).toHaveBeenCalledWith(['short']);
      expect(got.get('long').freshUntil).toBe(T - 600_000 + 1800_000);
      expect(got.get('short').freshUntil).toBe(T + 240_000); // refetched now
      // Asked with the value and the instant it was fetched, not the read time.
      expect(lifeOf).toHaveBeenCalledWith({ life: 1800 }, T - 600_000);
      expect(lifeOf).toHaveBeenCalledWith({ life: 240 }, T);
    });

    it('treats a non-number life as already expired: refetched every time, never kept', async () => {
      await seed({ a: { value: { life: undefined }, fetchedAt: T - 1 } });
      const fetchMissing = vi.fn(async () => ({ a: { life: NaN } }));
      const got = await sharedMapGet(ORIGIN, NAME, ['a'], fetchMissing, { freshS, now });
      expect(fetchMissing).toHaveBeenCalledWith(['a']);
      expect(got.get('a').freshUntil).toBe(T);
    });
  });
});

// The cap on a digest built from map values and cached whole: it lives until
// its FIRST part expires, which with per-value lives need not be its oldest.
describe('freshForEarliest', () => {
  afterEach(() => vi.useRealTimers());

  it('lives until the earliest part expires, not the oldest part plus a constant', () => {
    vi.useFakeTimers({ now: T });
    const parts = [
      { fetchedAt: T - 600_000, freshUntil: T - 600_000 + 1800_000 }, // oldest, closed market: 20 min left
      { fetchedAt: T - 60_000, freshUntil: T - 60_000 + 240_000 }, // newer, trading: 3 min left
    ];
    const digest = { updatedAt: Math.floor((T - 600_000) / 1000), [FRESH_UNTIL_MS]: earliestFreshUntil(parts) };
    expect(freshForEarliest(240)(digest)).toBe(180);
  });

  it('with one life for every part, is exactly the oldest part\'s remainder (the /services rule)', () => {
    vi.useFakeTimers({ now: T });
    const parts = [T - 479_000, T - 10_000].map((fetchedAt) => ({ fetchedAt, freshUntil: fetchedAt + 480_000 }));
    const digest = { updatedAt: Math.floor((T - 479_000) / 1000), [FRESH_UNTIL_MS]: earliestFreshUntil(parts) };
    expect(freshForEarliest(480)(digest)).toBe(1);
  });

  it('falls back to updatedAt plus the shortest life should the stamp be lost', () => {
    vi.useFakeTimers({ now: T });
    expect(freshForEarliest(240)({ updatedAt: T / 1000 - 100 })).toBe(140);
  });
});
