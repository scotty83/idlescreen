// Config schema, normalization and codec. Runs in browser (Chromium >=102),
// on user phones (setup page) and in Node >=20 (tests, tooling).
//
// Schema v3 (2026-07-02): grid refined from 6x4 to 12x8 — v2 rects double.
// Schema v2 (2026-07-02): the ordered `widgets` list became `layout`
// ({id,x,y,w,h} on the 6×4 grid); `lirr` became a Penn-only branch filter;
// the default location moved to ZIP 10001. v1 configs migrate automatically.
// `widgets` survives as a derived convenience array (layout ids, in order).

import { CATALOG_IDS, CATALOG_GROUPS } from './catalog.js';
import { DEFAULT_LAYOUT, normalizeLayout, migrateWidgetsToLayout, contentMaxH } from './layout.js';
import { TFL_TUBE_IDS, TFL_LINE_IDS } from './tfl-lines.js';
import { CHART_TOPICS, CHART_TOPIC_SLUGS } from './widgets/chart-topics.js';
import { DEFAULT_SCHEDULE } from './modes.js';
import { OCEAN_WIDGETS, hasOcean } from './surf-gate.js';

export const ART_CATS = [
  ['european', 'European'],
  ['american', 'American'],
  ['asian', 'Asian'],
];

// The widget vocabulary itself now lives in catalog.js, which is pure data and
// therefore safe for the phone wizard to import: one entry per card carrying
// its id, its one settings-facing label and its picker group. These two names
// are what the rest of the tree has always asked config.js for, and their
// shapes are unchanged (an ordered id list; an ordered [{label, ids}] list), so
// nothing downstream had to move. What changed is that they are no longer typed
// here, and the label maps the two settings surfaces each kept are gone with
// them. WIDGET_IDS stays the validity source of truth for a config.
export const WIDGET_IDS = CATALOG_IDS;
export const WIDGET_GROUPS = CATALOG_GROUPS;

const SERVICE_IDS = ['webex', 'zoom', 'slack', 'ubiquiti', 'cloudflare', 'github', 'm365', 'gworkspace', 'aws', 'claude', 'openai'];

// NJ Transit rail lines served from New York Penn Station. The widget is
// Penn-fixed (mirrors LIRR/Amtrak) and filters departures by line client-side;
// [] = all lines. These must match the LINE strings the getStationSchedule feed
// emits verbatim — VERIFY against the live board before merge to main. Single
// source of truth shared by the default, validation, and the settings/setup pickers.
export const NJT_LINES = [
  'Northeast Corridor Line',
  'North Jersey Coast Line',
  'Morris & Essex Line',
  'Montclair-Boonton Line',
  'Gladstone Branch',
  'Raritan Valley Line',
];
const NJT_LINE_SET = new Set(NJT_LINES);

