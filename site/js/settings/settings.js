// Full-screen, tap-only settings overlay for the board. Left rail of
// sections; every control is a ≥56px touch target; no typing anywhere
// (setup codes use the on-page keypad, names come from the companion page).

import { isLaunched, isAdvancedHidden, normalizeConfig, encodeConfig, ART_CATS, NJT_LINES, CURATED_SOURCES } from '../config.js';
import { WIDGET_LABELS } from '../catalog.js';
import { loadCache, markPendingEdit, applyConfig } from '../store.js';
import { fetchJSON } from '../net.js';
import { mintCode, redeemCode, codeFailureText } from '../setupcode.js';
import { fetchDailyBackdrop } from '../curated.js';
import { TFL_LINES, TFL_MODES } from '../tfl-lines.js';
import { WORKER_URL } from '../env.js';
import { escapeHtml } from '../util.js';
import { icon } from '../icons.js';
import { locationSearch } from '../geo.js';
import { stepTime, fmtHM } from '../modes.js';
import { toggleIn, applyNameKey, nameAutoCap, searchStations, canAddTicker, TICKER_MAX, foldAt, marketsRect } from './pickers.js';
import { attachReorder, foldHeadHtml, tickerRowsHtml } from './reorder.js';
import { itemCapacity } from '../capacity.js';
import { paneHtml as whatsNewHtml, railFootHtml, loadChangelog, fitChangelog, wireChangelog } from './whatsnew.js';

// The card names this surface shows come from the catalogue now, and so do
// /setup's: this file and that one each kept a 35-key map of their own, and the
// pair had already drifted apart on Metro-North and Live Video. Re-exported
// under the name it has always had, because the Diagnostics readout below and
// the tests both reach for it here.
export { WIDGET_LABELS };


import { SUBWAY_LINES } from '../widgets/subway.js';
import { PATH_STATIONS, PATH_DIRS } from '../widgets/path.js';
import { BSKY_API } from '../widgets/posts.js';
import { OFFICES, zoneLabel, zonesByRegion } from '../widgets/worldclock.js';
import { symbolKnown } from '../widgets/markets.js';
import { stripData, stripHtml } from '../ambient.js';
import { registerSurface } from '../surfaces.js';

// The two full-screen surfaces Settings puts up. Both are built on demand and
// removed on the tap that dismisses them, so matching at all is being up.
registerSurface('screensaver preview', '.ss-preview');
registerSurface('display test', '.displaytest');

let state = null; // { cfg, root, section, stack }

export async function openSettings(cfg, { focus } = {}) {
  if (state) closeSettings();
  state = {
    cfg: structuredClone(cfg),
    root: document.querySelector('#settings-root'),
    // Land on the nav's first entry (Display) unless asked to focus a
    // specific section (setup-code path, or an unconfigured card's tap).
    section: focus && SECTION_IDS.includes(focus) ? focus : NAV_MODEL[0].id,
    openGroup: navGroupForSection(focus && SECTION_IDS.includes(focus) ? focus : NAV_MODEL[0].id),
    stack: [],
  };
  // Baseline for hasUnsavedChanges(): every pane edits state.cfg in place, so
  // "is there anything to save" is a comparison against what Settings opened
  // with. (It replaces a `dirty` flag that was initialised here and never set
  // again by anything, i.e. it always read false.)
  state.clean = JSON.stringify(state.cfg);
  state.root.innerHTML = `
    <div class="settings" role="dialog" aria-label="Settings">
      <aside class="settings__rail">
        <h1 class="settings__brand">Settings</h1>
        <nav class="settings__nav"></nav>
        <div class="settings__railfoot">
          <button class="btn btn--primary settings__save">Save</button>
          <button class="btn settings__close">Cancel</button>
          ${railFootHtml()}
        </div>
      </aside>
      <section class="settings__pane"></section>
    </div>`;
  state.root.querySelector('.settings__close').addEventListener('click', closeSettings);
  state.root.querySelector('.settings__save').addEventListener('click', saveAndClose);
  state.root.querySelector('[data-whatsnew]').addEventListener('click', openWhatsNew);
  attachScrollIndicator(state.root.querySelector('.settings__nav'), state.root.querySelector('.settings__rail'), 8);
  attachScrollIndicator(state.root.querySelector('.settings__pane'), state.root.querySelector('.settings'), 14);
  renderNav();
  renderSection();
}

// Custom RoomOS-style scroll indicator: an overlay thumb we fully control —
// inset from the content (right offset in the host), shorter than a native
// thumb (0.6× proportional, floored), and iOS-style rubber-band squish when
// a wheel or drag pushes past an end (the thumb compresses against that end
// and springs back via the CSS height/top transition). Visible WHENEVER the
// surface is scrollable (a MutationObserver catches content growth like
// expanding a nav group); hidden only when nothing overflows.
function attachScrollIndicator(scrollEl, host, right) {
  const bar = document.createElement('div');
  bar.className = 'scrollind';
  bar.style.right = `${right}px`;
  host.appendChild(bar);
  let squish = 0;
  let squishTimer = null;
  let touchY = null;
  const INSET = 14;
  const update = () => {
    const sh = scrollEl.scrollHeight, ch = scrollEl.clientHeight;
    if (sh <= ch + 1) { bar.classList.remove('is-on'); return; }
    const sRect = scrollEl.getBoundingClientRect();
    const hRect = host.getBoundingClientRect();
    const track = ch - INSET * 2;
    // Fixed RoomOS-style length — every surface's indicator matches (the
    // proportional length made the pane's run longer than the nav's).
    let len = Math.max(36, Math.min(240, track * 0.6));
    len = Math.max(24, len - Math.min(squish, len * 0.6));
    const progress = scrollEl.scrollTop / (sh - ch);
    // progress 0 pins the squished thumb to the top, 1 to the bottom — the
    // compression anchors at whichever end is being pushed past.
    const top = sRect.top - hRect.top + INSET + Math.min(1, Math.max(0, progress)) * (track - len);
    bar.style.top = `${top}px`;
    bar.style.height = `${len}px`;
    bar.classList.add('is-on');
  };
  // Content growth happens two ways: re-renders (childList) and group
  // expands that only toggle classes on existing nodes + animate grid rows
  // (attributes; transitionend re-measures once the height settles).
  new MutationObserver(update).observe(scrollEl, { childList: true, subtree: true, attributes: true });
  scrollEl.addEventListener('transitionend', update, { passive: true });
  update();
  const addSquish = (amount) => {
    squish = Math.min(48, squish + amount);
    update();
    clearTimeout(squishTimer);
    squishTimer = setTimeout(() => { squish = 0; update(); }, 180);
  };
  scrollEl.addEventListener('scroll', () => { squish = 0; update(); }, { passive: true });
  scrollEl.addEventListener('wheel', (e) => {
    const atTop = scrollEl.scrollTop <= 0;
    const atBottom = scrollEl.scrollTop >= scrollEl.scrollHeight - scrollEl.clientHeight - 1;
    if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) addSquish(Math.abs(e.deltaY) * 0.3);
  }, { passive: true });
  scrollEl.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
  scrollEl.addEventListener('touchmove', (e) => {
    if (touchY === null) return;
    const dy = e.touches[0].clientY - touchY;
    touchY = e.touches[0].clientY;
    const atTop = scrollEl.scrollTop <= 0;
    const atBottom = scrollEl.scrollTop >= scrollEl.scrollHeight - scrollEl.clientHeight - 1;
    if ((atTop && dy > 0) || (atBottom && dy < 0)) addSquish(Math.abs(dy) * 0.35);
  }, { passive: true });
  scrollEl.addEventListener('touchend', () => { touchY = null; squish = 0; update(); }, { passive: true });
}

export function closeSettings() {
  if (!state) return;
  state.root.innerHTML = '';
  state = null;
}

// Whether Cancel would throw work away. Nothing marks the config dirty as it is
// edited (see openSettings), and nothing needs to: a value set back to what it
// was is not a change, and store.js's applyConfig is what "saving" means,
// so JSON equality with the opening config IS the question. Exported for tests.
export function hasUnsavedChanges() {
  return !!state && JSON.stringify(state.cfg) !== state.clean;
}

// What "saving" means is store.js's applyConfig, in full: the fresh timestamp,
// the write, and the reload that is still the simplest correct way to apply
// layout and widget changes. All this panel adds is which config, and taking
// itself off the screen afterwards.
async function saveAndClose() {
  await applyConfig(state.cfg);
  closeSettings();
}

// Collapsible nav model: pinned items + collapsible category groups (one open
// at a time). The nav source (replaces the old flat SECTIONS). Single-config
// categories are pinned items, not one-child groups. Its ids must equal
// SECTION_IDS (coverage-tested); grouping intentionally diverges from /setup.
// Markets became a group when Markets News landed, and My Teams when Sports News
// did (2026-07-31): a card and its feed twin share one collapsible entry.
export const NAV_MODEL = [
  { type: 'item', id: 'display', label: 'Display' },
  { type: 'item', id: 'widgets', label: 'Widgets' },
  { type: 'item', id: 'screensaver', label: 'Screensaver' },
  { type: 'item', id: 'weather', label: 'Weather' },
  { type: 'item', id: 'worldclock', label: 'World Clock' },
  { type: 'group', label: 'Images', items: [['art', 'Art'], ['landscapes', 'Landscapes'], ['photos', 'iCloud Photos'], ['gdrivephotos', 'GDrive Photos']] },
  { type: 'group', label: 'Commute', items: [
    ['subway', 'Subway'], ['lirr', 'LIRR'], ['mnr', 'Metro-North'], ['njt', 'NJ Transit'], ['amtrak', 'Amtrak'],
    ['path', 'PATH'], ['ferry', 'NYC Ferry'], ['bus', 'Express Bus'], ['citibike', 'Citi Bike'], ['tfl', 'TfL Status'] ] },
  { type: 'group', label: 'Markets', items: [['markets', 'Markets'], ['marketsnews', 'Markets News']] },
  { type: 'group', label: 'News & Social', items: [['news', 'Headlines'], ['substack', 'Substack'], ['bsky', 'Bluesky']] },
  // Sean named the group Sports: it holds more than the teams card now.
  { type: 'group', label: 'Sports', items: [['sports', 'My Teams'], ['sportsnews', 'Sports News']] },
  { type: 'item', id: 'services', label: 'Cloud Services' },
  { type: 'item', id: 'chart', label: 'Chart of the Day' },
  { type: 'item', id: 'iptv', label: 'Live Video' },
  { type: 'item', id: 'code', label: 'Setup code' },
  { type: 'item', id: 'diag', label: 'Diagnostics' },
];

// The category label containing a section id, or null if pinned/unknown.
export function navGroupForSection(id) {
  for (const e of NAV_MODEL) {
    if (e.type === 'group' && e.items.some(([sid]) => sid === id)) return e.label;
  }
  return null;
}

// Pure nav HTML: pinned items as nav buttons; groups as a toggle header (chevron
// + aria-expanded) followed by indented child buttons only when the group is open.
export function navHtml(section, openGroup, cfg = null) {
  const itemVisible = (id) =>
    isLaunched(id) && (!isAdvancedHidden(id, cfg) || cfg?.layout?.some((r) => r.id === id));
  return NAV_MODEL.filter((e) => e.type !== 'item' || itemVisible(e.id)).map((e) => {
    if (e.type === 'item') {
      return `<button class="settings__navitem ${e.id === section ? 'is-active' : ''}" data-section="${e.id}">${e.label}</button>`;
    }
    const open = openGroup === e.label;
    const header = `<button class="settings__navgroup ${open ? 'is-open' : ''}" data-group="${e.label}" aria-expanded="${open}"><span class="settings__chev"></span>${e.label}</button>`;
    // Children always in the DOM inside a grid wrapper; toggling .is-open animates
    // grid-template-rows 0fr↔1fr (see main.css). Kept persistent so the transition plays.
    const children = e.items.map(([id, label]) =>
      `<button class="settings__navitem settings__navchild ${id === section ? 'is-active' : ''}" data-section="${id}">${label}</button>`).join('');
    return `${header}<div class="settings__navkids ${open ? 'is-open' : ''}"><div class="settings__navkids__inner">${children}</div></div>`;
  }).join('');
}

