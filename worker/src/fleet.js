// Anonymous usage beacon (Tier 2 metrics): boards POST a tiny heartbeat to
// /fleet hourly; the route writes one Analytics Engine data point per ping.
// No KV (write caps), no caching, no PII — the device id is a random UUID the
// board generates locally, and tz is the coarse IANA zone name.

// Exported so the /fleet route can bound the transport read to the same ceiling
// parseBeacon enforces, rejecting an oversized upload before buffering it.
export const MAX_BODY = 2048;
const MODES = new Set(['scheduled', 'dashboard', 'ambient']);

// Numeric beacon fields: a plain count with a sane ceiling. Anything that is
// not a finite number in range — absent (an old board), a string, NaN,
// Infinity, negative, or an absurd value from a broken clock — reads 0, which
// is also the legitimate "nothing to report" value. The ceiling matters as
// much as the floor: an unbounded double poisons a fleet-wide median forever.
const bounded = (v, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 0;
};

// Parse + validate a beacon body. Returns the normalized payload, or null for
// anything malformed (the route answers 400 — boards never retry beacons).
export function parseBeacon(text) {
  if (typeof text !== 'string' || text.length > MAX_BODY) return null;
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof b?.deviceId !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(b.deviceId)) return null;
  if (!Array.isArray(b.widgets)) return null;
  // Widget ids are a leading letter then lowercase alphanumerics (e.g. 'f1',
  // 'worldclock') — digits MUST be allowed or numbered widgets like f1 get
  // silently dropped from adoption. Still rejects markup, numeric-only, oversized.
  // Deliberately SHAPE-only, never a WIDGET_IDS membership check: boards that
  // still carry a card the site has since removed (World Cup, deleted
  // 2026-07-29) keep reporting it, and the adoption history in the stats repo
  // depends on those pings arriving instead of being filtered at the edge.
  const widgets = [...new Set(b.widgets.filter((w) => typeof w === 'string' && /^[a-z][a-z0-9]{1,19}$/.test(w)))].slice(0, 32);
  return {
    deviceId: b.deviceId.toLowerCase(),
    widgets,
    mode: MODES.has(b.mode) ? b.mode : 'unknown',
    version: typeof b.version === 'string' && /^[\w.-]{1,20}$/.test(b.version) ? b.version : 'unknown',
    tz: typeof b.tz === 'string' && /^[\w/+-]{1,40}$/.test(b.tz) ? b.tz : '',
    // Widget health (site fleet.js, backlog item 9): compact id=state pairs,
    // exceptions only, lowercase like widget ids; '…' is the site's
    // truncation mark. Optional and shape-bounded like version/tz — old
    // boards send nothing and normalize to ''.
    health: typeof b.health === 'string' && /^[a-z0-9=,…]{1,200}$/u.test(b.health) ? b.health : '',
    // ---- runtime fields (site fleet.js, 2026-08-10) --------------------------
    // Every one of these is OPTIONAL: boards on older builds omit them all, and
    // the empty string / 0 they normalize to means "this build does not report
    // it", never "the value is off". The stats app treats '' as unknown and
    // falls back to its own heuristics, so a mixed fleet reads correctly while
    // it self-updates.
    //
    // Serving channel — '' rather than a 'prod' default ON PURPOSE: defaulting
    // would tell the stats app "this board is definitely production" about
    // every old board that never said anything, disabling the version-lineage
    // fallback that is currently the only way it spots a beta rig.
    channel: typeof b.channel === 'string' && /^(prod|beta|dev)$/.test(b.channel) ? b.channel : '',
    viewport: typeof b.viewport === 'string' && /^\d{3,4}x\d{3,4}$/.test(b.viewport) ? b.viewport : '',
    // Same shape as a widget id (leading letter, lowercase alphanumerics), so
    // 'none' — the site's word for a screensaver that is off — passes as data.
    saver: typeof b.saver === 'string' && /^[a-z][a-z0-9]{0,19}$/.test(b.saver) ? b.saver : '',
    units: typeof b.units === 'string' && /^[FC](12|24)$/.test(b.units) ? b.units : '',
    bootMs: bounded(b.bootMs, 600000),   // 10 min: past that it is not a boot
    bootRetries: bounded(b.bootRetries, 99),
    taps: bounded(b.taps, 10000),        // per hour-ish window, so generous
    wkrMs: bounded(b.wkrMs, 60000),      // the site's own fetch timeout is 15s
  };
}

