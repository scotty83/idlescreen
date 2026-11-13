// Content-aware layout generation: fit the board to the data the user asked for.
//
// Every other add surface in this app places a newly checked widget at its
// hard-coded MIN_SIZE in the first free slot, top-left first. That is why a
// freshly set-up board is a pile of minimum-size cards with holes between them,
// and why a user who picks 11 tube lines sees two of them behind a "+9" badge.
// The blank space and the +N badges are the same bug seen from two sides.
//
//   optimizeLayout(ids, cfg) -> { layout, dropped, crowded, plan, metrics }
//
// Pure, side-effect free and deterministic: the same ids and the same cfg give a
// byte-identical layout, independent of the order the ids arrive in. No Date, no
// random, no DOM, no network — so /setup can re-run it on every checkbox change
// and a test can pin the output.
//
// SHAPE OF THE ALGORITHM
//   The board is 12 columns x 8 rows. Content demand is a HEIGHT question only —
//   every capacity model in capacity.js is a function of h alone, width never
//   enters it (asserted in test/layout-optimize.test.js). So the generator picks
//   a column structure, drops each card into a column, then spends the 8 rows of
//   each column on whatever those rows buy the most of.
//
//     1  column plan   enumerate splits of the 12 columns into 2..6 columns
//     2  assign        reading order, group-major, left to right
//     3  absorb        every column should own something that can eat spare rows
//     4  fill          award rows in RUNS to whoever buys the most per row
//     5  repair        first-improvement local search (move / swap between
//                      columns) against the objective in scoreOf
//     6  score         fewest unplaced -> fewest blank cells -> fewest broken
//                      promises -> most content value -> calmest columns
//
// SCOPE (v1, 2026-07-29): this drives /setup's layout generation only. The board's
// own edit-mode tray (as of 2026-08-01 its only add surface) keeps its firstFitAny
// behaviour on purpose — a user editing a board they arranged by hand should not
// have it silently reflowed under them. Quick Start keeps its hand-arranged
// showcase, which already tiles all 96 cells.

import { GRID, MIN_SIZE, MAX_SIZE, minAlternatives, contentMaxH } from './layout.js';
import { WIDGET_GROUPS, WIDGET_IDS } from './config.js';
import { itemCapacity, trimOf } from './capacity.js';

