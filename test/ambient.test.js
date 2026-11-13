/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSlideshow, swipeFadeThrough, SWIPE_OUT_MS, captionPlacement,
  CAPTION_LEFT, CAPTION_BOTTOM, CAPTION_BAR_BOTTOM, CAPTION_BAR_MIN,
} from '../site/js/imageshow.js';
import { stripData, stripHtml, setStripSourceStale, isStripSourceStale, onStripStaleChange } from '../site/js/ambient.js';
import { ambientSource } from '../site/js/modes.js';
import { resolvePhotosManifest } from '../site/js/photos-manifest.js';
import { DEMO_VMS, DEMO_NOW_MS } from '../site/demo/fixtures.js';

const MANIFEST = [
  { img: 'a.jpg', title: 'A', artist: 'AA', year: '1900', ar: 1.78 },
  { img: 'b.jpg', title: 'B', artist: 'BB', year: '1910', ar: 1.3 },
  { img: 'c.jpg', title: 'C', artist: 'CC', year: '1920', ar: 2.4 },
];

describe('createSlideshow', () => {
  let loadedSrcs;
  beforeEach(() => {
    vi.useFakeTimers();
    loadedSrcs = [];
    // Deterministic Image: records src, fires onload synchronously-ish.
    vi.stubGlobal(
      'Image',
      class {
        set src(v) {
          loadedSrcs.push(v);
          queueMicrotask(() => this.onload?.());
        }
      },
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a swiped step fades the stage through dark and flips in the dark beat', async () => {
    // Sean's final call, felt on the glass: fade-through-dark is the swipe
    // grammar for every photo surface on every device — calm beats
    // directional. The stage (layers + caption) dims at the gesture, the
    // layer flip happens instantly while invisible (slide--cut), and the
    // stage rises on the new photo. The AUTO advance keeps the 2.5s dissolve.
    const host = document.createElement('div');
    const show = createSlideshow(
      [{ img: 'a.jpg' }, { img: 'b.jpg' }, { img: 'c.jpg' }],
      host, { intervalMs: 1000, random: () => 0.4 },
    );
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    const layers = [...host.querySelectorAll('.slide')];
    const activeBefore = host.querySelector('.slide[data-active]');
    show.step(1);
    expect(host.style.opacity).toBe('0'); // the dimming IS the instant acknowledgment
    expect(host.querySelector('.slide[data-active]')).toBe(activeBefore); // flip waits for the dark
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 50);
    expect(host.querySelector('.slide[data-active]')).not.toBe(activeBefore);
    expect(layers.every((l) => l.classList.contains('slide--cut'))).toBe(true); // invisible flip, no dissolve
    expect(host.style.opacity).toBe(''); // rising
    await vi.advanceTimersByTimeAsync(1000); // next AUTO advance restores the dissolve
    expect(layers.some((l) => l.classList.contains('slide--cut'))).toBe(false);
  });

  it('backdrop swipes fade out, swap in the dark, fade back in — same on every device', async () => {
    // Sean's call 2026-08-01, after two rounds of Navigator flashes: the
    // backdrop reuses its initial-load grammar. One opacity animation on one
    // existing layer; the swap happens while invisible, so nothing new is
    // ever rastered on screen and there is nothing to flash.
    const el = document.createElement('div');
    el.style.backgroundImage = 'url("old.jpg")';
    document.documentElement.style.zoom = '0.326'; // even scaled panels take this path
    try {
      let applied = false;
      swipeFadeThrough(el, Promise.resolve(), () => {
        applied = true;
        el.style.backgroundImage = 'url("new.jpg")';
      });
      // The mount animation (backdrop-in, fill both) would override inline
      // opacity in the cascade and turn the whole fade into a silent no-op —
      // it must be released before the fade owns opacity.
      expect(el.style.animation).toBe('none');
      expect(el.style.opacity).toBe('0'); // the fade-out IS the instant acknowledgment
      expect(applied).toBe(false); // the swap waits for the dark beat
      await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 50);
      expect(applied).toBe(true);
      expect(el.style.backgroundImage).toContain('new.jpg');
      expect(el.style.opacity).toBe(''); // fading back in
      expect(document.querySelector('.swipe-ghost')).toBeNull(); // no ghost, ever
    } finally {
      document.documentElement.style.zoom = '';
    }
  });

  it('a slow decode extends the dark beat instead of flashing a half-ready photo', async () => {
    const el = document.createElement('div');
    let ready;
    const decode = new Promise((r) => { ready = r; });
    let applied = false;
    swipeFadeThrough(el, decode, () => { applied = true; });
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 200); // out finished long ago
    expect(applied).toBe(false); // still dark: the bitmap is not ready
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toBe(true);
  });

  it('leaves the caption empty for a titleless photo (no stray grey box)', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(
      [{ img: 'x.jpg', title: '', ar: 1.5 }], // GDrive-style: no title, no artist
      host,
      { intervalMs: 1000, random: () => 0 },
    );
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    const cap = host.querySelector('.slide-caption');
    expect(cap.children.length).toBe(0); // no empty spans -> :empty CSS hides it
    expect(cap.textContent).toBe('');
  });

  it('preloads, alternates two layers and wraps with reshuffle', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0.4 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedSrcs).toHaveLength(1);
    expect(host.querySelectorAll('.slide').length).toBe(2); // never more than 2 layers
    expect(host.querySelectorAll('.slide[data-active]').length).toBe(1);
    const firstCaption = host.querySelector('.slide-caption').textContent;

    await vi.advanceTimersByTimeAsync(1000);
    expect(loadedSrcs).toHaveLength(2);
    expect(host.querySelector('.slide-caption').textContent).not.toBe(firstCaption);

    // Advance through the wrap point — no errors, keeps cycling.
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(loadedSrcs.length).toBe(7);
    show.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(loadedSrcs.length).toBe(7);
  });

  it('letterboxes every image on black (matches the full-screen viewer)', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0 });
    show.start();
    const sizes = [];
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 1000);
      const active = host.querySelector('.slide[data-active]');
      sizes.push(`${show.current().ar}:${active.style.backgroundSize}`);
    }
    show.stop();
    // Every aspect now letterboxes (contain) — consistent with tap-in.
    expect(sizes.sort()).toEqual(['1.3:contain', '1.78:contain', '2.4:contain']);
  });

  it('fit: "cover" fills the viewport (curated sources like Landscapes)', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0, fit: 'cover' });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('.slide[data-active]').style.backgroundSize).toBe('cover');
    show.stop();
  });

  it('does nothing with an empty manifest', async () => {
    const host = document.createElement('div');
    const show = createSlideshow([], host, { intervalMs: 1000 });
    show.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(loadedSrcs).toHaveLength(0);
  });

  it('step(1) advances immediately and resets the cadence', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0.4 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedSrcs).toHaveLength(1);
    const first = host.querySelector('.slide-caption').textContent;

    show.step(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedSrcs).toHaveLength(2); // the preload starts at the gesture
    expect(host.querySelector('.slide-caption').textContent).toBe(first); // swap waits for the dark beat
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 30);
    expect(host.querySelector('.slide-caption').textContent).not.toBe(first);

    // cadence reset counts from the swap: nothing at +999ms, next at +1000ms
    await vi.advanceTimersByTimeAsync(999);
    expect(loadedSrcs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(loadedSrcs).toHaveLength(3);
    show.stop();
  });

  it('step(-1) returns to the previously shown item', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0.4 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = host.querySelector('.slide-caption').textContent;
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.querySelector('.slide-caption').textContent).not.toBe(first);

    show.step(-1);
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 30); // through the dark beat
    expect(host.querySelector('.slide-caption').textContent).toBe(first);
    show.stop();
  });

  it('step after stop does nothing', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0.4 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    show.stop();
    show.step(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(loadedSrcs).toHaveLength(1);
  });

  // F06: a swipe schedules its next auto advance only when its preload finishes,
  // and clearing the timer at the top of step cannot cancel a timer an earlier,
  // still-loading swipe has not created yet. Two rapid swipes therefore used to
  // arm two timers and race two rotation chains for the session.
  it('two rapid swipes leave exactly one rotation chain', async () => {
    const host = document.createElement('div');
    const show = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0.4 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadedSrcs).toHaveLength(1); // the first auto advance

    show.step(1); // swipe A: preloads at the gesture
    show.step(1); // swipe B: before A's dark beat completes
    await vi.advanceTimersByTimeAsync(SWIPE_OUT_MS + 40); // both dark beats pass
    const afterSwipes = loadedSrcs.length; // 3: the initial load + the two swipe preloads

    // One interval on, exactly ONE auto advance should fire — one chain, one new
    // image. Before the fix both swipes' timers fired and loaded two.
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadedSrcs.length - afterSwipes).toBe(1);
    show.stop();
  });

  // F11: a signed-URL manifest expires while a screensaver runs for hours.
  // updateManifest swaps in renewed URLs, keeping the current photo by stable
  // identity (a renewed signed URL is a new url for the SAME shot) and loading
  // later photos from the fresh links.
  it('updateManifest renews URLs, preserving the current photo by identity', async () => {
    const host = document.createElement('div');
    const original = [
      { img: 'https://x/a-old.jpg', title: 'A', date: '2026-01-01', ar: 1.5 },
      { img: 'https://x/b-old.jpg', title: 'B', date: '2026-01-02', ar: 1.5 },
    ];
    const show = createSlideshow(original, host, { intervalMs: 1000, random: () => 0 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = show.current();

    // Same shots (date/title), fresh signed URLs.
    const renewed = original.map((p) => ({ ...p, img: p.img.replace('-old', '-new') }));
    show.updateManifest(renewed);

    const after = show.current();
    expect(after.title).toBe(before.title);            // same photo,
    expect(after.date).toBe(before.date);
    expect(after.img).toBe(before.img.replace('-old', '-new')); // renewed URL

    // The next auto advance loads from a renewed link, not a dead one.
    const n = loadedSrcs.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadedSrcs.slice(n).every((s) => s.includes('-new'))).toBe(true);
    show.stop();
  });
});

