/**
 * @vitest-environment happy-dom
 */
// The in-card image surface: every rotating image card (art, photos,
// landscapes, APOD) goes through renderImageCard, which must never put an
// undecoded bitmap on the glass and must not rebuild the <img> for a photo that
// has not changed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderImageCard, clearImageCard, loadImage, CARD_FADE_MS, openImageViewer, SWIPE_OUT_MS } from '../site/js/imageshow.js';
import * as art from '../site/js/widgets/art.js';
import * as landscapes from '../site/js/widgets/landscapes.js';
import * as apod from '../site/js/widgets/apod.js';
import * as chart from '../site/js/widgets/chart.js';

const CFG = { name: 'Sean' };
const host = () => document.createElement('div');
const frameOf = (el) => el.querySelector('.artwork__frame');
const imgs = (el) => [...el.querySelectorAll('.artwork__img')];
const shown = (el) => imgs(el).map((i) => i.getAttribute('src'));

// Every decode() is captured instead of resolving, so a test decides exactly
// when a bitmap becomes ready — that is the ordering the whole fix rests on.
let pending = [];

beforeEach(() => {
  pending = [];
  vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function decode() {
    return new Promise((resolve, reject) => { pending.push({ img: this, resolve, reject }); });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Settle every outstanding decode, then let the .then() chains run.
async function settle(how = 'resolve') {
  const batch = pending;
  pending = [];
  for (const d of batch) d[how](how === 'reject' ? new Error('decode failed') : undefined);
  await Promise.resolve();
  await Promise.resolve();
}

// The engine's "the fade finished" signal (jsdom-style environments never run
// real transitions, so the test plays the browser's part).
const endTransition = (el) => el.dispatchEvent(new Event('transitionend'));

const paint = (el, src, extra = {}) => renderImageCard(el, { src, alt: '', ...extra });

describe('renderImageCard: first paint', () => {
  it('puts the <img> in the DOM straight away but keeps it invisible until the bitmap decodes', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    const img = el.querySelector('.artwork__img');
    // Synchronous markup: anything reading the card right after render still
    // finds the image and its src.
    expect(img.getAttribute('src')).toBe('https://x.test/a.jpg');
    expect(img.classList.contains('is-entering')).toBe(true); // opacity 0 in CSS
    await settle();
    expect(img.classList.contains('is-entering')).toBe(false); // fades up, no band-by-band draw
  });

  it('builds the scaffold once and never nests frames', () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    paint(el, 'https://x.test/a.jpg');
    expect(el.querySelectorAll('.artwork').length).toBe(1);
    expect(el.querySelectorAll('.artwork__frame').length).toBe(1);
  });

  it('renders no <img> at all for an empty src (a broken box is worse than nothing)', () => {
    const el = host();
    paint(el, '');
    expect(imgs(el)).toHaveLength(0);
    expect(frameOf(el)).not.toBeNull();
  });
});

describe('renderImageCard: decode before swap', () => {
  it('leaves the old photo up until the new one has decoded, then stacks and dissolves', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();

    paint(el, 'https://x.test/b.jpg');
    // Nothing has touched the DOM yet: the card still shows only photo A.
    expect(shown(el)).toEqual(['https://x.test/a.jpg']);

    await settle();
    // Both layers, new one on top (later in DOM order), entering from opacity 0.
    expect(shown(el)).toEqual(['https://x.test/a.jpg', 'https://x.test/b.jpg']);
    expect(imgs(el)[1].classList.contains('is-entering')).toBe(false); // released to fade in
  });

  it('swaps in the very element that was decoded, so the bitmap is not fetched twice', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    const decoded = pending.at(-1).img;
    await settle();
    expect(imgs(el)[1]).toBe(decoded);
  });

  // CONTRACT INVERTED 2026-08-10 (Sean): a failed load must never reach the
  // glass. The old behaviour revealed the errored <img> — which is the browser's
  // broken-image glyph, and it flashed on every boot when the cached digest's
  // expired signed URL errored a second before the fresh fetch healed it. Now a
  // failure keeps whatever the card already shows (or its bare surface on first
  // paint) and forgets state.src so the next render retries.
  it('keeps the current photo when the incoming one fails — a broken newcomer evicts nothing', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    await settle('reject');
    expect(shown(el)).toEqual(['https://x.test/a.jpg']); // b never stacked
  });

  it('retries a failed rotation on the next render instead of short-circuiting on the remembered src', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    await settle('reject');
    paint(el, 'https://x.test/b.jpg'); // 60 s later: same URL must be attempted again
    await settle();
    endTransition(imgs(el).at(-1));
    expect(shown(el)).toEqual(['https://x.test/b.jpg']);
  });

  it('shows nothing — not the broken-image glyph — when the first photo fails', async () => {
    const el = host();
    paint(el, 'https://x.test/bad.jpg');
    await settle('reject');
    expect(imgs(el)).toEqual([]); // the errored layer left the DOM entirely
  });

  it('retries a failed first paint on the next render, even with the identical URL', async () => {
    const el = host();
    paint(el, 'https://x.test/flaky.jpg');
    await settle('reject');
    paint(el, 'https://x.test/flaky.jpg');
    await settle();
    expect(shown(el)).toEqual(['https://x.test/flaky.jpg']);
    expect(imgs(el)[0].classList.contains('is-entering')).toBe(false);
  });

  it('drops a superseded load: the last requested photo wins', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    const stale = pending.at(-1);
    paint(el, 'https://x.test/c.jpg');
    const fresh = pending.at(-1);
    fresh.resolve();
    stale.resolve(); // arrives late, must be ignored
    await Promise.resolve();
    await Promise.resolve();
    expect(shown(el)).toEqual(['https://x.test/a.jpg', 'https://x.test/c.jpg']);
  });
});

