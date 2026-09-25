import { describe, it, expect, vi, afterEach } from 'vitest';
import { sharedMapGet } from '../../worker/src/sharedmap.js';

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
});
