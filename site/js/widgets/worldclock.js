// World clock: user-configurable city list (cfg.worldclock.cities), displayed
// in order of current local time (earliest -> latest). Presets are the
// D. E. Shaw offices; any IANA zone can be added. Pure Intl math, no network.

import { escapeHtml, clockTimeOpts } from '../util.js';
import { fitList } from '../capacity.js';
import { setExpandSource } from '../expand.js';
import { clockFaceHtml } from '../clockfaces.js';

export const meta = { id: 'worldclock', title: 'World Clock', refreshMs: 30 * 1000 };

export const OFFICES = [
  ['New York', 'America/New_York'],
  ['Boston', 'America/New_York'],
  ['Rye', 'America/New_York'],
  ['Bermuda', 'Atlantic/Bermuda'],
  ['Kansas City', 'America/Chicago'],
  ['San Francisco', 'America/Los_Angeles'],
  ['London', 'Europe/London'],
  ['Luxembourg', 'Europe/Luxembourg'],
  ['Bengaluru', 'Asia/Kolkata'],
  ['Gurugram', 'Asia/Kolkata'],
  ['Hyderabad', 'Asia/Kolkata'],
  ['Hong Kong', 'Asia/Hong_Kong'],
  ['Shanghai', 'Asia/Shanghai'],
  ['Singapore', 'Asia/Singapore'],
];

// "America/Indiana/Indianapolis" -> "Indianapolis"
export const zoneLabel = (zone) => zone.split('/').pop().replace(/_/g, ' ');

// Group ~400 IANA zones by the segment before the first "/" (so
// "America/Argentina/Buenos_Aires" lands under "America"); zones with no "/"
// (UTC, GMT, etc.) share a synthetic bucket. Input is alphabetical, so the
// keys and each group's zones come out sorted.
export function zonesByRegion(zones) {
  const out = {};
  for (const zone of zones) {
    const slash = zone.indexOf('/');
    const region = slash === -1 ? 'UTC / Other' : zone.slice(0, slash);
    (out[region] ??= []).push(zone);
  }
  return out;
}

const dayKey = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', timeZone ? { timeZone, dateStyle: 'short' } : { dateStyle: 'short' }).format(date);

