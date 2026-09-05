// Weather widget: Open-Meteo forecast (browser-direct, CORS-open, keyless)
// plus NWS active-alert banner. All time strings stay in the device-local
// timezone Open-Meteo returns (timezone=auto) — no Date parsing of API times.

import { escapeHtml, chaikin } from '../util.js';
import { setCardNote } from '../card.js';
import { icon } from '../icons.js';
import { setExpandSource } from '../expand.js';

export const meta = {
  id: 'weather', title: 'Weather', refreshMs: 10 * 60 * 1000,
  // Location drives the fetch; units and the label are presentation, converted
  // at render and never refetched, so they stay out of the cache fingerprint —
  // a cache from the old location must not paint after a move (store.js F09).
  cacheInputs: (cfg) => ({ lat: cfg?.loc?.lat ?? null, lon: cfg?.loc?.lon ?? null }),
};

// An hour worth planning around. The card's own droplet threshold, hoisted to a
// constant so the overlay's wet marking can't drift away from the card's.
const WET_PP = 30;
// How many hours mapWeather keeps. The card draws at most 8 (see render); the
// rest exists for the full-screen view, and costs nothing — one request returns
// the whole forecast horizon whatever we slice off it.
const HOURLY_KEPT = 24;
// Optional-by-construction readings: a vm cached by an older build, or a partial
// API response, prints a dash rather than "NaN" or "undefined".
const num = (v) => (Number.isFinite(v) ? v : null);
const orDash = (v, fmt) => (Number.isFinite(v) ? fmt(v) : '—');

// Inline SVG temperature trend. viewBox is 0..n across (points at column
// centers) and 0..100 down, stretched to the chart box with
// preserveAspectRatio="none" so it lines up with an n-column flex label row at
// ANY width. The stroke uses vector-effect="non-scaling-stroke" to stay a
// constant weight under that stretch. Domain is padded (minWindow degrees at
// minimum) so a calm night still shows a legible slope without being
// misleading: the caller widens that window on taller cards, where the same
// slope would otherwise be stretched into a dramatic swing.
export function trendSvg(temps, gradId, minWindow = 6) {
  const n = temps.length;
  if (n < 2) return '';
  let lo = Math.min(...temps), hi = Math.max(...temps);
  if (hi - lo < minWindow) { const mid = (lo + hi) / 2; lo = mid - minWindow / 2; hi = mid + minWindow / 2; }
  else { lo -= 1; hi += 1; }
  const TOP = 14, BOT = 86;
  const px = (i) => i + 0.5;
  const py = (t) => TOP + (1 - (t - lo) / (hi - lo)) * (BOT - TOP);
  // Smooth the trend the same way as the markets sparkline: Chaikin keeps the
  // endpoints (so the line still spans 0.5..n-0.5 and lines up with the hour
  // columns) and never overshoots the padded domain.
  const sm = chaikin(temps.map((t, i) => [px(i), py(t)]));
  const xy = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  const pts = sm.map(xy);
  const line = 'M' + pts.join(' L');
  const area = `M${sm[0][0].toFixed(2)} 100 L` + pts.join(' L') + ` L${sm[sm.length - 1][0].toFixed(2)} 100 Z`;
  return `<svg class="wx-trend__chart" viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="wx-trend__g0"></stop><stop offset="1" class="wx-trend__g1"></stop>
      </linearGradient></defs>
      <path class="wx-trend__area" d="${area}" fill="url(#${gradId})"></path>
      <path class="wx-trend__line" d="${line}"></path>
    </svg>`;
}

// Droplet for the hourly precip row. Kept here rather than in icons.js: that
// map is a stroke-based 24-box system sized for 20px+ glyphs, and a 1.6px
// stroke scaled into a 9px box turns to mush on a board panel. This one is a
// solid shape at its native size, and fill="currentColor" with no colour of its
// own is what lets each cell tint its own droplet (dim when dry, accent when
// wet) without a single extra CSS rule.
// The viewBox is cropped to the shape (x 1..8) rather than the round 0..9 box:
// the drawn droplet is identical, but the 2px of transparent side padding it
// used to carry is exactly what a 3-wide card cannot spare when every hour
// reads 100% (measured: 49.0px of content in a 48.9px column, versus 51.0px
// with the padding).
const DROP = '<svg class="wx-pp__drop" viewBox="1 0 7 11" width="7" height="11" fill="currentColor" aria-hidden="true">'
  + '<path d="M4.5 0.5C3.2 2.6 1 5.4 1 7.1a3.5 3.5 0 0 0 7 0C8 5.4 5.8 2.6 4.5 0.5Z"/></svg>';

