// Tap-to-expand for the five rail departure boards (LIRR, Metro-North,
// NJ Transit, Amtrak, Ferry) — wave 2 of the +N rollout, one wiring because
// they all render the same .train rows and must behave identically. After a
// renderer has sliced to capacity, this fits the rows the browser can actually
// hold, counts what the card is NOT showing, pins the quiet "+N" corner
// badge, and registers the full departures overlay.
//
// The board opens whenever there is a departure to show, not only when some
// are hidden (Sean, 2026-11-13): every card opens when tapped, which is the
// rule the board teaches, and a commuter who taps a card that fits its trains
// still gets the board at reading size. Only the badge tracks what is hidden.
//
// The whole card is the target, the markets grammar (Sean, 2026-07-31): the
// first cut used a pill-only trigger whose touch-target reserve cost a
// visible train row on exactly-filled cards, a worse trade than reserving
// rail rows for a hypothetical future row tap. The news wave, whose rows
// really ARE tappable, then went the
// other way and punched its live rows out of the card target (the engine's
// `except`), so no narrowing selector was ever wanted and the engine no longer
// carries one.

import { escapeHtml } from './util.js';
import { setMoreBadge } from './card.js';
import { setExpandSource } from './expand.js';
import { fitTrainRows } from './capacity.js';
import { dealColumns, gridStyle } from './columns.js';

// The rail board's row cost, stated rather than left in a comment: six trains
// is what one grand centered column carries. It is an aesthetic floor, not a
// pixel one (six 68px rows on 40px gaps are only 608px of the 814px body), so
// it belongs to this view and only the split it feeds is shared.
const TRAINS_ONE_COLUMN = 6;

// `rows` is the FULL departure list's markup, built by the caller's own row
// template — the overlay shows exactly the rows the card would, uncapped. The
// strings are captured per render, so the tap-time snapshot is this render's.
// `alerts` are the card's banner alerts: each banner becomes a subview that
// reads THAT alert full screen (header plus the digest's long description),
// while every other tap on the card opens the schedule. An empty `rows` (no
// departures, or a setup prompt) registers no schedule, so that card surface
// stays inert while any banner on it still reads.
export function wireTrainExpand(el, { title, note = '', rows, alerts = [] }) {
  fitTrainRows(el);
  const hidden = rows.length - (el.querySelectorAll?.('.train').length ?? 0);
  setMoreBadge(el, hidden);
  const subviews = alerts.length
    ? [{
        selector: '.talert',
        build: (banner) => {
          // Banners render in vm.alerts order, so the element's position IS
          // its alert. The card holds at most two.
          const idx = [...(el.closest?.('.card') ?? el).querySelectorAll('.talert')].indexOf(banner);
          const a = alerts[idx] ?? alerts[0];
          return {
            title,
            note: 'service alert',
            bodyHtml: `<div class="alert-view"><p class="alert-view__head">${escapeHtml(a.header)}</p>${
              a.body ? `<p class="alert-view__body">${escapeHtml(a.body)}</p>` : ''
            }</div>`,
          };
        },
      }]
    : null;
  setExpandSource(
    el,
    rows.length
      ? () => {
          // The board sizes to its content (Sean's pick, mockup A): up to six
          // trains fill one grand centered column; beyond that the same rows
          // split into two balanced centered columns a step smaller. rows is
          // snapshot-at-open, so the shape is fixed for the overlay's life.
          const { columns, rows: perColumn } = dealColumns(rows.length, { fitsOneColumn: TRAINS_ONE_COLUMN });
          const split = columns > 1;
          const cls = `trains trains--board trains--board--${split ? 'split' : 'grand'}`;
          // The grand column is a flex stack and never reads the property, so
          // the unsplit board goes out without it, as it always has.
          const style = split ? gridStyle('--board-rows', perColumn) : '';
          return { title, note, bodyHtml: `<div class="${cls}"${style}>${rows.join('')}</div>` };
        }
      : null,
    { subviews },
  );
}
