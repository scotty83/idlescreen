// "This Day in History" from Wikimedia's on-this-day feed (browser-direct,
// CORS-open, keyless). Picks five events spread across the centuries.

import { escapeHtml } from '../util.js';
import { setMoreBadge } from '../card.js';
import { fitList, cardSize, sizeTier } from '../capacity.js';
import { setExpandSource } from '../expand.js';

// `daily` schedules the refresh against the local calendar (next midnight), not
// 24h from the last fetch, so a board left on across midnight rolls to the new
// day's events instead of the nightly reload being the only thing that does.
export const meta = { id: 'history', title: 'This Day in History', refreshMs: 24 * 60 * 60 * 1000, daily: true };

// Whether any event drawn in the body lost words to its line clamp. A clamped
// box keeps its unclamped content height as scrollHeight, so a cut row reads
// taller inside than out; the pixel of tolerance absorbs subpixel rounding.
// Exported for the fit tests, which drive it on a hand-built body.
export const cutShort = (body) =>
  [...body.querySelectorAll('.history__text')].some((t) => t.scrollHeight > t.clientHeight + 1);

// The reading view's tightening ladder: how many steps past the resting sizes
// main.css draws under .history-board[data-fit="N"]. Step 1 only closes the gaps
// between events; 2 to 4 also bring the type down a notch each, ending at the
// 20px floor. test/expand.test.js reads the stylesheet back to keep the two in
// step.
export const BOARD_FITS = 4;

// Fits the full-day reading list to the canvas it opened on. The list is every
// event of the day at reading size, centred in the overlay body, and the sizes
// in main.css were set for a day of mostly one-line facts. A day of long ones
// (2026-11-13: eight of nine ran to two lines) stood about 60px taller than the
// canvas, and a centred column that overflows is cropped at BOTH ends: half a
// fact off the top, half off the bottom. So the view measures itself on open,
// the contract subway's alert wall already runs (expand.js `onOpen`), and walks
// the ladder above only as far as it must. A list that fits is left alone.
//
// Past the last step the events are clamped to one shared number of whole
// lines, ending in an ellipsis, so every year of the day stays on screen. That
// takes nine facts of three-plus lines each at the smallest size; it is the
// backstop, not a state a normal day reaches.
export function fitHistoryBoard(body) {
  const board = body?.querySelector?.('.history-board');
  if (!board?.clientHeight) return; // no layout engine (unit tests)
  const items = [...board.children];
  if (!items.length) return;
  // Measured off the rows, not scrollHeight: a centred overflow spills off both
  // ends and scrollHeight only counts the far one, so it reads half the excess.
  const spill = () =>
    items[items.length - 1].getBoundingClientRect().bottom - items[0].getBoundingClientRect().top - board.clientHeight;
  for (let step = 1; step <= BOARD_FITS && spill() > 0; step++) board.dataset.fit = String(step);
  if (spill() <= 0) return;
  const texts = [...board.querySelectorAll('.history__text')];
  const lineH = parseFloat(getComputedStyle(texts[0]).lineHeight) || 1;
  let clamp = Math.max(...texts.map((t) => Math.round(t.getBoundingClientRect().height / lineH)));
  board.classList.add('history-board--clamped');
  while (spill() > 0 && clamp > 1) {
    clamp -= 1;
    board.style.setProperty('--board-clamp', String(clamp));
  }
}

export function render(el, vm, _cfg) {
  if (!vm.events?.length) {
    el.innerHTML = '<div class="empty">No events for today</div>';
    setMoreBadge(el, 0);
    setExpandSource(el, null);
    return;
  }
  const row = (e) => `<div class="history__item">
        <span class="history__year">${e.year}</span>
        <span class="history__text">${escapeHtml(e.text)}</span>
      </div>`;
  const rows = vm.events.map(row);
  // A shallow card (two rows tall) used to clamp every event to one line so two
  // of them fit, which drew two half-facts. Now an event may run to two lines,
  // and the card keeps only the events it can show WHOLE: the fit sheds from the
  // tail while the body overflows or any event drawn is cut short by its clamp,
  // then grows back while short facts leave room. A card left with one event
  // lets it run to three lines (history--single, main.css), and that last event
  // is never shed, so a fact too long even for three lines is the one place the
  // ellipsis stays. The medium and tall tiers are untouched: their rows keep
  // the estimate, unmeasured.
  //
  // fitList's squeeze ends by spending leftover room on one more row drawn
  // short. That row would be an event cut to one line, the half-fact this
  // replaces, so draw ignores the `squeezed` flag: the extra row is drawn whole,
  // fails exactly as the grow step's last try did, and comes back off.
  const shallow = sizeTier(cardSize(el, [6, 2])[1]) === 's';
  // The overflow count rides the corner badge, in the one board-wide form.
  fitList(el, {
    id: meta.id,
    items: rows,
    defaultSize: [6, 2],
    measure: shallow,
    squeeze: shallow,
    clipped: cutShort,
    badge: true,
    draw: (n) => {
      const single = shallow && n === 1 ? ' history--single' : '';
      el.innerHTML = `<div class="history${single}">${rows.slice(0, n).join('')}</div>`;
    },
  });
  // Whole-card tap for the whole day (Sean's pick, mockup A): the grand
  // centered reading list of every event, the card's own rows at reading size.
  // Unconditional, not only when rows are hidden: the rows cover the card, so
  // one card has to mean one destination, and a card that fits its events still
  // owes a tap the bigger reading view. Only the badge tracks `hidden`.
  setExpandSource(el, () => ({
    title: meta.title,
    // The date the events are FOR (stamped by fetchData), not the day the tap
    // happens: across midnight without a refetch the rows still describe
    // yesterday, and labelling them with today's date is the mismatch this fixes.
    note: new Date(vm.date ?? Date.now()).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
    bodyHtml: `<div class="history history-board">${rows.join('')}</div>`,
    onOpen: fitHistoryBoard,
  }));
}

export function mapHistory(json, count = 9) {
  const events = (Array.isArray(json?.events) ? json.events : [])
    .filter((e) => Number.isFinite(e?.year) && typeof e?.text === 'string')
    .sort((a, b) => a.year - b.year);
  if (events.length <= count) {
    return { events: events.map((e) => ({ year: e.year, text: e.text })) };
  }
  // Spread picks evenly across the sorted list for a mix of eras.
  const picked = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (events.length - 1)) / (count - 1));
    picked.push(events[idx]);
  }
  const unique = [...new Map(picked.map((e) => [e.year, e])).values()];
  // Backfill if rounding collapsed picks onto the same year.
  for (const e of events) {
    if (unique.length >= count) break;
    if (!unique.some((u) => u.year === e.year)) unique.push(e);
  }
  unique.sort((a, b) => a.year - b.year);
  return { events: unique.slice(0, count).map((e) => ({ year: e.year, text: e.text })) };
}

export async function fetchData(cfg, net) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const json = await net.fetchJSON(
    `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`,
  );
  // Stamp the local date the events are for, so the expanded view labels them by
  // THAT day even when the card is tapped after midnight (before the next fetch).
  return { ...mapHistory(json), date: now.getTime() };
}