describe('renderImageCard: unchanged src is left alone', () => {
  it('keeps the same <img> element across refreshes and starts no new load', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    const first = el.querySelector('.artwork__img');
    pending = [];
    paint(el, 'https://x.test/a.jpg');
    paint(el, 'https://x.test/a.jpg');
    expect(pending).toHaveLength(0); // nothing re-decoded
    expect(el.querySelector('.artwork__img')).toBe(first); // same node, no re-paint
    expect(imgs(el)).toHaveLength(1);
  });

  it('still refreshes the tap target on an unchanged photo (the album list is re-fetched under it)', async () => {
    const el = host();
    let opened = '';
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened = 'first list'; } });
    await settle();
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened = 'refreshed list'; } });
    el.querySelector('.artwork').click();
    expect(opened).toBe('refreshed list');
  });

  it('updates a changed caption without touching the image', async () => {
    const el = host();
    renderImageCard(el, { src: 'https://x.test/a.jpg', caption: '<span>Old</span>' });
    await settle();
    const img = el.querySelector('.artwork__img');
    renderImageCard(el, { src: 'https://x.test/a.jpg', caption: '<span>New</span>' });
    expect(el.querySelector('.artwork__caption').textContent).toBe('New');
    expect(el.querySelector('.artwork__img')).toBe(img);
  });

  it('drops the caption box entirely when there is no caption', async () => {
    const el = host();
    renderImageCard(el, { src: 'https://x.test/a.jpg', caption: '<span>Titled</span>' });
    await settle();
    renderImageCard(el, { src: 'https://x.test/a.jpg', caption: '' });
    expect(el.querySelector('.artwork__caption')).toBeNull();
  });

  it('rebuilds after the card showed something else (an empty/setup state)', async () => {
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    el.innerHTML = '<div class="empty">Landscapes unavailable right now.</div>';
    paint(el, 'https://x.test/a.jpg'); // same src, but the scaffold is gone
    expect(el.querySelector('.artwork__img').getAttribute('src')).toBe('https://x.test/a.jpg');
  });
});

describe('renderImageCard: the DOM does not grow', () => {
  it('keeps exactly one layer after each dissolve, over many rotations', async () => {
    const el = host();
    paint(el, 'https://x.test/0.jpg');
    await settle();
    for (let i = 1; i <= 12; i++) {
      paint(el, `https://x.test/${i}.jpg`);
      await settle();
      expect(imgs(el)).toHaveLength(2); // mid-dissolve: old under, new over
      endTransition(imgs(el).at(-1));
      expect(shown(el)).toEqual([`https://x.test/${i}.jpg`]);
    }
    expect(el.querySelectorAll('.artwork, .artwork__frame')).toHaveLength(2); // one of each
  });

  it('sweeps the old layer on a timer when no transition ever fires, and leaves nothing running', async () => {
    vi.useFakeTimers();
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    await settle();
    expect(imgs(el)).toHaveLength(2);
    vi.advanceTimersByTime(CARD_FADE_MS + 200);
    expect(shown(el)).toEqual(['https://x.test/b.jpg']);
    expect(vi.getTimerCount()).toBe(0); // no cost at all between rotations
  });

  it('clears the sweep timer when the transition ends first', async () => {
    vi.useFakeTimers();
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    await settle();
    expect(vi.getTimerCount()).toBe(1); // the net, armed for one fade
    endTransition(imgs(el).at(-1));
    expect(vi.getTimerCount()).toBe(0);
    expect(imgs(el)).toHaveLength(1);
  });
});

