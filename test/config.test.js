import { describe, it, expect } from 'vitest';
import {
  isAddable,
  isAdvancedHidden,
  isBetaHost,
  isLaunched,
  isRetired,
  DEFAULT_CONFIG,
  normalizeConfig,
  encodeConfig,
  decodeConfig,
  encodePhotosCode,
  decodeCode,
  pickNewest,
  WIDGET_IDS,
  WIDGET_GROUPS,
  encodeVideoCode,
  RETIRED_AFTER,
} from '../site/js/config.js';
import { CHART_TOPICS } from '../site/js/widgets/chart-topics.js';

describe('normalizeConfig', () => {
  it('fills v3 defaults for an empty object', () => {
    const cfg = normalizeConfig({});
    expect(cfg.v).toBe(3);
    expect(cfg.layout).toEqual(DEFAULT_CONFIG.layout);
    expect(cfg.widgets).toEqual(cfg.layout.map((r) => r.id)); // derived
    expect(cfg.mode).toBe('dashboard');
    expect(cfg.theme).toBeUndefined(); // theme machinery retired: single baked-in look
    expect(cfg.loc).toEqual({ lat: 40.7506, lon: -73.9971, label: 'New York 10001', units: 'F' });
    expect(cfg.lirr).toEqual({ dest: '', alerts: true, origin: 'penn' });
    expect(cfg.mnr).toEqual({ dest: '', alerts: true });
    expect(cfg.bus).toEqual({ legs: [] });
    expect(cfg.markets).toEqual({ symbols: ['^DJI', '^IXIC', '^GSPC'] });
    expect(normalizeConfig({ v: 2, markets: { symbols: [] } }).markets.symbols).toEqual(['^DJI', '^IXIC', '^GSPC']);
    expect(normalizeConfig({ v: 2, markets: { symbols: ['aapl', '^GSPC', 'bad ticker!', 'MSFT'] } }).markets.symbols).toEqual(['AAPL', '^GSPC', 'MSFT']);
    expect(normalizeConfig({ v: 2, bus: { stops: ['550685', 'junk', '12'] } }).bus).toEqual({ legs: [] });
  });

  it('keeps 20 tickers and drops the 21st', () => {
    // The wall shows every configured ticker at once, and 20 is the count that
    // still fits the 1920x1080 overlay without scrolling (see expand.test.js).
    const want = Array.from({ length: 20 }, (_, i) => `TK${String(i).padStart(2, '0')}`);
    const kept = normalizeConfig({ v: 2, markets: { symbols: [...want, 'TK20'] } }).markets.symbols;
    expect(kept).toEqual(want);
    expect(kept).toHaveLength(20);
    expect(kept).not.toContain('TK20');
  });

  it('migrates a v1 config: widgets->layout, lirr, Midtown loc', () => {
    const cfg = normalizeConfig({
      v: 1,
      name: 'Sean',
      widgets: ['weather', 'lirr', 'bogus'],
      subway: { lines: ['4', '5'] },
      lirr: { orig: '237', dest: 'PWS' },
      loc: { lat: 40.754, lon: -73.984, label: 'Midtown' },
      mode: 'ambient',
    });
    expect(cfg.v).toBe(3);
    expect(cfg.widgets).toEqual(['weather', 'lirr']); // unknown ids dropped
    const lirr = cfg.layout.find((r) => r.id === 'lirr');
    expect(lirr.w).toBeGreaterThanOrEqual(2);
    expect(cfg.lirr).toEqual({ dest: 'PWS', alerts: true, origin: 'penn' }); // v1 dest carries into the v2 filter
    expect(cfg.loc.label).toBe('New York 10001'); // old default replaced
    expect(cfg.mode).toBe('ambient');
  });

  it('keeps a customized v1 location during migration', () => {
    const cfg = normalizeConfig({ v: 1, loc: { lat: 41.03, lon: -73.76, label: 'White Plains' } });
    expect(cfg.loc.label).toBe('White Plains');
  });

  it('normalizes a v2 layout (clamps, resolves overlap, keeps branches)', () => {
    const cfg = normalizeConfig({
      v: 2,
      layout: [
        { id: 'weather', x: 0, y: 0, w: 3, h: 2 },
        { id: 'markets', x: 1, y: 1, w: 2, h: 1 }, // overlaps weather -> re-placed
      ],
      lirr: { dest: '171' },
    });
    expect(cfg.layout).toHaveLength(2);
    expect(cfg.layout[1].y).toBe(0); // moved out of weather's rect
    expect(cfg.lirr.dest).toBe('171');
  });

  it('defaults transit alerts on, honors explicit opt-out', () => {
    expect(normalizeConfig({}).njt.alerts).toBe(true);
    const cfg = normalizeConfig({ v: 2, lirr: { dest: '', alerts: false } });
    expect(cfg.lirr.alerts).toBe(false);
    expect(cfg.njt.alerts).toBe(true);
  });

  it('defaults the subway status board to the Penn lines and art to 30 min', () => {
    const cfg = normalizeConfig({});
    expect(cfg.subway.lines).toEqual(['1', '2', '3']);
    expect(cfg.art).toEqual({ every: 30, cats: [] });
    const custom = normalizeConfig({ v: 2, subway: { lines: ['G'] }, art: { every: 5, cats: ['asian', 'bogus'] } });
    expect(custom.subway.lines).toEqual(['G']);
    expect(custom.art).toEqual({ every: 5, cats: ['asian'] });
  });

  it('defaults worldclock to the five offices and validates custom cities', () => {
    const cfg = normalizeConfig({});
    expect(cfg.worldclock.cities).toHaveLength(5);
    expect(cfg.worldclock.cities[0]).toEqual({ label: 'New York', zone: 'America/New_York' });
    expect(cfg.worldclock.cities.map((c) => c.label)).toContain('San Francisco');

    const custom = normalizeConfig({ v: 3, worldclock: { cities: [
      { label: 'Tokyo', zone: 'Asia/Tokyo' },
      { label: 'Nowhere', zone: 'Fake/Zone' },          // invalid zone -> dropped
      { label: 'Tokyo', zone: 'Asia/Tokyo' },            // dupe -> dropped
      { label: '', zone: 'Europe/Paris' },               // empty label -> dropped
      { label: 'A very very long label over 24 chars!!', zone: 'Europe/Paris' },
    ] } });
    expect(custom.worldclock.cities).toEqual([
      { label: 'Tokyo', zone: 'Asia/Tokyo' },
      { label: 'A very very long label o', zone: 'Europe/Paris' },
    ]);

    const many = normalizeConfig({ v: 3, worldclock: { cities: Array.from({ length: 14 }, (_, i) => ({ label: `City ${i}`, zone: 'Asia/Tokyo' })) } });
    expect(many.worldclock.cities).toHaveLength(10);

    expect(normalizeConfig({ v: 3, worldclock: { cities: [] } }).worldclock.cities).toHaveLength(5); // empty -> defaults
  });

  it('throws on non-objects and unknown future versions', () => {
    expect(() => normalizeConfig(null)).toThrow(TypeError);
    expect(() => normalizeConfig('x')).toThrow(TypeError);
    expect(() => normalizeConfig({ v: 4 })).toThrow(TypeError);
    expect(() => normalizeConfig({ v: 99 })).toThrow(TypeError);
  });

  it('clamps name length and invalid mode; drops legacy theme keys', () => {
    const cfg = normalizeConfig({ name: 'x'.repeat(99), mode: 'weird', theme: 'neon' });
    expect(cfg.name.length).toBeLessThanOrEqual(24);
    expect(cfg.mode).toBe('dashboard');
    expect(cfg.theme).toBeUndefined();
  });
});

