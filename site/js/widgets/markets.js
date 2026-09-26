// Markets widget: Dow / Nasdaq / S&P 500 via the Worker (upstream is the
// unofficial Yahoo Finance chart API — Worker-side only, cached, and this
// widget hides itself when the payload is unusable).

import { WORKER_URL } from '../env.js';
import { escapeHtml, fmtClock, chaikin } from '../util.js';
import { setCardNote } from '../card.js';
import { fitList, cardSize } from '../capacity.js';
import { setExpandSource, OVERLAY_BODY_H } from '../expand.js';
import { dealColumns, gridStyle } from '../columns.js';

export const meta = { id: 'markets', title: 'Markets', refreshMs: 5 * 60 * 1000 };

// Normalizes a series into [x, y] points spanning w×h (padding baked in).
function sparkPts(values, w, h) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 2;
  return values.map((v, i) => [
    pad + (i * (w - 2 * pad)) / (values.length - 1),
    pad + (1 - (v - min) / span) * (h - 2 * pad),
  ]);
}
const toPath = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

// Normalizes a series into an SVG path spanning w×h.
export function sparkPath(values, w, h) {
  return toPath(sparkPts(values, w, h));
}

// X (in a w-wide viewBox) of the yesterday|today divider: the midpoint of the
// gap between the last prior-session point (split-1) and the first today point
// (split), matching sparkPath's index→x mapping.
export function sparkDividerX(len, split, w = 90, pad = 2) {
  const step = (w - 2 * pad) / (len - 1);
  return pad + (split - 0.5) * step;
}

// Y (in the 28-tall viewBox) of a value, using a series' own min/max — matches
// sparkPts' value→y mapping, so a value in `values` lands on its plotted point.
export function yForValue(val, values, h = 28, pad = 2) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return pad + (1 - (val - min) / span) * (h - 2 * pad);
}

// Splits a polyline into GREEN (at/above the baseline) and RED (below) subpaths,
// cutting each segment exactly where it crosses the baseline y. Pure geometry
// with plain <path> data — deliberately NO SVG clip-paths, which the board's
// gen1 WebEngine renders unreliably (a crossing line dropped out entirely).
export function colorSplit(pts, yBase) {
  let up = '';
  let down = '';
  const push = (above, x1, y1, x2, y2) => {
    const s = `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;
    if (above) up += s; else down += s;
  };
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const a1 = y1 <= yBase; // smaller y = higher price = above the baseline (green)
    const a2 = y2 <= yBase;
    if (a1 === a2) {
      push(a1, x1, y1, x2, y2);
    } else {
      const xc = x1 + ((yBase - y1) / (y2 - y1)) * (x2 - x1); // x where it crosses
      push(a1, x1, y1, xc, yBase);
      push(a2, xc, yBase, x2, y2);
    }
  }
  return { up, down };
}

// Splits a monotonic-x polyline at x = xc, interpolating the point on the line
// there so the two halves join EXACTLY at xc (the day divider). Returns
// { left, right }, both including the join point, so the white prior session and
// the coloured today meet with no gap or kink.
export function splitAtX(pts, xc) {
  const k = pts.findIndex(([x]) => x >= xc);
  if (k <= 0) return { left: [], right: pts };
  if (pts[k][0] === xc) return { left: pts.slice(0, k + 1), right: pts.slice(k) };
  const [x1, y1] = pts[k - 1];
  const [x2, y2] = pts[k];
  const cross = [xc, y1 + ((xc - x1) / (x2 - x1)) * (y2 - y1)];
  return { left: [...pts.slice(0, k), cross], right: [cross, ...pts.slice(k)] };
}

// Sparkline SVG. The CURRENT session is coloured against the prior close: green
// where the price sits above it, red where below, cut cleanly at the crossing
// so an intraday move that dips through the baseline shows BOTH colours. Wide
// cards (twoDay) draw the prior session in WHITE ahead of a dashed day-boundary
// rule; compact cards draw today alone, coloured the same way.
function sparkSvg(ix, cls = 'spark') {
  const two =
    ix.twoDay &&
    Array.isArray(ix.spark2) &&
    ix.spark2.length > 2 &&
    ix.split > 0 &&
    ix.split < ix.spark2.length;
  const series = two ? ix.spark2 : ix.spark;
  const pts = sparkPts(series, 90, 28);
  if (pts.length < 2) return `<svg class="${cls}" viewBox="0 0 90 28" preserveAspectRatio="none"></svg>`;
  // Colour baseline = the prior close. Two-day: yesterday's last bar (the split
  // point); compact: price − change. The current segment starts there, so the
  // overnight move reads as part of today.
  const baseVal = two ? series[ix.split - 1] : ix.price - ix.change;
  const yBase = yForValue(baseVal, series);
  // Smooth the WHOLE line once (Chaikin), then split at the day divider — so the
  // white prior session flows seamlessly into today's colour. Smoothing the two
  // halves separately left a visible kink at the boundary.
  const sm = chaikin(pts);
  let extras = '';
  let todayPts = sm;
  if (two) {
    const dx = sparkDividerX(series.length, ix.split);
    const { left, right } = splitAtX(sm, dx);
    todayPts = right;
    extras = `<path class="spark__prev" d="${toPath(left)}" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` +
      `<line class="spark__div" x1="${dx.toFixed(1)}" y1="-5" x2="${dx.toFixed(1)}" y2="33" vector-effect="non-scaling-stroke"/>`;
  }
  const { up, down } = colorSplit(todayPts, yBase);
  const today =
    (up ? `<path class="spark__up" d="${up}" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : '') +
    (down ? `<path class="spark__down" d="${down}" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` : '');
  return `<svg class="${cls}" viewBox="0 0 90 28" preserveAspectRatio="none">${extras}${today}</svg>`;
}

