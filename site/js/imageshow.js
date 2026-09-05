// Shared image surface: the in-card image (art, photos, landscapes, APOD), the
// full-screen viewer, and the ambient slideshow engine.  The viewer takes a
// pre-built photo list; callers are responsible for fetching/building that list
// before opening.
//
// One rule runs through all three: an image is never put on the glass until its
// bitmap is decoded.  Assigning a src to a visible <img> lets the engine paint
// the picture band by band as the bytes arrive — the "drawing in from the top"
// that made a rotating card yank the eye across the room.

import { escapeHtml } from './util.js';
import { isOverlayOpen, registerSurface, whileShown } from './surfaces.js';
import { markExpandable } from './card.js';
import { attachGesture } from './gesture.js';
import { stripData, stripHtml } from './ambient.js';
import { loadCache } from './store.js';

// Trimmed field read: whitespace-only is the same as absent for caption purposes
// (an iCloud/GDrive "caption" of " " must not conjure a caption box).
const field = (v) => (v == null ? '' : String(v).trim());

// Caption metadata line: artist [· year] for art; empty when absent (e.g. photos).
function captionMeta(item) {
  const artist = field(item.artist);
  if (!artist) return '';
  const year = field(item.year);
  return `${escapeHtml(artist)}${year ? ` · ${escapeHtml(year)}` : ''}`;
}

// Optional third caption line (APOD explanation); clamped in CSS. Empty when absent.
function captionDesc(item) {
  const desc = field(item.desc);
  return desc ? `<span class="slide-caption__desc">${escapeHtml(desc)}</span>` : '';
}

// Caption innards — only the lines that actually carry text. Returns '' when the
// item has no caption content at all, which is the signal callers use to skip the
// box entirely. Emitting empty <span>s instead would defeat the `:empty` CSS
// guard (an element with blank children is not `:empty`) and paint the padded
// background as a stray grey rectangle in the lower left — exactly what an
// untitled Landscapes/GDrive photo used to do.
export function captionHtml(item) {
  const title = field(item.title);
  const meta = captionMeta(item);
  const parts = [];
  if (title) parts.push(`<span class="slide-caption__title">${escapeHtml(title)}</span>`);
  if (meta) parts.push(`<span class="slide-caption__meta">${meta}</span>`);
  parts.push(captionDesc(item));
  return parts.filter(Boolean).join('');
}

// Ready-to-paint promise for an image.  decode() is the real guarantee (the
// bitmap exists before anything is shown); the load event is the fallback for
// engines without it.  Never rejects: a broken image resolves too, so a dead URL
// degrades to the same broken/alt state it always did instead of freezing the
// card on the previous photo for ever.
export function loadImage(img, src) {
  return new Promise((resolve) => {
    let settled = false;
    // Resolves `true` when a bitmap actually exists, `false` when it never
    // will (dead URL, 403 on an expired signed link). Never rejects — the
    // CALLER decides what a failure looks like, and for the in-card surface
    // the answer is "the card's own face", never the broken-image glyph
    // (which used to flash on every boot: the cached digest's signed Google
    // URL had expired overnight, errored, and was revealed anyway for the
    // ~1 s the healing fetch took — Sean saw it on boards and on a Mac).
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // Property handlers rather than addEventListener: this also runs against the
    // bare `Image` stubs the ambient/viewer tests install, which only fire onload.
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = src;
    // decode() only means anything once src is set. It rejects for a broken or
    // empty source, but ALSO (rarely) for a perfectly good bitmap under memory
    // pressure — naturalWidth is what separates the two, so a failed decode can
    // never block the swap of an image that did load.
    if (typeof img.decode === 'function') img.decode().then(() => done(true), () => done(img.naturalWidth > 0));
    else if (img.complete) done(true);
  });
}

// ---------- in-card image surface (art, photos, landscapes, APOD) ----------

// Cross-fade duration for a card swap.  The ambient screensaver dissolves over
// 2.5 s because it owns the whole 55" glass; a card is one small object on a
// busy board, so it takes the project's UI easing (ease-out
// cubic-bezier(0.22, 1, 0.36, 1)) stretched to 700 ms — long enough to read as a
// dissolve rather than a cut, short enough that it never becomes the thing you
// look at.  Mirrored in main.css; the timer below is only a cleanup net, so a
// few ms of drift between the two is harmless.
export const CARD_FADE_MS = 700;

const cardState = new WeakMap(); // .card__body → { src, caption, gen, open }

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