describe('encode/decode round trip', () => {
  it('round-trips a full config', async () => {
    const cfg = normalizeConfig({
      v: 2,
      name: 'Sean',
      t: 1782000000,
      loc: { lat: 40.75, lon: -73.99, label: 'Chelsea' },
      layout: [
        { id: 'weather', x: 0, y: 0, w: 3, h: 2 },
        { id: 'subway', x: 3, y: 0, w: 2, h: 2 },
        { id: 'worldclock', x: 5, y: 0, w: 1, h: 2 },
        { id: 'lirr', x: 0, y: 2, w: 3, h: 2 },
        { id: 'markets', x: 3, y: 2, w: 3, h: 2 },
      ],
      subway: { lines: ['4', '5', '6'] },
      lirr: { dest: '171' },
      njt: { lines: ['Northeast Corridor Line', 'Morris & Essex Line'] },
      mode: 'scheduled',
      theme: 'momentum',
    });
    const enc = await encodeConfig(cfg);
    expect(typeof enc).toBe('string');
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    const dec = await decodeConfig(enc);
    expect(dec).toEqual(cfg);
  });

  it('stays small enough for URL fragments and setup flows', async () => {
    // A maximal config must leave ample headroom inside the 2048-char
    // signage URL, whose fragment now carries `#cfg=` and nothing else.
    const cfg = normalizeConfig({
      v: 2,
      name: 'Maximiliano Longname',
      t: 2000000000,
      subway: { lines: ['4', '5', '6', 'N', 'Q', 'R', 'A', 'C', 'E', 'L'] },
      lirr: { dest: '171' },
      mnr: { dest: '105' },
      njt: { lines: ['Northeast Corridor Line', 'North Jersey Coast Line', 'Morris & Essex Line', 'Montclair-Boonton Line', 'Gladstone Branch', 'Raritan Valley Line'] },
      bus: { stops: ['550685', '401234'] },
      sports: { teams: [{ lg: 'mlb', id: 'nym' }, { lg: 'nfl', id: 'nyj' }, { lg: 'nba', id: 'nyk' }, { lg: 'nhl', id: 'nyr' }, { lg: 'mls', id: 'nyc' }, { lg: 'epl', id: 'ars' }] },
      markets: { symbols: ['^DJI', '^IXIC', '^GSPC', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOG', 'META',
        'BRK-B', 'JPM', 'UNH', 'XOM', 'CBG.L', 'SAP.DE', '7203.T', 'GOOGL', 'AVGO', 'LLY'] },
      news: { sources: ['nyt-home', 'nyt-us', 'nyt-business', 'npr', 'bbc', 'nyt-nyregion', 'gothamist'] },
      substack: { pubs: Array.from({ length: 6 }, (_, i) => ({ id: `custompublication${i}`, label: `A Custom Publication Name ${i}` })) },
      bsky: { handles: Array.from({ length: 6 }, (_, i) => ({ id: `somelongname${i}.bsky.social`, label: `Custom Person Number ${i}` })) },
      worldclock: { cities: [
        { label: 'New York', zone: 'America/New_York' }, { label: 'San Francisco', zone: 'America/Los_Angeles' },
        { label: 'Kansas City', zone: 'America/Chicago' }, { label: 'Bermuda', zone: 'Atlantic/Bermuda' },
        { label: 'London', zone: 'Europe/London' }, { label: 'Luxembourg', zone: 'Europe/Luxembourg' },
        { label: 'Hyderabad', zone: 'Asia/Kolkata' }, { label: 'Hong Kong', zone: 'Asia/Hong_Kong' },
        { label: 'Shanghai', zone: 'Asia/Shanghai' }, { label: 'Singapore', zone: 'Asia/Singapore' },
      ] },
    });
    const enc = await encodeConfig(cfg);
    // The 2048-char URL leaves close to 2000 chars for the fragment (it used
    // to reserve ~100 for the retired bridge credentials, and no longer needs
    // to); the fully-maxed config (20 tickers, 10 clock cities, 7 feeds,
    // 12 fully-custom follow accounts, all 6 NJT line-name strings) measures
    // ~1345 — it was ~1280 when the ticker cap was 10 — so 1450 still guards
    // ~1.3x headroom. Default follow lists are stripped from the wire and
    // re-derived on decode, so untouched boards stay far smaller.
    expect(enc.length).toBeLessThan(1450);

    const plain = await encodeConfig(normalizeConfig({}));
    expect(plain.length).toBeLessThan(700); // starter lists never ship
  });

  // The user arranges markets.symbols by hand and the card fills from the top
  // of it down, so order is DATA. This pins the guard rail: never add an
  // order-insensitive `sameSet` strip for markets the way chart.topics has
  // one — it would erase a deliberate permutation of the starter three the
  // moment it happened to be one.
  it('keeps a reordered ticker list through a setup code', async () => {
    const shuffled = ['^GSPC', '^DJI', '^IXIC']; // a permutation of the defaults
    const cfg = normalizeConfig({ markets: { symbols: shuffled } });
    expect(cfg.markets.symbols).toEqual(shuffled); // normalizeConfig does not sort
    const dec = await decodeConfig(await encodeConfig(cfg));
    expect(dec.markets.symbols).toEqual(shuffled);
    // ...and it costs bytes, because it reached the wire at all.
    expect((await encodeConfig(cfg)).length).toBeGreaterThan((await encodeConfig(normalizeConfig({}))).length - 1);

    const custom = normalizeConfig({ markets: { symbols: ['CSCO', 'AAPL', '^DJI', 'MSFT'] } });
    expect((await decodeConfig(await encodeConfig(custom))).markets.symbols)
      .toEqual(['CSCO', 'AAPL', '^DJI', 'MSFT']);
  });

  it('carries the Sports News picks through a setup code, default free', async () => {
    const plain = await encodeConfig(normalizeConfig({}));
    expect((await encodeConfig(normalizeConfig({ sportsnews: {} }))).length).toBe(plain.length);
    const custom = normalizeConfig({ sportsnews: { sources: ['espn'], onlyMyTeams: true } });
    const dec = await decodeConfig(await encodeConfig(custom));
    expect(dec.sportsnews).toEqual({ sources: ['espn'], sports: [], onlyMyTeams: true });
  });

  it('throws on corrupt input', async () => {
    await expect(decodeConfig('!!!not-base64url!!!')).rejects.toThrow();
    await expect(decodeConfig('AAAA')).rejects.toThrow();
    await expect(decodeConfig('')).rejects.toThrow();
  });
});