describe('renderImageCard: prefers-reduced-motion', () => {
  it('cuts straight to the new photo with no fade and no leftover layer', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true });
    vi.useFakeTimers();
    const el = host();
    paint(el, 'https://x.test/a.jpg');
    await settle();
    paint(el, 'https://x.test/b.jpg');
    await settle();
    // Instant: one layer, already visible, no transition to wait on.
    expect(shown(el)).toEqual(['https://x.test/b.jpg']);
    expect(el.querySelector('.artwork__img').classList.contains('is-entering')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('loadImage', () => {
  it('falls back to the load event on an engine without decode()', async () => {
    HTMLImageElement.prototype.decode.mockRestore();
    const img = document.createElement('img');
    delete img.decode;
    Object.defineProperty(img, 'decode', { value: undefined, configurable: true });
    Object.defineProperty(img, 'complete', { value: false, configurable: true });
    let done = false;
    loadImage(img, 'https://x.test/a.jpg').then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    img.onload();
    await Promise.resolve();
    expect(done).toBe(true);
  });

  it('resolves once, even if both decode and the load event report in', async () => {
    const img = document.createElement('img');
    let count = 0;
    loadImage(img, 'https://x.test/a.jpg').then(() => { count++; });
    pending.at(-1).resolve();
    img.onload();
    img.onerror();
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(1);
  });
});

describe('every rotating image card shares the surface', () => {
  const vmA = { img: 'https://x.test/art-a.jpg', title: 'Wheat Fields', artist: 'Ruisdael', year: '1670' };
  const vmB = { img: 'https://x.test/art-b.jpg', title: 'Sea View', artist: 'Vroom', year: '1620' };

  it('art dissolves between works and keeps its caption', async () => {
    const el = host();
    art.render(el, vmA, CFG);
    await settle();
    expect(el.querySelector('.artwork__title').textContent).toBe('Wheat Fields');
    art.render(el, vmB, CFG);
    expect(shown(el)).toEqual(['https://x.test/art-a.jpg']); // nothing before decode
    await settle();
    expect(shown(el)).toEqual(['https://x.test/art-a.jpg', 'https://x.test/art-b.jpg']);
    endTransition(imgs(el).at(-1));
    expect(el.querySelector('.artwork__artist').textContent).toBe('Vroom (1620)');
  });

  it('a viewer swipe fades through dark: dim at the gesture, swap unseen, neighbors warmed', async () => {
    vi.useFakeTimers();
    document.querySelector('#art-viewer')?.remove();
    const list = [
      { img: 'https://x.test/s1.jpg', title: 'One' },
      { img: 'https://x.test/s2.jpg', title: 'Two' },
      { img: 'https://x.test/s3.jpg', title: 'Three' },
    ];
    openImageViewer(list[0], CFG, { list });
    const viewer = document.querySelector('#art-viewer');
    const img = viewer.querySelector('.art-viewer__img');
    viewer.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, bubbles: true }));
    viewer.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, bubbles: true })); // 200px left = next
    expect(img.style.opacity).toBe('0'); // dimming starts at the gesture
    expect(img.getAttribute('src')).toBe('https://x.test/s1.jpg'); // swap waits for the dark
    await settle(); // decode resolves
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 50); // dark beat passes
    expect(img.getAttribute('src')).toBe('https://x.test/s2.jpg');
    expect(img.style.opacity).toBe(''); // rising on the new photo
    expect(document.querySelector('.art-viewer__img--ghost')).toBeNull(); // ghost machinery retired
    // Both neighbors were queued to decode, so the next swipe starts instantly.
    expect(pending.length).toBeGreaterThanOrEqual(2);
    document.querySelector('#art-viewer')?.remove();
    vi.useRealTimers();
  });

  it('landscapes/photos dissolve, and a tap opens the photo that is actually showing', async () => {
    document.querySelector('#art-viewer')?.remove();
    const el = host();
    landscapes.render(el, { photos: [{ img: 'https://x.test/l1.jpg', title: '' }] }, CFG);
    await settle();
    expect(el.querySelector('.artwork__caption')).toBeNull(); // untitled photo, no box
    landscapes.render(el, { photos: [{ img: 'https://x.test/l2.jpg', title: 'Fjord' }] }, CFG);
    await settle();
    endTransition(imgs(el).at(-1));
    expect(shown(el)).toEqual(['https://x.test/l2.jpg']);
    el.querySelector('.artwork').click();
    expect(document.querySelector('#art-viewer .art-viewer__img').getAttribute('src')).toBe('https://x.test/l2.jpg');
    document.querySelector('#art-viewer')?.remove();
  });

  it('chart holds its infographic across the 30 minute refresh, and never loads it lazily', async () => {
    const el = host();
    const vm = { charts: [{ url: 'https://x.test/chart.png', title: 'Population Growth', desc: 'why' }] };
    chart.render(el, vm, CFG);
    const img = el.querySelector('.artwork__img');
    // A board has no fold: the picture starts loading with the card, not when
    // something scrolls it into view (a lazy chart left the card black at boot).
    expect(img.getAttribute('loading')).toBeNull();
    expect(img.classList.contains('is-entering')).toBe(true);
    await settle();
    expect(img.classList.contains('is-entering')).toBe(false);
    expect(el.querySelector('.artwork--contain')).not.toBeNull(); // data images never crop
    expect(el.querySelector('.artwork__caption')).toBeNull(); // the title is baked into the image
    pending = [];
    chart.render(el, vm, CFG);
    chart.render(el, { charts: [{ ...vm.charts[0] }] }, CFG);
    expect(pending).toHaveLength(0); // same chart, no re-decode, no re-paint
    expect(el.querySelector('.artwork__img')).toBe(img);
    // The day's new chart still dissolves in behind the old one.
    chart.render(el, { charts: [{ url: 'https://x.test/chart-2.png', title: 'Next', desc: '' }] }, CFG);
    expect(shown(el)).toEqual(['https://x.test/chart.png']); // nothing before decode
    await settle();
    expect(shown(el)).toEqual(['https://x.test/chart.png', 'https://x.test/chart-2.png']);
    endTransition(imgs(el).at(-1));
    expect(shown(el)).toEqual(['https://x.test/chart-2.png']);
  });

  it('chart still opens the full-screen viewer on a tap', async () => {
    document.querySelector('#art-viewer')?.remove();
    const el = host();
    chart.render(el, { charts: [{ url: 'https://x.test/chart.png', title: 'Population Growth', desc: 'why' }] }, CFG);
    await settle();
    el.querySelector('.artwork').click();
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/chart.png');
    expect(viewer.querySelector('.slide-caption')).toBeNull(); // caption:false — it is in the image
    expect(viewer.querySelector('.strip')).toBeNull(); // strip:false — it would cover the chart
    viewer.remove();
  });

  it('apod holds its one photo across the 30 minute refresh instead of re-decoding it', async () => {
    const el = host();
    const vm = { photo: { url: 'https://x.test/apod.jpg', title: 'Messier 24', credit: 'Chuck Ayoub', explanation: 'A star cloud.' } };
    apod.render(el, vm, CFG);
    await settle();
    const img = el.querySelector('.artwork__img');
    pending = [];
    apod.render(el, vm, CFG);
    apod.render(el, { photo: { ...vm.photo } }, CFG);
    expect(pending).toHaveLength(0);
    expect(el.querySelector('.artwork__img')).toBe(img);
    expect(el.querySelector('.artwork__title').textContent).toBe('Messier 24');
  });
});