const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- tap-to-expand: the full ticker wall ----------

// Indices (^-prefixed symbols) lead the wall on their own shelf; everything
// else falls to the grid below. Both keep their relative config order, so a
// user who interleaves ^GSPC among their stocks still gets a clean two-band
// wall in the order they wrote.
export const isIndexSymbol = (symbol) => String(symbol ?? '').startsWith('^');

// Overlay geometry, browser-measured on the fixed 1920x1080 board (the same
// fixed-pixel reasoning capacity.js uses for card rows — the canvas never
// changes size): the wall's content box, a shelf row, the shelf's hairline
// block, and the floor a grid tile needs to hold its four lines. The canvas
// itself is the shared one every overlay gets.
export const WALL_H = OVERLAY_BODY_H;
const SHELF_ROW = 225;
const RULE_BLOCK = 53;
// A grid tile's four lines with the sparkline at its 36px minimum measure 163px
// (browser-measured at the 20-ticker cap); 175 is that floor plus enough slack
// that the chart still shows some curve rather than a flat 36px sliver.
const TILE_MIN = 175;
const TILE_GAP = 20;
// Six columns is the width ceiling. Measured: 6 across gives a 279px tile,
// which holds a five-character ticker (GOOGL, SAP.DE) only in the denser type
// below; 7 across gives 237px and ellipses those symbols however the type is
// trimmed, and a symbol nobody can read whole defeats the wall.
// At that width the tile switches to .wall__grid--dense in main.css.
const MAX_COLS = 6;

// The band a shelf occupies: its own rows, plus the hairline block when a grid
// follows it.
function shelfBlock(rows, withGrid) {
  return rows ? rows * SHELF_ROW + (rows - 1) * TILE_GAP + (withGrid ? RULE_BLOCK : 0) : 0;
}

// Grid rows that clear the tile floor once the shelf has taken its share. ZERO
// is a real answer, and the reason there is no Math.max(1, …) here: three shelf
// rows leave 86px, which does not hold a 175px tile, so claiming one row fits
// there is how the wall came to approve a 943px layout on an 854px canvas.
// Answering honestly makes gridFits fail and the shelf fold, which is the
// degradation the wall already knows how to do.
function maxRows(shelfRows) {
  const avail = WALL_H - shelfBlock(shelfRows, true);
  return Math.max(0, Math.floor((avail + TILE_GAP) / (TILE_MIN + TILE_GAP)));
}

// The wall's modeled height — the one number the fit rules are judged against,
// and the number a browser measurement of the overlay should match.
export function wallHeight(nShelf, nRest) {
  const sRows = nShelf ? Math.ceil(nShelf / shelfCols(nShelf)) : 0;
  const gRows = nRest ? Math.ceil(nRest / tileCols(nRest, sRows)) : 0;
  return shelfBlock(sRows, gRows > 0) + (gRows ? gRows * TILE_MIN + (gRows - 1) * TILE_GAP : 0);
}