function renderNav() {
  const nav = state.root.querySelector('.settings__nav');
  nav.innerHTML = navHtml(state.section, state.openGroup, state.cfg);
  nav.querySelectorAll('[data-section]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.section = btn.dataset.section;
      state.stack = [];
      state.openGroup = navGroupForSection(state.section);
      renderNav();
      renderSection();
    }),
  );
  nav.querySelectorAll('[data-group]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.openGroup = state.openGroup === btn.dataset.group ? null : btn.dataset.group;
      // Toggle open state in place (no re-render) so the grid-rows transition animates.
      nav.querySelectorAll('.settings__navgroup').forEach((h) => {
        const on = h.dataset.group === state.openGroup;
        h.classList.toggle('is-open', on);
        h.setAttribute('aria-expanded', String(on));
        h.nextElementSibling.classList.toggle('is-open', on); // the .settings__navkids wrapper
      });
    }),
  );
}

function pane() {
  return state.root.querySelector('.settings__pane');
}

const SECTION_RENDERERS = {
  widgets: renderWidgets, subway: renderSubway, lirr: renderLirr, mnr: renderMnr, njt: renderNjt, amtrak: renderAmtrak,
  path: renderPath, ferry: renderFerry, bus: renderBus, citibike: renderCitibike, tfl: renderTfl, markets: renderMarkets, marketsnews: renderMarketsNews, sports: renderSports, sportsnews: renderSportsNews,
  news: renderNews, substack: renderSubstack, bsky: renderBsky, worldclock: renderWorldclock, services: renderServices, chart: renderChart, iptv: renderIptv, screensaver: renderScreensaver,
  art: renderArt, photos: renderPhotos, gdrivephotos: renderGdrivePhotos, landscapes: renderLandscapes, weather: renderWeather, display: renderDisplay,
  code: renderCode, diag: renderDiag,
};
export const SECTION_IDS = Object.keys(SECTION_RENDERERS);

// Bumped on every section navigation. An async renderer captures it before its
// await and bails if it changed meanwhile, so a slow fetch can't overwrite the
// pane the user has since navigated to (`navStale()` below).
let navToken = 0;
export function navStale(token) {
  return token !== navToken;
}
function renderSection() {
  navToken += 1;
  const token = navToken;
  markWhatsNew(false);
  // Several renderers await a fetch or a dynamic import (the deploy-skew
  // SyntaxError vector). A rejection here left the wrong pane under the new nav
  // highlight with no message on a console-less board. Surface a hint, unless
  // the user has already navigated on (navStale guards the fast-nav clobber).
  Promise.resolve(SECTION_RENDERERS[state.section]()).catch((err) => {
    console.error('[settings] section render failed', err);
    if (navStale(token)) return;
    const pane = document.querySelector('.settings__pane');
    if (pane) pane.innerHTML = '<p class="pane__empty">Couldn’t load this section. Check the connection and try again.</p>';
  });
}

/* ---------- what's new (rail footer, not a nav section) ---------- */

// Deliberately NOT a NAV_MODEL entry. The rail is a list Sean specified by
// hand and the one that grows every time a widget ships; this does not belong
// in it. It hangs off the rail's FOOTER instead, which is `flex: none` and
// never scrolls, so it costs the nav a little height once rather than joining
// the queue that scrolls. That also keeps NAV_MODEL === SECTION_IDS, the
// coverage invariant test/settings-logic.test.js pins.
//
// Measured at 1920x1040 with the entry present: the nav seats 669px of rows in
// a 734px box on a default board and 717px on a board also showing the
// advanced Live Video row (15 rows, the most there can be), so neither scrolls
// at rest. test/viewport.test.js guards the geometry that makes that true.
function markWhatsNew(on) {
  state?.root.querySelector('[data-whatsnew]')?.classList.toggle('is-active', on);
}

// Same async shape as the section renderers (capture the token, bail if the
// user navigated on), and it bumps the token itself so a section fetch still in
// flight cannot repaint over the notes. Reached only from the footer, so the
// pane carries its own back button; back re-renders whichever section the nav
// is still highlighting, which is exactly where the reader came from.
async function openWhatsNew() {
  navToken += 1;
  const _nav = navToken;
  markWhatsNew(true);
  const groups = await loadChangelog(fetchJSON);
  if (!state || navStale(_nav)) return; // Cancel during the fetch tears `state` down
  pane().innerHTML = whatsNewHtml(groups, { build: window.__signage?.version ?? '' });
  fitChangelog(pane()); // optimistic build, measured trim (see whatsnew.js)
  wireChangelog(pane());
  pane().querySelector('[data-wn-back]').addEventListener('click', renderSection);
}

/* ---------- widgets: the pane points at edit mode ---------- */

// This pane used to carry its own add/remove toggle list, which was a second,
// worse editor: it could only ever place a card at its minimum size in the
// first hole that fit, it showed nothing about how the board would look, and
// on a full grid up to 31 rows read "(no room — resize others first)" behind a
// dead toggle — a list of things you cannot do. Edit mode is the single source
// of truth for add/remove/resize (and the only surface that can tell you what
// fits), so the rail keeps its Widgets row — that is where people look for
// widgets — and the pane spends it teaching the pencil.
function renderWidgets() {
  pane().innerHTML = `
    <h2 class="pane__title">Widgets</h2>
    <div class="wredirect">
      <span class="wredirect__glyph">${icon('pencil', 'icon--xl')}</span>
      <h3 class="wredirect__head">Widgets live in Edit mode</h3>
      <p class="wredirect__body">Add, remove, and resize cards right on the dashboard. Edit mode shows every widget’s size and what fits as you go.</p>
      <button class="btn btn--primary" data-open-edit>Open Edit mode</button>
    </div>`;
  pane().querySelector('[data-open-edit]').addEventListener('click', enterEditMode);
}

// The handoff. Edit mode runs on the dashboard, so Settings has to be gone
// first, and the entry belongs to the pencil FAB: main.js's handler owns the
// live cfg plus the save and reload that finishing an edit needs.
// Tapping that button is already how a retired card's prompt gets there
// (main.js cardFor), so this is the same one entry path rather than a second
// one that would have to re-implement all of it.
//
// Unsaved edits from another pane are not discarded and not silently kept:
// this saves them through the Save button's own path. That path ends in a
// reload (the only way widget/layout changes get applied), which is exactly
// what edit mode wants — it operates on the saved config — but it also means
// the intent to edit cannot live in a variable. store.js parks it for the
// length of one reload and main.js picks it up once the fresh config is
// running. With nothing to save there is nothing to reload for, so the common
// case opens the editor immediately.
async function enterEditMode() {
  if (!hasUnsavedChanges()) {
    closeSettings();
    document.querySelector('#edit')?.click();
    return;
  }
  markPendingEdit();
  await saveAndClose();
}

/* ---------- shared: service-alerts toggle ---------- */

// Full-width tap-row for pick-a-value settings: label left, value + chevron
// right; the ENTIRE row is the touch target (replaces the old .kv container
// with a small Change button marooned at the end).
function navRow(label, value, attr) {
  return `<button class="row row--nav" ${attr}>
    <span class="row__label row__label--dim">${label}</span>
    <span class="row__value">${value} <span class="row__chev">›</span></span>
  </button>`;
}

function alertsToggleHtml(group) {
  const on = state.cfg[group].alerts;
  return `<div class="row">
    <button class="toggle ${on ? 'is-on' : ''}" data-alerts="${group}" role="switch" aria-checked="${on}">
      <span class="toggle__knob"></span>
    </button>
    <span class="row__label">Show service alerts</span>
  </div>`;
}

function bindAlertsToggle(rerender) {
  pane().querySelectorAll('[data-alerts]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const group = btn.dataset.alerts;
      state.cfg[group].alerts = !state.cfg[group].alerts;
      rerender();
    }),
  );
}

/* ---------- art ---------- */

const ART_INTERVALS = [5, 15, 30, 60, 120];
// Compact label for the interval segmented control: 5m · 15m · 30m · 1h · 2h.
const intervalLabel = (m) => (m >= 60 ? `${m / 60}h` : `${m}m`);

function renderArt() {
  pane().innerHTML = `
    <h2 class="pane__title">Art</h2>
    <p class="pane__label">Rotation</p>
    <p class="pane__hint">Applies to the screensaver and the dashboard card.</p>
    <div class="segmented" role="group" aria-label="How often the artwork changes">${ART_INTERVALS.map(
      (m) => `<button class="seg ${state.cfg.art.every === m ? 'is-active' : ''}" data-every="${m}">${intervalLabel(m)}</button>`,
    ).join('')}</div>
    <p class="pane__label">Collections</p>
    <p class="pane__hint">None selected means every collection shows.</p>
    <div class="rows">${ART_CATS.map(([id, label]) => {
      const on = state.cfg.art.cats.includes(id);
      return `<div class="row">
        <button class="toggle ${on ? 'is-on' : ''}" data-cat="${id}" role="switch" aria-checked="${on}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">${label}</span>
      </div>`;
    }).join('')}</div>`;
  pane().querySelectorAll('[data-every]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.art.every = Number(btn.dataset.every);
      renderArt();
    }),
  );
  pane().querySelectorAll('[data-cat]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.art.cats = toggleIn(state.cfg.art.cats, btn.dataset.cat);
      renderArt();
    }),
  );
}

// Landscapes is a curated source (fixed folder, no album to connect), so its
// only setting is rotation — shared by the dashboard card and the screensaver.
function renderLandscapes() {
  pane().innerHTML = `
    <h2 class="pane__title">Landscapes</h2>
    <p class="pane__label">Rotation</p>
    <p class="pane__hint">Applies to the screensaver and the dashboard card.</p>
    <div class="segmented" role="group" aria-label="How often the landscape changes">${ART_INTERVALS.map(
      (m) => `<button class="seg ${state.cfg.landscapes.every === m ? 'is-active' : ''}" data-every="${m}">${intervalLabel(m)}</button>`,
    ).join('')}</div>
    <p class="pane__hint">A curated set of landscape photos — no setup needed. Pick it as a screensaver in Settings → Screensaver.</p>`;
  pane().querySelectorAll('[data-every]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.landscapes.every = Number(btn.dataset.every);
      renderLandscapes();
    }),
  );
}

/* ---------- photos (two widgets: iCloud + Google Drive) ---------- */

// iCloud and GDrive Photos are separate widgets with their own settings pane;
// this one renderer serves both, keyed by source. The dashboard card title is
// "Photos" for both (clean); the descriptive names live in the rail + picker.
// Function declarations (not const arrows) so SECTION_RENDERERS can forward-
// reference them above.
function renderPhotos() { return renderPhotoPane('icloud'); }
function renderGdrivePhotos() { return renderPhotoPane('gdrive'); }

// Merge a redeemed photos code into the two photo blocks. Sparse: it touches
// only the slots the code carried, so an iCloud-only code leaves any existing
// Drive album alone. Returns the human list of what changed.
function applyPhotosPatch(patch) {
  const changed = [];
  if (patch.icloud) { state.cfg.photos.album = patch.icloud; changed.push('iCloud'); }
  if (patch.gdrive) { state.cfg.gdrivephotos.album = patch.gdrive; changed.push('Google Drive'); }
  return changed;
}