/**
 * The whole card is the tap target (2026-08-01), the same grammar weather and
 * markets already used. The figure used to carry role="button" and the click
 * listener, which made the picture tappable and left the title row and the
 * padding around it dead glass — one of several unlabelled tap models sharing
 * the board.
 */
describe('an image card is one tap target, not a figure inside a card', () => {
  // A real card wrapper, the shape main.js builds.
  function cardHost(kind = 'art', title = 'Art') {
    document.body.innerHTML = `
      <div id="grid">
        <article class="card card--${kind}" data-widget="${kind}">
          <h2 class="card__title">${title}</h2>
          <div class="card__body"></div>
          <div class="card__stamp" hidden></div>
        </article>
      </div>`;
    return document.querySelector('.card__body');
  }

  beforeEach(() => {
    document.querySelector('#art-viewer')?.remove();
  });

  it('opens from a tap on the card, not only on the picture', async () => {
    const el = cardHost();
    let opened = 0;
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened += 1; } });
    await settle();
    // The title row: dead glass before this, part of the target now.
    el.closest('.card').querySelector('.card__title').click();
    expect(opened).toBe(1);
    el.querySelector('.artwork').click(); // the picture still works, of course
    expect(opened).toBe(2);
  });

  it('moves the button semantics up to the card, and leaves the corner clean', async () => {
    const el = cardHost();
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => {} });
    await settle();
    const card = el.closest('.card');
    expect(el.querySelector('.artwork').getAttribute('role')).toBeNull(); // it left the figure
    expect(el.querySelector('.artwork').getAttribute('tabindex')).toBeNull();
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.getAttribute('aria-label')).toBe('View image full screen');
    expect(card.classList.contains('is-expandable')).toBe(true);
    // An image card counts nothing hidden, so it draws no badge: the bare mark
    // it briefly wore was retired on 2026-08-01, and the picture kept the 12px
    // its reserve had been costing.
    expect(card.querySelector('.card__more')).toBeNull();
  });

  it('keeps exactly one handler however often the scaffold is rebuilt', async () => {
    const el = cardHost();
    let opened = 0;
    const paintIt = () => renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened += 1; } });
    paintIt();
    await settle();
    el.innerHTML = '<div class="empty">unavailable right now</div>'; // scaffold and state void
    paintIt();
    await settle();
    el.closest('.card').click();
    expect(opened).toBe(1); // not two listeners on one card
  });

  it('opens the LATEST photo after a rebuild, not the one the listener was born beside', async () => {
    const el = cardHost();
    let opened = '';
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened = 'first'; } });
    await settle();
    el.innerHTML = '<div class="empty">gone</div>';
    renderImageCard(el, { src: 'https://x.test/b.jpg', onOpen: () => { opened = 'latest'; } });
    await settle();
    el.closest('.card').click();
    expect(opened).toBe('latest');
  });

  it('refuses a tap that is really a full-screen view being dismissed', async () => {
    const el = cardHost();
    let opened = 0;
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened += 1; } });
    await settle();
    // One tap, one destination: with a view already up, a click reaching the
    // card is that view's dismissal leaking through, never a second opening.
    const viewer = document.createElement('div');
    viewer.id = 'art-viewer';
    viewer.hidden = false;
    document.body.appendChild(viewer);
    el.closest('.card').click();
    expect(opened).toBe(0);

    viewer.remove();
    el.closest('.card').click();
    expect(opened).toBe(1);
  });

  it('is not tappable at all when there is no photo to open', async () => {
    const el = cardHost('landscapes', 'Landscapes');
    let opened = 0;
    renderImageCard(el, { src: '', onOpen: () => { opened += 1; } });
    const card = el.closest('.card');
    expect(card.classList.contains('is-expandable')).toBe(false);
    expect(card.getAttribute('role')).toBeNull();
    card.click();
    expect(opened).toBe(0);
  });

  it('does not open the last photo from under a setup prompt', async () => {
    // The listener lives on the card now, and the card outlives the render that
    // replaced the picture with a prompt — so the DESTINATION is what has to go.
    // Tapping the prompt opens Settings (main.js) and must do nothing else.
    const el = cardHost('photos', 'Photos');
    let opened = 0;
    renderImageCard(el, { src: 'https://x.test/a.jpg', onOpen: () => { opened += 1; } });
    await settle();
    el.innerHTML = '<p class="empty" data-setup="photos">Tap here to add an album</p>';
    clearImageCard(el);
    el.closest('.card').click();
    expect(opened).toBe(0);
    expect(el.closest('.card').classList.contains('is-expandable')).toBe(false);
  });

  it('takes the tap back when the card falls to its empty state', async () => {
    const el = cardHost('chart', 'Chart of the Day');
    chart.render(el, { charts: [{ url: 'https://x.test/cotd.png', title: 'Growth' }] }, CFG);
    await settle();
    const card = el.closest('.card');
    expect(card.classList.contains('is-expandable')).toBe(true);
    expect(card.getAttribute('aria-label')).toBe('View chart full screen');
    expect(card.querySelector('.card__more')).toBeNull(); // nothing counted, nothing painted

    chart.render(el, { charts: [] }, CFG); // the feed came back empty
    expect(card.getAttribute('role')).toBeNull(); // yesterday's tap does not outlive it
    expect(card.getAttribute('tabindex')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(false);
  });

  it('opens the chart viewer from anywhere on the chart card', async () => {
    const el = cardHost('chart', 'Chart of the Day');
    chart.render(el, { charts: [{ url: 'https://x.test/cotd.png', title: 'Growth', desc: 'why' }] }, CFG);
    await settle();
    el.closest('.card').querySelector('.card__title').click();
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.hidden).toBe(false);
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/cotd.png');
    expect(viewer.querySelector('.strip')).toBeNull(); // no info band over a chart
    viewer.remove();
  });
});

