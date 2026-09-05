/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSlideshow, swipeFadeThrough, SWIPE_OUT_MS } from '../site/js/imageshow.js';
import { stripData, stripHtml } from '../site/js/ambient.js';
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
    expect(out.transit[0].label).toContain('Tk 3');
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

  it('skips fetchData() when photoManifest() is already populated (warm cache)', async () => {
    const photo = { img: 'https://example.com/cached.jpg', ar: 1.5, title: 'Cached' };
    const fetchDataMock = vi.fn();
    const photosMod = {
      photoManifest: () => [photo], // warm: render() ran earlier
      fetchData: fetchDataMock,
    };
    const cfg = { photos: { source: 'icloud', album: 'B1m5fk75vLWwX' } };
    const net = { fetchJSON: vi.fn() };

    const manifest = await resolvePhotosManifest(cfg, net, photosMod);

    expect(fetchDataMock).not.toHaveBeenCalled();
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toBe(photo);
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
