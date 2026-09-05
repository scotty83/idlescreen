import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { loadConfig, saveConfig, loadCache, saveCache, cacheStampFor, cacheAgeOf, cacheFingerprint } from '../site/js/store.js';
import { schedule, msUntilNextLocalMidnight, dailyRefresh } from '../site/js/scheduler.js';
import { resolveMode, stepTime, fmtHM } from '../site/js/modes.js';
import { normalizeConfig, encodeConfig } from '../site/js/config.js';

// store.js resolves storage via window.localStorage; provide a conformant
// in-memory implementation (Node's own localStorage global is a flag-gated
// stub, and vitest's DOM environments cannot override it).
const mem = new Map();
const fakeStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

beforeAll(() => {
  vi.stubGlobal('window', { localStorage: fakeStorage });
});

beforeEach(() => window.localStorage.clear());

describe('store', () => {
  it('round-trips config through localStorage', async () => {
    const cfg = normalizeConfig({ name: 'Sean', t: 42 });
    await saveConfig(cfg);
    expect(await loadConfig()).toEqual(cfg);
  });
  it('returns null for missing or corrupt config', async () => {
    expect(await loadConfig()).toBeNull();
    fakeStorage.setItem('sgn.cfg', '!!corrupt!!');
    expect(await loadConfig()).toBeNull();
  });
  it('round-trips feed caches with timestamps', () => {
    saveCache('weather', { now: { temp: 80 } }, 1234);
    expect(loadCache('weather')).toEqual({ t: 1234, data: { now: { temp: 80 } } });
    expect(loadCache('missing')).toBeNull();
  });
});

// F10: a Worker stale fallback carries its data's own age (updatedAt); storing
// it under the wall clock, and reading the storage time back, resets the
// displayed "as of" to now on every reload.
describe('cache freshness stamps', () => {
  afterEach(() => vi.useRealTimers());

  it('stamps a stale payload with its own source time, not the wall clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z')); // "now" = noon
    const eightAm = Math.floor(new Date('2026-09-04T08:00:00Z').getTime() / 1000);
    expect(cacheStampFor({ stale: true, updatedAt: eightAm })).toBe(eightAm);
  });

  it('falls back to now for a fresh payload with no source time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    const now = Math.floor(Date.now() / 1000);
    expect(cacheStampFor({ temp: 80 })).toBe(now);
    expect(cacheStampFor(undefined)).toBe(now);
    expect(cacheStampFor({ updatedAt: NaN })).toBe(now);
  });

  it('prefers a payload updatedAt over the write time when showing age', () => {
    const eightAm = 1_757_318_400; // some epoch seconds
    // Written at noon, but the digest is from 8 AM: 8 AM is the age to show.
    expect(cacheAgeOf({ t: eightAm + 4 * 3600, data: { updatedAt: eightAm } })).toBe(eightAm);
    // No source time: the write time is all we have.
    expect(cacheAgeOf({ t: 500, data: { temp: 80 } })).toBe(500);
    expect(cacheAgeOf({ t: 500, data: null })).toBe(500);
    expect(cacheAgeOf(null)).toBeNull();
  });

  it('round-trips a stale payload so a reload keeps its true age', () => {
    const eightAm = 1_757_318_400;
    const vm = { stale: true, updatedAt: eightAm, temp: 72 };
    saveCache('weather', vm, cacheStampFor(vm));
    expect(cacheAgeOf(loadCache('weather'))).toBe(eightAm);
  });
});