// F12: a swipe's decode can finish long after a later swipe already landed. The
// viewer keeps a navigation generation so only the newest navigation of the
// CURRENT session may touch the image, and a slow loser stays a no-op.
describe('the photo viewer: a late swipe cannot overwrite a newer one', () => {
  const swipe = (viewer, dir) => {
    const [down, up] = dir > 0 ? [300, 100] : [100, 300]; // left drag = next
    viewer.dispatchEvent(new PointerEvent('pointerdown', { clientX: down, bubbles: true }));
    viewer.dispatchEvent(new PointerEvent('pointerup', { clientX: up, bubbles: true }));
  };
  // Resolve the FIRST pending decode whose image src carries `match`. loadImage
  // sets .src before calling decode(), so the pending entry already knows which
  // photo it is waiting on.
  const resolveDecode = (match) => {
    const i = pending.findIndex((d) => String(d.img.src ?? '').includes(match));
    if (i < 0) throw new Error(`no pending decode for ${match}`);
    pending.splice(i, 1)[0].resolve();
  };

  it('B loading slowly after C already landed leaves C on the glass', async () => {
    vi.useFakeTimers();
    document.querySelector('#art-viewer')?.remove();
    const list = [
      { img: 'https://x.test/v1.jpg', title: 'One' },
      { img: 'https://x.test/v2.jpg', title: 'Two' },
      { img: 'https://x.test/v3.jpg', title: 'Three' },
    ];
    openImageViewer(list[0], CFG, { list });
    const viewer = document.querySelector('#art-viewer');
    const img = viewer.querySelector('.art-viewer__img');

    pending = []; // drop the neighbors warmed at open; the swipes are what matter
    swipe(viewer, 1); // toward v2 (will load slowly)
    swipe(viewer, 1); // toward v3 (lands first)

    resolveDecode('v3.jpg');
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 50); // v3 rises through the dark
    expect(img.getAttribute('src')).toBe('https://x.test/v3.jpg');

    resolveDecode('v2.jpg'); // the slow, superseded swipe finally decodes
    await vi.advanceTimersByTimeAsync(0);
    expect(img.getAttribute('src')).toBe('https://x.test/v3.jpg'); // not clobbered

    document.querySelector('#art-viewer')?.remove();
    vi.useRealTimers();
  });

  it('a swipe still decoding when the viewer reopens cannot caption the new album', async () => {
    // Reopen rebuilds the <img>, so an orphaned swipe's src write lands on a
    // detached element harmlessly — but its CAPTION write targets the live
    // viewer, which is exactly where the old album used to leak into the new
    // session before the generation check.
    vi.useFakeTimers();
    document.querySelector('#art-viewer')?.remove();
    const first = [
      { img: 'https://x.test/a1.jpg', title: 'A1' },
      { img: 'https://x.test/a2.jpg', title: 'Album A photo two' },
    ];
    openImageViewer(first[0], CFG, { list: first });
    const viewer = document.querySelector('#art-viewer');
    const captionText = () => viewer.querySelector('.slide-caption__title')?.textContent ?? '';

    pending = [];
    swipe(viewer, 1); // toward a2, whose decode never resolves before we reopen

    const second = [{ img: 'https://x.test/b1.jpg', title: 'Album B photo one' }];
    openImageViewer(second[0], CFG, { list: second });
    expect(captionText()).toBe('Album B photo one');

    resolveDecode('a2.jpg'); // the orphaned swipe from the old session decodes now
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 50);
    expect(captionText()).toBe('Album B photo one'); // the old album's caption never leaks in

    document.querySelector('#art-viewer')?.remove();
    vi.useRealTimers();
  });
});
