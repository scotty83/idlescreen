import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../worker/src/index.js';
import {
  CHART_TOPICS, resolveTopic, parseListing, parseChartPage, topicsOf,
} from '../../worker/src/chart.js';
import { CHART_TOPICS as SITE_TOPICS, CHART_TOPIC_ALIASES } from '../../site/js/widgets/chart-topics.js';
import LISTING from './fixtures/statista-recent.html?raw';
import PAGE_36743 from './fixtures/statista-chart-36743.html?raw';
import PAGE_36738 from './fixtures/statista-chart-36738.html?raw';

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (path, init, extraEnv = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, init), { ...env, ...extraEnv }, ctx);

const cacheKey = (kind, key) => new Request(`https://api.test/__cache/${kind}/${encodeURIComponent(key)}`);
const clearCache = (key) =>
  Promise.all([caches.default.delete(cacheKey('fresh', key)), caches.default.delete(cacheKey('stale', key))]);

// The chart index lives in one Cache API entry of its own, beside the route's
// fresh/stale pair; tests read it to see what a refresh classified.
const indexKey = () => new Request('https://api.test/__cache/chart-index/v1');
const readIndex = async () => (await caches.default.match(indexKey()))?.json() ?? null;
// Push the stored index past its 30-minute fresh window, so the next miss
// re-reads the listing (a full refresh) rather than catching up.
const writeIndex = (index) =>
  caches.default.put(indexKey(), new Response(JSON.stringify(index), { headers: { 'Cache-Control': 'max-age=2592000' } }));
const ageIndex = async (edit = () => {}) => {
  const index = await readIndex();
  index.builtAt = 0;
  edit(index);
  await writeIndex(index);
};
// The claim a refresh holds while it reads the chart pages (see loadIndex).
const busyKey = () => new Request('https://api.test/__cache/chart-index/busy');
const holdRefresh = () => caches.default.put(busyKey(), new Response('1', { headers: { 'Cache-Control': 'max-age=30' } }));
const MIN = 60 * 1000;
const ALL_KEYS = ['chart', ...CHART_TOPICS.map(([, slug]) => `chart:${slug}`)];
const clearRoute = () => Promise.all(ALL_KEYS.map(clearCache));

const P1 = 'https://www.statista.com/recent/infographics/';
const P2 = 'https://www.statista.com/recent/infographics/p/2/';

// Encode a value the way React Router's turbo-stream does (the "flat" array:
// objects map _<key index> to a value index, arrays list value indices), and
// wrap it in the listing page's enqueue script. Lets a test build a listing of
// any size without another fixture.
function turbo(value) {
  const flat = [];
  const put = (v) => {
    const i = flat.length;
    flat.push(null);
    if (Array.isArray(v)) flat[i] = v.map(put);
    else if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const ki = flat.length;
        flat.push(k);
        o[`_${ki}`] = put(x);
      }
      flat[i] = o;
    } else flat[i] = v;
    return i;
  };
  put(value);
  return flat;
}
const listingHtml = (results, routeId = 'routes/recent-en-index') => {
  const stream = `${JSON.stringify(turbo({ loaderData: { root: {}, [routeId]: { recentResponse: { n_hits: results.length, results } } } }))}\n`;
  return `<html><body><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(stream)});</script></body></html>`;
};
const item = (id, date, over = {}) => ({
  id: `infographic-${id}`,
  contentId: String(id),
  contentType: 'infographic',
  title: `Chart ${id}`,
  subtitle: 'Topic',
  description: `Chart ${id} says something. `.repeat(40),
  urlPath: `/chart/${id}/chart-${id}/`,
  released: `${date}T09:00:00Z`,
  updated: `${date}T10:00:00Z`,
  premium: false,
  ...over,
});

// A chart page's head, as much of it as the classifier reads.
const head = (b, tags = []) => `<!DOCTYPE html><html><head>${tags.map((t, i) => `<meta id="gtm_infographic_tag${i + 1}" data-page="${t}" />`).join('')}</head>
<body><script>adHandler.service.setTargeting('branchen',[${b.join(',')}].map(String));</script></body></html>`;