// Columns for n tiles in the stock grid on the 1920-wide overlay. Config caps
// the list at 20, so the grid runs to four rows of generous tiles. A tall shelf
// eats the canvas, so the grid then trades columns for rows rather than
// squeezing tiles below the height their four lines need.
export function tileCols(n, shelfRows = 0) {
  // The wall's PREFERRED shape at each ticker count, browser-measured: three
  // across is right for six tiles, four for eight. The wall's own row cost
  // (maxRows, the tile floor against what the shelf left) can only push that
  // wider from there, never narrower, which is the `from` the shared deal grows
  // out of.
  const preferred = n <= 3 ? Math.max(n, 1) : n <= 4 ? 2 : n <= 6 ? 3 : n <= 8 ? 4 : 5;
  return dealColumns(n, {
    fitsOneColumn: maxRows(shelfRows),
    maxColumns: MAX_COLS,
    from: preferred,
  }).columns;
}

// Whether the watchlist grid still clears the tile floor with the shelf in place.
const gridFits = (n, shelfRows) => Math.ceil(n / tileCols(n, shelfRows)) <= maxRows(shelfRows);

// The shelf earns its place only when the whole wall still fits around it: its
// own rows must clear the canvas, and the watchlist below must still clear the
// tile floor. A twenty-long list behind one or two indices cannot afford the
// shelf's 278px band, so the indices fold back into the grid as ordinary tiles
// — they ARE ordinary entries, and the shelf is the luxury, not the list.
export function shelfFits(nShelf, nRest) {
  if (!nShelf) return false;
  const rows = Math.ceil(nShelf / shelfCols(nShelf));
  if (nRest && !gridFits(nRest, rows)) return false; // the watchlist can't clear its floor
  return wallHeight(nShelf, nRest) <= WALL_H; // and the whole wall clears the canvas
}

// Shelf columns. Index tiles carry the big lead type (a 46px six-figure price
// beside its change), which needs ~400px of tile: measured, 5 across (340px)
// overflows the price row. Four is the hard ceiling, so a long index list wraps
// to a second shelf row instead of squeezing.
export function shelfCols(n) {
  return n <= 4 ? Math.max(n, 1) : Math.min(4, tileCols(n));
}

// One tile per configured symbol. An index leads with its friendly name (a
// symbol nobody reads aloud) and carries ^SYM underneath; a stock leads with
// its symbol and carries the company name. Sparklines take the compact
// single-session form: a tile is small, and the two-day shape needs the card's
// full width to read.
function tile(ix) {
  const up = ix.change >= 0;
  const index = isIndexSymbol(ix.symbol);
  const lead = index ? ix.name : ix.symbol;
  const sub = index ? ix.symbol : ix.name;
  const dir = up ? 'up' : 'down';
  return `<div class="tile${index ? ' tile--index' : ''}">
    <div class="tile__head">
      <span class="tile__sym">${escapeHtml(lead)}</span>
      <span class="tile__pct delta--${dir}">${up ? '▲' : '▼'} ${Math.abs(ix.changePct).toFixed(2)}%</span>
    </div>
    <div class="tile__row">
      <span class="tile__price">${fmt.format(ix.price)}</span>
      <span class="tile__chg delta--${dir}">${up ? '+' : '−'}${fmt.format(Math.abs(ix.change))}</span>
    </div>
    ${sparkSvg({ ...ix, twoDay: false }, 'spark tile__spark')}
    <span class="tile__name">${escapeHtml(sub)}</span>
  </div>`;
}