describe('pickNewest', () => {
  const a = { v: 1, t: 100 };
  const b = { v: 1, t: 200 };
  it('handles nulls', () => {
    expect(pickNewest(null, null)).toBeNull();
    expect(pickNewest(a, null)).toBe(a);
    expect(pickNewest(null, b)).toBe(b);
  });
  it('picks higher t', () => {
    expect(pickNewest(a, b)).toBe(b);
    expect(pickNewest(b, a)).toBe(b);
  });
  it('treats missing t as 0', () => {
    expect(pickNewest({ v: 1 }, a)).toBe(a);
  });
});

describe('path/ferry/wotd config (v3 additive)', () => {
  it('defaults path to 33rd St NJ-bound and ferry to East 34th St', () => {
    const cfg = normalizeConfig({});
    expect(cfg.path).toEqual({ station: '33S', dir: 'ToNJ' });
    expect(cfg.ferry).toEqual({ landing: '17' });
  });
  it('keeps valid values and falls back on junk', () => {
    const cfg = normalizeConfig({ path: { station: 'HOB', dir: 'ToNY' }, ferry: { landing: '87' } });
    expect(cfg.path).toEqual({ station: 'HOB', dir: 'ToNY' });
    expect(cfg.ferry.landing).toBe('87');
    const bad = normalizeConfig({ path: { station: 'X;DROP', dir: 'sideways' }, ferry: { landing: 'x' } });
    expect(bad.path).toEqual({ station: '33S', dir: 'ToNJ' });
    expect(bad.ferry.landing).toBe('17');
  });
  it('accepts the new ids in layouts', () => {
    const cfg = normalizeConfig({ layout: [
      { id: 'path', x: 0, y: 0, w: 3, h: 3 },
      { id: 'ferry', x: 3, y: 0, w: 3, h: 3 },
      { id: 'wotd', x: 6, y: 0, w: 2, h: 2 },
    ] });
    expect(cfg.widgets).toEqual(['path', 'ferry', 'wotd']);
  });
});

describe('chart config (v3 additive)', () => {
  const ALL_SLUGS = CHART_TOPICS.map(([, slug]) => slug);

  it('defaults to politics-hidden with every topic on', () => {
    const cfg = normalizeConfig({});
    expect(cfg.chart).toEqual({ excludePolitics: true, topics: ALL_SLUGS });
    expect(DEFAULT_CONFIG.chart.topics).toEqual(ALL_SLUGS); // registry order, whole vocabulary
  });
  it('honors an explicit politics opt-out', () => {
    const cfg = normalizeConfig({ chart: { excludePolitics: false } });
    expect(cfg.chart.excludePolitics).toBe(false);
    expect(cfg.chart.topics).toEqual(ALL_SLUGS); // topics absent → still the default
  });
  it('keeps only valid slugs, deduped, and drops unknown/non-string ones', () => {
    expect(normalizeConfig({ chart: { topics: ['technology', 'sports'] } }).chart.topics).toEqual(['technology', 'sports']);
    expect(normalizeConfig({ chart: { topics: ['consumer goods'] } }).chart.topics).toEqual(['consumer goods']);
    expect(normalizeConfig({ chart: { topics: ['technology', 'technology'] } }).chart.topics).toEqual(['technology']);
    expect(normalizeConfig({ chart: { topics: ['technology', 'not-a-real-topic', 42] } }).chart.topics).toEqual(['technology']);
    // an explicit array of nothing but junk normalizes to [] (the global
    // listing), never to a bogus slug the worker would reject
    expect(normalizeConfig({ chart: { topics: ['not-a-real-topic', 7, null] } }).chart.topics).toEqual([]);
  });
  it('preserves an explicit empty topics list (every topic turned off → global listing)', () => {
    expect(normalizeConfig({ chart: { topics: [] } }).chart.topics).toEqual([]);
  });
  it('falls back to every topic when topics is absent, null, or malformed', () => {
    expect(normalizeConfig({ chart: {} }).chart.topics).toEqual(ALL_SLUGS);
    expect(normalizeConfig({ chart: { topics: null } }).chart.topics).toEqual(ALL_SLUGS);
    expect(normalizeConfig({ chart: { topics: 'technology' } }).chart.topics).toEqual(ALL_SLUGS); // not an array → default
  });
  it('migrates an old single-topic config to a one-element topics array', () => {
    expect(normalizeConfig({ chart: { topic: 'sports' } }).chart.topics).toEqual(['sports']);
    // an invalid legacy slug is no migration at all → the all-topics default
    expect(normalizeConfig({ chart: { topic: 'not-a-real-topic' } }).chart.topics).toEqual(ALL_SLUGS);
    // a present topics array wins over the legacy topic field
    expect(normalizeConfig({ chart: { topic: 'sports', topics: ['technology'] } }).chart.topics).toEqual(['technology']);
  });
  it('strips a default chart from the wire but keeps a customized one', async () => {
    const plainDec = await decodeConfig(await encodeConfig(normalizeConfig({})));
    expect(plainDec.chart).toEqual({ excludePolitics: true, topics: ALL_SLUGS }); // re-derived on decode
    const custom = normalizeConfig({ chart: { excludePolitics: false, topics: ['sports', 'technology'] } });
    const dec = await decodeConfig(await encodeConfig(custom));
    expect(dec.chart).toEqual({ excludePolitics: false, topics: ['sports', 'technology'] });
  });
  it('strips an all-topics selection whatever order it was toggled in', async () => {
    const shuffled = normalizeConfig({ chart: { topics: [...ALL_SLUGS].reverse() } });
    const enc = await encodeConfig(shuffled);
    expect(enc.length).toBe((await encodeConfig(normalizeConfig({}))).length); // topics never reached the wire
    expect((await decodeConfig(enc)).chart.topics).toEqual(ALL_SLUGS); // re-derived in registry order
  });
  it('keeps an explicit empty topics list on the wire (all-off is not the default)', async () => {
    const allOff = normalizeConfig({ chart: { topics: [] } });
    const enc = await encodeConfig(allOff);
    expect(enc.length).toBeGreaterThan((await encodeConfig(normalizeConfig({}))).length);
    expect((await decodeConfig(enc)).chart).toEqual({ excludePolitics: true, topics: [] });
  });
  it('round-trips a partial selection plus the default politics filter', async () => {
    const partial = normalizeConfig({ chart: { topics: ['finance', 'health', 'science'] } });
    const dec = await decodeConfig(await encodeConfig(partial));
    expect(dec.chart).toEqual({ excludePolitics: true, topics: ['finance', 'health', 'science'] });
  });
  it('round-trips a politics opt-out with the default (all) topics', async () => {
    const noFilter = normalizeConfig({ chart: { excludePolitics: false } });
    const dec = await decodeConfig(await encodeConfig(noFilter));
    expect(dec.chart).toEqual({ excludePolitics: false, topics: ALL_SLUGS });
  });
});

