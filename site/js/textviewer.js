// Full-screen reader for truncated text: tap any clamped/ellipsized message on
// a card to see the whole thing at glance-legible size (mirrors the art card's
// tap-to-view). News headlines get a richer view: the summary plus a QR to the
// full article, so a viewer reads it on their phone (the board is a shared
// kiosk and the finance sources are paywalled — we never navigate it away).
// Tap anywhere to dismiss; a 20s idle timer returns an abandoned board home.

import { escapeHtml } from './util.js';
import { registerSurface, whileShown } from './surfaces.js';
import { surfaceOwnsTap } from './expand.js';

// Every card text that CSS may clamp or ellipsize. Headlines are handled
// separately (rich story view), but stay here as the fallback for a link-less,
// summary-less item so an overflowing title still expands.
const EXPANDABLE =
  '.linestatus__text, .talert__text, .headline__title, .quote__text, .wc-row__city';

// Status/alert copy is the one kind of text a card may ALSO expand as a whole:
// a subway card's tap opens the full status board, which shows this line's
// alert in full anyway. On such a card the single-line reader is a redundant
// intermediate, so these classes step aside and let the card's own expansion
// take the tap. Story/quote/city text never defers: the news wave needs a row
// tap to stay a story tap even inside an expandable card. History rows are not
// listed above at all: they cover nearly the whole card, so a per-row reader
// swallowed the taps meant for the day view. Leaving the list rather than
// deferring keeps them out of the reader on any card, expandable or not.
const DEFER_TO_EXPAND = '.linestatus__text, .talert__text';

// The same rule, for the cards that wire their OWN row taps rather than coming
// through the delegated listener below. Cloud Services and TfL attach a click
// handler per degraded row, and their status text is not in EXPANDABLE at all,
// so the selector list above can never reach them — this predicate is how they
// ask the same question. Once the card itself opens a fuller view the per-row
// reader is a redundant intermediate (the ledger those cards expand into
// carries the very prose the reader used to show), so it steps aside and
// leaves exactly one handler in play. A card with data now always opens
// (Sean, 2026-11-13), so in practice the reader only answers on a card that
// registered no view at all.
export const defersToExpand = (el) => Boolean(el?.closest?.('.card.is-expandable'));

const defaultTruncated = (el) =>
  el.scrollHeight - el.clientHeight > 1 || el.scrollWidth - el.clientWidth > 1;

const DISMISS_MS = 20 * 1000;
let timer = null;

// Built once by viewerEl() and thereafter toggled, so `hidden` is the signal.
registerSurface('text viewer', '#text-viewer', whileShown);

// Shared overlay element: created once, wired to close on any tap.
function viewerEl() {
  let viewer = document.querySelector('#text-viewer');
  if (!viewer) {
    viewer = document.createElement('div');
    viewer.id = 'text-viewer';
    viewer.className = 'text-viewer';
    viewer.addEventListener('click', closeTextViewer);
    document.body.appendChild(viewer);
  }
  return viewer;
}

// The close hint is the viewer's, not the panel's: pinned to the viewer's own
// bottom edge (the tap view's .expand__hint placement), so it sits in the same
// spot at every glass height and costs the panel's height budget nothing.
const HINT = '<p class="text-viewer__hint">Tap anywhere to close</p>';

function show(viewer, html) {
  viewer.innerHTML = html;
  viewer.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(closeTextViewer, DISMISS_MS);
}

// `text` is plain text and is escaped here — that is the contract every caller
// gets by default, and untrusted feed copy must keep it. `{ html: true }` is the
// one opt-out, for a caller that has ALREADY escaped its text and substituted
// markup of its own (transit-alerts.js routeBullets, whose route bullets would
// otherwise flatten to bare digits in here: "no 1 between 14 St and South
// Ferry"). Nothing that has not been through an escaping pipeline of ours may
// take that path.
export function openTextViewer(title, text, { html = false } = {}) {
  show(viewerEl(), `
    <div class="text-viewer__panel">
      ${title ? `<h2 class="text-viewer__title">${escapeHtml(title)}</h2>` : ''}
      <p class="text-viewer__body">${html ? text : escapeHtml(text)}</p>
    </div>
    ${HINT}`);
}

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// How many lines of summary honestly fit. Pure arithmetic so the decision can be
// tested without a layout engine; 0 means "unmeasurable, leave it unclamped".
// Floor, never round: a partial line is a clipped line. At least one line always
// survives — a story with no visible summary at all is not worth opening.
export function descLineBudget(viewportH, reservedH, lineH) {
  if (!(viewportH > 0) || !(lineH > 0)) return 0;
  return Math.max(1, Math.floor((viewportH - reservedH) / lineH));
}

// What the panel costs BEFORE the summary. Measured, not modelled: the headline
// is feed text that wraps to one line or to four depending on the words in it,
// and no character count predicts which. Collapsing the summary to a single line
// and subtracting that line leaves exactly the fixed blocks — meta + headline +
// QR block + padding + gaps — whatever they happen to be right now. The close
// hint is out of flow (pinned to the viewer) and inside the panel's 60px bottom
// padding when the panel fits, so it reserves nothing and is never painted over.
function measureStory(viewer, desc) {
  const panel = desc.closest('.text-viewer__panel');
  return {
    viewportH: viewer.clientHeight,
    reservedH: panel.getBoundingClientRect().height - desc.getBoundingClientRect().height,
    lineH: parseFloat(getComputedStyle(desc).lineHeight),
  };
}