function renderPhotoPane(src) {
  const gd = src === 'gdrive';
  const cfgKey = gd ? 'gdrivephotos' : 'photos';
  const otherKey = gd ? 'photos' : 'gdrivephotos';
  const p = state.cfg[cfgKey];
  const rerender = () => renderPhotoPane(src);
  // The album is built and validated on the phone (/photo-setup) — the board
  // only takes the short code it mints. No paste/type path here: clipboard is
  // unreliable on the device and Drive ids aren't OSK-typeable anyway.
  // Rotation controls only appear once an album is connected (an unconfigured
  // pane keeps a single next step: scan, get a code, enter it). Which source
  // drives the full-screen view lives on the Screensaver page now.
  const configured = p.album
    ? `<div class="rows">
        <div class="row"><span class="row__label">${gd ? 'Folder' : 'Album'} connected</span>
          <button class="btn btn--ghost" data-clear-album>Remove</button></div>
      </div>
      <p class="pane__label">Rotation</p>
      <p class="pane__hint">Applies to the slideshow and the dashboard card.</p>
      <div class="segmented" role="group" aria-label="How often the photo changes">${ART_INTERVALS.map(
        (m) => `<button class="seg ${p.every === m ? 'is-active' : ''}" data-every="${m}">${intervalLabel(m)}</button>`,
      ).join('')}</div>
      <hr class="pane__rule">`
    : '';
  pane().innerHTML = `
    <h2 class="pane__title">${gd ? 'GDrive Photos' : 'iCloud Photos'}</h2>
    <p class="pane__hint">Shows a ${gd ? '<b>Google Drive folder</b> of photos' : 'iCloud <b>Shared Album</b>'}.
      The ${gd ? 'folder' : 'album'} must be shared with a public link. It's unlikely anyone would randomly discover
      it, but <b>anyone with the link could view these photos</b>; if you're not comfortable with that, don't add
      personal photos. It's your responsibility to make sure photos are workplace appropriate.</p>
    ${configured}
    <p class="pane__label pane__label--head">${p.album ? 'Change it from your phone' : 'Set it up from your phone'}</p>
    <p class="pane__hint">Scan for the step-by-step: build the ${gd ? 'folder' : 'album'}, check its link, and it
      hands you a short code. Enter the code below.</p>
    <div class="qr qr--photos"></div>
    <button class="btn" data-code-reveal>Enter code</button>
    <div class="photo-code" hidden></div>
    <p class="code__status"></p>`;
  // Short-URL QR renders eagerly (unlike the dense config QR behind a button):
  // it's version ~3, cheap to draw. The .then re-queries the pane so a
  // re-render can't paint into a detached node.
  import('../vendor/qrcode.js').then(({ default: qrcode }) => {
    const box = pane()?.querySelector('.qr--photos');
    if (!box) return;
    const qr = qrcode(0, 'M');
    qr.addData(`https://${location.host}/photo-setup`);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4 });
  });
  // Removing an album is destructive-ish (re-adding means the phone dance
  // again), so it takes two taps: first arms the button (red, relabeled),
  // second clears; it disarms itself after 4s if the user walks away.
  pane().querySelector('[data-clear-album]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed) { state.cfg[cfgKey].album = ''; rerender(); return; }
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to remove';
    btn.classList.add('btn--armed');
    setTimeout(() => {
      if (!pane()?.contains(btn)) return; // pane re-rendered meanwhile
      delete btn.dataset.armed;
      btn.textContent = 'Remove';
      btn.classList.remove('btn--armed');
    }, 4000);
  });
  pane().querySelectorAll('[data-every]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg[cfgKey].every = Number(btn.dataset.every);
      rerender();
    }),
  );
  // The code from /photo-setup merges just the photo slots it carries (never
  // the rest of the board), applying either or both sources.
  wirePhotoCodeEntry(src, pane().querySelector('.code__status'));
}

// One status line, three registers. `.code__status` ships amber, which is the
// right colour for the only thing it used to say: something went wrong. But it
// also carries "Checking…" while a code is in flight and "Applied …" when one
// worked, and a board that answers a correct code in warning amber tells the
// person standing at it that they got it wrong. So progress goes quiet
// (--ink-dim) and success takes --good on its own solid well, the badge idiom
// from DESIGN.md; a problem keeps the amber it always had.
//   'busy'  work in progress, no verdict yet
//   'good'  it worked
//   'warn'  (default) the message is a problem
function setStatus(el, text, kind = 'warn') {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('code__status--busy', kind === 'busy');
  el.classList.toggle('code__status--good', kind === 'good');
}

// Reveals a 6-char code keypad that redeems a photos-only setup code and merges
// it into the photo blocks. Shared by both photo panes; src is the pane to
// re-render on success.
function wirePhotoCodeEntry(src, status) {
  const host = pane().querySelector('.photo-code');
  let code = '';
  const paint = () => {
    host.innerHTML = `<output class="osk__display code__display--pin" aria-live="polite">${code.padEnd(6, '·')}</output>`
      + qwertyKeypad('ABCDEFGHJKMNPQRSTVWXYZ0123456789', [],
        '<button class="key osk__key osk__key--wide" data-key="⌫">⌫</button>');
    host.querySelectorAll('[data-key]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const k = btn.dataset.key;
        if (k === '⌫') code = code.slice(0, -1);
        else if (code.length < 6) code += k;
        paint();
        if (code.length === 6) {
          setStatus(status, 'Checking…', 'busy');
          try {
            const decoded = await redeemCode(code);
            if (decoded.scope !== 'photos') { setStatus(status, 'That code holds a full board setup; enter it under Settings → Setup code instead.'); code = ''; paint(); return; }
            const changed = applyPhotosPatch(decoded.patch);
            if (!changed.length) { setStatus(status, "That code didn't carry a usable photo link."); code = ''; paint(); return; }
            renderPhotoPane(src);
            setStatus(pane().querySelector('.code__status'), `Applied ${changed.join(' + ')} photos. Press Save to finish.`, 'good');
          } catch (err) {
            setStatus(status, codeFailureText(err));
            code = '';
            paint();
          }
        }
      }));
  };
  pane().querySelector('[data-code-reveal]').addEventListener('click', (e) => {
    e.currentTarget.hidden = true;
    paint();
    host.hidden = false;
    host.scrollIntoView({ block: 'end' });
  });
}

// Reveals the 6-char keypad that redeems a video-only setup code ('~V~')
// into cfg.iptv. Mirrors wirePhotoCodeEntry.
function wireVideoCodeEntry(status) {
  const host = pane().querySelector('.photo-code');
  let code = '';
  const paint = () => {
    host.innerHTML = `<output class="osk__display code__display--pin" aria-live="polite">${code.padEnd(6, '\u00b7')}</output>`
      + qwertyKeypad('ABCDEFGHJKMNPQRSTVWXYZ0123456789', [],
        '<button class="key osk__key osk__key--wide" data-key="\u232b">\u232b</button>');
    host.querySelectorAll('[data-key]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const k = btn.dataset.key;
        if (k === '\u232b') code = code.slice(0, -1);
        else if (code.length < 6) code += k;
        paint();
        if (code.length === 6) {
          setStatus(status, 'Checking\u2026', 'busy');
          try {
            const decoded = await redeemCode(code);
            if (decoded.scope !== 'video') { setStatus(status, 'That code is not a Live Video code; full setups go under Settings \u2192 Setup code.'); code = ''; paint(); return; }
            if (!decoded.patch.url) { setStatus(status, "That code didn't carry a usable stream link."); code = ''; paint(); return; }
            state.cfg.iptv = { ...state.cfg.iptv, ...decoded.patch };
            renderIptv();
            setStatus(pane().querySelector('.code__status'), 'Applied the stream. Press Save to finish.', 'good');
          } catch (err) {
            setStatus(status, codeFailureText(err));
            code = '';
            paint();
          }
        }
      }));
  };
  pane().querySelector('[data-code-reveal]').addEventListener('click', (e) => {
    e.currentTarget.hidden = true;
    paint();
    host.hidden = false;
    host.scrollIntoView({ block: 'end' });
  });
}

/* ---------- subway ---------- */

function renderSubway() {
  const lineChips = SUBWAY_LINES.map((l) => {
    const on = state.cfg.subway.lines.includes(l);
    return `<button class="bullet bullet--${l} linechip ${on ? '' : 'linechip--off'}" data-line="${l}"
      role="switch" aria-checked="${on}">${l}</button>`;
  }).join('');
  pane().innerHTML = `
    <h2 class="pane__title">Subway status</h2>
    <p class="pane__hint">The card shows Good Service or the current alert for each line you pick.</p>
    <div class="linechips">${lineChips}</div>`;
  pane().querySelectorAll('[data-line]').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.cfg.subway.lines = toggleIn(state.cfg.subway.lines, chip.dataset.line);
      renderSubway();
    }),
  );
}

/* ---------- drill-down list (shared by LIRR / NJT pickers) ---------- */

function drillList(title, items, onPick, { back = true } = {}) {
  const drill = pane().querySelector('.drill');
  if (!drill) return; // navigated away mid-flight — the pane no longer has a .drill
  // back:false for panes where the drill IS the pane's permanent picker
  // (Ferry): backing out of those blanked the list with no way to reopen it.
  drill.innerHTML = `
    <div class="drill__head">
      ${back ? '<button class="iconbtn" data-back aria-label="Back">←</button>' : ''}
      <h3>${escapeHtml(title)}</h3>
    </div>
    <div class="drill__list">${items
      .map((it, i) => `<button class="drill__item" data-i="${i}">${it.html}</button>`)
      .join('')}</div>`;
  drill.querySelector('[data-back]')?.addEventListener('click', () => {
    const prev = state.stack.pop();
    if (prev) prev();
    else drill.innerHTML = '';
  });
  drill.querySelectorAll('[data-i]').forEach((btn) =>
    btn.addEventListener('click', () => onPick(items[Number(btn.dataset.i)])),
  );
}

/* ---------- LIRR / NJT ---------- */

// PATH-style station pill grid shared by the rail panes. No "Any station"
// entry: a stops-at pick is required (the card prompts until one is made).
function stationGridHtml(stations, currentId) {
  return `<div class="rows rows--grid rows--pill">${stations.map((s) =>
    `<button class="row row--tap ${currentId === s.id ? 'is-selected' : ''}" data-dest-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`,
  ).join('')}</div>`;
}
function bindStationGrid(cfgBlock, rerender) {
  pane().querySelectorAll('[data-dest-id]').forEach((btn) =>
    btn.addEventListener('click', () => {
      cfgBlock.dest = btn.dataset.destId;
      rerender();
    }),
  );
  // Long lists (127 LIRR stations): surface the current pick without a hunt.
  // 'nearest' is a no-op when it's already on screen, so re-renders don't jump.
  pane().querySelector('.rows--pill .is-selected')?.scrollIntoView({ block: 'nearest' });
}

let lirrStations = null;
async function renderLirr() {
  const _nav = navToken;
  lirrStations ??= await fetchJSON('data/stations-lirr.json');
  if (navStale(_nav)) return;
  const origin = state.cfg.lirr.origin ?? 'penn';
  pane().innerHTML = `
    <h2 class="pane__title">LIRR</h2>
    <p class="pane__label">Departs from</p>
    <div class="segmented" role="group" aria-label="Departure station">
      ${[['penn', 'Penn Station'], ['gct', 'Grand Central'], ['both', 'Both stations']].map(([id, label]) =>
        `<button class="seg ${origin === id ? 'is-active' : ''}" data-origin="${id}">${label}</button>`).join('')}
    </div>
    <div class="rows">${alertsToggleHtml('lirr')}</div>
    <p class="pane__label">Trains stopping at</p>
    <p class="pane__hint">Pick your station; the branch shows per train, so multi-branch destinations just work.</p>
    ${stationGridHtml(lirrStations, state.cfg.lirr.dest)}`;
  bindAlertsToggle(renderLirr);
  pane().querySelectorAll('[data-origin]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.lirr.origin = btn.dataset.origin;
      renderLirr();
    }),
  );
  bindStationGrid(state.cfg.lirr, renderLirr);
}

let amtrakStations = null;
async function renderAmtrak() {
  const _nav = navToken;
  amtrakStations ??= await fetchJSON('data/stations-amtrak.json');
  if (navStale(_nav)) return;
  pane().innerHTML = `
    <h2 class="pane__title">Amtrak — Moynihan / Penn departures</h2>
    <p class="pane__hint">Shows Amtrak trains leaving Moynihan Train Hall (New York Penn).</p>
    <div class="rows">${alertsToggleHtml('amtrak')}</div>
    <p class="pane__label">Trains stopping at</p>
    <p class="pane__hint">The arrival time at your destination shows per train.</p>
    ${stationGridHtml(amtrakStations, state.cfg.amtrak.dest)}`;
  bindAlertsToggle(renderAmtrak);
  bindStationGrid(state.cfg.amtrak, renderAmtrak);
}

let mnrStations = null;
async function renderMnr() {
  const _nav = navToken;
  mnrStations ??= await fetchJSON('data/stations-mnr.json');
  if (navStale(_nav)) return;
  pane().innerHTML = `
    <h2 class="pane__title">Metro-North — Grand Central departures</h2>
    <p class="pane__hint">Shows trains leaving Grand Central.</p>
    <div class="rows">${alertsToggleHtml('mnr')}</div>
    <p class="pane__label">Trains stopping at</p>
    <p class="pane__hint">Pick your station; the line shows per train.</p>
    ${stationGridHtml(mnrStations, state.cfg.mnr.dest)}`;
  bindAlertsToggle(renderMnr);
  bindStationGrid(state.cfg.mnr, renderMnr);
}