describe('substack/bsky config', () => {
  it('defaults to the starter accounts and sanitizes entries', () => {
    const cfg = normalizeConfig({});
    expect(cfg.substack.pubs).toEqual(DEFAULT_CONFIG.substack.pubs.map((a) => ({ ...a })));
    expect(cfg.bsky.handles).toEqual(DEFAULT_CONFIG.bsky.handles.map((a) => ({ ...a })));
    // Emptied lists fall back to the starters (markets-tickers convention).
    expect(normalizeConfig({ substack: { pubs: [] } }).substack.pubs.length).toBe(5);
    const filled = normalizeConfig({
      substack: { pubs: [{ id: 'astralcodexten', label: 'ACX' }, { id: 'Bad Slug!', label: 'x' }] },
      bsky: { handles: [{ id: 'nytimes.com', label: 'NYT' }] },
    });
    expect(filled.substack.pubs).toEqual([{ id: 'astralcodexten', label: 'ACX' }]);
    expect(filled.bsky.handles).toEqual([{ id: 'nytimes.com', label: 'NYT' }]);
  });
  it('migrates the short-lived combined posts config', () => {
    const cfg = normalizeConfig({ posts: { accounts: [
      { net: 'substack', id: 'astralcodexten', label: 'ACX' },
      { net: 'bsky', id: 'nytimes.com', label: 'NYT' },
    ] } });
    expect(cfg.substack.pubs).toEqual([{ id: 'astralcodexten', label: 'ACX' }]);
    expect(cfg.bsky.handles).toEqual([{ id: 'nytimes.com', label: 'NYT' }]);
    expect(cfg.posts).toBeUndefined();
  });
});

describe('photos config (iCloud + GDrive widgets)', () => {
  const GDRIVE_ID = '1RHow60mcBwzMturimQSbziK3hqCvP2lz';
  it('defaults both blocks empty and sanitizes each', () => {
    const d = normalizeConfig({});
    expect(d.photos).toEqual({ album: '', every: 30 });
    expect(d.gdrivephotos).toEqual({ album: '', every: 30 });
    const cfg = normalizeConfig({
      photos: { album: 'B1m5fk75vLWwX', every: 15 },
      gdrivephotos: { album: GDRIVE_ID, every: 60 },
    });
    expect(cfg.photos).toEqual({ album: 'B1m5fk75vLWwX', every: 15 });
    expect(cfg.gdrivephotos).toEqual({ album: GDRIVE_ID, every: 60 });
    // Cross-shaped albums are rejected by the other block's rule.
    expect(normalizeConfig({ photos: { album: GDRIVE_ID } }).photos.album).toBe(''); // not an iCloud token
    expect(normalizeConfig({ gdrivephotos: { album: 'nope!' } }).gdrivephotos.album).toBe('');
    // every clamps like art.every (1–360 minutes)
    expect(normalizeConfig({ photos: { every: 0 } }).photos.every).toBe(1);
    expect(normalizeConfig({ gdrivephotos: { every: 999 } }).gdrivephotos.every).toBe(360);
  });
  it('migrates legacy per-widget screensaver booleans to cfg.screensaver', () => {
    const both = normalizeConfig({
      photos: { album: 'B1m5fk75vLWwX', screensaver: true },
      gdrivephotos: { album: GDRIVE_ID, screensaver: true },
    });
    expect(both.screensaver).toEqual({ source: 'photos', strip: true, markers: true, backdrop: false }); // iCloud wins the legacy tie
    expect(both.photos.screensaver).toBeUndefined(); // booleans retired from the blocks
    const gd = normalizeConfig({ gdrivephotos: { album: GDRIVE_ID, screensaver: true } });
    expect(gd.screensaver.source).toBe('gdrivephotos');
    const legacyDrive = normalizeConfig({ photos: { source: 'gdrive', album: GDRIVE_ID, screensaver: true } });
    expect(legacyDrive.screensaver.source).toBe('gdrivephotos'); // single-source-era Drive config
  });

  it('screensaver block: validates source, defaults, and wire round-trip', async () => {
    expect(normalizeConfig({}).screensaver).toEqual({ source: 'art', strip: true, markers: true, backdrop: false });
    expect(normalizeConfig({ screensaver: { source: 'nope' } }).screensaver.source).toBe('art');
    expect(normalizeConfig({ screensaver: { source: 'off' } }).screensaver.source).toBe('art'); // Off retired -> default
    expect(normalizeConfig({ screensaver: { source: 'worldclocks', strip: false } }).screensaver).toEqual({ source: 'worldclocks', strip: false, markers: true, backdrop: false });
    // Backdrop: opt-in boolean, default off, valid on any source (only rendered under clocks).
    expect(normalizeConfig({ screensaver: { source: 'clock', backdrop: true } }).screensaver.backdrop).toBe(true);
    expect(normalizeConfig({ screensaver: { source: 'clock' } }).screensaver.backdrop).toBe(false);
    // Landscapes rotation: user-adjustable minutes, default 30, clamped, wire round-trips.
    expect(normalizeConfig({}).landscapes).toEqual({ every: 30 });
    expect(normalizeConfig({ landscapes: { every: 60 } }).landscapes.every).toBe(60);
    const rtl = await decodeConfig(await encodeConfig(normalizeConfig({ landscapes: { every: 120 } })));
    expect(rtl.landscapes.every).toBe(120);
    expect(normalizeConfig({ screensaver: { source: 'worldclocks', markers: false } }).screensaver.markers).toBe(false);
    const rt = await decodeConfig(await encodeConfig(normalizeConfig({ screensaver: { source: 'clock', strip: false, markers: false, backdrop: true } })));
    expect(rt.screensaver).toEqual({ source: 'clock', strip: false, markers: false, backdrop: true });
    // Curated built-in source (e.g. Landscapes) is a valid, persistable choice —
    // no album needed since its folder is baked into CURATED_SOURCES.
    expect(normalizeConfig({ screensaver: { source: 'landscapes' } }).screensaver.source).toBe('landscapes');
    const rtc = await decodeConfig(await encodeConfig(normalizeConfig({ screensaver: { source: 'landscapes' } })));
    expect(rtc.screensaver.source).toBe('landscapes');
  });
  it('migrates the legacy single-source shape', () => {
    // Legacy iCloud: album stays on photos, gdrivephotos empty.
    const ic = normalizeConfig({ photos: { source: 'icloud', album: 'B1m5fk75vLWwX', screensaver: true, every: 15 } });
    expect(ic.photos).toEqual({ album: 'B1m5fk75vLWwX', every: 15 });
    expect(ic.gdrivephotos.album).toBe('');
    // Legacy Drive: album + screensaver move to gdrivephotos; photos empties;
    // a placed `photos` layout entry re-homes to `gdrivephotos`.
    const gd = normalizeConfig({
      layout: [{ id: 'photos', x: 0, y: 0, w: 2, h: 2 }],
      photos: { source: 'gdrive', album: GDRIVE_ID, screensaver: true, every: 60 },
    });
    expect(gd.photos).toEqual({ album: '', every: 60 });
    expect(gd.gdrivephotos).toEqual({ album: GDRIVE_ID, every: 60 });
    expect(gd.screensaver.source).toBe('gdrivephotos'); // choice migrated with the album
    expect(gd.layout.map((r) => r.id)).toContain('gdrivephotos');
    expect(gd.layout.map((r) => r.id)).not.toContain('photos');
  });
});