// The story panel has no scroller and never will: a passerby will not discover a
// scroll on a wall display. So the summary is fitted to the screen instead —
// centring alone cannot save it, because a panel taller than the viewport spills
// past BOTH edges and the top half is unreachable. The fixed blocks are reserved
// first and the summary takes what is left, which keeps the headline and the QR
// on screen at every board height; when that costs the tail of a long summary,
// the QR is what completes it. Same measure-then-fit contract the cards run
// (fitTrainRows, fitStatusBoard), and it runs on every open, so a viewer reused
// for a different story is re-measured rather than inheriting the last one's fit.
export function fitStoryDesc(viewer, measure = measureStory) {
  const desc = viewer.querySelector('.story__desc');
  if (!desc) return 0; // a story with no summary: nothing elastic to fit
  desc.style.setProperty('--desc-lines', '1');
  const { viewportH, reservedH, lineH } = measure(viewer, desc);
  const lines = descLineBudget(viewportH, reservedH, lineH);
  if (lines) desc.style.setProperty('--desc-lines', String(lines));
  else desc.style.removeProperty('--desc-lines'); // no layout engine (unit tests)
  return lines;
}

// The headline's summary at reading size, plus a QR to the full article. The
// QR renders async (the generator is a lazy chunk); the destination host is
// shown regardless, so a failed/slow load still tells you where it goes.
export function openStoryViewer({ title, source, age, desc, link }) {
  const viewer = viewerEl();
  show(viewer, `
    <div class="text-viewer__panel story">
      <div class="story__meta">
        <span class="story__src">${escapeHtml(source)}</span>
        ${age ? `<span class="story__age">${escapeHtml(age)}</span>` : ''}
      </div>
      <h2 class="story__title">${escapeHtml(title)}</h2>
      ${desc ? `<p class="story__desc">${escapeHtml(desc)}</p>` : ''}
      ${link ? `<div class="story__more">
        <div class="story__qr"></div>
        <div class="story__more-text">
          <span class="story__more-label">Read the full story</span>
          <span class="story__more-host">${escapeHtml(hostOf(link))}</span>
          <span class="story__more-hint">Scan with your phone</span>
        </div>
      </div>` : ''}
    </div>
    ${HINT}`);
  // Fit before the QR chunk resolves: the QR's box is a fixed 232px whether or
  // not the code has painted into it, so the reservation is the same either way.
  fitStoryDesc(viewer);
  if (link) renderQr(viewer.querySelector('.story__qr'), link);
}

function renderQr(container, url) {
  if (!container) return;
  import('./vendor/qrcode.js')
    .then(({ default: qrcode }) => {
      if (viewerEl().hidden) return; // closed before the chunk loaded
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3 });
    })
    .catch(() => { /* the host text still names the destination */ });
}

export function closeTextViewer() {
  const viewer = document.querySelector('#text-viewer');
  if (viewer) viewer.hidden = true;
  clearTimeout(timer);
  timer = null;
}

// Delegated: one listener on the grid covers every card, surviving re-renders.
export function initTextViewer(host, { truncated = defaultTruncated } = {}) {
  host.addEventListener('click', (e) => {
    // No reader opens under a full-screen surface, and the tap that dismisses
    // one is that surface's tap, not the grid's. This listener ran unguarded
    // for as long as the overlay probe was a three-id allow-list: a tap while
    // live TV covered the board, or the retargeted click trailing its exit,
    // could open a reader on whatever truncated row sat under the finger.
    if (surfaceOwnsTap()) return;
    // A news headline opens the rich story view (summary + QR) whether or not
    // its title is truncated — the value is the story behind it, not just the
    // full headline.
    const headline = e.target.closest?.('.headline');
    if (headline && (headline.dataset.link || headline.dataset.desc)) {
      openStoryViewer({
        title: headline.querySelector('.headline__title')?.textContent.trim() ?? '',
        source: headline.querySelector('.headline__src')?.textContent.trim() ?? '',
        age: headline.querySelector('.headline__age')?.textContent.trim() ?? '',
        desc: headline.dataset.desc ?? '',
        link: headline.dataset.link ?? '',
      });
      return;
    }
    // Everything else: expand only when the text is actually overflowing.
    const el = e.target.closest?.(EXPANDABLE);
    if (!el) return;
    // One tap, one destination. Both this listener and the expand engine's are
    // delegated on the grid, so a tap on a truncated status row used to fire
    // BOTH: the reader (z-index 46) opened on top of the card's status board
    // (44), and the tap that dismissed the reader looked like it opened the
    // board. Deferring here leaves exactly one handler in play. Cards with no
    // expansion are untouched: the rail alert banners on LIRR/MNR/NJT, and a
    // subway card small enough to hide nothing, still open the reader.
    if (el.matches?.(DEFER_TO_EXPAND) && defersToExpand(el)) return;
    if (!truncated(el)) return;
    // First text node only: card titles may carry extra spans (e.g. "as of").
    const title = el.closest('.card')?.querySelector('.card__title')?.childNodes[0]?.textContent?.trim() ?? '';
    // A row whose prose names a line wears that line's bullet (routeBullets), and
    // the reader has to show the same sentence the row shows: textContent turns
    // the span back into a naked numeral. Take the markup path only when such a
    // bullet is actually in the row — that markup is our own pipeline's output,
    // escaped before the substitution, and no other expandable text (rail alert
    // banners, headlines, quotes, city names) carries any. Anything else is
    // still read as plain text and escaped in the viewer.
    if (el.querySelector?.('.bullet--inline')) openTextViewer(title, el.innerHTML.trim(), { html: true });
    else openTextViewer(title, el.textContent.trim());
  });
}