// Every non-sponsored chart in the real fixture gets a classification; the
// two real chart pages answer for themselves. Nothing here is energy, health,
// finance, transportation or travel, which is what the fallback cases lean on.
const HEADS = {
  35531: head([415, 423], ['Black Friday']), // consumer goods, retail
  7045: head([413]), // e-commerce
  31412: head([413, 423]), // e-commerce, retail
  25829: head([424, 417], ['social media']), // internet, media
  20010: head([411]), // society
  36781: head([424]), // internet
  36744: head([418], ['Anthropic', 'AI infrastructure']), // technology + AI by tag
  36743: PAGE_36743, // AI by branch, technology
  27506: head([2535], ['inflation']), // economy
  31146: head([476, 417], ['horror']), // entertainment, media
  36738: PAGE_36738, // entertainment, media
  30001: head([409], ['football']), // sports, page 2 only
};
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
// Page 2 by default: one older chart of its own, and a repeat of a page-1 chart
// under another title (the first occurrence wins).
const PAGE2 = () => listingHtml([
  item(36738, '2026-10-28', { title: 'DUPLICATE' }),
  item(30001, '2026-10-01', { title: 'Football Fans' }),
]);

// Routes the stubbed fetch by URL: listing page 1, page 2, chart pages.
function stubUpstream({
  page1 = () => html(LISTING),
  page2 = () => html(PAGE2()),
  chart = (id) => (HEADS[id] ? html(HEADS[id]) : html('missing', 404)),
} = {}) {
  const calls = [];
  const fn = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === P1) return page1();
    if (url === P2) return page2();
    const m = /^https:\/\/www\.statista\.com\/chart\/(\d+)\//.exec(url);
    if (m) return chart(m[1]);
    return html('unexpected', 404);
  });
  vi.stubGlobal('fetch', fn);
  return {
    calls,
    listings: () => calls.filter((u) => u === P1 || u === P2).length,
    chartPages: (id) => calls.filter((u) => (id ? u.includes(`/chart/${id}/`) : u.includes('/chart/'))).length,
    reset: () => { calls.length = 0; },
  };
}

const ids = (body) => body.charts.map((c) => c.id);

afterEach(async () => {
  await clearRoute();
  await caches.default.delete(indexKey());
  await caches.default.delete(busyKey());
  vi.unstubAllGlobals();
});

