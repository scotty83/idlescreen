// Capacity model: how many items of a widget's primary list fit at a given
// card size. Renderers slice to this (data is removed on purpose, never
// clipped mid-row), and edit mode surfaces it so users see what a resize
// gains or loses. Counts are calibrated against the browser overflow audit.
//
// Three things live here, in the order a row count is arrived at: the
// capacity estimate (the table below), the trim a widget is known to shed
// under it, and fitList, the one operation every list renderer asks its
// question through.

// setMoreBadge is the corner count's only writer, and a fit is the only thing
// that knows what a card left out, so the stamp happens here rather than in
// every renderer that slices a list. card.js reaches config.js, which reaches
// layout.js, which reaches back here; nothing in that ring runs at module
// scope, so the cycle resolves before any of it is called.
import { setMoreBadge } from './card.js';

// Usable body height in px for h grid rows on the 12x8 canvas (cell ≈ 92px
// tall after the safe-bottom reserve, minus card chrome: padding + title).
// Exported for the widgets whose "rows" are not list items (quote.js counts
// the lines a sentence wraps to) so there is one cell arithmetic, not two.
export const bodyPx = (h) => h * 92 + (h - 1) * 20 - 90;

// Usable body WIDTH in px for w grid columns: 12 columns of 135px on the 20px
// gap, less the card's 26px side padding. Same canvas, same reasoning.
export const bodyWidthPx = (w) => w * 135 + (w - 1) * 20 - 52;

// Height tiers drive both row counts and the compact CSS variants:
// s = shallow (h<=2, old single-row), m = medium (3-4), l = tall (5+).
export const sizeTier = (h) => (h <= 2 ? 's' : h <= 4 ? 'm' : 'l');

// rowPx is the medium-tier pitch, compactRowPx the shallow one. tallRowPx is
// optional and defaults to rowPx: several widgets grow their type at h>=5 (the
// `l` tier), so one pitch calibrated on the medium tier over-promises by a row
// on a tall card. Added 2026-07-29 when the content-aware generator started
// emitting tall cards and the overflow audit caught sports and the headline
// feeds clipping at h=5 (see the per-widget notes below).
const listCapacity = (rowPx, compactRowPx, tallRowPx = rowPx) => (w, h) =>
  Math.max(1, Math.floor(bodyPx(h) / (
    sizeTier(h) === 's' ? compactRowPx : sizeTier(h) === 'm' ? rowPx : tallRowPx)));

// ---- rail / ferry departure boards ----------------------------------------
// LIRR, Metro-North, NJ Transit, Amtrak and Ferry all render the same .train
// row: 51px tall on the .trains 10px gap, i.e. a 61px pitch at every width and
// tier (browser-measured, line chip and track pill included). The `.trains` box
// itself measures 121 / 234 / 347 / 459 / 572 / 685 / 798 px at h=2..8 on the
// 12x8 canvas, so floor((box + gap) / (row + gap)) is the row count below.
// They all shared listCapacity(80, 56), a pitch ~30% taller than the rows
// actually are, which left a 3x3 card showing 2 trains in space that holds 4
// and a 6-tall card showing 7 where 9 fit. h=8 measures 13 rows of space, but
// every rail feed slices to 12 departures, so 12 is the most data can fill.
// bodyPx() is deliberately not used here: its cell estimate runs 7-12px under
// the real box, which costs a row exactly at h=3.
const RAIL_ROWS = Object.freeze({ 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 8: 12 });
const railCapacity = (w, h) => (h < 2 ? 1 : RAIL_ROWS[Math.min(h, 8)]);