// The overlay body: every ticker the card fetched. Each band renders only if it
// has tiles — the indices are removable entries like any other symbol, so a
// config without them yields a plain stock grid on the full canvas (no shelf,
// no reserved space, no hairline), and an indices-only config yields the shelf
// alone with no empty grid below it. When the shelf cannot be afforded at all
// (see shelfFits), the wall drops it and shows one grid of everything.
export function tileWall(indices) {
  const leads = indices.filter((ix) => isIndexSymbol(ix.symbol));
  const banded = shelfFits(leads.length, indices.length - leads.length);
  const shelf = banded ? leads : [];
  const rest = banded ? indices.filter((ix) => !isIndexSymbol(ix.symbol)) : indices;
  const bands = [];
  const sCols = shelfCols(shelf.length);
  const shelfRows = shelf.length ? Math.ceil(shelf.length / sCols) : 0;
  if (shelf.length) {
    bands.push(`<div class="wall__shelf"${gridStyle('--cols', sCols)}>${shelf.map(tile).join('')}</div>`);
  }
  if (shelf.length && rest.length) bands.push('<div class="wall__rule"></div>');
  if (rest.length) {
    const gCols = tileCols(rest.length, shelfRows);
    // A six-across grid drops to the denser tile type (see main.css): the extra
    // column is only legible if the tile buys the width back.
    bands.push(
      `<div class="wall__grid${gCols >= MAX_COLS ? ' wall__grid--dense' : ''}"${gridStyle('--cols', gCols)}>${rest.map(tile).join('')}</div>`,
    );
  }
  // A lone shelf centers instead of stranding itself at the top edge.
  const solo = shelf.length && !rest.length ? ' wall--shelf-only' : '';
  return `<div class="wall${solo}">${bands.join('')}</div>`;
}

// Config order is the CLIENT's business, applied at render, not the Worker's.
//
// /markets deliberately sorts its cache key so AAPL,MSFT and MSFT,AAPL coalesce
// to one entry (~20 Yahoo subrequests saved per permutation), while fetchMarkets
// returns quotes in REQUEST order. Reordering therefore hits the same cached
// payload and gets the old order back for up to 300s — and a settings save
// reloads the board, so the very first thing a user saw after reordering was
// nothing changing. Ordering here instead keeps that coalescing AND fixes the
// older `partial: true` case, where a symbol Yahoo failed on is dropped from
// `indices` and every later ticker silently shifts up a slot.
//
// Quotes for symbols the config doesn't name (the defaults path, where the
// Worker picks the list) are appended rather than dropped.
export function orderBySymbols(indices, symbols) {
  if (!Array.isArray(symbols) || !symbols.length) return indices;
  const by = new Map(indices.map((ix) => [ix.symbol, ix]));
  const wanted = new Set(symbols);
  return [
    ...symbols.map((s) => by.get(s)).filter(Boolean),
    ...indices.filter((ix) => !wanted.has(ix.symbol)),
  ];
}

// A quote the worker has not called closed is open: a payload from before it
// sent `open` (an older worker, a cached payload mid-rollout) reads as today.
const isOpen = (ix) => ix?.open !== false;

// The header note, on the card and on the wall behind the tap. It dates only
// the quotes still trading, from the OLDEST of their fetches: a closed market's
// quote is as new as it gets until the open, so its age says nothing about how
// current the list is. With every quote closed the note is just "Closed", said
// once here rather than on each row. A quote without its own fetchedAt is
// dated by the payload's updatedAt, so an older payload gets exactly the old
// note. A worker fetch time, not render time, and a clock reading, so it
// honors clock24. Empty when there is nothing to date.
export function marketsNote(vm, clock24) {
  const indices = vm?.indices ?? [];
  const open = indices.filter(isOpen);
  if (indices.length && !open.length) return 'Closed';
  const stamps = open
    .map((ix) => (Number.isFinite(ix.fetchedAt) ? ix.fetchedAt : vm.updatedAt))
    .filter(Number.isFinite);
  const at = stamps.length ? Math.min(...stamps) : vm?.updatedAt;
  return at ? `as of ${fmtClock(at, clock24)}` : '';
}

