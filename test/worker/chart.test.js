import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../worker/src/index.js';
import {
  CHART_TOPICS, resolveTopic, parseListing, parseChartPage, topicsOf, fetchChart,
} from '../../worker/src/chart.js';
import { CHECKS } from '../../worker/src/health.js';
import { CHART_TOPICS as SITE_TOPICS, CHART_TOPIC_ALIASES, CHART_TOPICS_DROPPED } from '../../site/js/widgets/chart-topics.js';
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
const chartCheck = CHECKS.find((c) => c.name === 'chart');

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
    for (const slug of CHART_TOPICS_DROPPED) expect(resolveTopic(slug)).toBe(''); // the worker's general list
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
    expect(body).toMatchObject({ topic: '', fallback: false });
    expect(body.partial).toBeUndefined();
    // The general list needs no topics, so the request reads one wave of chart
    // pages (the six newest) and leaves the rest for a request that wants them.
    expect(up.chartPages()).toBe(6);
    expect(body.charts.slice(0, 6).every((c) => c.topics.length > 0)).toBe(true);
    expect(body.charts.slice(6).every((c) => c.topics.length === 0)).toBe(true);
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
    await call('/chart?topic=media');
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

  it('a fallback is provisional while any chart is unclassified, and honest once none is', async () => {
    // Only the newest chart's page answers; the rest fail and wait out a retry.
    stubUpstream({ chart: (id) => (id === '35531' ? html(HEADS[id]) : html('busy', 503)) });
    const retail = await (await call('/chart?topic=retail')).json();
    expect(ids(retail)).toEqual(['35531']);
    expect(retail.partial).toBeUndefined(); // a real hit, not a fallback
    expect(await caches.default.match(cacheKey('stale', 'chart:retail'))).toBeTruthy();
    // Media's charts are among the failed ones. The fallback must not sit on
    // the topic for an hour, nor become its backup: cached() keeps a partial
    // answer 120s and never as last-good.
    const media = await (await call('/chart?topic=media')).json();
    expect(media).toMatchObject({ fallback: true, partial: true });
    expect(ids(media)[0]).toBe('35531');
    expect(await caches.default.match(cacheKey('stale', 'chart:media'))).toBeUndefined();
    const general = await (await call('/chart')).json();
    expect(general.partial).toBeUndefined(); // the general list is never a fallback
  });

  it('a fallback with every chart classified caches like any answer', async () => {
    stubUpstream();
    const energy = await (await call('/chart?topic=energy')).json();
    expect(energy.fallback).toBe(true);
    expect(energy.partial).toBeUndefined();
    expect(await caches.default.match(cacheKey('stale', 'chart:energy'))).toBeTruthy();
  });

  it('a chart-page outage never replaces a topic\'s good backup with the fallback', async () => {
    stubUpstream();
    expect(ids(await (await call('/chart?topic=technology')).json())).toEqual(['36744', '36743']);
    // The colo loses its index (eviction) and Statista starts refusing chart
    // pages; the route's fresh entry runs out.
    await caches.default.delete(indexKey());
    await caches.default.delete(cacheKey('fresh', 'chart:technology'));
    stubUpstream({ chart: () => html('refused', 403) });
    const during = await (await call('/chart?topic=technology')).json();
    expect(during).toMatchObject({ fallback: true, partial: true });
    const backup = await (await caches.default.match(cacheKey('stale', 'chart:technology'))).json();
    expect(ids(backup)).toEqual(['36744', '36743']);
  });

  it('stops a pass when nothing answers, and parks the catch-up until the next refresh', async () => {
    const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
    const results = Array.from({ length: 60 }, (_, i) => item(40001 + i, day(i)));
    const up = stubUpstream({
      page1: () => html(listingHtml(results)),
      page2: () => html('gone', 404),
      chart: () => html('refused', 403),
    });
    const tried = async () => (await readIndex()).charts.filter((c) => c.tries === 1).length;
    const first = await (await call('/chart?topic=media')).json();
    expect(first).toMatchObject({ fallback: true, partial: true });
    expect(first.charts).toHaveLength(10); // the general list needs no chart page
    // Six failures and no success is Statista, not a bad page: the pass stops
    // there, give or take the pages already in flight, far short of its 32.
    const n = up.chartPages();
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(11);
    expect((await readIndex()).stalled).toBe(true);
    expect(await tried()).toBe(n);
    // Inside the fresh window a stalled index is left alone: no chart pages on
    // every poll while Statista refuses them.
    up.reset();
    await clearCache('chart:media');
    expect((await call('/chart?topic=media')).status).toBe(200);
    expect(up.calls).toHaveLength(0);
    // The next listing refresh tries again, with charts not yet tried (the ones
    // that failed are inside their retry delay), and stalls again.
    await ageIndex();
    await clearRoute();
    up.reset();
    expect((await call('/chart?topic=media')).status).toBe(200);
    expect(up.listings()).toBe(2);
    expect(up.chartPages()).toBeGreaterThanOrEqual(6);
    expect(up.chartPages()).toBeLessThanOrEqual(11);
    expect(await tried()).toBe(n + up.chartPages());
    expect((await readIndex()).stalled).toBe(true);
  });

  it('catches up inside the fresh window: a cold topic converges without a listing fetch', async () => {
    // 60 charts; the 32 newest are sports, the 28 oldest travel. The first
    // refresh classifies its cap of 32, so travel falls back, flagged partial;
    // the next miss classifies the rest and finds travel's own charts.
    const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
    const results = Array.from({ length: 60 }, (_, i) => item(40001 + i, day(i)));
    const heads = Object.fromEntries(results.map((r, i) => [r.contentId, head([i < 32 ? 409 : 420])]));
    const up = stubUpstream({
      page1: () => html(listingHtml(results)),
      page2: () => html('gone', 404),
      chart: (id) => html(heads[id]),
    });
    const first = await (await call('/chart?topic=travel')).json();
    expect(up.chartPages()).toBe(32); // the per-pass cap
    expect(first).toMatchObject({ fallback: true, partial: true });
    // cached() keeps a partial answer briefly and never as the 24h backup.
    expect(await caches.default.match(cacheKey('stale', 'chart:travel'))).toBeUndefined();
    up.reset();
    await clearCache('chart:travel'); // the 120s partial entry runs out
    const second = await (await call('/chart?topic=travel')).json();
    expect(up.listings()).toBe(0);
    expect(up.chartPages()).toBe(28);
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

  it('makes no fetch at all inside the fresh window once every chart has had its turn', async () => {
    const up = stubUpstream();
    await call('/chart?topic=media');
    up.reset();
    await clearCache('chart'); // so the route really runs again
    const res = await call('/chart');
    expect(res.status).toBe(200);
    expect(up.calls).toHaveLength(0);
  });

  it('reuses classifications across refreshes', async () => {
    const up = stubUpstream();
    await call('/chart?topic=media');
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
    expect(cold).toMatchObject({ fallback: true, partial: true });
    expect(ids(cold)[0]).toBe('35531');
    // The general list built this way carries no topics, so it is provisional
    // too: two minutes in the cache, never the backup, and the health check
    // does not read it as "the chart pages stopped answering".
    const general = await (await call('/chart')).json();
    expect(general.partial).toBe(true);
    expect(general.charts.every((c) => c.topics.length === 0)).toBe(true);
    expect(await caches.default.match(cacheKey('stale', 'chart'))).toBeUndefined();
    expect(chartCheck.ok(general)).toBe(true);
  });

  it('a request that defers to a held refresh still uses what the old index knows', async () => {
    const up = stubUpstream();
    await call('/chart?topic=media');
    await ageIndex();
    await clearRoute();
    await holdRefresh();
    up.reset();
    const media = await (await call('/chart?topic=media')).json();
    expect(up.listings()).toBe(2); // an aged index still owes the current listing
    expect(up.chartPages()).toBe(0);
    expect(ids(media)).toEqual(['25829', '31146', '36738']); // classifications carried over
    expect(media.partial).toBe(true);
    expect((await readIndex()).builtAt).toBe(0); // and nothing stored: the holder will
  });

  it('a held refresh also parks the catch-up pass, and a finished one lets go', async () => {
    const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
    const results = Array.from({ length: 60 }, (_, i) => item(40001 + i, day(i)));
    const up = stubUpstream({
      page1: () => html(listingHtml(results)),
      page2: () => html('gone', 404),
      chart: () => html(head([409])),
    });
    expect((await call('/chart?topic=sports')).status).toBe(200);
    expect(up.chartPages()).toBe(32);
    expect(await caches.default.match(busyKey())).toBeUndefined(); // released when the refresh ended
    await holdRefresh();
    await clearCache('chart:sports');
    up.reset();
    expect((await call('/chart?topic=sports')).status).toBe(200);
    expect(up.calls).toHaveLength(0); // a fresh index answers as it stands
    await caches.default.delete(busyKey());
    await clearCache('chart:sports');
    expect((await call('/chart?topic=sports')).status).toBe(200);
    expect(up.chartPages()).toBe(28); // the catch-up pass runs once nobody holds it
  });

  it('a refresh that loses its claim midway neither stores its index nor releases the other\'s claim', async () => {
    // Two requests claimed a moment apart and this one's check passed before
    // the other's token landed. Played here by the claim changing hands while
    // the listing is being read.
    const up = stubUpstream({
      page1: async () => {
        await caches.default.put(busyKey(), new Response('someone-else', { headers: { 'Cache-Control': 'max-age=30' } }));
        return html(LISTING);
      },
    });
    const res = await call('/chart?topic=media');
    expect(res.status).toBe(200);
    expect(ids(await res.json())).toEqual(['25829', '31146', '36738']); // it still answers from its own work
    expect(up.chartPages()).toBe(12);
    expect(await readIndex()).toBeNull(); // the index is the other request's to store
    expect(await (await caches.default.match(busyKey())).text()).toBe('someone-else');
  });

  it('keeps a chart that scrolled off the listing, drops one that turned sponsored, and caps the index', async () => {
    // 30001 (sports) is on page 2 only. Page 2 then fails: the chart survives
    // on the index alone, which is how a quiet topic keeps something to show.
    let up = stubUpstream();
    expect(ids(await (await call('/chart?topic=sports')).json())).toEqual(['30001']);
    await ageIndex();
    await clearRoute();
    up = stubUpstream({ page2: () => html('down', 500) });
    expect(ids(await (await call('/chart?topic=sports')).json())).toEqual(['30001']);
    expect(up.chartPages()).toBe(0);
    // The same chart comes back on the listing as a sponsored post: gone.
    await ageIndex();
    await clearRoute();
    stubUpstream({ page2: () => html(listingHtml([item(30001, '2026-11-18', { subtitle: 'Sponsored post by Acme' })])) });
    const after = await (await call('/chart?topic=sports')).json();
    expect(after.fallback).toBe(true);
    expect((await readIndex()).charts.some((c) => c.id === '30001')).toBe(false);
    // And the index holds the newest 300, however much the listing offers.
    await caches.default.delete(indexKey());
    await clearRoute();
    const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
    const many = (from, n) => Array.from({ length: n }, (_, i) => item(50000 + from + i, day(from + i)));
    stubUpstream({
      page1: () => html(listingHtml(many(0, 200))),
      page2: () => html(listingHtml(many(200, 150))),
      chart: () => html(head([409])),
    });
    expect((await call('/chart')).status).toBe(200);
    const capped = (await readIndex()).charts;
    expect(capped).toHaveLength(300);
    expect(capped[0].id).toBe('50000');
    expect(capped.at(-1).id).toBe('50299');
  });

  describe('the time budget', () => {
    // Chart pages that answer after `ms`, or never, and give way to the abort
    // signal like a real fetch. fetchChart is called directly so the budget can
    // be a second and a half instead of nine.
    const slowPages = (ms) => {
      const day = (i) => new Date(Date.UTC(2026, 10, 17) - i * 86400 * 1000).toISOString().slice(0, 10);
      const results = Array.from({ length: 60 }, (_, i) => item(60001 + i, day(i)));
      const seen = { pages: 0, aborted: 0 };
      vi.stubGlobal('fetch', vi.fn(async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url === P1) return html(listingHtml(results));
        if (url === P2) return html('gone', 404);
        seen.pages += 1;
        return new Promise((resolve, reject) => {
          const timer = ms == null ? null : setTimeout(() => resolve(html(head([409]))), ms);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            seen.aborted += 1;
            reject(init.signal.reason);
          });
        });
      }));
      return seen;
    };

    it('starts no chart page it has no time for, and answers inside the budget', async () => {
      const seen = slowPages(400);
      const t0 = Date.now();
      const out = await fetchChart('sports', { origin: 'https://api.test', budgetMs: 1500 });
      const took = Date.now() - t0;
      // Waves at 0, 0.4 and 0.8s fit; at 1.2s less than half a second is left.
      expect(seen.pages).toBe(18);
      expect(took).toBeLessThan(1500);
      expect(out.charts).toHaveLength(10);
      expect(out.fallback).toBe(false);
      const index = await readIndex();
      expect(index.charts.filter((c) => c.cls)).toHaveLength(18);
      expect(index.charts.filter((c) => !c.cls && !c.tries)).toHaveLength(42); // untouched, not failed
    });

    it('cuts a hanging chart page off at the deadline, not at its own timeout', async () => {
      const seen = slowPages(null);
      const t0 = Date.now();
      const out = await fetchChart('sports', { origin: 'https://api.test', budgetMs: 1500 });
      const took = Date.now() - t0;
      expect(seen.pages).toBe(6); // one wave, then the pass stalls
      expect(seen.aborted).toBe(6);
      expect(took).toBeGreaterThanOrEqual(1400);
      expect(took).toBeLessThan(2500); // a page's own timeout is 3.5s
      expect(out).toMatchObject({ fallback: true, partial: true });
      expect((await readIndex()).stalled).toBe(true);
    });
  });

  describe('what the health check makes of real answers', () => {
    const today = new Date().toISOString().slice(0, 10);
    const results = Array.from({ length: 12 }, (_, i) => item(70001 + i, today));
    const live = (chart) => stubUpstream({ page1: () => html(listingHtml(results)), page2: () => html('gone', 404), chart });

    it('passes the general list as the route serves it', async () => {
      live(() => html(head([409])));
      expect(chartCheck.ok(await (await call('/chart')).json())).toBe(true);
    });

    it('fails when chart pages are refused', async () => {
      live(() => html('refused', 403));
      expect(chartCheck.ok(await (await call('/chart')).json())).toBe(false);
    });

    it('fails when chart pages answer but say nothing: an empty industry list on every one', async () => {
      // A consent or bot variant of the page, or ad targeting switched off.
      // Every chart "classifies", no chart earns a topic.
      const up = live(() => html(head([])));
      const body = await (await call('/chart')).json();
      expect(up.chartPages()).toBe(6);
      expect(body.partial).toBeUndefined();
      expect(chartCheck.ok(body)).toBe(false);
    });

    it('fails when the industry ids no longer mean anything to the topic rules', async () => {
      live(() => html(head([9001, 9002])));
      expect(chartCheck.ok(await (await call('/chart')).json())).toBe(false);
    });
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