// The board is pinned to New York Penn Station (mirrors LIRR/Amtrak); the user
// filters departures by line. Empty selection = all lines. Modeled on the
// subway/TfL line multi-selects — no station fetch, so no flicker or getToken burst.
function renderNjt() {
  const chosen = state.cfg.njt.lines;
  const lineChips = NJT_LINES.map((l) => {
    const on = chosen.includes(l);
    return `<button class="chip ${on ? 'chip--on' : ''}" data-line="${escapeHtml(l)}"
      role="switch" aria-checked="${on}">${escapeHtml(l)}</button>`;
  }).join('');
  pane().innerHTML = `
    <h2 class="pane__title">NJ Transit — Penn Station departures</h2>
    <p class="pane__hint">Departures from New York Penn Station. Pick the lines to show; leave all off to show every line.</p>
    <div class="chips">${lineChips}</div>
    ${alertsToggleHtml('njt')}`;
  bindAlertsToggle(renderNjt);
  pane().querySelectorAll('[data-line]').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.cfg.njt.lines = toggleIn(state.cfg.njt.lines, chip.dataset.line);
      renderNjt();
    }),
  );
}

function renderPath() {
  pane().innerHTML = `
    <h2 class="pane__title">PATH</h2>
    <p class="pane__label">Direction</p>
    <div class="segmented" role="group" aria-label="Direction">${PATH_DIRS.map(([id, label]) =>
      `<button class="seg ${state.cfg.path.dir === id ? 'is-active' : ''}" data-dir="${id}">${label}</button>`,
    ).join('')}</div>
    <p class="pane__label">Station</p>
    <div class="rows rows--grid rows--pill">${Object.entries(PATH_STATIONS).map(([code, name]) =>
      `<button class="row row--tap ${state.cfg.path.station === code ? 'is-selected' : ''}" data-station="${code}">${name}</button>`,
    ).join('')}</div>`;
  pane().querySelectorAll('[data-station]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.path.station = btn.dataset.station;
      renderPath();
    }),
  );
  pane().querySelectorAll('[data-dir]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.path.dir = btn.dataset.dir;
      renderPath();
    }),
  );
}

let ferryStops = null;
// Mirrors renderPath: a flat pill grid with the current pick outlined (the old
// drill-list picker read as a different idiom from its PATH neighbor).
async function renderFerry() {
  const _nav = navToken;
  pane().innerHTML = `
    <h2 class="pane__title">NYC Ferry</h2>
    <p class="pane__label">Landing</p>
    <div class="rows rows--grid rows--pill"><p class="pane__empty">Loading…</p></div>`;
  try {
    ferryStops ??= (await fetchJSON('data/ferry.json')).stops;
    if (navStale(_nav)) return;
    pane().querySelector('.rows').innerHTML = ferryStops.map((s) =>
      `<button class="row row--tap ${state.cfg.ferry.landing === s.id ? 'is-selected' : ''}" data-landing-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`,
    ).join('');
    pane().querySelectorAll('[data-landing-id]').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.cfg.ferry.landing = btn.dataset.landingId;
        renderFerry();
      }),
    );
  } catch {
    const d = pane().querySelector('.rows');
    if (d) d.innerHTML = '<p class="pane__empty">Landing list unavailable. Redeploy the site data.</p>';
  }
}

let expressBus = null;
async function renderBus() {
  const _nav = navToken;
  expressBus ??= await fetchJSON('data/express-bus.json');
  if (navStale(_nav)) return;
  const { expressRoutes, directionsForRoute, stopsForRouteDir } = await import('./pickers.js');
  const legs = state.cfg.bus.legs;
  const chips = legs
    .map((l, i) => `<button class="chip" data-remove="${i}"><b class="buspill">${escapeHtml(l.route)}</b> ${escapeHtml(l.stopName)} ✕</button>`)
    .join('');
  pane().innerHTML = `
    <h2 class="pane__title">Express Bus</h2>
    <p class="pane__hint">Pick your express route, direction, then stop. Add up to two.</p>
    <div class="chips">${chips || '<span class="pane__empty">No routes yet</span>'}</div>
    ${legs.length < 2 ? '<button class="btn" data-add>Add a route</button>' : ''}
    <div class="drill"></div>`;
  pane().querySelectorAll('[data-remove]').forEach((c) =>
    c.addEventListener('click', () => { state.cfg.bus.legs = legs.filter((_, i) => i !== Number(c.dataset.remove)); renderBus(); }));
  pane().querySelector('[data-add]')?.addEventListener('click', () => {
    state.stack = [];
    const pickRoute = () => drillList('Express route',
      expressRoutes(expressBus).map((r) => ({ html: `<b class="buspill">${escapeHtml(r.id)}</b>`, value: r })),
      (r) => { state.stack.push(pickRoute); pickDir(r.value); });
    const pickDir = (route) => drillList(`${route.id} — direction`,
      directionsForRoute(expressBus, route.id).map((d) => ({ html: escapeHtml(d.headsign || `Direction ${d.id}`), value: d })),
      (d) => { state.stack.push(() => pickDir(route)); pickStop(route, d.value); });
    const pickStop = (route, dir) => drillList(`${route.id} ${dir.headsign} — stop`,
      stopsForRouteDir(expressBus, route.id, dir.id).map((s) => ({ html: escapeHtml(s.name), value: s })),
      (s) => {
        state.cfg.bus.legs = [...state.cfg.bus.legs, { route: route.id, lineRef: route.lineRef, dir: dir.id, stopId: s.value.id, stopName: s.value.name }];
        renderBus();
      });
    pickRoute();
  });
}

function renderTfl() {
  const chosen = state.cfg.tfl.lines;
  const groups = TFL_MODES.map((g) => {
    const chips = TFL_LINES.filter((l) => l.mode === g).map((l) => {
      const on = chosen.includes(l.id);
      return `<button class="tflchip ${on ? '' : 'tflchip--off'}" data-line="${l.id}" role="switch" aria-checked="${on}">
        <span class="tflchip__dot" style="background:${l.color}"></span>${escapeHtml(l.name)}</button>`;
    }).join('');
    return `<h3 class="pane__subhead">${g}</h3><div class="tflchips">${chips}</div>`;
  }).join('');
  pane().innerHTML = `
    <h2 class="pane__title">TfL Status</h2>
    <p class="pane__hint">Pick the London lines to watch; each shows Good Service or the current disruption.</p>
    ${groups}`;
  pane().querySelectorAll('[data-line]').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.cfg.tfl.lines = toggleIn(state.cfg.tfl.lines, chip.dataset.line);
      renderTfl();
    }));
}

let cbStations = null; // citibike station bundle [{id,name}], fetched once
async function renderCitibike() {
  const _nav = navToken;
  cbStations ??= await fetchJSON('data/citibike-stations.json');
  if (navStale(_nav)) return;
  let query = '';
  const draw = () => {
    const chosen = state.cfg.citibike.stations;
    const chips = chosen
      .map((s, i) => `<button class="chip" data-remove="${i}">${escapeHtml(s.name)} ✕</button>`).join('');
    const chosenIds = new Set(chosen.map((s) => s.id));
    // Cap at 8: on the 860px spine 20 matches wrap into ~10 rows and shove the
    // keyboard below the fold mid-search — keep typing to narrow instead.
    const matches = searchStations(cbStations, query, chosenIds, 8);
    pane().innerHTML = `
      <h2 class="pane__title">Citi Bike</h2>
      <p class="pane__hint">Search a station by its cross-streets. Add up to 6.</p>
      <div class="chips">${chips || '<span class="pane__empty">No stations; defaults return on save</span>'}</div>
      <output class="code__display">${escapeHtml(query) || '&nbsp;'}</output>
      <div class="picklist">${matches
        .map((s) => (s.added
          ? `<span class="btn picklist__item picklist__item--added">${escapeHtml(s.name)} ✓ Added</span>`
          : `<button class="btn picklist__item" data-add="${s.id}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`))
        .join('') || (query.trim().length >= 2 ? '<span class="pane__empty">No matches</span>' : '')}</div>
      ${chosen.length < 6
        ? qwertyKeypad('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', [' ', '-', '/'],
          '<button class="key osk__key" data-key="⌫">⌫</button>')
        : '<p class="pane__hint">Max 6; remove one to add another.</p>'}`;
    pane().querySelectorAll('[data-remove]').forEach((c) =>
      c.addEventListener('click', () => { state.cfg.citibike.stations = chosen.filter((_, i) => i !== Number(c.dataset.remove)); draw(); }));
    pane().querySelectorAll('[data-add]').forEach((b) =>
      b.addEventListener('click', () => {
        if (chosen.length >= 6) return;
        state.cfg.citibike.stations = [...chosen, { id: b.dataset.add, name: b.dataset.name }];
        query = ''; draw();
      }));
    pane().querySelectorAll('[data-key]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const k = btn.dataset.key;
        if (k === '⌫') query = query.slice(0, -1);
        else if (query.length < 30) query += k;
        draw();
      }));
  };
  draw();
}

// QWERTY-ordered keypad rows filtered to the field's alphabet: keys keep their
// familiar positions, and characters the field doesn't accept simply don't
// appear (setup codes have no I/L/O/U on purpose). Reuses the photos
// keyboard's .osk row/key styles so every on-board keyboard reads the same.
const QWERTY_ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
export function qwertyKeypad(alphabet, extraKeys, actionsHtml, { lower = false, shift = null } = {}) {
  const allowed = new Set(alphabet);
  const rows = QWERTY_ROWS.map((r) => [...r].filter((k) => allowed.has(k)))
    .filter((r) => r.length); // digit-less alphabets (the name pad) drop the empty digits row
  rows[rows.length - 1].push(...extraKeys.filter((k) => k !== ' ')); // symbols ride the short bottom row
  // shift === null keeps the classic fixed-case pad (`lower` picks the case).
  // A boolean makes the pad SHIFTABLE: letters render/emit in the shift case
  // and the bottom letter row gains ⇧ (head) and ⌫ (tail) — the name-pad
  // layout. Callers own the state and re-render on the Shift key.
  const upper = shift === null ? !lower : shift;
  const cased = (k) => (upper ? k : k.toLowerCase());
  const keyHtml = (k) => `<button class="key osk__key" data-key="${cased(k)}">${cased(k)}</button>`;
  const shiftKey = shift === null ? ''
    : `<button class="key osk__key ${shift ? 'is-on' : ''}" data-key="Shift">⇧</button>`;
  const backKey = shift === null ? '' : '<button class="key osk__key" data-key="⌫">⌫</button>';
  // The space bar is a wide, labeled key (a bare ' ' renders as a blank
  // key-sized button — Sean hit this in the Citi Bike search) and sits on the
  // bottom actions row, the same spot as the greeting-name pad's space bar.
  const space = extraKeys.includes(' ')
    ? '<button class="key osk__key osk__key--space" data-key=" ">space</button>'
    : '';
  return `<div class="osk">${rows
    .map((row, i) => `<div class="osk__row">${i === rows.length - 1 ? shiftKey : ''}${row.map(keyHtml).join('')}${i === rows.length - 1 ? backKey : ''}</div>`)
    .join('')}<div class="osk__row">${space}${actionsHtml}</div></div>`;
}

// Company names for the list's second line, borrowed from the last markets
// payload the board fetched. Best-effort decoration only: with no cache the
// rows show symbols alone, which is what the chips did.
function marketNames() {
  const out = {};
  for (const ix of loadCache('markets')?.data?.indices ?? []) {
    if (typeof ix?.symbol === 'string' && typeof ix?.name === 'string') out[ix.symbol] = ix.name;
  }
  return out;
}

// Two columns, and the ONE settings pane that has them. It earns the exception:
// this is the only pane holding both a 20-item ordered list and an on-screen
// keyboard, and one column puts the keypad 671px below the pane's bottom edge
// at 12 tickers (measured) — so adding a ticker would mean scrolling past the
// whole list first. Here the list scrolls inside its own column and the keypad
// never moves. Citi Bike (max 6), My Teams (max 6) and the station pickers all
// still fit one column.
function renderMarkets() {
  const symbols = state.cfg.markets.symbols;
  const rect = marketsRect(state.cfg);
  const cap = foldAt(state.cfg);
  // The size→capacity relationship, stated in words for the first time
  // anywhere in the product: it teaches that resizing the card is the OTHER
  // lever, so ordering isn't the only answer to "I can't see CSCO".
  const note = !rect
    ? 'Markets isn’t on the board right now'
    : `Markets card is ${rect.w}×${rect.h}, so it shows the first ${itemCapacity('markets', rect.w, rect.h)}`;
  const list = symbols.length
    ? `<div class="colhead"><h3>Order</h3><span>${escapeHtml(note)}</span></div>
       ${foldHeadHtml(cap, symbols.length)}
       <div class="tk-listwrap"><div class="tk-list" data-tk-list>${tickerRowsHtml(symbols, { cap, names: marketNames() })}</div></div>
       ${symbols.length === 1 ? '<p class="pane__hint tk-note">Add a second ticker and each row gains a handle to drag it by.</p>' : ''}`
    : `<div class="colhead"><h3>Order</h3><span>nothing to order yet</span></div>
       <p class="pane__empty">No tickers; the three index defaults return on save.</p>`;
  pane().innerHTML = `
    <h2 class="pane__title">Markets</h2>
    <p class="pane__hint">Drag a ticker by its arrows to reorder the list; the card fills from the top of it down, and everything under the line is one tap away on the card, where the ^ indexes always lead on their own shelf. Add up to ${TICKER_MAX} (indexes start with ^; non-US listings use the exchange suffix: London CBG.L, Frankfurt SAP.DE, Tokyo 7203.T).</p>
    <div class="pane__cols">
      <div class="pane__col">${list}</div>
      <div class="pane__col">
        <div class="colhead"><h3>Add a ticker</h3><span>${TICKER_MAX - symbols.length} slot${TICKER_MAX - symbols.length === 1 ? '' : 's'} left</span></div>
        <output class="code__display" aria-live="polite"></output>
        ${qwertyKeypad('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ['^', '.', '-'],
          '<button class="key osk__key" data-key="⌫">⌫</button><button class="key osk__key osk__key--primary osk__key--wide" data-key="Add">Add</button>')}
        <p class="code__status"></p>
      </div>
    </div>`;
  pane().querySelectorAll('[data-remove-sym]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.markets.symbols = symbols.filter((t) => t !== btn.dataset.removeSym);
      renderMarkets();
    }),
  );
  const listEl = pane().querySelector('[data-tk-list]');
  if (listEl) {
    attachReorder(listEl, {
      order: () => state.cfg.markets.symbols,
      cap,
      // The list column is what scrolls under a drag here, not the pane.
      scroller: listEl,
      commit: (next) => { state.cfg.markets.symbols = next; renderMarkets(); },
    });
  }
  let ticker = '';
  const display = pane().querySelector('.code__display');
  const status = pane().querySelector('.code__status');
  pane().querySelectorAll('[data-key]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const k = btn.dataset.key;
      if (k === '⌫') ticker = ticker.slice(0, -1);
      else if (k === 'Add') {
        if (!canAddTicker(symbols, ticker)) return;
        setStatus(status, 'Checking…', 'busy');
        if (await symbolKnown(ticker)) {
          state.cfg.markets.symbols = [...symbols, ticker];
          renderMarkets();
          return;
        }
        setStatus(status, `${ticker} isn't a known ticker. Check the symbol.${/^[A-Z]{1,6}$/.test(ticker) ? ' Non-US listings need the exchange suffix, e.g. CBG.L for London.' : ''}`);
      } else if (ticker.length < 10) ticker += k;
      display.textContent = ticker;
    }),
  );
}

