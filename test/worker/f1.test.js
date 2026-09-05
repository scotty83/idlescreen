import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../worker/src/index.js';
import { mapF1, fetchF1 } from '../../worker/src/f1.js';
import nextFx from './fixtures/f1-next.json';
import lastFx from './fixtures/f1-last.json';
import driversFx from './fixtures/f1-drivers.json';
import teamsFx from './fixtures/f1-teams.json';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, init, extraEnv = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, init), { ...env, ...extraEnv }, ctx);

const cacheKey = (kind, key) => new Request(`https://api.test/__cache/${kind}/${encodeURIComponent(key)}`);
const clearCache = (key) =>
  Promise.all([caches.default.delete(cacheKey('fresh', key)), caches.default.delete(cacheKey('stale', key))]);

describe('mapF1', () => {
  const d = mapF1(nextFx, lastFx, driversFx, teamsFx);

  it('maps the next race', () => {
    // The CARD's four fields, pinned. The digest carries more for the expanded
    // season view (round, circuitId, the weekend's sessions) — those are
    // test/f1-expand.test.js's, and this stays about what the card reads.
    expect(d.next).toMatchObject({ name: 'Belgian Grand Prix', date: '2026-07-19', circuit: 'Circuit de Spa-Francorchamps', country: 'Belgium' });
  });
  it('extracts the last race podium (top 3, winner first, with nationality + team)', () => {
    expect(d.lastRace).toBe('British Grand Prix');
    expect(d.podium).toHaveLength(3);
    expect(d.podium[0]).toEqual({ pos: 1, driver: 'Leclerc', nat: 'Monegasque', cid: 'ferrari' });
    expect(d.podium.map((p) => p.pos)).toEqual([1, 2, 3]);
  });
  it('maps driver standings with numeric points and the current constructor', () => {
    expect(d.drivers[0]).toMatchObject({ pos: 1, name: 'Antonelli', nat: 'Italian', cid: 'mercedes' });
    expect(typeof d.drivers[0].pts).toBe('number');
    expect(d.drivers.map((x) => x.pos)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('maps constructor standings ordered by position', () => {
    expect(d.teams[0]).toMatchObject({ pos: 1, cid: 'mercedes', name: 'Mercedes', pts: 333 });
    expect(d.teams[1].cid).toBe('ferrari');
  });
  it('tolerates a null next race (offseason) and empty blocks without throwing', () => {
    const off = mapF1(null, lastFx, driversFx, teamsFx);
    expect(off.next).toBeNull();
    expect(off.podium).toHaveLength(3); // other blocks intact
    const empty = mapF1(null, null, null, null);
    expect(empty).toMatchObject({ next: null, lastRace: null, podium: null, drivers: [], teams: [] });
  });
});

describe('GET /f1', () => {
  afterEach(async () => { await clearCache('f1'); vi.unstubAllGlobals(); });

  it('fans out to Jolpica, merges, and serves one digest', async () => {
    const body = { next: nextFx, 'last/results': lastFx, driverStandings: driversFx, constructorStandings: teamsFx };
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      const key = Object.keys(body).find((k) => url.includes(`/current/${k}/`));
      return new Response(JSON.stringify(body[key]), { status: 200 });
    }));
    const res = await call('/f1');
    expect(res.status).toBe(200);
    const digest = await res.json();
    expect(digest.next.name).toBe('Belgian Grand Prix');
    expect(digest.podium[0].driver).toBe('Leclerc');
    expect(digest.drivers[0].name).toBe('Antonelli');
    expect(digest.teams[0].cid).toBe('mercedes');
  });

  it('survives a partial upstream failure (one block null, digest still served)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/constructorStandings/')) return new Response('down', { status: 503 });
      const map = { next: nextFx, 'last/results': lastFx, driverStandings: driversFx };
      const key = Object.keys(map).find((k) => url.includes(`/current/${k}/`));
      return new Response(JSON.stringify(map[key]), { status: 200 });
    }));
    const digest = await (await call('/f1')).json();
    expect(digest.drivers.length).toBeGreaterThan(0);
    expect(digest.teams).toEqual([]); // failed block empty, not fatal
  });

  it('caps the sequential fan-out at the deadline and still serves the answered block (F13)', async () => {
    // 'next' answers instantly; 'last/results' hangs until its own abort fires,
    // by which point the budget is spent and the last two blocks are skipped.
    // Before the budget, four 10s fetches in series stacked to ~40s and failed
    // the whole card. A tiny injected budget keeps the test near-instant.
    vi.stubGlobal('fetch', vi.fn((input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/current/next/')) return Promise.resolve(new Response(JSON.stringify(nextFx), { status: 200 }));
      // A slow upstream that honours its abort signal, exactly as fetch does
      // when AbortSignal.timeout fires.
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }));
    const digest = await fetchF1({ deadlineMs: 1500 });
    expect(digest.next.name).toBe('Belgian Grand Prix'); // the block that answered survives
    expect(digest.partial).toBe(true); // the rest didn't finish -> partial (mendF1 backfills)
    expect(digest.drivers).toEqual([]); // a skipped block degrades to empty
    expect(digest.teams).toEqual([]);
  });
});
