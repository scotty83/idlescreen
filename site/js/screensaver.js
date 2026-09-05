// The ambient engine: what the board shows when it is not showing the
// dashboard. Backdrop or slideshow or clock face, the info strip's place on the
// screen, the daily pick and its midnight rollover, and the swipe that steps
// ahead of schedule (CONTEXT.md: ambient mode, backdrop, ambient strip).
//
// main.js decides WHICH mode applies, because that is policy (modes.js, plus
// the ?mode= override) and it belongs with the boot script that owns the config
// and the schedule. Everything the ambient screen then DOES is here. It lived
// inline in main.js, which meant seven of the boot script's module-level
// variables, three concurrency guards and a teardown ladder sat among the
// widget registry and the rest of the boot script's bookkeeping, and the only
// way to ask "are we ambient?" from anywhere else was to read a class off
// <body>.
//
// The mode is still published as body.mode-ambient, because main.css branches
// on it, but the write happens in exactly one place below and every reader in
// JS asks isAmbient() instead.
//
// Two content lookups are injected rather than imported (initScreensaver): the
// photo manifest for a source and the backdrop folder. Both are boot-script
// knowledge (the demo fixtures, the photo widgets' own album resolution, the
// art manifest), and injecting them keeps the widget modules out of the
// lifecycle and lets a test drive the engine with three photos and no network.

import { CURATED_SOURCES, imageFit } from './config.js';
import { ambientSource } from './modes.js';
import { createSlideshow, swipeFadeThrough, loadImage } from './imageshow.js';
import { startClockFace, CLOCK_SOURCES } from './clockfaces.js';
import { attachGesture } from './gesture.js';
import { registerSurface, whileShown } from './surfaces.js';
import { backdropDayIndex, localDayNumber } from './curated.js';

const $ = (sel) => document.querySelector(sel);

// Ambient signs the surfaces register too, and it is the one that needed an
// argument. isAmbient() below stays exactly as it is: the MODE is policy, and
// it answers a different question, "should this widget be doing work at all".
// The register answers a question about the screen, and ambient covers the
// screen as completely as any tap-opened view. Leaving it out would mean
// writing "is anything full screen, other than the screensaver" wherever the
// plain question was wanted, which is precisely how the old three-id allow-list
// came to be wrong. Nothing about tap handling changes by signing: setMode
// hides #grid outright, so there are no card taps to guard while ambient is up,
// and a tap that somehow leaked through should not open a card behind the
// screensaver anyway. #ambient ships hidden in index.html and setMode is the
// one writer, so `hidden` is the same live signal the overlays give.
registerSurface('ambient', '#ambient', whileShown);

let ambient = false; // the published mode: what isAmbient() answers
let source = null; // the ambient source in force, for step() and the minute re-runs
let slideshow = null;
let clockface = null; // minute-tick clock screensaver engine (clockfaces.js)
let slideshowStarting = false; // guards the await gap in startSlideshow
// Slideshow lifecycle generation, bumped whenever the board leaves ambient or
// the ambient source changes. startSlideshow captures it before awaiting the
// manifest; a resolution whose generation is stale must not build an engine
// behind the dashboard or install a source the board has since moved off.
let slideshowGen = 0;
// Signed-URL sources (iCloud, Google Drive) hand out links that expire after a
// few hours; the other sources (art, curated folders) carry stable URLs. Only
// the signed ones need their manifest renewed while a screensaver runs for hours.
const SIGNED_SOURCES = new Set(['photos', 'gdrivephotos']);
const MANIFEST_TTL_MS = 20 * 60 * 1000; // renew a signed manifest about this often
let manifestAt = 0; // when the running slideshow's manifest was last resolved
let manifestRefreshing = false; // guards the await gap in refreshManifest
let backdropGen = 0; // guards the await gap in applyBackdrop (mode can flip mid-fetch)
let backdropList = []; // full curated backdrop set, for swipe-to-next
let backdropIndex = 0; // which backdrop is showing (starts at the daily pick)
let backdropDay = 0; // local day the index was computed for (rollover detection)

let photosFor = async () => [];
let backdropsFor = async () => [];
let swipeHost = null; // the element the swipe is wired to, so it is wired once

// `photos(src)` answers with the slideshow manifest for an ambient source and
// `backdrops()` with the clock-backdrop set, both for the config the boot
// script is holding (which owns it, and replaces it wholesale on every save).
// Either may reject, and a rejection is treated as "nothing to show" rather
// than as a broken screensaver.
//
// This also wires the swipe, so it needs the ambient DOM to exist: main.js
// calls it as top-level setup, where the two hand-rolled swipe handlers used to
// sit.
export function initScreensaver({ photos, backdrops } = {}) {
  if (photos) photosFor = photos;
  if (backdrops) backdropsFor = backdrops;
  // Swipe ahead of schedule, wired once on the ambient container. The photo
  // slideshow and the clock backdrop used to keep one verbatim-twin handler
  // each; #slideshow lives INSIDE #ambient, so the container's handler already
  // saw every swipe over both, and the backdrop copy was inert during a
  // slideshow anyway (its no-op guard). One handler, one router (step).
  const host = $('#ambient');
  if (host && host !== swipeHost) {
    swipeHost = host;
    attachGesture(host, { onNext: () => step(1), onPrev: () => step(-1) });
  }
}