export const DEFAULT_CONFIG = Object.freeze({
  v: 3,
  t: 0,
  name: '',
  loc: Object.freeze({ lat: 40.7506, lon: -73.9971, label: 'New York 10001', units: 'F' }),
  layout: DEFAULT_LAYOUT,
  worldclock: Object.freeze({ cities: Object.freeze([
    { label: 'New York', zone: 'America/New_York' },
    { label: 'San Francisco', zone: 'America/Los_Angeles' },
    { label: 'London', zone: 'Europe/London' },
    { label: 'Hyderabad', zone: 'Asia/Kolkata' },
    { label: 'Hong Kong', zone: 'Asia/Hong_Kong' },
  ].map(Object.freeze)) }),
  // Status board defaults to the Penn Station lines (matches 10001 default).
  subway: Object.freeze({ lines: Object.freeze(['1', '2', '3']) }),
  lirr: Object.freeze({ dest: '', alerts: true, origin: 'penn' }), // '' dest = unpicked (card prompts); origin: penn | gct | both
  mnr: Object.freeze({ dest: '', alerts: true }), // Grand Central board destination filter
  bus: Object.freeze({ legs: Object.freeze([]) }), // up to 2 route-first legs
  markets: Object.freeze({ symbols: Object.freeze(['^DJI', '^IXIC', '^GSPC']) }), // removable like any ticker
  marketsnews: Object.freeze({ sources: Object.freeze(['mw', 'wsj-markets', 'ft-markets', 'cnbc', 'nyt-business', 'yahoo-finance']) }),
  services: Object.freeze({ list: Object.freeze(['webex', 'slack', 'm365']) }), // first-enable default; SERVICE_IDS is the full menu
  // Chart of the Day: hide-politics on by default (client-side keyword filter);
  // topics = curated CHART_TOPICS slugs the card cycles through on refresh.
  // Every topic is on by default (the widest, most varied rotation); turning
  // them all OFF leaves [] = any/global listing (the newest chart across
  // everything), which stays a legal, reachable state.
  chart: Object.freeze({ excludePolitics: true, topics: Object.freeze(CHART_TOPICS.map(([, slug]) => slug)) }),
  // Live Video: user-supplied HLS stream (https .m3u8). Nothing bundled --
  // rights sit with the user. label is an optional card-corner name.
  iptv: Object.freeze({ url: '', label: '' }),
  nerdMode: false, // Diagnostics toggle: expose ADVANCED_WIDGETS in pickers

  tfl: Object.freeze({ lines: Object.freeze([...TFL_TUBE_IDS]) }),
  citibike: Object.freeze({ stations: Object.freeze([
    Object.freeze({ id: '66dc7c31-0aca-11e7-82f6-3863bb44ef7c', name: 'W 29 St & 9 Ave' }),
    Object.freeze({ id: '66dc51e9-0aca-11e7-82f6-3863bb44ef7c', name: '10 Ave & W 28 St' }),
    Object.freeze({ id: '1869743938848725856', name: '9 Ave & W 33 St' }),
  ]) }),
  sports: Object.freeze({ teams: Object.freeze([]) }), // [{lg, id}] up to 6
  // Sports headlines. onlyMyTeams narrows them to the teams `sports` follows;
  // off by default because a board with no teams picked would show nothing.
  sportsnews: Object.freeze({ sources: Object.freeze(['espn', 'cbs-sports', 'yahoo-sports', 'the-athletic']), sports: Object.freeze([]), onlyMyTeams: false }),
  news: Object.freeze({ sources: Object.freeze(['nyt-home', 'nyt-nyregion']) }),
  // Starter accounts (AI/tech/finance, politically neutral, verified active
  // 2026-07-05) — removable entries like the markets tickers.
  substack: Object.freeze({ pubs: Object.freeze([
    { id: 'oneusefulthing', label: 'One Useful Thing' },
    { id: 'importai', label: 'Import AI' },
    { id: 'netinterest', label: 'Net Interest' },
    { id: 'pragmaticengineer', label: 'The Pragmatic Engineer' },
    { id: 'exponentialview', label: 'Exponential View' },
  ].map(Object.freeze)) }),
  bsky: Object.freeze({ handles: Object.freeze([
    { id: 'bloomberg.com', label: 'Bloomberg' },
    { id: 'reuters.com', label: 'Reuters' },
    { id: 'theverge.com', label: 'The Verge' },
    { id: 'emollick.bsky.social', label: 'Ethan Mollick' },
    { id: 'simonwillison.net', label: 'Simon Willison' },
  ].map(Object.freeze)) }),
  njt: Object.freeze({ lines: Object.freeze([]), alerts: true }), // New York Penn departures; [] = all lines
  amtrak: Object.freeze({ dest: '', alerts: true }), // NYP (Moynihan) board destination filter ('' = all trains)
  path: Object.freeze({ station: '33S', dir: 'ToNJ' }), // ridepath consideredStation code; default NJ-bound (evening commute home)
  ferry: Object.freeze({ landing: '17' }), // NYC Ferry stop_id (East 34th Street)
  art: Object.freeze({ every: 30, cats: Object.freeze([]) }), // rotation minutes; [] = all categories
  // Two independent photo widgets share this render but keep separate config:
  // photos = iCloud shared-album token, gdrivephotos = Drive folder id. album =
  // the source's id, every = rotation minutes. Which source drives the
  // full-screen screensaver lives in cfg.screensaver (dedicated Settings page);
  // the legacy per-widget screensaver booleans migrate there in normalizeConfig.
  photos: Object.freeze({ album: '', every: 30 }),
  gdrivephotos: Object.freeze({ album: '', every: 30 }),
  // Curated Landscapes source: no album (folder is baked into CURATED_SOURCES);
  // only the rotation minutes are user-adjustable (Settings → Landscapes).
  landscapes: Object.freeze({ every: 30 }),
  // Screensaver: what fills the screen in ambient mode. source: art | photos |
  // gdrivephotos (slideshows), clock | worldclocks | clockrow (clock faces,
  // A/C/D from the 2026-07-19 design review), or off. strip = the bottom
  // weather/transit info band.
  screensaver: Object.freeze({ source: 'art', strip: true, markers: true, backdrop: false }),
  mode: 'dashboard',
  schedule: Object.freeze(DEFAULT_SCHEDULE.map((w) => Object.freeze({ ...w }))),
  beacon: true, // anonymous hourly usage ping (see fleet.js); Diagnostics toggle
  clock24: false, // 24-hour time for the topbar Clock, World Clock + Weather's hour labels (departures keep fmtTime's 12h)
});

const MODES = ['scheduled', 'dashboard', 'ambient'];
// (Theme machinery retired 2026-07-19: Momentum is baked into :root.
// Legacy configs may still carry a `theme` key — normalize drops it.)
const MAX_NAME = 24;

const str = (v, fallback, max = 64) =>
  typeof v === 'string' ? v.slice(0, max) : fallback;
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const isZone = (z) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; }
};
const strList = (v, max = 12) =>
  Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, max) : [];

// v1 shipped with a Midtown default; migrated configs still carrying it get
// the new 10001 default instead of a stale "chosen" location.
function normalizeLoc(rawLoc) {
  const d = DEFAULT_CONFIG.loc;
  if (!rawLoc || rawLoc.label === 'Midtown') return { ...d };
  return {
    lat: num(rawLoc.lat, d.lat),
    lon: num(rawLoc.lon, d.lon),
    label: str(rawLoc.label, d.label, 40),
    units: rawLoc.units === 'C' ? 'C' : 'F',
  };
}

