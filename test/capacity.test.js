import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { itemCapacity, capacityLabel, bodyPx, TRIM, trimOf } from '../site/js/capacity.js';
import { capHeadroom } from '../site/js/layout.js';
import { DEMAND } from '../site/js/layout-optimize.js';

// Some capacity numbers are only half the answer: the other half is a pixel in
// main.css, and nothing re-measures the two against each other at runtime. Read
// the stylesheet back and re-do the sum. Same idiom as overlay-chrome.test.js
// and viewport.test.js: literal selectors, so renaming or splitting a rule
// throws rather than silently passing.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../site/css/main.css'), 'utf8');
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for "${selector}" in main.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}
function decl(selector, prop) {
  const m = rule(selector).match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`));
  expect(m, `no ${prop} in "${selector}"`).not.toBeNull();
  return m[1].trim();
}
const px = (v) => {
  const n = Number.parseFloat(v);
  expect(Number.isFinite(n), `not a number: ${v}`).toBe(true);
  return n;
};

// Sizes are on the 12×8 grid: h=2 is a shallow strip (compact tier s), h=4 the
// common default (tier m), h=6/8 a tall card (tier l).
describe('itemCapacity', () => {
  it('scales list rows with card height', () => {
    expect(itemCapacity('markets', 4, 2)).toBe(3); // shallow rows are spark-less — 3 tickers fit
    expect(itemCapacity('markets', 4, 3)).toBe(3);
    expect(itemCapacity('markets', 4, 4)).toBe(5); // trimmed rows: five fit a 4-tall
    // 3-wide runs the trimmed stacked rows (data-w=3 CSS): a 3x4 fits five.
    expect(itemCapacity('markets', 3, 3)).toBe(3);
    expect(itemCapacity('markets', 3, 4)).toBe(5);
    expect(itemCapacity('markets', 3, 5)).toBe(6);
    expect(itemCapacity('markets', 4, 8)).toBe(11);
    expect(itemCapacity('bus', 3, 3)).toBe(4); // stop headers + arrivals share the row budget
    expect(itemCapacity('bus', 4, 8)).toBe(15);
    expect(itemCapacity('lirr', 4, 4)).toBe(5);
    expect(itemCapacity('lirr', 4, 6)).toBe(9);
    expect(itemCapacity('subway', 4, 4)).toBe(6); // optimistic pitch; alert days trim to the badge
    // Shallow History promises its worst case: a day of long facts shows one
    // whole event at any width (history.js measures; short facts show more).
    expect(itemCapacity('history', 4, 2)).toBe(1);
    expect(itemCapacity('history', 12, 2)).toBe(1);
    expect(itemCapacity('history', 4, 4)).toBe(5);
    expect(itemCapacity('worldclock', 2, 3)).toBe(5);
    expect(itemCapacity('worldclock', 3, 4)).toBe(7);
    expect(itemCapacity('worldclock', 3, 8)).toBe(17);
  });
  // Browser-measured on the 12x8 canvas: the .trains box is 121/234/347/459/
  // 572/685/798px tall at h=2..8 and a .train row is 51px on a 10px gap, so
  // floor((box + gap) / 61) is the count. Rail used to share a listCapacity(80,
  // 56) estimate that left a 3x3 card showing 2 trains where 4 fit.
  const RAIL_BY_H = { 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 8: 12 };
  it('fits rail/ferry rows to the measured row pitch at every size', () => {
    for (const id of ['lirr', 'mnr', 'njt', 'amtrak', 'ferry']) {
      for (const [h, n] of Object.entries(RAIL_BY_H)) {
        // Row geometry is width-independent (the renderers' fitTrainRows
        // backstop absorbs the meta-line wrap on narrow cards).
        for (const w of [3, 4, 6, 12]) {
          expect(itemCapacity(id, w, Number(h)), `${id} ${w}x${h}`).toBe(n);
        }
      }
    }
  });
  it('stops rail capacity at the 12 departures the feeds supply', () => {
    // h=8 measures 13 rows of space; every rail feed slices to 12, so 12 is
    // the honest ceiling (a 13 here would promise a row data can never fill).
    expect(itemCapacity('mnr', 12, 8)).toBe(12);
  });
  it('leaves the non-rail list widgets exactly where they were', () => {
    // Regression guard for the rail recalibration: it must not move any other
    // widget's numbers (these are the audited values from before the change).
    expect(itemCapacity('subway', 4, 4)).toBe(6);
    expect(itemCapacity('subway', 3, 3)).toBe(4);
    expect(itemCapacity('bus', 3, 3)).toBe(4);
    expect(itemCapacity('path', 3, 3)).toBe(3);
    expect(itemCapacity('path', 4, 6)).toBe(9);
    expect(itemCapacity('news', 4, 4)).toBe(4);
    expect(itemCapacity('markets', 4, 4)).toBe(5);
  });
  it('gives both headline twins the same capacity as news (never null)', () => {
    // Regression: a missing MODELS entry returned null, which made
    // renderHeadlines treat the whole feed as overflow and show 1 item.
    for (const id of ['marketsnews', 'sportsnews']) {
      for (const [w, h] of [[4, 4], [4, 6], [6, 8]]) {
        expect(itemCapacity(id, w, h), id).toBe(itemCapacity('news', w, h));
      }
      expect(itemCapacity(id, 4, 6), id).toBeGreaterThan(1);
    }
  });
  it('returns null for widgets without a primary list', () => {
    expect(itemCapacity('art', 2, 2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Trim: one record, two readers.
//
// The number of rows subway and services shed below their estimate used to be
// written three times at two values: layout.js said services trims 1, the
// optimizer said 2, and only the optimizer had measured it. Both now read
// capacity.js, and this is what stops either of them growing a table again.
// ---------------------------------------------------------------------------
describe('trim', () => {
  it('records the measured numbers, and nothing that does not trim', () => {
    expect(TRIM).toEqual({ subway: 1, services: 2 });
    expect(trimOf('markets')).toBe(0);
    expect(trimOf('nonsense')).toBe(0);
  });

  it('is what the optimizer discounts a card by, exactly', () => {
    // The optimizer asks what a card shows TODAY, so it takes the whole trim.
    for (const id of Object.keys(TRIM)) {
      expect(DEMAND[id].trim, id).toBe(trimOf(id));
    }
  });

  it('is what the height caps buy one row of, and only where there is trim', () => {
    // The cap asks a different question (a standing bet, paid as dead air on
    // every good day), so it buys one row of the trim rather than all of it.
    // Deliberate, and measured: spending the second row on services re-packs
    // the generator's twelve-widget board and takes markets below the height
    // its own presentable floor puts the sparklines at (layout.js says so at
    // length). What must never drift is WHO trims.
    for (const id of [...Object.keys(TRIM), 'markets', 'worldclock', 'lirr']) {
      expect(capHeadroom(id), id).toBe(Math.min(1, trimOf(id)));
    }
    for (const id of Object.keys(TRIM)) expect(capHeadroom(id), id).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// World Clock's shallow tier. h=2 became legal on 2026-08-01 (MIN_ALTS opened
// 3x2), which is the first time tier 's' ever applied to this card — so the
// compact pitch stopped being a placeholder and became a promise, and the
// stylesheet has to be able to keep it.
// ---------------------------------------------------------------------------
describe('worldclock at its new shallow size', () => {
  it('fits three cities in a 3x2, and does not over-promise a fourth', () => {
    expect(itemCapacity('worldclock', 3, 2)).toBe(3);
    expect(itemCapacity('worldclock', 3, 2)).toBeLessThan(4);
    // The taller tiers are untouched: the change is the compact pitch alone.
    expect(itemCapacity('worldclock', 2, 3)).toBe(5);
    expect(itemCapacity('worldclock', 3, 4)).toBe(7);
    expect(itemCapacity('worldclock', 3, 8)).toBe(17);
  });

  it('is a fit the stylesheet can actually keep', () => {
    // The split constant: capacity.js promises three rows, main.css draws them.
    // Nothing re-measures the two against each other at runtime, so the sum is
    // re-done here — the same join overlay-chrome.test.js holds for the hint
    // band. The shallow row is a FIXED height on purpose: an h=2 World Clock is
    // the one size where the fit is exact, and a device font with taller metrics
    // must not be able to spend the margin.
    const row = px(decl('.card--worldclock.t-s .wc-row', 'height'));
    const gapFloor = px(rule('.card--worldclock .card__body').match(/clamp\(([^,]+),/)[1]);
    const rowVar = px(decl('.card--worldclock.t-s .card__body', '--wcrow'));
    expect(row).toBe(28);
    expect(gapFloor).toBe(10);
    // The clamp's row var is what the elastic gap divides the leftover by, so
    // undershooting it would overflow the card (main.css says so out loud).
    // It must be the row the stylesheet actually draws, not the taller one.
    expect(rowVar).toBe(row);
    expect(px(decl('.card--worldclock .card__body', '--wcrow'))).toBe(35);
    // capacity.js's compact constant IS row + gap, and three of them fit the
    // model's own body estimate with room over.
    const n = itemCapacity('worldclock', 3, 2);
    expect(Math.floor(bodyPx(2) / (row + gapFloor))).toBe(n);
    expect(n * row + (n - 1) * gapFloor).toBeLessThanOrEqual(bodyPx(2));
    // A fourth row would not, which is why the count is three and not four.
    expect((n + 1) * row + n * gapFloor).toBeGreaterThan(bodyPx(2));
  });

  it('keeps the city at the legibility floor and the time above it', () => {
    // PRODUCT's hard floor is 20px; the shallow tier buys its row height from
    // the TIME (23 -> 21), never from the city, and weight + full ink keep the
    // time the thing the eye lands on.
    expect(px(decl('.wc-row__city', 'font-size'))).toBe(20);
    const time = px(decl('.card--worldclock.t-s .wc-row__time', 'font-size'));
    expect(time).toBe(21);
    expect(time).toBeGreaterThan(px(decl('.wc-row__city', 'font-size')));
    expect(time).toBeLessThan(px(decl('.wc-row__time', 'font-size'))); // shorter than the full-size row's
  });
});

describe('capacityLabel', () => {
  const cfg = {
    markets: { symbols: ['^DJI', '^IXIC', '^GSPC', 'AAPL', 'MSFT', 'NVDA', 'TSLA'] },
    subway: { lines: ['1', '2', '3', 'A'] },
    worldclock: { cities: Array.from({ length: 8 }, (_, i) => ({ label: `C${i}`, zone: 'UTC' })) },
  };
  it('describes markets as shown-of-total tickers', () => {
    expect(capacityLabel('markets', 4, 2, cfg)).toBe('shows 3 of 7 tickers');
    expect(capacityLabel('markets', 4, 8, cfg)).toBe('shows all 7 tickers');
  });
  it('weather forecast label matches what render actually shows (big = w>=5||h>=5)', () => {
    // small tier (incl. the reported 3×4): 6 hourly · 4-day
    expect(capacityLabel('weather', 3, 4, cfg)).toBe('6 hourly · 4-day forecast');
    expect(capacityLabel('weather', 4, 4, cfg)).toBe('6 hourly · 4-day forecast');
    // big tier by height OR width
    expect(capacityLabel('weather', 4, 5, cfg)).toBe('8 hourly · 5-day forecast');
    expect(capacityLabel('weather', 5, 4, cfg)).toBe('8 hourly · 5-day forecast');
  });
  it('bus label counts buses, not header rows', () => {
    // 3x3 (4 rows): 1 leg = header + 3 arrivals; 2 legs at 4x4 (6 rows) =
    // two headers + 3 + 1 arrivals. The old label printed the raw row count.
    expect(capacityLabel('bus', 3, 3, { bus: { legs: [{}] } })).toBe('next 3 buses');
    expect(capacityLabel('bus', 4, 4, { bus: { legs: [{}, {}] } })).toBe('next 4 buses');
  });

  it('describes subway lines against the selection', () => {
    expect(capacityLabel('subway', 4, 2, cfg)).toBe('shows 2 of 4 lines');
    expect(capacityLabel('subway', 4, 4, cfg)).toBe('shows all 4 lines');
  });
  it('describes worldclock cities against the selection', () => {
    expect(capacityLabel('worldclock', 2, 3, cfg)).toBe('shows 5 of 8 cities');
    expect(capacityLabel('worldclock', 3, 8, cfg)).toBe('shows all 8 cities');
  });
  it('describes trains and events plainly', () => {
    expect(capacityLabel('lirr', 4, 4, cfg)).toBe('next 5 trains');
    expect(capacityLabel('history', 4, 2, cfg)).toBe('1 event'); // singular, never "1 events"
    expect(capacityLabel('history', 4, 4, cfg)).toBe('5 events');
  });
  it('describes all three news widgets as headlines', () => {
    expect(capacityLabel('news', 4, 4, cfg)).toBe('4 headlines');
    expect(capacityLabel('marketsnews', 4, 4, cfg)).toBe('4 headlines');
    expect(capacityLabel('sportsnews', 4, 4, cfg)).toBe('4 headlines');
  });
  it('describes weather tiers and stays quiet for non-lists', () => {
    expect(capacityLabel('weather', 4, 4, cfg)).toBe('6 hourly · 4-day forecast');
    expect(capacityLabel('weather', 6, 6, cfg)).toBe('8 hourly · 5-day forecast');
    expect(capacityLabel('art', 2, 2, cfg)).toBeNull();
  });
});