// Is the board in ambient mode? The question renderStrip and the video widget
// ask before doing work that only makes sense behind (or in front of) the
// screensaver.
export function isAmbient() {
  return ambient;
}

// The mode main.js decided, applied to the screen.
//
// Idempotent on purpose, because it is called more than once for the same
// answer: once directly at boot, once more from the scheduler's immediate first
// tick, and on every minute after that (a schedule window opens or closes on a
// minute boundary, and the ambient half has upkeep of its own to do on that
// same cadence: the daily backdrop pick rolls over at local midnight, and an
// album that came back empty is retried). Every step below is therefore either
// a no-op when nothing changed or guarded against running twice.
export function setMode(mode, cfg) {
  const prevSource = source;
  source = ambientSource(cfg);
  ambient = mode === 'ambient' && source !== null;
  // A source swap invalidates any slideshow still starting for the old one; the
  // leave() below covers dropping out of ambient entirely.
  if (source !== prevSource) slideshowGen++;
  document.body.classList.toggle('mode-ambient', ambient);
  // Clock faces reserve extra bottom space when the info strip is showing, so a
  // wrapped (two-row) world-clock grid centers above the strip instead of
  // colliding with it.
  document.body.classList.toggle('has-strip', ambient && cfg.screensaver?.strip !== false);
  $('#ambient').hidden = !ambient;
  $('#grid').hidden = ambient;
  if (ambient) enter(cfg);
  else leave();
}

function enter(cfg) {
  const isClock = CLOCK_SOURCES.has(source);
  $('#slideshow').hidden = isClock;
  $('#clockface').hidden = !isClock;
  $('#strip').hidden = cfg.screensaver?.strip === false;
  if (isClock) {
    if (slideshow) { slideshow.stop(); slideshow = null; }
    clockface ??= startClockFace($('#clockface'), source, cfg);
    applyBackdrop(cfg.screensaver?.backdrop === true);
  } else {
    if (clockface) { clockface.stop(); clockface = null; }
    applyBackdrop(false); // photo slideshows own the full screen themselves
    startSlideshow(cfg);
  }
}

// Everything the ambient screen was running, stopped. The clock face's minute
// timer would otherwise keep repainting a hidden element until the nightly
// reload, and the backdrop's generation bump abandons any folder fetch still in
// flight so it cannot paint over the dashboard when it lands.
function leave() {
  slideshowGen++; // a manifest still resolving must not start a slideshow now
  if (slideshow) { slideshow.stop(); slideshow = null; }
  if (clockface) { clockface.stop(); clockface = null; }
  applyBackdrop(false);
}

async function startSlideshow(cfg) {
  // `slideshow` is only assigned after the manifest await, so two near-
  // simultaneous calls (setMode runs once directly + once from schedule's
  // immediate first tick) would both pass a `slideshow`-only guard and spawn a
  // second, un-stoppable engine. The synchronous in-flight flag closes that gap.
  // Already running: the per-minute setMode re-entry is the cadence a signed
  // manifest renews on, so a screensaver up for hours keeps live URLs instead of
  // freezing on expired ones until the nightly reload.
  if (slideshow) { refreshManifest(); return; }
  if (slideshowStarting) return;
  slideshowStarting = true;
  try {
    const src = source;
    const bornGen = slideshowGen;
    const manifest = await photosFor(src);
    // The await is a gap the schedule can drive through: the board may have gone
    // to the dashboard, or switched sources, while the album was fetching. Only
    // build the engine if the world it was started for is still the one in force.
    if (!ambient || source !== src || slideshowGen !== bornGen) return;
    if (!manifest?.length) return; // don't lock an empty slideshow; retry next setMode
    // Each ambient source owns its interval: the chosen photo widget's every for
    // its slideshow, the curated source's user rotation (its own default), art's
    // every for art (art's setting used to leak into photos).
    const everyMin = (src === 'photos' ? cfg.photos?.every
      : src === 'gdrivephotos' ? cfg.gdrivephotos?.every
      : CURATED_SOURCES[src] ? (cfg[src]?.every ?? CURATED_SOURCES[src].every)
      : cfg.art?.every) ?? 30;
    // Curated photo sources (Landscapes) fill the screen; art/personal photos
    // letterbox to never crop the canvas. Same rule the tapped-open viewer asks.
    const fit = imageFit(src);
    slideshow = createSlideshow(manifest, $('#slideshow'), {
      intervalMs: everyMin * 60 * 1000, fit,
      // A dead photo (expired signed link) renews the whole manifest at once,
      // rather than waiting out the 20-minute cadence with more dead links.
      onImageError: () => refreshManifest({ force: true }),
    });
    slideshow.start();
    manifestAt = Date.now();
  } catch (err) { console.error('[signage] slideshow unavailable', err); }
  finally { slideshowStarting = false; }
}

