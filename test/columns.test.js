/**
 * @vitest-environment happy-dom
 */
// PARITY PROOF for the one-split refactor.
//
// Six full-screen views used to spell the same one-column-until-it-does-not-fit
// decision six different ways. They now hand it to site/js/columns.js. Every
// formula in an `oracle` block below is the PRE-REFACTOR arithmetic, copied off
// the site it used to live at and frozen here: it is the reference, not a
// restatement of the new code. Each sweep runs every input count the view can
// actually receive through both and demands the same columns, the same rows,
// and the same custom property text.
//
// If a sweep ever fails, the refactor moved a board that was not supposed to
// move. Fix columns.js or the call site. Do NOT bring an oracle into line.

import { describe, it, expect, beforeEach } from 'vitest';
import { dealColumns, dealInto, gridStyle } from '../site/js/columns.js';
import { closeExpand, isExpandOpen } from '../site/js/expand.js';
import * as lirr from '../site/js/widgets/lirr.js';
import * as golf from '../site/js/widgets/golf.js';
import * as markets from '../site/js/widgets/markets.js';
import * as news from '../site/js/widgets/news.js';
import * as bsky from '../site/js/widgets/bsky.js';
import { renderHeadlines, listRows, listColumns, listCapacity, listBoard, LIST_MAX_COLS } from '../site/js/widgets/newscore.js';
import { ledgerColumns } from '../site/js/ledger.js';
import { clockFaceHtml } from '../site/js/clockfaces.js';
import { board as mountBoard } from './helpers/board.js';

const overlay = () => document.querySelector('#expand-view');