// Built-in curated screensaver photo sources: hand-curated images living in a
// public Google Drive folder, served through the worker's /gdrive/album route
// (the same path as the user-configurable GDrive photo source). Folder IDs are
// public — the folders are link-shared; only the worker's GDRIVE_KEY is secret.
// Add a category here and it becomes a selectable screensaver source everywhere
// (settings picker, preview, ambient slideshow) with no other wiring.
export const CURATED_SOURCES = Object.freeze({
  landscapes: Object.freeze({ label: 'Landscapes', folder: '1RHow60mcBwzMturimQSbziK3hqCvP2lz', every: 30 }),
});

// How an image source fills a full screen, asked by BOTH full-screen paths: the
// ambient slideshow (main.js) and the tap-opened viewer (imageshow.js). One rule
// so a photo cannot letterbox when tapped and crop as a screensaver, which is
// what Landscapes did. Curated sources are chosen scenery meant to fill the
// glass; art and a viewer's own photos are never cropped (you do not crop a
// painting, and a personal album is full of portraits).
export const imageFit = (id) => (CURATED_SOURCES[id] ? 'cover' : 'contain');

export const SCREENSAVER_SOURCES = Object.freeze([
  'art', 'photos', 'gdrivephotos', ...Object.keys(CURATED_SOURCES), 'clock', 'worldclocks', 'clockrow',
]);

// Curated folder of photos shown behind the clock-face screensavers when the
// "Backdrop image" toggle is on. Public/link-shared like CURATED_SOURCES; the
// board picks one image per day (deterministic daily rotation).
export const CLOCK_BACKDROP_FOLDER = '164wx5qOAP1SKukb3F6Ro0AlRpbELsUC4';