// ---------------------------------------------------------------------------
// The demand model: one question per widget — "how much card does this user's
// configuration actually need, and what is a bigger card worth?"
//
//   kind
//     'exact'   the list length is knowable from cfg. Truncation is a broken
//               promise ("I picked 4 teams and see 2"). Past the height that
//               shows the whole list a taller card only adds dead air, which is
//               the reason layout.js already carries CONTENT_CAPPED.
//     'elastic' an open-ended feed. `target` is the useful minimum; `feed` is
//               where more rows stop buying data (every rail feed slices to 12).
//     'canvas'  no list: a picture, a single fact, a chart. Worth its AREA, plus
//               a bonus for each renderer tier it reaches.
//
//   tiers     {h: bonus} — a real behaviour change in the renderer at that
//             height, cited to the file. Absolute: reaching a tier is worth the
//             same at any width.
//   soft      above this height extra area is nearly worthless (a taller Quote
//             of the Day is just bigger type) but still better than a hole.
//   widthTier [w, bonus] — a real behaviour change at that WIDTH.
//   trim      rows this card will lose that no static table can predict — a
//             number, or a function of cfg. Two causes, both measured in the
//             browser on 2026-07-29 and both genuinely unknowable up front:
//             a renderer that measures its drawn box and sheds trailing rows to
//             the +N badge (subway, services), and a service alert banner that
//             the .train boards subtract from their own capacity when the live
//             feed happens to carry one. Discount rather than spend the board on
//             a promise the browser will quietly break.
//   shape     [w, minH] — a card this wide needs at least this many rows or its
//             body clips. Measured, not guessed.
//
// Every citation here was re-checked against the live widget file on 2026-07-29.
// The tier heights are the one thing that drifts: if you change a renderer's
// size branches, fix the row here in the same commit.
// ---------------------------------------------------------------------------
export const DEMAND = {
  // ---- exact: config-bounded lists ----
  sports: { kind: 'exact', count: (c) => c.sports?.teams?.length },
  markets: { kind: 'exact', count: (c) => c.markets?.symbols?.length, widthTier: [4, 6] }, // markets.js:311 twoDay spark at w>=4
  // subway + services carry a deliberately optimistic pitch because their
  // renderers measure the rendered box and shed trailing rows to the corner
  // count. Ask for that headroom so a wrapped alert row does not turn "shows
  // all 6 lines" into "+1" on the wall. How many rows each sheds is the
  // measurement recorded next to the pitch it corrects (capacity.js TRIM), and
  // this table no longer keeps a second opinion of it.
  subway: { kind: 'exact', count: (c) => c.subway?.lines?.length, trim: trimOf('subway') },
  worldclock: { kind: 'exact', count: (c) => c.worldclock?.cities?.length },
  services: { kind: 'exact', count: (c) => c.services?.list?.length, trim: trimOf('services') },
  citibike: { kind: 'exact', count: (c) => c.citibike?.stations?.length },
  tfl: { kind: 'exact', count: (c) => c.tfl?.lines?.length },
  // bus spends 1 row on each stop header then up to 3 arrivals (capacity.js
  // capacityLabel), so its demand is counted in ROWS, not buses.
  bus: { kind: 'exact', count: (c) => Math.max(1, c.bus?.legs?.length || 1) * 4 },

  // ---- elastic: open-ended feeds ----
  // Rail: every feed slices to 12 departures (capacity.js RAIL_ROWS). target 5
  // is about the next 45-60 min at Penn/GCT frequencies — where a departure board
  // stops being a teaser. Rows past that still help (a later train to plan
  // around). Two rows go missing on a bad day and the browser confirmed both:
  // fitTrainRows() sheds one when a 3-wide row wraps its meta line, and the
  // renderer subtracts each service-alert banner straight off its own capacity
  // (lirr.js: `cap = itemCapacity(...) - alerts.length`). Measured at 3-wide with
  // one alert: 2 of 4 at h=3, 3 of 5 at h=4, 10 of 12 at h=8; at 6-wide, where the
  // meta line does not wrap, exactly one less than promised.
  lirr: { kind: 'elastic', target: 5, feed: 12, trim: (c) => (c.lirr?.alerts ? 2 : 1) },
  mnr: { kind: 'elastic', target: 5, feed: 12, trim: (c) => (c.mnr?.alerts ? 2 : 1) },
  njt: { kind: 'elastic', target: 5, feed: 12, trim: (c) => (c.njt?.alerts ? 2 : 1) },
  amtrak: { kind: 'elastic', target: 4, feed: 12, trim: (c) => (c.amtrak?.alerts ? 2 : 1) },
  ferry: { kind: 'elastic', target: 4, feed: 12, trim: 1 }, // no alert banners; fitTrainRows still applies
  path: { kind: 'elastic', target: 4, feed: 12 }, // path.js has no measure-trim
  news: { kind: 'elastic', target: 4, feed: 10 },
  marketsnews: { kind: 'elastic', target: 4, feed: 10 },
  // Same feed shape, but the Only-my-teams filter can cut the merged list to a
  // handful, so it is never worth buying rows past the shared target.
  sportsnews: { kind: 'elastic', target: 4, feed: 10 },
  // Post texts wrap to two lines almost always (capacity.js substack/bsky) and
  // the follow list caps at 6, so 6 is the ceiling worth chasing.
  substack: { kind: 'elastic', target: 3, feed: 6 },
  bsky: { kind: 'elastic', target: 3, feed: 6 },
  history: { kind: 'elastic', target: 3, feed: 8 },
  golf: { kind: 'elastic', target: 5, feed: 15 },
  tennis: { kind: 'elastic', target: 4, feed: 10 },

  // ---- canvas: area + renderer tiers ----
  // weather.js:441 big = w>=5||h>=5 -> 8 hourly + a 5-day strip (vs 6/4);
  // :464 adds the precipitation row at h>=5; :486 widens the trend chart.
  // shape: a weather card 5+ columns wide loses main.css's `.t-narrow`
  // compaction AND switches to the 8-hour / 5-day presentation, and the two
  // together do not fit four rows — 6x4 overflowed its body by 13px in the audit.
  // Wide means tall for this card. (A hand-dragged 6x4 still clips; that is a
  // pre-existing CSS gap the sweep found, not something the generator can emit.)
  weather: { kind: 'canvas', tiers: { 5: 34 }, widthTier: [5, 10], shape: [5, 5] },
  aqi: { kind: 'canvas', tiers: { 3: 14 }, soft: 5 },                    // aqi.js:24 leaves the shallow layout at h>=3
  wotd: { kind: 'canvas', tiers: { 3: 12 }, soft: 4, widthTier: [3, 8] }, // wotd.js:12 example line needs tier!=s AND w>2
  quote: { kind: 'canvas', soft: 4 },                                    // no tiers: a taller card is bigger type
  chart: { kind: 'canvas', widthTier: [3, 10] },                         // layout.js MIN_SIZE: in-image text reads at w>=3
  surf: { kind: 'canvas', soft: 6, widthTier: [4, 12] },                 // surf.js:441 8 vs 6 hourly wave heights at w>=4
  // Pictures are pure area. What keeps them off a letterbox sliver is the
  // presentable floor below, not an invented tier bonus.
  art: { kind: 'canvas' },
  landscapes: { kind: 'canvas' },
  photos: { kind: 'canvas' },
  gdrivephotos: { kind: 'canvas' },
  apod: { kind: 'canvas' },
  iptv: { kind: 'canvas', soft: 6 },
  f1: { kind: 'canvas', soft: 6 },
};

