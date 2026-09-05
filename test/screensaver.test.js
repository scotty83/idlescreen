/**
 * @vitest-environment happy-dom
 *
 * The ambient engine, driven through its interface: main.js hands it a mode and
 * a config, and everything after that decision is its own. These are the parts
 * that used to be inline in the boot script and untestable there: the guard
 * that keeps two near-simultaneous enters from spawning a second slideshow, the
 * daily backdrop pick rolling over at local midnight, and the teardown that has
 * to stop a clock face still repainting a screen nobody can see.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initScreensaver, setMode, isAmbient } from '../site/js/screensaver.js';
import { SWIPE_OUT_MS } from '../site/js/imageshow.js';

const PHOTOS = [
  { img: 'https://x.test/p1.jpg', title: 'One' },
  { img: 'https://x.test/p2.jpg', title: 'Two' },
  { img: 'https://x.test/p3.jpg', title: 'Three' },
];

// Five, so a day-to-day step is unambiguous against the modulo.
const BACKDROPS = [1, 2, 3, 4, 5].map((n) => ({ img: `https://x.test/b${n}.jpg`, title: `B${n}` }));

const ART = { screensaver: { source: 'art', strip: true }, art: { every: 30 } };
const CLOCK = { screensaver: { source: 'clock', strip: true, backdrop: true } };
// Two distinct photo sources, for the lifecycle-generation guard: switching
// between them changes the ambient source while a manifest may be in flight.
const PHOTOS_CFG = { screensaver: { source: 'photos', strip: true }, photos: { album: 'A', every: 30 } };
const GDRIVE_CFG = { screensaver: { source: 'gdrivephotos', strip: true }, gdrivephotos: { album: 'B', every: 30 } };

// index.html's ambient nodes, which the engine addresses by id.
function mountBoard() {
  document.body.className = '';
  document.body.innerHTML = `
    <section id="grid"></section>
    <section id="ambient" hidden>
      <div id="backdrop" hidden></div>
      <div id="slideshow"></div>
      <div id="clockface" hidden></div>
      <div id="strip"></div>
    </section>`;
}

const $ = (sel) => document.querySelector(sel);
const bgOf = (el) => el.style.backgroundImage;

// Let every pending microtask (the manifest await, the decode) settle without
// moving the fake clock.
const flush = () => vi.advanceTimersByTimeAsync(0);

// A promise the test resolves when it chooses, for driving an await gap.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Image', class { set src(_v) { queueMicrotask(() => this.onload?.()); } });
  mountBoard();
});

afterEach(async () => {
  setMode('dashboard', ART); // release the engine's state between tests
  await flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('the mode the board is in', () => {
  it('flips with the mode it is handed, and publishes it once', async () => {
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => [] });
    expect(isAmbient()).toBe(false);

    setMode('ambient', ART);
    await flush();
    expect(isAmbient()).toBe(true);
    expect(document.body.classList.contains('mode-ambient')).toBe(true);
    expect($('#ambient').hidden).toBe(false);
    expect($('#grid').hidden).toBe(true);

    setMode('dashboard', ART);
    await flush();
    expect(isAmbient()).toBe(false);
    expect(document.body.classList.contains('mode-ambient')).toBe(false);
    expect($('#ambient').hidden).toBe(true);
    expect($('#grid').hidden).toBe(false);
  });

  it('is not ambient when the config has no ambient source to show', async () => {
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => [] });
    setMode('ambient', { screensaver: { source: 'off' } });
    await flush();
    expect(isAmbient()).toBe(false);
    expect($('#grid').hidden).toBe(false);
  });

  it('hides the strip, and the space reserved for it, when it is turned off', async () => {
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => [] });
    setMode('ambient', { screensaver: { source: 'art', strip: false } });
    await flush();
    expect($('#strip').hidden).toBe(true);
    expect(document.body.classList.contains('has-strip')).toBe(false);
  });
});

describe('the slideshow', () => {
  it('starts exactly one engine for two near-simultaneous enters', async () => {
    // The boot path calls setMode twice in the same tick (once directly, once
    // from the scheduler's immediate first tick), and `slideshow` is only
    // assigned after the manifest await. Without the in-flight flag both calls
    // pass the guard and the second engine can never be stopped.
    let asked = 0;
    const gate = deferred();
    initScreensaver({
      photos: async () => { asked++; await gate.promise; return PHOTOS; },
      backdrops: async () => [],
    });

    setMode('ambient', ART);
    setMode('ambient', ART);
    expect(asked).toBe(1);

    gate.resolve();
    await flush();
    expect($('#slideshow').querySelectorAll('.slide')).toHaveLength(2); // one engine's two layers
    expect(bgOf($('#slideshow .slide[data-active]'))).toContain('https://x.test/');

    setMode('ambient', ART); // and a later minute does not start another
    await flush();
    expect(asked).toBe(1);
  });

  it('does not lock an empty album: the next minute asks again', async () => {
    let asked = 0;
    let album = [];
    initScreensaver({ photos: async () => { asked++; return album; }, backdrops: async () => [] });

    setMode('ambient', ART);
    await flush();
    expect(asked).toBe(1);
    expect($('#slideshow').querySelectorAll('.slide')).toHaveLength(0);

    album = PHOTOS;
    setMode('ambient', ART);
    await flush();
    expect(asked).toBe(2);
    expect($('#slideshow').querySelectorAll('.slide')).toHaveLength(2);
  });

  it('a manifest that resolves after the board left ambient never starts a hidden slideshow', async () => {
    // A slow album fetch begins just before the schedule flips to dashboard; its
    // late response must not spin an engine and a rotation timer behind the grid.
    const gate = deferred();
    initScreensaver({
      photos: async () => { await gate.promise; return PHOTOS; },
      backdrops: async () => [],
    });

    setMode('ambient', ART);
    await flush();
    expect($('#slideshow').querySelectorAll('.slide')).toHaveLength(0); // still fetching

    setMode('dashboard', ART); // the schedule window opened while the album was in flight
    gate.resolve();
    await flush();
    expect(isAmbient()).toBe(false);
    expect($('#slideshow').querySelectorAll('.slide')).toHaveLength(0); // nothing spun up behind the grid
  });

  it('a manifest for a source the board has since left does not install that source', async () => {
    const gate = deferred();
    const served = [];
    initScreensaver({
      photos: async (src) => { served.push(src); await gate.promise; return PHOTOS; },
      backdrops: async () => [],
    });

    setMode('ambient', PHOTOS_CFG); // starts fetching the iCloud album
    await flush();
    expect(served).toEqual(['photos']);

    setMode('ambient', GDRIVE_CFG); // source switched to Drive while the fetch was in flight
    gate.resolve();
    await flush();
    // The iCloud manifest resolves now, but the board is on gdrivephotos: the
    // obsolete source must not be installed behind the current one.
    expect($('#slideshow').querySelectorAll('.slide')).toHaveLength(0);
  });

  it('stops the slideshow on the way out', async () => {
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => [] });
    setMode('ambient', ART);
    await flush();
    const shown = bgOf($('#slideshow .slide[data-active]'));

    setMode('dashboard', ART);
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000); // well past the 30-minute rotation
    expect(bgOf($('#slideshow .slide[data-active]'))).toBe(shown); // nothing advanced behind the grid
  });
});

describe('a long-running photo screensaver renews its signed URLs', () => {
  // iCloud/Drive URLs expire after hours; a slideshow that keeps its original
  // array shows dead links until the nightly reload. The engine must receive
  // renewed manifests on a bounded cadence and after an image failure (F11).
  const v1 = [
    { img: 'https://x.test/p1-v1.jpg', title: 'One', date: 'd1' },
    { img: 'https://x.test/p2-v1.jpg', title: 'Two', date: 'd2' },
  ];
  const v2 = v1.map((p) => ({ ...p, img: p.img.replace('-v1', '-v2') }));

  it('re-resolves the manifest on the ~20-minute cadence, not before', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 0));
    let call = 0;
    initScreensaver({ photos: async () => (call++ === 0 ? v1 : v2), backdrops: async () => [] });

    setMode('ambient', PHOTOS_CFG);
    await flush();
    expect(call).toBe(1);
    expect(bgOf($('#slideshow .slide[data-active]'))).toContain('-v1');

    // A re-entry inside the TTL does not re-resolve.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    setMode('ambient', PHOTOS_CFG);
    await flush();
    expect(call).toBe(1);

    // Past the 20-minute TTL, the next re-entry renews it.
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // now 21 min in
    setMode('ambient', PHOTOS_CFG);
    await flush();
    expect(call).toBe(2);

    // The renewed URLs reach the glass on the next auto advance (30-min every).
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await flush();
    expect(bgOf($('#slideshow .slide[data-active]'))).toContain('-v2');
  });

  it('renews at once when a photo fails to load, without waiting for the TTL', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 0));
    // v1 links are dead (expired); v2 links load.
    vi.stubGlobal('Image', class {
      set src(v) { queueMicrotask(() => (String(v).includes('-v1') ? this.onerror?.() : this.onload?.())); }
    });
    let call = 0;
    initScreensaver({ photos: async () => (call++ === 0 ? v1 : v2), backdrops: async () => [] });

    setMode('ambient', PHOTOS_CFG);
    await flush();
    await flush(); // the dead first photo fires onImageError → a forced refresh
    await flush();
    expect(call).toBe(2);
  });

  it('leaves art/curated manifests alone — their URLs do not expire', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 0));
    let call = 0;
    initScreensaver({ photos: async () => { call++; return PHOTOS; }, backdrops: async () => [] });

    setMode('ambient', ART); // art source: stable URLs
    await flush();
    expect(call).toBe(1);

    await vi.advanceTimersByTimeAsync(25 * 60 * 1000); // well past the TTL
    setMode('ambient', ART);
    await flush();
    expect(call).toBe(1); // no needless refetch for a non-signed source
  });
});

describe('the daily backdrop', () => {
  it('opens on the day pick and advances it across local midnight', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 30)); // local, on purpose: the pick is keyed to the local day
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => BACKDROPS });

    setMode('ambient', CLOCK);
    await flush();
    expect($('#backdrop').hidden).toBe(false);
    expect(document.body.classList.contains('ss-backdrop')).toBe(true);
    const first = bgOf($('#backdrop'));
    expect(first).toContain('https://x.test/b');

    // A scheduled board is ambient all night, so nothing reloads the page: the
    // rollover has to happen on the minute cadence or the same photo hangs
    // there for a second day.
    setMode('ambient', CLOCK);
    await flush();
    expect(bgOf($('#backdrop'))).toBe(first); // same day, same picture

    vi.setSystemTime(new Date(2026, 7, 12, 0, 30));
    setMode('ambient', CLOCK);
    await flush();
    const next = bgOf($('#backdrop'));
    expect(next).not.toBe(first);
    // One day on is one picture on, in the folder's own order.
    const order = BACKDROPS.map((b) => `url("${b.img}")`);
    expect(order.indexOf(next)).toBe((order.indexOf(first) + 1) % order.length);
  });

  it('releases a folder fetch that lands after the board went back to the dashboard', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 30));
    const gate = deferred();
    initScreensaver({
      photos: async () => PHOTOS,
      backdrops: async () => { await gate.promise; return BACKDROPS; },
    });

    setMode('ambient', CLOCK);
    await flush();
    expect($('#backdrop').hidden).toBe(true); // still fetching

    setMode('dashboard', CLOCK); // the schedule window opened while the folder was in flight
    gate.resolve();
    await flush();
    expect($('#backdrop').hidden).toBe(true); // the stale result never reaches the glass
    expect(bgOf($('#backdrop'))).toBe('');
    expect(document.body.classList.contains('ss-backdrop')).toBe(false);
  });

  it('a swipe over the clock face steps the backdrop ahead of the day', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 30));
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => BACKDROPS });
    setMode('ambient', CLOCK);
    await flush();
    const first = bgOf($('#backdrop'));

    // The engine wires its own swipe, on the ambient container: over a clock
    // face the slideshow host is hidden, so this is the only handler there is.
    const host = $('#ambient');
    const Ctor = globalThis.PointerEvent ?? globalThis.MouseEvent;
    host.dispatchEvent(new Ctor('pointerdown', { bubbles: true, clientX: 600, clientY: 100, pointerId: 1 }));
    host.dispatchEvent(new Ctor('pointerup', { bubbles: true, clientX: 400, clientY: 104, pointerId: 1 }));
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 100); // the fade through dark

    const order = BACKDROPS.map((b) => `url("${b.img}")`);
    expect(order.indexOf(bgOf($('#backdrop')))).toBe((order.indexOf(first) + 1) % order.length);
  });
});

describe('the clock face', () => {
  it('stops repainting the moment the dashboard comes back', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 30));
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => [] });

    setMode('ambient', CLOCK);
    await flush();
    expect($('#clockface').hidden).toBe(false);
    expect($('#clockface').innerHTML).not.toBe('');
    expect($('#slideshow').hidden).toBe(true);

    setMode('dashboard', CLOCK);
    await flush();
    expect($('#clockface').innerHTML).toBe(''); // the face is torn down, not just hidden
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect($('#clockface').innerHTML).toBe(''); // and its minute timer is not still going
  });

  it('swaps a running slideshow for the face rather than leaving both alive', async () => {
    vi.setSystemTime(new Date(2026, 7, 11, 22, 30));
    initScreensaver({ photos: async () => PHOTOS, backdrops: async () => [] });

    setMode('ambient', ART);
    await flush();
    const shown = bgOf($('#slideshow .slide[data-active]'));

    setMode('ambient', CLOCK);
    await flush();
    expect($('#clockface').innerHTML).not.toBe('');
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(bgOf($('#slideshow .slide[data-active]'))).toBe(shown); // the stopped engine stays stopped
  });
});