export function render(el, vm, cfg) {
  const note = marketsNote(vm, cfg?.clock24);
  if (note) setCardNote(el, note);
  // Config order once, for BOTH the card and the wall behind the tap.
  const indices = orderBySymbols(vm.indices, cfg?.markets?.symbols ?? []);
  // A closed quote in a list that is still partly trading gets a CLOSED label
  // under its deltas, because the header's clock no longer speaks for it. Not
  // when every quote is closed (the header says it once), and not on the
  // 2-row tier, whose one-line rows have no spare line: a label there squeezes
  // the names. The label is absolutely placed (main.css), so rows keep their
  // height and the fit below never sees it.
  const markClosed =
    cardSize(el, [4, 4])[1] > 2 && indices.some(isOpen) && indices.some((ix) => !isOpen(ix));
  // At full width (4 cols — markets caps there, see MAX_SIZE) show the
  // two-session sparkline; the 3-wide min keeps the compact last-session shape.
  // Width is a presentation branch rather than a count, so it is read here and
  // not through the fit.
  const twoDay = cardSize(el, [4, 4])[0] >= 4;
  const shown = fitList(el, {
    id: meta.id,
    items: indices,
    badge: true,
    draw: (n) => {
      const rows = indices.slice(0, n);
      // Rows render display:contents inside one .indexes grid so every row shares
      // the same column tracks — otherwise the auto-sized delta column would shift
      // each row's sparkline independently (594.83 vs 0.01 wide deltas).
      el.innerHTML = rows.length
        ? `<div class="indexes" style="--n:${rows.length}">` + rows
            .map((ix) => {
              const up = ix.change >= 0;
              const closed = markClosed && !isOpen(ix);
              return `<div class="index${closed ? ' index--closed' : ''}">
            <div class="index__info">
              <span class="index__name">${escapeHtml(ix.name)}</span>
              <span class="index__price">${fmt.format(ix.price)}</span>
            </div>
            ${sparkSvg({ ...ix, twoDay })}
            <span class="delta delta__chg ${up ? 'delta--up' : 'delta--down'}">${up ? '▲' : '▼'} ${fmt.format(Math.abs(ix.change))}</span>
            <span class="delta delta__pct ${up ? 'delta--up' : 'delta--down'}">(${Math.abs(ix.changePct).toFixed(2)}%)${closed ? '<span class="index__closed">Closed</span>' : ''}</span>
          </div>`;
            })
            .join('') + '</div>'
        : '<div class="empty">Market data unavailable</div>';
    },
  });
  const hidden = indices.length - shown;
  // Rows here are not tappable, so the whole card is the target and the +N badge
  // is a passive signifier — the two must agree exactly: no badge, no expansion.
  // The closure captures THIS render's vm, so the overlay always shows what the
  // card was showing when it was tapped, header note included. The wall's
  // tiles carry no CLOSED label: that treatment is the card's alone.
  setExpandSource(
    el,
    shown && hidden > 0
      ? () => ({ title: meta.title, note, bodyHtml: tileWall(indices) })
      : null,
  );
}

export function mapMarkets(payload) {
  if (!payload || payload.error || !Array.isArray(payload.indices)) {
    // Throw rather than return an empty sentinel: startWidget's catch then
    // preserves the last-good cache + stale mark, instead of a blank payload
    // overwriting good data (and leaving a stale "as of" note in the header).
    throw new Error('markets: unusable payload');
  }
  const indices = payload.indices.filter(
    (ix) =>
      typeof ix?.symbol === 'string' &&
      typeof ix?.name === 'string' &&
      Number.isFinite(ix?.price) &&
      Number.isFinite(ix?.change) &&
      Number.isFinite(ix?.changePct) &&
      Array.isArray(ix?.spark),
  );
  return { updatedAt: payload.updatedAt ?? null, stale: Boolean(payload.stale), indices };
}

// True when the quote source recognizes the symbol. Both settings surfaces
// validate adds with this — a syntactically-valid unknown ticker otherwise
// saves fine and then silently never appears on the card.
// User notation -> Yahoo symbol. Strips a $ prefix ($AAPL); maps a £ prefix to
// the London Stock Exchange suffix (£CBG -> CBG.L — Yahoo keys LSE listings
// with .L, and UK users write their tickers with a leading £).
export function normalizeSymbol(raw) {
  let t = String(raw ?? '').trim().toUpperCase();
  if (t.startsWith('$')) t = t.slice(1);
  if (t.startsWith('£')) {
    t = t.slice(1);
    if (!t.endsWith('.L')) t += '.L';
  }
  return t;
}

export async function symbolKnown(symbol, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${WORKER_URL}/markets?symbols=${encodeURIComponent(symbol)}`);
    if (!res.ok) return false;
    const payload = await res.json();
    return Array.isArray(payload.indices) && payload.indices.some((ix) => ix.symbol === symbol);
  } catch {
    return false;
  }
}

export async function fetchData(cfg, net) {
  const symbols = cfg.markets?.symbols ?? [];
  const query = symbols.length ? `?symbols=${symbols.map(encodeURIComponent).join(',')}` : '';
  return mapMarkets(await net.fetchJSON(`${WORKER_URL}/markets${query}`));
}