// ---------------------------------------------------------------------------
// PRESENTABLE FLOORS — Sean's call, 2026-07-29.
//
// MIN_SIZE is the smallest size a widget renders LEGIBLY, found by the browser
// overflow audit. It is not the smallest size a card is WORTH. A 3x2 LIRR board
// carrying a service alert shows exactly one departure; a 3x2 Art card is a
// letterbox sliver. Both are legal and both fill space, and neither is worth the
// cells it takes. So the generator will not put a data card below the size that
// shows a worthwhile amount of its data, and only relaxes to the bare legible
// minimum when the pick leaves it no choice (see optimizeLayout's second pass,
// which reports those ids as `crowded` so /setup can say so out loud).
//
//   items  the minimum number of the card's own list items it must show. For an
//          'exact' widget this is clamped to what the user actually configured —
//          a one-line subway pick is a complete promise at one line.
//   minH   a height floor for the cards that have no list to count.
//
// Only rows that BIND are listed: a floor at or below the widget's MIN_SIZE
// height would be decoration (worldclock shows 3 cities at its shallow 3x2 and
// 5 at its canonical 2x3 — three is the same "reads as the network" threshold
// the status boards below take as their floor — golf 5 players at 3x3, history
// 1 event at 2x2, bus a full stop at 3x3), and test/layout-optimize.test.js
// fails if a row here is inert.
// ---------------------------------------------------------------------------
export const FLOOR = {
  // A rail board below three departures is a teaser, not a board: you cannot
  // decide whether to leave now on one train. Three needs h=3 (4 measured rows
  // minus the trim allowance) — h=2 with an alert banner really does show one.
  lirr: { items: 3 },
  mnr: { items: 3 },
  njt: { items: 3 },
  amtrak: { items: 3 },
  ferry: { items: 3 },
  path: { items: 3 },
  // Same argument for the status boards: two lines is a sample, three reads as
  // "the network". Both are trim widgets, so three lines needs h=3.
  subway: { items: 3 },
  tfl: { items: 3 },
  services: { items: 3 },
  // A bike card answers "can I get one" — one station is a coin flip, three is
  // a choice of corner.
  citibike: { items: 3 },
  // Three tickers is the smallest set that reads as a market rather than a
  // number, and minH pins the sparkline: markets h<=2 is the shallow tier with
  // no spark at all (capacity.js markets, and CONTENT_CAPPED's search floor
  // exists to keep that richer tier reachable).
  markets: { items: 3, minH: 3 },
  // Headlines at one story is a ticker; three is a front page. h=3.
  news: { items: 3 },
  marketsnews: { items: 3 },
  sportsnews: { items: 3 },
  // Post rows are two lines each, so a 3x2 card holds one post and a badge.
  // Two posts (h=3) is the floor where the card reads as a feed.
  substack: { items: 2 },
  bsky: { items: 2 },
  // A picture below three rows is a letterbox strip that reads as a colour
  // swatch rather than an image — apod's MIN_SIZE is already 3x3 for exactly
  // this reason, and these four only escape it because they can also be a small
  // portrait tile.
  art: { minH: 3 },
  landscapes: { minH: 3 },
  photos: { minH: 3 },
  gdrivephotos: { minH: 3 },
};

const AREA_RATE = 1;   // value of one cell of picture / chart / single fact
const SOFT_RATE = 0.3; // ...above the widget's `soft` height
const ITEM_VALUE = 12; // one item from a list the user NAMED (a team, a ticker, a line)
const TARGET_ITEM = 10; // one row of an open-ended feed, up to its useful target
const SPARE_ITEM = 3;  // ...one row past that target
// ITEM_VALUE > TARGET_ITEM on purpose: when a column has one row to give and
// both a named list and an open-ended feed want it, the thing the user typed in
// wins. An exact card above the height that shows its whole list just centres a
// short list in a tall box (main.css clamps the elastic row gap, then centres),
// so dead air is priced NEGATIVE and the fill pass never buys it except in the
// explicit anti-hole phase.
const DEAD_AIR = -4;

// ---------------------------------------------------------------------------
// Reading order. Column order left-to-right follows this list so every board
// reads the same way: the sky, then how you get home, then money, then the rest,
// with the picture cards last (they are wallpaper, not information). Independent
// of WIDGET_GROUPS' own order, which is picker ergonomics, not board layout —
// but it must name exactly the same groups (asserted in the test).
// ---------------------------------------------------------------------------
export const GROUP_ORDER = ['Weather & Air', 'Commute', 'Markets', 'Sports', 'News & Social', 'Reference', 'Daily', 'Images'];
const GROUP_OF = new Map();
for (const g of WIDGET_GROUPS) for (const id of g.ids) GROUP_OF.set(id, g.label);
const groupRank = (id) => {
  const i = GROUP_ORDER.indexOf(GROUP_OF.get(id));
  return i === -1 ? GROUP_ORDER.length : i;
};
const idRank = (id) => WIDGET_IDS.indexOf(id);

