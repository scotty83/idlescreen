// Statista "Chart of the Day". No feed exists. Until the November 2026
// redesign this scraped the /chartoftheday/ listing and its per-topic pages;
// those now 301 to /recent/infographics/ and the per-topic pages are gone for
// good. What replaced them, and what this file reads instead:
//   - the listing, /recent/infographics/ (and its page 2), a React Router app
//     whose data rides in an embedded turbo-stream payload: the newest 100
//     infographics per page, with no topic on them;
//   - each chart's own page, whose tag-manager metas and ad-targeting line
//     carry Statista's industry taxonomy, which is what a topic is built from.
// Fetching a chart page per chart per request would be ruinous, so the worker
// keeps one index of recent charts in the Cache API (never KV: see cached() in
// index.js), classifies each chart once, and serves every topic by filtering
// that index. Infographic images hotlink freely from cdn.statcdn.com
// (probe-verified: no cookie/referer checks) and carry the Statista branding
// baked in; the card adds a "Statista" credit line (their charts are CC BY-ND
// with attribution). Neither page needs a cookie any more, so the old SSO
// cookie-jar walk is gone too.

const SITE = 'https://www.statista.com';
const LISTING = `${SITE}/recent/infographics/`;
const LISTING_P2 = `${LISTING}p/2/`;
const IMAGE = (id) => `https://cdn.statcdn.com/Infographic/images/normal/${id}.jpeg`;

// Full browser UA: thin agents from datacenter egress get bounced by some
// CDNs (the AWS status lesson) — assume Statista is at least as picky.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'text/html' };

const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// How long one answer of the /chart route serves (its cache TTL, and so the
// oldest a healthy answer gets; the health check's age window builds on it).
// Statista posts on weekdays, so an hour bounds how late a board sees a chart.
export const CHART_TTL_S = 3600;

// The topics a board can pick, [label, slug], alphabetical by label. Slugs are
// plain identifiers now (they used to be Statista URL slugs); every one that
// survived the redesign kept its old spelling so saved boards keep working.
// topicsOf() maps each onto Statista's industry taxonomy. Mirrored by
// site/js/widgets/chart-topics.js; keep the two in sync.
export const CHART_TOPICS = [
  ['Artificial Intelligence', 'artificial intelligence'],
  ['Consumer Goods', 'consumer goods'],
  ['E-Commerce', 'e-commerce'],
  ['Economy', 'economy'],
  ['Energy & Environment', 'energy'],
  ['Entertainment', 'entertainment'],
  ['Finance', 'finance'],
  ['Health', 'health'],
  ['Internet', 'internet'],
  ['Media', 'media'],
  ['Retail', 'retail'],
  ['Society', 'society'],
  ['Sports', 'sports'],
  ['Technology', 'technology'],
  ['Transportation', 'transportation'],
  ['Travel', 'travel'],
];
const TOPIC_SLUGS = new Set(CHART_TOPICS.map(([, slug]) => slug));

// Slugs a board saved before the redesign that are no longer topics. Energy
// and Environment merged into one topic under the energy slug; Business and
// Science were dropped (no industry in the taxonomy matches either well), so
// they read as "no topic": the newest charts overall.
const LEGACY_TOPICS = new Map([
  ['environment', 'energy'],
  ['business', ''],
  ['science', ''],
]);

// '' for no topic (the general list), the slug to serve for a known topic or
// a legacy one, null for anything else (the route answers 400 before any
// upstream fetch, so a bad slug can never cost a refresh).
export function resolveTopic(raw) {
  if (raw == null || raw === '') return '';
  if (TOPIC_SLUGS.has(raw)) return raw;
  if (LEGACY_TOPICS.has(raw)) return LEGACY_TOPICS.get(raw);
  return null;
}

// ---- Topic rules -----------------------------------------------------------
// A chart page's `branchen` targeting lists its industry path in Statista's
// taxonomy: one to three numeric ids, leaf first, top-level industry last
// (order is not relied on). Ids are kept as strings, as the page gives them.