// Per-widget capacity of the primary list, or null when there isn't one.
// Exported for the catalogue completeness suite: a key here that is not a
// widget id is a calibration nothing ever reads.
export const MODELS = {
  // ~67px row pitch (name+price stacked over a 28px spark, +10px row-gap) with
  // headroom for the "+N more" hint. 69 (was a too-tall 78) makes a 4x3 fit 3
  // index rows instead of 2 — verified overflow-safe with the hint at 3–8 tall.
  // Markets rows trim to ~61px + 8px gaps at every width (markets caps at
  // 4 wide), so a 4-tall card fits five tickers; shallow spark-less rows 36
  // (fits all 3 tickers at 3x2). Browser-calibrated with a 6-ticker fixture.
  markets: (w, h) =>
    Math.max(1, sizeTier(h) === 's'
      ? Math.floor(bodyPx(h) / 36)
      : Math.floor((bodyPx(h) + 8) / 69)),
  // Optimistic 52 pitch (typical Good-Service rows are ~42; wrapped alert
  // rows are taller, and the renderer's measure-trim sheds those days to the
  // corner badge) — a 3x3 fits 4 all-quiet lines instead of promising 3.
  subway: listCapacity(52, 42),
  // Measured .train rows (see RAIL_ROWS). Narrow cards wrap the meta line
  // taller than 51px, so every one of these renderers ends with fitTrainRows().
  lirr: railCapacity,
  mnr: railCapacity,
  njt: railCapacity,
  amtrak: railCapacity,
  path: listCapacity(58, 44), // single-line rows, subway-like density
  ferry: railCapacity,
  // Row budget shared between each stop's header (~28px) and its arrival rows
  // (~41px). It borrowed lirr/mnr's 80px two-line pitch, which ~halved what
  // fits; 50 is the measured safe average (never overflows worst-case configs
  // 3x3–4x8, hint included) — e.g. a 3x3 now packs 5 rows, not 2.
  bus: listCapacity(50, 56),
  // History's shallow tier promises one event, its worst case at every width.
  // There the renderer measures (history.js): an event may take two lines, any
  // event its clamp would cut is shed, and a lone survivor gets three, so a day
  // of long facts shows one event however wide the card is. Short facts show
  // two or three, which the count under-states; it must never over-state. The
  // old 54px shallow pitch promised two one-line rows that no longer exist.
  // Medium and tall cards are unmeasured and keep their 64px pitch.
  history: (w, h) => (sizeTier(h) === 's' ? 1 : Math.max(1, Math.floor(bodyPx(h) / 64))),
  // 74px pitch (was a too-tall 94 that estimated ~row+gap far above the ~66px
  // t-m rows) makes a 3×3 fit 3 teams instead of 2 — verified worst-case
  // (all-3-line rows) overflow-safe with the t-m font compaction below.
  // Shallow rows are compact (no Last line, 32px logo) — 2 teams fit a 3×2.
  // The tall tier needs 76: measured 2026-07-29, a 5-tall card draws 67px rows
  // on a 10px minimum gap, so 74 promised 6 teams in space that holds 5 and a
  // full 6-team card overflowed by 3px at 3x5, 4x5 and 6x5. Fixes the resting
  // card too — anyone with 6 teams on a 5-tall card was clipping.
  sports: listCapacity(74, 55, 76),
  // Golf: compact 30px rows (flags carry identity, lines stay single).
  golf: listCapacity(38, 34),
  // Tennis: single-line match rows, worldclock-like density.
  tennis: listCapacity(45, 40),
  // Stacked rows: meta line + up to 2 title lines = 73.6px worst case (+gap);
  // shallow cards clamp titles to 1 line (47.4px + gap). The tall tier needs 80:
  // measured 2026-07-29 with ten full-length headlines, 75 promised 6 rows at
  // h=5 and 10 at h=8 where the renderer's own measure-and-trim settled on 5 and
  // 9. Over-promising here cost nothing visible (newscore trims rather than
  // clips) but it made the generator buy a row that bought no headline.
  news: listCapacity(75, 57, 80),
  // Markets News and Sports News render the identical stacked-headline rows as
  // news, through the same renderHeadlines measure-and-trim.
  marketsnews: listCapacity(75, 57, 80),
  sportsnews: listCapacity(75, 57, 80),
  // Same stacked rows as news, but post texts are long by nature — nearly
  // every row wraps to the full 2 lines, and the +N hint needs headroom too.
  substack: listCapacity(90, 62),
  bsky: listCapacity(90, 62),
  // Single-line 35px rows + 10px gap (shrunk so five zones fit a 3-tall card).
  // The shallow tier was 45 too, because h=2 was illegal and tier s could never
  // apply. It can now (MIN_ALTS opened 3x2, Sean 2026-08-01: three cities ought
  // to fit a small card), and 38 is that tier's own measured pitch: main.css
  // gives .card--worldclock.t-s a FIXED 28px row and drops the time to 21px, on
  // the same 10px gap floor every other list card uses. bodyPx(2) is 114, so
  // floor(114 / 38) = 3 — and the honest fit is 3 * 28 + 2 * 10 = 104, which
  // clears the estimate by 10px (and the real h=2 box, which measures ~121, by
  // more; see the RAIL_ROWS note on bodyPx running under). The row height is
  // pinned rather than measured so a device font with taller metrics cannot
  // spend that margin. Change 28 or 10 here and change its twin in main.css.
  worldclock: listCapacity(45, 38),
  // Calibrated to the TYPICAL all-Operational row (~44px incl gap) so the
  // edit-mode label matches what actually renders (52 budgeted worst-case
  // degraded rows — a 3×3 promised 4 but showed 5). The renderer measures
  // and trims when incident notes make rows taller, so an optimistic static
  // estimate is safe; the corner badge covers what gets trimmed.
  services: listCapacity(45, 40),
  // Citi Bike shared TfL's 44px pitch, and it should not have: a TfL row is one
  // line (dot, name, status) and measures 35px, while a Citi Bike row carries the
  // station name AND a bikes/docks line and measures 40px. On a 10px minimum row
  // gap that is a 50px pitch, so 44 promised 5 stations in a 3-tall card that
  // holds 4 — measured overflowing by 7px at 3x3 and 4x3 with six stations
  // (2026-07-29). 51 is the corrected pitch; the resting card stops clipping for
  // anyone who follows five or six stations.
  citibike: listCapacity(51, 40),
  tfl: listCapacity(44, 40),
};

