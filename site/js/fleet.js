// Anonymous usage heartbeat (Tier 2 metrics): once an hour the board POSTs a
// tiny payload to the worker's /fleet route so the operator can count active
// devices and see widget adoption. No PII — a random locally-generated device
// id, the widget ids on the layout, the display mode, the running site
// version, and the coarse IANA timezone. Toggle: Settings → Diagnostics
// ("Anonymous usage ping", cfg.beacon); the tick re-reads the config so a
// saved toggle takes effect without a reload.
//
// It also carries a handful of counters and enums about how the board is
// RUNNING — serving channel, viewport, screensaver source, unit preferences,
// boot time, boot retries, taps, worker latency. Every one of them is a number
// or a fixed-vocabulary string; none of them is, or can become, content. The
// opt-out above still turns the whole thing off.

import { schedule } from './scheduler.js';
import { fetchJSON, setWorkerFetchHook } from './net.js';
import { WORKER_URL } from './env.js';
import { ambientSource } from './modes.js';

const DEVICE_KEY = 'sgn.device';
const HOUR_MS = 60 * 60 * 1000;

// Stable random device id, persisted in localStorage. Regenerated if storage
// was wiped (Diagnostics "Clear web storage") — anonymity-preserving.
//
// When the id CANNOT be persisted it is tagged with an `e-` prefix so the
// stats side can count it as a session, not a device: a storage-blocked kiosk
// otherwise mints a fresh "device" on every reload and paints the daily-actives
// chart with phantom first-seens (diagnosed 2026-08-10 — the chronic half of
// the inflation; the other half was the quadrille.io domain adds, where a new
// origin means a new localStorage and a legitimate one-time re-identity; the
// unsleep.app / unsleep.io adds of 2026-08-18 do the same thing once, so read
// that first-seen bump as boards moving house rather than as growth).
// The write is verified by reading back, because private-mode storage can
// accept a write and persist nothing without throwing. The prefix still
// matches the worker's parseBeacon bound (`e` is a hex character), so old
// workers pass it through unchanged.
export function deviceId(storage) {
  let id = null;
  try {
    id = storage.getItem(DEVICE_KEY);
  } catch {
    // storage unavailable: fall through to a per-session id
  }
  if (id && /^[a-f0-9-]{8,64}$/i.test(id)) return id;
  id = crypto.randomUUID();
  try {
    storage.setItem(DEVICE_KEY, id);
    if (storage.getItem(DEVICE_KEY) === id) return id;
  } catch {
    // best effort
  }
  return `e-${id}`;
}

// Widget-level health (Tier 2, backlog item 9): exceptions only. The runtime
// reports each widget's refresh outcome (error / worker-stale / recovered)
// and the hourly beacon carries the UNHEALTHY set as compact id=state pairs
// ("lirr=stale,njt=error"), so a widget silently broken across the fleet
// shows up in roomboard-stats instead of waiting for a colleague to mention
// it. Healthy boards send ''. No new cadence, no new endpoint, no PII. The
// map cannot outlive a layout: boards reload on config and deploy changes.
const HEALTH_MAX = 200;
const widgetHealth = new Map();

export function reportWidgetHealth(id, state) {
  if (!id) return;
  if (state) widgetHealth.set(id, state);
  else widgetHealth.delete(id);
}

export function resetWidgetHealth() {
  widgetHealth.clear();
}

export function healthVector() {
  const s = [...widgetHealth].map(([id, state]) => `${id}=${state}`).join(',');
  return s.length > HEALTH_MAX ? `${s.slice(0, HEALTH_MAX - 1)}…` : s;
}

// Usage counters (Tier 2). Same idiom as the health map above: the runtime
// reports events in, the hourly beacon drains them out. Both are PER-BEACON-
// WINDOW — building a payload zeroes them — so a number always means "since the
// last ping" and never "since this page loaded", which is what makes the
// dashboard able to divide by days. Counters only, never what was tapped.
const WKR_SAMPLES = 60; // an hour of worker calls at the widgets' refresh rates
let taps = 0;
const wkrSamples = [];

export function reportTap() {
  taps += 1;
}

export function reportWorkerFetch(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  wkrSamples.push(ms);
  if (wkrSamples.length > WKR_SAMPLES) wkrSamples.shift(); // keep the newest window
}

// Test seam, mirroring resetWidgetHealth: a payload drains these on its own, so
// nothing in the runtime needs it.
export function resetUsage() {
  taps = 0;
  wkrSamples.length = 0;
}

// Median, not mean: one 15s timeout must not become the fleet's "latency".
const medianMs = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};