// Country is the ISO-3166 alpha-2 the edge resolved for the request (NOT the
// board — the board sends no location). 'XX' when unknown/absent.
const country = (c) => (typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'XX');

// Cisco RoomOS WebEngine puts the device model in its User-Agent:
//   Mozilla/5.0 (Linux; RoomOS; Cisco Board Pro) AppleWebKit/...
// Parse it edge-side from the UA header (the board sends nothing). Non-RoomOS
// traffic (a desktop preview, the e2e test) has no such segment → 'other'.
export function deviceModel(ua) {
  const m = /RoomOS;\s*([^)]+)/i.exec(String(ua ?? ''));
  if (!m) return 'other';
  return m[1].replace(/\s*\(.*$/, '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'other';
}

// The hostname the page was actually served from — the fact the stats app
// needs to answer "which URL is each board on", now that the fleet spans
// three brands' worth of live hostnames and channel (blob8) deliberately
// collapses them all to 'prod'. Parsed edge-side from the Origin header
// (sendBeacon and keepalive fetch both send it cross-origin; the board adds
// nothing), hostname only — scheme and port carry no signal here. '' when
// absent or unparseable (a curl, a null Origin), so the unknown reads as
// unknown instead of inventing a host.
export function originHost(o) {
  try {
    const host = new URL(String(o)).hostname.toLowerCase();
    return /^[a-z0-9.-]{1,64}$/.test(host) ? host : '';
  } catch {
    return '';
  }
}

// Analytics Engine shape. The index is the device id so AE's sampling keys on
// devices, not pings; blobs carry the dimensions, doubles the counters.
//
// THE COLUMNS ARE POSITIONAL AND THE SCHEMA IS APPEND-ONLY. Analytics Engine
// has no column names — the stats app reads blob1..blobN / double1..doubleN by
// position — so reordering or reusing a slot silently rewrites the meaning of
// every row already stored. New fields go on the END, and a retired field
// leaves its slot behind as dead space rather than letting the ones after it
// shift up.
//
//   blob1  deviceId   blob5  widgets   blob9   health    blob13  origin
//   blob2  version    blob6  country   blob10  viewport
//   blob3  mode       blob7  model     blob11  saver
//   blob4  tz         blob8  channel   blob12  units
//   double1 widget count   double2 bootMs   double3 bootRetries
//   double4 taps           double5 wkrMs
//
// blob8 was reserved-and-empty from the beacon's first day for exactly this
// (backlog item 32); the serving channel LANDED there 2026-08-10, so the slot
// is now live and blob9's health has never had to move.
//
// blob13 (2026-08-19): the serving origin hostname, stamped by the route from
// the Origin header the same way country and model are — edge-derived, so
// every board reports it from its next heartbeat with no board-side change.
//
// p.country, p.model and p.origin are stamped by the route from the request,
// not the payload. The `|| ''` / `|| 0` fallbacks let a caller hand over a raw payload
// that predates these fields without minting undefined columns.
export function beaconDataPoint(p) {
  return {
    indexes: [p.deviceId],
    blobs: [
      p.deviceId, p.version, p.mode, p.tz, p.widgets.join(','), country(p.country), p.model || 'other',
      p.channel || '', p.health || '', p.viewport || '', p.saver || '', p.units || '',
      p.origin || '',
    ],
    doubles: [p.widgets.length, p.bootMs || 0, p.bootRetries || 0, p.taps || 0, p.wkrMs || 0],
  };
}