// Top-level industries that are a topic of their own.
const BRANCH_TOPICS = new Map([
  ['415', 'consumer goods'], // Consumer Goods & FMCG
  ['413', 'e-commerce'], // E-Commerce
  ['408', 'energy'], // Energy & Environment
  ['414', 'finance'], // Finance, Insurance & Real Estate
  ['412', 'health'], // Health, Pharma & Medtech
  ['424', 'internet'], // Internet
  ['417', 'media'], // Media
  ['423', 'retail'], // Retail & Trade
  ['411', 'society'], // Society
  ['409', 'sports'], // Sports & Recreation
  ['418', 'technology'], // Technology & Telecommunications
  ['419', 'transportation'], // Transportation & Logistics
  ['420', 'travel'], // Travel, Tourism & Hospitality
  // Neighbouring industries with no topic of their own, folded into the
  // closest one so their charts still reach a board.
  ['479', 'media'], // Advertising & Marketing
  ['407', 'technology'], // Metals & Electronics
  ['416', 'society'], // Life
]);

// Economy & Politics is one industry upstream, but a board that picks Economy
// wants money, not elections. So politics charts (Politics & Government) leave
// the topic unless they are about Government Finances.
const ECONOMY_POLITICS = '2535'; // Economy & Politics
const POLITICS = '966'; // Politics & Government
const GOVERNMENT_FINANCES = '968'; // Government Finances

// Sub-industries of Media (417) that make a chart entertainment as well.
const ENTERTAINMENT_BRANCHES = ['475', '476', '478']; // Audio; TV, video & film; Video gaming & esports

// Artificial Intelligence is its own industry, but most AI charts sit under
// Technology or Internet and only their tags say AI, so tags count too. The
// acronyms are case-sensitive on purpose: "AIRLINES" or "Air travel" must not
// read as AI.
const AI_BRANCH = '2570'; // Artificial Intelligence
const AI_TAG = /\bAI\b|\bChatGPT\b|\bLLMs?\b/;
const AI_PHRASE = /artificial intelligence/i;

// The topic slugs a classification earns, in CHART_TOPICS order. Derived on
// every serve rather than stored, so a rule change needs no re-fetch.
export function topicsOf(cls) {
  if (!cls) return [];
  const b = new Set((Array.isArray(cls.b) ? cls.b : []).map(String));
  const tags = Array.isArray(cls.tags) ? cls.tags : [];
  const got = new Set();
  for (const id of b) if (BRANCH_TOPICS.has(id)) got.add(BRANCH_TOPICS.get(id));
  if (b.has(ECONOMY_POLITICS) && !(b.has(POLITICS) && !b.has(GOVERNMENT_FINANCES))) got.add('economy');
  if (ENTERTAINMENT_BRANCHES.some((id) => b.has(id))) got.add('entertainment');
  if (b.has(AI_BRANCH) || tags.some((t) => AI_TAG.test(t) || AI_PHRASE.test(t))) got.add('artificial intelligence');
  return CHART_TOPICS.map(([, slug]) => slug).filter((slug) => got.has(slug));
}

// ---- Listing ---------------------------------------------------------------

// The JS string literal passed to the first streamController.enqueue(...),
// found by scanning for its closing quote rather than by regex: the payload is
// most of a 1MB page, and a backtracking pattern over that is a gamble.
function streamLiteral(html) {
  const open = html.indexOf('streamController.enqueue("');
  if (open < 0) return null;
  const start = open + 'streamController.enqueue('.length;
  for (let i = start + 1; i < html.length; i += 1) {
    if (html[i] === '\\') i += 1;
    else if (html[i] === '"') return html.slice(start, i + 1);
  }
  return null;
}

// Rebuild the turbo-stream "flat" array into plain values. flat[0] is the
// root; an object {"_1":2} means key flat[1] holds hydrate(2); an array holds
// indices; a negative index is a sentinel (undefined, null, ...) read as null.
// An array that opens with a string is a typed value (a Date, a Map); none
// occur in this payload, so one is passed through as is. The memo makes a
// shared or cyclic reference resolve to the same object instead of recursing.
function hydrate(flat) {
  const memo = new Map();
  const at = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= flat.length) return null;
    if (memo.has(i)) return memo.get(i);
    const v = flat[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        memo.set(i, v);
        return v;
      }
      const out = [];
      memo.set(i, out);
      for (const x of v) out.push(at(x));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      memo.set(i, out);
      for (const [k, x] of Object.entries(v)) {
        const key = flat[Number(k.slice(1))];
        if (typeof key === 'string') out[key] = at(x);
      }
      return out;
    }
    memo.set(i, v);
    return v;
  };
  return at(0);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DESC_MAX = 500;