describe('parseListing', () => {
  it('reads the real payload: every result in listing order, sponsored ones flagged', () => {
    const list = parseListing(LISTING);
    expect(list.map((c) => c.id)).toEqual([
      '35531', '7045', '31412', '25829', '20010', '36781', '36777', '36763', '36744', '36743', '27506', '31146', '36738',
    ]);
    const first = list[0];
    expect(first).toMatchObject({
      id: '35531',
      path: '/chart/35531/black-friday-product-categories-best-deals-expectations/',
      title: 'Where Americans Expect the Best Deals This Holiday Season',
      date: '2026-11-17', // updated, not the 2025 release
      sponsored: false,
    });
    // Both spellings of Statista's sponsored label.
    expect(list.filter((c) => c.sponsored).map((c) => c.id)).toEqual(['36777', '36763']);
    // A percent-escaped slug is still this chart's own page.
    expect(list.find((c) => c.id === '31146').path).toBe('/chart/31146/share-of-respondents-who-watch-or-stream-%22horror%22/');
  });

  it('cuts every description at a sentence end inside 500 characters', () => {
    for (const c of parseListing(LISTING)) {
      expect(c.desc.length).toBeLessThanOrEqual(500);
      expect(c.desc.length).toBeGreaterThan(120);
      expect(c.desc).toMatch(/[.!?]$/);
    }
  });

  it('does not end a description on an abbreviation', () => {
    // The last ". " inside the limit follows "U.S", which is no sentence end.
    const opening = 'This chart shows holiday spending by region across the country. It draws on a survey of 2,000 adults carried out in the first week of October. ';
    const description = `${opening}${'More shoppers than ever plan to buy online this year '.repeat(7)}according to U.S. Census Bureau figures and ${'word '.repeat(60)}`;
    const [c] = parseListing(listingHtml([item(1, '2026-11-01', { description })]));
    expect(c.desc).toBe(opening.trim());
    // A real end right at the limit still counts.
    const exact = `${'x'.repeat(498)}. Next sentence follows here.`;
    expect(parseListing(listingHtml([item(2, '2026-11-01', { description: exact })]))[0].desc).toHaveLength(499);
  });

  it('hard-cuts a description with no sentence end past the opening', () => {
    const [c] = parseListing(listingHtml([item(1, '2026-11-01', { description: 'word '.repeat(300) })]));
    expect(c.desc.length).toBeLessThanOrEqual(500);
    expect(c.desc.length).toBeGreaterThan(490);
  });

  it('finds the results under whatever route id the app uses', () => {
    expect(parseListing(listingHtml([item(1, '2026-11-01')], 'routes/recent-de-index'))[0].id).toBe('1');
  });

  it('skips premium, non-infographic, foreign-path and undated items', () => {
    const list = parseListing(listingHtml([
      item(1, '2026-11-01'),
      item(2, '2026-11-01', { premium: true }),
      item(3, '2026-11-01', { contentType: 'statistic' }),
      item(4, '2026-11-01', { urlPath: '/chart/999/someone-else/' }),
      item(5, '2026-11-01', { urlPath: '/chart/5/a"onerror="x/' }),
      item(6, '2026-11-01', { urlPath: 'https://evil.example/chart/6/' }),
      item(7, '2026-11-01', { updated: 'soon', released: null }),
      item('x8', '2026-11-01'),
      item(9, '2026-11-01', { updated: null }), // falls back to released
    ]));
    expect(list.map((c) => c.id)).toEqual(['1', '9']);
    expect(list[1].date).toBe('2026-11-01');
  });

  it('throws on a page with no payload, so cached() keeps last-good', () => {
    expect(() => parseListing('<html>consent wall</html>')).toThrow(/no stream payload/);
  });

  it('throws on a payload with no results, and on results with nothing usable', () => {
    const noResults = `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(`${JSON.stringify(turbo({ loaderData: { root: {} } }))}\n`)});</script>`;
    expect(() => parseListing(noResults)).toThrow(/no results array/);
    expect(() => parseListing(listingHtml([item(2, '2026-11-01', { premium: true })]))).toThrow(/no infographics/);
  });
});

describe('parseChartPage', () => {
  it('reads the AI chart: its industry path and its tags', () => {
    const cls = parseChartPage(PAGE_36743);
    expect(cls.b).toEqual(['2570', '484', '418']);
    expect(cls.tags).toContain('Artificial Intelligence');
    expect(cls.tags).toContain('AI');
    expect(cls.tags).toContain('ChatGPT');
    expect(cls.tags).toContain('Generative artificial intelligence (AI) in the U.S.');
    // masterBranch and branch1 repeat each other; a label is kept once.
    expect(cls.tags.filter((t) => t === 'Artificial Intelligence')).toHaveLength(1);
  });

  it('reads the horror chart, decoding its entity-encoded labels', () => {
    const cls = parseChartPage(PAGE_36738);
    expect(cls.b).toEqual(['674', '476', '417']);
    expect(cls.tags).toContain('Cinema & Film');
    expect(cls.tags).toContain('Horror movies');
    expect(cls.tags.filter((t) => t === 'Box office revenues')).toHaveLength(1);
    expect(cls.tags.every((t) => !t.includes('&amp;'))).toBe(true);
  });

  it('normalises non-breaking spaces and leaves out the metas that are not labels', () => {
    const cls = parseChartPage(`<meta id="gtm_infographic_editor" data-page="367" />
      <meta id="gtm_infographic_idTopic" data-page="11895" />
      <meta id="gtm_infographic_masterTag1" data-page="Video&nbsp;games" />
      <meta id="gtm_infographic_tag2" data-page="Box&#160;office" />
      <script>adHandler.service.setTargeting('branchen',[478].map(String));</script>`);
    expect(cls).toEqual({ b: ['478'], tags: ['Video games', 'Box office'] });
  });

  it('is null without the branchen targeting call, so the chart is retried later', () => {
    expect(parseChartPage('<html><meta id="gtm_infographic_tag1" data-page="AI" /></html>')).toBeNull();
    expect(parseChartPage('')).toBeNull();
  });

  it('reads an empty industry list as an answer: a chart in no topic, not a failed page', () => {
    // Statista files some charts under no industry (31983, on terrorism fears).
    const page = `<meta id="gtm_infographic_topic" data-page="Terrorism" />
      <script>adHandler.service.setTargeting('branchen',[].map(String));</script>`;
    const cls = parseChartPage(page);
    expect(cls).toEqual({ b: [], tags: ['Terrorism'] });
    expect(topicsOf(cls)).toEqual([]);
    // Its tags still count, so an industry-less AI chart is not lost.
    expect(topicsOf(parseChartPage(page.replace('Terrorism', 'Generative AI')))).toEqual(['artificial intelligence']);
  });
});