describe('staged rollout (BETA_ONLY widgets)', () => {
  it('iptv hides on prod hosts only; launched widgets show everywhere', () => {
    expect(isLaunched('iptv', 'roomboard.app')).toBe(false);
    expect(isLaunched('iptv', 'www.roomboard.app')).toBe(false);
    expect(isLaunched('iptv', 'unsleep.app')).toBe(false);
    expect(isLaunched('iptv', 'idlescreen.app')).toBe(false);
    expect(isLaunched('iptv', 'beta.roomboard.app')).toBe(true);
    expect(isLaunched('iptv', 'beta.idlescreen.app')).toBe(true);
    expect(isLaunched('iptv', 'signage.rvc.tech')).toBe(true);
    expect(isLaunched('iptv', 'localhost')).toBe(true);
    expect(isLaunched('weather', 'roomboard.app')).toBe(true);
    expect(isLaunched('weather', 'idlescreen.app')).toBe(true);
  });

  // The production host list is what the gate is actually made of: every
  // production domain serves the same board, so none may read as staging.
  it('isBetaHost treats every production domain as prod and everything else as beta', () => {
    expect(isBetaHost('roomboard.app')).toBe(false);
    expect(isBetaHost('www.roomboard.app')).toBe(false);
    expect(isBetaHost('unsleep.app')).toBe(false);
    expect(isBetaHost('idlescreen.app')).toBe(false);
    expect(isBetaHost('beta.idlescreen.app')).toBe(true);
    expect(isBetaHost('beta.roomboard.app')).toBe(true);
    expect(isBetaHost('beta.unsleep.app')).toBe(true);
    expect(isBetaHost('signage.rvc.tech')).toBe(true);
    expect(isBetaHost('localhost')).toBe(true);
  });
});

describe('nerd mode (ADVANCED_WIDGETS gate)', () => {
  it('defaults off, normalizes strictly, and stays off the wire when false', async () => {
    expect(normalizeConfig({}).nerdMode).toBe(false);
    expect(normalizeConfig({ nerdMode: 'yes' }).nerdMode).toBe(false); // boolean true only
    expect(normalizeConfig({ nerdMode: true }).nerdMode).toBe(true);
    const rt = await decodeConfig(await encodeConfig(normalizeConfig({ nerdMode: true })));
    expect(rt.nerdMode).toBe(true);
    const bare = await decodeConfig(await encodeConfig(normalizeConfig({})));
    expect(bare.nerdMode).toBe(false); // stripped on the wire, re-derived by normalize
  });

  it('hides advanced ids unless nerd mode is on', () => {
    expect(isAdvancedHidden('iptv', { nerdMode: false })).toBe(true);
    expect(isAdvancedHidden('iptv', null)).toBe(true);
    expect(isAdvancedHidden('iptv', { nerdMode: true })).toBe(false);
    expect(isAdvancedHidden('weather', { nerdMode: false })).toBe(false);
  });

  it('isAddable composes retired + launched + advanced (the one add-policy)', () => {
    // ordinary widget: always offerable, on any host
    expect(isAddable('weather', {}, 'roomboard.app')).toBe(true);
    // advanced widget: needs nerd mode
    expect(isAddable('iptv', { nerdMode: false }, 'beta.roomboard.app')).toBe(false);
    expect(isAddable('iptv', { nerdMode: true }, 'beta.roomboard.app')).toBe(true);
    // ...but the host gate still wins on prod even with nerd mode on
    expect(isAddable('iptv', { nerdMode: true }, 'roomboard.app')).toBe(false);
  });
});

// The mechanism outlived its only user: World Cup 2026 retired on 2026-07-20
// and its code left the tree on 2026-07-29, leaving the table empty. These
// tests keep the SUNSET RULE pinned so the next seasonal card inherits a
// working gate instead of re-deriving one — the boundary is tested against a
// synthetic table, since a real entry would sunset a real card.
describe('widget retirement (RETIRED_AFTER)', () => {
  it('is an empty frozen table today: nothing in the tree is retired', () => {
    expect(RETIRED_AFTER).toEqual({});
    expect(Object.isFrozen(RETIRED_AFTER)).toBe(true);
    for (const id of WIDGET_IDS) expect(isRetired(id, Date.UTC(2030, 0, 1)), id).toBe(false);
  });

  it('sunsets on the date, and the card lives through the whole day before it', () => {
    const table = { seasonal: Date.UTC(2026, 6, 20) };
    expect(isRetired('seasonal', Date.UTC(2026, 6, 19, 23, 59), table)).toBe(false); // final day, still live
    expect(isRetired('seasonal', Date.UTC(2026, 6, 20), table)).toBe(false); // the stroke of midnight is not yet past
    expect(isRetired('seasonal', Date.UTC(2026, 6, 20, 0, 0, 1), table)).toBe(true);
    expect(isRetired('seasonal', Date.UTC(2026, 7, 1), table)).toBe(true);
  });

  it('an id absent from the table is never retired, at any clock', () => {
    const table = { seasonal: Date.UTC(2026, 6, 20) };
    expect(isRetired('weather', Date.UTC(2030, 0, 1), table)).toBe(false);
    expect(isRetired('nonexistent', Date.UTC(2030, 0, 1), table)).toBe(false);
  });

  it('isAddable routes through it: a retired id is not offerable', () => {
    // isAddable reads the real (empty) table, so this asserts the composition
    // by way of the gate that IS populated; the retirement branch is covered
    // above. Both must hold for the one-predicate promise to mean anything.
    expect(isAddable('sports', DEFAULT_CONFIG, 'roomboard.app')).toBe(true);
    expect(isAddable('iptv', DEFAULT_CONFIG, 'roomboard.app')).toBe(false);
  });
});