// WMO weather interpretation codes → display label + icon key.
const WMO = new Map([
  [0, ['Clear', 'clear']],
  [1, ['Mostly clear', 'clear']],
  [2, ['Partly cloudy', 'partly']],
  [3, ['Overcast', 'cloudy']],
  [45, ['Fog', 'fog']],
  [48, ['Freezing fog', 'fog']],
  [51, ['Light drizzle', 'drizzle']],
  [53, ['Drizzle', 'drizzle']],
  [55, ['Heavy drizzle', 'drizzle']],
  [56, ['Freezing drizzle', 'sleet']],
  [57, ['Freezing drizzle', 'sleet']],
  [61, ['Light rain', 'rain']],
  [63, ['Rain', 'rain']],
  [65, ['Heavy rain', 'rain']],
  [66, ['Freezing rain', 'sleet']],
  [67, ['Freezing rain', 'sleet']],
  [71, ['Light snow', 'snow']],
  [73, ['Snow', 'snow']],
  [75, ['Heavy snow', 'snow']],
  [77, ['Snow grains', 'snow']],
  [80, ['Light showers', 'rain']],
  [81, ['Showers', 'rain']],
  [82, ['Heavy showers', 'rain']],
  [85, ['Snow showers', 'snow']],
  [86, ['Snow showers', 'snow']],
  [95, ['Thunderstorm', 'thunder']],
  [96, ['Thunderstorm w/ hail', 'thunder']],
  [99, ['Thunderstorm w/ hail', 'thunder']],
]);

