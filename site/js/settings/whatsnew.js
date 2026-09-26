// Settings → What's new. The board's own copy of the release notes that
// idlescreen.io publishes: the SAME data file (site/data/changelog.json),
// the same rhythm — a date gutter, lead + prose to its right, one hairline per
// dated group — retuned for a 6 ft reading distance.
//
// Pure builders plus one fetch. settings.js owns the pane element and the
// wiring, so everything worth a unit test lives out here and takes its data as
// an argument. No worker route is involved: the changelog is a Pages asset
// served from the board's own origin, so this is a same-origin GET that
// site/_headers already marks `Cache-Control: no-cache` (revalidate, 304, ~free).

import { escapeHtml } from '../util.js';

// The fewest groups that stand open no matter what. The newest ship is what
// "what's new" MEANS, so it is never demoted even if it alone overflows (the
// pane scrolls in that case, which is the pane's own normal behaviour).
export const MIN_OPEN_GROUPS = 1;

// Relative, so it resolves against the board's own origin whatever host it is
// served from (idlescreen.app, roomboard.app, beta., a preview deploy).
export const CHANGELOG_URL = 'data/changelog.json';

// Same shape guard /info applies: a group needs a date and at least one item
// with text, or it is skipped rather than rendered as an empty hairline.
function usableItems(g) {
  if (!g || !g.date || !Array.isArray(g.items)) return [];
  return g.items.filter((it) => it && it.text);
}

function groupHtml(g) {
  const items = usableItems(g);
  if (!items.length) return '';
  const body = items
    .map((it) => `<p class="log__item">${it.lead ? `<b class="log__lead">${escapeHtml(it.lead)}</b>` : ''}${escapeHtml(it.text)}</p>`)
    .join('');
  return `<div class="log__group">
      <h3 class="log__date">${escapeHtml(g.date)}</h3>
      <div class="log__items">${body}</div>
    </div>`;
}

// The whole list, as one HTML string, with EVERY group open and an empty
// history drawer waiting below the disclosure. fitChangelog() then demotes
// whatever does not fit.
//
// Optimistic static build, then a measured trim: the same contract the cards
// and the full-screen overlays already run on (fitTrainRows, subway's row loop,
// expand.js's `onOpen`). A fixed "open the newest N" like /info's OPEN_GROUPS
// cannot be right here — /info's groups are 16px prose in a page that scrolls
// for free, the board's are 24px in a fixed pane, and the groups themselves
// range from one item to seven. Two groups fills the pane one week and
// overflows it the next. Measuring is what makes the guarantee below true on
// every week's data:
//
//   the disclosure is ALWAYS visible without scrolling.
//
// That is the whole answer to a growing history on a wall panel. A reader never
// has to discover a scrollbar to learn that there is more; the control that
// reveals it is on screen before they touch anything.
//
// Returns '' when nothing is usable, which is the caller's cue to show the
// empty line instead.
export function changelogHtml(groups) {
  const built = (Array.isArray(groups) ? groups : []).map(groupHtml).filter(Boolean);
  if (!built.length) return '';
  if (built.length === 1) return `<div class="log">${built[0]}</div>`;
  // A disclosure, not a link: it stays put and stays reversible. The count is
  // the board's own addition to /info's wording. The hidden mass grows with
  // every ship and there is no scrollbar to hint at its size, so saying the
  // number is the difference between "there might be more" and "there are ten
  // more". It is filled in by fitChangelog, which is what knows the number.
  // The toggle ships VISIBLE and is hidden again only if nothing had to be
  // demoted. It is 64px tall plus a hairline, so measuring the pane without it
  // would let the loop stop one group early and then push the control it just
  // revealed off the bottom edge. Reserving its space is the fix; hiding it
  // afterwards only ever frees room.
  return `<div class="log">
      ${built.join('')}
      <button class="log__toggle" type="button" data-log-more aria-expanded="false" aria-controls="log-earlier"><span class="log__label">Show earlier updates</span><span class="log__count"></span></button>
      <div class="log__more" id="log-earlier" hidden></div>
    </div>`;
}

// Demote trailing groups into the history drawer until the pane fits, then
// label the disclosure. `pane` is the scrolling container (.settings__pane).
//
// Runs once, before the reader sees anything, and converges: every pass moves
// exactly one group out of the flow, and it stops at MIN_OPEN_GROUPS. A dozen
// layout reads worst case, on a surface the user just opened.
//
// Safe where there is no layout at all (happy-dom reports 0 for both heights,
// so the loop never runs and every group stays open) — a test asserts the
// unfitted markup, and the browser audit asserts the fit.
export function fitChangelog(pane) {
  const log = pane?.querySelector?.('.log');
  const toggle = log?.querySelector('[data-log-more]');
  const more = log?.querySelector('.log__more');
  if (!log || !toggle || !more) return 0;
  const open = [...log.querySelectorAll(':scope > .log__group')];
  const overflows = () => pane.scrollHeight > pane.clientHeight;
  let demoted = 0;
  while (open.length > MIN_OPEN_GROUPS && overflows()) {
    more.prepend(open.pop());
    demoted += 1;
  }
  if (demoted) toggle.querySelector('.log__count').textContent = `· ${demoted} more`;
  else toggle.hidden = true; // everything fit: no drawer, no control for it
  return demoted;
}