describe('topicsOf', () => {
  const t = (b, tags) => topicsOf({ b: b.map(String), tags });

  it('maps each top-level industry onto its topic', () => {
    expect(t([415])).toEqual(['consumer goods']);
    expect(t([413])).toEqual(['e-commerce']);
    expect(t([408])).toEqual(['energy']);
    expect(t([414])).toEqual(['finance']);
    expect(t([412])).toEqual(['health']);
    expect(t([424])).toEqual(['internet']);
    expect(t([417])).toEqual(['media']);
    expect(t([423])).toEqual(['retail']);
    expect(t([411])).toEqual(['society']);
    expect(t([409])).toEqual(['sports']);
    expect(t([418])).toEqual(['technology']);
    expect(t([419])).toEqual(['transportation']);
    expect(t([420])).toEqual(['travel']);
  });

  it('folds the neighbouring industries into the closest topic', () => {
    expect(t([479])).toEqual(['media']); // Advertising & Marketing
    expect(t([407])).toEqual(['technology']); // Metals & Electronics
    expect(t([416])).toEqual(['society']); // Life
  });

  it('economy keeps government finances but not elections or general politics', () => {
    expect(t([2535])).toEqual(['economy']);
    expect(t([968, 966, 2535])).toEqual(['economy']); // Government Finances
    expect(t([967, 966, 2535])).toEqual([]); // Politics & Government, not finances
    expect(t([966, 2535])).toEqual([]);
  });

  it('a film, audio or gaming chart is entertainment and media both', () => {
    expect(t([674, 476, 417])).toEqual(['entertainment', 'media']);
    expect(t([475, 417])).toEqual(['entertainment', 'media']);
    expect(t([478])).toEqual(['entertainment']);
  });

  it('artificial intelligence by branch, or by a tag alone', () => {
    expect(t([2570, 484, 418])).toEqual(['artificial intelligence', 'technology']);
    expect(t([418], ['ChatGPT'])).toEqual(['artificial intelligence', 'technology']);
    expect(t([424], ['AI adoption'])).toEqual(['artificial intelligence', 'internet']);
    expect(t([424], ['LLM'])).toContain('artificial intelligence');
    expect(t([424], ['LLMs'])).toContain('artificial intelligence');
    expect(t([424], ['Generative Artificial Intelligence'])).toContain('artificial intelligence');
  });

  it('a tag that merely starts with AI, or a lowercase "ai", is not AI', () => {
    expect(t([419], ['AIRLINES', 'Air travel'])).toEqual(['transportation']);
    expect(t([419], ['ai', 'Airbus', 'MAIL'])).toEqual(['transportation']);
  });

  it('returns topics in CHART_TOPICS order, and nothing for no classification', () => {
    expect(t([420, 418, 415])).toEqual(['consumer goods', 'technology', 'travel']);
    expect(topicsOf(null)).toEqual([]);
    expect(topicsOf({ b: [415] })).toEqual(['consumer goods']); // numeric ids and missing tags are fine
    expect(t([999999])).toEqual([]);
  });
});

