// Boot and runtime orchestration for the signage dashboard.

import { normalizeConfig, decodeConfig, CURATED_SOURCES } from './config.js';
import { loadConfig, saveConfig, loadCache, saveCache, cacheStampFor, cacheAgeOf, cacheFingerprint, takePendingEdit, applyConfig, isDemoSession } from './store.js';
import { fetchJSON, fetchBuffer, fetchText } from './net.js';
import { fitViewport, narrowViewportToGlass } from './util.js';
import { cardFor, markFresh, markStale, setCardConfigSource } from './card.js';
import { blockZoomGestures } from './zoomguard.js';
import { schedule } from './scheduler.js';
import { resolveMode, ambientSource } from './modes.js';
import { chooseBootConfig, fragmentConfig } from './boot.js';
import { stripData, stripHtml } from './ambient.js';
import { initScreensaver, setMode, isAmbient } from './screensaver.js';
import { startBeacon, reportWidgetHealth } from './fleet.js';
import { initTextViewer } from './textviewer.js';
import { initExpand } from './expand.js';
import { CLOCK_SOURCES } from './clockfaces.js';
import { icon } from './icons.js';
import { ensureOceanProbe } from './surf-gate.js';
import { trackTittle } from './tittle-probe.js';

import * as clock from './widgets/clock.js';
import * as weather from './widgets/weather.js';
import * as subway from './widgets/subway.js';
import * as lirr from './widgets/lirr.js';
import * as mnr from './widgets/mnr.js';
import * as bus from './widgets/bus.js';
import * as njt from './widgets/njt.js';
import * as amtrak from './widgets/amtrak.js';
import * as pathw from './widgets/path.js';
import * as ferry from './widgets/ferry.js';
import * as art from './widgets/art.js';
import * as history from './widgets/history.js';
import * as aqi from './widgets/aqi.js';
import * as surf from './widgets/surf.js';
import * as quote from './widgets/quote.js';
import * as wotd from './widgets/wotd.js';
import * as markets from './widgets/markets.js';
import * as marketsnews from './widgets/marketsnews.js';
import * as worldclock from './widgets/worldclock.js';
import * as sports from './widgets/sports.js';
import * as sportsnews from './widgets/sportsnews.js';
import * as f1 from './widgets/f1.js';
import * as golf from './widgets/golf.js';
import * as tennis from './widgets/tennis.js';
import * as iptv from './widgets/iptv.js';
import * as news from './widgets/news.js';
import * as substack from './widgets/substack.js';
import * as bsky from './widgets/bsky.js';
import * as photos from './widgets/photos.js';
import * as gdrivephotos from './widgets/gdrivephotos.js';
import * as landscapes from './widgets/landscapes.js';
import * as services from './widgets/services.js';
import * as apod from './widgets/apod.js';
import * as chart from './widgets/chart.js';
import * as citibike from './widgets/citibike.js';
import * as tfl from './widgets/tfl.js';
import { resolvePhotosManifest } from './photos-manifest.js';
import { fetchCuratedManifest, fetchBackdropList } from './curated.js';

// Every widget module the board can run, and the id lookup the layout walks to
// find one. This used to be registry.js: a module-level Map, a register loop, a
// getter, plus an activeWidgets() and a clearRegistry() that no production code
// ever called. The Map is one line here and nothing outside this file wanted
// it: a widget is reached through the layout, never by asking a registry. That
// this list names exactly the catalogue's ids is pinned by test/shell.test.js.
const MODULES = [weather, subway, lirr, mnr, njt, amtrak, pathw, ferry, bus, art, history, aqi, surf, quote, wotd, markets, marketsnews, worldclock, sports, sportsnews, news, substack, bsky, photos, gdrivephotos, landscapes, services, apod, chart, citibike, tfl, f1, golf, tennis, iptv];
const BY_ID = new Map(MODULES.map((m) => [m.meta.id, m]));
const getWidget = (id) => BY_ID.get(id) ?? null;

const net = { fetchJSON, fetchBuffer, fetchText };
const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
// Asked of store.js rather than re-derived here: it is the same question the
// save path asks before it refuses to persist, and two spellings of "is this a
// demo?" is exactly how the save path came to have one answer and Settings the
// other.
const DEMO = isDemoSession();

// The demo fixtures are a 33 KB module (the 3rd-largest thing in the boot
// graph) that only ?demo=1 ever reads. A static import shipped and parsed them
// on every production board, so they load on demand instead — once per session,
// awaited before any demo path renders, after which `fixtures` reads
// synchronously. No top-level await: boot semantics are unchanged.
let fixtures = null;
let fixturesPromise = null;
const loadFixtures = () =>
  (fixturesPromise ??= import('../demo/fixtures.js').then((m) => (fixtures = m)));