beforeEach(() => {
  closeExpand();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------- the stamp

describe('parity: the custom-property stamp', () => {
  it('spells every property exactly as the six template strings used to', () => {
    // The three inline attributes the views wrote by hand, verbatim.
    const railOld = (rows) => ` style="--board-rows:${rows}"`;
    const listOld = (rows) => ` style="--list-rows:${rows}"`;
    const wallOld = (cols) => ` style="--cols:${cols}"`;
    for (let v = 0; v <= 100; v++) {
      expect(gridStyle('--board-rows', v)).toBe(railOld(v));
      expect(gridStyle('--list-rows', v)).toBe(listOld(v));
      expect(gridStyle('--cols', v)).toBe(wallOld(v));
    }
  });
});

// ------------------------------------------------------- rail (train-expand)

describe('parity: the rail departures board', () => {
  // train-expand.js, pre-refactor:
  //   const split = rows.length > 6;
  //   const cls = `trains trains--board trains--board--${split ? 'split' : 'grand'}`;
  //   const style = split ? ` style="--board-rows:${Math.ceil(rows.length / 2)}"` : '';
  const railOracle = (n) => {
    const split = n > 6;
    return { split, style: split ? ` style="--board-rows:${Math.ceil(n / 2)}"` : '' };
  };

  const dep = (i) => ({
    t: 1000 + i * 600, min: 10 + i * 10, dest: `Stop ${i}`, destId: String(i),
    branch: 'Babylon', routeId: '1', trainNum: String(100 + i), track: null, origin: 'penn',
  });
  const vm = (n) => ({ departures: Array.from({ length: n }, (_, i) => dep(i)), destName: 'Rockville Centre' });

  // Every card with a departure opens (Sean, 2026-11-13), so the sweep runs
  // from one train up; zero is the one count with nothing behind the tap.
  const MAX = 64;

  it('sweeps 0 to 64 departures: identical class and identical --board-rows', () => {
    const { card, render } = mountBoard(lirr, { rect: { w: 3, h: 2 }, vm: vm(3), cfg: {} });
    for (let n = 0; n <= MAX; n++) {
      closeExpand();
      render(vm(n));
      if (n === 0) {
        // No departures: the card is inert and no board is ever built. Stated
        // so the sweep's floor is a fact rather than an omission.
        card.click();
        expect(isExpandOpen(), `${n} departures must not open`).toBe(false);
        continue;
      }
      card.click();
      const el = overlay().querySelector('.trains--board');
      const want = railOracle(n);
      expect(el.classList.contains('trains--board--split'), `${n} split`).toBe(want.split);
      expect(el.classList.contains('trains--board--grand'), `${n} grand`).toBe(!want.split);
      // The unsplit board carries no style attribute at all, as it never did.
      expect(el.getAttribute('style') ?? '', `${n} style`)
        .toBe(want.style ? want.style.replace(' style="', '').replace('"', '') : '');
      if (want.split) {
        expect(el.style.getPropertyValue('--board-rows'), `${n} rows`).toBe(String(Math.ceil(n / 2)));
      }
      expect(overlay().querySelectorAll('.train').length, `${n} rows rendered`).toBe(n);
    }
  });

  it('the shared deal answers what the old expression did, count for count', () => {
    for (let n = 0; n <= MAX; n++) {
      const { columns, rows } = dealColumns(n, { fitsOneColumn: 6 });
      const want = railOracle(n);
      expect(columns > 1, `${n} split`).toBe(want.split);
      expect(columns > 1 ? gridStyle('--board-rows', rows) : '', `${n} style`).toBe(want.style);
    }
  });
});

// ------------------------------------------------------------ golf (golf.js)

describe('parity: the golf leaderboard', () => {
  // golf.js, pre-refactor (BOARD_ROWS 12, BOARD_PLAYERS 24 inlined as the
  // literals they were, so the oracle cannot drift with the constants):
  //   const shown = players.slice(0, 24);
  //   const split = shown.length > 12;
  //   const rows = split ? Math.ceil(shown.length / 2) : shown.length;
  const golfOracle = (n) => {
    const shown = Math.min(n, 24);
    const split = shown > 12;
    return { split, rows: split ? Math.ceil(shown / 2) : shown, shown };
  };

  const vm = (n) => ({
    name: 'Open', round: 3, state: 'in', startsAt: null,
    players: Array.from({ length: n }, (_, i) => ({
      pos: String(i + 1), name: `P ${i}`, score: i % 2 ? '-3' : '+1', today: '-2', flag: null,
    })),
  });

  it('pins the constants the oracle was frozen against', () => {
    expect(golf.BOARD_ROWS).toBe(12);
    expect(golf.BOARD_PLAYERS).toBe(24);
  });

  it('sweeps 0 to 80 players: identical split class and identical --board-rows', () => {
    const { card, render } = mountBoard(golf, { rect: { w: 3, h: 4 }, vm: vm(3), cfg: {} });
    for (let n = 0; n <= 80; n++) {
      closeExpand();
      render(vm(n));
      if (n === 0) {
        // An off week has no leaderboard: the card refuses rather than raising
        // an empty canvas, so zero never reaches the board builder.
        card.click();
        expect(isExpandOpen(), 'an empty field must not open').toBe(false);
        continue;
      }
      card.click();
      const el = overlay().querySelector('.golf-board');
      const want = golfOracle(n);
      expect(el.classList.contains('golf-board--split'), `${n} split`).toBe(want.split);
      expect(el.style.getPropertyValue('--board-rows'), `${n} rows`).toBe(String(want.rows));
      expect(el.getAttribute('style'), `${n} stamp`).toBe(`--board-rows:${want.rows}`);
      expect(el.querySelectorAll('.golf-board__row').length, `${n} rows rendered`).toBe(want.shown);
    }
  });
});

// ------------------------------------------- the news reading list (newscore)

describe('parity: the news reading list', () => {
  // newscore.js, pre-refactor:
  //   listColumns(n, maxCols) { if (n <= 6) return 1; if (n <= 12) return Math.min(2, maxCols); return maxCols; }
  //   listCapacity(n, id)     { return listRows() * listColumns(n, LIST_MAX_COLS[id] ?? 3); }
  //   perCol                  = Math.ceil(Math.min(n, viewCap) / cols)
  // listRows() is the view's own ROW COST and did not move, so the oracle calls
  // the real one.
  const listColumnsOld = (n, maxCols) => {
    if (n <= 6) return 1;
    if (n <= 12) return Math.min(2, maxCols);
    return maxCols;
  };
  const listCapacityOld = (n, maxCols) => listRows() * listColumnsOld(n, maxCols);
  const perColOld = (n, maxCols) =>
    Math.ceil(Math.min(n, listCapacityOld(n, maxCols)) / listColumnsOld(n, maxCols));

  // The whole reachable domain of maxCols: every value LIST_MAX_COLS holds.
  // Nothing in the board can ask for a fourth column, which matters, because
  // the two rules genuinely diverge above three (see the note in the sweep).
  const MAX_COLS_SEEN = [...new Set(Object.values(LIST_MAX_COLS))].sort();
  const MAX = 40; // mergeNews hands over at most 30

  it('pins the maxCols domain the sweep is run over', () => {
    expect(MAX_COLS_SEEN).toEqual([2, 3]);
  });

  it('sweeps 0 to 40 items across both family widths: columns, rows, seats', () => {
    for (const maxCols of MAX_COLS_SEEN) {
      for (let n = 0; n <= MAX; n++) {
        const cols = listColumnsOld(n, maxCols);
        expect(listColumns(n, maxCols), `${n} @ ${maxCols}: columns`).toBe(cols);
        const id = Object.keys(LIST_MAX_COLS).find((k) => LIST_MAX_COLS[k] === maxCols);
        expect(listCapacity(n, id), `${n} @ ${maxCols}: seats`).toBe(listCapacityOld(n, maxCols));
        const deal = listBoard(n, id);
        expect(deal.columns, `${n} @ ${maxCols}: deal columns`).toBe(cols);
        if (n) expect(deal.rows, `${n} @ ${maxCols}: rows per column`).toBe(perColOld(n, maxCols));
        expect(gridStyle('--list-rows', deal.rows), `${n} @ ${maxCols}: style`)
          .toBe(n ? ` style="--list-rows:${perColOld(n, maxCols)}"` : ' style="--list-rows:0"');
      }
    }
  });

  const items = (n) => Array.from({ length: n }, (_, i) => ({
    title: `Story ${i}`, t: Date.now() - i * 60000, source: 'NYT',
    link: `https://example.com/${i}`, desc: `Summary ${i}`,
  }));

  it('sweeps the rendered list for both a three-column and a two-column family', () => {
    for (const mod of [news, bsky]) {
      const maxCols = LIST_MAX_COLS[mod.meta.id];
      const { card, render } = mountBoard(mod, {
        rect: { w: 3, h: 2 },
        vm: { nowMs: Date.now(), items: items(3) },
        cfg: { clock24: false },
        render: (el, vm, cfg) => renderHeadlines(el, vm, { widgetId: mod.meta.id, emptyHint: '', title: mod.meta.title }, cfg),
      });
      for (let n = 0; n <= 35; n++) {
        closeExpand();
        render({ nowMs: Date.now(), items: items(n) });
        if (n === 0) {
          card.click();
          expect(isExpandOpen(), `${mod.meta.id}: an empty card must not open`).toBe(false);
          continue;
        }
        card.click();
        const el = overlay().querySelector('.news-board');
        const cols = listColumnsOld(n, maxCols);
        expect(el.classList.contains(`news-board--c${cols}`), `${mod.meta.id} ${n}: column class`).toBe(true);
        expect(el.getAttribute('style'), `${mod.meta.id} ${n}: stamp`).toBe(`--list-rows:${perColOld(n, maxCols)}`);
        expect(el.querySelectorAll('.headline').length, `${mod.meta.id} ${n}: rows rendered`)
          .toBe(Math.min(n, listCapacityOld(n, maxCols)));
      }
    }
  });
});

// ------------------------------------------------------- the ledger (ledger)

describe('parity: the services / TfL ledger', () => {
  // ledger.js, pre-refactor:
  //   if (rows.length < 2) return rows.length ? [rows] : [];
  //   const first = Math.ceil(rows.length / 2);
  //   return [rows.slice(0, first), rows.slice(first)];
  const ledgerColumnsOld = (rows) => {
    if (rows.length < 2) return rows.length ? [rows] : [];
    const first = Math.ceil(rows.length / 2);
    return [rows.slice(0, first), rows.slice(first)];
  };

  it('sweeps 0 to 40 quiet rows: identical columns, identical contents', () => {
    for (let n = 0; n <= 40; n++) {
      const rows = Array.from({ length: n }, (_, i) => `svc${i}`);
      expect(ledgerColumns(rows), `${n} rows`).toEqual(ledgerColumnsOld(rows));
    }
  });
});

// ------------------------------------------------- the dial grid (clockfaces)

describe('parity: the clock-face dial grid', () => {
  // clockfaces.js, pre-refactor:
  //   function planRows(n, solo) { if (n <= solo) return [n]; const top = Math.ceil(n / 2); return [top, n - top]; }
  //   ...called as planRows(list.length, 5) at both faces.
  const planRowsOld = (n, solo) => {
    if (n <= solo) return [n];
    const top = Math.ceil(n / 2);
    return [top, n - top];
  };

  it('sweeps 0 to 16 dials: identical bands, in order', () => {
    for (let n = 0; n <= 16; n++) {
      const list = Array.from({ length: n }, (_, i) => i);
      const bands = dealInto(list, { fitsOneColumn: 5, maxColumns: 2 });
      expect(bands.map((b) => b.length), `${n} dials: band sizes`).toEqual(planRowsOld(n, 5));
      // And the same items land in the same band: filled DOWN the first.
      expect(bands.flat(), `${n} dials: order`).toEqual(list);
    }
  });

  // Zones chosen so none is the pinned local zone and all sort distinctly.
  const ZONES = [
    'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver',
    'America/Chicago', 'America/Sao_Paulo', 'Europe/London', 'Europe/Paris',
    'Europe/Athens', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Bangkok',
    'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
  ];
  const T = new Date(Date.UTC(2026, 6, 19, 16, 9));
  const LOCAL = 'America/New_York';
  const cfgOf = (k) => ({ clock24: false, worldclock: { cities: ZONES.slice(0, k).map((z) => ({ label: z, zone: z })) } });
  // Band sizes as the rendered face actually deals them.
  const bandsOf = (html, cls) =>
    html.split(`class="${cls}"`).slice(1).map((chunk) => (chunk.match(/class="cf-(dial|city) /g) ?? []).length);

  it('sweeps the rendered world face, 0 to 14 configured cities', () => {
    for (let k = 0; k <= 14; k++) {
      // cities() slices the config to 10, a Local dial joins when no listed
      // city is local, and worldCities caps at MAX_DIALS = 10.
      const n = Math.min(Math.min(k, 10) + 1, 10);
      const html = clockFaceHtml('worldclocks', cfgOf(k), T, LOCAL);
      expect(bandsOf(html, 'cf-drow'), `${k} cities -> ${n} dials`).toEqual(planRowsOld(n, 5));
    }
  });

  it('sweeps the rendered clock row, 0 to 14 configured cities', () => {
    for (let k = 0; k <= 14; k++) {
      // The hero IS local time, so the row takes the config's first 10 and
      // then its own first 9; an empty list still draws its (empty) band.
      const n = Math.min(Math.min(k, 10), 9);
      const html = clockFaceHtml('clockrow', cfgOf(k), T, LOCAL);
      expect(bandsOf(html, 'cf-crow'), `${k} cities -> ${n} cells`).toEqual(planRowsOld(n, 5));
    }
  });
});

// -------------------------------------------------- the ticker wall (markets)

describe('parity: the markets ticker wall', () => {
  // markets.js, pre-refactor. The row-cost model (maxRows and the geometry
  // under it) is the WALL's own and did not move, but its constants are
  // module-private, so the oracle carries its own frozen copy: if those numbers
  // ever drift apart, this sweep is what says so.
  const SHELF_ROW = 225;
  const RULE_BLOCK = 53;
  const TILE_MIN = 175;
  const TILE_GAP = 20;
  const MAX_COLS = 6;
  const shelfBlockOld = (rows, withGrid) =>
    (rows ? rows * SHELF_ROW + (rows - 1) * TILE_GAP + (withGrid ? RULE_BLOCK : 0) : 0);
  const maxRowsOld = (shelfRows) =>
    Math.max(0, Math.floor((markets.WALL_H - shelfBlockOld(shelfRows, true) + TILE_GAP) / (TILE_MIN + TILE_GAP)));
  const tileColsOld = (n, shelfRows = 0) => {
    let cols = n <= 3 ? Math.max(n, 1) : n <= 4 ? 2 : n <= 6 ? 3 : n <= 8 ? 4 : 5;
    const rows = maxRowsOld(shelfRows);
    while (Math.ceil(n / cols) > rows && cols < MAX_COLS) cols++;
    return cols;
  };
  // Unchanged by the refactor, but it reads tileCols, so it is swept too.
  const shelfColsOld = (n) => (n <= 4 ? Math.max(n, 1) : Math.min(4, tileColsOld(n)));

  it('sweeps 0 to 40 tiles against every shelf depth 0 to 6', () => {
    for (let shelfRows = 0; shelfRows <= 6; shelfRows++) {
      for (let n = 0; n <= 40; n++) {
        expect(markets.tileCols(n, shelfRows), `${n} tiles under ${shelfRows} shelf rows`)
          .toBe(tileColsOld(n, shelfRows));
      }
    }
  });

  it('sweeps 0 to 40 shelf tiles', () => {
    for (let n = 0; n <= 40; n++) {
      expect(markets.shelfCols(n), `${n} shelf tiles`).toBe(shelfColsOld(n));
    }
  });

  const vmOf = (symbols) => symbols.map((s, i) => ({
    symbol: s, name: `Name ${i}`, price: 100 + i, change: 1, changePct: 0.5, spark: [1, 2, 3],
  }));
  const attrOf = (html, cls) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.querySelector(cls)?.getAttribute('style') ?? null;
  };

  it('sweeps the rendered wall, 1 to 20 stocks behind 0 to 4 indices', () => {
    // 20 is the config cap on the watchlist; indices are drawn from the same
    // list, so every reachable shelf/grid split is covered.
    for (let nIdx = 0; nIdx <= 4; nIdx++) {
      for (let nStock = 1; nStock <= 20; nStock++) {
        const syms = [
          ...Array.from({ length: nIdx }, (_, i) => `^IDX${i}`),
          ...Array.from({ length: nStock }, (_, i) => `SYM${i}`),
        ];
        const html = markets.tileWall(vmOf(syms));
        const banded = markets.shelfFits(nIdx, nStock);
        const sCols = banded ? shelfColsOld(nIdx) : 0;
        const shelfRows = banded && nIdx ? Math.ceil(nIdx / sCols) : 0;
        const gCols = tileColsOld(banded ? nStock : nIdx + nStock, shelfRows);
        expect(attrOf(html, '.wall__grid'), `${nIdx} idx + ${nStock} stocks: grid`).toBe(`--cols:${gCols}`);
        if (banded && nIdx) {
          expect(attrOf(html, '.wall__shelf'), `${nIdx} idx + ${nStock} stocks: shelf`).toBe(`--cols:${sCols}`);
        }
      }
    }
  });
});