export function itemCapacity(id, w, h) {
  const model = MODELS[id];
  return model ? model(w, h) : null;
}

// Trim: the rows a widget habitually sheds BELOW its estimate. Two of the
// pitches above are deliberately optimistic, calibrated on the TYPICAL row (an
// all-Operational service, a Good-Service subway line), because those two
// renderers measure the drawn box and shed trailing rows to the corner count
// whenever an alert or an incident note wraps taller. Anything that plans a
// board has to discount by that.
//
// The fact used to be written three times at two different values: layout.js
// budgeted services one row, layout-optimize.js two, and only the optimizer
// carried the measurement that settles it. So the measurement wins, and it
// lives beside the pitch it corrects, where a future recalibration cannot move
// one and forget the other.
//
//   subway    1 across the sizes the generator emits (measured 5 of 6 at h=4,
//             7 of 8 at h=5, 11 of 12 at h=7, a third of 24 lines alerting).
//   services  2, not 1: an incident note makes a row half again as tall
//             (measured 3 of 5 at h=3, 5 of 7 at h=4, 10 of 12 at h=6, with
//             3 of 11 services degraded).
//
// The rail boards' trim is deliberately NOT here: theirs is a function of
// whether the live feed happens to carry an alert banner, which is a fact
// about the day rather than about the widget (layout-optimize.js DEMAND).
export const TRIM = Object.freeze({ subway: 1, services: 2 });
export const trimOf = (id) => TRIM[id] ?? 0;

function ofTotal(shown, total, unit) {
  if (total == null) return `next ${shown} ${unit}`;
  return shown >= total ? `shows all ${total} ${unit}` : `shows ${shown} of ${total} ${unit}`;
}