// Capacity is a function of h alone, so the width passed here is irrelevant and
// MIN_SIZE's is used for every widget. This is the fact the whole optimizer
// rests on, and the test asserts it across every widget and every legal size.
const capAt = (id, h) => itemCapacity(id, MIN_SIZE[id][0], h);

// Smallest legal [w, h] for this widget inside a colW-wide column, honouring
// MIN_ALTS (wotd is 2x3 OR 3x2) and any measured `shape` rule. Prefers the
// shortest alternative that fits. This is the LEGIBLE floor: it is never relaxed,
// because below it the card clips.
export function legibleFloor(id, colW) {
  const fits = minAlternatives(id).filter(([mw]) => mw <= colW);
  if (!fits.length) return null;
  const base = fits.reduce((a, b) => (b[1] < a[1] ? b : a));
  const shape = DEMAND[id]?.shape;
  return shape && colW >= shape[0] ? [base[0], Math.max(base[1], shape[1])] : base;
}

const maxWFor = (id) => Math.min(MAX_SIZE[id]?.[0] ?? GRID.cols, GRID.cols);

// ---------------------------------------------------------------------------
// One evaluation context per optimizeLayout call. It caches the two things that
// are expensive and cfg-derived (the content caps and the per-column fit
// heights) WITHOUT keying anything off the cfg object itself: /setup mutates its
// cfg in place as the user edits tickers and lines, so a cache that outlived a
// call would hand back a stale board.
//
// `mode` is the floor policy: 'presentable' honours FLOOR, 'legible' falls back
// to MIN_SIZE / MIN_ALTS for an oversubscribed pick.
// ---------------------------------------------------------------------------
function makeCtx(cfg, mode) {
  const caps = contentMaxH(cfg ?? {});
  const memo = new Map();
  const once = (key, make) => {
    if (!memo.has(key)) memo.set(key, make());
    return memo.get(key);
  };
  const ctx = {
    cfg: cfg ?? {},
    mode,
    count: (id) => DEMAND[id]?.count?.(ctx.cfg) || 0,
    maxH: (id) => Math.min(MAX_SIZE[id]?.[1] ?? GRID.rows, caps[id] ?? GRID.rows, GRID.rows),
    trim: (id) => {
      const t = DEMAND[id]?.trim;
      return (typeof t === 'function' ? t(ctx.cfg) : t) ?? 0;
    },
    // Items this card actually shows at height h, and the user's own total.
    shownAt: (id, h) => {
      const d = DEMAND[id];
      const cap = capAt(id, h);
      if (!d || cap == null) return { shown: null, total: null };
      const eff = Math.max(1, cap - ctx.trim(id));
      const total = d.kind === 'exact' ? ctx.count(id) : d.kind === 'elastic' ? d.feed : null;
      if (total == null) return { shown: eff, total: null };
      return { shown: Math.min(eff, total), total };
    },
    // The height that satisfies this user's data: exact -> the whole list is on
    // screen; elastic -> `target` rows; canvas -> its lowest renderer tier.
    fitH: (id, colW) => once(`f${id}:${colW}`, () => {
      const floor = legibleFloor(id, colW);
      if (!floor) return null;
      const d = DEMAND[id];
      const hi = ctx.maxH(id);
      if (!d) return floor[1];
      if (d.kind === 'canvas') {
        const tiers = Object.keys(d.tiers ?? {}).map(Number);
        return Math.min(hi, Math.max(floor[1], ...(tiers.length ? [Math.min(...tiers)] : [floor[1]])));
      }
      const want = d.kind === 'exact' ? ctx.count(id) || 1 : d.target;
      for (let h = floor[1]; h <= hi; h++) if ((ctx.shownAt(id, h).shown ?? Infinity) >= want) return h;
      return hi;
    }),
    // The presentable floor: the smallest height that shows a worthwhile amount.
    // An unreachable floor is not a constraint (it would refuse the card for
    // being physically small), so it falls back to the legible minimum.
    presentableH: (id, colW) => once(`p${id}:${colW}`, () => {
      const base = legibleFloor(id, colW)?.[1] ?? null;
      if (base == null) return null;
      const f = FLOOR[id];
      if (!f) return base;
      const hi = ctx.maxH(id);
      let want = Math.min(Math.max(base, f.minH ?? base), hi);
      if (f.items) {
        const n = DEMAND[id]?.kind === 'exact' ? Math.min(f.items, ctx.count(id) || f.items) : f.items;
        for (let h = base; h <= hi; h++) {
          if ((ctx.shownAt(id, h).shown ?? 0) >= n) { want = Math.max(want, h); break; }
        }
      }
      return Math.min(want, hi);
    }),
  };
  // The floor the search RESERVES. Feasibility never depends on the growth
  // passes, so whatever this returns is what every card is guaranteed.
  ctx.floorH = (colW, id) => (ctx.mode === 'presentable' ? ctx.presentableH(id, colW) : legibleFloor(id, colW)?.[1]);
  // Memoized column fill (see place()). Keyed on width + ids in order.
  ctx.column = (colW, ids) => once(`c${colW}|${ids.join(',')}`, () => fillColumn(ctx, colW, ids));
  return ctx;
}

