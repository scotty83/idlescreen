// Quote of the day from the bundled curated list — zero API dependency.

import { escapeHtml, dailyPick } from '../util.js';
import { bodyPx, bodyWidthPx, cardSize, sizeTier } from '../capacity.js';

// `daily`: refresh at the next local midnight so the quote turns over with the
// date, not 24h after the last fetch (see scheduler.dailyRefresh).
export const meta = { id: 'quote', title: 'Quote of the Day', refreshMs: 24 * 60 * 60 * 1000, daily: true };

// What the card can hold, in the only currency a quote has: lines, and the
// characters that fit them. Pure canvas arithmetic, the same shape capacity.js
// prices list rows in.
//   TEXT_PX   .quote__text at each tier (main.css steps it down on a shallow card)
//   LINE      its line-height
//   AUTHOR_PX the attribution's line box (21px type), GAP the .quote gap
//   CHAR_EM   average glyph advance of the italic body face as a share of the
//             type size, WRAP_FILL the share of a line that ragged-right
//             wrapping actually fills. Both are deliberately pessimistic:
//             over-estimating costs a quote its place in the pool,
//             under-estimating puts an ellipsis on the wall.
const TEXT_PX = { s: 22, m: 24, l: 24 };
const LINE = 1.4;
const AUTHOR_PX = 25;
const GAP = 12;
const CHAR_EM = 0.52;
const WRAP_FILL = 0.92;

export function quoteFit(w, h) {
  const fontPx = TEXT_PX[sizeTier(h)];
  const lines = Math.max(1, Math.floor((bodyPx(h) - AUTHOR_PX - GAP) / (fontPx * LINE)));
  const perLine = bodyWidthPx(w) / (fontPx * CHAR_EM);
  return { lines, chars: Math.max(1, Math.floor(lines * perLine * WRAP_FILL)) };
}

// The day's quote, chosen from the ones that FIT. A quote cut mid-sentence is
// not a shortened quote, it is a broken one ("I have not failed. I've just
// found 10,000 ways that won't…" says nothing at all), and the card is a
// glance, not a reader. So the card's size narrows the pool first and the
// calendar picks inside it: every board of a given size still lands on the same
// quote on the same day, and a small card simply reads a shorter one.
// `+ 2` is the pair of curly quotes the renderer wraps the text in.
export function pickQuote(quotes, chars, date) {
  const list = (Array.isArray(quotes) ? quotes : []).filter((q) => typeof q?.text === 'string');
  if (!list.length) return null;
  const fits = list.filter((q) => q.text.length + 2 <= chars);
  if (fits.length) return dailyPick(fits, date);
  // Nothing fits (a 2x2 card and an unlucky list): the shortest is the least
  // clipped, and the CSS clamp is still there behind it.
  return list.reduce((a, b) => (b.text.length < a.text.length ? b : a));
}

// The bundled list, kept module-side for the size-aware pick (art.js's manifest
// idiom). null until the first fetch lands, which is why render falls back to
// the cached vm: a board painting from localStorage at boot shows the day's
// quote immediately and re-picks for its own size a moment later.
let pool = null;

export function render(el, vm, _cfg) {
  const [w, h] = cardSize(el, [6, 2]);
  const { lines, chars } = quoteFit(w, h);
  const q = pickQuote(pool ?? [vm], chars, new Date()) ?? vm;
  if (!q?.text) {
    el.innerHTML = '<div class="empty">No quote today</div>';
    return;
  }
  // The clamp is the backstop, not the plan: it is the same line count the pick
  // was measured against, so on a fitting quote it never fires.
  el.style.setProperty('--quote-lines', String(lines));
  el.innerHTML = `
    <blockquote class="quote">
      <p class="quote__text">“${escapeHtml(q.text)}”</p>
      <footer class="quote__author">— ${escapeHtml(q.author)}</footer>
    </blockquote>`;
}

// The shared day index keeps quote and word-of-the-day on one calendar.
export const quoteOfDay = dailyPick;

export async function fetchData(cfg, net) {
  // Bundled and static: fetch it once and keep it (the card refreshes daily and
  // the file never changes). The whole-pool pick is what gets cached, so a
  // cache-only paint is still a quote; render re-picks it for the card's size.
  pool ??= await net.fetchJSON('data/quotes.json');
  return quoteOfDay(pool, new Date());
}