const DESC_MIN_SENTENCE = 120;

// A sentence end: closing punctuation, a space, then the capital, digit or
// quote that opens the next sentence. The lookbehind refuses a period that
// follows a capital letter, so "U.S. respondents" and "Washington, D.C. has"
// are not read as ends (Statista's copy is full of both).
const SENTENCE_END = /(?<![A-Z])[.!?] (?=[A-Z0-9"“‘])/g;

// Descriptions run 900 to 3500 characters (the whole article); the viewer
// wants the opening. Cut at the last sentence end inside the limit, unless
// that would leave a stub, in which case a hard cut reads better.
function clip(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= DESC_MAX) return t;
  const window = t.slice(0, DESC_MAX + 2);
  let end = -1;
  for (const m of window.matchAll(SENTENCE_END)) end = m.index + 1;
  return end >= DESC_MIN_SENTENCE ? t.slice(0, end) : t.slice(0, DESC_MAX).trimEnd();
}

// Every listed infographic, in listing order (newest update first):
// [{ id, path, title, desc, date, sponsored }]. Throws when nothing parses, so
// the refresh fails and cached() serves last-good instead of caching junk.
export function parseListing(html) {
  const literal = streamLiteral(String(html ?? ''));
  if (!literal) throw new Error('statista: no stream payload in the listing page');
  let root;
  try {
    const stream = JSON.parse(literal);
    const nl = stream.indexOf('\n');
    root = hydrate(JSON.parse(nl < 0 ? stream : stream.slice(0, nl)));
  } catch {
    throw new Error('statista: unreadable stream payload in the listing page');
  }
  // The route id (routes/recent-en-index today) is the app's to rename, so
  // take whichever route's loader data carries the results.
  const route = Object.values(root?.loaderData ?? {}).find((v) => Array.isArray(v?.recentResponse?.results));
  if (!route) throw new Error('statista: no results array in the listing payload');
  const out = [];
  for (const r of route.recentResponse.results) {
    if (!r || r.contentType !== 'infographic' || r.premium === true) continue;
    const id = String(r.contentId ?? '');
    if (!/^\d+$/.test(id)) continue;
    const path = typeof r.urlPath === 'string' ? r.urlPath : '';
    // The path becomes a fetch URL and a link on the board, so it must be this
    // chart's own page and nothing that could break out of an attribute.
    if (!new RegExp(`^/chart/${id}/[^\\s"'<>\\\\]*$`).test(path)) continue;
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 200) : '';
    if (!title) continue;
    const updated = typeof r.updated === 'string' ? r.updated.slice(0, 10) : '';
    const released = typeof r.released === 'string' ? r.released.slice(0, 10) : '';
    const date = DAY.test(updated) ? updated : DAY.test(released) ? released : '';
    if (!date) continue;
    out.push({
      id,
      path,
      title,
      desc: clip(typeof r.description === 'string' ? r.description : ''),
      date,
      sponsored: /sponsored/i.test(typeof r.subtitle === 'string' ? r.subtitle : ''),
    });
  }
  if (!out.length) throw new Error('statista: no infographics in the listing payload');
  return out;
}

// ---- Chart page ------------------------------------------------------------

const BRANCHEN = /setTargeting\(\s*['"]branchen['"]\s*,\s*\[([^\]]*)\]/;
const GTM_META = /<meta\b[^>]*\bid="gtm_infographic_(masterBranch|branch1|topic|masterTag\d+|tag\d+)"[^>]*>/g;
const MAX_TAGS = 30;
const MAX_TAG_LEN = 80;

// A chart page's classification, { b: [industry ids], tags: [labels] }, or
// null when the page has no branchen targeting call at all (a reshaped page,
// an error page): the caller counts that as a failed try rather than a chart
// with no topic, so a later refresh asks again. A call with an EMPTY list is
// different, and real: Statista files some charts under no industry (a chart
// on terrorism fears, seen live 2026-11-18). That is an answer, a chart that
// belongs to no topic unless its tags say AI, and it must not be asked again.
export function parseChartPage(html) {
  const s = String(html ?? '');
  const m = BRANCHEN.exec(s);
  if (!m) return null;
  const b = [...m[1].matchAll(/\d+/g)].map(([id]) => id);
  const tags = [];
  for (const [tag] of s.matchAll(GTM_META)) {
    const value = /\bdata-page="([^"]*)"/.exec(tag);
    if (!value) continue;
    const t = decode(value[1].replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN);
    if (t && !tags.includes(t)) tags.push(t);
    if (tags.length >= MAX_TAGS) break;
  }
  return { b, tags };
}