export function wmoInfo(code) {
  const hit = WMO.get(code);
  return hit ? { label: hit[0], icon: hit[1] } : { label: '—', icon: 'clear' };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// An hour axis is a clock reading, so it honors the board-wide 12/24-hour
// preference (cfg.clock24) that already drives the topbar Clock and World Clock.
// The default is 12-hour, which keeps every existing caller — and the label
// baked into a cached vm — exactly as it was.
export function hourLabel(isoLocal, clock24 = false) {
  const h = Number(isoLocal.slice(11, 13));
  if (clock24) return `${String(h).padStart(2, '0')}:00`;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// A wall-clock reading (sunrise, sunset) from Open-Meteo's local iso string.
// Formatted by slicing rather than through util.js's fmtClock, which takes an
// epoch: these strings are ALREADY in the board's local timezone and must never
// go through Date parsing (see the module header).
export function timeLabel(isoLocal, clock24 = false) {
  const h = Number(isoLocal.slice(11, 13));
  const m = isoLocal.slice(14, 16);
  if (clock24) return `${String(h).padStart(2, '0')}:${m}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Meteorological wind direction (degrees the wind blows FROM) as a 16-point
// compass point — "14 mph SSE" is readable at 6 ft in a way that "148°" is not.
export const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

// Wind and precipitation amounts follow the SAME canonical-unit rule as
// temperature: the request pins ONE unit (mph, inch) and the renderer converts
// per cfg.loc.units. A units change is then a re-render, never a refetch, and a
// cached vm can never be in the wrong unit.
export function fmtWind(mph, units) {
  return units === 'C' ? `${Math.round(mph * 1.609344)} km/h` : `${Math.round(mph)} mph`;
}
export function fmtAmount(inch, units) {
  return units === 'C' ? `${(inch * 25.4).toFixed(1)} mm` : `${inch.toFixed(2)} in`;
}

function dayLabel(isoDate, index) {
  if (index === 0) return 'Today';
  // Parse as UTC noon to avoid TZ date shifts, then take the weekday.
  return DAY_NAMES[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
}

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

function pickAlert(alertsJson) {
  const feats = alertsJson?.features;
  if (!Array.isArray(feats) || feats.length === 0) return null;
  const ranked = feats
    .map((f) => f?.properties)
    // Only live warnings reach the glass. CAP's other statuses (Test,
    // Exercise, System, Draft) are deliberately fake, and the only place NWS
    // marks them as fake is the headline text, which the banner does not
    // show: the tsunami system's routine communications test ranks Extreme
    // and wore the banner as a bare "Tsunami Warning" on real boards
    // (2026-08-11). A Cancel message is likewise ABOUT a warning, not one.
    .filter((p) => p && typeof p.event === 'string'
      && p.status === 'Actual' && p.messageType !== 'Cancel')
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
    );
  if (!ranked.length) return null;
  return { event: ranked[0].event, headline: ranked[0].headline ?? ranked[0].event };
}

export function mapWeather(json, alertsJson) {
  const cur = json.current;
  const info = wmoInfo(cur.weather_code);
  // Hourly strip: the full-day run after the current observation time. The card
  // slices the first 6-8 of these; the rest is what the full-screen view reads.
  const startIdx = json.hourly.time.findIndex((t) => t > cur.time);
  const hourly = [];
  // Precipitation chance is optional: an older cached payload (fetched before
  // the field was requested) or a partial API response leaves it missing or
  // short, and a null must never round-trip into the markup as NaN. The amount
  // (`precipitation`) and the iso stamp are optional for the same reason.
  const pop = json.hourly.precipitation_probability;
  const amt = json.hourly.precipitation;
  for (let i = Math.max(startIdx, 0); i < json.hourly.time.length && hourly.length < HOURLY_KEPT; i++) {
    const pp = Array.isArray(pop) ? pop[i] : null;
    hourly.push({
      iso: json.hourly.time[i],
      // Kept alongside `iso` deliberately: a vm cached by a build that predates
      // `iso` still carries this baked 12-hour label, and the card falls back to
      // it for the ~10 minutes before the next refresh replaces the cache.
      h: hourLabel(json.hourly.time[i]),
      temp: Math.round(json.hourly.temperature_2m[i]),
      code: json.hourly.weather_code[i],
      pp: Number.isFinite(pp) ? Math.round(pp) : null,
      precip: Array.isArray(amt) && Number.isFinite(amt[i]) ? amt[i] : 0,
    });
  }
  const D = json.daily;
  // No slice: the card takes its own 4-5, and the overlay shows the whole
  // 7-day horizon the request now asks for.
  const daily = D.time.map((t, i) => ({
    iso: t,
    day: dayLabel(t, i),
    hi: Math.round(D.temperature_2m_max[i]),
    lo: Math.round(D.temperature_2m_min[i]),
    code: D.weather_code[i],
    // Overlay-only extras, all optional (see `num`). Per-day sunrise/sunset is
    // what lets the overlay shade the night across a window that runs past
    // midnight, not just today's pair.
    ppMax: num(D.precipitation_probability_max?.[i]),
    uvMax: num(D.uv_index_max?.[i]),
    precipSum: num(D.precipitation_sum?.[i]),
    windMax: num(D.wind_speed_10m_max?.[i]),
    sunrise: D.sunrise?.[i] ?? null,
    sunset: D.sunset?.[i] ?? null,
  }));
  return {
    now: {
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature),
      code: cur.weather_code,
      label: info.label,
      icon: info.icon,
      // Overlay-only, and all four ride the same `current` block the card's
      // temperature already comes from.
      humidity: num(cur.relative_humidity_2m),
      wind: num(cur.wind_speed_10m),
      dir: num(cur.wind_direction_10m),
      gust: num(cur.wind_gusts_10m),
    },
    hourly,
    daily,
    sunrise: D.sunrise[0],
    sunset: D.sunset[0],
    alert: pickAlert(alertsJson),
  };
}

// Format a rounded-Fahrenheit temp for display in the chosen unit ('F'|'C').
export function fmtTemp(fTemp, units) {
  return `${units === 'C' ? Math.round((fTemp - 32) * 5 / 9) : fTemp}°`;
}

// An hour's column label. Prefers the iso stamp (so cfg.clock24 can switch the
// format), and falls back to the 12-hour label baked into a vm cached by a build
// that predates `iso`.
const hourText = (x, clock24) => (x.iso ? hourLabel(x.iso, clock24) : x.h);

// An hour worth planning around: the card's own droplet threshold, OR the model
// having it actually precipitating. Probability alone disagreed with the rain
// band on real London data (27% chance, 0.1 mm falling).
const isWet = (x) => x.pp >= WET_PP || x.precip > 0;

/* ======================================================================
   Tap-for-detail: the full meteo board.

   The SECOND class of expansion (see docs/superpowers/specs/
   2026-07-27-expand-overlay-design.md). There are no hidden rows here — the
   card renders every hour and every day it has room for — so instead of
   uncapping a list, the overlay derives a richer reading from the very same
   payload the card is already holding: 24 hours instead of 8, the full 7-day
   horizon instead of 5, and the wind / humidity / UV / rain-total / sun-time
   fields the card has never had the room to show. Still one call, still no
   fetch at open. Nothing is counted, so there is no "+N" to badge: the press
   tint is the whole signifier, deliberately.
   ====================================================================== */

// The hourly window. A full day is what makes the view worth opening, and the
// payload already carries a week of it.
const OVERLAY_HOURS = 24;
// One printed reading every other column. 24 hours share the right-hand pane's
// ~1188px, so a column is ~49px and a 30px temperature needs almost all of it;
// labelling every second hour restores the mockup's 12-column breathing room
// while the curve, the rain bars and the night wash keep all 24 hours of
// resolution underneath.
const LABEL_EVERY = 2;

// Which day's sun times govern an hour, and whether that hour is after dark.
// Optional by construction: a vm without per-day sun times simply gets no night
// wash, and the chart still reads.
function nightAt(iso, daily) {
  const d = daily.find((x) => x.iso === iso.slice(0, 10)) ?? daily[0];
  if (!d?.sunrise || !d?.sunset) return false;
  const t = iso.slice(11, 16);
  return t < d.sunrise.slice(11, 16) || t >= d.sunset.slice(11, 16);
}

// The overlay's hourly canvas. Temperature is trendSvg's math verbatim — same
// TOP/BOT band, same padded domain, same Chaikin smoothing, same
// non-scaling-stroke under preserveAspectRatio="none" — with two layers added
// BEHIND it that the card has no room for: the night, shaded from the
// sunrise/sunset already in the vm, and the hourly chance of rain as a bar band
// at the foot on its own axis. Plain rects and lines only: gen1 Qt WebEngine has
// no clipPath and no filters.
export function meteoCanvas(hours, daily, gradId, minWindow = 10) {
  const n = hours.length;
  if (n < 2) return '';
  const temps = hours.map((x) => x.temp);
  let lo = Math.min(...temps), hi = Math.max(...temps);
  if (hi - lo < minWindow) { const mid = (lo + hi) / 2; lo = mid - minWindow / 2; hi = mid + minWindow / 2; }
  else { lo -= 1; hi += 1; }
  const TOP = 12, BOT = 74, PPBASE = 100, PPMAX = 23;
  const px = (i) => i + 0.5;
  const py = (t) => TOP + (1 - (t - lo) / (hi - lo)) * (BOT - TOP);
  const sm = chaikin(temps.map((t, i) => [px(i), py(t)]));
  const xy = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  const pts = sm.map(xy);
  const line = 'M' + pts.join(' L');
  const area = `M${sm[0][0].toFixed(2)} ${BOT} L` + pts.join(' L') + ` L${sm[sm.length - 1][0].toFixed(2)} ${BOT} Z`;
  const night = hours
    .map((x, i) => (x.iso && nightAt(x.iso, daily)
      ? `<rect class="wxf-canvas__night" x="${i}" y="0" width="1" height="100"/>` : ''))
    .join('');
  const bars = hours
    .map((x, i) => {
      const pp = Number.isFinite(x.pp) ? x.pp : 0;
      if (pp <= 0) return '';
      const ht = (pp / 100) * PPMAX;
      return `<rect class="wxf-canvas__pp${isWet(x) ? ' is-wet' : ''}" x="${(i + 0.14).toFixed(2)}"`
        + ` y="${(PPBASE - ht).toFixed(2)}" width="0.72" height="${ht.toFixed(2)}"/>`;
    })
    .join('');
  // A hairline where the wash starts and ends — dawn and dusk, without a caption
  // to read.
  const suns = hours
    .map((x, i) => (i > 0 && x.iso && hours[i - 1].iso
      && nightAt(x.iso, daily) !== nightAt(hours[i - 1].iso, daily)
      ? `<line class="wxf-canvas__sun" x1="${i}" y1="0" x2="${i}" y2="100"/>` : ''))
    .join('');
  return `<svg class="wxf-canvas" viewBox="0 0 ${n} 100" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="wxf-canvas__g0"></stop><stop offset="1" class="wxf-canvas__g1"></stop>
      </linearGradient></defs>
      ${night}${bars}
      <path class="wxf-canvas__area" d="${area}" fill="url(#${gradId})"></path>
      <path class="wxf-canvas__line" d="${line}"></path>
      ${suns}
    </svg>`;
}

const statCell = (value, label) =>
  `<div class="wxf__stat"><b>${value}</b><span>${label}</span></div>`;
const kvRow = (label, value) =>
  `<div class="wxf__kv"><span>${label}</span><b>${value}</b></div>`;

// The overlay body: a snapshot built at tap time from the vm the card is
// showing. Values are formatted here exactly as the card formats its own, so the
// two surfaces can never disagree about a temperature.
export function meteoBoard(vm, cfg) {
  const units = cfg?.loc?.units ?? 'F';
  const clock24 = Boolean(cfg?.clock24);
  const hours = vm.hourly.slice(0, OVERLAY_HOURS);
  const days = vm.daily.slice(0, 7);
  const d0 = days[0] ?? {};
  const info = wmoInfo(vm.now.code);
  const mark = (i) => i % LABEL_EVERY === 0;

  const tempsRow = hours
    .map((x, i) => `<span>${mark(i) ? fmtTemp(x.temp, units) : ''}</span>`)
    .join('');
  const ppRow = hours
    .map((x, i) => (!mark(i) || x.pp == null
      ? '<span></span>'
      : `<span${isWet(x) ? ' class="is-wet"' : ''}>${DROP}${x.pp}%</span>`))
    .join('');
  const hoursRow = hours
    .map((x, i) => `<span>${mark(i) ? escapeHtml(hourText(x, clock24)) : ''}</span>`)
    .join('');
  const dayCards = days
    .map((d, i) => {
      const di = wmoInfo(d.code);
      return `<div class="wxf__day${i === 0 ? ' wxf__day--today' : ''}">
          <span class="wxf__dayname">${escapeHtml(d.day)}</span>
          ${icon(di.icon, 'wxf__dayico wx-ico--' + di.icon)}
          <span class="wxf__dayhi">${fmtTemp(d.hi, units)}</span>
          <span class="wxf__daylo">${fmtTemp(d.lo, units)}</span>
          <span class="wxf__daypp${d.ppMax >= WET_PP ? ' is-wet' : ''}">${DROP}${orDash(d.ppMax, (v) => `${v}%`)}</span>
        </div>`;
    })
    .join('');

  return `<div class="wxf" data-cond="${escapeHtml(info.icon)}">
    ${vm.alert ? `<div class="alert">${icon('thunder', 'icon--sm')}<span>${escapeHtml(vm.alert.event)}</span></div>` : ''}
    <div class="wxf__split">
      <section class="wxf__nowpane">
        <div class="wxf__nowtop">
          ${icon(info.icon, 'wxf__glyph wx-ico--' + info.icon)}
          <span class="wxf__temp">${fmtTemp(vm.now.temp, units)}</span>
        </div>
        <div class="wxf__herometa">
          <span class="wxf__cond">${escapeHtml(info.label)}</span>
          <span class="wxf__feels">Feels like ${fmtTemp(vm.now.feels, units)}</span>
        </div>
        <div class="wxf__todayrail">
          <div class="wxf__rule"></div>
          ${kvRow('High today', fmtTemp(d0.hi, units))}
          ${kvRow('Low tonight', fmtTemp(d0.lo, units))}
          ${kvRow('Chance of rain', orDash(d0.ppMax, (v) => `${v}%`))}
          <div class="wxf__rule"></div>
          ${kvRow('Sunrise', vm.sunrise ? timeLabel(vm.sunrise, clock24) : '—')}
          ${kvRow('Sunset', vm.sunset ? timeLabel(vm.sunset, clock24) : '—')}
        </div>
      </section>
      <div class="wxf__colright">
        <div class="wxf__chart">
          <div class="wxf__row wxf__row--temp">${tempsRow}</div>
          <div class="wxf__row wxf__row--pp">${ppRow}</div>
          ${meteoCanvas(hours, days, 'wxf-canvas-grad', 10)}
          <div class="wxf__row wxf__row--hours">${hoursRow}</div>
        </div>
        <div class="wxf__days">${dayCards}</div>
      </div>
    </div>
    <div class="wxf__stats">
      ${statCell(orDash(vm.now.wind, (v) => fmtWind(v, units) + (Number.isFinite(vm.now.dir) ? ` ${compass(vm.now.dir)}` : '')), 'Wind')}
      ${statCell(orDash(vm.now.gust, (v) => fmtWind(v, units)), 'Gusts')}
      ${statCell(orDash(vm.now.humidity, (v) => `${v}%`), 'Humidity')}
      ${statCell(orDash(d0.uvMax, (v) => String(Math.round(v))), 'UV max today')}
      ${statCell(orDash(d0.precipSum, (v) => fmtAmount(v, units)), 'Rain today')}
      ${statCell(orDash(d0.windMax, (v) => fmtWind(v, units)), 'Peak wind today')}
    </div>
  </div>`;
}

export function render(el, vm, cfg) {
  // Location note in the card header ("New York 10001", "London, England (GB)")
  // — matters now that weather can track anywhere, not just the office.
  setCardNote(el, cfg?.loc?.label ?? '');
  const units = cfg?.loc?.units ?? 'F';
  // Clear first, register at the end: a vm with nothing to show throws partway
  // through this function (main.js catches and logs it), and a card left
  // expandable would then open an overlay on the previous render's data.
  setExpandSource(el, null);

  // Size class is stamped on the card by main.js (cardFor) before render runs.
  const card = el.closest('.card');
  const w = Number(card?.dataset.w) || 3;
  const h = Number(card?.dataset.h) || 4;
  const big = w >= 5 || h >= 5;
  const nHours = big ? 8 : 6;
  const nDays = big ? 5 : 4;

  // Drive the accent from the CURRENT condition.
  if (card) card.dataset.cond = vm.now.icon;

  const hours = vm.hourly.slice(0, nHours);
  const days = vm.daily.slice(0, nDays);

  const tempsRow = hours
    .map((x) => `<span>${fmtTemp(x.temp, units)}</span>`)
    .join('');
  const hoursRow = hours
    .map((x) => `<span>${escapeHtml(hourText(x, cfg?.clock24))}</span>`)
    .join('');
  // Tall cards leave a dead band between the hourly strip and the day chips;
  // spend it on the hourly chance of precipitation. Height tier only (NOT
  // `big`): a wide-but-shallow card has no spare height for another row. An
  // hour with no reading holds its column with an empty span so the row stays
  // aligned with the temps and the chart, and a row that would be blank
  // everywhere is dropped entirely. Every reading carries a droplet, dry hours
  // included, so the number's meaning is legible on a calm day too.
  const showPrecip = h >= 5 && hours.some((x) => x.pp != null);
  const precipRow = showPrecip
    ? `<div class="wx-trend__row wx-trend__row--precip">${hours
        .map((x) =>
          x.pp == null
            ? '<span></span>'
            : `<span${x.pp >= WET_PP ? ' class="wx-pp--wet"' : ''}>${DROP}${x.pp}%</span>`,
        )
        .join('')}</div>`
    : '';
  // Flat-day guard, paired with the chart-height ladder in main.css (100 -> 192
  // -> 304 -> 420px at h 5 -> 8): a fixed 6-degree floor stretched over a 420px
  // chart turns a 4-degree overnight drift into a 200px plunge. Widening the
  // window with the tier holds a flat day near the px-per-degree the short
  // tiers read at (~12 at h=5 up to ~17 at h=8; the banner variants land a bit
  // calmer, which is fine). A real swing is untouched: once the actual range
  // exceeds the window, the domain stays actual range +/- 1.
  const minWindow = h >= 8 ? 18 : h === 7 ? 14 : h === 6 ? 10 : 6;
  // The NWS banner changes the tall-card height budget twice over: it eats ~46px,
  // and as a fourth flex item it turns the body's two space-between gaps into
  // three, so the leftover slack divides differently. Mark the case and let the
  // measured-fit rules in main.css pick the chart height per tier.
  const trendClass = h >= 5 && vm.alert ? 'wx-trend wx-trend--banner' : 'wx-trend';
  const dayTiles = days
    .map(
      (d) => `<div class="wx-day">
          <span class="wx-day__name">${escapeHtml(d.day)}</span>
          ${icon(wmoInfo(d.code).icon, 'wx-day__ico wx-ico--' + wmoInfo(d.code).icon)}
          <span class="wx-day__hi">${fmtTemp(d.hi, units)}</span>
          <span class="wx-day__lo">${fmtTemp(d.lo, units)}</span>
        </div>`,
    )
    .join('');

  el.innerHTML = `
    ${vm.alert ? `<div class="alert">${icon('thunder', 'icon--sm')}<span>${escapeHtml(vm.alert.event)}</span></div>` : ''}
    <div class="wx-now">
      ${icon(vm.now.icon, 'wx-now__icon wx-ico--' + vm.now.icon)}
      <span class="wx-now__temp">${fmtTemp(vm.now.temp, units)}</span>
      <div class="wx-now__meta">
        <span class="wx-now__label">${escapeHtml(vm.now.label)}</span>
        <span class="wx-now__feels">Feels like ${fmtTemp(vm.now.feels, units)}</span>
      </div>
    </div>
    <div class="wx-rule"></div>
    <div class="${trendClass}">
      <div class="wx-trend__row">${tempsRow}</div>
      ${precipRow}
      ${trendSvg(hours.map((x) => x.temp), 'wx-trend-grad', minWindow)}
      <div class="wx-trend__row wx-trend__row--hours">${hoursRow}</div>
    </div>
    <div class="wx-days">${dayTiles}</div>`;

  // Weather ALWAYS has detail: nothing on this card is capped away, so there is
  // no hidden-row condition to gate on and no "+N" badge to agree with — the
  // source registers whenever the card has data. The closure captures THIS
  // render's vm, so the overlay always shows what the card was showing when it
  // was tapped.
  setExpandSource(el, () => ({
    title: meta.title,
    note: cfg?.loc?.label ?? '',
    bodyHtml: meteoBoard(vm, cfg),
  }));
}

// Rough US bounding boxes (continental, Alaska, Hawaii). Gates the US-only
// NWS alerts call — a non-US point would 400 on every refresh otherwise.
export function inUS(lat, lon) {
  return (lat >= 24.5 && lat <= 49.5 && lon >= -125 && lon <= -66.9)
    || (lat >= 51 && lat <= 72 && lon >= -170 && lon <= -129)
    || (lat >= 18.5 && lat <= 22.5 && lon >= -160.5 && lon <= -154.5);
}

export async function fetchData(cfg, net) {
  const { lat, lon } = cfg.loc;
  // ONE call, for the card AND the full-screen view. Open-Meteo weights a
  // request by its variable count (weight = variables / 10), so the nine fields
  // the overlay adds take this from 1.1 to 2.0 weighted calls: at a 10-minute
  // refresh that is 288 a day per board against a free ceiling of 10,000.
  // Every unit is pinned to ONE canonical choice (°F, mph, inch) and converted
  // at render per cfg.loc.units — see fmtTemp / fmtWind / fmtAmount.
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,weather_code,precipitation_probability,precipitation' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max,precipitation_sum,wind_speed_10m_max' +
    '&forecast_days=7&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch';
  const forecast = await net.fetchJSON(url);
  let alerts = null;
  if (inUS(lat, lon)) {
    try {
      alerts = await net.fetchJSON(`https://api.weather.gov/alerts/active?point=${lat},${lon}`);
    } catch {
      // Alerts are an enhancement; the widget renders without them.
    }
  }
  return mapWeather(forecast, alerts);
}