// Human impact line for edit mode. cfg supplies totals where they're known.
export function capacityLabel(id, w, h, cfg = {}) {
  const n = itemCapacity(id, w, h);
  switch (id) {
    case 'markets':
      return ofTotal(Math.min(n, cfg.markets?.symbols?.length ?? n), cfg.markets?.symbols?.length, 'tickers');
    case 'subway':
      return ofTotal(Math.min(n, cfg.subway?.lines?.length ?? n), cfg.subway?.lines?.length, 'lines');
    case 'lirr':
    case 'mnr':
    case 'njt':
    case 'amtrak':
      return `next ${n} trains`;
    case 'golf':
      return `top ${n} players`;
    case 'tennis':
      return `${n} matches`;
    case 'bus': {
      // Mirror the renderer's row split (each stop spends 1 header row, then
      // up to 3 arrival rows, while rows remain): the raw row budget counted
      // headers as buses and over-stated.
      const legs = Math.max(1, cfg.bus?.legs?.length || 1);
      let rows = n;
      let buses = 0;
      for (let i = 0; i < legs && rows >= 2; i++) {
        rows -= 1; // stop header
        const take = Math.min(3, rows);
        buses += take;
        rows -= take;
      }
      buses = buses || n;
      return `next ${buses} bus${buses === 1 ? '' : 'es'}`;
    }
    case 'path':
      return `next ${n} trains`;
    case 'ferry':
      return `next ${n} ferries`;
    case 'history':
      return `${n} event${n === 1 ? '' : 's'}`;
    case 'sports':
      return ofTotal(Math.min(n, cfg.sports?.teams?.length ?? n), cfg.sports?.teams?.length, 'teams');
    case 'news':
    case 'marketsnews':
    case 'sportsnews':
      return `${n} headlines`;
    case 'substack':
    case 'bsky':
      return `${n} posts`;
    case 'worldclock':
      return ofTotal(Math.min(n, cfg.worldclock?.cities?.length ?? n), cfg.worldclock?.cities?.length, 'cities');
    case 'services':
      return ofTotal(Math.min(n, cfg.services?.list?.length ?? n), cfg.services?.list?.length, 'services');
    case 'citibike':
      return ofTotal(Math.min(n, cfg.citibike?.stations?.length ?? n), cfg.citibike?.stations?.length, 'stations');
    case 'tfl':
      return ofTotal(Math.min(n, cfg.tfl?.lines?.length ?? n), cfg.tfl?.lines?.length, 'lines');
    case 'surf':
      // Must match surf.js render exactly: wide = w>=4 -> 8 columns at 3-hour
      // steps, else 6 at 4-hour steps. Both windows cover the same 24 hours,
      // so what a resize buys here is resolution, not reach.
      return `${w >= 4 ? 8 : 6} hourly wave heights`;
    case 'weather': {
      // Must match weather.js render exactly: big = w>=5||h>=5 → 5 days, else 4;
      // 8 hourly only when big AND at least 4 wide (a 3-wide column cannot hold
      // an 18px hour label), else 6. (Was hardcoded "2-day" with a mismatched
      // threshold.)
      const big = w >= 5 || h >= 5;
      return `${big && w >= 4 ? 8 : 6} hourly · ${big ? 5 : 4}-day forecast`;
    }
    default:
      return null;
  }
}

// Measured backstop for the .train boards, the same contract subway and
// services run: the static count above is calibrated on the TYPICAL 51px row,
// but a 3-wide LIRR row with a track pill wraps its meta line to 75px and a
// 3-wide NJT row with a status to 99px, and a device font with taller metrics
// can add a pixel or two everywhere. After the card renders, shed trailing rows
// until nothing is clipped, so an optimistic estimate costs a row rather than
// drawing half of one. Departures outrank banners at the floor: a shallow card
// carrying two alert banners has less than one row of space left, so the last
// banner yields rather than clip the next train (with no banners even the 99px
// worst-case row fits the 121px h=2 box, so the cascade always terminates).
export function fitTrainRows(el) {
  const trains = el.querySelector?.('.trains');
  if (!trains) return;
  // Three tabular digits (or the 999+ clamp) run ~95px against the 76px
  // column's exact two-digit fit, so the whole card widens its min column
  // while (and only while) such a row is on the board, keeping every row's
  // destination aligned. Toggled before measuring so the row fit below sees
  // the final geometry. (PATH and bus skip this pass; their realtime windows
  // cannot produce a 100-minute countdown.)
  trains.classList.toggle(
    'trains--widemin',
    [...trains.querySelectorAll('.train__min span')].some((s) => s.textContent.length > 2),
  );
  if (!trains.clientHeight) return; // no layout engine (unit tests)
  const over = () => trains.scrollHeight > trains.clientHeight;
  const rows = [...trains.querySelectorAll('.train')];
  while (over() && rows.length > 1) rows.pop().remove();
  const banners = [...el.querySelectorAll('.talert')];
  while (over() && banners.length) banners.pop().remove();
}

// Renderers read their card's size from the DOM (data-w/data-h set by the
// dashboard and by edit mode); tests render into bare divs and get defaults.
export function cardSize(el, defaults = [4, 4]) {
  const card = el.closest?.('.card');
  const w = Number(card?.dataset.w) || defaults[0];
  const h = Number(card?.dataset.h) || defaults[1];
  return [w, h];
}