// Caption presence follows content, like the viewer's: a titleless photo gets no
// figcaption at all rather than an empty padded box.
function setFigCaption(fig, html) {
  let cap = fig.querySelector('.artwork__caption');
  if (!html) {
    cap?.remove();
    return;
  }
  if (!cap) {
    cap = document.createElement('figcaption');
    cap.className = 'artwork__caption';
    fig.appendChild(cap);
  }
  cap.innerHTML = html;
}

// Reveal a layer that was inserted transparent.  The forced layout read flushes
// opacity:0 as the transition's start value; without it the engine coalesces
// insert+unset into a single style pass and the fade never runs.
function enter(img) {
  void img.offsetWidth;
  img.classList.remove('is-entering');
}

// Dissolve `next` (already decoded, already stacked over `current`) in, then drop
// the outgoing layer so a card rotating 24/7 keeps exactly one <img> instead of
// accumulating one per photo.
function crossfade(current, next) {
  if (reducedMotion()) {
    next.classList.remove('is-entering');
    current.remove();
    return;
  }
  enter(next);
  let timer = 0;
  const done = () => {
    clearTimeout(timer);
    next.removeEventListener('transitionend', done);
    current.remove();
  };
  // transitionend is the accurate signal; the timer is the net for a transition
  // that never runs at all (card hidden, motion disabled in CSS, engine quirk).
  next.addEventListener('transitionend', done, { once: true });
  timer = setTimeout(done, CARD_FADE_MS + 150);
}

function paintImage(frame, src, alt, state) {
  const gen = ++state.gen; // a newer render wins; a stale load drops on arrival
  if (!src) {
    frame.replaceChildren();
    return;
  }
  const next = document.createElement('img');
  next.className = 'artwork__img is-entering';
  next.alt = alt;
  const current = frame.querySelector('.artwork__img');
  if (!current) {
    // First paint: the <img> joins the DOM immediately (callers and tests read
    // the markup synchronously) but stays transparent until its bitmap is ready,
    // so the card fades up from its own surface instead of drawing in bands.
    // A FAILED load stays invisible and comes out of the DOM: the glyph is
    // never the right pixel on a wall, and the usual cause heals itself —
    // boot renders the cached digest whose signed URL expired overnight, the
    // fresh fetch replaces it within a second. Forgetting state.src is what
    // arms the retry: the next 60 s render sees a "new" src and tries again
    // even when the URL text is identical (art/APOD URLs are stable).
    frame.appendChild(next);
    loadImage(next, src).then((ok) => {
      if (state.gen !== gen) return;
      if (ok) { enter(next); return; }
      next.remove();
      state.src = '';
    });
    return;
  }
  // Rotation: decode off-screen first and only then stack the new layer over the
  // old one.  Nothing half-drawn ever reaches the glass — and a photo that
  // FAILS to load never evicts the one the card already shows; the card keeps
  // what it has and the forgotten state.src retries the newcomer next tick.
  loadImage(next, src).then((ok) => {
    if (state.gen !== gen) return;
    if (!ok) {
      state.src = current.getAttribute('src') ?? '';
      return;
    }
    frame.appendChild(next);
    crossfade(current, next);
  });
}

// The card, not the figure, carries the tap handler — one per surface, added
// the first time the card is painted and never again. A WeakSet rather than a
// flag on the state object: the state is rebuilt whenever the scaffold is
// (an empty state, a setup prompt), and a rebuilt state must not buy a second
// listener on a card element that outlives all of them.
const tapWired = new WeakSet();