export function worldTimes(date, cities, clock24 = false) {
  const localDay = dayKey(date);
  return cities
    .map(({ label, zone }) => {
      const zoneDay = dayKey(date, zone);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(date);
      const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const dayDiff = zoneDay === localDay ? 0 : zoneDay > localDay ? 1 : -1;
      return {
        city: label,
        time: new Intl.DateTimeFormat('en-US', { timeZone: zone, ...clockTimeOpts(clock24) }).format(date),
        dayDiff,
        sortKey: dayDiff * 1440 + get('hour') * 60 + get('minute'),
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey)
    .map(({ city, time, dayDiff }) => ({ city, time, dayDiff }));
}

export async function fetchData(cfg) {
  return worldTimes(new Date(), cfg.worldclock.cities, cfg.clock24);
}

// ---------- tap-to-expand: the analog face, verbatim ----------

// The expansion is the SCREENSAVER's world face (design C), reused exactly as
// clockFaceHtml builds it for ambient mode — dials, night dimming, the home
// city treatment and the day markers all included. Nothing is rebuilt here on
// purpose: two drawings of the same clock would drift, and the face is already
// the board's most legible answer to "what time is it there".
//
// It is also why this card registers UNCONDITIONALLY, unlike the list cards
// whose expansion only uncaps a slice (history and weather set the precedent).
// The face is a richer RE-READ rather than a longer list: worldCities always
// injects the local zone as a home dial, which the card never shows at all, so
// even a card displaying every configured city still owes a tap something it
// does not have. Only the corner badge tracks what is hidden.
const DIAL_MIN = 200;
const DIAL_STEP = 15;
const GAP_MIN = 40;
const GAP_STEP = 6;

// The screensaver lays its dials out against .clockface, roughly 1032px tall;
// the overlay canvas is OVERLAY_BODY_H, 814. Walking clockfaces' own deal
// (DIAL_BANDS through columns.js) and gridScale, every dial count clears that
// except exactly SIX: six deals as
// 3 + 3, which gridScale then draws at the biggest 330px dial for about 892px
// of cells. (A user with five cities and no home city lands there, because the
// local dial is injected.) Rather than re-tune the shared grid — the face must
// stay the screensaver's, verbatim, everywhere it already fits — step the dial
// down only when the browser says it genuinely overflows. Same estimate-then-
// measure contract fitStatusBoard and fitTrainRows run, bounded by DIAL_MIN,
// and a no-op under happy-dom where nothing has a clientHeight.
export function fitWorldFace(body) {
  const cf = body?.querySelector?.('.cf');
  const dials = body?.querySelector?.('.cf-dials');
  if (!cf?.clientHeight || !dials) return 0;
  let steps = 0;
  while (dials.offsetHeight > cf.clientHeight) {
    const dial = parseFloat(dials.style.getPropertyValue('--dial'));
    if (!(dial > DIAL_MIN)) break;
    dials.style.setProperty('--dial', `${Math.max(DIAL_MIN, dial - DIAL_STEP)}px`);
    const gap = parseFloat(dials.style.getPropertyValue('--dgap'));
    if (gap > GAP_MIN) dials.style.setProperty('--dgap', `${Math.max(GAP_MIN, gap - GAP_STEP)}px`);
    steps += 1;
  }
  return steps;
}

// A clock is the one thing the overlay's snapshot rule cannot hold: every other
// expansion shows data that was already stale the moment it was fetched, but a
// face reading 9:14 while the wall clock says 9:31 is simply WRONG. So it
// repaints on the minute boundary, the same alignment (and the same no-seconds
// calm) as the screensaver engine.
//
// Returns the stop. The engine tells the view when it is going away
// (openExpand's `onClose`) and that call is what ends this, on the one event
// that actually means it. The first cut had no such seam, so it watched
// body.isConnected instead and deduced its own closure from the fact that
// closeExpand had detached the element under it. That worked, and the comment
// here read it as a feature, but a repaint that has to infer whether anyone is
// still watching is a view doing the engine's job. The 60s idle auto-close
// bounds the whole thing either way: a reader sees at most one repaint.
export function startWorldFaceRepaint(body, cfg, schedule = setTimeout, cancel = clearTimeout) {
  let timer = null;
  const arm = () => {
    timer = schedule(() => {
      body.innerHTML = clockFaceHtml('worldclocks', cfg);
      fitWorldFace(body);
      arm();
    }, 60000 - (Date.now() % 60000) + 80);
  };
  arm();
  return () => cancel(timer);
}

export function render(el, vm, cfg) {
  fitList(el, {
    id: meta.id,
    items: vm,
    defaultSize: [3, 4],
    badge: true,
    draw: (n) => {
      const shown = vm.slice(0, n);
      // Reserve the day-offset gutter on every row (only when some city actually
      // crosses a day boundary) so the +1d/−1d badge never shifts the time; and
      // split the hour into a fixed-width cell so the colon sits on one axis
      // whether the hour is one or two digits.
      el.classList.toggle('wc-has-day', shown.some((row) => row.dayDiff));
      el.style.setProperty('--n', String(shown.length)); // elastic row-gap divisor
      el.innerHTML = shown
        .map((row) => {
          const ci = row.time.indexOf(':');
          const hh = row.time.slice(0, ci);
          const rest = row.time.slice(ci); // ":11 PM"
          // AM/PM gets its own span so the 2-wide card can set it smaller and
          // dimmer than the digits (main.css). The separator Intl wrote stays in
          // the markup as-is (newer ICU writes a narrow no-break space, older a
          // plain one, hence \s), so every other size renders exactly as
          // before; a 24-hour clock has no suffix and no span.
          const sp = rest.search(/\s/);
          const mm = sp === -1 ? rest : rest.slice(0, sp + 1); // ":11 "
          const ap = sp === -1 ? '' : rest.slice(sp + 1); // "PM", or ''
          const day = row.dayDiff > 0 ? '+1d' : row.dayDiff < 0 ? '−1d' : '';
          return `<div class="wc-row">
        <span class="wc-row__city">${escapeHtml(row.city)}</span>
        <span class="wc-row__time"><span class="wc-row__hh">${escapeHtml(hh)}</span>${escapeHtml(mm)}${ap ? `<span class="wc-row__ap">${escapeHtml(ap)}</span>` : ''}</span>
        <span class="wc-row__day">${day}</span>
      </div>`;
        })
        .join('');
    },
  });
  // Built at TAP time, not here: the face must read the clock the moment it is
  // opened, not the clock at the last card refresh. The repaint is per view,
  // so the stop lives in the build's own closure and one open can never cancel
  // another's timer.
  setExpandSource(el, () => {
    let stopRepaint = null;
    return {
      title: meta.title,
      bodyHtml: clockFaceHtml('worldclocks', cfg),
      onOpen: (bodyEl) => {
        fitWorldFace(bodyEl);
        stopRepaint = startWorldFaceRepaint(bodyEl, cfg);
      },
      onClose: () => stopRepaint?.(),
    };
  });
}