// Time limits. The health monitor gives a probe 13s and a board gives a fetch
// 15s, so one request gets REQUEST_BUDGET_MS for everything it asks Statista:
// the listing first, then chart pages for whatever is left, each page's own
// timeout cut down to the time remaining. That leaves room to parse, store and
// answer even when Statista is slow, and when the health cron's seventeen
// other probes are sharing this invocation's six connections. A normal request
// takes two or three seconds.
const REQUEST_BUDGET_MS = 9000;
const LISTING_TIMEOUT_MS = 5000;
const PAGE_TIMEOUT_MS = 3500;
const PAGE_MIN_MS = 500; // with less than this left, a chart page is not worth starting
// The taxonomy sits in the first ~12KB of a ~315KB page; reading the rest
// would spend bandwidth and CPU on markup nobody looks at.
const HEAD_BYTES = 64 * 1024;

async function classifyOne(path, timeoutMs) {
  const res = await fetch(`${SITE}${path}`, {
    redirect: 'follow',
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.body) return parseChartPage(await res.text());
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < HEAD_BYTES && !BRANCHEN.test(text)) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += dec.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return parseChartPage(text);
}

// ---- Index -----------------------------------------------------------------

const INDEX_FRESH_MS = 30 * 60 * 1000; // a newer listing is worth a look every half hour
const INDEX_KEEP_S = 30 * 86400; // the Cache API may evict sooner; a rebuild just costs a cold refresh
const INDEX_CAP = 300;
const SERVE_N = 10;
// Chart pages per pass: a cold index fills over a few passes. 32, with the two
// listing pages and the cache calls around them, also keeps a pass inside the
// 50 subrequests a Free-plan worker gets (this one is on the paid plan, but
// the repo is public and a self-hosted copy may not be).
const CLASSIFY_MAX = 32;
// A request for the general list needs no topics, so it reads the pages of the
// charts it serves and no more: enough to keep a quiet colo's index moving and
// to give the health check its evidence (it wants a topic among exactly these
// charts), without the health cron (which asks for the general list every 20
// minutes, in a colo that may be cold each time) sending Statista a full pass
// on every run.
const CLASSIFY_GENERAL = SERVE_N;
const CLASSIFY_PARALLEL = 6;
// A pass that has seen this many failures and not one success has found
// Statista refusing or hanging, not a bad page: it stops, and the index is
// marked stalled so the catch-up pass waits for the next listing refresh
// instead of sending six more doomed requests on every poll in between.
const STALL_AFTER = 6; // one wave
// A chart page that failed is asked again later, never given up on: the wait
// doubles from half an hour (so the first retry is the next refresh) to a day.
// A count that stopped at "three strikes" would turn an afternoon of Statista
// refusing this worker into charts that stay topic-less for as long as the
// index lives; with a wait that only grows, a page that is broken for good
// costs one fetch a day and everything else recovers on its own.
const RETRY_BASE_MS = 30 * 60 * 1000;
const RETRY_MAX_MS = 24 * 3600 * 1000;

// Bump the version to throw every colo's index away. That is the recovery if
// Statista ever serves pages whose industry list is present but emptied: such
// a chart is stored as "in no topic" and never asked again (see
// parseChartPage), so the charts indexed during the episode would stay
// topic-less. Renumbered ids need no bump: the raw ids are what is stored.
const indexKey = (origin) => new Request(`${origin}/__cache/chart-index/v1`);
const unclassified = (c) => c.cls == null;
const untried = (c) => c.cls == null && !c.tries;
const due = (c, now) =>
  c.cls == null && (!c.tries || now - (c.triedAt ?? 0) >= Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (c.tries - 1)));

