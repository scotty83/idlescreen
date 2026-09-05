// "This Day in History" from Wikimedia's on-this-day feed (browser-direct,
// CORS-open, keyless). Picks five events spread across the centuries.

import { escapeHtml } from '../util.js';
import { setMoreBadge } from '../card.js';
import { fitList } from '../capacity.js';
import { setExpandSource } from '../expand.js';

// `daily` schedules the refresh against the local calendar (next midnight), not
// 24h from the last fetch, so a board left on across midnight rolls to the new
// day's events instead of the nightly reload being the only thing that does.
export const meta = { id: 'history', title: 'This Day in History', refreshMs: 24 * 60 * 60 * 1000, daily: true };

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
  // The overflow count rides the corner badge, in the one board-wide form.
  fitList(el, {
    id: meta.id,
    items: rows,
    defaultSize: [6, 2],
    badge: true,
    draw: (n) => { el.innerHTML = `<div class="history">${rows.slice(0, n).join('')}</div>`; },
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
