import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deviceId, beaconPayload, reportWidgetHealth, healthVector, resetWidgetHealth,
  reportTap, reportWorkerFetch, resetUsage, serveChannel, viewportSize, saverId, unitsCode,
} from '../site/js/fleet.js';
import { fetchJSON, onWorkerFetch } from '../site/js/net.js';
import { WORKER_URL } from '../site/js/env.js';
import { normalizeConfig } from '../site/js/config.js';

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m };
};

describe('deviceId', () => {
  it('creates a uuid, persists it, and returns the same id next time', () => {
    const s = memStorage();
    const id = deviceId(s);
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    expect(s.map.get('sgn.device')).toBe(id);
    expect(deviceId(s)).toBe(id);
  });
  it('regenerates when the stored value is junk', () => {
    const s = memStorage({ 'sgn.device': '<script>alert(1)</script>' });
    expect(deviceId(s)).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('tags the id ephemeral when storage throws — sessions, not devices', () => {
    const broken = { getItem() { throw new Error('nope'); }, setItem() { throw new Error('nope'); } };
    expect(deviceId(broken)).toMatch(/^e-[a-f0-9-]{36}$/);
  });
  it('tags the id ephemeral when storage lies — accepts the write, keeps nothing', () => {
    // Private-mode behaviour: setItem does not throw, but nothing persists.
    const liar = { getItem() { return null; }, setItem() { /* swallowed */ } };
    expect(deviceId(liar)).toMatch(/^e-[a-f0-9-]{36}$/);
  });
  it('never persists the ephemeral prefix — a working store gets a plain uuid', () => {
    const s = memStorage();
    expect(deviceId(s)).not.toMatch(/^e-/);
    expect(s.map.get('sgn.device')).not.toMatch(/^e-/);
  });
});

describe('beaconPayload', () => {
  it('carries widget ids, mode, version, tz — and nothing personal', () => {
    const cfg = normalizeConfig({ name: 'Sean', mode: 'scheduled' });
    const p = beaconPayload(cfg, 'abc-123', '9d757c6ee919');
    expect(p.widgets).toEqual(cfg.layout.map((r) => r.id));
    expect(p.mode).toBe('scheduled');
    expect(p.version).toBe('9d757c6ee919');
    expect(typeof p.tz).toBe('string');
    expect(JSON.stringify(p)).not.toContain('Sean'); // no PII on the wire
  });
  it('falls back to unknown when the version fetch failed', () => {
    expect(beaconPayload(normalizeConfig({}), 'abc-123', null).version).toBe('unknown');
  });
});

describe('widget health vector (Tier 2, exceptions only — backlog item 9)', () => {
  it('collects only unhealthy widgets and clears them on recovery', () => {
    resetWidgetHealth();
    expect(healthVector()).toBe('');
    reportWidgetHealth('lirr', 'stale');
    reportWidgetHealth('njt', 'error');
    expect(healthVector()).toBe('lirr=stale,njt=error');
    reportWidgetHealth('lirr', null); // recovered: drops out entirely
    expect(healthVector()).toBe('njt=error');
    resetWidgetHealth();
    expect(healthVector()).toBe('');
  });
  it('caps a pathological vector with a truncation mark', () => {
    resetWidgetHealth();
    for (let i = 0; i < 40; i += 1) reportWidgetHealth(`w${String(i).padStart(2, '0')}xxxxxxxxxx`, 'error');
    const v = healthVector();
    expect(v.length).toBeLessThanOrEqual(200);
    expect(v.endsWith('…')).toBe(true);
    resetWidgetHealth();
  });
  it('rides the beacon payload as `health`', () => {
    resetWidgetHealth();
    reportWidgetHealth('markets', 'error');
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').health).toBe('markets=error');
    resetWidgetHealth();
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').health).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Runtime fields (2026-08-10). Counters and enums only — the payload gained no
// way to carry content, and the cfg.beacon opt-out still governs all of it.
// ---------------------------------------------------------------------------
describe('serving channel', () => {
  it('reads the deployment off the hostname', () => {
    expect(serveChannel({ hostname: 'roomboard.app' })).toBe('prod');
    expect(serveChannel({ hostname: 'idlescreen.app' })).toBe('prod');
    expect(serveChannel({ hostname: 'beta.roomboard.app' })).toBe('beta');
    expect(serveChannel({ hostname: 'beta.idlescreen.app' })).toBe('beta');
    expect(serveChannel({ hostname: 'localhost' })).toBe('dev');
    expect(serveChannel({ hostname: '127.0.0.1' })).toBe('dev');
  });
  it('reads a rename as new hosts, never as new channel values', () => {
    // The dashboard keys on these three strings, so the 2026-08-18 unsleep
    // hosts must land in the SAME buckets the old names do. A brand that
    // minted its own channel value would split every historical series.
    expect(serveChannel({ hostname: 'app.unsleep.app' })).toBe('prod');
    expect(serveChannel({ hostname: 'unsleep.io' })).toBe('prod');
    expect(serveChannel({ hostname: 'beta.unsleep.io' })).toBe('beta');
    expect(serveChannel({ hostname: 'beta.unsleep.app' })).toBe('beta');
  });
  it('never mistakes a lookalike host for beta', () => {
    // The prefix must be the whole first label: a host that merely starts with
    // the letters is production.
    expect(serveChannel({ hostname: 'betaboards.example.com' })).toBe('prod');
    expect(serveChannel({ hostname: 'my-beta.roomboard.app' })).toBe('prod');
  });
  it('falls back to prod with no location at all (tests, odd embeddings)', () => {
    expect(serveChannel(null)).toBe('prod');
    expect(serveChannel({})).toBe('prod');
    expect(serveChannel()).toBe('prod'); // node: `location` is undefined
  });
});

describe('viewport, saver and units', () => {
  it('reports the glass the device handed the page', () => {
    expect(viewportSize({ innerWidth: 1920, innerHeight: 1040 })).toBe('1920x1040'); // Board Pro
    expect(viewportSize({ innerWidth: 1920, innerHeight: 1200 })).toBe('1920x1200'); // Navigator
    expect(viewportSize({ innerWidth: 1920.4, innerHeight: 1039.6 })).toBe('1920x1040'); // fractional px
  });
  it('reports nothing rather than a fake size when there is no window', () => {
    expect(viewportSize(null)).toBe('');
    expect(viewportSize({})).toBe('');
    expect(viewportSize({ innerWidth: 0, innerHeight: 0 })).toBe('');
    expect(viewportSize()).toBe(''); // node: no window
  });
  it('resolves the screensaver to a bare id, with none for off', () => {
    const cfg = (screensaver, over = {}) => normalizeConfig({ screensaver: { source: screensaver }, ...over });
    expect(saverId(cfg('art'))).toBe('art');
    expect(saverId(cfg('clockrow'))).toBe('clockrow');
    expect(saverId(cfg('worldclocks'))).toBe('worldclocks');
    // A photo source with no album falls back to the art slideshow, and the
    // beacon reports what is ACTUALLY on screen, not what was picked.
    expect(saverId(cfg('photos'))).toBe('art');
    expect(saverId(cfg('photos', { photos: { album: 'B1m5fk75vLWwX' } }))).toBe('photos');
    // 'off' is a legacy value the picker no longer offers and normalizeConfig
    // no longer keeps, so it only reaches ambientSource on a raw config —
    // where it returns null and the beacon says 'none' rather than ''.
    expect(saverId({ screensaver: { source: 'off' } })).toBe('none');
  });
  it('never emits a saver id the worker would throw away', () => {
    // The worker bound is /^[a-z][a-z0-9]{0,19}$/ — anything else must arrive
    // already normalized rather than being silently dropped at the edge.
    const bound = /^[a-z][a-z0-9]{0,19}$/;
    expect(saverId({ screensaver: { source: 'Some Source!' } })).toMatch(bound);
    expect(saverId({ screensaver: { source: '99redballoons' } })).toBe('none'); // leading digit
    expect(saverId({ screensaver: { source: 'x'.repeat(60) } })).toMatch(bound);
    expect(saverId({})).toMatch(bound); // default 'art'
  });
  it('pairs temperature and clock preference in one code', () => {
    expect(unitsCode(normalizeConfig({}))).toBe('F12');
    expect(unitsCode(normalizeConfig({ clock24: true }))).toBe('F24');
    expect(unitsCode(normalizeConfig({ loc: { units: 'C' } }))).toBe('C12');
    expect(unitsCode(normalizeConfig({ loc: { units: 'C' }, clock24: true }))).toBe('C24');
    expect(unitsCode({})).toBe('F12'); // no config at all still reads the default
  });
});

describe('usage counters (per beacon window)', () => {
  beforeEach(() => resetUsage());

  it('counts taps and drains them into each payload', () => {
    reportTap();
    reportTap();
    reportTap();
    const first = beaconPayload(normalizeConfig({}), 'abc-123', 'v1');
    expect(first.taps).toBe(3);
    // Per WINDOW, not per page life: the next beacon starts from zero, which is
    // what lets the dashboard divide by days.
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').taps).toBe(0);
    reportTap();
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').taps).toBe(1);
  });

  it('reports the MEDIAN worker latency, so one timeout is not the fleet number', () => {
    for (const ms of [10, 20, 30, 40, 15000]) reportWorkerFetch(ms);
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(30);
  });

  it('averages the two middle samples on an even count, and rounds to an integer', () => {
    reportWorkerFetch(10);
    reportWorkerFetch(15);
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(13); // 12.5 -> 13
  });

  it('reports 0 — not NaN — with no samples at all', () => {
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(0);
  });

  it('keeps only the newest 60 samples', () => {
    // 100 rising samples: a 60-deep ring holds 41..100, whose median is 70.5.
    for (let i = 1; i <= 100; i += 1) reportWorkerFetch(i);
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(71); // 70.5 -> 71
  });

  it('ignores junk samples instead of poisoning the median', () => {
    reportWorkerFetch(100);
    reportWorkerFetch(NaN);
    reportWorkerFetch(Infinity);
    reportWorkerFetch(-5);
    reportWorkerFetch(undefined);
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(100);
  });

  it('drains the latency ring as well as the tap counter', () => {
    reportWorkerFetch(500);
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(500);
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(0);
  });
});

// fleet.js registers reportWorkerFetch with net.js at module init rather than
// net.js importing fleet.js, which would close a fleet -> net -> fleet cycle.
// Importing net.js here AFTER fleet.js is what a real page does (main.js pulls
// in both), so the hook is already installed.
describe('worker-latency hook (fleet registers itself with net.js)', () => {
  const okFetch = () => vi.fn(async () => ({ ok: true, json: async () => ({ ok: 1 }) }));
  let realFetch;
  // net.js times with Date.now() deltas. Freeze the clock so a fetch measures
  // EXACTLY 0ms: on a loaded machine the "0ms" samples below picked up 1-2ms
  // of real time and nudged the exact-median assertions (200 became 201) —
  // a run-to-run flake, caught 2-of-3 runs on 2026-08-10.
  beforeEach(() => { resetUsage(); realFetch = globalThis.fetch; vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000); });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('times OUR worker and reports it to the beacon', async () => {
    globalThis.fetch = okFetch();
    await fetchJSON(`${WORKER_URL}/weather?lat=1&lon=2`);
    // A same-tick fetch is 0ms, which is a real reading and not "no sample" —
    // the tell is that a sample exists at all.
    const p = beaconPayload(normalizeConfig({}), 'abc-123', 'v1');
    expect(p.wkrMs).toBe(0);
    expect(onWorkerFetch).toBeTypeOf('function'); // the hook IS installed
  });

  it('ignores third-party feeds — their latency says nothing about the deploy', async () => {
    globalThis.fetch = okFetch();
    reportWorkerFetch(500); // one real worker sample
    await fetchJSON('https://api.weather.example/forecast');
    await fetchJSON('version.json');
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(500);
  });

  it('still records a worker call that FAILED — a slow worker must not read fast', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(fetchJSON(`${WORKER_URL}/markets`)).rejects.toThrow('HTTP 503');
    reportWorkerFetch(400);
    // Two samples: the 0ms failure and the 400ms success -> median 200.
    expect(beaconPayload(normalizeConfig({}), 'abc-123', 'v1').wkrMs).toBe(200);
  });
});

describe('beaconPayload runtime fields', () => {
  const cfg = () => normalizeConfig({ name: 'Sean' });

  beforeEach(() => resetUsage());
  afterEach(() => { delete globalThis.window; });

  it('carries the whole runtime set, and still nothing personal', () => {
    const p = beaconPayload(cfg(), 'abc-123', 'v1', { channel: 'beta', viewport: '1920x1040' });
    expect(p).toMatchObject({
      channel: 'beta', viewport: '1920x1040', saver: 'art', units: 'F12',
      bootMs: 0, bootRetries: 0, taps: 0, wkrMs: 0,
    });
    expect(JSON.stringify(p)).not.toContain('Sean');
  });

  it('derives channel and viewport itself when the caller hands over no context', () => {
    const p = beaconPayload(cfg(), 'abc-123', 'v1');
    expect(p.channel).toBe('prod'); // no location in this environment
    expect(p.viewport).toBe('');    // no window either
  });

  it('reads the boot facts main.js and bootguard.js stashed on window', () => {
    globalThis.window = { __bootMs: 2481.7, __bootRetries: 2 };
    expect(beaconPayload(cfg(), 'abc-123', 'v1')).toMatchObject({ bootMs: 2482, bootRetries: 2 });
  });

  it('reads 0 for boot facts that are absent or nonsense (old build, broken clock)', () => {
    globalThis.window = {};
    expect(beaconPayload(cfg(), 'abc-123', 'v1')).toMatchObject({ bootMs: 0, bootRetries: 0 });
    globalThis.window = { __bootMs: 'soon', __bootRetries: -1 };
    expect(beaconPayload(cfg(), 'abc-123', 'v1')).toMatchObject({ bootMs: 0, bootRetries: 0 });
    globalThis.window = { __bootMs: Infinity, __bootRetries: NaN };
    expect(beaconPayload(cfg(), 'abc-123', 'v1')).toMatchObject({ bootMs: 0, bootRetries: 0 });
  });
});