// World Cup was deleted outright on 2026-07-29 while real boards had it placed
// and hour-old setup codes still encoded it. Dropping an id must be a non-event
// for those boards: the card goes, nothing else moves, and no path throws.
describe('a removed widget id in a stored config or an old setup code', () => {
  // A board configured before the removal: worldcup in the middle of the layout,
  // written on the wire exactly as encodeConfig would have written it.
  const STORED = Object.freeze({
    v: 3,
    t: 1784000000,
    name: 'Sean',
    layout: [
      { id: 'weather', x: 0, y: 0, w: 3, h: 5 },
      { id: 'worldcup', x: 3, y: 0, w: 3, h: 3 },
      { id: 'worldclock', x: 6, y: 0, w: 3, h: 3 },
      { id: 'subway', x: 9, y: 0, w: 3, h: 3 },
      { id: 'markets', x: 0, y: 5, w: 3, h: 3 },
    ],
  });

  it('decodes without throwing and drops only the removed card', () => {
    const cfg = normalizeConfig(STORED);
    expect(cfg.widgets).not.toContain('worldcup');
    expect(cfg.widgets).toEqual(['weather', 'worldclock', 'subway', 'markets']);
  });

  it('leaves every surviving card on the exact cell it was on', () => {
    const cfg = normalizeConfig(STORED);
    for (const kept of STORED.layout.filter((r) => r.id !== 'worldcup')) {
      expect(cfg.layout.find((r) => r.id === kept.id), kept.id).toEqual(kept);
    }
  });

  it('leaves the vacated cells EMPTY rather than reflowing the board', () => {
    const cfg = normalizeConfig(STORED);
    // x 3-5 / y 0-2 was the World Cup slot; nothing may slide into it.
    const occupies = (x, y) => cfg.layout.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    for (let y = 0; y < 3; y++) for (let x = 3; x < 6; x++) expect(occupies(x, y), `${x},${y}`).toBe(false);
  });

  it('survives a config that is ONLY the removed card, falling back to defaults', () => {
    // Every id dropping out is indistinguishable from "no layout given", so the
    // safety net applies rather than handing a board zero cards.
    const cfg = normalizeConfig({ v: 3, layout: [{ id: 'worldcup', x: 0, y: 0, w: 3, h: 3 }] });
    expect(cfg.layout).toEqual(DEFAULT_CONFIG.layout);
  });

  it('round-trips through a real v3 setup code, as an hour-old code would', async () => {
    const code = await encodeConfig(STORED);
    const cfg = await decodeConfig(code);
    expect(cfg.widgets).toEqual(['weather', 'worldclock', 'subway', 'markets']);
    expect(cfg.name).toBe('Sean');
  });

  it('migrates a v1 widgets list that names it', () => {
    const cfg = normalizeConfig({ v: 1, widgets: ['weather', 'worldcup', 'markets'] });
    expect(cfg.widgets).toEqual(['weather', 'markets']);
  });

  it('migrates a v2 layout that names it, doubling the survivors onto 12x8', () => {
    const cfg = normalizeConfig({
      v: 2,
      layout: [{ id: 'weather', x: 0, y: 0, w: 2, h: 2 }, { id: 'worldcup', x: 2, y: 0, w: 2, h: 2 }],
    });
    expect(cfg.widgets).toEqual(['weather']);
    expect(cfg.layout[0]).toEqual({ id: 'weather', x: 0, y: 0, w: 4, h: 4 });
  });
});

describe('video-only setup code (~V~)', () => {
  it('round-trips url + label and scopes as video', async () => {
    const code = await encodeVideoCode({ url: ' https://cdn.example.com/live/a.m3u8 ', label: ' Lobby cam ' });
    expect(code.startsWith('~V~')).toBe(true);
    const decoded = await decodeCode(code);
    expect(decoded.scope).toBe('video');
    expect(decoded.patch).toEqual({ url: 'https://cdn.example.com/live/a.m3u8', label: 'Lobby cam' });
  });

  it('drops junk urls and clamps the label on decode', async () => {
    const decoded = await decodeCode(await encodeVideoCode({ url: 'http://insecure.test/a.m3u8', label: 'x'.repeat(60) }));
    expect(decoded.patch.url).toBeUndefined();
    const ok = await decodeCode(await encodeVideoCode({ url: 'https://x.test/a.m3u8', label: 'x'.repeat(60) }));
    expect(ok.patch.label).toHaveLength(40);
  });

  it('full-config codes still decode as scope full', async () => {
    const full = await encodeConfig(normalizeConfig({}));
    expect((await decodeCode(full)).scope).toBe('full');
  });
});

describe('iptv config (Live Video)', () => {
  it('defaults to unconfigured and accepts an https stream + label', () => {
    expect(normalizeConfig({}).iptv).toEqual({ url: '', label: '' });
    const cfg = normalizeConfig({ iptv: { url: ' https://cdn.example.com/live/a.m3u8 ', label: '  Lobby cam  ' } });
    expect(cfg.iptv.url).toBe('https://cdn.example.com/live/a.m3u8');
    expect(cfg.iptv.label).toBe('Lobby cam');
  });

  it('drops non-https and junk urls (mixed content would be blocked anyway)', () => {
    expect(normalizeConfig({ iptv: { url: 'http://x.test/a.m3u8' } }).iptv.url).toBe('');
    expect(normalizeConfig({ iptv: { url: 'not a url' } }).iptv.url).toBe('');
    expect(normalizeConfig({ iptv: { url: 42 } }).iptv.url).toBe('');
  });

  it('clamps the label to 40 chars', () => {
    expect(normalizeConfig({ iptv: { label: 'x'.repeat(60) } }).iptv.label).toHaveLength(40);
  });

  it('stays off the wire when unconfigured, survives the round trip when set', async () => {
    const base = normalizeConfig({});
    const bare = await decodeConfig(await encodeConfig(base));
    expect(JSON.parse(JSON.stringify(bare)).iptv ?? { url: '', label: '' }).toEqual({ url: '', label: '' });
    const withStream = normalizeConfig({ iptv: { url: 'https://x.test/a.m3u8', label: 'Cam' } });
    const rt = await decodeConfig(await encodeConfig(withStream));
    expect(rt.iptv).toEqual({ url: 'https://x.test/a.m3u8', label: 'Cam' });
  });
});

describe('content-aware layout caps', () => {
  it('shrinks an over-tall worldclock/markets on load to the content fit', () => {
    const cfg = normalizeConfig({
      layout: [
        { id: 'worldclock', x: 0, y: 0, w: 3, h: 5 },
        { id: 'markets', x: 3, y: 0, w: 3, h: 5 },
      ],
      // 5 default cities and 3 default tickers -> both cap at 3 tall
    });
    expect(cfg.layout.find((r) => r.id === 'worldclock').h).toBe(3);
    expect(cfg.layout.find((r) => r.id === 'markets').h).toBe(3);
  });
  it('a longer list raises the cap', () => {
    const cfg = normalizeConfig({
      layout: [{ id: 'markets', x: 0, y: 0, w: 3, h: 4 }],
      markets: { symbols: ['^DJI', '^IXIC', '^GSPC', 'AAPL', 'MSFT'] },
    });
    expect(cfg.layout.find((r) => r.id === 'markets').h).toBe(4);
  });
});

