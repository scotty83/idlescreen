// What the board keeps, and the one operation that changes it: the config and
// the widget caches in localStorage, and applyConfig, which puts a new config
// there and reloads onto it.
//
// The signage web-engine profile keeps this data across standby, reboots and
// RoomOS upgrades (per Cisco's WebEngine guide); if it is ever wiped, the
// `#cfg=` fragment in the board's own signage URL is the recovery layer
// (boot.js), and it needs nothing from this module to do its job.

import { encodeConfig, decodeConfig, normalizeConfig } from './config.js';

const CFG_KEY = 'sgn.cfg';
const CACHE_PREFIX = 'sgn.cache.';

// Resolve through window: Node >=22 defines a stub `localStorage` global that
// is undefined without a flag and would shadow the DOM one under test.
const storage = () => window.localStorage;

export async function loadConfig() {
  // getItem inside the try: a storage-unavailable throw here would otherwise
  // kill boot before the watchdog exists.
  try {
    const raw = storage().getItem(CFG_KEY);
    if (!raw) return null;
    return await decodeConfig(raw);
  } catch {
    return null;
  }
}

export async function saveConfig(cfg) {
  const encoded = await encodeConfig(cfg);
  try {
    storage().setItem(CFG_KEY, encoded);
  } catch {
    // Quota: the config MUST win over the best-effort widget caches — drop
    // them and retry once. A second failure propagates to the caller.
    for (let i = storage().length - 1; i >= 0; i--) {
      const k = storage().key(i);
      if (k && k.startsWith(CACHE_PREFIX)) storage().removeItem(k);
    }
    storage().setItem(CFG_KEY, encoded);
  }
}

/* ---------- applying a config to the board ---------- */

// A demo session is a showroom, not a board. Somebody opening /?demo=1 to look
// around must not have a config left behind in their browser, so nothing on
// this path persists. Resolved through window at call time for the same reason
// storage() is: the answer is a property of the page, not of module load order.
export function isDemoSession() {
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

// Applying a config to the board is ONE operation, and this is it: stamp it,
// persist it, reload.
//
// It was written twice before this (edit mode's Done and Settings' Save), and
// the copies had drifted the way copies do: only one of them honoured "a demo
// session never persists", and only one of them bothered to import the encoder
// lazily. Neither difference was a decision anybody made. The reload is the
// part that makes the rest inevitable, since it is the only way a layout or
// widget change actually reaches the screen, so it belongs to the operation
// rather than to whoever remembers to call it.
//
// `reload` is injectable so a test can watch the ritual finish without a real
// navigation; production never passes it.
export async function applyConfig(cfg, { reload = () => window.location.reload() } = {}) {
  // One fresh stamp, taken once, on the object that then goes everywhere: the
  // timestamp is what boot.js compares to pick the newest config, so a second
  // reading of the clock inside one apply could only produce disagreement.
  const applied = normalizeConfig({ ...cfg, t: Math.floor(Date.now() / 1000) });
  if (isDemoSession()) {
    // The reload still happens: it is how the demo returns to its fixtures.
    reload();
    return applied;
  }
  // Deliberately unguarded. A quota failure that survived saveConfig's retry
  // means the save did NOT happen, and reloading onto the old config while the
  // panel says "saved" is the one outcome worse than the error.
  await saveConfig(applied);
  reload();
  return applied;
}

// Order-independent stringify: two configs that differ only in key order share a
// fingerprint, so a cosmetic reshuffle never invalidates a cache.
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// A widget cache is addressed by widget id, but a widget's payload is only valid
// for the fetch inputs that produced it: a photo album's id, a weather location.
// A module hands its fetch-relevant config subset (meta.cacheInputs) here to
// stamp the cache, and passes the same subset when reading; presentation-only
// settings (a rotation interval, a unit) must be left OUT, since they change
// what the payload LOOKS like, not what it IS. Null (a module with no inputs to
// declare) means "no fingerprint" — today's id-only behaviour.
export function cacheFingerprint(inputs) {
  return inputs == null ? null : stableStringify(inputs);
}

export function saveCache(id, data, t = Math.floor(Date.now() / 1000), fp = null) {
  // Omit fp when absent so id-only caches keep their exact stored shape.
  const entry = fp == null ? { t, data } : { t, data, fp };
  try {
    storage().setItem(CACHE_PREFIX + id, JSON.stringify(entry));
  } catch {
    // Storage full or unavailable — cache is best-effort.
  }
}

export function loadCache(id, expectedFp = null) {
  try {
    const raw = storage().getItem(CACHE_PREFIX + id);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // A fingerprint mismatch means the stored payload was fetched for a
    // different source than the one the caller is now configured for (a swapped
    // album, a moved location). Treat it as a miss so the old source's data
    // cannot paint under the new config while the new fetch is still failing.
    if (expectedFp != null && entry?.fp !== expectedFp) return null;
    return entry;
  } catch {
    return null; // storage unavailable — best-effort, mirroring saveCache
  }
}

// The timestamp a payload should be STORED under. A Worker stale fallback (up to
// 24h old) carries the age of the DATA in its digest envelope (updatedAt, epoch
// seconds); stamping such a payload with the wall clock instead resets its
// displayed age to "now" on every save, so a noon reload of an 8 AM digest would
// claim "as of 12 PM". A fresh payload carries no updatedAt and falls back to now.
export function cacheStampFor(data) {
  return Number.isFinite(data?.updatedAt) ? data.updatedAt : Math.floor(Date.now() / 1000);
}

// The timestamp a cached entry should DISPLAY as its "as of": the payload's own
// source time when it has one (which also corrects caches written by an older
// build before cacheStampFor existed), else the moment it was written. Epoch
// seconds, the unit markStale reads.
export function cacheAgeOf(cached) {
  return cached?.data?.updatedAt ?? cached?.t ?? null;
}

/* ---------- pending edit-mode handoff ---------- */

// Settings → Widgets hands off to edit mode, and when it has changes to save
// first that save reloads the board (the only way config changes get applied).
// The intent to open the editor therefore cannot live in a variable, so it is
// parked here for the length of that one reload. sessionStorage, not local:
// this belongs to the tab and the moment, never to the board.
//
// The timestamp is the safety catch. A save that throws before it reloads would
// otherwise leave the flag lying there for the NIGHTLY reload to find, and a
// board that wakes up in edit mode at 4 AM is a genuinely bad morning.
const EDIT_KEY = 'sgn.editafter';
const EDIT_WINDOW_MS = 60 * 1000;

export function markPendingEdit() {
  try {
    window.sessionStorage.setItem(EDIT_KEY, String(Date.now()));
  } catch {
    // Storage-blocked kiosk: the save still lands, the editor just doesn't open.
  }
}

// Reads AND clears: the intent is spent whether or not the caller acts on it.
export function takePendingEdit() {
  try {
    const at = Number(window.sessionStorage.getItem(EDIT_KEY));
    window.sessionStorage.removeItem(EDIT_KEY);
    return at > 0 && Date.now() - at < EDIT_WINDOW_MS;
  } catch {
    return false;
  }
}