// Which deployment this board is actually served by, so the stats app can stop
// GUESSING at beta rigs from version lineage (its documented fallback). Derived
// from the hostname, which is the only honest source: beta.* is the dev channel
// (beta.idlescreen.app, beta.roomboard.app, beta.unsleep.io), loopback is a
// laptop, everything else is production. No location at all (a test, an odd
// embedding) reads 'prod' rather than inventing a third state.
//
// Deliberately reads the first LABEL, never the brand: the three values are the
// whole vocabulary the stats app keys on, so a rename adds hosts here and
// changes no reported value. Renaming the channels instead would silently split
// every historical series in two.
export function serveChannel(loc = typeof location === 'undefined' ? null : location) {
  const host = String(loc?.hostname ?? '');
  if (host.startsWith('beta.')) return 'beta';
  if (host === 'localhost' || host === '127.0.0.1') return 'dev';
  return 'prod';
}

// The glass the device actually handed the page ('1920x1040' on a Board Pro,
// '1920x1200' on a Navigator). Fleet-wide this is how a new device class shows
// up before anyone files a bug about the layout on it.
export function viewportSize(win = typeof window === 'undefined' ? null : window) {
  const w = Math.round(Number(win?.innerWidth) || 0);
  const h = Math.round(Number(win?.innerHeight) || 0);
  return w > 0 && h > 0 ? `${w}x${h}` : '';
}

// The screensaver actually in force, as a bare lowercase id. ambientSource()
// resolves the picker against the config (a photo source with no album falls
// back to 'art') and returns null for the legacy 'off', which is 'none' here.
// Normalized hard because this crosses the wire into a bounded worker field.
export function saverId(cfg) {
  const raw = String(ambientSource(cfg) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  return /^[a-z]/.test(raw) ? raw : 'none';
}

// Temperature + clock preferences as one 4-char code ('F12', 'C24'). Two enums
// in one field: it is the pair that is interesting (nobody runs C with 12h).
export function unitsCode(cfg) {
  return `${cfg?.loc?.units === 'C' ? 'C' : 'F'}${cfg?.clock24 ? '24' : '12'}`;
}

// Boot facts the page stashes on `window`: main.js writes __bootMs as its
// last act before the loaded flag, and bootguard.js writes __bootRetries when
// it clears a retry counter. Both are constant for the life of the page, and
// absent (0) is a perfectly ordinary reading — an old build, or a board that
// booted first try.
const winNumber = (key) => {
  const v = typeof window === 'undefined' ? undefined : window[key];
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
};

// `ctx` carries the values startBeacon resolved ONCE for the page (channel,
// viewport): neither can change without a reload, so re-deriving them on every
// hourly tick would be waste. Callers that omit it (tests) get them derived
// on the spot.
export function beaconPayload(cfg, id, version, ctx = {}) {
  const payload = {
    deviceId: id,
    widgets: (cfg.layout ?? []).map((r) => r.id),
    mode: cfg.mode,
    version: version || 'unknown',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    health: healthVector(),
    channel: ctx.channel ?? serveChannel(),
    viewport: ctx.viewport ?? viewportSize(),
    saver: saverId(cfg),
    units: unitsCode(cfg),
    bootMs: winNumber('__bootMs'),
    bootRetries: winNumber('__bootRetries'),
    taps,
    wkrMs: medianMs(wkrSamples),
  };
  // Drain optimistically. postBeacon is fire-and-forget by design (sendBeacon
  // reports nothing back), so there is no delivery to wait for and no honest
  // way to retry — carrying the counters forward on a failure would silently
  // double-count the next window instead.
  resetUsage();
  return payload;
}

// Fire-and-forget POST. A plain-string body is a "simple request" (text/plain,
// no CORS preflight); sendBeacon also survives page unload/reload.
export function postBeacon(payload, nav = navigator) {
  const body = JSON.stringify(payload);
  const url = `${WORKER_URL}/fleet`;
  if (nav.sendBeacon?.(url, body)) return;
  fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
}

// Hourly loop. The page reloads on every deploy (self-healing version check),
// so the running version is constant per page lifetime — fetched once here.
export function startBeacon(getCfg) {
  // Accessing window.localStorage THROWS (not returns null) on storage-blocked
  // kiosks; deviceId(null) is safe (both accessors are guarded) and yields a
  // per-session id.
  let ls = null;
  try { ls = window.localStorage; } catch { /* blocked storage */ }
  const id = deviceId(ls);
  // Fixed for the page's life, exactly like the id: neither the serving host
  // nor the device's viewport can change without a reload.
  const ctx = { channel: serveChannel(), viewport: viewportSize() };
  const versionP = fetchJSON('version.json').then((v) => v.version).catch(() => 'unknown');
  return schedule(async () => {
    const cfg = getCfg();
    if (!cfg || cfg.beacon === false) return;
    postBeacon(beaconPayload(cfg, id, await versionP, ctx));
  }, HOUR_MS);
}

// Let net.js time OUR worker's calls without importing this module (that would
// close a fleet -> net -> fleet cycle). Registered at module init so a board
// starts sampling the moment the graph loads, not only once startBeacon runs.
setWorkerFetchHook(reportWorkerFetch);