// ---------------------------------------------------------------------------
// ABSOLUTE value of a card at [w, h]. Absolute rather than incremental on
// purpose: scoring only the growth above the floor secretly rewarded narrow
// columns, because narrow floors leave more cells over to "earn".
//   exact   12 per item the user asked for and can see. Area is irrelevant —
//           which is why the generator keeps list cards tight and spends the
//           leftover space on the flexible ones, exactly as intended.
//   elastic 10 per row up to the useful target, 3 for each extra.
//   canvas  1 per cell (0.3 above `soft`), plus each renderer tier reached.
// Plus a one-off width bonus wherever a renderer really changes at a width.
// ---------------------------------------------------------------------------
function cardValue(ctx, id, w, h) {
  const d = DEMAND[id];
  const wb = widthBonus(id, w);
  if (!d) return wb + AREA_RATE * w * h;
  if (d.kind === 'canvas') {
    const soft = d.soft ?? GRID.rows;
    const area = w * (Math.min(h, soft) * AREA_RATE + Math.max(0, h - soft) * SOFT_RATE);
    let tiers = 0;
    for (const [th, bonus] of Object.entries(d.tiers ?? {})) if (h >= Number(th)) tiers += bonus;
    return wb + area + tiers;
  }
  const { shown } = ctx.shownAt(id, h);
  if (d.kind === 'exact') return wb + ITEM_VALUE * shown;
  return wb + TARGET_ITEM * Math.min(shown, d.target) + SPARE_ITEM * Math.max(0, shown - d.target);
}

// Marginal value of growing this card from h-1 to h inside a colW-wide column.
function stepValue(ctx, id, h, colW) {
  if (h > ctx.maxH(id)) return -Infinity;
  const gain = cardValue(ctx, id, colW, h) - cardValue(ctx, id, colW, h - 1);
  return DEMAND[id]?.kind === 'exact' && gain <= 0 ? DEAD_AIR : gain;
}

// One-off bonus for a column wider than the widget's floor, only where the
// RENDERER changes behaviour at that width (not a generic "wider is nicer").
function widthBonus(id, w) {
  const t = DEMAND[id]?.widthTier;
  return t && w >= t[0] ? t[1] : 0;
}

// A widget that can usefully absorb spare rows. Every column wants one, so no
// column ends up with a hole (or a short list floating in a tall card).
const isAbsorber = (id) => DEMAND[id]?.kind !== 'exact';

// ---------------------------------------------------------------------------
// Pass 1 — column plans. Parts from {2,3,4,6} summing to exactly 12. [3,3,3,3]
// is listed first because it is the split DEFAULT_LAYOUT and QUICKSTART_CONFIG
// already use, so ties resolve toward the look the product already has.
// ---------------------------------------------------------------------------
const PLANS = [
  [3, 3, 3, 3],
  [4, 4, 4],
  [6, 3, 3],
  [4, 4, 2, 2],
  [4, 3, 3, 2],
  [6, 6],
  [3, 3, 2, 2, 2],
  [6, 4, 2],
  [6, 2, 2, 2],
  [4, 2, 2, 2, 2],
  [2, 2, 2, 2, 2, 2],
];