describe('stripData', () => {
  const NOW = 1_800_000_000; // fixed "now" in epoch seconds
  const caches = {
    weather: { now: { temp: 84 } },
    // Departures carry an absolute `t`; the countdown is derived from it, not
    // from any cached `min` (see the staleness tests below).
    lirr: { departures: [{ min: 999, t: NOW + 8 * 60, dest: 'Port Washington', track: '17' }] },
  };
  it('assembles temp and next departures from enabled widgets', () => {
    const out = stripData(caches, { widgets: ['weather', 'lirr'] }, { nowSec: NOW });
    expect(out.temp).toBe(84);
    expect(out.transit).toHaveLength(1);
    expect(out.transit[0].label).toContain('Port Washington');
    expect(out.transit[0].min).toBe(8);
  });
  it('omits missing/disabled sources', () => {
    const out = stripData({ weather: caches.weather }, { widgets: ['weather'] }, { nowSec: NOW });
    expect(out.temp).toBe(84);
    expect(out.transit).toEqual([]);
    expect(stripData({}, { widgets: [] }).temp).toBeNull();
  });

  // The bug this guards: the strip used to read the cached `min` straight
  // through, so a wedged feed (or a cache restored from localStorage at boot)
  // showed a confident wrong countdown forever.
  it('recomputes the countdown from the absolute time, ignoring a frozen stale `min`', () => {
    const stale = { lirr: { departures: [{ min: 8, t: NOW + 20 * 60, dest: 'Mineola' }] } };
    const out = stripData(stale, { widgets: ['lirr'] }, { nowSec: NOW });
    expect(out.transit[0].min).toBe(20); // 20, not the cached 8
  });
  it('goes quiet rather than lying when every cached departure is in the past', () => {
    const hoursOld = {
      lirr: { departures: [{ min: 8, t: NOW - 3 * 3600, dest: 'Mineola' }] },
      njt: { trains: [{ min: 12, time: NOW - 2 * 3600, dest: 'Trenton' }] },
    };
    const out = stripData(hoursOld, { widgets: ['lirr', 'njt'] }, { nowSec: NOW });
    expect(out.transit).toEqual([]);
  });
  it('skips already-departed entries instead of trusting index 0', () => {
    // A stale cache still holds departed trains: the widget's own past filter
    // ran at ITS render, not now.
    const mixed = { njt: { trains: [
      { min: 1, time: NOW - 600, dest: 'Departed' },
      { min: 2, time: NOW - 60, dest: 'Also departed' },
      { min: 3, time: NOW + 7 * 60, dest: 'Trenton', track: '3' },
    ] } };
    const out = stripData(mixed, { widgets: ['njt'] }, { nowSec: NOW });
    expect(out.transit).toHaveLength(1);
    expect(out.transit[0].label).toContain('Trenton');
    expect(out.transit[0].label).toContain('Track 3');
    expect(out.transit[0].min).toBe(7);
  });
  it('drops an entry with no usable absolute time (unverifiable countdown)', () => {
    const shapeless = { mnr: { departures: [{ min: 5, dest: 'Southeast' }] } };
    expect(stripData(shapeless, { widgets: ['mnr'] }, { nowSec: NOW }).transit).toEqual([]);
  });
  it('never renders a sub-minute countdown as 0 min', () => {
    const soon = { lirr: { departures: [{ t: NOW + 20, dest: 'Mineola' }] } };
    expect(stripData(soon, { widgets: ['lirr'] }, { nowSec: NOW }).transit[0].min).toBe(1);
  });
  it('keeps the demo fixtures readable when given their own reference instant', () => {
    const out = stripData(
      { lirr: DEMO_VMS.lirr, mnr: DEMO_VMS.mnr, njt: DEMO_VMS.njt },
      { widgets: ['lirr', 'mnr', 'njt'] },
      { nowSec: Math.floor(DEMO_NOW_MS / 1000) },
    );
    expect(out.transit.map((t) => t.min)).toEqual([8, 6, 12]); // the fixtures' intended minutes
  });
});