// Paints an image card in place: builds the .artwork scaffold once, then only
// touches what actually changed.  `caption` is trusted HTML (callers escape),
// '' means no caption box; `onOpen` is re-read on every tap, so a refreshed
// photo list or config is always what the full-screen viewer receives.
//
// The WHOLE CARD is the tap target (2026-08-01), the same grammar as weather
// and markets. The figure used to hold role="button" and the click listener,
// which made the picture tappable but left the title row and the padding
// around it dead: three tap models on one board, none of them labelled. The
// button semantics move up with the target, so an image card behaves like
// every other card that opens something. It draws no corner badge, because it
// counts nothing hidden (see util.js paintMoreBadge) and the picture is
// better off with the height a mark's reserve used to cost it.
export function renderImageCard(el, { src, alt = '', caption = '', label = 'View image full screen', contain = false, onOpen } = {}) {
  let state = cardState.get(el);
  let fig = el.querySelector('.artwork');
  if (!fig || !state) {
    // No scaffold yet, or the card was showing something else entirely (an
    // empty/setup state), so any remembered src is void.
    el.innerHTML = '<figure class="artwork"><div class="artwork__frame"></div></figure>';
    fig = el.querySelector('.artwork');
    state = { src: '', caption: null, gen: 0, open: null };
    cardState.set(el, state);
  }
  // No photo means nothing to open, so the card is neither tappable nor marked.
  // One condition feeds both, so the mark can never promise a view that the tap
  // would not actually give (an art manifest filtered down to nothing, a photo
  // album that came back empty).
  state.open = src ? onOpen ?? null : null;
  // `el` (the card body) is the stable key; the handler reads the live state
  // through it rather than closing over the object it was created beside.
  const target = el.closest?.('.card') ?? el;
  if (!tapWired.has(target)) {
    tapWired.add(target);
    target.addEventListener('click', () => {
      // One tap, one destination: a tap that lands here while something is
      // already full screen is that view's dismissal leaking through, never an
      // invitation to stack a second one.
      if (isOverlayOpen()) return;
      cardState.get(el)?.open?.();
    });
  }
  markExpandable(el, Boolean(state.open), { label });
  fig.classList.toggle('artwork--contain', contain);
  if (state.caption !== caption) {
    setFigCaption(fig, caption);
    state.caption = caption;
  }
  // The card re-renders every 60 s but the photo only changes when its rotation
  // bucket flips.  Re-creating the <img> for an unchanged URL would re-decode
  // and re-paint the same picture dozens of times an hour, on every image card.
  if (state.src === src) return;
  state.src = src;
  paintImage(fig.querySelector('.artwork__frame'), src, alt, state);
}

// This card is not showing a photo any more: an empty state, a setup prompt, a
// feed that came back with nothing. Both halves of the tap have to go, and this
// is why they are one call. The card-level listener stays wired (the card
// outlives every render and re-adding it would only stack duplicates), so
// nulling the destination is what actually disarms it — without this, a card
// that fell back to a setup prompt would still open the last photo it held,
// under a prompt whose own tap opens Settings.
export function clearImageCard(el) {
  const state = cardState.get(el);
  if (state) state.open = null;
  markExpandable(el, false);
}

let stripTimer = null;
let viewerList = null; // photo list for the open viewer session
let viewerCaption = true; // whether this session shows captions at all (chart: false)
let viewerIndex = -1;
let viewerGen = 0; // bumped per open; session identity for a deferred swipe
let viewerNav = 0; // bumped per navigation (swipe) and per open/close: a slow
                   // decode from an earlier swipe must not land after a later one
let userStepped = false; // guards against clobbering a swipe with deferred state

// Put the caption box where the content says it belongs: create it only when
// there is text to show, remove it the moment there isn't. Presence follows
// content, so swiping from a captioned artwork to an untitled photo can't
// strand an empty box, and swiping back brings the box straight back.
function renderViewerCaption(viewer, item) {
  const html = viewerCaption ? captionHtml(item) : '';
  let cap = viewer.querySelector('.slide-caption');
  if (!html) {
    cap?.remove();
    return;
  }
  if (!cap) {
    cap = document.createElement('div');
    cap.className = 'slide-caption';
    // Ahead of the info strip, which stays last (insertBefore(…, null) appends
    // when there is no strip, e.g. the chart viewer).
    viewer.insertBefore(cap, viewer.querySelector('.strip'));
  }
  cap.innerHTML = html;
}

// Built once below and thereafter toggled, so `hidden` is the signal.
registerSurface('art viewer', '#art-viewer', whileShown);