export function normalizeConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('config must be an object');
  }
  if (raw.v !== undefined && ![1, 2, 3].includes(raw.v)) {
    throw new TypeError(`unsupported config version: ${raw.v}`);
  }
  // v2 layouts lived on a 6x4 grid; double onto today's 12x8.
  const rawLayout = Array.isArray(raw.layout)
    ? raw.v === 2
      ? raw.layout.map((r) => ({ id: r.id, x: r.x * 2, y: r.y * 2, w: r.w * 2, h: r.h * 2 }))
      : raw.layout
    : null;
  // Content-aware height caps from the RAW lists (validation only ever drops
  // entries, so a raw overcount can only make a cap more permissive); absent
  // lists fall back to the defaults the normalized config will carry.
  const rawList = (v, dflt) => (Array.isArray(v) && v.length ? v : dflt);
  const contentCaps = contentMaxH({
    worldclock: { cities: rawList(raw.worldclock?.cities, DEFAULT_CONFIG.worldclock.cities) },
    markets: { symbols: rawList(raw.markets?.symbols, DEFAULT_CONFIG.markets.symbols) },
    sports: { teams: rawList(raw.sports?.teams, DEFAULT_CONFIG.sports.teams) },
    services: { list: rawList(raw.services?.list, DEFAULT_CONFIG.services.list) },
    citibike: { stations: rawList(raw.citibike?.stations, DEFAULT_CONFIG.citibike.stations) },
    tfl: { lines: rawList(raw.tfl?.lines, DEFAULT_CONFIG.tfl.lines) },
    subway: { lines: rawList(raw.subway?.lines, DEFAULT_CONFIG.subway.lines) },
  // soft:false so a height the user chose by hand SURVIVES the round trip. This
  // path re-clamps every stored layout on load, so leaving the advisory caps in
  // would quietly undo a taller Cloud Services card the next time the board
  // booted, which is the same as never having allowed it.
  }, { soft: false });
  let layout =
    // An explicitly-present layout (even empty — the user removed every widget)
    // is honored; only a truly ABSENT layout falls back to the legacy widgets
    // list or the default. Previously `[]` failed the length check and silently
    // resurrected the stale widgets list at scrambled default positions.
    Array.isArray(rawLayout)
      ? normalizeLayout(rawLayout, contentCaps)
      : Array.isArray(raw.widgets)
        ? migrateWidgetsToLayout(raw.widgets)
        : [...DEFAULT_LAYOUT];
  // Legacy single-source migration: a board whose photos source was Drive keeps
  // its placed card, re-homed onto the new gdrivephotos widget id.
  if (raw.photos?.source === 'gdrive') {
    layout = layout.map((r) => (r.id === 'photos' ? { ...r, id: 'gdrivephotos' } : r));
  }
  const photos = normalizePhotos(raw.photos);
  const gdrivephotos = normalizeGdrivePhotos(raw.gdrivephotos, raw.photos);
  // Screensaver: prefer the dedicated block; otherwise migrate the legacy
  // per-widget booleans (pre-2026-07-19 configs) — iCloud wins a double-set,
  // matching the old exclusivity tie-break. Falls back to the historical
  // default (art slideshow) with the info strip on.
  const screensaver = (() => {
    const s = raw.screensaver;
    // markers = the World-clocks hour-dot toggle (2a dots on / 2b off), default on.
    const markers = raw.screensaver?.markers !== false;
    // backdrop = optional daily photo behind the clock faces, default off.
    const backdrop = raw.screensaver?.backdrop === true;
    if (s && SCREENSAVER_SOURCES.includes(s.source)) return { source: s.source, strip: s.strip !== false, markers, backdrop };
    if (raw.photos?.screensaver === true && photos.album) return { source: 'photos', strip: true, markers, backdrop };
    if (raw.gdrivephotos?.screensaver === true && gdrivephotos.album) return { source: 'gdrivephotos', strip: true, markers, backdrop };
    // Legacy single-source Drive block: {photos:{source:'gdrive',screensaver}}
    // migrated its album into gdrivephotos above — carry the choice with it.
    if (raw.photos?.source === 'gdrive' && raw.photos?.screensaver === true && gdrivephotos.album) return { source: 'gdrivephotos', strip: true, markers, backdrop };
    return { source: 'art', strip: true, markers, backdrop };
  })();

  return {
    v: 3,
    t: num(raw.t, 0),
    name: str(raw.name, DEFAULT_CONFIG.name, MAX_NAME),
    loc: normalizeLoc(raw.loc),
    layout,
    widgets: layout.map((r) => r.id),
    subway: {
      // Status board: lines only (stops/alerts fields from older configs drop).
      lines: strList(raw.subway?.lines, 24).length
        ? strList(raw.subway?.lines, 24)
        : [...DEFAULT_CONFIG.subway.lines],
    },
    lirr: {
      dest: str(raw.lirr?.dest, '', 4), // '' = no station picked yet (card prompts)
      alerts: raw.lirr?.alerts !== false,
      // Departure terminal(s): Penn, Grand Central, or both. Penn is the
      // historical behavior and the default.
      origin: ['penn', 'gct', 'both'].includes(raw.lirr?.origin) ? raw.lirr.origin : 'penn',
    },
    mnr: {
      dest: str(raw.mnr?.dest, '', 4),
      alerts: raw.mnr?.alerts !== false,
    },
    bus: {
      legs: (Array.isArray(raw.bus?.legs) ? raw.bus.legs : [])
        .filter((l) =>
          l && /^(QM|BM|SIM|X)\d+[A-Z]?$/i.test(String(l.route ?? '')) &&
          (l.dir === 0 || l.dir === 1) &&
          typeof l.stopId === 'string' && l.stopId.length > 0)
        .slice(0, 2)
        .map((l) => ({ route: String(l.route), lineRef: String(l.lineRef ?? ''), dir: l.dir, stopId: String(l.stopId), stopName: String(l.stopName ?? '') })),
    },
    sports: {
      teams: (Array.isArray(raw.sports?.teams) ? raw.sports.teams : [])
        // lg/id render into `data-team` attributes; constrain to the real
        // league-key / id charset so a crafted config can't break out of the
        // attribute (defense in depth behind the per-render escapeHtml).
        .filter((t) => typeof t?.lg === 'string' && typeof t?.id === 'string'
          && /^[a-z0-9.]{1,12}$/i.test(t.lg) && /^[a-z0-9]{1,12}$/i.test(t.id))
        .map((t) => ({ lg: t.lg, id: t.id.toLowerCase().slice(0, 8) }))
        .slice(0, 6),
    },
    news: {
      sources: (() => {
        const list = strList(raw.news?.sources, 7);
        return list.length ? list : [...DEFAULT_CONFIG.news.sources];
      })(),
    },
    // Short-lived combined `posts` configs (2026-07-05) migrate into the two
    // split widgets; the account shape {id, label} stays.
    // An empty follow list falls back to the starter accounts (a card with
    // zero accounts is never useful — remove the widget instead), matching
    // the markets-tickers convention.
    substack: {
      pubs: (() => {
        const list = [
          ...(Array.isArray(raw.substack?.pubs) ? raw.substack.pubs : []),
          ...(Array.isArray(raw.posts?.accounts) ? raw.posts.accounts.filter((a) => a?.net === 'substack') : []),
        ]
          .filter((a) => /^[a-z0-9-]{2,64}$/.test(a?.id ?? ''))
          .map((a) => ({ id: a.id, label: str(a.label, a.id, 30) }))
          .slice(0, 6);
        return list.length ? list : DEFAULT_CONFIG.substack.pubs.map((a) => ({ ...a }));
      })(),
    },
    bsky: {
      handles: (() => {
        const list = [
          ...(Array.isArray(raw.bsky?.handles) ? raw.bsky.handles : []),
          ...(Array.isArray(raw.posts?.accounts) ? raw.posts.accounts.filter((a) => a?.net === 'bsky') : []),
        ]
          .filter((a) => /^[a-z0-9.-]{4,253}$/i.test(a?.id ?? ''))
          .map((a) => ({ id: a.id, label: str(a.label, a.id, 30) }))
          .slice(0, 6);
        return list.length ? list : DEFAULT_CONFIG.bsky.handles.map((a) => ({ ...a }));
      })(),
    },
    markets: {
      // An empty list falls back to the defaults (a markets card with zero
      // tickers is never useful — remove the widget instead). The 20-symbol cap
      // is the expand overlay's no-scroll ceiling; it is TICKER_MAX in
      // settings/pickers.js and the /markets slice in the Worker.
      //
      // ORDER IS DATA here: map and filter only, never a sort. The user
      // arranges this list by hand in Settings › Markets and the card fills
      // from the top of it down, so order in must be order out.
      symbols: (() => {
        const list = strList(raw.markets?.symbols, 20)
          .map((t) => t.toUpperCase())
          .filter((t) => /^[\^A-Z0-9.\-]{1,10}$/.test(t));
        return list.length ? list : [...DEFAULT_CONFIG.markets.symbols];
      })(),
    },
    marketsnews: {
      sources: (() => {
        const valid = new Set(['mw', 'wsj-markets', 'ft-markets', 'sa', 'cnbc', 'nyt-business', 'yahoo-finance']); // MARKET_SOURCES ids
        const picked = (Array.isArray(raw.marketsnews?.sources) ? raw.marketsnews.sources : []).filter((s) => valid.has(s));
        return picked.length ? picked : [...DEFAULT_CONFIG.marketsnews.sources];
      })(),
    },
    sportsnews: {
      sources: (() => {
        // SPORTS_SOURCES ids. the-athletic was missing here at first, which
        // silently deleted an explicit Athletic pick on every load.
        const valid = new Set(['espn', 'cbs-sports', 'yahoo-sports', 'the-athletic', 'bbc-sport', 'guardian-sport']);
        const picked = (Array.isArray(raw.sportsnews?.sources) ? raw.sportsnews.sources : []).filter((s) => valid.has(s));
        return picked.length ? picked : [...DEFAULT_CONFIG.sportsnews.sources];
      })(),
      // Sport chips (SPORTS ids). Empty means all sports, and IS the default,
      // so unlike sources an empty array is honored verbatim.
      sports: (() => {
        const valid = new Set(['mlb', 'nfl', 'nba', 'nhl', 'mls', 'f1', 'golf', 'tennis']);
        return (Array.isArray(raw.sportsnews?.sports) ? raw.sportsnews.sports : []).filter((s) => valid.has(s));
      })(),
      onlyMyTeams: raw.sportsnews?.onlyMyTeams === true,
    },
    chart: {
      // Client-side hide-politics filter (on unless explicitly disabled).
      excludePolitics: raw.chart?.excludePolitics !== false,
      // Curated slugs the card cycles through. An EXPLICIT array is honored
      // verbatim (valid slugs only, deduped, capped at the full vocabulary) —
      // including [], which the user reaches by turning every pill off and
      // which means the any/global listing. Absent (or malformed) topics fall
      // back to the default: every topic on. Old single-topic configs
      // (raw.chart.topic) still migrate to a one-element array when no topics
      // array is present.
      topics: (() => {
        if (Array.isArray(raw.chart?.topics)) {
          return [...new Set(raw.chart.topics.filter((s) => CHART_TOPIC_SLUGS.has(s)))].slice(0, CHART_TOPIC_SLUGS.size);
        }
        if (raw.chart?.topics == null && CHART_TOPIC_SLUGS.has(raw.chart?.topic)) return [raw.chart.topic];
        return [...DEFAULT_CONFIG.chart.topics];
      })(),
    },
    services: {
      list: (() => {
        const picked = (Array.isArray(raw.services?.list) ? raw.services.list : [])
          .filter((s) => SERVICE_IDS.includes(s)); // validate against ALL ids, not the default trio
        return picked.length ? picked : [...DEFAULT_CONFIG.services.list];
      })(),
    },
    citibike: {
      stations: (() => {
        const picked = (Array.isArray(raw.citibike?.stations) ? raw.citibike.stations : [])
          .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
          .slice(0, 6)
          .map((s) => ({ id: s.id, name: s.name }));
        return picked.length ? picked : DEFAULT_CONFIG.citibike.stations.map((s) => ({ id: s.id, name: s.name }));
      })(),
    },
    nerdMode: raw.nerdMode === true,
    iptv: {
      // https-only: the site is https, so an http stream would be blocked as
      // mixed content anyway. Anything else normalizes to unconfigured.
      url: (() => {
        const u = typeof raw.iptv?.url === 'string' ? raw.iptv.url.trim() : '';
        return /^https:\/\/\S+$/i.test(u) ? u : '';
      })(),
      label: typeof raw.iptv?.label === 'string' ? raw.iptv.label.trim().slice(0, 40) : '',
    },
    tfl: {
      lines: (() => {
        const picked = [...new Set((Array.isArray(raw.tfl?.lines) ? raw.tfl.lines : []).filter((id) => TFL_LINE_IDS.has(id)))];
        return picked.length ? picked : [...DEFAULT_CONFIG.tfl.lines];
      })(),
    },
    njt: {
      // New York Penn is fixed; the user filters by line (intersect against the
      // known NYP-served set, dedupe). [] = all lines. Old station-based configs
      // fall through to all lines — no migration needed.
      lines: [...new Set((Array.isArray(raw.njt?.lines) ? raw.njt.lines : []).filter((l) => NJT_LINE_SET.has(l)))],
      alerts: raw.njt?.alerts !== false,
    },
    amtrak: {
      dest: str(raw.amtrak?.dest, '', 5), // Amtrak station code (e.g. PHL); '' = all NYP departures
      alerts: raw.amtrak?.alerts !== false,
    },
    path: {
      station: /^[A-Z0-9]{3}$/.test(raw.path?.station ?? '') ? raw.path.station : DEFAULT_CONFIG.path.station,
      dir: ['both', 'ToNY', 'ToNJ'].includes(raw.path?.dir) ? raw.path.dir : DEFAULT_CONFIG.path.dir,
    },
    ferry: {
      landing: /^\d{1,4}$/.test(raw.ferry?.landing ?? '') ? raw.ferry.landing : DEFAULT_CONFIG.ferry.landing,
    },
    art: {
      every: Math.min(Math.max(num(raw.art?.every, 30), 1), 360),
      cats: strList(raw.art?.cats, 6).filter((c) => ART_CATS.some(([id]) => id === c)),
    },
    photos,
    screensaver,
    gdrivephotos,
    landscapes: { every: photoEvery(raw.landscapes) },
    worldclock: {
      cities: (() => {
        const seen = new Set();
        const list = (Array.isArray(raw.worldclock?.cities) ? raw.worldclock.cities : [])
          .filter((c) => typeof c?.label === 'string' && typeof c?.zone === 'string' && isZone(c.zone))
          // Strip HTML-special chars: labels render into innerHTML on several
          // surfaces; a legit city label never contains these (defense in depth
          // behind the per-render escapeHtml).
          .map((c) => ({ label: c.label.replace(/[<>"'&]/g, '').trim().slice(0, 24), zone: c.zone }))
          .filter((c) => c.label && !seen.has(`${c.label}|${c.zone}`) && !!seen.add(`${c.label}|${c.zone}`))
          .slice(0, 10);
        return list.length ? list : DEFAULT_CONFIG.worldclock.cities.map((c) => ({ ...c }));
      })(),
    },
    mode: (() => {
      const m = raw.mode === 'auto' ? 'scheduled' : raw.mode; // legacy Auto → Scheduled
      return MODES.includes(m) ? m : DEFAULT_CONFIG.mode;
    })(),
    schedule: (() => {
      const q = (n) => Math.min(1440, Math.max(0, Math.round(n / 15) * 15));
      const clean = (Array.isArray(raw.schedule) ? raw.schedule : [])
        .filter((w) => Number.isFinite(w?.start) && Number.isFinite(w?.end))
        .map((w) => ({ start: q(w.start), end: q(w.end) }))
        .filter((w) => w.start < w.end)
        .slice(0, 4);
      return clean.length ? clean : DEFAULT_CONFIG.schedule.map((w) => ({ ...w }));
    })(),
    beacon: raw.beacon !== false, // absent (older configs) → on
    clock24: raw.clock24 === true, // absent/anything-but-true → 12-hour default
  };
}

function bytesToBase64url(buf) {
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('invalid base64url');
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeConfig(cfg) {
  // Keep the wire format minimal: `widgets` is derived from layout, and
  // follow lists equal to the starter defaults re-derive on decode (only
  // customized lists pay for their bytes in the URL fragment).
  const { widgets, ...wire } = cfg;
  const isDefault = (list, defs) => JSON.stringify(list) === JSON.stringify(defs);
  // Order-insensitive list compare: the chart topic pills can be toggled back
  // to the full set in any order, and that is still "the default".
  const sameSet = (list, defs) => {
    if (!Array.isArray(list)) return false;
    const a = new Set(list);
    const b = new Set(defs);
    return a.size === b.size && [...a].every((x) => b.has(x));
  };
  // NOTE: there is deliberately NO strip line for `markets`. Its `symbols` is
  // an ORDERED list the user arranges by hand, and the card fills from the top
  // of it down — so never add a `sameSet` strip for it. An order-insensitive
  // compare would erase a deliberate permutation of the starter three the
  // moment it happened to be one, and the user's order would silently revert
  // on the next setup-code round trip. test/config.test.js pins this.
  if (wire.substack && isDefault(wire.substack.pubs, DEFAULT_CONFIG.substack.pubs)) delete wire.substack;
  if (wire.bsky && isDefault(wire.bsky.handles, DEFAULT_CONFIG.bsky.handles)) delete wire.bsky;
  if (wire.marketsnews && isDefault(wire.marketsnews.sources, DEFAULT_CONFIG.marketsnews.sources)) delete wire.marketsnews;
  if (wire.sportsnews && isDefault(wire.sportsnews, DEFAULT_CONFIG.sportsnews)) delete wire.sportsnews; // sources AND the filter untouched
  if (wire.chart) {
    // Per-key strip: an all-topics selection (in any order) and the default
    // politics filter re-derive on decode; an explicit [] (every topic off →
    // global listing) or a narrowed selection pays for its bytes.
    const chart = { ...wire.chart };
    if (sameSet(chart.topics, DEFAULT_CONFIG.chart.topics)) delete chart.topics;
    if (chart.excludePolitics === DEFAULT_CONFIG.chart.excludePolitics) delete chart.excludePolitics;
    if (Object.keys(chart).length) wire.chart = chart;
    else delete wire.chart;
  }
  if (wire.services && isDefault(wire.services.list, DEFAULT_CONFIG.services.list)) delete wire.services;
  if (wire.citibike && isDefault(wire.citibike.stations, DEFAULT_CONFIG.citibike.stations)) delete wire.citibike;
  if (wire.tfl && isDefault(wire.tfl.lines, DEFAULT_CONFIG.tfl.lines)) delete wire.tfl;
  if (wire.schedule && isDefault(wire.schedule, DEFAULT_CONFIG.schedule)) delete wire.schedule;
  if (wire.beacon === DEFAULT_CONFIG.beacon) delete wire.beacon;
  if (wire.clock24 === DEFAULT_CONFIG.clock24) delete wire.clock24; // default 12h → off the wire
  if (wire.photos && isDefault(wire.photos, DEFAULT_CONFIG.photos)) delete wire.photos; // unconfigured → re-derives on decode
  if (wire.gdrivephotos && isDefault(wire.gdrivephotos, DEFAULT_CONFIG.gdrivephotos)) delete wire.gdrivephotos;
  if (wire.landscapes && isDefault(wire.landscapes, DEFAULT_CONFIG.landscapes)) delete wire.landscapes; // default rotation → re-derives on decode
  if (wire.iptv && isDefault(wire.iptv, DEFAULT_CONFIG.iptv)) delete wire.iptv; // unconfigured → off the wire
  if (wire.nerdMode === false) delete wire.nerdMode;
  if (wire.screensaver && isDefault(wire.screensaver, DEFAULT_CONFIG.screensaver)) delete wire.screensaver;
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  return bytesToBase64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decodeConfig(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('empty config string');
  }
  const compressed = base64urlToBytes(encoded);
  const bytes = await pipe(compressed, new DecompressionStream('deflate-raw'));
  return normalizeConfig(JSON.parse(new TextDecoder().decode(bytes)));
}

// Per-source album shapes: an iCloud shared-album token is case-sensitive
// base62 (8-25 chars); a Drive folder id is [-\w] (~10-80). Shared by the
// config normalizers and the photos-only code so validation stays identical.
const isIcloudToken = (v) => /^[A-Za-z0-9]{8,25}$/.test(v ?? '');
const isDriveFolder = (v) => /^[-\w]{10,80}$/.test(v ?? '');
const photoEvery = (p) => Math.min(Math.max(num(p?.every, 30), 1), 360);

// iCloud Photos block, from the new shape ({album,...}) or a legacy single-
// source block ({source,album,...}) — but a legacy Drive album belongs to
// gdrivephotos, so it's dropped here. Key order matches DEFAULT_CONFIG.photos
// (encodeConfig's wire-strip compares JSON.stringify of the whole object).
export function normalizePhotos(raw) {
  const p = raw ?? {};
  const legacyDrive = p.source === 'gdrive';
  const tok = legacyDrive ? '' : p.album;
  return {
    album: isIcloudToken(tok) ? tok : '',
    every: photoEvery(p),
  };
}

// GDrive Photos block, from its own new-shape block, else migrated from a
// legacy Drive-sourced photos block ({source:'gdrive',album,...}).
export function normalizeGdrivePhotos(raw, rawPhotos) {
  const p = raw ?? (rawPhotos?.source === 'gdrive' ? rawPhotos : {});
  return {
    album: isDriveFolder(p.album) ? p.album : '',
    every: photoEvery(p),
  };
}

// Photos-only setup code. The board MERGES this into the photo blocks rather
// than overwriting the whole config (what a full setup code does), so a user
// can set a photo source from their phone without losing the rest of the
// board's setup. Sparse: only the slots the sender filled travel, so applying
// an iCloud-only code never disturbs an existing Drive slot. The '~P~' sentinel
// can't collide with a full-config code (those are pure base64url).
// Event widgets with a hard end date. Add `id: Date.UTC(y, m, d)` here and on
// that date the id drops out of every add picker (isAddable below) while a
// board that already has the card placed keeps its slot and gets a tap-to-swap
// prompt (util.js editPrompt) — an event card is never yanked out of somebody's
// layout from the server side.
//
// The map is EMPTY today. World Cup 2026 was the first and so far only dated
// card: it retired on 2026-07-20 (final was Jul 19, Spain won) and its code was
// removed from the tree on 2026-07-29, which is the whole lifecycle this table
// exists to make cheap. Kept empty rather than deleted because the next
// seasonal card is one line, and because RETIRED_AFTER is one of the four
// isAddable gates the add-policy tests assert as a set.
//
// A retired id must ALSO leave DEFAULT_LAYOUT in the same change — World Cup
// did not, and every board quick-started between Jul 20 and Jul 29 shipped
// with a dead card pre-checked on /setup. test/layout.test.js now fails if a
// default is not offerable.
export const RETIRED_AFTER = Object.freeze({});
// The date is the first day the card is GONE: the comparison is strict against
// that date's UTC midnight, so the card lives through the whole day before it.
// `table` is the injection seam that keeps that rule under test while the real
// map is empty; production callers never pass it.
export const isRetired = (id, nowMs = Date.now(), table = RETIRED_AFTER) =>
  (table[id] ?? Infinity) < nowMs;

// Staged rollout: ids listed here surface only on staging hosts (the beta.
// origins such as beta.idlescreen.app, local dev) — prod ships the code dark
// and the pickers/settings nav hide the id until launch.
// A card that is already PLACED still renders everywhere, so a beta-configured
// board never breaks by visiting prod.
const BETA_ONLY = Object.freeze(['iptv']);
// The list is of PRODUCTION hosts, and everything else is staging by default.
// idlescreen.app, unsleep.app and roomboard.app all serve production, so none
// of them may count as a staging host; the beta hosts (beta.idlescreen.app,
// beta.roomboard.app, ...) fall through to the default and stay beta. A
// production domain missing from this list would quietly ship the
// BETA_ONLY cards to real boards, which is why the rename reconciliation of
// 2026-08-18 added unsleep.app here the same day the domain went live. The
// same rule decides when a host may leave: only once it serves no page at
// all, as app.quadrille.io did 2026-09-26 when it became a redirect.
export const isBetaHost = (host = (typeof location !== 'undefined' ? location.hostname : 'localhost')) =>
  host !== 'roomboard.app' && host !== 'www.roomboard.app' && host !== 'unsleep.app' &&
  host !== 'idlescreen.app';
export const isLaunched = (id, host) => !BETA_ONLY.includes(id) || isBetaHost(host);

// "Nerd mode": cards that need self-hosted infrastructure (live streams,
// camera gateways) stay out of every add picker unless the board's owner
// flips the toggle in Settings → Diagnostics — technical users find them,
// everyone else never sees the clutter. Placed cards always render.
export const ADVANCED_WIDGETS = Object.freeze(['iptv']);
export const isAdvancedHidden = (id, cfg) => ADVANCED_WIDGETS.includes(id) && !cfg?.nerdMode;

// Place-gated cards: the first gate that depends on WHERE the board is rather
// than on what its owner turned on. Surf is only offered once a cached probe
// has confirmed the effective spot resolves to open water — see surf-gate.js
// for the probe, its cache and why the verdict has to be readable
// synchronously. Pessimistic by design: no verdict yet means no card, not a
// card that will apologise later.
export const isOceanHidden = (id, cfg) => OCEAN_WIDGETS.includes(id) && !hasOcean(cfg?.loc);

// Single source of truth for "may this widget be OFFERED to add right now":
// not sunset (RETIRED_AFTER), launched on this host (BETA_ONLY), not gated
// behind nerd mode (ADVANCED_WIDGETS), and — for the place-gated cards —
// actually available where this board is (OCEAN_WIDGETS). EVERY add surface —
// the edit-mode tray (the board's only one since 2026-08-01) and the /setup
// checkboxes — routes through this one predicate, so a new gate or a new advanced
// card can't leak through a picker someone forgot to update. (A PLACED card is
// always shown for removal regardless; callers OR this with `placed.has(id)`.)
export const isAddable = (id, cfg, host) =>
  !isRetired(id) && isLaunched(id, host) && !isAdvancedHidden(id, cfg) && !isOceanHidden(id, cfg);

const PHOTOS_CODE_MARK = '~P~';
// Live Video rides the same phone-to-board setup code: '~V~' carries just the
// stream URL (+ optional label) so redeeming never disturbs the board's setup.
const VIDEO_CODE_MARK = '~V~';
const isStreamUrl = (u) => typeof u === 'string' && /^https:\/\/\S+$/i.test(u.trim());

export async function encodePhotosCode({ icloud, gdrive } = {}) {
  const patch = {};
  if (isIcloudToken(icloud)) patch.icloud = icloud;
  if (isDriveFolder(gdrive)) patch.gdrive = gdrive;
  const bytes = new TextEncoder().encode(JSON.stringify(patch));
  return PHOTOS_CODE_MARK + bytesToBase64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function encodeVideoCode({ url, label } = {}) {
  const patch = {};
  if (isStreamUrl(url)) patch.url = url.trim();
  if (typeof label === 'string' && label.trim()) patch.label = label.trim().slice(0, 40);
  const bytes = new TextEncoder().encode(JSON.stringify(patch));
  return VIDEO_CODE_MARK + bytesToBase64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

// Resolve a redeemed setup-code payload: { scope:'photos', patch:{icloud?,gdrive?} }
// for a photos code (merge only the present slots), or { scope:'full', cfg }
// for a normal config (replace, as before). Both board code-entries branch on
// scope.
export async function decodeCode(encoded) {
  if (typeof encoded === 'string' && encoded.startsWith(PHOTOS_CODE_MARK)) {
    const compressed = base64urlToBytes(encoded.slice(PHOTOS_CODE_MARK.length));
    const bytes = await pipe(compressed, new DecompressionStream('deflate-raw'));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    const patch = {};
    if (isIcloudToken(p.icloud)) patch.icloud = p.icloud;
    if (isDriveFolder(p.gdrive)) patch.gdrive = p.gdrive;
    return { scope: 'photos', patch };
  }
  if (typeof encoded === 'string' && encoded.startsWith(VIDEO_CODE_MARK)) {
    const compressed = base64urlToBytes(encoded.slice(VIDEO_CODE_MARK.length));
    const bytes = await pipe(compressed, new DecompressionStream('deflate-raw'));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    const patch = {};
    if (isStreamUrl(p.url)) patch.url = p.url.trim();
    if (typeof p.label === 'string' && p.label.trim()) patch.label = p.label.trim().slice(0, 40);
    return { scope: 'video', patch };
  }
  return { scope: 'full', cfg: await decodeConfig(encoded) };
}

export function pickNewest(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return (b.t ?? 0) > (a.t ?? 0) ? b : a;
}