describe('stripHtml', () => {
  const now = new Date('2026-07-03T21:30:00');
  it('always renders the clock, and temp/transit only when present', () => {
    const bare = stripHtml({ temp: null, cond: null, transit: [] }, now);
    expect(bare).toContain('strip__time');
    expect(bare).toContain('9:30 PM');
    expect(bare).not.toContain('strip__wx');
    const full = stripHtml({ temp: 84, cond: 'Clear', transit: [{ label: 'LIRR · Mineola', min: 8 }] }, now);
    expect(full).toContain('84°');
    expect(full).toContain('Clear'); // conditions, not just temp
    expect(full).toContain('LIRR · Mineola');
    expect(full).toContain('<b>8 min</b>');
  });
  it('leads a transit segment with its minutes, then the label', () => {
    // "Track 17 8 min" read as "17 8": the minutes come first.
    const out = stripHtml({ temp: null, cond: null, transit: [{ label: 'LIRR · Port Washington · Track 17', min: 8 }] }, now);
    expect(out).toContain('<span class="strip__transit"><b>8 min</b> LIRR · Port Washington · Track 17</span>');
  });
  it('omits the time under a clock-face screensaver (no duplication)', () => {
    const noTime = stripHtml({ temp: 72, cond: 'Clear', transit: [] }, now, { showTime: false });
    expect(noTime).not.toContain('strip__time');
    expect(noTime).toContain('72°'); // weather still shows
    expect(noTime).toContain('Clear');
  });
  it('escapes upstream label text', () => {
    const out = stripHtml({ temp: null, cond: null, transit: [{ label: 'NJT · <img src=x onerror=1>', min: 3 }] }, now);
    expect(out).not.toContain('<img');
    expect(out).toContain('&#60;img');
  });
});