// Distinct permutations, lexicographic — deterministic and small (50 in all).
function perms(arr) {
  const out = [];
  const walk = (rest, acc) => {
    if (!rest.length) { out.push(acc); return; }
    const seen = new Set();
    for (let i = 0; i < rest.length; i++) {
      if (seen.has(rest[i])) continue;
      seen.add(rest[i]);
      walk([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
    }
  };
  walk([...arr].sort((a, b) => a - b), []);
  return out;
}
const ARRANGEMENTS = PLANS.flatMap((p) => perms(p));

// A column may hold a card only if the card fits its width (MAX_SIZE stops the
// status rows from stretching; MIN_ALTS sets the narrow floor).
const canHost = (colW, id) => colW <= maxWFor(id) && legibleFloor(id, colW) != null;
const usedFloor = (ctx, col) => col.ids.reduce((s, id) => s + ctx.floorH(col.w, id), 0);
const feasible = (ctx, col) => col.ids.every((id) => canHost(col.w, id)) && usedFloor(ctx, col) <= GRID.rows;

// ---------------------------------------------------------------------------
// Pass 2 — assignment. Reading order; each card takes the first column that can
// legally hold it. Preference, in order:
//   a) a column already holding its group AND with room for the card's FIT
//      height — commute cards stack together as long as they all still get
//      their data
//   b) an empty column — a hungry card starts a fresh stack rather than
//      squeezing in at its floor
//   c) a column holding its group, at the floor
//   d) whichever column has the most area left
// ---------------------------------------------------------------------------
function assign(ctx, ids, widths) {
  const cols = widths.map((w, i) => ({ i, w, ids: [] }));
  const dropped = [];
  const ordered = [...ids].sort((a, b) =>
    groupRank(a) - groupRank(b) ||
    (ctx.floorH(GRID.cols, b) ?? 0) - (ctx.floorH(GRID.cols, a) ?? 0) ||
    idRank(a) - idRank(b));

  for (const id of ordered) {
    const legal = cols.filter((c) => canHost(c.w, id) && usedFloor(ctx, c) + ctx.floorH(c.w, id) <= GRID.rows);
    if (!legal.length) { dropped.push(id); continue; }
    const kin = (c) => c.ids.some((o) => GROUP_OF.get(o) === GROUP_OF.get(id));
    const roomy = legal.filter((c) => kin(c) && usedFloor(ctx, c) + ctx.fitH(id, c.w) <= GRID.rows);
    const pick = roomy[0] ?? legal.find((c) => !c.ids.length) ?? legal.find(kin)
      ?? legal.slice().sort((a, b) =>
        (b.w * (GRID.rows - usedFloor(ctx, b))) - (a.w * (GRID.rows - usedFloor(ctx, a))) || a.i - b.i)[0];
    pick.ids.push(id);
  }
  return { cols, dropped };
}

// ---------------------------------------------------------------------------
// Pass 3 — absorber balancing. A column of nothing but exact cards cannot spend
// spare rows without opening dead air inside a card, so trade one absorber
// (elastic or canvas) in from a column that has two or more.
// ---------------------------------------------------------------------------
function balanceAbsorbers(ctx, cols) {
  for (const need of cols) {
    if (!need.ids.length || usedFloor(ctx, need) >= GRID.rows) continue;
    if (need.ids.some(isAbsorber)) continue;
    const donor = cols.find((c) => c !== need && c.ids.filter(isAbsorber).length > 1);
    if (!donor) continue;
    const move = donor.ids
      .filter((id) => isAbsorber(id) && canHost(need.w, id))
      .sort((a, b) => ctx.floorH(need.w, a) - ctx.floorH(need.w, b) || idRank(a) - idRank(b))
      .find((id) => usedFloor(ctx, need) + ctx.floorH(need.w, id) <= GRID.rows);
    if (!move) continue;
    donor.ids.splice(donor.ids.indexOf(move), 1);
    need.ids.push(move);
  }
}

// ---------------------------------------------------------------------------
// Pass 4 — fill. Rows are awarded in RUNS, priced per row: a card whose next
// single row buys nothing but whose next TWO rows reveal an item still competes.
// (markets holds 3 tickers at both h=2 and h=3, so a one-row lookahead strands a
// 12-ticker card at 3 forever — the exact bug in today's boards.)
//
//   value per row = 12 x items revealed | renderer tier bonus | area growth
//
// so the data-driven cards outbid polish with no special-casing. Phase A only
// awards rows that buy something; phase B is the last resort against a hole — an
// exact card may run up to +2 rows past its fit height, spending dead air inside
// the card rather than leaving a gap in the wall.
// ---------------------------------------------------------------------------
function place(ctx, cols) {
  // Filling a column depends on nothing but its width and the ids in it, so the
  // repair pass — which re-places every column after touching two — gets the rest
  // for free. Worth roughly a 3x on a 12-widget pick, which is the case where
  // /setup runs this on a phone.
  return cols.map((col) => ctx.column(col.w, col.ids).map((it) => ({ ...it })));
}

function fillColumn(ctx, colW, ids) {
  const items = ids.map((id) => ({ id, h: ctx.floorH(colW, id) }));
  if (!items.length) return items;
  for (const phase of ['A', 'B']) {
    for (;;) {
      const spare = GRID.rows - items.reduce((s, it) => s + it.h, 0);
      if (spare <= 0) break;
      let best = null;
      for (const [pos, it] of items.entries()) {
        const ceiling = phase === 'B'
          ? Math.min(ctx.maxH(it.id), ctx.fitH(it.id, colW) + 2)
          : ctx.maxH(it.id);
        let acc = 0;
        for (let k = 1; k <= spare && it.h + k <= ceiling; k++) {
          acc += stepValue(ctx, it.id, it.h + k, colW);
          const rate = acc / k;
          if (phase === 'A' && rate <= 0) continue;
          if (!best || rate > best.rate
            || (rate === best.rate && (k < best.k || (k === best.k && pos < best.pos)))) {
            best = { it, k, rate, pos };
          }
        }
      }
      if (!best) break;
      best.it.h += best.k;
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Pass 6 — objective, compared field by field.
// ---------------------------------------------------------------------------
function scoreOf(ctx, cols, placed, dropped, widths) {
  let cells = 0, value = 0, cohesion = 0, broken = 0;
  for (const [ci, col] of cols.entries()) {
    for (const [i, it] of placed[ci].entries()) {
      const w = Math.min(col.w, maxWFor(it.id));
      cells += w * it.h;
      value += cardValue(ctx, it.id, w, it.h);
      if (i && GROUP_OF.get(placed[ci][i - 1].id) === GROUP_OF.get(it.id)) cohesion += 1;
      if (DEMAND[it.id]?.kind === 'exact') {
        const { shown, total } = ctx.shownAt(it.id, it.h);
        broken += Math.max(0, (total ?? 0) - (shown ?? 0));
      }
    }
  }
  const spread = Math.max(...widths) - Math.min(...widths);
  return { dropped: dropped.length, blank: GRID.cols * GRID.rows - cells, broken, value, cohesion, spread };
}
const better = (a, b) =>
  a.dropped !== b.dropped ? a.dropped < b.dropped
    : a.blank !== b.blank ? a.blank < b.blank
      : a.broken !== b.broken ? a.broken < b.broken
        : a.value !== b.value ? a.value > b.value
          : a.spread !== b.spread ? a.spread < b.spread
            : a.cohesion !== b.cohesion ? a.cohesion > b.cohesion
              : false;

// ---------------------------------------------------------------------------
// Pass 5 — repair. The greedy construction is column-local, so a card can end up
// starved in a tight column while another column has rows to spare. Walk every
// single move and every single swap between columns in a fixed order and take the
// FIRST strictly better one (first-improvement hill climbing: no randomness, so
// the result is reproducible).
// ---------------------------------------------------------------------------
const ROUNDS = 8;
function repair(ctx, cols, dropped, widths) {
  const evalNow = () => {
    const placed = place(ctx, cols);
    return { placed, score: scoreOf(ctx, cols, placed, dropped, widths) };
  };
  let cur = evalNow();
  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    for (const from of cols) {
      for (const id of [...from.ids]) {
        for (const to of cols) {
          if (to === from) continue;
          // MOVE
          if (canHost(to.w, id)) {
            const save = [[...from.ids], [...to.ids]];
            from.ids.splice(from.ids.indexOf(id), 1);
            to.ids.push(id);
            if (feasible(ctx, from) && feasible(ctx, to)) {
              const next = evalNow();
              if (better(next.score, cur.score)) { cur = next; moved = true; break; }
            }
            from.ids = save[0]; to.ids = save[1];
          }
          // SWAP
          for (const other of [...to.ids]) {
            if (!canHost(to.w, id) || !canHost(from.w, other)) continue;
            const save = [[...from.ids], [...to.ids]];
            from.ids[from.ids.indexOf(id)] = other;
            to.ids[to.ids.indexOf(other)] = id;
            if (feasible(ctx, from) && feasible(ctx, to)) {
              const next = evalNow();
              if (better(next.score, cur.score)) { cur = next; moved = true; break; }
            }
            from.ids = save[0]; to.ids = save[1];
          }
          if (moved) break;
        }
        if (moved) break;
      }
      if (moved) break;
    }
    if (!moved) break;
  }
  return cur;
}

function search(ctx, want) {
  let champ = null;
  for (const widths of ARRANGEMENTS) {
    const { cols, dropped } = assign(ctx, want, widths);
    balanceAbsorbers(ctx, cols);
    const { placed, score } = repair(ctx, cols, dropped, widths);
    if (!champ || better(score, champ.score)) champ = { ctx, cols, placed, dropped, widths, score };
  }
  return champ;
}

// Debug hook: every arrangement with its score, best first.
export function explainPlans(ids, cfg, mode = 'presentable') {
  const ctx = makeCtx(cfg, mode);
  const want = [...new Set(ids)].filter((id) => id in MIN_SIZE);
  const out = [];
  for (const widths of ARRANGEMENTS) {
    const { cols, dropped } = assign(ctx, want, widths);
    balanceAbsorbers(ctx, cols);
    const { placed, score } = repair(ctx, cols, dropped, widths);
    out.push({ widths, score, cols: cols.map((c, i) => `${c.w}:[${placed[i].map((it) => it.id + it.h).join(' ')}]`).join(' ') });
  }
  return out.sort((a, b) => (better(a.score, b.score) ? -1 : better(b.score, a.score) ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The whole point.
//
//   layout   {id,x,y,w,h}[] — survives normalizeLayout(layout, contentMaxH(cfg))
//            byte for byte (asserted in the test; that round trip is what
//            re-opens holes if the generator ignores the content caps)
//   dropped  ids that could not be placed anywhere at their legible minimum.
//            For any pick of 12 or fewer this is empty in practice.
//   crowded  ids that had to give up their presentable floor because the pick
//            asked for more than the board holds — /setup says so rather than
//            pretending a sliver is a card.
//   plan     the chosen column widths, left to right
//   metrics  the winning score (blank cells, broken promises, content value)
// ---------------------------------------------------------------------------
export function optimizeLayout(ids, cfg) {
  const want = [...new Set(ids)].filter((id) => id in MIN_SIZE);
  if (!want.length) return { layout: [], dropped: [], crowded: [], plan: [], metrics: null };

  // Degradation, in the order that costs the user least: first try to give every
  // card its presentable floor. Only if that cannot place everything do we fall
  // back to the legible minimums — a card the user checked appearing small beats
  // a card the user checked not appearing.
  const presentable = makeCtx(cfg, 'presentable');
  let champ = search(presentable, want);
  if (champ.score.dropped) {
    const relaxed = search(makeCtx(cfg, 'legible'), want);
    if (relaxed.score.dropped < champ.score.dropped) champ = relaxed;
  }

  // The search optimizes content, not reading order, so impose the order at the
  // end: columns left-to-right by the highest-priority group they hold, cards
  // top-to-bottom the same way. Two consequences worth having — weather (or the
  // commute, if there is no weather card) always lands top-left like
  // DEFAULT_LAYOUT, and two arrangements that differ only in column order
  // collapse to one board, so the result stops depending on search order.
  const stacks = champ.cols
    .map((col, ci) => ({
      w: col.w,
      items: [...champ.placed[ci]].sort((a, b) =>
        groupRank(a.id) - groupRank(b.id) || b.h - a.h || idRank(a.id) - idRank(b.id)),
    }))
    .filter((s) => s.items.length)
    .sort((a, b) =>
      groupRank(a.items[0].id) - groupRank(b.items[0].id) ||
      b.w - a.w ||
      idRank(a.items[0].id) - idRank(b.items[0].id));

  const layout = [];
  const crowded = [];
  let x = 0;
  for (const s of stacks) {
    let y = 0;
    for (const it of s.items) {
      const w = Math.min(s.w, maxWFor(it.id));
      layout.push({ id: it.id, x, y, w, h: it.h });
      if (it.h < presentable.presentableH(it.id, s.w)) crowded.push(it.id);
      y += it.h;
    }
    x += s.w;
  }
  return { layout, dropped: [...champ.dropped], crowded, plan: stacks.map((s) => s.w), metrics: champ.score };
}

// ---------------------------------------------------------------------------
// Shared measurement, so a BEFORE and an AFTER board are judged identically.
//   blank        empty cells of 96
//   hiddenTotal  items the user would see on a taller card but cannot
//   hiddenExact  the subset the user EXPLICITLY configured — the broken
//                promises, and the number that matters
//   impossible   of those, the ones no legal card size could have shown (12
//                tickers do not fit any markets card), so a regression test can
//                demand zero AVOIDABLE breakage
// A widget that could not be placed at all hides everything it would have shown;
// counting only the placed cards would flatter whichever generator gave up first.
// ---------------------------------------------------------------------------
export function measure(layout, cfg, absent = []) {
  const ctx = makeCtx(cfg, 'presentable');
  let cells = 0, hiddenExact = 0, hiddenTotal = 0, impossible = 0;
  const detail = [];
  const ceiling = (id) => {
    let best = 0;
    for (let h = MIN_SIZE[id][1]; h <= GRID.rows; h++) best = Math.max(best, ctx.shownAt(id, h).shown ?? 0);
    return best;
  };
  for (const id of absent) {
    const d = DEMAND[id];
    if (!d) continue;
    const total = ctx.shownAt(id, GRID.rows).total ?? 0;
    if (d.kind === 'exact') { hiddenExact += total; impossible += Math.max(0, total - ceiling(id)); }
    hiddenTotal += total;
    if (total) detail.push(`${id} ABSENT 0/${total}${d.kind === 'exact' ? '!' : ''}`);
  }
  for (const r of layout) {
    cells += r.w * r.h;
    const d = DEMAND[r.id];
    if (!d || capAt(r.id, r.h) == null) continue;
    const { shown, total } = ctx.shownAt(r.id, r.h);
    if (total == null) continue;
    const hid = Math.max(0, total - shown);
    if (d.kind === 'exact') { hiddenExact += hid; impossible += Math.max(0, total - ceiling(r.id)); }
    hiddenTotal += hid;
    if (hid) detail.push(`${r.id} ${r.w}x${r.h} ${shown}/${total}${d.kind === 'exact' ? '!' : ''}`);
  }
  return { blank: GRID.cols * GRID.rows - cells, cells, hiddenExact, hiddenTotal, impossible, detail };
}