// Bring the page into agreement with the glass on smaller RoomOS panels (Cisco
// Room Navigator): first the layout viewport, so the full-bleed overlays are the
// screen, then the 1920x1080 layout itself, scaled down to fit inside it. Both
// no-ops on the Board Pro. See util.js for why each one exists.
const refit = () => { narrowViewportToGlass(); fitViewport(); };
refit();
window.addEventListener('resize', refit);
// The visual viewport can change WITHOUT a window resize, and that is the whole
// failure being guarded here: an engine that picks its own page scale shrinks
// the glass while the layout viewport sits still, so `resize` never fires.
// Optional chaining because happy-dom and older engines may not carry the
// object at all.
window.visualViewport?.addEventListener('resize', refit);

// …and having sized the page for the device, refuse to let anyone resize it by
// hand. An accidental pinch on a board zoomed the dashboard to ~200% and the
// zoom survived the reload that Save does, so the board sat unusable until
// someone undid it by hand. The touch gesture is refused in main.css
// (`touch-action` on the root); this covers the pointer paths, which CSS has no
// say over. See zoomguard.js for the full account.
blockZoomGestures(window);

let cfg = null;
// card.js reads the config it needs (the stamp's 12/24-hour format, the section
// an unconfigured card taps into) through this getter rather than a copy, since
// every save REPLACES cfg with a fresh object.
setCardConfigSource(() => cfg);
// Liveness heartbeat for the watchdog: bumped on every clock tick, NOT on
// widget freshness. A board showing only stale data (upstream outage) or only
// daily-refresh widgets is still alive — the clock proves the page isn't
// wedged, so it must not trigger a reload loop.
let lastRender = Date.now();
const cancels = [];

function renderWidget(mod, vm, rect) {
  const card = cardFor(mod, rect);
  try {
    mod.render(card.querySelector('.card__body'), vm, cfg);
  } catch (err) {
    console.error(`[signage] render failed: ${mod.meta.id}`, err);
  }
}

// Boot fetch herd: every card used to open its first connection in the same
// tick — ~20 requests across ~7 hosts at once on gen1's embedded stack, which
// queues them anyway and delays the cards at the back of the line. Each widget
// gets its own small slot instead. Cached content still paints immediately
// (below, before the schedule), and the last card's first fetch starts well
// inside 2 s, so the board is populated as fast as it ever was.
const BOOT_STAGGER_STEP_MS = 120;
const BOOT_STAGGER_MAX_MS = 1800;

function startWidget(mod, rect, startDelayMs = 0) {
  const card = cardFor(mod, rect);
  // The fetch-input fingerprint for THIS config: a module that declares no
  // inputs (meta.cacheInputs absent) gets null and keeps the id-only behaviour;
  // one that does (photos, weather) only loads a cache its inputs match (F09).
  const fp = mod.meta.cacheInputs ? cacheFingerprint(mod.meta.cacheInputs(cfg)) : null;
  const cached = loadCache(mod.meta.id, fp);
  if (cached) {
    renderWidget(mod, cached.data);
    // The payload's own source time, not the moment it was written: a Worker
    // stale fallback must read as old as its data is (F10).
    markStale(card, cacheAgeOf(cached));
  }
  const cancel = schedule(async () => {
    try {
      const vm = await mod.fetchData(cfg, net);
      // Persist the payload's source age so a stale digest keeps its true "as
      // of" across a reload instead of being re-stamped to now (F10), stamped
      // with the inputs that produced it (F09).
      saveCache(mod.meta.id, vm, cacheStampFor(vm), fp);
      renderWidget(mod, vm);
      // A worker-served stale fallback (up to 24h old) must not read as fresh:
      // dim the card and stamp its age instead of clearing the stale mark.
      if (vm?.stale) markStale(card, vm.updatedAt);
      else markFresh(card);
      // Health vector (fleet.js): worker-served stale counts, fresh clears.
      reportWidgetHealth(mod.meta.id, vm?.stale ? 'stale' : null);
    } catch (err) {
      reportWidgetHealth(mod.meta.id, 'error');
      markStale(card, cacheAgeOf(loadCache(mod.meta.id, fp)));
      throw err; // let the scheduler back off
    }
  }, mod.meta.refreshMs, { startDelayMs });
  cancels.push(cancel);
}