describe('CHART_TOPICS and resolveTopic', () => {
  it('is the 16-topic list, alphabetical by label, with unique slugs', () => {
    expect(CHART_TOPICS).toHaveLength(16);
    const labels = CHART_TOPICS.map(([label]) => label);
    expect([...labels].sort((a, b) => a.localeCompare(b))).toEqual(labels);
    const slugs = CHART_TOPICS.map(([, s]) => s);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(CHART_TOPICS).toContainEqual(['Energy & Environment', 'energy']);
  });

  it('mirrors the site list and its alias exactly', () => {
    expect(SITE_TOPICS).toEqual(CHART_TOPICS);
    for (const [from, to] of Object.entries(CHART_TOPIC_ALIASES)) expect(resolveTopic(from)).toBe(to);
  });

  it('resolves current, legacy and unknown slugs', () => {
    expect(resolveTopic('')).toBe('');
    expect(resolveTopic(null)).toBe('');
    expect(resolveTopic(undefined)).toBe('');
    expect(resolveTopic('energy')).toBe('energy');
    expect(resolveTopic('artificial intelligence')).toBe('artificial intelligence');
    expect(resolveTopic('environment')).toBe('energy');
    expect(resolveTopic('business')).toBe('');
    expect(resolveTopic('science')).toBe('');
    expect(resolveTopic('nonsense')).toBeNull();
    expect(resolveTopic('Energy')).toBeNull();
    expect(resolveTopic('__proto__')).toBeNull();
  });
});