// Shown when the notes cannot be fetched or come back unusable. Quiet on
// purpose: it is an absence, not an error, and it names the place the reader
// can always get them (their phone, which is where a board with no browser
// sends you).
export const EMPTY_COPY = 'Couldn’t load the update notes just now. They are always at idlescreen.io.';

export function emptyHtml(copy = EMPTY_COPY) {
  return `<div class="log"><p class="log__empty">${escapeHtml(copy)}</p></div>`;
}

// One handler; `root` is the pane. Safe to call when there is no toggle (the
// empty state, or a history short enough that fitChangelog hid it).
export function wireChangelog(root) {
  const toggle = root.querySelector('[data-log-more]');
  if (!toggle) return;
  const more = root.querySelector('#log-earlier');
  const label = toggle.querySelector('.log__label');
  toggle.addEventListener('click', () => {
    const opening = more.hidden;
    more.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    label.textContent = opening ? 'Hide earlier updates' : 'Show earlier updates';
  });
}

// Never throws: a failed fetch, a non-JSON body and a JSON body that is not an
// array all resolve to null, and the caller renders the empty line. The board
// must never show a stack trace it has no console for. `fetchJSON` is injected
// rather than imported so a test can hand it a stub without touching the
// network; settings.js passes net.js's.
export async function loadChangelog(fetchJSON, url = CHANGELOG_URL) {
  try {
    const groups = await fetchJSON(url);
    return Array.isArray(groups) && groups.length ? groups : null;
  } catch {
    return null;
  }
}

// The pane, minus the fetch — so a test can render it from a fixture.
// `build` is the running site version (version.json). The colophon is the ONLY
// place a board states it: the fleet beacon has always reported it, but nothing
// on the glass did until this pane, and the rail footer deliberately does not
// (see railFootHtml). If this clause goes, the board stops answering "what
// version am I running" altogether.
//
// The back button is the pane's own, not the nav's: What's new is reached from
// the rail FOOTER, so no nav row is lit while it is open and there is nothing
// else on screen that says how to get out. Same 56px .iconbtn and the same
// arrow the drill-down lists use.
export function paneHtml(groups, { build = '' } = {}) {
  const list = groups ? changelogHtml(groups) : '';
  // The wrapper is a full-height flex column so the colophon can sit on the
  // pane's floor. A dated list is lumpy — one ship is two items and the next is
  // seven — so on some weeks the fit leaves a few hundred px of air below the
  // disclosure. Anchored, that air reads as the panel's lower margin; unanchored
  // it reads as content that failed to arrive.
  return `<div class="whatsnew">
      <div class="pane__head">
        <button class="iconbtn" type="button" data-wn-back aria-label="Back to settings">←</button>
        <h2 class="pane__title">What’s new</h2>
      </div>
      <p class="pane__hint">Updates to this board, newest first. It keeps itself up to date, so there is nothing to install.</p>
      ${list || emptyHtml()}
      <p class="log__foot">idlescreen${build ? ` · version ${escapeHtml(build)}` : ''} · full guide at idlescreen.io</p>
    </div>`;
}

// The rail footer's entry point: the control that opens the notes, and nothing
// else. The wordmark, which was decorative, carries the affordance instead of
// costing the rail a row of its own; the caret is the resting signifier.
// Measured: the footer grows 22px, which the nav has spare even on a board
// showing the advanced Live Video row (the 15th and last possible nav row), so
// the rail still does not scroll at rest on any configuration. There is no room
// for a second line: the rail's content box is 222px, so anything that wraps
// here costs another 24px the nav does not have.
//
// The build id used to ride this line, shortened to 7 characters. It is gone:
// a version number is what you go LOOKING for, once, and putting it in the
// rail made every reader pay attention to a string they did not ask for. The
// pane's colophon states it in full, one tap away, which is where someone who
// wants it will look.
export function railFootHtml() {
  return `<button class="settings__whatsnew" type="button" data-whatsnew>
      <span class="settings__lockup imark" aria-hidden="true"><span class="imark__idle">idle</span><span class="imark__screen">screen</span></span>
      <span class="settings__wnline">What’s new</span>
    </button>`;
}