let teamsData = null;
async function renderSports() {
  const _nav = navToken;
  teamsData ??= await fetchJSON('data/teams.json');
  if (navStale(_nav)) return;
  const byKey = {};
  for (const l of teamsData.leagues) for (const t of l.teams) byKey[`${l.lg}:${t.id}`] = { ...t, label: l.label };
  const chips = state.cfg.sports.teams
    .map((sel) => {
      const t = byKey[`${sel.lg}:${sel.id}`];
      return `<button class="chip" data-remove-team="${escapeHtml(sel.lg)}:${escapeHtml(sel.id)}">${t ? `${escapeHtml(t.name)} (${escapeHtml(t.label)})` : escapeHtml(sel.id)} ✕</button>`;
    })
    .join('');
  pane().innerHTML = `
    <h2 class="pane__title">My Teams</h2>
    <p class="pane__hint">Follow up to 6 teams; one glanceable row each: live score, final, or next game.</p>
    <div class="chips">${chips || '<span class="pane__empty">No teams yet</span>'}</div>
    <button class="btn btn--primary" data-add-team>Add a team</button>
    <div class="drill"></div>`;
  pane().querySelectorAll('[data-remove-team]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const [lg, id] = chip.dataset.removeTeam.split(':');
      state.cfg.sports.teams = state.cfg.sports.teams.filter((t) => !(t.lg === lg && t.id === id));
      renderSports();
    }),
  );
  pane().querySelector('[data-add-team]').addEventListener('click', () => {
    drillList(
      'Choose a league',
      teamsData.leagues.map((l) => ({ html: escapeHtml(l.label), value: l })),
      (pick) => {
        state.stack.push(() => renderSports());
        drillList(
          `${pick.value.label} — choose a team`,
          pick.value.teams.map((t) => ({ html: escapeHtml(t.name), value: { lg: pick.value.lg, id: t.id } })),
          (teamPick) => {
            const sel = teamPick.value;
            const exists = state.cfg.sports.teams.some((t) => t.lg === sel.lg && t.id === sel.id);
            if (!exists && state.cfg.sports.teams.length < 6) {
              state.cfg.sports.teams = [...state.cfg.sports.teams, sel];
            }
            state.stack = [];
            renderSports();
          },
        );
      },
    );
  });
}

async function renderNews() {
  const _nav = navToken;
  const { NEWS_SOURCES } = await import('../widgets/news.js');
  if (navStale(_nav)) return;
  const groups = ['National', 'Local NYC'];
  pane().innerHTML = `
    <h2 class="pane__title">Headlines</h2>
    <p class="pane__hint">Pick your sources: newest stories across all of them, merged.</p>
    ${groups.map((g) => `
      <p class="pane__label">${g}</p>
      <div class="rows">${NEWS_SOURCES.filter((s) => s[4] === g).map(([id, label]) => {
        const on = state.cfg.news.sources.includes(id);
        return `<div class="row">
          <button class="toggle ${on ? 'is-on' : ''}" data-src="${id}" role="switch" aria-checked="${on}">
            <span class="toggle__knob"></span>
          </button>
          <span class="row__label">${label}</span>
        </div>`;
      }).join('')}</div>`).join('')}`;
  pane().querySelectorAll('[data-src]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.news.sources = toggleIn(state.cfg.news.sources, btn.dataset.src);
      renderNews();
    }),
  );
}

async function renderMarketsNews() {
  const _nav = navToken;
  const { MARKET_SOURCES } = await import('../widgets/marketsnews.js');
  if (navStale(_nav)) return;
  pane().innerHTML = `
    <h2 class="pane__title">Markets News</h2>
    <p class="pane__hint">Pick your finance sources — newest stories across all of them, merged.</p>
    <div class="rows">${MARKET_SOURCES.map(([id, label]) => {
      const on = state.cfg.marketsnews.sources.includes(id);
      return `<div class="row">
        <button class="toggle ${on ? 'is-on' : ''}" data-src="${id}" role="switch" aria-checked="${on}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">${label}</span>
      </div>`;
    }).join('')}</div>`;
  pane().querySelectorAll('[data-src]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.marketsnews.sources = toggleIn(state.cfg.marketsnews.sources, btn.dataset.src);
      renderMarketsNews();
    }),
  );
}

async function renderSportsNews() {
  const _nav = navToken;
  const { SPORTS_SOURCES, SPORTS, SPORT_FEEDS, takeoverSummary } = await import('../widgets/sportsnews.js');
  if (navStale(_nav)) return;
  const t = state.cfg.sportsnews;
  // The filter has nothing to filter BY until My Teams has a team, so the row
  // says so and stays untappable rather than silently doing nothing.
  const hasTeams = state.cfg.sports.teams.length > 0;
  const on = t.onlyMyTeams && hasTeams;
  // With the takeover on, the toggle owns the sports dimension: the chips gray
  // out (disabled, not hidden) and the note says what is choosing for them.
  const leagues = [...new Set(state.cfg.sports.teams.map((tm) => tm.lg))].filter((l) => l in SPORT_FEEDS);
  const sportsHint = on
    ? `Only my teams is picking your sports: ${takeoverSummary(leagues)}.`
    : 'Narrow the card to particular sports. None picked means all of them.';
  pane().innerHTML = `
    <h2 class="pane__title">Sports News</h2>
    <p class="pane__hint">Pick your sports sources: newest stories across all of them, merged.</p>
    <div class="rows">${SPORTS_SOURCES.map(([id, label]) => {
      const src = t.sources.includes(id);
      return `<div class="row">
        <button class="toggle ${src ? 'is-on' : ''}" data-src="${id}" role="switch" aria-checked="${src}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">${label}</span>
      </div>`;
    }).join('')}</div>
    <p class="pane__hint">${sportsHint}</p>
    <div class="chips">${SPORTS.map(([id, label]) => {
      const picked = t.sports.includes(id);
      return `<button class="chip ${picked && !on ? 'chip--on' : ''}" data-sport="${id}" ${on ? 'disabled' : ''}>${label}</button>`;
    }).join('')}</div>
    <div class="row row--control">
      <button class="toggle ${on ? 'is-on' : ''}" data-only-teams role="switch" aria-checked="${on}" ${hasTeams ? '' : 'disabled'}>
        <span class="toggle__knob"></span>
      </button>
      <span class="row__label">Only my teams${hasTeams ? '' : ' <small>(pick teams in My Teams first)</small>'}</span>
    </div>
    <p class="pane__hint">On, the card fetches your teams' leagues and keeps only stories that name one of your teams. Matching is on the words in the headline and its summary, so a story that calls a team by a nickname alone can slip past.</p>`;
  pane().querySelectorAll('[data-src]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.sportsnews.sources = toggleIn(state.cfg.sportsnews.sources, btn.dataset.src);
      renderSportsNews();
    }),
  );
  pane().querySelectorAll('[data-sport]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (on) return;
      state.cfg.sportsnews.sports = toggleIn(state.cfg.sportsnews.sports, btn.dataset.sport);
      renderSportsNews();
    }),
  );
  pane().querySelector('[data-only-teams]').addEventListener('click', () => {
    if (!hasTeams) return;
    state.cfg.sportsnews.onlyMyTeams = !state.cfg.sportsnews.onlyMyTeams;
    renderSportsNews();
  });
}

async function renderChart() {
  const _nav = navToken;
  const { CHART_TOPICS } = await import('../widgets/chart-topics.js');
  if (navStale(_nav)) return;
  const c = state.cfg.chart;
  const allSlugs = CHART_TOPICS.map(([, slug]) => slug);
  const allOn = allSlugs.every((slug) => c.topics.includes(slug));
  pane().innerHTML = `
    <h2 class="pane__title">Chart of the Day</h2>
    <p class="pane__hint">A daily Statista infographic. Every topic is on to start; the card cycles through whichever are on at each refresh. With none on, it shows the newest chart across every topic.</p>
    <div class="row row--control">
      <button class="toggle ${allOn ? 'is-on' : ''}" data-topic-all role="switch" aria-checked="${allOn}">
        <span class="toggle__knob"></span>
      </button>
      <span class="row__label">Select all</span>
    </div>
    <div class="rows rows--grid">${CHART_TOPICS.map(([label, slug]) => {
      const on = c.topics.includes(slug);
      return `<div class="row">
        <button class="toggle ${on ? 'is-on' : ''}" data-topic="${escapeHtml(slug)}" role="switch" aria-checked="${on}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">${escapeHtml(label)}</span>
      </div>`;
    }).join('')}</div>
    <div class="pane__section">
      <div class="row">
        <button class="toggle ${c.excludePolitics ? 'is-on' : ''}" data-chart-politics role="switch" aria-checked="${c.excludePolitics}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">Hide political charts</span>
      </div>
    </div>`;
  pane().querySelector('[data-topic-all]').addEventListener('click', () => {
    state.cfg.chart.topics = allOn ? [] : [...allSlugs];
    renderChart();
  });
  pane().querySelectorAll('[data-topic]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.chart.topics = toggleIn(state.cfg.chart.topics, btn.dataset.topic);
      renderChart();
    }),
  );
  pane().querySelector('[data-chart-politics]').addEventListener('click', () => {
    state.cfg.chart.excludePolitics = !state.cfg.chart.excludePolitics;
    renderChart();
  });
}