// Full-screen viewer: tap the dashboard card to open, tap anywhere to close,
// swipe left/right to browse the supplied photo list.  Shows the ambient info
// strip so the clock stays visible.  Stays up indefinitely (mode changes don't
// touch it).  strip:false suppresses the info band — used by the chart viewer,
// where the band would cover chart content and the view is short-lived anyway.
// fit is the widget's own screensaver fit (config.js imageFit): 'contain'
// letterboxes, 'cover' fills the glass and crops.
export function openImageViewer(current, cfg, { list = [], caption = true, strip = true, fit = 'contain' } = {}) {
  // Reset session state synchronously. The nav bump supersedes any swipe from a
  // previous session whose decode is still in flight, so it cannot paint over
  // the album just opened.
  ++viewerGen;
  ++viewerNav;
  userStepped = false;
  let viewer = document.querySelector('#art-viewer');
  if (!viewer) {
    viewer = document.createElement('div');
    viewer.id = 'art-viewer';
    viewer.className = 'art-viewer';
    // Close on tap, navigate on swipe.  The trailing click is classified by
    // its own coordinates against the gesture origin — no suppression state,
    // so a swipe that never produces a click can't swallow the next tap.
    //
    // This surface used to keep a bare pair of coordinates with no notion of
    // whose finger they belonged to, which on a 55" panel is the one place that
    // really matters: a palm resting on the glass beside the photo moved the
    // origin under the gesture already in flight. The shared record
    // (gesture.js) only lets the first pointer of a gesture set it.
    attachGesture(viewer, {
      onNext: () => step(viewer, 1),
      onPrev: () => step(viewer, -1),
      onTap: () => {
        viewer.hidden = true;
        clearInterval(stripTimer);
        viewerList = null; // release the album; reopen passes a fresh list
        ++viewerNav; // a swipe still decoding when the viewer closes is void
      },
    });
    document.body.appendChild(viewer);
  }
  // Per-open, not per-element: the shared viewer is reused by every image card.
  viewer.classList.toggle('art-viewer--fill', fit === 'cover');
  viewer.innerHTML = `
    <img class="art-viewer__img" src="${escapeHtml(current.img)}" alt="${escapeHtml(current.title ?? '')}">
    ${strip ? '<div class="strip"></div>' : ''}`;
  viewerCaption = caption;
  renderViewerCaption(viewer, current);
  const stripEl = viewer.querySelector('.strip');
  clearInterval(stripTimer);
  stripTimer = null;
  if (stripEl) {
    const refreshStrip = () => {
      const caches = {};
      for (const id of ['weather', 'lirr', 'mnr', 'njt']) caches[id] = loadCache(id)?.data;
      stripEl.innerHTML = stripHtml(stripData(caches, cfg ?? { widgets: [] }), new Date());
    };
    refreshStrip();
    stripTimer = setInterval(refreshStrip, 30 * 1000);
  }
  // Seed the session list synchronously — no fetch here; callers pass the list.
  viewerList = Array.isArray(list) ? list : [];
  viewerIndex = viewerList.findIndex((a) => a.img === current.img);
  viewer.hidden = false;
  warmNeighbors();
}

// THE swipe grammar for every photo surface — viewer, photo screensaver,
// clock backdrop — on every device (Sean's final call, felt on the glass:
// calm beats directional). Fade the existing layer down to the dark base,
// swap while invisible, rise like the initial load. One opacity animation, no
// ghost, no new layer — nothing is ever rastered while visible, so the
// weakest panel cannot flash. The fade-out starting on the gesture IS the
// acknowledgment; `ready` (the decode) rides inside the dark beat and extends
// it when the network is slow rather than ever showing a half-ready photo.
// Reduced motion swaps plainly. Auto rotations everywhere keep their slow
// dissolves; this is only ever a gesture's answer.
export const SWIPE_OUT_MS = 350;
export function swipeFadeThrough(el, ready, apply) {
  if (reducedMotion()) { Promise.resolve(ready).then(apply); return; }
  // Release the mount animation (backdrop-in) before touching opacity: a
  // FILLED keyframe animation outranks inline styles in the cascade, which
  // made the first cut of this fade a silent no-op on every device (the swipe
  // just swapped instantly — Sean caught it on a Navigator, 2026-07-31). The
  // CSS fill-mode is also 'backwards' now; this line guards the cascade even
  // if some future animation lands on the element.
  el.style.animation = 'none';
  el.style.transition = `opacity ${SWIPE_OUT_MS}ms ease-out`;
  el.style.opacity = '0';
  const dark = new Promise((r) => setTimeout(r, SWIPE_OUT_MS + 30));
  Promise.all([ready, dark]).then(() => {
    apply();
    void el.offsetWidth; // flush the dark frame, so the rise starts from 0
    el.style.transition = 'opacity 600ms ease-out'; // the unhurried half, like backdrop-in
    el.style.opacity = '';
    setTimeout(() => { el.style.transition = ''; }, 650);
  });
}

function step(viewer, dir) {
  if (!viewerList?.length) return;
  userStepped = true;
  viewerIndex = (viewerIndex + dir + viewerList.length) % viewerList.length;
  const item = viewerList[viewerIndex];
  const imgEl = viewer.querySelector('.art-viewer__img');
  // Captured before the decode: a swipe toward B that loads slowly must not
  // land after a later swipe toward C already did, and neither may paint over a
  // viewer that has since closed or reopened onto another album. The session
  // (viewerGen), the latest navigation (viewerNav), the viewer still being up,
  // and imgEl still being the live image all have to hold before the swap.
  const gen = viewerGen;
  const nav = ++viewerNav;
  // The one swipe grammar (swipeFadeThrough): the photo dims at the gesture,
  // the src/caption swap happens in the dark, and the new photo rises. The
  // decode rides the dark beat; neighbors are pre-warmed so it rarely waits.
  swipeFadeThrough(imgEl, loadImage(new Image(), item.img), () => {
    if (gen !== viewerGen || nav !== viewerNav || viewer.hidden) return;
    if (viewer.querySelector('.art-viewer__img') !== imgEl) return;
    imgEl.src = item.img;
    imgEl.alt = item.title ?? '';
    renderViewerCaption(viewer, item);
    warmNeighbors();
  });
}