// Renew the running slideshow's manifest with fresh signed URLs. Signed sources
// only (art/curated links do not expire); bounded to MANIFEST_TTL_MS unless an
// image failure forces it. The same lifecycle-generation and source rechecks as
// startSlideshow guard the await gap, so a refresh that lands after the board
// left ambient or switched sources is dropped.
async function refreshManifest({ force = false } = {}) {
  if (!slideshow || !SIGNED_SOURCES.has(source) || manifestRefreshing) return;
  if (!force && Date.now() - manifestAt < MANIFEST_TTL_MS) return;
  manifestRefreshing = true;
  const src = source;
  const bornGen = slideshowGen;
  try {
    const next = await photosFor(src);
    if (!slideshow || source !== src || slideshowGen !== bornGen) return;
    if (next?.length) {
      slideshow.updateManifest(next);
      manifestAt = Date.now();
    }
  } catch (err) { console.error('[signage] manifest refresh failed', err); }
  finally { manifestRefreshing = false; }
}

// CSS url() escaping for externally-sourced image URLs: quotes and backslashes
// would otherwise terminate the url string (style-injection surface).
const cssUrl = (u) => `url("${String(u).replaceAll('\\', '%5C').replaceAll('"', '%22')}")`;

// Paints the current backdrop image into #backdrop.
function showBackdrop() {
  const el = $('#backdrop');
  el.style.backgroundImage = cssUrl(backdropList[backdropIndex].img);
  el.hidden = false;
}

// Swipe ahead of schedule: step to the next/prev backdrop. No-ops unless a clock
// backdrop is currently showing, so it's safe to wire to the whole ambient area.
// Preload before swapping (the slideshow's step() pattern) so the swipe never
// flashes the fallback background while the next image streams in.
function stepBackdrop(dir) {
  if (backdropList.length < 2 || $('#backdrop').hidden) return;
  backdropIndex = (backdropIndex + dir + backdropList.length) % backdropList.length;
  // Fade-to-dark, swap, fade back — the initial-load grammar on every device
  // (see swipeFadeThrough). The fade-out starts NOW as the acknowledgment;
  // the decode (loadImage: decode-gated, never rejects) rides the dark beat.
  swipeFadeThrough($('#backdrop'), loadImage(new Image(), backdropList[backdropIndex].img), showBackdrop);
}

// One picture forward or back, whichever surface is showing. A photo slideshow
// steps itself; over a clock face there is no slideshow at all (it is stopped
// and dropped when the face goes up), so the swipe belongs to the backdrop.
export function step(dir) {
  if (slideshow) { slideshow.step(dir); return; }
  stepBackdrop(dir);
}

// Shows/hides the daily photo behind a clock face. Async (folder fetch), so a
// generation guard drops a stale result if the mode flips mid-fetch. Loads the
// full set (for swipe-to-next) and opens on the day's deterministic pick. body's
// .ss-backdrop class drives the clock's legibility treatment (text-shadow +
// dial discs); a failed/empty fetch falls back to the plain dark background.
async function applyBackdrop(on) {
  const el = $('#backdrop');
  const gen = ++backdropGen;
  if (!on) { el.hidden = true; el.style.backgroundImage = ''; document.body.classList.remove('ss-backdrop'); backdropList = []; return; }
  if (backdropList.length) {
    // Already loaded; keep the shown image — EXCEPT across local midnight.
    // Screensaver stretches span midnight (scheduled boards are ambient all
    // night), so the daily rotation must advance here, not only on a reload.
    // A new day also supersedes yesterday's manual swipe.
    const day = localDayNumber(new Date());
    if (day !== backdropDay) {
      backdropDay = day;
      backdropIndex = backdropDayIndex(new Date(), backdropList.length);
    }
    document.body.classList.add('ss-backdrop');
    showBackdrop();
    return;
  }
  try {
    const list = await backdropsFor();
    if (gen !== backdropGen) return; // mode changed while fetching — abandon
    if (!list.length) { el.hidden = true; document.body.classList.remove('ss-backdrop'); return; }
    backdropList = list;
    backdropDay = localDayNumber(new Date());
    backdropIndex = backdropDayIndex(new Date(), list.length);
    document.body.classList.add('ss-backdrop');
    showBackdrop();
  } catch (err) {
    if (gen !== backdropGen) return;
    console.error('[signage] backdrop unavailable', err);
    el.hidden = true;
    document.body.classList.remove('ss-backdrop');
  }
}