// Full-screen preview of a screensaver source; any tap exits. Clock faces
// render instantly (pure); art/photos show one image from their source.
async function openSsPreview(source) {
  const ov = document.createElement('div');
  ov.className = 'ss-preview';
  ov.innerHTML = '<div class="ss-preview__hint">Tap anywhere to exit the preview</div>';
  ov.addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
  // Faithful preview: include the info strip exactly as ambient renders it
  // (from the live widget caches) whenever the toggle is on.
  const stripPart = state.cfg.screensaver?.strip === false ? '' : (() => {
    const caches = {};
    for (const id of ['weather', 'lirr', 'mnr', 'njt']) caches[id] = loadCache(id)?.data;
    const showTime = !['clock', 'worldclocks', 'clockrow'].includes(source);
    return `<div class="strip">${stripHtml(stripData(caches, state.cfg), new Date(), { showTime })}</div>`;
  })();
  // Mirrors ambient's has-strip: reserves the strip's space so a two-row clock
  // grid centers above it in the preview too.
  if (stripPart) ov.classList.add('has-strip');
  const hint = stripPart + '<div class="ss-preview__hint">Tap anywhere to exit the preview</div>';
  try {
    if (source === 'clock' || source === 'worldclocks' || source === 'clockrow') {
      const { clockFaceHtml } = await import('../clockfaces.js');
      if (state.cfg.screensaver.backdrop) {
        const url = await fetchDailyBackdrop({ fetchJSON });
        // Escape quotes/backslashes so an external URL can't break out of url("...").
        if (url) { ov.style.backgroundImage = `url("${String(url).replaceAll('\\', '%5C').replaceAll('"', '%22')}")`; ov.classList.add('ss-backdrop'); }
      }
      ov.innerHTML = clockFaceHtml(source, state.cfg) + hint;
    } else if (source === 'art') {
      const man = await fetchJSON('data/art-manifest.json');
      const p = man[Math.floor(Math.random() * man.length)];
      ov.innerHTML = `<img class="ss-preview__img" src="${escapeHtml(p.img)}" alt="">` + hint;
    } else if (CURATED_SOURCES[source]) {
      const digest = await fetchJSON(`${WORKER_URL}/gdrive/album?folder=${encodeURIComponent(CURATED_SOURCES[source].folder)}`);
      const list = digest.photos ?? [];
      const p = list[Math.floor(Math.random() * list.length)];
      if (!p) throw new Error('no photos');
      ov.innerHTML = `<img class="ss-preview__img" src="${escapeHtml(p.url)}" alt="">` + hint;
    } else {
      const block = state.cfg[source];
      const path = source === 'photos' ? '/icloud/album?token=' : '/gdrive/album?folder=';
      const digest = await fetchJSON(`${WORKER_URL}${path}${encodeURIComponent(block.album)}`);
      const p = digest.photos?.[0];
      if (!p) throw new Error('no photos');
      ov.innerHTML = `<img class="ss-preview__img" src="${escapeHtml(p.url)}" alt="">` + hint;
    }
  } catch {
    ov.innerHTML = '<div class="ss-preview__hint">Preview unavailable right now. Tap to close.</div>';
  }
}

async function renderScreensaver() {
  const ss = state.cfg.screensaver;
  const CLOCK_IDS = ['clock', 'worldclocks', 'clockrow'];
  const OPTIONS = [
    ['art', 'Art slideshow', ''],
    ...Object.entries(CURATED_SOURCES).map(([id, s]) => [id, s.label, 'curated slideshow']),
    ['photos', 'iCloud Photos', state.cfg.photos.album ? '' : 'no album connected yet'],
    ['gdrivephotos', 'GDrive Photos', state.cfg.gdrivephotos.album ? '' : 'no folder connected yet'],
    ['clock', 'Big clock', ''],
    ['worldclocks', 'World clocks', 'analog dials, one per World Clock city'],
    ['clockrow', 'Clock + world times', ''],
  ];
  pane().innerHTML = `
    <h2 class="pane__title">Screensaver</h2>
    <p class="pane__hint">The screensaver only shows when Display
      mode is <b>Always screensaver</b>, or <b>Scheduled</b> outside the dashboard windows
      (Settings → Display). To have no screensaver, set Display to <b>Always dashboard</b>.</p>
    <div class="rows">${OPTIONS.map(([id, label, note]) => `
      <div class="ss-opt">
        <div class="row row--tap row--pill ${ss.source === id ? 'is-selected' : ''}" data-ss-src="${id}" role="button" tabindex="0">
          <span class="row__label">${label}${note ? ` <small>· ${note}</small>` : ''}</span>
        </div>
        <button class="btn btn--ghost ss-prev" data-ss-prev="${id}">Preview</button>
      </div>
      ${CLOCK_IDS.includes(id) && ss.source === id ? `
      ${id === 'worldclocks' ? `<div class="row row--control ss-suboption">
        <button class="toggle ${ss.markers ? 'is-on' : ''}" data-ss-markers role="switch" aria-checked="${ss.markers}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">Hour markers</span>
      </div>` : ''}
      <div class="row row--control ss-suboption">
        <button class="toggle ${ss.backdrop ? 'is-on' : ''}" data-ss-backdrop role="switch" aria-checked="${ss.backdrop}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">Backdrop image <small>· a daily photo behind the clock</small></span>
      </div>` : ''}`).join('')}</div>
    <div class="row row--control ss-striprow">
      <button class="toggle ${ss.strip ? 'is-on' : ''}" data-ss-strip role="switch" aria-checked="${ss.strip}">
        <span class="toggle__knob"></span>
      </button>
      <span class="row__label">Show the info strip (weather + next trains) along the bottom</span>
    </div>
    <p class="pane__hint">If a photo source loses its album, the board falls back to the Art slideshow, so the screen never goes empty. Press Save to apply.</p>`;
  pane().querySelectorAll('[data-ss-src]').forEach((row) =>
    row.addEventListener('click', () => {
      state.cfg.screensaver.source = row.dataset.ssSrc;
      renderScreensaver();
    }));
  pane().querySelectorAll('[data-ss-prev]').forEach((btn) =>
    btn.addEventListener('click', () => openSsPreview(btn.dataset.ssPrev)));
  pane().querySelector('[data-ss-strip]').addEventListener('click', () => {
    state.cfg.screensaver.strip = !state.cfg.screensaver.strip;
    renderScreensaver();
  });
  pane().querySelector('[data-ss-backdrop]')?.addEventListener('click', () => {
    state.cfg.screensaver.backdrop = !state.cfg.screensaver.backdrop;
    renderScreensaver();
  });
  pane().querySelector('[data-ss-markers]')?.addEventListener('click', () => {
    state.cfg.screensaver.markers = !state.cfg.screensaver.markers;
    renderScreensaver();
  });
}

async function renderIptv() {
  const c = state.cfg.iptv;
  const host = (() => { try { return new URL(c.url).host; } catch { return ''; } })();
  pane().innerHTML = `
    <h2 class="pane__title">Live Video</h2>
    <p class="pane__hint">Streams a live HLS feed (always muted) or a UniFi camera share link on the card. Use a stream you have the rights to show.</p>
    ${c.url ? `
    <div class="rows">
      <div class="row"><span class="row__label">Stream</span><span class="row__value">${escapeHtml(host)}</span></div>
      ${c.label ? `<div class="row"><span class="row__label">Label</span><span class="row__value">${escapeHtml(c.label)}</span></div>` : ''}
    </div>
    <button class="btn btn--ghost" data-clear-stream>Remove</button>` : ''}
    <p class="pane__label pane__label--head">${c.url ? 'Change it from your phone' : 'Set it up from your phone'}</p>
    <p class="pane__hint">Scan to paste the stream link and preview it; the page hands you a short code. Enter the code below.</p>
    <div class="qr qr--photos"></div>
    <button class="btn" data-code-reveal>Enter code</button>
    <div class="photo-code" hidden></div>
    <p class="code__status"></p>`;
  import('../vendor/qrcode.js').then(({ default: qrcode }) => {
    const box = pane()?.querySelector('.qr--photos');
    if (!box) return;
    const qr = qrcode(0, 'M');
    qr.addData(`https://${location.host}/video-setup`);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4 });
  });
  wireVideoCodeEntry(pane().querySelector('.code__status'));
  // Two-tap remove, matching the photo-album pattern: first tap arms (red),
  // second clears; disarms after 4s.
  pane().querySelector('[data-clear-stream]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed) { state.cfg.iptv = { url: '', label: '' }; renderIptv(); return; }
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to remove';
    btn.classList.add('btn--armed');
    setTimeout(() => {
      if (!pane()?.contains(btn)) return;
      delete btn.dataset.armed;
      btn.textContent = 'Remove';
      btn.classList.remove('btn--armed');
    }, 4000);
  });
}

async function renderServices() {
  const _nav = navToken;
  const { SERVICE_CHOICES } = await import('../widgets/services.js');
  if (navStale(_nav)) return;
  pane().innerHTML = `
    <h2 class="pane__title">Cloud Services</h2>
    <p class="pane__hint">Pick the cloud services to watch — each shows Operational or its current incident. Tap a degraded service on the card for the full picture.</p>
    <div class="rows">${SERVICE_CHOICES.map(([id, label]) => {
      const on = state.cfg.services.list.includes(id);
      return `<div class="row">
        <button class="toggle ${on ? 'is-on' : ''}" data-svc="${id}" role="switch" aria-checked="${on}">
          <span class="toggle__knob"></span>
        </button>
        <span class="row__label">${label}</span>
      </div>`;
    }).join('')}</div>`;
  pane().querySelectorAll('[data-svc]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.services.list = toggleIn(state.cfg.services.list, btn.dataset.svc);
      renderServices();
    }),
  );
}

/* ---------- newsletters (substack) + bluesky ---------- */

// Shared follow-list pane: chips + one add flow on the code keypad. Short
// identifiers only — never URLs (the board keyboard requirement).
function renderFollowPane(opts) {
  const list = state.cfg[opts.cfgKey][opts.listKey];
  const chips = list
    .map((a, i) => `<button class="chip" data-rm-acct="${i}">${escapeHtml(a.label)} ✕</button>`)
    .join('');
  pane().innerHTML = `
    <h2 class="pane__title">${opts.title}</h2>
    <p class="pane__hint">${opts.hint} Tap a clipped post on the card to read it full screen.</p>
    <div class="chips">${chips || '<span class="pane__empty">Nothing followed yet</span>'}</div>
    <button class="btn btn--primary" data-add>${opts.addLabel}</button>
    <div class="acct-pad" hidden>
      <output class="code__display" aria-live="polite"></output>
      <div class="acct-pad__keys"></div>
      <p class="code__status"></p>
    </div>`;
  pane().querySelectorAll('[data-rm-acct]').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.cfg[opts.cfgKey][opts.listKey] = list.filter((_, i) => i !== Number(chip.dataset.rmAcct));
      opts.rerender();
    }),
  );
  const pad = pane().querySelector('.acct-pad');
  const display = pad.querySelector('.code__display');
  const status = pad.querySelector('.code__status');
  const keys = pad.querySelector('.acct-pad__keys');
  let id = '';
  pane().querySelector('[data-add]').addEventListener('click', () => {
    id = '';
    keys.innerHTML = qwertyKeypad('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ['.', '-'],
      (opts.suffixKey ? `<button class="key osk__key osk__key--wide" data-key="${opts.suffixKey}">·${opts.suffixKey.slice(1)}</button>` : '') +
      '<button class="key osk__key" data-key="⌫">⌫</button><button class="key osk__key osk__key--wide osk__key--primary" data-key="Check">Check</button>',
      { lower: true }); // handles/slugs are lowercase — keys type what they show
    pad.hidden = false;
    display.textContent = '';
    setStatus(status, '');
    keys.querySelectorAll('[data-key]').forEach((k) =>
      k.addEventListener('click', async () => {
        const key = k.dataset.key;
        if (key === '⌫') id = id.slice(0, -1);
        else if (key === 'Check') {
          if (list.length >= 6 || list.some((a) => a.id === id)) {
            setStatus(status, 'Already following that one (or the list is full).');
            return;
          }
          setStatus(status, 'Checking…', 'busy');
          try {
            const label = await opts.validate(id);
            state.cfg[opts.cfgKey][opts.listKey] = [...list, { id, label }];
            opts.rerender();
          } catch {
            setStatus(status, `Couldn't find "${id}" — ${opts.notFoundHint}`);
          }
          return;
        } else if (id.length < 60) id += key;
        display.textContent = id;
      }),
    );
  });
}