// Decode the swipe targets ahead of the gesture, so the transition starts the
// moment the finger lifts instead of after a network round trip — the gap
// that makes people doubt the swipe registered and swipe again.
function warmNeighbors() {
  if (!viewerList?.length || viewerList.length < 2) return;
  for (const d of [1, -1]) {
    const n = viewerList[(viewerIndex + d + viewerList.length) % viewerList.length];
    if (n) loadImage(new Image(), n.img);
  }
}

// Ambient slideshow engine: two stacked layers, crossfade via [data-active].
// deps.now/random are injectable for tests.
export function createSlideshow(manifest, host, { intervalMs = 75000, random = Math.random, fit = 'contain' } = {}) {
  let order = shuffle([...manifest.keys()], random);
  let pos = 0;
  let timer = null;
  let active = 0;
  let stopped = false;

  host.innerHTML = `
    <div class="slide" data-layer="0"></div>
    <div class="slide" data-layer="1"></div>
    <div class="slide-caption"></div>`;
  const layers = [...host.querySelectorAll('.slide')];
  const caption = host.querySelector('.slide-caption');

  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function itemAt(p) {
    if (p >= order.length) {
      order = shuffle(order, random);
      pos = 0;
    }
    return manifest[order[pos]];
  }

  function show(item, instant = false) {
    const next = layers[1 - active];
    const out = layers[active];
    // A swiped change flips INSTANTLY — it happens in the dark, mid
    // swipeFadeThrough, where a dissolve would only bleed the old photo into
    // the rise. The auto advance keeps the slow dissolve (no class).
    next.classList.toggle('slide--cut', instant);
    out.classList.toggle('slide--cut', instant);
    next.style.backgroundImage = `url("${item.img}")`;
    // Fit mode. 'contain' letterboxes on black — art and personal photos are
    // never cropped and look the same in ambient as when tapped into (the
    // full-screen viewer is object-fit:contain too). 'cover' fills the viewport
    // and crops, for curated photo sources (e.g. Landscapes) that are meant to
    // fill the screen edge-to-edge.
    next.style.backgroundSize = fit;
    next.setAttribute('data-active', '');
    layers[active].removeAttribute('data-active');
    active = 1 - active;
    // Only the pieces that exist — a titleless photo (common for GDrive folders)
    // leaves this element with no children at all, which `:empty` hides so the
    // padded background box never shows as a stray grey rectangle.
    caption.innerHTML = captionHtml(item);
  }

  // Decode before the crossfade starts, so the incoming layer is a finished
  // picture the moment it becomes visible (a broken URL resolves too; the
  // background-image will retry).
  function preload(item, done) {
    loadImage(new Image(), item.img).then(() => done());
  }

  function advance() {
    if (stopped) return;
    const item = itemAt(pos);
    pos += 1;
    preload(item, () => {
      // stop() during an in-flight preload must not resurrect the loop: the
      // pending onload/onerror would otherwise schedule an uncancellable chain.
      if (stopped) return;
      show(item);
      timer = setTimeout(() => advance(), intervalMs);
    });
  }

  return {
    start() {
      if (!manifest.length) return;
      stopped = false;
      advance();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    // Manual navigation (ambient swipe): the whole stage fades through dark
    // (swipeFadeThrough) with the layer flip happening invisibly, next picks
    // the natural advance's item, prev re-shows the previously shown one.
    // Both reset the auto-advance cadence so a swipe isn't followed moments
    // later by a scheduled change.
    step(dir) {
      if (stopped || !manifest.length) return;
      clearTimeout(timer);
      let item;
      if (dir > 0) {
        item = itemAt(pos);
        pos += 1;
      } else {
        pos = (pos - 2 + order.length) % order.length;
        item = manifest[order[pos]];
        pos += 1;
      }
      const ready = new Promise((res) => preload(item, res));
      swipeFadeThrough(host, ready, () => {
        if (stopped) return;
        show(item, true);
        timer = setTimeout(() => advance(), intervalMs);
      });
    },
    current() {
      return manifest[order[Math.max(pos - 1, 0)]] ?? null;
    },
  };
}