describe('createSlideshow stop() safety', () => {
  it('a stop() during a pending preload never resurrects the advance loop', () => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', class { set src(_v) { this._fire = () => this.onload?.(); Slideshow._pending.push(this); } });
    const host = document.createElement('div');
    const s = createSlideshow(MANIFEST, host, { intervalMs: 1000, random: () => 0 });
    s.start(); // advance → preload → onload pending (not fired)
    s.stop(); // stopped while the preload is in flight
    Slideshow._pending.forEach((img) => img._fire()); // resolve the pending onload
    vi.advanceTimersByTime(10000);
    expect(host.querySelector('.slide-caption').innerHTML.trim()).toBe(''); // never showed
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
const Slideshow = { _pending: [] };

describe('photos screensaver cold-boot — manifest resolution', () => {
  // Regression for the cold-start race in startSlideshow (photos source).
  // Before the fix, photoManifest() returned [] on cold boot (widget fetches
  // async), so createSlideshow([]) assigned a non-null `slideshow`. Every
  // subsequent applyMode() retry hit `if (slideshow) return` and the
  // screensaver stayed blank until the nightly page reload.

  it('calls fetchData() inline when photoManifest() is empty on cold boot', async () => {
    const photo = { img: 'https://example.com/1.jpg', ar: 1.78, title: 'Sunset' };
    const fetchDataMock = vi.fn().mockResolvedValue({ photos: [photo] });
    const photosMod = {
      photoManifest: () => [], // cold boot: render() hasn't run yet
      fetchData: fetchDataMock,
    };
    const cfg = { photos: { source: 'icloud', album: 'B1m5fk75vLWwX' } };
    const net = { fetchJSON: vi.fn() };

    const manifest = await resolvePhotosManifest(cfg, net, photosMod);

    expect(fetchDataMock).toHaveBeenCalledWith(cfg, net);
    expect(manifest).toHaveLength(1);
    expect(manifest[0].img).toBe(photo.img);
  });

  it('skips fetchData() when photoManifest() is populated AND fresh (warm cache)', async () => {
    const photo = { img: 'https://example.com/cached.jpg', ar: 1.5, title: 'Cached' };
    const fetchDataMock = vi.fn();
    const photosMod = {
      photoManifest: () => [photo], // warm: render() ran earlier
      photoManifestAt: () => Date.now(), // ...and just now, so its URLs are fresh
      fetchData: fetchDataMock,
    };
    const cfg = { photos: { source: 'icloud', album: 'B1m5fk75vLWwX' } };
    const net = { fetchJSON: vi.fn() };

    const manifest = await resolvePhotosManifest(cfg, net, photosMod);

    expect(fetchDataMock).not.toHaveBeenCalled();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toBe(photo);
  });

  // F11: a nonempty list is no longer trusted forever. A manifest that has sat
  // long enough for its signed URLs to expire is refetched, not reused.
  it('refetches when the rendered list is stale (its signed URLs may have expired)', async () => {
    const stale = { img: 'https://example.com/expired.jpg', ar: 1.5, title: 'Old', date: '2026-01-01' };
    const fresh = { img: 'https://example.com/renewed.jpg', ar: 1.5, title: 'Old', date: '2026-01-01' };
    const fetchDataMock = vi.fn().mockResolvedValue({ photos: [fresh] });
    const photosMod = {
      photoManifest: () => [stale],
      photoManifestAt: () => Date.now() - 30 * 60 * 1000, // half an hour old
      fetchData: fetchDataMock,
    };
    const cfg = { photos: { source: 'icloud', album: 'B1m5fk75vLWwX' } };
    const net = { fetchJSON: vi.fn() };

    const manifest = await resolvePhotosManifest(cfg, net, photosMod);

    expect(fetchDataMock).toHaveBeenCalledWith(cfg, net);
    expect(manifest[0].img).toBe('https://example.com/renewed.jpg');
  });

  it('keeps the last good list when a stale-triggered refetch comes back empty', async () => {
    const stale = { img: 'https://example.com/expired.jpg', ar: 1.5, title: 'Old' };
    const fetchDataMock = vi.fn().mockResolvedValue({ photos: [] });
    const photosMod = {
      photoManifest: () => [stale],
      photoManifestAt: () => Date.now() - 30 * 60 * 1000,
      fetchData: fetchDataMock,
    };
    const manifest = await resolvePhotosManifest({}, { fetchJSON: vi.fn() }, photosMod);
    expect(fetchDataMock).toHaveBeenCalled();
    expect(manifest).toEqual([stale]); // a failed refresh does not blank the screensaver
  });

  it('returns [] when both photoManifest() and fetchData() are empty — allows retry without locking', async () => {
    const fetchDataMock = vi.fn().mockResolvedValue({ photos: [] });
    const photosMod = {
      photoManifest: () => [],
      fetchData: fetchDataMock,
    };
    const cfg = { photos: { source: 'icloud', album: 'B1m5fk75vLWwX' } };
    const net = { fetchJSON: vi.fn() };

    const manifest = await resolvePhotosManifest(cfg, net, photosMod);

    // Returns [] — startSlideshow then hits `if (!manifest.length) return`
    // so slideshow stays null and the next applyMode() retry can recover.
    expect(manifest).toHaveLength(0);
    expect(fetchDataMock).toHaveBeenCalled(); // tried, but album was empty
  });
});

describe('ambientSource', () => {
  const ss = (source) => ({ source, strip: true });

  it('follows the dedicated screensaver picker', () => {
    expect(ambientSource({ widgets: ['art'], screensaver: ss('art') })).toBe('art');
    expect(ambientSource({ widgets: ['photos'], photos: { album: 'B1m5fk75vLWwX' }, screensaver: ss('photos') })).toBe('photos');
    expect(ambientSource({ widgets: [], screensaver: ss('off') })).toBe(null); // defensive guard (picker no longer offers Off)
    expect(ambientSource({ widgets: [], screensaver: ss('clock') })).toBe('clock');
    expect(ambientSource({ widgets: [], screensaver: ss('worldclocks') })).toBe('worldclocks');
    expect(ambientSource({ widgets: [], screensaver: ss('clockrow') })).toBe('clockrow');
  });

  it('no source requires its widget on the dashboard', () => {
    // art fetches its manifest directly; photo sources need only their album.
    expect(ambientSource({ widgets: [], screensaver: ss('art') })).toBe('art');
    expect(ambientSource({ widgets: [], photos: { album: 'B1m5fk75vLWwX' }, screensaver: ss('photos') })).toBe('photos');
  });

  it('degrades a broken photo source to the art slideshow', () => {
    expect(ambientSource({ widgets: [], photos: { album: '' }, screensaver: ss('photos') })).toBe('art');
    expect(ambientSource({ widgets: [], gdrivephotos: { album: '' }, screensaver: ss('gdrivephotos') })).toBe('art');
  });
});

describe('stripData temperature units', () => {
  it('carries the weather condition alongside the temp', () => {
    const caches = { weather: { now: { temp: 84, label: 'Mostly clear' } } };
    expect(stripData(caches, { widgets: ['weather'] }).cond).toBe('Mostly clear');
    expect(stripData({}, { widgets: [] }).cond).toBeNull(); // no weather -> no cond
  });

  it('converts the strip temp to the configured unit', () => {
    const caches = { weather: { now: { temp: 84 } } };
    expect(stripData(caches, { widgets: ['weather'], loc: { units: 'C' } }).temp).toBe(29);
    expect(stripData(caches, { widgets: ['weather'], loc: { units: 'F' } }).temp).toBe(84);
    expect(stripData(caches, { widgets: ['weather'] }).temp).toBe(84); // no loc → F default
  });
});

// Sean's pick C (2026-11-13): a source the dashboard holds stale leaves the
// strip, rather than showing an old number the card would have dimmed and
// stamped. The registry is module state, so every test leaves it empty.
describe('stripData drops stale sources', () => {
  const NOW = 1_800_000_000;
  const caches = {
    weather: { now: { temp: 84, label: 'Mostly clear' } },
    lirr: { departures: [{ t: NOW + 8 * 60, dest: 'Port Washington', track: '17' }] },
    njt: { trains: [{ time: NOW + 12 * 60, dest: 'Trenton', track: '3' }] },
  };
  const cfg = { widgets: ['weather', 'lirr', 'njt'] };
  const staleOf = (...ids) => (id) => ids.includes(id);
  afterEach(() => { for (const id of ['weather', 'lirr', 'mnr', 'njt']) setStripSourceStale(id, false); });

  it('shows everything when every source is fresh (nothing changes)', () => {
    const out = stripData(caches, cfg, { nowSec: NOW, isStale: staleOf() });
    expect(out.temp).toBe(84);
    expect(out.transit.map((t) => t.label)).toEqual(['LIRR · Port Washington · Track 17', 'NJT · Trenton · Track 3']);
  });

  it('a stale source drops only its own segment', () => {
    const wx = stripData(caches, cfg, { nowSec: NOW, isStale: staleOf('weather') });
    expect(wx.temp).toBeNull();
    expect(wx.cond).toBeNull();
    expect(wx.transit).toHaveLength(2);
    const lirr = stripData(caches, cfg, { nowSec: NOW, isStale: staleOf('lirr') });
    expect(lirr.temp).toBe(84);
    expect(lirr.transit.map((t) => t.label)).toEqual(['NJT · Trenton · Track 3']);
  });

  it('with every source stale the strip is the clock alone', () => {
    const out = stripData(caches, cfg, { nowSec: NOW, isStale: staleOf('weather', 'lirr', 'njt') });
    expect(out).toEqual({ temp: null, cond: null, transit: [] });
    const html = stripHtml(out, new Date('2026-07-03T21:30:00'));
    expect(html).toContain('strip__time');
    expect(html).not.toContain('strip__wx');
    expect(html).not.toContain('strip__transit');
  });

  it('reads the shared registry by default, so every strip host agrees', () => {
    // The screensaver, the art viewer and the settings preview all call
    // stripData without an isStale: one state, no second code path.
    setStripSourceStale('weather', true);
    expect(stripData(caches, cfg, { nowSec: NOW }).temp).toBeNull();
    setStripSourceStale('weather', false);
    expect(stripData(caches, cfg, { nowSec: NOW }).temp).toBe(84);
  });

  it('an empty registry (a board just booted from cache) shows the cached values', () => {
    for (const id of ['weather', 'lirr', 'njt']) expect(isStripSourceStale(id)).toBe(false);
    const out = stripData(caches, cfg, { nowSec: NOW });
    expect(out.temp).toBe(84);
    expect(out.transit).toHaveLength(2);
  });

  it('notifies on a flip, and only on a flip', () => {
    const seen = [];
    const off = onStripStaleChange((id, stale) => seen.push(`${id}:${stale}`));
    setStripSourceStale('lirr', true);
    setStripSourceStale('lirr', true); // already stale: no redraw
    setStripSourceStale('lirr', false);
    setStripSourceStale('lirr', false);
    off();
    setStripSourceStale('lirr', true); // unsubscribed
    expect(seen).toEqual(['lirr:true', 'lirr:false']);
  });
});

// main.js boots the board at module scope, so its wiring is read as text (the
// shell.test.js precedent). What matters: the strip's stale state follows the
// FETCH outcomes, never the boot restore from cache, and a flip redraws.
describe('main.js feeds the strip the card\'s stale state', () => {
  const main = readFileSync(resolve(process.cwd(), 'site/js/main.js'), 'utf8');
  const startWidget = main.slice(main.indexOf('function startWidget('), main.indexOf('function renderStrip('));
  const bootRestore = startWidget.slice(startWidget.indexOf('if (cached) {'), startWidget.indexOf('const cancel = schedule('));
  const fetchTry = startWidget.slice(startWidget.indexOf('try {'), startWidget.indexOf('} catch (err) {'));
  const fetchCatch = startWidget.slice(startWidget.indexOf('} catch (err) {'), startWidget.indexOf('throw err;'));

  it('the boot restore dims the card but leaves the strip alone', () => {
    expect(bootRestore).toContain('markStale(');
    expect(bootRestore).not.toContain('setStripSourceStale');
  });
  it('a settled fetch sets the strip from vm.stale, a thrown one marks it stale', () => {
    expect(fetchTry).toMatch(/setStripSourceStale\(mod\.meta\.id, Boolean\(vm\?\.stale\)\)/);
    expect(fetchCatch).toMatch(/setStripSourceStale\(mod\.meta\.id, true\)/);
  });
  it('redraws the strip whenever a source flips', () => {
    expect(main).toMatch(/onStripStaleChange\(\(\) => renderStrip\(\)\)/);
  });
});

// Sean's pick B (2026-11-13), "use the black bar": pure geometry, against a
// 1920 x 1040 board. Contain fit centres a narrower picture at full height.
describe('captionPlacement', () => {
  const box = { boxW: 1920, boxH: 1040 };
  const at = (natW, natH, fit) => captionPlacement({ ...box, natW, natH, fit });
  // A picture of aspect `ar` leaves a side bar of (1920 - 1040 ar) / 2, and the
  // bar column is that minus the 48 px floor and the 32 px gap.
  const arForColumn = (col) => (1920 - 2 * (col + CAPTION_LEFT + 32)) / 1040;

  it('leaves a picture as wide as the screen, or wider, at today\'s spot', () => {
    expect(at(1920, 1040)).toBeNull(); // exact
    expect(at(1600, 600)).toBeNull(); // wide panorama, letterboxed top and bottom
  });
  it('leaves cover fit and an unknown natural size at today\'s spot', () => {
    expect(at(600, 800, 'cover')).toBeNull();
    expect(at(0, 0)).toBeNull();
    expect(at(undefined, undefined)).toBeNull(); // decode failed or not landed yet
    expect(captionPlacement({ boxW: 0, boxH: 0, natW: 600, natH: 800 })).toBeNull(); // hidden box
  });
  it('puts the plate on a 4:3 picture, 24 px in from its corner and held to its width', () => {
    // 4:3 at 1040 tall is 1387 wide: picture 267 to 1653, a 187 px column.
    const p = at(1200, 900);
    expect(p.bar).toBe(false);
    expect(p.left).toBe(291); // 266.7 + 24
    expect(p.bottom).toBe(CAPTION_BOTTOM);
    expect(p.left + p.maxWidth).toBeLessThanOrEqual(1653 - 24 + 1);
  });
  it('keeps the 48 px floor when the picture nearly fills the width', () => {
    const p = at(1880, 1040); // bar 20 px
    expect(p.bar).toBe(false);
    expect(p.left).toBe(CAPTION_LEFT);
    expect(p.bottom).toBe(CAPTION_BOTTOM);
  });
  it('a portrait just under the threshold stays on the picture, with the plate', () => {
    const p = captionPlacement({ ...box, natW: arForColumn(CAPTION_BAR_MIN - 1) * 1000, natH: 1000 });
    expect(p.bar).toBe(false);
    expect(p.left).toBeGreaterThan(CAPTION_LEFT + CAPTION_BAR_MIN); // right of the bar, on the art
  });
  it('a portrait just over the threshold moves wholly into the bar, no plate', () => {
    const p = captionPlacement({ ...box, natW: arForColumn(CAPTION_BAR_MIN + 1) * 1000, natH: 1000 });
    expect(p).toEqual({ bar: true, left: CAPTION_LEFT, bottom: CAPTION_BAR_BOTTOM, maxWidth: CAPTION_BAR_MIN + 1 });
  });
  it('never leaves the caption half on the bar: the column ends 32 px short of the picture', () => {
    // Madame X, 365 x 625: picture 656 to 1264, column 48 to 624.
    const p = at(365, 625);
    expect(p.bar).toBe(true);
    expect(p.left + p.maxWidth).toBeLessThanOrEqual(656 - 32);
  });
});

describe('createSlideshow places the caption from the decoded picture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The preload's natural size is the only input: every stub Image reports
    // the size encoded in its file name (w x h), or nothing for "unknown".
    vi.stubGlobal('Image', class {
      set src(v) {
        const m = /(\d+)x(\d+)/.exec(v);
        this.naturalWidth = m ? Number(m[1]) : 0;
        this.naturalHeight = m ? Number(m[2]) : 0;
        queueMicrotask(() => this.onload?.());
      }
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const board = () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 1920 });
    Object.defineProperty(host, 'clientHeight', { value: 1040 });
    return host;
  };

  it('moves into the bar for a portrait and back onto a wide picture, with the text swap', async () => {
    const host = board();
    const show = createSlideshow(
      [{ img: 'p-365x625.jpg', title: 'Portrait' }, { img: 'w-599x464.jpg', title: 'Wheat' }],
      host, { intervalMs: 1000, random: () => 0.99 },
    );
    show.start();
    const cap = host.querySelector('.slide-caption');
    const seen = {};
    for (const ms of [0, 1000]) {
      await vi.advanceTimersByTimeAsync(ms);
      seen[cap.textContent] = { bar: cap.classList.contains('slide-caption--bar'), left: cap.style.left, bottom: cap.style.bottom };
    }
    show.stop();
    // Portrait (365 x 625): a 576 px column in the bar, plain text.
    expect(seen.Portrait).toEqual({ bar: true, left: '48px', bottom: '96px' });
    // Wheat (599 x 464): the bar is too narrow, so the plate sits on the
    // picture, 24 px in from its left edge at 289.
    expect(seen.Wheat).toEqual({ bar: false, left: '313px', bottom: '82px' });
  });

  it('a picture whose size is unknown keeps the default spot (no inline position)', async () => {
    const host = board();
    const show = createSlideshow([{ img: 'unknown.jpg', title: 'Mystery' }], host, { intervalMs: 1000 });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    const cap = host.querySelector('.slide-caption');
    expect(cap.textContent).toBe('Mystery');
    expect(cap.style.left).toBe('');
    expect(cap.style.bottom).toBe('');
    expect(cap.classList.contains('slide-caption--bar')).toBe(false);
    show.stop();
  });

  it('cover fit leaves the caption where it is today', async () => {
    const host = board();
    const show = createSlideshow([{ img: 'p-365x625.jpg', title: 'Portrait' }], host, { intervalMs: 1000, fit: 'cover' });
    show.start();
    await vi.advanceTimersByTimeAsync(0);
    const cap = host.querySelector('.slide-caption');
    expect(cap.style.left).toBe('');
    expect(cap.classList.contains('slide-caption--bar')).toBe(false);
    show.stop();
  });
});