async function readIndex(origin) {
  try {
    const hit = await caches.default.match(indexKey(origin));
    if (!hit) return null;
    const index = await hit.json();
    return Array.isArray(index?.charts) ? index : null;
  } catch {
    return null; // an unreadable entry is no index: rebuild
  }
}

async function fetchListing(url, deadline) {
  const timeoutMs = Math.max(1, Math.min(LISTING_TIMEOUT_MS, deadline - Date.now()));
  const res = await fetch(url, { redirect: 'follow', headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {}); // an unread body would keep its connection
    throw new Error(`statista listing ${res.status}`);
  }
  return parseListing(await res.text());
}

// One refresh at a time. Every topic key (17 of them) expires on its own hour
// and a floor of boards waking together all miss at once; unguarded, each of
// those requests would read the same chart pages, a burst Statista could
// fairly answer by refusing this worker. The claim is a short-lived Cache API
// entry holding its owner's token, so it works across isolates in the colo.
// The Cache API has no compare-and-set, so the claim is checked rather than
// trusted: a claimant reads its token back before working (of two that wrote
// a moment apart, only the later one finds its own), reads the index again
// (the other may have just finished), checks once more before storing (so a
// loser that slipped through cannot overwrite the winner's index), and deletes
// the claim only while it is still its own. Each of those is a read followed
// by a write, so another claimant can still land its token between the two;
// what is left is a narrow window that costs a duplicate pass or one index
// written over a slightly better one, never a wrong answer.
//
// Only ANOTHER request's token counts as losing. The Cache API does not
// promise that a read sees the write just before it, and a claim that needed
// its own token back would, in a colo where that read misses, send every
// request down the deferring path for good: no chart page read, no index
// stored, every topic on its fallback, and nothing to show for it but
// provisional answers. So a missing claim reads as "still mine".
//
// A promise shared between requests would be tighter than any of this, but
// one request awaiting I/O that another started is exactly what workerd warns
// against: if the starter is cancelled, the waiter hangs.
const BUSY_S = 30; // well past REQUEST_BUDGET_MS; released as soon as the work ends anyway
const busyKey = (origin) => new Request(`${origin}/__cache/chart-index/busy`);
const lostTo = (held, token) => held !== null && held !== token;
const holder = async (origin) => {
  try {
    const hit = await caches.default.match(busyKey(origin));
    return hit ? await hit.text() : null;
  } catch {
    return null;
  }
};
// The token when this request now holds the refresh, null when another does
// (or when the cache cannot say, in which case nothing could be stored anyway).
async function claim(origin) {
  if (await holder(origin)) return null;
  const token = crypto.randomUUID();
  try {
    await caches.default.put(busyKey(origin), new Response(token, { headers: { 'Cache-Control': `max-age=${BUSY_S}` } }));
  } catch {
    return null;
  }
  return lostTo(await holder(origin), token) ? null : token;
}
async function release(origin, token) {
  if ((await holder(origin)) === token) await caches.default.delete(busyKey(origin)).catch(() => {});
}