function renderStrip() {
  // The strip only shows in ambient mode; skip the cache reads + DOM rebuild
  // on the 30 s schedule while the dashboard grid is up.
  if (!DEMO && !isAmbient()) return;
  if (cfg?.screensaver?.strip === false) return; // Screensaver page turned the band off
  const caches = {};
  // Same fingerprint gate as startWidget: a weather cache from the old location
  // must not feed the strip after a move (F09). Transit ids declare no inputs,
  // so they read as before.
  for (const id of ['weather', 'lirr', 'mnr', 'njt']) {
    const mod = getWidget(id);
    const fp = mod?.meta.cacheInputs ? cacheFingerprint(mod.meta.cacheInputs(cfg)) : null;
    caches[id] = loadCache(id, fp)?.data;
  }
  const data = DEMO && fixtures
    ? stripData(
        {
          weather: fixtures.DEMO_VMS.weather,
          lirr: fixtures.DEMO_VMS.lirr,
          mnr: fixtures.DEMO_VMS.mnr,
          njt: fixtures.DEMO_VMS.njt,
        },
        cfg,
        // The fixtures are frozen at DEMO_NOW_MS; stripData derives countdowns
        // from absolute times, so it needs the fixtures' own "now" or every demo
        // departure reads as long past and the strip goes quiet.
        { nowSec: Math.floor(fixtures.DEMO_NOW_MS / 1000) },
      )
    : stripData(caches, cfg);
  // The clock-face screensavers already show the time large; drop it from the
  // strip so it isn't printed twice.
  const showTime = !CLOCK_SOURCES.has(ambientSource(cfg));
  $('#strip').innerHTML = stripHtml(data, new Date(), { showTime });
}

// Which pictures the ambient slideshow shows for a given source. It stays in
// the boot script rather than moving into the engine because every branch of it
// is boot-script knowledge: the demo fixtures, the photo widgets' own album
// resolution, and the art manifest that ships with the site.
async function ambientPhotos(src) {
  if (DEMO) return [(await loadFixtures()).DEMO_VMS.art];
  if (src === 'photos') return resolvePhotosManifest(cfg, net, photos);
  if (src === 'gdrivephotos') return resolvePhotosManifest(cfg, net, gdrivephotos);
  if (CURATED_SOURCES[src]) return fetchCuratedManifest(src, net);
  return art.filterByCats(await fetchJSON('data/art-manifest.json'), cfg.art?.cats);
}

// The mode DECISION, which is all that is left here: the ?mode= override for
// the audit harness, otherwise modes.js policy against the clock. What the
// ambient screen then does is screensaver.js's, ladder and guards and all.
function applyMode() {
  const forced = params.get('mode');
  const mode = forced === 'ambient' || forced === 'dashboard' ? forced : resolveMode(cfg, new Date());
  setMode(mode, cfg);
  if (isAmbient()) renderStrip();
}

function startClock() {
  const tick = () => {
    clock.render($('#topbar'), null, cfg);
    lastRender = Date.now(); // heartbeat: the clock ticking proves the page is alive
  };
  tick();
  cancels.push(schedule(tick, clock.meta.refreshMs, { jitter: 0 }));
}