function renderSubstack() {
  renderFollowPane({
    cfgKey: 'substack',
    listKey: 'pubs',
    title: 'Substack',
    hint: 'Follow up to 6 publications — newest essays across all of them.',
    addLabel: 'Add a publication — type the name before .substack.com',
    suffixKey: null,
    notFoundHint: 'check the publication name.',
    rerender: renderSubstack,
    validate: async (id) => {
      const digest = await fetchJSON(`${WORKER_URL}/posts/substack?pub=${encodeURIComponent(id)}`);
      if (!digest.posts?.length) throw new Error('no posts');
      return id.slice(0, 30);
    },
  });
}

function renderBsky() {
  renderFollowPane({
    cfgKey: 'bsky',
    listKey: 'handles',
    title: 'Bluesky',
    hint: 'Follow up to 6 accounts — newest posts across all of them.',
    addLabel: 'Add an account — type the handle',
    suffixKey: '.bsky.social',
    notFoundHint: 'check the handle.',
    rerender: renderBsky,
    validate: async (id) => {
      const prof = await fetchJSON(`${BSKY_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(id)}`);
      if (!prof.handle) throw new Error('not found');
      return (prof.displayName || prof.handle).slice(0, 30);
    },
  });
}

/* ---------- weather / display ---------- */

// Shared 12/24-hour toggle. One board-wide setting (cfg.clock24) surfaced in
// both the Display and World Clock panes; governs the topbar Clock, the World
// Clock widget and Weather's hour labels (transit departures keep fmtTime's 12h).
function clockFormatMarkup() {
  return `
    <p class="pane__label">Time format</p>
    <div class="segmented" role="group" aria-label="Clock time format">
      <button class="seg ${!state.cfg.clock24 ? 'is-active' : ''}" data-clock24="12">12-hour</button>
      <button class="seg ${state.cfg.clock24 ? 'is-active' : ''}" data-clock24="24">24-hour</button>
    </div>`;
}
function wireClockFormat(rerender) {
  pane().querySelectorAll('[data-clock24]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.clock24 = btn.dataset.clock24 === '24';
      rerender();
    }));
}

function renderWorldclock() {
  const cities = () => state.cfg.worldclock.cities;
  const has = (label, zone) => cities().some((c) => c.label === label && c.zone === zone);
  const zonesApi = typeof Intl.supportedValuesOf === 'function';
  pane().innerHTML = `
    <h2 class="pane__title">World Clock</h2>
    <p class="pane__hint">Cities display in order of their current time. Tap an office to add or remove it (up to 10).</p>
    <div class="chips">${cities().map((c, i) => `<button class="chip" data-rm="${i}">${escapeHtml(c.label)} ✕</button>`).join('')}</div>
    <p class="pane__label">Offices</p>
    <div class="chips">${OFFICES.map(([label, zone], i) =>
      `<button class="chip ${has(label, zone) ? 'chip--on' : ''}" data-office="${i}">${label}</button>`).join('')}</div>
    ${zonesApi ? `<p class="pane__label">Any time zone</p>
    <button class="btn" data-add-zone>Add any time zone</button>
    <div class="drill"></div>` : ''}
    ${clockFormatMarkup()}`;
  wireClockFormat(renderWorldclock);
  const set = (list) => { state.cfg.worldclock.cities = list.slice(0, 10); renderWorldclock(); };
  pane().querySelectorAll('[data-rm]').forEach((b) =>
    b.addEventListener('click', () => set(cities().filter((_, i) => i !== Number(b.dataset.rm)))));
  pane().querySelectorAll('[data-office]').forEach((b) =>
    b.addEventListener('click', () => {
      const [label, zone] = OFFICES[Number(b.dataset.office)];
      set(has(label, zone) ? cities().filter((c) => !(c.label === label && c.zone === zone)) : [...cities(), { label, zone }]);
    }));
  pane().querySelector('[data-add-zone]')?.addEventListener('click', () => {
    state.stack = [];
    const byRegion = zonesByRegion(Intl.supportedValuesOf('timeZone'));
    const pickRegion = () => drillList('Region',
      Object.keys(byRegion).map((r) => ({ html: escapeHtml(r), value: r })),
      (r) => { state.stack.push(pickRegion); pickZone(r.value); });
    const pickZone = (region) => drillList(region,
      byRegion[region].map((z) => {
        // The region is already chosen, so drop the redundant prefix: show the
        // city, plus any middle segment (e.g. Argentina) that disambiguates it.
        const rest = z.includes('/') ? z.slice(z.indexOf('/') + 1) : '';
        const mid = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')).replace(/_/g, ' ') : '';
        return {
          html: `${escapeHtml(zoneLabel(z))}${mid ? ` <small>${escapeHtml(mid)}</small>` : ''}`,
          value: z,
        };
      }),
      (it) => {
        const zone = it.value;
        const label = zoneLabel(zone);
        if (!has(label, zone)) set([...cities(), { label, zone }]);
      });
    pickRegion();
  });
}

// Open-Meteo's data is CC BY 4.0, so the credit sits where the location that
// drives all three of its cards is chosen (the docs weather page carries it too).
function renderWeather() {
  let query = '';
  let results = [];
  let status = '';
  let searching = false; // the status line is progress, not a warning (setStatus)
  const draw = () => {
    pane().innerHTML = `
      <h2 class="pane__title">Weather</h2>
      <p class="pane__label">Temperature unit</p>
      <div class="segmented" role="group" aria-label="Temperature unit">
        <button class="seg ${state.cfg.loc.units !== 'C' ? 'is-active' : ''}" data-units="F">°F</button>
        <button class="seg ${state.cfg.loc.units === 'C' ? 'is-active' : ''}" data-units="C">°C</button>
      </div>
      <div class="row"><span class="row__label row__label--dim">Current</span><span class="row__value">${escapeHtml(state.cfg.loc.label)}</span></div>
      <p class="pane__label">Location</p>
      <p class="pane__hint">Search a city anywhere, or a 5-digit US ZIP.</p>
      <output class="code__display" aria-live="polite">${escapeHtml(query) || '&nbsp;'}</output>
      <div class="picklist">${results
        .map((r, i) => `<button class="btn picklist__item" data-pick="${i}">${escapeHtml(r.label)}</button>`)
        .join('')}</div>
      ${qwertyKeypad('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', [' ', '-'],
        '<button class="key osk__key" data-key="⌫">⌫</button><button class="key osk__key osk__key--primary osk__key--wide" data-key="Search">Search</button>')}
      <p class="code__status${searching ? ' code__status--busy' : ''}">${escapeHtml(status)}</p>
      <p class="pane__hint">Weather, Air &amp; Sky and Surf data by Open-Meteo.com (CC BY 4.0).</p>`;
    pane().querySelectorAll('[data-units]').forEach((btn) =>
      btn.addEventListener('click', () => {
        state.cfg.loc = { ...state.cfg.loc, units: btn.dataset.units };
        draw();
      }));
    pane().querySelectorAll('[data-pick]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const r = results[Number(btn.dataset.pick)];
        // Picking sets units by region (US → °F, else °C); the toggle overrides.
        state.cfg.loc = { lat: r.lat, lon: r.lon, label: r.label, units: r.cc === 'US' ? 'F' : 'C' };
        query = ''; results = []; status = '';
        draw();
      }));
    pane().querySelectorAll('[data-key]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const k = btn.dataset.key;
        if (k === '⌫') query = query.slice(0, -1);
        else if (k === 'Search') {
          status = 'Searching…'; searching = true; draw();
          results = await locationSearch(query);
          status = results.length ? '' : 'No matches — try a city name or a 5-digit US ZIP.';
          searching = false;
          draw();
          return;
        } else if (query.length < 30) query += k;
        draw();
      }));
  };
  draw();
}

function renderDisplay() {
  const seg = (value, label) => `
    <button class="seg ${state.cfg.mode === value ? 'is-active' : ''}" data-set="mode:${value}">${label}</button>`;
  pane().innerHTML = `
    <h2 class="pane__title">Display</h2>
    <p class="pane__label">Mode</p>
    <div class="segmented" role="group" aria-label="Display mode">
      ${seg('dashboard', 'Always dashboard')}
      ${seg('ambient', 'Always screensaver')}
      ${seg('scheduled', 'Scheduled')}
    </div>
    ${state.cfg.mode === 'scheduled' ? `<p class="pane__hint">Dashboard shows during these windows; the screensaver shows the rest of the time.</p>
    <div class="sched">${state.cfg.schedule.map((w, i) => `
      <div class="sched__win">
        <button class="btn sched__step" data-i="${i}" data-t="start" data-d="-1">▼</button>
        <span class="sched__time">${fmtHM(w.start)}</span>
        <button class="btn sched__step" data-i="${i}" data-t="start" data-d="1">▲</button>
        <span class="sched__dash">–</span>
        <button class="btn sched__step" data-i="${i}" data-t="end" data-d="-1">▼</button>
        <span class="sched__time">${fmtHM(w.end)}</span>
        <button class="btn sched__step" data-i="${i}" data-t="end" data-d="1">▲</button>
        ${state.cfg.schedule.length > 1 ? `<button class="btn sched__rm" data-rm="${i}">✕</button>` : ''}
        ${w.start >= w.end ? '<span class="sched__warn">end must be after start</span>' : ''}
      </div>`).join('')}
      ${state.cfg.schedule.length < 4 ? '<button class="btn" data-add-win>Add window</button>' : ''}
    </div>` : ''}
    ${clockFormatMarkup()}
    <p class="pane__label">Greeting name</p>
    ${navRow('Shown as', escapeHtml(state.cfg.name || 'not set'), 'data-edit-name')}
    ${state.cfg.name ? '<button class="btn btn--ghost" data-clear-name>Remove name</button>' : ''}
    <div class="namepad" hidden>
      <output class="code__display" aria-live="polite">·</output>
      <div class="namepad__keys"></div>
    </div>`;
  pane().querySelectorAll('[data-set]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [group, value] = btn.dataset.set.split(':');
      state.cfg[group] = value;
      renderDisplay();
    }),
  );
  wireClockFormat(renderDisplay);
  pane().querySelectorAll('[data-t]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i), key = btn.dataset.t, d = Number(btn.dataset.d);
      state.cfg.schedule[i][key] = stepTime(state.cfg.schedule[i][key], d);
      renderDisplay();
    }),
  );
  pane().querySelector('[data-add-win]')?.addEventListener('click', () => {
    state.cfg.schedule = [...state.cfg.schedule, { start: 540, end: 1020 }]; // 9:00 AM–5:00 PM
    renderDisplay();
  });
  pane().querySelectorAll('[data-rm]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.cfg.schedule = state.cfg.schedule.filter((_, i) => i !== Number(btn.dataset.rm));
      renderDisplay();
    }),
  );
  pane().querySelector('[data-clear-name]')?.addEventListener('click', () => {
    state.cfg.name = '';
    renderDisplay();
  });
  const pad = pane().querySelector('.namepad');
  const display = pad.querySelector('.code__display');
  const keys = pad.querySelector('.namepad__keys');
  // Explicit case, saved verbatim (see applyNameKey): auto-caps the first
  // letter of each word, Shift overrides for camelCase, '-' for hyphenated.
  // QWERTY layout in the shared .osk styles; labels follow the shift state.
  let nameState = { value: state.cfg.name, shift: nameAutoCap(state.cfg.name) };
  function paintPad() {
    const { value, shift } = nameState;
    display.textContent = value || '·';
    // The shared qwertyKeypad (shiftable variant) renders the keys;
    // applyNameKey still owns the state — its auto-caps logic expects
    // UPPERCASE letters and named action keys, so normalize what the pad
    // emits (cased letters, ' ', '⌫') before handing over.
    keys.innerHTML = qwertyKeypad('ABCDEFGHIJKLMNOPQRSTUVWXYZ', [' ', '-'],
      '<button class="key osk__key osk__key--wide" data-key="Done">Done</button>', { shift });
    keys.querySelectorAll('[data-key]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const raw = btn.dataset.key;
        if (raw === 'Done') { state.cfg.name = nameState.value.trim(); renderDisplay(); return; }
        const k = raw === '⌫' ? 'Backspace' : raw === ' ' ? 'Space' : raw.length === 1 ? raw.toUpperCase() : raw;
        nameState = applyNameKey(nameState, k);
        paintPad();
      }),
    );
  }
  pane().querySelector('[data-edit-name]').addEventListener('click', () => {
    pad.hidden = !pad.hidden;
    if (!pad.hidden) paintPad();
  });
}