async function writeIndex(origin, index, token) {
  if (lostTo(await holder(origin), token)) return; // the claim passed to another request: its index stands
  try {
    await caches.default.put(indexKey(origin), new Response(JSON.stringify(index), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${INDEX_KEEP_S}` },
    }));
  } catch (err) {
    // Best effort: this request still serves the index it just built.
    console.warn(`[chart] index write failed: ${String(err?.message ?? err)}`);
  }
}

// Classify the newest unclassified charts that `want` selects, in place, a
// wave of CLASSIFY_PARALLEL at a time, until `max` are done or the request's
// deadline is near. One failure costs that chart a try and nothing else.
// Returns true when the pass stalled (see STALL_AFTER). Waves rather than a
// pool of lanes, so the stall and the deadline are judged between waves on
// settled results: lanes that each took the next page as their own failure
// landed would start a second round of doomed requests before the count
// reached six, and a hanging Statista would cost two timeouts instead of one.
async function classify(charts, { want = due, max, deadline }) {
  const queue = charts.filter((c) => want(c, Date.now())).slice(0, max);
  let ok = 0;
  let failed = 0;
  const one = async (c, timeoutMs) => {
    try {
      const cls = await classifyOne(c.path, timeoutMs);
      if (cls) {
        c.cls = cls;
        ok += 1;
        return;
      }
      console.warn(`[chart] ${c.id}: no branchen targeting on the chart page`);
    } catch (err) {
      // Cut off by this request's deadline, not by the page's own timeout:
      // that says the request ran out of time, nothing about the page. It
      // stays untried, and the catch-up pass takes it next.
      if (timeoutMs < PAGE_TIMEOUT_MS && err?.name === 'TimeoutError') return;
      console.warn(`[chart] ${c.id}: chart page failed: ${String(err?.message ?? err)}`);
    }
    failed += 1;
    c.tries = (c.tries ?? 0) + 1;
    c.triedAt = Date.now();
  };
  const stalled = () => ok === 0 && failed >= STALL_AFTER;
  for (let i = 0; i < queue.length && !stalled(); i += CLASSIFY_PARALLEL) {
    const left = deadline - Date.now();
    if (left < PAGE_MIN_MS) break;
    const timeoutMs = Math.min(PAGE_TIMEOUT_MS, left);
    await Promise.all(queue.slice(i, i + CLASSIFY_PARALLEL).map((c) => one(c, timeoutMs)));
  }
  return stalled();
}

// Re-read the listing and fold it into the old index: listed charts first
// (carrying over what is already known about each), then charts that have
// scrolled off the listing. A failed page 1 throws even when an old index is
// at hand: serving that would hand cached() a "fresh" answer built from a
// listing that may be weeks old, where throwing lets it serve the route's own
// last-good copy marked stale, or the error.
//
// Page 2 is best effort, but its absence is remembered (`short`): the older
// half of the listing is where a quiet topic's only chart tends to be, so an
// index built without it cannot say a topic is empty (see fetchChart).
async function readListing(old, deadline) {
  const [p1, p2] = await Promise.allSettled([fetchListing(LISTING, deadline), fetchListing(LISTING_P2, deadline)]);
  if (p1.status === 'rejected') throw p1.reason;
  if (p2.status === 'rejected') {
    console.warn(`[chart] listing page 2 failed (ignored): ${String(p2.reason?.message ?? p2.reason)}`);
  }
  const listed = [...p1.value, ...(p2.status === 'fulfilled' ? p2.value : [])];
  const prev = new Map((old?.charts ?? []).map((c) => [c.id, c]));
  const seen = new Set();
  const merged = [];
  for (const item of listed) {
    if (seen.has(item.id)) continue;
    // Marked seen even when sponsored, so an old copy of a chart that has
    // since turned sponsored is dropped below rather than kept.
    seen.add(item.id);
    if (item.sponsored) continue;
    const was = prev.get(item.id);
    merged.push({
      id: item.id,
      path: item.path,
      title: item.title,
      desc: item.desc,
      date: item.date,
      cls: was?.cls ?? null,
      tries: was?.tries ?? 0,
      ...(was?.triedAt ? { triedAt: was.triedAt } : {}),
    });
  }
  // Charts that have scrolled off the listing stay reachable through the index
  // alone, which is how a quiet topic keeps a chart to show.
  for (const c of old?.charts ?? []) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      merged.push(c);
    }
  }
  // Newest first; Array.prototype.sort is stable, so a date tie keeps the
  // listing's own order (which is by update time).
  merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { charts: merged.slice(0, INDEX_CAP), ...(p2.status === 'rejected' ? { short: true } : {}) };
}

const isFresh = (index) => Boolean(index) && Date.now() - index.builtAt < INDEX_FRESH_MS;
// Nothing to do before the next listing refresh: fresh, and either every chart
// has had its turn or the last pass stalled and more would only stall again.
const settled = (index) => isFresh(index) && (index.stalled === true || !index.charts.some(untried));

// The index to answer from. `max` is how many chart pages this request may
// read (see CLASSIFY_MAX and CLASSIFY_GENERAL).
//
// Inside the fresh window the listing is not re-read, but charts that were
// never tried still get their turn (the catch-up pass): a cold colo's first
// refresh stops at `max`, and without this the rest would wait out the whole
// window while topics served their fallback (see the note in fetchChart). Only
// never-tried charts: a page that failed waits out its retry delay, and
// builtAt is kept, so the listing refresh stays on schedule.
//
// When another request holds the refresh, this one does not wait for it. A
// missing or aged index still owes this request the current listing, so it
// reads that; a fresh one is used as it stands. Either way it classifies
// nothing and stores nothing, and says so (`light`), which makes the answer
// provisional (see fetchChart): the holder is about to store better.
async function loadIndex(origin, max, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let old = await readIndex(origin);
  if (settled(old)) return old;
  const token = await claim(origin);
  if (!token) {
    return isFresh(old)
      ? { ...old, light: true }
      : { builtAt: Date.now(), ...(await readListing(old, deadline)), light: true };
  }
  try {
    old = await readIndex(origin); // whoever held the claim before may have just finished
    if (settled(old)) return old;
    const fresh = isFresh(old);
    // A catch-up pass keeps the build time and whether page 2 was missing: both
    // describe the listing read, and this pass reads no listing.
    const base = fresh
      ? { builtAt: old.builtAt, charts: old.charts, ...(old.short ? { short: true } : {}) }
      : { builtAt: Date.now(), ...(await readListing(old, deadline)) };
    const stalled = await classify(base.charts, { want: fresh ? untried : due, max, deadline });
    const index = { ...base, ...(stalled ? { stalled: true } : {}) };
    await writeIndex(origin, index, token);
    return index;
  } finally {
    await release(origin, token);
  }
}

// ---- Serving ---------------------------------------------------------------

const served = (c) => ({
  id: c.id,
  title: c.title,
  desc: c.desc,
  date: c.date,
  url: IMAGE(c.id),
  link: `${SITE}${c.path}`,
  topics: topicsOf(c.cls),
});

// The newest charts for a topic ('' = the newest overall). A topic with no
// classified chart falls back to the general list, flagged, so a board never
// blanks on a quiet topic. budgetMs is the route's to leave alone; tests
// shorten it to see the deadline hold without waiting nine seconds.
export async function fetchChart(topic = '', { origin, budgetMs = REQUEST_BUDGET_MS } = {}) {
  if (!origin) throw new Error('chart: origin required');
  const t = resolveTopic(topic);
  if (t === null) throw new Error(`statista: unknown topic "${topic}"`);
  const index = await loadIndex(origin, t ? CLASSIFY_MAX : CLASSIFY_GENERAL, budgetMs);
  const all = index.charts ?? [];
  if (!all.length) throw new Error('statista: the chart index is empty');
  let picked = all.slice(0, SERVE_N);
  let fallback = false;
  if (t) {
    const hits = all.filter((c) => c.cls && topicsOf(c.cls).includes(t)).slice(0, SERVE_N);
    if (hits.length) picked = hits;
    else fallback = true;
  }
  const charts = picked.map(served);
  // Keep `chart` (the newest) beside `charts[]` so a client that only reads the
  // legacy singular field keeps working when this worker deploys ahead of the
  // new widget (e.g. prod worker updated, prod chart widget not yet).
  const out = { chart: charts[0], charts, topic: t, fallback };
  // Provisional answers. partial: true makes cached() keep an answer for at
  // most 120s and never write it over the route's 24h backup, which is right
  // for two kinds of answer here:
  //   - a topic fallback while any chart is still unclassified. The topic may
  //     be empty only because its charts are waiting their turn (a cold colo
  //     fills over a few passes, and each poll that gets past the 120s runs
  //     the next one) or because Statista is refusing the chart pages; either
  //     way the newest-overall list must not sit on the topic for an hour, and
  //     must never replace a backup that holds the topic's real charts. Once
  //     every chart is classified, a fallback is the honest answer and caches
  //     for the full hour.
  //     The same goes for a fallback from an index built without page 2 of
  //     the listing (`short`): the topic's charts may simply be on the page
  //     that failed.
  //   - any answer built from a light index: it skipped the chart pages, and
  //     the request that held the refresh is about to store better.
  if (index.light || (fallback && (index.short || all.some(unclassified)))) out.partial = true;
  return out;
}