function showWelcome() {
  const welcome = $('#welcome');
  welcome.hidden = false;
  $('#grid').hidden = true;
  welcome.innerHTML = `
    <div class="welcome__inner">
      <!-- The welcome screen is the board's ONE brand moment: the only surface
           in the shell a stranger meets before the product is anything, and the
           only one that shows the wordmark at display scale. So this lockup
           spends the accent on the word's own power tittle, and the little SVG
           mark that used to sit beside it is GONE from here (it still leads
           every other shell lockup, and the icon masters are untouched).
           The rule it obeys is the one info.css writes out in full: THE ACCENT
           APPEARS ONCE PER SURFACE. A lit mark and a lit tittle side by side
           are two saturated things reading as decoration; one reads as a
           signal. Where a mark shares the surface the mark carries the accent
           and the word stays plain, which is why the settings rail's lockup
           and the guide's nav and footer never take this modifier. Here nothing
           shares the surface, so the word takes it and the mark leaves rather
           than compete. -->
      <div class="welcome__brand" aria-hidden="true">
        <span class="imark imark--led welcome__word"><span class="imark__idle">idle</span><span class="imark__screen">screen</span></span>
      </div>
      <h1>Welcome to your office display</h1>
      <p>Set it up from your phone or desktop, or start with sensible defaults and fine-tune later.</p>
      <div class="qr welcome__qr"></div>
      <p class="welcome__hint">Scan to build a setup code on your phone, or visit <b>${location.host}/setup</b>.</p>
      <div class="welcome__actions">
        <button class="btn btn--primary" data-action="enter-code">I have a setup code</button>
        <button class="btn" data-action="quick-start">Quick start</button>
      </div>
    </div>`;
  // The tittle's placement is a property of the face the BOARD rendered, which
  // is CiscoSansTT where it is installed and something else everywhere else, so
  // it is measured here rather than assumed. Feature-detected end to end: a
  // panel that cannot answer keeps the stylesheet's static placement.
  trackTittle(welcome.querySelector('.welcome__brand'));
  // The board's URL isn't visible to the person standing in front of it, so a
  // /setup hint alone can't get them there — the QR carries the full address.
  // Best-effort: if the QR module fails to load, the text hint still names the host.
  import('./vendor/qrcode.js')
    .then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(`https://${location.host}/setup`);
      qr.make();
      welcome.querySelector('.welcome__qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3 });
    })
    .catch(() => {});
  welcome.querySelector('[data-action="quick-start"]').addEventListener('click', async () => {
    const { QUICKSTART_CONFIG } = await import('./quickstart.js');
    cfg = normalizeConfig({ ...QUICKSTART_CONFIG, t: Math.floor(Date.now() / 1000) });
    // Best-effort: a storage-blocked kiosk must still start (config is held in
    // memory); a failed persist means it re-quick-starts next boot, not a stall.
    try { await saveConfig(cfg); } catch (e) { console.error('[boot] quick-start save failed', e); }
    welcome.hidden = true;
    $('#grid').hidden = false;
    startRuntime();
  });
  welcome.querySelector('[data-action="enter-code"]').addEventListener('click', async () => {
    const settings = await import('./settings/settings.js');
    settings.openSettings(cfg ?? normalizeConfig({}), { focus: 'code' });
  });
}

function startSelfHealing() {
  // Reload nightly at ~4 AM to pick up deploys and clear any memory creep.
  const now = new Date();
  const next4 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 0);
  if (next4 <= now) next4.setDate(next4.getDate() + 1);
  setTimeout(() => location.reload(), next4 - now);

  // Hourly version check → reload when the site is redeployed.
  let bootVersion = null;
  cancels.push(
    schedule(async () => {
      const v = await fetchJSON(`version.json?bust=${Date.now()}`);
      // Publish it rather than fetching version.json a third time: the colophon
      // of Settings' What's new pane states the running version, and this poll's
      // first run is a setTimeout(0), so it is populated within a tick of boot —
      // long before anyone reaches for the gear.
      if (window.__signage) window.__signage.version = v.version;
      if (bootVersion === null) bootVersion = v.version;
      else if (v.version !== bootVersion) location.reload();
    }, 60 * 60 * 1000),
  );

  // Watchdog: if nothing has rendered fresh data for 15 minutes while the
  // browser thinks it is online, reload the page.
  setInterval(() => {
    if (navigator.onLine !== false && Date.now() - lastRender > 15 * 60 * 1000) {
      location.reload();
    }
  }, 60 * 1000);
}

function startRuntime() {
  startClock();
  let slot = 0;
  for (const rect of cfg.layout) {
    const mod = getWidget(rect.id);
    if (mod) startWidget(mod, rect, Math.min(slot++ * BOOT_STAGGER_STEP_MS, BOOT_STAGGER_MAX_MS));
  }
  applyMode();
  cancels.push(schedule(applyMode, 60 * 1000, { jitter: 0 }));
  cancels.push(schedule(renderStrip, 30 * 1000, { jitter: 0 }));
  if (!DEMO) {
    startSelfHealing();
    cancels.push(startBeacon(() => cfg));
    // Ocean gate: keep the Surf card's add-picker verdict current for THIS
    // board's location, so the edit tray and the Settings widget list (both
    // opened later, from here) can answer synchronously the moment they render.
    // A board that already has the card placed re-earns the verdict out of the
    // widget's own refresh and needs no separate probe.
    if (!cfg.widgets.includes('surf')) ensureOceanProbe(cfg.loc, net);
  }
  // Settings → Widgets hands off to edit mode. When it had changes to save it
  // took the Save path, which reloads, so the intent arrives through storage
  // rather than a call (store.js takePendingEdit). Clicking the FAB rather than
  // importing edit.js keeps ONE entry path: the handler below owns the live cfg
  // and the save/sync/reload that Done needs.
  if (takePendingEdit()) $('#edit').click();
}