// ---------------------------------------------------------------------------
// THE FIT: one question, how many rows fit.
//
// Every list renderer used to assemble the answer itself out of the same four
// moves (read the card's size, ask the model, clamp what the model said, then
// slice and draw), and the clamp is exactly where nineteen call sites drifted
// into six dialects: Math.max(1, ...) on the four rail boards, `?? 4` on five
// more, `?? 5` on services, nothing at all on seven, and PATH writing a
// compound of all three at once. Four widgets went further and measured the
// drawn box, in two copies of one shrink-grow-squeeze walk that only two of
// them had tests for.
//
// So the protocol is one call, and the dialects become arguments:
//
//   id          the widget's own meta.id, which is the capacity model's key.
//   items       the list being sliced. Optional: a widget that spends the
//               count as a BUDGET rather than slicing one list (bus shares it
//               between stop headers and arrivals, PATH between two direction
//               sections) has no single total to measure against.
//   draw(n, squeezed)  render n items into the body. Called once for the
//               estimate, and again for every step of the measured walk.
//   defaultSize the size to assume when there is no card to read one from
//               (tests render into bare divs; see cardSize).
//   min         the floor under the estimate, and the row the shed loop will
//               never take. This is the Math.max idiom.
//   fallback    what to draw when the model has no entry for this id. This is
//               the `??` idiom.
//   reserve     rows the card spends on something other than items before it
//               counts any (PATH's per-section labels).
//   measure     also run the shed loop against the drawn box.
//   squeeze     ...and, having shrunk, grow back into whatever room is left,
//               then spend the last of it on one row drawn short. Growing and
//               squeezing arrive together because they are one appetite: fill
//               the card. The two shrink-only callers must not grow: subway
//               settled its priority order against the estimate and would
//               start dealing rows it had already ruled out, and F1's columns
//               have no more rows to deal.
//   slack       pixels of overflow to tolerate before shedding. F1 shipped
//               with one of them; unifying it to zero would cost a standings
//               row on a hairline overflow.
//   clipped(body)  a second way for a draw not to fit, checked beside the box:
//               true when something drawn is cut short even though the body
//               does not overflow. History's shallow card counts an event its
//               line clamp ellipsised as not fitting, because a row is only
//               worth its place whole.
//   badge       stamp the corner count with what the fit left out. Off unless
//               asked, because three families count something else: the rail
//               boards count after their own measured fit, the news family
//               caps the count at what its reading list can seat, and bus
//               counts STOPS while it fits ROWS.
//
// Returns the count actually drawn.
// ---------------------------------------------------------------------------
export function fitList(body, {
  id, items, draw, defaultSize = [4, 4],
  min = 0, fallback = null, reserve = 0,
  measure = false, squeeze = false, slack = 0, badge = false, clipped = null,
}) {
  const [w, h] = cardSize(body, defaultSize);
  // The estimate, and the whole answer wherever there is no rendered box to
  // measure (happy-dom in tests, and any card the browser has not laid out
  // yet). A widget with neither a model nor a fallback lands on `min`, which
  // is what its old bare `slice(0, cap)` did with a null cap.
  const model = itemCapacity(id, w, h) ?? fallback;
  let n = Math.max(min, (model ?? 0) - reserve);
  if (items) n = Math.min(items.length, n);
  draw(n);
  if (measure && body.clientHeight > 0) {
    const over = () => body.scrollHeight > body.clientHeight + slack || !!clipped?.(body);
    // A card sheds down to its last row and no further: one row too few is the
    // corner count doing its job, half a row of clipping is a bug.
    const floor = Math.max(1, min);
    while (n > floor && over()) { n -= 1; draw(n); }
    if (squeeze) {
      const total = items?.length ?? n;
      while (n < total) {
        n += 1;
        draw(n);
        if (over()) { n -= 1; draw(n); break; }
      }
      // The loops fit WHOLE rows, so when the next one does not fit, most of a
      // row can sit empty. Spend it on one more item drawn short (a headline
      // clamped to one line, a service without its incident notes), because a
      // truncated row beats blank space, and the tap still tells the whole
      // story.
      if (n < total) {
        n += 1;
        draw(n, true);
        if (over()) { n -= 1; draw(n); }
      }
    }
  }
  if (badge && items) setMoreBadge(body, items.length - n);
  return n;
}