/* ---------- setup code + QR export ---------- */

function renderCode() {
  pane().innerHTML = `
    <h2 class="pane__title">Setup code</h2>
    <p class="pane__hint">Build your configuration at <b>${location.host}/setup</b> on any device, then enter the 6-character code here.</p>
    <output class="code__display code__display--pin" aria-live="polite">······</output>
    ${qwertyKeypad('ABCDEFGHJKMNPQRSTVWXYZ0123456789', [],
      '<button class="key osk__key osk__key--wide" data-key="⌫">⌫</button>')}
    <p class="code__status"></p>
    <hr class="pane__rule">
    <p class="pane__hint">Share this board's setup: get a code to write down, then enter it on another board (Settings → Setup code) or at <b>${location.host}/setup</b>.</p>
    <button class="btn" data-export>Get a code for this board</button>
    <div class="code-export" hidden>
      <output class="code__display code__display--pin" aria-live="polite"></output>
      <p class="pane__hint code-export__note"></p>
    </div>
    <hr class="pane__rule">
    <p class="pane__hint">Or move this board's setup to your phone.</p>
    <button class="btn" data-qr>Show QR of current config</button>
    <div class="qr"></div>
    <p class="pane__hint">Setting up a non-touch device? Scan the QR code, click through the options to get a pre-configured <b>signage URL</b>.</p>`;
  let code = '';
  const display = pane().querySelector('.code__display');
  const status = pane().querySelector('.code__status');
  pane().querySelectorAll('[data-key]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const k = btn.dataset.key;
      if (k === '⌫') code = code.slice(0, -1);
      else if (code.length < 6) code += k;
      display.textContent = code.padEnd(6, '·');
      if (code.length === 6) {
        setStatus(status, 'Checking…', 'busy');
        try {
          const decoded = await redeemCode(code);
          if (decoded.scope === 'photos') {
            // A photos-only code merges just the photo blocks (Settings → Photos
            // is the home for these, but redeeming here shouldn't dead-end).
            const changed = applyPhotosPatch(decoded.patch);
            if (changed.length) setStatus(status, `Applied ${changed.join(' + ')} photos. Press Save to finish.`, 'good');
            else setStatus(status, "That code didn't carry a usable photo link.");
          } else if (decoded.scope === 'video') {
            if (decoded.patch.url) {
              state.cfg.iptv = { ...state.cfg.iptv, ...decoded.patch };
              setStatus(status, 'Applied the Live Video stream. Press Save to finish.', 'good');
            } else {
              setStatus(status, "That code didn't carry a usable stream link.");
            }
          } else {
            state.cfg = decoded.cfg;
            setStatus(status, 'Applied! Review the other sections, then press Save.', 'good');
          }
        } catch (err) {
          // Only a real 404 means the code is wrong; anything else is the
          // network or the service, and minting a fresh code won't help.
          // setupcode.js owns that reading now, for all three keypads.
          setStatus(status, codeFailureText(err));
          code = '';
          display.textContent = '······';
        }
      }
    }),
  );
  pane().querySelector('[data-qr]').addEventListener('click', async () => {
    const { default: qrcode } = await import('../vendor/qrcode.js');
    const encoded = await encodeConfig(normalizeConfig(state.cfg));
    const qr = qrcode(0, 'M');
    qr.addData(`https://${location.host}/setup#cfg=${encoded}`);
    qr.make();
    // cellSize 3 (was 6): the config QR is dense (~25-version for the full
    // encoded cfg), and at 6 it dominated the pane. ~350 logical px ≈ 22cm on
    // the 55" panel — still an easy phone scan. Margin stays 4 (QR quiet zone).
    pane().querySelector('.qr').innerHTML = qr.createSvgTag({ cellSize: 3, margin: 4 });
  });
  pane().querySelector('[data-export]').addEventListener('click', async () => {
    const btn = pane().querySelector('[data-export]');
    const box = pane().querySelector('.code-export');
    const codeEl = box.querySelector('.code__display');
    const note = box.querySelector('.code-export__note');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Getting code…';
    try {
      const encoded = await encodeConfig(normalizeConfig(state.cfg));
      const code = await mintCode(encoded);
      codeEl.textContent = code;
      note.textContent = `Write it down. Enter it on another board (Settings → Setup code) or at ${location.host}/setup; expires in 1 hour.`;
    } catch (err) {
      codeEl.textContent = '—';
      note.textContent = codeFailureText(err);
    } finally {
      box.hidden = false;
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

/* ---------- diagnostics ---------- */

// Do any Cisco Sans families resolve inside this web view? RoomOS draws its
// own UI in CiscoSansTT; if the firmware exposes it to web content, the
// Momentum theme can reference the real face by name (we never bundle the
// font — it's Cisco-proprietary). fonts.check() alone can false-positive on
// aliased fallbacks, so a canvas width comparison against both generic
// families is the tie-breaker. Returns 'unknown' where canvas/FontFaceSet
// are unavailable (tests, ancient engines).
function probeCiscoFonts() {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = 'RoomOS wide sample MW10';
    const width = (fam) => {
      ctx.font = `24px ${fam}`;
      return ctx.measureText(sample).width;
    };
    const serif = width('serif');
    const mono = width('monospace');
    // Base names first, then individual faces — devices often register each
    // weight as its own family. The inventory tells us which weights we can
    // map precisely (e.g. via @font-face local()) vs what snaps to Bold.
    const hits = [
      'CiscoSansTT', 'CiscoSans', 'Cisco Sans', 'Cisco SansTT',
      'CiscoSansTT Thin', 'CiscoSansTT ExtraLight', 'CiscoSansTT Light',
      'CiscoSansTT Medium', 'CiscoSansTT Bold', 'CiscoSansTT Heavy',
      'CiscoSansTT Oblique',
    ].filter((fam) =>
      document.fonts?.check?.(`16px "${fam}"`)
      && width(`"${fam}", serif`) !== serif
      && width(`"${fam}", monospace`) !== mono);
    return hits.length ? hits.join(', ') : 'not exposed';
  } catch {
    return 'unknown';
  }
}

// Full-screen alignment pattern for capturing how the panel actually draws
// the page: 100px green grid on black with coordinate labels, the viewport
// edge, the --safe-bottom line, and the ~40 logical px the RoomOS "tap here
// to start" bar overlays. Static gradients only (gen1-safe). Tap to dismiss.
function showDisplayTest() {
  const o = document.createElement('div');
  o.className = 'displaytest';
  const labels = [];
  for (let x = 100; x < window.innerWidth; x += 100) labels.push(`<span class="displaytest__lx" style="left:${x}px">${x}</span>`);
  for (let y = 100; y < window.innerHeight; y += 100) labels.push(`<span class="displaytest__ly" style="top:${y}px">${y}</span>`);
  o.innerHTML = `
    <div class="displaytest__info">viewport ${window.innerWidth}×${window.innerHeight} css px · dpr ${window.devicePixelRatio} · screen ${screen.width}×${screen.height} · tap to close</div>
    ${labels.join('')}
    <div class="displaytest__safe"><span>--safe-bottom (84px)</span></div>
    <div class="displaytest__unsafe"><span>RoomOS bar overlay (~40px)</span></div>`;
  o.addEventListener('click', () => o.remove());
  document.body.appendChild(o);
}

function renderDiag() {
  const rows = state.cfg.layout.map(({ id }) => {
    const cache = loadCache(id);
    const age = cache ? Math.round((Date.now() / 1000 - cache.t) / 60) : null;
    return `<span>${WIDGET_LABELS[id]}</span>
      <b>${age === null ? 'no data yet' : age < 1 ? 'fresh' : `${age} min ago`}</b>`;
  });
  pane().innerHTML = `
    <h2 class="pane__title">Diagnostics</h2>
    <div class="kv-grid">
      <span>Config source</span><b>${window.__signage?.source ?? '—'}</b>
      ${rows.join('')}
      <span>User agent</span><b class="kv__small">${escapeHtml(navigator.userAgent)}</b>
      <span>Cisco fonts</span><b>${escapeHtml(probeCiscoFonts())}</b>
    </div>
    <div class="row">
      <button class="toggle ${state.cfg.beacon ? 'is-on' : ''}" data-beacon role="switch" aria-checked="${state.cfg.beacon}">
        <span class="toggle__knob"></span>
      </button>
      <span class="row__label">Anonymous usage ping</span>
    </div>
    <p class="pane__hint">Once an hour the board sends a random device id, its widget list, display mode, version, and timezone; nothing personal. Helps the operator count active boards.</p>
    <div class="row">
      <button class="toggle ${state.cfg.nerdMode ? 'is-on' : ''}" data-nerd role="switch" aria-checked="${state.cfg.nerdMode}">
        <span class="toggle__knob"></span>
      </button>
      <span class="row__label">Nerd mode</span>
    </div>
    <p class="pane__hint">Shows advanced cards in the widget pickers that need self-hosted gear behind them (live video streams, camera gateways). Off keeps the pickers simple.</p>
    <p class="pane__label">Display</p>
    <div class="btnrow">
      <button class="btn btn--primary" data-reload>Reload display now</button>
      <button class="btn" data-displaytest>Display test</button>
    </div>
    <p class="pane__label">Storage</p>
    <div class="btnrow">
      <button class="btn" data-clear>Clear web storage</button>
    </div>
    <p class="pane__hint">Wipes this board's saved data and reloads. If the signage URL carries its configuration (the #cfg fragment), the setup returns by itself; on a board pointed at the plain URL the layout does not come back, and there is no copy anywhere to restore from. Before clearing such a board, get a code first (Setup code → <b>Get a code for this board</b>) and re-enter it after the reload — codes last an hour, so for a lasting copy use <b>Show QR of current config</b> and keep the signage URL it leads to.</p>`;
  pane().querySelector('[data-beacon]').addEventListener('click', () => {
    state.cfg.beacon = !state.cfg.beacon;
    renderDiag();
  });
  pane().querySelector('[data-nerd]').addEventListener('click', () => {
    state.cfg.nerdMode = !state.cfg.nerdMode;
    renderDiag();
  });
  pane().querySelector('[data-reload]').addEventListener('click', () => location.reload());
  pane().querySelector('[data-displaytest]').addEventListener('click', showDisplayTest);
  // Two taps for the destructive button, the same arming the photo-album
  // and stream Remove buttons run: the first tap turns the button red
  // (.btn--armed) and relabels it, the second fires, and it disarms itself
  // after 4s if the user walks away. The armed label keeps its own verb and
  // noun — on a wall a passer-by has to be able to read what is about to
  // happen, and "Tap again to confirm" says only that something will.
  const confirmThen = (btn, armedLabel, action) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.armed) {
        await action();
        return;
      }
      btn.dataset.armed = '1';
      const original = btn.textContent;
      btn.textContent = armedLabel;
      btn.classList.add('btn--armed');
      setTimeout(() => {
        delete btn.dataset.armed;
        btn.textContent = original;
        btn.classList.remove('btn--armed');
      }, 4000);
    });
  };
  confirmThen(pane().querySelector('[data-clear]'), 'Tap again to clear web storage', async () => {
    window.localStorage.clear();
    location.reload();
  });
}