describe('lirr origin', () => {
  it('defaults to penn and validates the terminal set', () => {
    expect(normalizeConfig({}).lirr.origin).toBe('penn');
    expect(normalizeConfig({ lirr: { origin: 'gct' } }).lirr.origin).toBe('gct');
    expect(normalizeConfig({ lirr: { origin: 'both' } }).lirr.origin).toBe('both');
    expect(normalizeConfig({ lirr: { origin: 'jfk' } }).lirr.origin).toBe('penn');
    // Pre-origin configs (no field at all) land on the historical Penn behavior.
    expect(normalizeConfig({ lirr: { dest: '102', alerts: true } }).lirr.origin).toBe('penn');
  });
});

describe('photos-only setup code', () => {
  const IC = 'B1m5fk75vLWwX';
  const GD = '1RHow60mcBwzMturimQSbziK3hqCvP2lz';
  it('round-trips both slots and marks the photos scope', async () => {
    const decoded = await decodeCode(await encodePhotosCode({ icloud: IC, gdrive: GD }));
    expect(decoded).toEqual({ scope: 'photos', patch: { icloud: IC, gdrive: GD } });
  });
  it('is sparse — only carries the slots that were filled', async () => {
    const one = await decodeCode(await encodePhotosCode({ icloud: IC }));
    expect(one).toEqual({ scope: 'photos', patch: { icloud: IC } });
    expect('gdrive' in one.patch).toBe(false);
  });
  it('drops invalid ids so a bad link never mints a slot', async () => {
    const decoded = await decodeCode(await encodePhotosCode({ icloud: 'nope!', gdrive: GD }));
    expect(decoded.patch).toEqual({ gdrive: GD });
  });
  it('a full-config code still decodes as scope:full', async () => {
    const encoded = await encodeConfig(normalizeConfig({ name: 'Sam' }));
    const decoded = await decodeCode(encoded);
    expect(decoded.scope).toBe('full');
    expect(decoded.cfg.name).toBe('Sam');
  });
});

describe('weather units', () => {
  it('defaults to F, preserves C, sanitizes junk', () => {
    expect(normalizeConfig({}).loc.units).toBe('F');
    expect(normalizeConfig({ loc: { label: 'X', lat: 1, lon: 2, units: 'C' } }).loc.units).toBe('C');
    expect(normalizeConfig({ loc: { label: 'X', lat: 1, lon: 2, units: 'K' } }).loc.units).toBe('F');
  });
});

describe('marketsnews config', () => {
  it('defaults to all sources except Seeking Alpha and filters junk ids', () => {
    const DEFAULTS = ['mw', 'wsj-markets', 'ft-markets', 'cnbc', 'nyt-business', 'yahoo-finance'];
    expect(normalizeConfig({}).marketsnews.sources).toEqual(DEFAULTS);
    expect(normalizeConfig({ marketsnews: { sources: ['cnbc', 'bogus'] } }).marketsnews.sources).toEqual(['cnbc']);
    expect(normalizeConfig({ marketsnews: { sources: [] } }).marketsnews.sources).toEqual(DEFAULTS);
  });
});

describe('sportsnews config', () => {
  // The Athletic joined the defaults 2026-07-31 (the first cut missed BOTH
  // config touchpoints: it was absent from this default list AND filtered out
  // of an explicit pick by the stale valid-set, so it could not be enabled
  // persistently at all).
  const DEFAULTS = ['espn', 'cbs-sports', 'yahoo-sports', 'the-athletic'];
  it('defaults to the US sources with the my-teams filter off, and filters junk ids', () => {
    expect(normalizeConfig({}).sportsnews).toEqual({ sources: DEFAULTS, sports: [], onlyMyTeams: false });
    expect(normalizeConfig({ sportsnews: { sources: ['espn', 'bogus'] } }).sportsnews.sources).toEqual(['espn']);
    expect(normalizeConfig({ sportsnews: { sources: [] } }).sportsnews.sources).toEqual(DEFAULTS);
  });
  it('keeps an explicit The Athletic pick across save and load', () => {
    expect(normalizeConfig({ sportsnews: { sources: ['the-athletic'] } }).sportsnews.sources).toEqual(['the-athletic']);
  });
  it('keeps valid sport chips, drops junk, defaults to all-sports (empty)', () => {
    expect(normalizeConfig({}).sportsnews.sports).toEqual([]);
    expect(normalizeConfig({ sportsnews: { sports: ['mlb', 'cricket', 'f1'] } }).sportsnews.sports).toEqual(['mlb', 'f1']);
    expect(normalizeConfig({ sportsnews: { sports: 'mlb' } }).sportsnews.sports).toEqual([]);
  });
  it('only turns the filter on for an explicit true', () => {
    expect(normalizeConfig({ sportsnews: { onlyMyTeams: true } }).sportsnews.onlyMyTeams).toBe(true);
    expect(normalizeConfig({ sportsnews: { onlyMyTeams: 'yes' } }).sportsnews.onlyMyTeams).toBe(false);
  });
});

describe('bus legs config', () => {
  it('defaults to empty legs', () => {
    expect(normalizeConfig({}).bus).toEqual({ legs: [] });
    expect(DEFAULT_CONFIG.bus).toEqual({ legs: [] });
  });
  it('migrates old stop-code config to empty legs', () => {
    expect(normalizeConfig({ bus: { stops: ['550789', '504123'] } }).bus).toEqual({ legs: [] });
  });
  it('keeps valid legs, caps at 2, drops junk, carries lineRef', () => {
    const legs = [
      { route: 'QM24', lineRef: 'MTABC_QM24', dir: 0, stopId: '550789', stopName: 'Madison Av / E 34 St' },
      { route: 'x27', lineRef: 'MTA NYCT_X27', dir: 1, stopId: '504123', stopName: 'Some Stop' }, // route case-insensitive
      { route: 'M15', lineRef: 'x', dir: 0, stopId: '1', stopName: 'x' },       // not express -> dropped
      { route: 'QM1', lineRef: 'x', dir: 5, stopId: '2', stopName: 'x' },       // bad dir -> dropped
      { route: 'QM2', lineRef: 'x', dir: 0, stopId: '', stopName: 'x' },        // empty stopId -> dropped
    ];
    const out = normalizeConfig({ bus: { legs } }).bus.legs;
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ route: 'QM24', lineRef: 'MTABC_QM24', dir: 0, stopId: '550789', stopName: 'Madison Av / E 34 St' });
    expect(out[1]).toEqual({ route: 'x27', lineRef: 'MTA NYCT_X27', dir: 1, stopId: '504123', stopName: 'Some Stop' });
  });
});