async function boot() {
  $('#gear').innerHTML = icon('settings', 'icon--btn');
  $('#edit').innerHTML = icon('pencil', 'icon--btn');
  initTextViewer($('#grid'));
  // Whole-card tap opens a card's hidden items full screen (markets today).
  // Delegated on the grid, so it survives every widget re-render.
  initExpand($('#grid'));
  const encodedCfg = fragmentConfig(location.hash);
  // Diagnostics surface: only what a person poking at a console (or the two
  // read-only lines in Settings) wants to see — how this board was configured
  // and what it is running. Working state stays out of it. The device bridge
  // and its vault status used to ride along here, which was already the wrong
  // shelf for something two save paths wrote through, and both are gone now
  // along with the back-channel itself.
  window.__signage = {
    fragment: { cfg: encodedCfg },
    source: null,
  };

  if (DEMO) {
    // Pull the fixtures in before anything below reads them: renderStrip and
    // applyMode both run synchronously off this branch.
    const { DEMO_VMS } = await loadFixtures();
    cfg = normalizeConfig({
      v: 3,
      name: 'User',
      mode: 'dashboard',
      layout: [
        { id: 'weather', x: 0, y: 0, w: 4, h: 4 },
        { id: 'subway', x: 4, y: 0, w: 4, h: 4 },
        { id: 'lirr', x: 8, y: 0, w: 4, h: 4 },
        { id: 'art', x: 0, y: 4, w: 2, h: 4 },
        { id: 'worldclock', x: 2, y: 4, w: 2, h: 4 },
        { id: 'history', x: 4, y: 4, w: 6, h: 2 },
        { id: 'quote', x: 4, y: 6, w: 6, h: 2 },
        { id: 'aqi', x: 10, y: 4, w: 2, h: 4 },
      ],
    });
    startClock();
    for (const rect of cfg.layout) {
      const mod = getWidget(rect.id);
      if (mod) renderWidget(mod, DEMO_VMS[mod.meta.id], rect);
    }
    applyMode();
    return;
  }

  let fragmentCfg = null;
  if (encodedCfg) {
    try {
      fragmentCfg = await decodeConfig(encodedCfg);
    } catch {
      fragmentCfg = null;
    }
  }
  const stored = await loadConfig();
  const { cfg: chosen, source } = chooseBootConfig(fragmentCfg, stored);
  window.__signage.source = source;

  if (!chosen) {
    showWelcome();
    return;
  }
  cfg = chosen;
  // Repair wiped storage from a decodable #fragment — but best-effort: on a
  // storage-blocked board this MUST NOT reject boot() (which reload-loops it).
  // The config is already in memory; a persist failure just re-repairs next boot.
  if (source === 'fragment') {
    try { await saveConfig(cfg); } catch (e) { console.error('[boot] config repair-save failed', e); }
  }
  startRuntime();
}

// Hand the ambient engine the two content lookups it does not own, and let it
// wire its own swipe. Top-level setup, where the swipe handlers themselves used
// to be: the ambient nodes are in index.html, so they exist by now.
initScreensaver({
  photos: ambientPhotos,
  backdrops: () => fetchBackdropList(net),
});

$('#gear').addEventListener('click', async () => {
  const settings = await import('./settings/settings.js');
  settings.openSettings(cfg ?? normalizeConfig({}), {});
});

$('#edit').addEventListener('click', async () => {
  if (!cfg) return;
  const { openEditMode } = await import('./edit.js');
  openEditMode(cfg, {
    async onDone(layout) {
      // Stamp, persist, mirror, reload: all of it is store.js's applyConfig now,
      // and this handler's only remaining job is saying WHICH config to apply.
      cfg = await applyConfig({ ...cfg, layout });
    },
  });
});

// Signal to bootguard.js (a classic script loaded ahead of this module) that the
// page's code is alive: every import resolved and all synchronous top-level
// setup above ran. This MUST stay the last top-level statement before boot() —
// a broken/stale import or a throw during setup then leaves the flag unset and
// the guard recovers. An async boot() failure past this point is handled by the
// catch below, not by the guard.
//
// How long the module graph took to load and run, read by the hourly beacon
// (js/fleet.js) and constant for the page's life. It is written HERE, one
// statement early, because this is the point the boot it measures is over.
window.__bootMs = Math.round(performance.now());
window.__signageLoaded = true;

// A boot crash means no runtime and therefore no watchdog — reload is the
// only recovery path on an unattended board.
boot().catch((err) => {
  console.error('[signage] boot failed', err);
  setTimeout(() => location.reload(), 60 * 1000);
});