describe('GET /chart', () => {
  it('serves the general list newest first, sponsored posts left out', async () => {
    const up = stubUpstream();
    const res = await call('/chart');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ids(body)).toEqual(['35531', '7045', '31412', '25829', '20010', '36781', '36744', '36743', '27506', '31146']);
    expect(ids(body)).not.toContain('36777');
    expect(ids(body)).not.toContain('36763');
    expect(body.chart).toEqual(body.charts[0]); // the legacy singular field
    expect(body).toMatchObject({ topic: '', fallback: false, classifiedTo: '2026-11-17' });
    expect(body.partial).toBeUndefined();
    expect(body.charts[0]).toEqual({
      id: '35531',
      title: 'Where Americans Expect the Best Deals This Holiday Season',
      desc: expect.stringMatching(/^This chart shows .*[.!?]$/),
      date: '2026-11-17',
      url: 'https://cdn.statcdn.com/Infographic/images/normal/35531.jpeg',
      link: 'https://www.statista.com/chart/35531/black-friday-product-categories-best-deals-expectations/',
      topics: ['consumer goods', 'retail'],
    });
    // Sponsored charts are never classified either: their pages are not fetched.
    expect(up.chartPages('36777')).toBe(0);
    expect(up.chartPages('36763')).toBe(0);
  });

  it('keeps the first listing of a chart and charts only page 2 carries', async () => {
    stubUpstream();
    await call('/chart');
    const index = await readIndex();
    expect(index.charts.filter((c) => c.id === '36738')).toHaveLength(1);
    expect(index.charts.find((c) => c.id === '36738').title).toBe('Horror Slays at the Box Office');
    expect(index.charts.at(-1)).toMatchObject({ id: '30001', date: '2026-10-01' });
    // Raw classification is stored, never derived topics.
    expect(index.charts.find((c) => c.id === '36743').cls.b).toEqual(['2570', '484', '418']);
    expect(index.charts.some((c) => 'topics' in c)).toBe(false);
  });

  it('a topic returns only its own charts, newest first', async () => {
    stubUpstream();
    const ai = await (await call(`/chart?topic=${encodeURIComponent('artificial intelligence')}`)).json();
    expect(ids(ai)).toEqual(['36744', '36743']); // by tag, then by branch
    expect(ai).toMatchObject({ topic: 'artificial intelligence', fallback: false });
    expect(ai.chart).toEqual(ai.charts[0]);
    const ent = await (await call('/chart?topic=entertainment')).json();
    expect(ids(ent)).toEqual(['31146', '36738']);
    expect(ent.charts.every((c) => c.topics.includes('entertainment'))).toBe(true);
    const sports = await (await call('/chart?topic=sports')).json();
    expect(ids(sports)).toEqual(['30001']); // reachable only through page 2
  });

  it('a topic with nothing recent falls back to the general list, flagged', async () => {
    stubUpstream();
    const body = await (await call('/chart?topic=travel')).json();
    expect(body).toMatchObject({ topic: 'travel', fallback: true });
    expect(ids(body)[0]).toBe('35531');
    expect(body.charts).toHaveLength(10);
    // Everything is classified, so the fallback is the honest answer.
    expect(body.partial).toBeUndefined();
  });

  it('serves legacy ?topic=environment under the energy key, ?topic=business as the general list', async () => {
    stubUpstream();
    const env1 = await (await call('/chart?topic=environment')).json();
    expect(env1.topic).toBe('energy');
    expect(await caches.default.match(cacheKey('fresh', 'chart:energy'))).toBeTruthy();
    expect(await caches.default.match(cacheKey('fresh', 'chart:environment'))).toBeUndefined();
    const biz = await (await call('/chart?topic=business')).json();
    expect(biz).toMatchObject({ topic: '', fallback: false });
    expect(await caches.default.match(cacheKey('fresh', 'chart'))).toBeTruthy();
    expect(await caches.default.match(cacheKey('fresh', 'chart:business'))).toBeUndefined();
    expect((await call('/chart?topic=science')).status).toBe(200);
  });

  it('rejects an unknown topic with 400 before any upstream fetch', async () => {
    const up = stubUpstream();
    const res = await call('/chart?topic=nonsense-not-a-topic');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_topic');
    expect(up.calls).toHaveLength(0);
  });

  it('a fallback is partial only while charts are still waiting for a first try', async () => {
    // Every chart page but the horror one fails. Each failed chart has had its
    // try and now waits out a retry delay, so re-polling in two minutes would
    // change nothing: the fallback is the answer and caches like one.
    stubUpstream({ chart: (id) => (id === '36738' ? html(PAGE_36738) : html('busy', 503)) });
    const general = await (await call('/chart')).json();
    expect(general.partial).toBeUndefined(); // not a topic answer
    expect(general.classifiedTo).toBe('2026-10-28'); // the one chart that classified
    const ent = await (await call('/chart?topic=entertainment')).json();
    expect(ids(ent)).toEqual(['36738']);
    expect(ent.partial).toBeUndefined(); // a real hit, not a fallback
    const sports = await (await call('/chart?topic=sports')).json();
    expect(sports.fallback).toBe(true);
    expect(sports.partial).toBeUndefined();
    expect(await caches.default.match(cacheKey('stale', 'chart:sports'))).toBeTruthy();
  });

  it('reports no classifiedTo when no chart page answers', async () => {
    stubUpstream({ chart: () => html('refused', 403) });
    const body = await (await call('/chart')).json();
    expect(body.charts).toHaveLength(10); // the general list needs no chart page
    expect(body.classifiedTo).toBeNull();
  });

  it('catches up inside the fresh window: a cold topic converges without a listing fetch', async () => {
    // 60 charts; the 48 newest are sports, the 12 oldest travel. The first
    // refresh classifies its cap of 48, so travel falls back, flagged partial;
    // the next miss classifies the rest and finds travel's own charts.
    const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
    const results = Array.from({ length: 60 }, (_, i) => item(40001 + i, day(i)));
    const heads = Object.fromEntries(results.map((r, i) => [r.contentId, head([i < 48 ? 409 : 420])]));
    const up = stubUpstream({
      page1: () => html(listingHtml(results)),
      page2: () => html('gone', 404),
      chart: (id) => html(heads[id]),
    });
    const first = await (await call('/chart?topic=travel')).json();
    expect(up.chartPages()).toBe(48); // the per-refresh cap
    expect(first).toMatchObject({ fallback: true, partial: true });
    // cached() keeps a partial answer briefly and never as the 24h backup.
    expect(await caches.default.match(cacheKey('stale', 'chart:travel'))).toBeUndefined();
    up.reset();
    await clearCache('chart:travel'); // the 120s partial entry runs out
    const second = await (await call('/chart?topic=travel')).json();
    expect(up.listings()).toBe(0);
    expect(up.chartPages()).toBe(12);
    expect(second.fallback).toBe(false);
    expect(second.partial).toBeUndefined();
    expect(second.charts).toHaveLength(10);
    expect(second.charts.every((c) => c.topics[0] === 'travel')).toBe(true);
  });

  it('a page-2 failure is harmless', async () => {
    stubUpstream({ page2: () => html('down', 500) });
    const res = await call('/chart');
    expect(res.status).toBe(200);
    expect(ids(await res.json())[0]).toBe('35531');
    expect((await readIndex()).charts.some((c) => c.id === '30001')).toBe(false);
  });

  it('a page-2 payload that does not parse is harmless too', async () => {
    stubUpstream({ page2: () => html('<html>consent wall</html>') });
    expect((await call('/chart')).status).toBe(200);
  });

  it('502s when page 1 fails and there is no index', async () => {
    stubUpstream({ page1: () => html('nope', 403) });
    expect((await call('/chart')).status).toBe(502);
  });

  it('a failed listing refresh is never served from the old index as if fresh', async () => {
    stubUpstream();
    await call('/chart'); // builds the index and the general key's backup
    await ageIndex();
    await Promise.all(ALL_KEYS.map((k) => caches.default.delete(cacheKey('fresh', k))));
    const up = stubUpstream({ page1: () => html('nope', 500) });
    // The general key has a last-good copy: served, and marked stale.
    const general = await call('/chart');
    expect(general.status).toBe(200);
    expect((await general.json()).stale).toBe(true);
    // A topic key with no copy of its own gets the error, not weeks-old charts
    // stamped as current.
    expect((await call('/chart?topic=media')).status).toBe(502);
    expect(up.chartPages()).toBe(0);
  });

  it('makes no listing fetch inside the index\'s fresh window', async () => {
    const up = stubUpstream();
    await call('/chart');
    up.reset();
    await clearCache('chart'); // so the route really runs again
    const res = await call('/chart');
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(0);
  });

  it('reuses classifications across refreshes', async () => {
    const up = stubUpstream();
    await call('/chart');
    expect(up.chartPages()).toBe(12); // 11 on page 1 (sponsored skipped), 1 on page 2
    await ageIndex();
    await clearRoute();
    up.reset();
    expect((await call('/chart?topic=economy')).status).toBe(200);
    expect(up.listings()).toBe(2); // a real refresh
    expect(up.chartPages()).toBe(0); // and nothing classified twice
  });

  it('retries a failed chart page on a doubling delay, and never gives up on it', async () => {
    let healthy = false;
    const up = stubUpstream({ chart: (id) => (id === '35531' && !healthy ? html('err', 500) : html(HEADS[id])) });
    const entry = async () => (await readIndex()).charts.find((c) => c.id === '35531');
    // Run a full refresh with the chart's last try `ago` in the past.
    const refresh = async (ago, tries) => {
      await ageIndex((index) => {
        const c = index.charts.find((x) => x.id === '35531');
        c.triedAt = Date.now() - ago;
        if (tries) c.tries = tries;
      });
      await clearRoute();
      up.reset();
      expect((await call('/chart')).status).toBe(200);
      return up.chartPages('35531');
    };
    expect((await call('/chart')).status).toBe(200);
    expect(await entry()).toMatchObject({ cls: null, tries: 1 });
    expect(await refresh(10 * MIN)).toBe(0); // too soon
    expect(await refresh(31 * MIN)).toBe(1); // the next refresh, half an hour on
    expect(await entry()).toMatchObject({ cls: null, tries: 2 });
    expect(await refresh(31 * MIN)).toBe(0); // the wait has doubled
    expect(await refresh(61 * MIN)).toBe(1);
    expect(await entry()).toMatchObject({ cls: null, tries: 3 });
    // However many tries, the wait stops growing at a day.
    expect(await refresh(23 * 60 * MIN, 40)).toBe(0);
    expect(await refresh(25 * 60 * MIN, 40)).toBe(1);
    // Still in the general list all along, just in no topic.
    expect(ids(await (await call('/chart')).json())[0]).toBe('35531');
    // And once the page answers, the chart is classified like any other.
    healthy = true;
    expect(await refresh(25 * 60 * MIN)).toBe(1);
    expect((await entry()).cls).toEqual({ b: ['415', '423'], tags: ['Black Friday'] });
  });

  it('a second request does not repeat a refresh another one holds', async () => {
    // No index yet, and a refresh is under way elsewhere: this request still
    // reads the listing (it owes an answer) but leaves the chart pages, and
    // the index, to the one already at them.
    const up = stubUpstream();
    await holdRefresh();
    const cold = await (await call('/chart?topic=media')).json();
    expect(up.listings()).toBe(2);
    expect(up.chartPages()).toBe(0);
    expect(await readIndex()).toBeNull();
    expect(cold).toMatchObject({ fallback: true, partial: true, classifiedTo: null });
    expect(ids(cold)[0]).toBe('35531');
  });

  it('a held refresh also parks the catch-up pass, and a finished one lets go', async () => {
    const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
    const results = Array.from({ length: 60 }, (_, i) => item(40001 + i, day(i)));
    const up = stubUpstream({
      page1: () => html(listingHtml(results)),
      page2: () => html('gone', 404),
      chart: () => html(head([409])),
    });
    expect((await call('/chart')).status).toBe(200);
    expect(up.chartPages()).toBe(48);
    expect(await caches.default.match(busyKey())).toBeUndefined(); // released when the refresh ended
    await holdRefresh();
    await clearCache('chart');
    up.reset();
    expect((await call('/chart')).status).toBe(200);
    expect(up.calls).toHaveLength(0); // a fresh index answers as it stands
    await caches.default.delete(busyKey());
    await clearCache('chart');
    expect((await call('/chart')).status).toBe(200);
    expect(up.chartPages()).toBe(12); // the catch-up pass runs once nobody holds it
  });

  it('stops reading a chart page at the targeting call, or at 64KB without one', async () => {
    // Pages served as streams far larger than the reader may take: one with the
    // targeting call in its first chunk, one with none at all.
    const streams = {};
    const big = (prefix) => {
      const s = { pulls: 0, cancelled: false };
      const filler = new TextEncoder().encode('<!-- '.padEnd(8188, 'x') + ' -->');
      const first = new TextEncoder().encode(prefix);
      s.body = new ReadableStream({
        pull(c) {
          s.pulls += 1;
          if (s.pulls > 128) c.close(); // 1MB in all
          else c.enqueue(s.pulls === 1 && prefix ? first : filler);
        },
        cancel() { s.cancelled = true; },
      });
      return s;
    };
    streams['35531'] = big("<script>adHandler.service.setTargeting('branchen',[415].map(String));</script>");
    streams['7045'] = big('');
    stubUpstream({ chart: (id) => (streams[id] ? new Response(streams[id].body) : html(HEADS[id])) });
    expect((await call('/chart')).status).toBe(200);
    const early = streams['35531'];
    const capped = streams['7045'];
    expect(early.pulls).toBeLessThan(4);
    expect(capped.pulls).toBeGreaterThanOrEqual(8); // it did read up to the 64KB cap
    expect(capped.pulls).toBeLessThan(16); // and stopped there, nowhere near 128
    expect(early.cancelled && capped.cancelled).toBe(true);
    const index = await readIndex();
    expect(index.charts.find((c) => c.id === '35531').cls).toEqual({ b: ['415'], tags: [] });
    expect(index.charts.find((c) => c.id === '7045')).toMatchObject({ cls: null, tries: 1 });
  });
});