describe('parseDriveFolder', () => {
  const ID = '1RHow60mcBwzMturimQSbziK3hqCvP2lz';
  const load = async () => (await import('../site/js/util.js')).parseDriveFolder;
  it('extracts the id from shared links', async () => {
    const parseDriveFolder = await load();
    expect(parseDriveFolder(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toBe(ID);
    expect(parseDriveFolder(`https://drive.google.com/drive/u/0/folders/${ID}`)).toBe(ID);
  });
  it('accepts a bare id and rejects junk', async () => {
    const parseDriveFolder = await load();
    expect(parseDriveFolder(ID)).toBe(ID);
    expect(parseDriveFolder('not a link')).toBeNull();
    expect(parseDriveFolder('')).toBeNull();
  });
});

describe('services config', () => {
  const DEFAULT_TRIO = ['webex', 'slack', 'm365'];
  it('defaults to Webex/Slack/M365 and filters junk ids', () => {
    expect(normalizeConfig({}).services.list).toEqual(DEFAULT_TRIO);
    expect(normalizeConfig({ services: { list: ['zoom', 'bogus'] } }).services.list).toEqual(['zoom']);
    expect(normalizeConfig({ services: { list: [] } }).services.list).toEqual(DEFAULT_TRIO);
  });
  it('keeps every non-default service a board already picked (ids validate against the full menu)', () => {
    const picked = ['zoom', 'ubiquiti', 'cloudflare', 'github', 'gworkspace', 'aws', 'claude', 'openai'];
    expect(normalizeConfig({ services: { list: picked } }).services.list).toEqual(picked);
  });
});

describe('apod widget id', () => {
  it('apod is a valid, grouped widget id', () => {
    expect(WIDGET_IDS).toContain('apod');
    expect(WIDGET_GROUPS.flatMap((g) => g.ids)).toContain('apod');
  });
});

describe('citibike config', () => {
  it('defaults to 3 office stations and caps custom at 6', () => {
    expect(normalizeConfig({}).citibike.stations).toHaveLength(3);
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, name: `S${i}` }));
    expect(normalizeConfig({ citibike: { stations: many } }).citibike.stations).toHaveLength(6);
    expect(normalizeConfig({ citibike: { stations: [{ id: 'a' }] } }).citibike.stations).toHaveLength(3);
  });
  it('strips a default citibike from the wire (custom is longer)', async () => {
    const def = await encodeConfig(normalizeConfig({}));
    const custom = await encodeConfig(normalizeConfig({ citibike: { stations: [{ id: 'zzzzzzzz-0000-0000-0000-000000000000', name: 'Custom Station Far Away' }] } }));
    expect(custom.length).toBeGreaterThan(def.length);
  });
});

describe('tfl config', () => {
  it('defaults to the 11 tube lines and drops junk ids', () => {
    expect(normalizeConfig({}).tfl.lines).toHaveLength(11);
    expect(normalizeConfig({ tfl: { lines: ['central', 'nope', 'central'] } }).tfl.lines).toEqual(['central']);
    expect(normalizeConfig({ tfl: { lines: [] } }).tfl.lines).toHaveLength(11);
  });
  it('strips a default tfl from the wire (custom is longer)', async () => {
    const def = await encodeConfig(normalizeConfig({}));
    const custom = await encodeConfig(normalizeConfig({ tfl: { lines: ['central', 'elizabeth', 'dlr'] } }));
    expect(custom.length).toBeGreaterThan(def.length);
  });
});

describe('config injection hardening', () => {
  it('strips HTML-special chars from worldclock labels', () => {
    const wc = normalizeConfig({ worldclock: { cities: [{ label: '<svg onload=alert(1)>', zone: 'America/New_York' }] } }).worldclock.cities;
    expect(wc).toHaveLength(1);
    expect(wc[0].label).not.toMatch(/[<>"'&]/);
  });
  it('drops sports teams whose lg/id fall outside the safe charset', () => {
    const teams = normalizeConfig({ sports: { teams: [
      { lg: '"><img src=x onerror=alert(1)>', id: 'a' },
      { lg: 'eng.1', id: '359' },
    ] } }).sports.teams;
    expect(teams.map((t) => t.lg)).toEqual(['eng.1']);
  });
});

describe('mode + schedule', () => {
  it('migrates legacy auto → scheduled with the default windows', () => {
    const c = normalizeConfig({ mode: 'auto' });
    expect(c.mode).toBe('scheduled');
    expect(c.schedule).toEqual([{ start: 360, end: 600 }, { start: 900, end: 1200 }]);
  });
  it('normalizes schedule: 15-min round, clamp, drop start>=end, cap 4, default when empty', () => {
    const s = normalizeConfig({ schedule: [
      { start: 367, end: 597 },  // 367→360, 597→600 (nearest 15)
      { start: 700, end: 700 },  // 705==705 after rounding → start>=end, dropped
      { start: -30, end: 5000 }, // clamps to 0..1440
    ] }).schedule;
    expect(s).toEqual([{ start: 360, end: 600 }, { start: 0, end: 1440 }]);
    expect(normalizeConfig({ schedule: [] }).schedule).toHaveLength(2);
    expect(normalizeConfig({ schedule: Array(9).fill({ start: 60, end: 120 }) }).schedule).toHaveLength(4);
  });
  it('strips a default schedule from the wire (custom is longer)', async () => {
    const def = await encodeConfig(normalizeConfig({}));
    const custom = await encodeConfig(normalizeConfig({ mode: 'scheduled', schedule: [{ start: 480, end: 1020 }] }));
    expect(custom.length).toBeGreaterThan(def.length);
  });
});

describe('usage beacon flag', () => {
  it('defaults on, honors explicit opt-out, survives the wire', async () => {
    expect(normalizeConfig({}).beacon).toBe(true);
    expect(normalizeConfig({ beacon: false }).beacon).toBe(false);
    const dec = await decodeConfig(await encodeConfig(normalizeConfig({ beacon: false })));
    expect(dec.beacon).toBe(false);
  });
  it('strips the default (true) from the wire', async () => {
    const def = await encodeConfig(normalizeConfig({}));
    const optOut = await encodeConfig(normalizeConfig({ beacon: false }));
    expect(optOut.length).toBeGreaterThan(def.length);
  });
});

describe('clock 12/24-hour flag', () => {
  it('defaults off (12h), honors explicit 24h, survives the wire', async () => {
    expect(normalizeConfig({}).clock24).toBe(false);
    expect(normalizeConfig({ clock24: true }).clock24).toBe(true);
    expect(normalizeConfig({ clock24: false }).clock24).toBe(false);
    expect(normalizeConfig({ clock24: 'yes' }).clock24).toBe(false); // only literal true counts
    const dec = await decodeConfig(await encodeConfig(normalizeConfig({ clock24: true })));
    expect(dec.clock24).toBe(true);
  });
  it('strips the default (false) from the wire', async () => {
    const def = await encodeConfig(normalizeConfig({}));
    const on = await encodeConfig(normalizeConfig({ clock24: true }));
    expect(on.length).toBeGreaterThan(def.length);
  });
});