// F09: a widget cache addressed only by id is rendered under any new config;
// stamping the fetch inputs and reading with the same subset makes a changed
// source (a swapped album, a moved location) a cache miss, not a wrong render.
describe('cache fingerprint gating', () => {
  it('a cache stamped for one input set is a miss for another', () => {
    const fpA = cacheFingerprint({ album: 'A' });
    const fpB = cacheFingerprint({ album: 'B' });
    saveCache('photos', { photos: ['a'] }, 1, fpA);
    expect(loadCache('photos', fpA)?.data).toEqual({ photos: ['a'] }); // same inputs → hit
    expect(loadCache('photos', fpB)).toBeNull();                        // changed album → miss
  });

  it('leaves id-only readers and non-fingerprinted caches exactly as they were', () => {
    saveCache('lirr', { departures: [] }, 5); // a module with no declared inputs
    expect(loadCache('lirr')).toEqual({ t: 5, data: { departures: [] } }); // stored shape unchanged
    // A fingerprinted cache is still visible to an id-only read (opt-in gating).
    saveCache('photos', { photos: ['a'] }, 1, cacheFingerprint({ album: 'A' }));
    expect(loadCache('photos')?.data).toEqual({ photos: ['a'] });
  });

  it('rejects a legacy cache written before fingerprints existed', () => {
    saveCache('photos', { photos: ['a'] }, 1); // pre-fix cache: no fp stored
    expect(loadCache('photos', cacheFingerprint({ album: 'A' }))).toBeNull();
  });

  it('is order-independent, so a cosmetic key reshuffle is not a new source', () => {
    expect(cacheFingerprint({ lat: 1, lon: 2 })).toBe(cacheFingerprint({ lon: 2, lat: 1 }));
    expect(cacheFingerprint(null)).toBeNull();
  });
});

describe('theme (retired)', () => {
  it('legacy theme keys are accepted and dropped — old configs/QRs still decode', () => {
    expect(normalizeConfig({ theme: 'momentum' }).theme).toBeUndefined();
    expect(normalizeConfig({ theme: 'dark' }).theme).toBeUndefined();
    expect(normalizeConfig({}).theme).toBeUndefined();
  });
});

describe('scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs immediately, then at jittered intervals', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const cancel = schedule(fn, 1000, { jitter: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('holds the first run for startDelayMs, then keeps the normal cadence', async () => {
    // Boot stagger (main.js deals each widget a slot): only the FIRST run moves.
    const fn = vi.fn().mockResolvedValue(undefined);
    const cancel = schedule(fn, 1000, { jitter: 0, startDelayMs: 600 });
    await vi.advanceTimersByTimeAsync(599);
    expect(fn).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2); // interval, not interval + delay
    cancel();
  });

  it('defaults to an immediate first run', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const cancel = schedule(fn, 1000, { jitter: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    cancel();
  });

  it('keeps jitter within bounds', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const delays = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, ms) => {
      delays.push(ms);
      return origSetTimeout(cb, ms);
    });
    const cancel = schedule(fn, 1000, { jitter: 0.2 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1300);
    cancel();
    for (const d of delays.slice(1)) {
      expect(d).toBeGreaterThanOrEqual(800);
      expect(d).toBeLessThanOrEqual(1200);
    }
  });

  it('backs off exponentially on failure and resets on success', async () => {
    let failures = 3;
    const fn = vi.fn().mockImplementation(() =>
      failures-- > 0 ? Promise.reject(new Error('x')) : Promise.resolve(),
    );
    const delays = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, ms) => {
      delays.push(ms);
      return origSetTimeout(cb, ms);
    });
    const cancel = schedule(fn, 1000, { jitter: 0 });
    await vi.advanceTimersByTimeAsync(0);      // fail 1
    await vi.advanceTimersByTimeAsync(2000);   // fail 2 (delay 2000)
    await vi.advanceTimersByTimeAsync(4000);   // fail 3 (delay 4000)
    await vi.advanceTimersByTimeAsync(8000);   // success (delay 8000)
    await vi.advanceTimersByTimeAsync(1000);   // back to base
    cancel();
    expect(delays.slice(1, 5)).toEqual([2000, 4000, 8000, 1000]);
  });

  it('caps backoff at 8x the interval', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    const delays = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, ms) => {
      delays.push(ms);
      return origSetTimeout(cb, ms);
    });
    const cancel = schedule(fn, 1000, { jitter: 0 });
    for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(8000);
    cancel();
    expect(Math.max(...delays)).toBe(8000);
  });

  // F08: a function interval lets a daily widget schedule against the local
  // calendar instead of a fixed period; it is recomputed after each run.
  it('accepts a function interval, recomputed after each run', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const delays = [3000, 7000];
    let i = 0;
    const cancel = schedule(fn, () => delays[Math.min(i++, delays.length - 1)], { jitter: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1); // immediate first run
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(2); // used the first computed delay
    await vi.advanceTimersByTimeAsync(6999);
    expect(fn).toHaveBeenCalledTimes(2); // and the second, not before it elapses
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    cancel();
  });
});

