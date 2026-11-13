// Ambient-mode info strip: a compact digest (temperature + next departures)
// assembled from whatever transit widgets the user has enabled, using their
// latest cached view models.

import { escapeHtml, fmtMin } from './util.js';

// Which strip sources the dashboard currently holds stale: the same state as
// the card's markStale/markFresh (a fetch that threw, a worker-served stale
// copy, LIRR's own old-feed rule), set by main.js beside those calls. A stale
// source leaves the strip rather than showing an old number with no mark on
// it (Sean's pick, 2026-11-13). The card can afford to dim and stamp its age;
// a one-line band read in passing cannot.
//
// It lives here, not in main.js, because three hosts render the strip (the
// screensaver, the tap-opened art viewer, the settings preview) and all three
// already import this module; stripData reads it by default, so none of them
// can drift onto a second notion of "stale".
//
// Deliberately NOT set by the boot-time restore from cache: the card is dimmed
// then too, but those values are usually minutes old and the first fetch
// settles within seconds. Counting it would leave the strip clock-only after
// every reload (the nightly one included) until the next 30 s tick.
const staleSources = new Set();
const staleListeners = new Set();

export function setStripSourceStale(id, stale) {
  if (staleSources.has(id) === Boolean(stale)) return;
  if (stale) staleSources.add(id);
  else staleSources.delete(id);
  // A flip re-renders at once, so a segment leaves (or comes back) with the
  // card's own mark instead of up to 30 s later.
  for (const fn of staleListeners) fn(id, Boolean(stale));
}

export function isStripSourceStale(id) {
  return staleSources.has(id);
}

// Subscribe to stale/fresh flips; returns the unsubscribe.
export function onStripStaleChange(fn) {
  staleListeners.add(fn);
  return () => staleListeners.delete(fn);
}

// Pick the next STILL-UPCOMING departure and recompute its countdown from the
// absolute departure time.
//
// The cached view models carry a `min` that was frozen when that widget last
// rendered. Reading it straight through (as the strip used to) means a wedged
// feed — or simply a cache restored from localStorage at boot — shows a
// confident wrong number indefinitely: "8 min" for a train that left hours ago.
// The widgets' own past-departure filter runs at THEIR render, so a stale cache
// still holds departed trains; hence scan forward for the first future one
// rather than trusting index 0.
//
// A departure in the past is dropped, not clamped to "1 min": the strip should
// go quiet rather than lie. An entry with no usable absolute time is dropped for
// the same reason — an unverifiable countdown is worse than none. Every real VM
// carries one (lirr/mnr `t`, njt `time`), so that only bites on an unexpected
// shape, and the next fetch (~1 min) restores the strip.
function nextUpcoming(list, timeKey, nowSec) {
  for (const d of Array.isArray(list) ? list : []) {
    const at = d?.[timeKey];
    if (!Number.isFinite(at) || at <= nowSec) continue;
    return { d, min: Math.max(1, Math.round((at - nowSec) / 60)) };
  }
  return null;
}

// `isStale` defaults to the shared registry above; tests pass their own.
export function stripData(caches, cfg, { nowSec = Math.floor(Date.now() / 1000), isStale = isStripSourceStale } = {}) {
  // A stale source contributes nothing, exactly as if it were switched off:
  // with every source stale the strip is the clock alone.
  const enabled = new Set((cfg.widgets ?? []).filter((id) => !isStale(id)));
  // The weather VM stores canonical Fahrenheit and converts at the card's
  // render; the strip must convert too or a °C board shows Fahrenheit here.
  const rawF = enabled.has('weather') && caches.weather ? caches.weather.now?.temp ?? null : null;
  const temp = rawF === null ? null
    : (cfg.loc?.units === 'C' ? Math.round((rawF - 32) * 5 / 9) : rawF);
  const cond = temp === null ? null : (caches.weather.now?.label ?? null);
  const transit = [];

  if (enabled.has('lirr') && caches.lirr) {
    const n = nextUpcoming(caches.lirr.departures, 't', nowSec);
    if (n) transit.push({ label: `LIRR · ${n.d.dest}${n.d.track ? ` · Track ${n.d.track}` : ''}`, min: n.min });
  }
  if (enabled.has('mnr') && caches.mnr) {
    const n = nextUpcoming(caches.mnr.departures, 't', nowSec);
    if (n) transit.push({ label: `MNR · ${n.d.dest}`, min: n.min });
  }
  if (enabled.has('njt') && caches.njt) {
    const n = nextUpcoming(caches.njt.trains, 'time', nowSec);
    if (n) transit.push({ label: `NJT · ${n.d.dest}${n.d.track ? ` · Track ${n.d.track}` : ''}`, min: n.min });
  }
  return { temp, cond, transit };
}

// Strip markup shared by ambient mode (#strip) and the art viewer's overlay.
// showTime is suppressed under a clock-face screensaver — the clock already
// IS the time, so repeating it in the strip is pure duplication. A transit
// segment leads with its minutes: trailing them after "Track 17" read as
// "17 8".
export function stripHtml(data, now, { showTime = true } = {}) {
  return `
    ${showTime ? `<span class="strip__time">${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>` : ''}
    ${data.temp !== null ? `<span class="strip__wx"><b>${data.temp}°</b>${data.cond ? ` ${escapeHtml(data.cond)}` : ''}</span>` : ''}
    ${data.transit
      .map((t) => `<span class="strip__transit"><b>${fmtMin(t.min)} min</b> ${escapeHtml(t.label)}</span>`)
      .join('')}`;
}