// F08: daily widgets turn over with the local DATE, not 24h after the last
// fetch. A jittered 24h interval drifts off the date boundary; a calendar
// schedule lands on it.
describe('daily calendar scheduling', () => {
  afterEach(() => vi.useRealTimers());

  it('measures the time to the next LOCAL midnight', () => {
    expect(msUntilNextLocalMidnight(new Date(2026, 8, 4, 22, 30))).toBe(90 * 60 * 1000);
    // At midnight, a full day to the NEXT one — never a zero-delay hot loop.
    expect(msUntilNextLocalMidnight(new Date(2026, 8, 4, 0, 0))).toBe(24 * 60 * 60 * 1000);
  });

  it('dailyRefresh waits for midnight on success, retries soon on failure', () => {
    const at2230 = new Date(2026, 8, 4, 22, 30).getTime();
    const next = dailyRefresh({ retryMs: 5 * 60 * 1000, jitterMs: 0, now: () => at2230 });
    expect(next({ failed: false })).toBe(90 * 60 * 1000);        // to the date boundary
    expect(next({ failed: true })).toBe(5 * 60 * 1000);          // not a whole day later
  });

  it('drives a schedule across the local date boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 4, 23, 59)); // one minute to midnight
    const fn = vi.fn().mockResolvedValue(undefined);
    const cancel = schedule(fn, dailyRefresh({ jitterMs: 0 }), { jitter: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1); // fetch now
    await vi.advanceTimersByTimeAsync(60 * 1000 - 1);
    expect(fn).toHaveBeenCalledTimes(1); // nothing before midnight
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2); // refreshes AT the boundary
    cancel();
  });
});

describe('resolveMode', () => {
  const cfg = (mode) => ({ mode });
  const at = (h, m = 0) => new Date(2026, 6, 2, h, m); // a Thursday
  it('respects explicit modes', () => {
    expect(resolveMode(cfg('dashboard'), at(23))).toBe('dashboard');
    expect(resolveMode(cfg('ambient'), at(8))).toBe('ambient');
  });
  it('scheduled with the default schedule matches the old commute windows', () => {
    // cfg('scheduled') has no `schedule` → resolveMode falls back to DEFAULT_SCHEDULE.
    expect(resolveMode(cfg('scheduled'), at(6))).toBe('dashboard');
    expect(resolveMode(cfg('scheduled'), at(9, 59))).toBe('dashboard');
    expect(resolveMode(cfg('scheduled'), at(10))).toBe('ambient'); // end exclusive
    expect(resolveMode(cfg('scheduled'), at(15))).toBe('dashboard');
    expect(resolveMode(cfg('scheduled'), at(19, 59))).toBe('dashboard');
    expect(resolveMode(cfg('scheduled'), at(20))).toBe('ambient');
    expect(resolveMode(cfg('scheduled'), at(2))).toBe('ambient');
  });
  it('scheduled honors a custom schedule; empty schedule → always art', () => {
    const custom = { mode: 'scheduled', schedule: [{ start: 480, end: 1020 }] }; // 8am–5pm
    expect(resolveMode(custom, at(9))).toBe('dashboard');
    expect(resolveMode(custom, at(17))).toBe('ambient'); // 17:00 == end, exclusive
    expect(resolveMode(custom, at(6))).toBe('ambient');
    expect(resolveMode({ mode: 'scheduled', schedule: [] }, at(9))).toBe('ambient');
  });
});

describe('stepTime / fmtHM', () => {
  it('steps 15 minutes and wraps a day', () => {
    expect(stepTime(600, 1)).toBe(615);
    expect(stepTime(0, -1)).toBe(1425);
    expect(stepTime(1425, 1)).toBe(0);
  });
  it('formats 12-hour with AM/PM (noon and midnight)', () => {
    expect(fmtHM(0)).toBe('12:00 AM');
    expect(fmtHM(360)).toBe('6:00 AM');
    expect(fmtHM(720)).toBe('12:00 PM');
    expect(fmtHM(1215)).toBe('8:15 PM');
    expect(fmtHM(1440)).toBe('12:00 AM');
  });
});
