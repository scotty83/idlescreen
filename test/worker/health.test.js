import { describe, it, expect, vi } from 'vitest';
import { CHECKS, runHealthChecks, notify, alertPlan, nextFailingState, heartbeat } from '../../worker/src/health.js';

// Valid response bodies keyed by a unique substring of each check's URL, so a
// mock fetch can answer every probe with a shape its validator accepts. The
// worker's OWN routes (the `path` checks) all answer through cached(), which
// stamps the digest envelope on every payload, so their bodies carry it here
// too: a `path` body without updatedAt now fails its check on purpose.
const STAMP = () => ({ updatedAt: Math.floor(Date.now() / 1000), stale: false });
const OK_BODIES = {
  'version.json': { version: '2026.07.22-abc1234' },
  'changelog.json': [{ date: 'August 18', items: [{ lead: 'A new name', text: 'Now called unsleep.' }] }],
  '/markets': { ...STAMP(), indices: [{ symbol: '^DJI', price: 52376.73 }] },
  'open-meteo': { hourly: { temperature_2m: [70, 71, 69] } },
  'gdrive': { ...STAMP(), photos: [{ id: 'a' }, { id: 'b' }] },
  'amtrak': { ...STAMP(), station: 'New York Penn', departures: [] }, // empty at night is still healthy
  '/njt': { ...STAMP(), station: 'NY', trains: [{ time: 9999999999, dest: 'Trenton' }] }, // far-future = an upcoming departure exists
  '/services/status': { ...STAMP(), services: [{ id: 'm365', label: 'Microsoft 365', state: 'ok', note: 'All systems operational', incidents: [] }] },
  '/sports/team': { ...STAMP(), row: { lg: 'mlb', abbr: 'NYY', name: 'Yankees', record: '48-38', line: 'vs MIN · 7:05 PM' } },
  // Shapes captured live 2026-08-11. PATH keeps its station skeleton around the
  // clock even when a direction has no train in it; the alerts and ferry
  // digests are legitimately empty for hours at a time.
  '/path/realtime': {
    ...STAMP(),
    stations: {
      NWK: { ToNY: [{ t: 1754900000, headSign: 'World Trade Center', lineColors: ['D93A30'] }], ToNJ: [] },
      HAR: { ToNY: [], ToNJ: [{ t: 1754900200, headSign: 'Journal Square', lineColors: ['4D92FB'] }] },
    },
  },
  '/alerts/subway': { ...STAMP(), alerts: [{ routes: ['4', '5', '6'], stops: [], kind: 'service', header: 'Downtown 4 trains run express', body: 'Track work.' }] },
  '/ferry/departures': { ...STAMP(), trips: [] }, // quiet midday board, live-observed
};
const bodyFor = (url) => OK_BODIES[Object.keys(OK_BODIES).find((k) => url.includes(k))];

// The CODES binding the setup-code canary reads. A healthy namespace has
// nothing under code:HEALTH, so it answers null, and that null is the pass.
const okEnv = () => ({ CODES: { get: vi.fn(() => Promise.resolve(null)) } });

// Mock fetch. overrides maps a URL-substring to {status} or {body:'raw'} to
// force a specific failure for one check while the rest stay green.
function mockFetch(overrides = {}) {
  return vi.fn((url) => {
    const key = Object.keys(overrides).find((k) => url.includes(k));
    const o = overrides[key];
    if (o?.throw) return Promise.reject(Object.assign(new Error('boom'), { name: o.throw }));
    const status = o?.status ?? 200;
    const body = o && 'body' in o ? o.body : JSON.stringify(bodyFor(url));
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
  });
}

describe('health CHECKS validators', () => {
  const byName = Object.fromEntries(CHECKS.map((c) => [c.name, c.ok]));

  it('site: needs a version string', () => {
    expect(byName.site({ version: '2026.07.22-abc' })).toBe(true);
    expect(byName.site({})).toBe(false);
    expect(byName.site({ version: '' })).toBe(false);
  });
  it('site-unsleep: the flagship name is watched, same bar as site', () => {
    const byName = Object.fromEntries(CHECKS.map((c) => [c.name, c.ok]));
    expect(byName['site-unsleep']({ version: '0415bfcbee63' })).toBe(true);
    expect(byName['site-unsleep']({})).toBe(false);
    const urls = Object.fromEntries(CHECKS.map((c) => [c.name, c.url]));
    expect(urls['site-unsleep']).toBe('https://unsleep.app/version.json');
  });

  it('site-idlescreen: the same version-string bar as site (same Pages project)', () => {
    // Byte-identical content by construction, so the validator is deliberately
    // identical too; the alias's DNS and custom-domain attachment are what this
    // check actually watches.
    expect(byName['site-idlescreen']({ version: '0415bfcbee63' })).toBe(true);
    expect(byName['site-idlescreen']({})).toBe(false);
    expect(byName['site-idlescreen']({ version: '' })).toBe(false);
  });
  it('markets: needs indices with a finite price', () => {
    expect(byName.markets({ indices: [{ price: 100 }] })).toBe(true);
    expect(byName.markets({ indices: [] })).toBe(false);
    expect(byName.markets({ indices: [{ price: 'x' }] })).toBe(false);
    expect(byName.markets({})).toBe(false);
  });
  it('weather: needs an hourly temperature series', () => {
    expect(byName.weather({ hourly: { temperature_2m: [1, 2] } })).toBe(true);
    expect(byName.weather({ hourly: { temperature_2m: [] } })).toBe(false);
    expect(byName.weather({ hourly: {} })).toBe(false);
  });
  it('gdrive: needs a non-empty photos array', () => {
    expect(byName.gdrive({ photos: [{}] })).toBe(true);
    expect(byName.gdrive({ photos: [] })).toBe(false);
  });
  it('amtrak: shape-only (departures may be empty)', () => {
    expect(byName.amtrak({ station: 'NYP', departures: [] })).toBe(true);
    expect(byName.amtrak({ station: 'NYP' })).toBe(false);
    expect(byName.amtrak({ departures: [] })).toBe(false);
  });
  it('m365: an unknown status row is the failure worth paging for', () => {
    // The row read "Status unavailable" for weeks after Microsoft retired its
    // old endpoint, and nothing noticed — because the route kept answering 200.
    const row = (state) => ({ services: [{ id: 'm365', state }] });
    expect(byName.m365(row('ok'))).toBe(true);
    expect(byName.m365(row('minor'))).toBe(true); // a real outage is a working check
    expect(byName.m365(row('major'))).toBe(true);
    expect(byName.m365(row('unknown'))).toBe(false); // the endpoint rotted
    expect(byName.m365({ services: [] })).toBe(false);
    expect(byName.m365({})).toBe(false);
    expect(byName.m365({ services: [{ id: 'slack', state: 'ok' }] })).toBe(false); // wrong service
  });
  it('espn: needs a real team row, since one upstream feeds three cards', () => {
    // My Teams, Golf and Tennis all read site.api.espn.com. ESPN's edge began
    // refusing the board's requests on 2026-08-05 and all three sat on old data
    // for days with nothing paging, so this asserts the row's CONTENT: a 200
    // carrying a row that lost its team is exactly the failure worth paging for.
    expect(byName.espn({ row: { abbr: 'NYY', name: 'Yankees' } })).toBe(true);
    expect(byName.espn({ row: { abbr: '' } })).toBe(false); // shape kept, team lost
    expect(byName.espn({ row: {} })).toBe(false);
    expect(byName.espn({ row: null })).toBe(false); // mapTeamSummary returns null on an unusable payload
    expect(byName.espn({})).toBe(false);
  });
  it('njt: healthy only with an upcoming departure (static daily schedule)', () => {
    const now = Date.now() / 1000;
    expect(byName.njt({ station: 'NY', trains: [{ time: now + 600 }] })).toBe(true);
    expect(byName.njt({ station: 'NY', trains: [{ time: now - 600 }] })).toBe(false); // all past = prior day
    expect(byName.njt({ station: 'NY', trains: [] })).toBe(false);
    expect(byName.njt({ trains: [{ time: now + 600 }] })).toBe(false); // no station
  });
  it('path: needs the station skeleton, not a train (PATH runs 24/7)', () => {
    const live = OK_BODIES['/path/realtime'];
    expect(byName.path(live)).toBe(true);
    // Between trains every array empties; the skeleton is what must survive.
    expect(byName.path({ stations: { NWK: { ToNY: [], ToNJ: [] } } })).toBe(true);
    expect(byName.path({ stations: {} })).toBe(false); // no stations = the feed reshaped
    expect(byName.path({ stations: { NWK: { ToNY: [] } } })).toBe(false); // lost a direction
    expect(byName.path({ stations: [] })).toBe(false); // an array is not the station map
    expect(byName.path({ stations: null })).toBe(false);
    expect(byName.path({})).toBe(false);
  });
  it('subway: shape-only, because a day with no alerts is good news', () => {
    const live = OK_BODIES['/alerts/subway'];
    expect(byName.subway(live)).toBe(true);
    expect(byName.subway({ alerts: [] })).toBe(true); // quiet day, not an outage
    expect(byName.subway({ alerts: [{ routes: ['A'] }] })).toBe(false); // row lost its header
    expect(byName.subway({ alerts: [{ header: 42 }] })).toBe(false);
    expect(byName.subway({ alerts: {} })).toBe(false);
    expect(byName.subway({})).toBe(false);
  });
  it('ferry: shape-only, because the board is empty for hours at a time', () => {
    expect(byName.ferry({ trips: [] })).toBe(true); // midday quiet period, live-observed
    expect(byName.ferry({ trips: [{ tripId: '1', stops: [] }] })).toBe(true);
    expect(byName.ferry({ trips: {} })).toBe(false);
    expect(byName.ferry({})).toBe(false);
  });
});

describe('front-door check (the separate origin nobody would notice broken)', () => {
  const byName = Object.fromEntries(CHECKS.map((c) => [c.name, c]));
  it('probes unsleep.io externally (url, not path) via its changelog', () => {
    expect(byName['frontdoor'].url).toContain('unsleep.io/data/changelog.json');
    expect(byName['frontdoor'].path).toBeUndefined();
  });
  it('never probes the worker\'s own custom domains: that check cannot exist', () => {
    // Proven live 2026-07-31 07:20Z (on the retired rvc.tech alias): the
    // worker fetching its OWN custom domain gets a Cloudflare 522 every run,
    // custom_domain binding or not, while the domain serves perfectly from
    // outside. A check that can only measure Cloudflare's own-alias
    // restriction is worse than no check, so none of api.roomboard.app,
    // api.quadrille.io or api.unsleep.app may ever appear in CHECKS.
    expect(byName['backup-api']).toBeUndefined();
    expect(CHECKS.some((c) => (c.url || '').includes('api.roomboard.app'))).toBe(false);
    expect(CHECKS.some((c) => (c.url || '').includes('api.quadrille.io'))).toBe(false);
    expect(CHECKS.some((c) => (c.url || '').includes('api.unsleep.app'))).toBe(false);
    expect(CHECKS.some((c) => (c.url || '').includes('api.idlescreen.app'))).toBe(false);
  });
  it('a broken front door fails its own check without touching the primary', async () => {
    const m = mockFetch({ 'unsleep.io': { throw: 'TypeError' } });
    const report = await runHealthChecks(okEnv(), m, m);
    expect(report.results.find((r) => r.name === 'frontdoor').ok).toBe(false);
    expect(report.results.find((r) => r.name === 'site').ok).toBe(true);
  });
});

describe('idlescreen aliases (same stacks, separately detachable names)', () => {
  // idlescreen.app and idlescreen.io went live 2026-08-20 as custom domains on
  // the very Pages projects that already serve unsleep.app and unsleep.io, so
  // their content is identical and only their attachment is their own. A Pages
  // detach or a DNS slip takes one name dark while every other check stays
  // green, which is the whole reason these two probes exist.
  const byName = Object.fromEntries(CHECKS.map((c) => [c.name, c]));
  const run = (overrides = {}) => {
    const m = mockFetch(overrides);
    return runHealthChecks(okEnv(), m, m);
  };
  const at = (report, name) => report.results.find((r) => r.name === name);

  it('probes both alias origins externally (url, not path)', () => {
    expect(byName['site-idlescreen'].url).toBe('https://idlescreen.app/version.json');
    expect(byName['site-idlescreen'].path).toBeUndefined();
    expect(byName['frontdoor-idlescreen'].url).toBe('https://idlescreen.io/data/changelog.json');
    expect(byName['frontdoor-idlescreen'].path).toBeUndefined();
  });

  it('all green in the healthy case', async () => {
    const report = await run();
    expect(at(report, 'site-idlescreen').ok).toBe(true);
    expect(at(report, 'frontdoor-idlescreen').ok).toBe(true);
  });

  it('a detached idlescreen.app fails alone, leaving the primary app green', async () => {
    // What a Pages custom-domain detach looks like from outside: the name stops
    // resolving/serving while roomboard.app keeps answering.
    const report = await run({ 'idlescreen.app': { throw: 'TypeError' } });
    expect(at(report, 'site-idlescreen')).toMatchObject({ ok: false });
    expect(at(report, 'site').ok).toBe(true);
    expect(at(report, 'frontdoor').ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('a detached idlescreen.io fails alone, leaving the primary front door green', async () => {
    const report = await run({ 'idlescreen.io': { throw: 'TypeError' } });
    expect(at(report, 'frontdoor-idlescreen')).toMatchObject({ ok: false });
    expect(at(report, 'frontdoor').ok).toBe(true);
    expect(at(report, 'site-idlescreen').ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('reports the HTTP status when an alias serves an error page', async () => {
    const report = await run({ 'idlescreen.app': { status: 404 } });
    expect(at(report, 'site-idlescreen')).toMatchObject({ ok: false, detail: 'HTTP 404' });
  });

  it('catches the 200-with-the-wrong-thing case on the front-door alias', async () => {
    // A DNS slip that lands the name on some other origin answers 200 with HTML
    // or an empty array; neither is the changelog.
    const empty = await run({ 'idlescreen.io': { body: JSON.stringify([]) } });
    expect(at(empty, 'frontdoor-idlescreen')).toMatchObject({ ok: false, detail: 'unexpected shape/content' });
    const html = await run({ 'idlescreen.io': { body: '<html>parked</html>' } });
    expect(at(html, 'frontdoor-idlescreen')).toMatchObject({ ok: false, detail: 'unparseable response' });
  });

  it('a timeout on an alias is named as one', async () => {
    const report = await run({ 'idlescreen.io': { throw: 'TimeoutError' } });
    expect(at(report, 'frontdoor-idlescreen')).toMatchObject({ ok: false, detail: 'timeout' });
  });

  it('breaking the primaries leaves the aliases green (the pairs are independent)', async () => {
    const report = await run({ 'roomboard.app': { throw: 'TypeError' }, 'unsleep.io': { throw: 'TypeError' } });
    expect(at(report, 'site').ok).toBe(false);
    expect(at(report, 'frontdoor').ok).toBe(false);
    expect(at(report, 'site-idlescreen').ok).toBe(true);
    expect(at(report, 'frontdoor-idlescreen').ok).toBe(true);
  });

  it('each alias pages under its own name, so an operator knows which is dark', () => {
    const plan = alertPlan(
      { at: '2026-08-21T00:00:00Z', results: [{ name: 'site-idlescreen', ok: false, detail: 'HTTP 404' }, { name: 'site', ok: true }] },
      [],
    );
    expect(plan.text).toContain('site-idlescreen (HTTP 404)');
    expect(plan.failing).toEqual(['site-idlescreen']);
  });
});

describe('heartbeat (cron dead-man switch)', () => {
  it('no-ops without HEARTBEAT_URL (nothing delivered)', async () => {
    const f = vi.fn();
    expect(await heartbeat({}, f)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('pings the check URL and reports delivery', async () => {
    const f = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    expect(await heartbeat({ HEARTBEAT_URL: 'https://hc-ping.com/uuid' }, f)).toBe(true);
    expect(f).toHaveBeenCalledOnce();
    expect(f.mock.calls[0][0]).toBe('https://hc-ping.com/uuid');
  });
  it('reports false on non-2xx and on network failure', async () => {
    const bad = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    expect(await heartbeat({ HEARTBEAT_URL: 'https://hc-ping.com/uuid' }, bad)).toBe(false);
    const boom = vi.fn(() => Promise.reject(new Error('net')));
    expect(await heartbeat({ HEARTBEAT_URL: 'https://hc-ping.com/uuid' }, boom)).toBe(false);
  });
});

describe('runHealthChecks', () => {
  // One mock serves both the in-process self checks (called with a path) and the
  // external checks (called with a URL) — it matches by URL/path substring.
  const run = (overrides = {}) => {
    const m = mockFetch(overrides);
    return runHealthChecks(okEnv(), m, m);
  };

  it('reports ok when every endpoint is healthy', async () => {
    const report = await run();
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(CHECKS.length);
    expect(report.results.every((r) => r.ok)).toBe(true);
  });
  it('carries all 15 checks, each under a distinct name', () => {
    // A hard count on purpose: toHaveLength(CHECKS.length) above is circular and
    // would happily pass with a check silently deleted. 13 → 15 on 2026-08-20,
    // when the idlescreen aliases were added.
    expect(CHECKS).toHaveLength(16);
    expect(new Set(CHECKS.map((c) => c.name)).size).toBe(16);
  });
  it('flags a non-200 with its status', async () => {
    const report = await run({ '/markets': { status: 503 } });
    expect(report.ok).toBe(false);
    const markets = report.results.find((r) => r.name === 'markets');
    expect(markets).toMatchObject({ ok: false, detail: 'HTTP 503' });
  });
  it('flags an unparseable body', async () => {
    const report = await run({ 'open-meteo': { body: '<html>down</html>' } });
    expect(report.results.find((r) => r.name === 'weather')).toMatchObject({ ok: false, detail: 'unparseable response' });
  });
  it('flags a 200 with the wrong shape (the reshaped-JSON case)', async () => {
    const report = await run({ '/markets': { body: JSON.stringify({ indices: [] }) } });
    expect(report.results.find((r) => r.name === 'markets')).toMatchObject({ ok: false, detail: 'unexpected shape/content' });
  });
  it('flags a timeout by name', async () => {
    const report = await run({ gdrive: { throw: 'TimeoutError' } });
    expect(report.results.find((r) => r.name === 'gdrive')).toMatchObject({ ok: false, detail: 'timeout' });
  });
});

describe('stale-age (cached routes serving old data)', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const run = (overrides = {}) => {
    const m = mockFetch(overrides);
    return runHealthChecks(okEnv(), m, m);
  };
  const byName = (report, name) => report.results.find((r) => r.name === name);

  it('FAILS when a real-time route is stale beyond the 1h threshold', async () => {
    const body = JSON.stringify({ indices: [{ price: 100 }], stale: true, updatedAt: nowSec() - 6 * 3600 });
    const report = await run({ '/markets': { body } });
    const markets = byName(report, 'markets');
    expect(markets.ok).toBe(false);
    expect(markets.detail).toMatch(/stale \d+ min old/);
    expect(report.ok).toBe(false);
  });

  it('tolerates brief staleness within the threshold', async () => {
    const body = JSON.stringify({ indices: [{ price: 100 }], stale: true, updatedAt: nowSec() - 10 * 60 });
    const report = await run({ '/markets': { body } });
    const markets = byName(report, 'markets');
    expect(markets.ok).toBe(true);
    expect(markets.detail).toMatch(/ok \(stale \d+ min\)/);
  });

  it('FAILS an own route whose payload carries no updatedAt', async () => {
    // The silent-exemption bug: a feed that stopped stamping got a null age, the
    // staleness test skipped on null, and the check reported ok. The feed least
    // able to describe itself was the one nothing could catch, so this is loud now.
    const body = JSON.stringify({ indices: [{ price: 100 }] }); // valid shape, no stamp
    const report = await run({ '/markets': { body } });
    expect(byName(report, 'markets')).toMatchObject({ ok: false, detail: 'no updatedAt (unstamped payload)' });
    expect(report.ok).toBe(false);
  });

  it('leaves external checks alone: third-party JSON never promised a stamp', async () => {
    // version.json and the front door's changelog carry no envelope and never
    // will (nor do their idlescreen twins); only our own routes are held to it.
    const report = await run();
    expect(byName(report, 'site').ok).toBe(true);
    expect(byName(report, 'frontdoor').ok).toBe(true);
    expect(byName(report, 'site-idlescreen').ok).toBe(true);
    expect(byName(report, 'frontdoor-idlescreen').ok).toBe(true);
    expect(byName(report, 'weather').ok).toBe(true);
  });

  it('treats a 503 not-configured route as skipped, not failed', async () => {
    const report = await run({ '/njt': { status: 503, body: JSON.stringify({ error: 'njt_not_configured' }) } });
    expect(byName(report, 'njt')).toMatchObject({ ok: true, detail: 'not configured (skipped)' });
  });
});

describe('stale-age on the three routes that could serve day-old cache unwatched', () => {
  // /path/realtime, /alerts/subway and /ferry/departures all ride cached(), so
  // each can hand a board a 24h backup while the monitor sees a green 200. The
  // validators are shape-only by design (an empty alerts list or ferry board is
  // normal), which makes the stale window the actual watchdog for all three.
  const nowSec = () => Math.floor(Date.now() / 1000);
  const run = (overrides = {}) => {
    const m = mockFetch(overrides);
    return runHealthChecks(okEnv(), m, m);
  };
  const staleBody = (key, ageSec) => JSON.stringify({ ...OK_BODIES[key], stale: true, updatedAt: nowSec() - ageSec });

  for (const [name, key] of [['path', '/path/realtime'], ['subway', '/alerts/subway'], ['ferry', '/ferry/departures']]) {
    it(`${name}: FAILS past the 1h window, tolerates a brief blip inside it`, async () => {
      const old = (await run({ [key]: { body: staleBody(key, 6 * 3600) } })).results.find((r) => r.name === name);
      expect(old.ok).toBe(false);
      expect(old.detail).toMatch(/stale \d+ min old/);
      const brief = (await run({ [key]: { body: staleBody(key, 10 * 60) } })).results.find((r) => r.name === name);
      expect(brief.ok).toBe(true);
      expect(brief.detail).toMatch(/ok \(stale \d+ min\)/);
    });
  }

  it('ferry: a FROZEN upstream (stale:false with an expired feed clock) still FAILS', async () => {
    // The ferry mapper preserves the upstream feed timestamp but clears stale on
    // every live 200, so a feed stuck on yesterday's protobuf reports stale:false
    // with a 6h-old updatedAt. The age check has to catch it independent of the
    // stale flag — nested inside the stale branch this was reported healthy.
    const frozen = JSON.stringify({ ...OK_BODIES['/ferry/departures'], stale: false, updatedAt: nowSec() - 6 * 3600 });
    const r = (await run({ '/ferry/departures': { body: frozen } })).results.find((x) => x.name === 'ferry');
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/stale \d+ min old/);
    expect(r.stale).toBe(false); // truthful: the worker never flagged it stale, the age threshold did
  });
});

describe('setup-code canary: read mode (what the public /health route runs)', () => {
  const probeCode = async (env) => {
    const m = mockFetch();
    const report = await runHealthChecks(env, m, m);
    return { result: report.results.find((r) => r.name === 'code'), calls: m.mock.calls.map((c) => c[0]) };
  };

  it('rides in every report, under one name, so alertPlan sees one concept', async () => {
    const { result } = await probeCode(okEnv());
    expect(result).toBeDefined();
    expect(CHECKS.filter((c) => c.name === 'code')).toHaveLength(1);
  });
  it('a null read is the SUCCESS case: binding present, namespace answering', async () => {
    const env = okEnv();
    const { result } = await probeCode(env);
    expect(result).toMatchObject({ ok: true, detail: 'ok (read)' });
    // code:HEALTH cannot collide with a minted code: CODE_ALPHABET has no L.
    expect(env.CODES.get).toHaveBeenCalledWith('code:HEALTH');
  });
  it('a value under the canary key is healthy too: the read itself is the test', async () => {
    const { result } = await probeCode({ CODES: { get: () => Promise.resolve('{"canary":true}') } });
    expect(result.ok).toBe(true);
  });
  it('fails with a truthful detail when the namespace throws', async () => {
    const { result } = await probeCode({ CODES: { get: () => Promise.reject(new Error('KV GET failed: 429 daily limit')) } });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('429');
  });
  it('fails when the binding is missing entirely', async () => {
    const { result } = await probeCode({});
    expect(result).toMatchObject({ ok: false, detail: 'CODES binding missing' });
  });
  it('never reaches the /code routes and never writes', async () => {
    const env = { CODES: { get: vi.fn(() => Promise.resolve(null)), put: vi.fn(), delete: vi.fn() } };
    const { calls } = await probeCode(env);
    expect(calls.some((u) => String(u).startsWith('/code'))).toBe(false);
    expect(env.CODES.put).not.toHaveBeenCalled();
    expect(env.CODES.delete).not.toHaveBeenCalled();
  });
});

// A selfFetch stand-in for the write-cycle canary: POST /code answers with the
// scripted status for that attempt (the last one repeats), GET /code/:code
// redeems what was minted, and every other path falls through to the ordinary
// mock so the rest of the report still resolves.
// `latencyMs` gives each /code call a fake-timer delay, so a case can measure
// the cycle against the probe's own timeout.
function writeCycleFetch(mintStatuses = [200], latencyMs = 0) {
  const base = mockFetch();
  const minted = new Map();
  const res = (status, body) => {
    const r = {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    };
    return latencyMs ? new Promise((resolve) => setTimeout(() => resolve(r), latencyMs)) : Promise.resolve(r);
  };
  let mints = 0;
  const fn = vi.fn((path, init) => {
    if (path === '/code' && init?.method === 'POST') {
      const status = mintStatuses[Math.min(mints, mintStatuses.length - 1)];
      mints += 1;
      if (status !== 200) return res(status, { error: 'rate_limited' });
      const code = `MINT0${mints}`;
      minted.set(code, JSON.parse(init.body).cfg);
      return res(200, { code });
    }
    if (path.startsWith('/code/')) {
      const code = path.slice('/code/'.length);
      return minted.has(code) ? res(200, { cfg: minted.get(code) }) : res(404, { error: 'not_found' });
    }
    return base(path);
  });
  fn.mints = () => mints;
  return fn;
}

describe('setup-code canary: the write cycle\'s one throttle retry', () => {
  // 2026-08-21: a double-fired cron (delivery is at-least-once) had both twins
  // minting with no CF-Connecting-IP, so both shared the 'anon' throttle bucket
  // and the second drew a 429 the monitor read as an outage. One 429 now buys
  // one retry past the 10 s window — and nothing else does.
  const run = (self, sleep) => runHealthChecks(okEnv(), self, mockFetch(), { writeCycle: true, ...(sleep && { sleep }) });
  const codeRow = async (self, sleep) => (await run(self, sleep)).results.find((r) => r.name === 'code');

  it('the ordinary cycle is untouched: no wait, one mint, the same detail', async () => {
    const sleep = vi.fn(async () => {});
    const self = writeCycleFetch([200]);
    expect(await codeRow(self, sleep)).toMatchObject({ ok: true, detail: 'ok (mint+redeem)' });
    expect(sleep).not.toHaveBeenCalled();
    expect(self.mints()).toBe(1);
  });

  it('429 then success: reports ok, and SAYS it retried', async () => {
    // The detail matters as much as the pass: a duplicate cron that starts
    // firing every run has to stay legible in the reports, not hide behind 'ok'.
    const sleep = vi.fn(async () => {});
    const self = writeCycleFetch([429, 200]);
    expect(await codeRow(self, sleep)).toMatchObject({ ok: true, detail: 'ok (mint+redeem, after throttle retry)' });
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(10000); // past the route's window
    expect(self.mints()).toBe(2);
  });

  it('429 twice: fails, and retries exactly once (never a loop)', async () => {
    const sleep = vi.fn(async () => {});
    const self = writeCycleFetch([429, 429]);
    expect(await codeRow(self, sleep)).toMatchObject({ ok: false, detail: 'mint HTTP 429' });
    expect(sleep).toHaveBeenCalledOnce();
    expect(self.mints()).toBe(2);
  });

  for (const status of [500, 503]) {
    it(`${status} fails immediately: no wait, no second mint (a real outage is the signal)`, async () => {
      const sleep = vi.fn(async () => {});
      const self = writeCycleFetch([status, 200]); // a retry WOULD have succeeded
      expect(await codeRow(self, sleep)).toMatchObject({ ok: false, detail: `mint HTTP ${status}` });
      expect(sleep).not.toHaveBeenCalled();
      expect(self.mints()).toBe(1);
    });
  }

  it('the wait gets its own headroom, so a retry is never reported as a timeout', async () => {
    // An 11 s wait plus three 1.5 s round trips is 15.5 s of a probe budget that
    // is a flat 13 s for everything else — so without the write-cycle headroom
    // (see probe) the retry would be cut off and page 'timeout', which is no
    // more truthful than the 429 it replaced. Real timers would make this an
    // 11-second test, so the whole cycle runs on fake time.
    vi.useFakeTimers();
    try {
      const running = run(writeCycleFetch([429, 200], 1500)); // the REAL sleep, on fake time
      await vi.advanceTimersByTimeAsync(20000);
      const report = await running;
      expect(report.results.find((r) => r.name === 'code'))
        .toMatchObject({ ok: true, detail: 'ok (mint+redeem, after throttle retry)' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('njt static-schedule health (age-agnostic)', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);
  const run = (overrides = {}) => {
    const m = mockFetch(overrides);
    return runHealthChecks(okEnv(), m, m);
  };
  const njtResult = (report) => report.results.find((r) => r.name === 'njt');

  it('a stale-but-current timetable is HEALTHY (has an upcoming train, no age penalty)', async () => {
    // 6h stale, but the static schedule still has a future departure — the widget
    // shows correct trains, so this must NOT page (that was the nightly noise).
    const body = JSON.stringify({ station: 'NY', stale: true, updatedAt: nowSec() - 6 * 3600, trains: [{ time: nowSec() + 1200 }] });
    const report = await run({ '/njt': { body } });
    expect(njtResult(report).ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('a prior-day timetable (every train in the past) FAILS', async () => {
    const body = JSON.stringify({ station: 'NY', stale: true, updatedAt: nowSec() - 26 * 3600, trains: [{ time: nowSec() - 3600 }] });
    const report = await run({ '/njt': { body } });
    expect(njtResult(report).ok).toBe(false);
  });
});

describe('notify', () => {
  it('no-ops (no POST) when ALERT_WEBHOOK is unset', async () => {
    const fetchImpl = vi.fn();
    await notify({}, 'anything', fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('posts the message as Slack-shaped JSON', async () => {
    const fetchImpl = mockFetch();
    await notify({ ALERT_WEBHOOK: 'https://hooks.slack.com/services/x' }, '🔴 markets (HTTP 503)', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body).text).toBe('🔴 markets (HTTP 503)');
  });
  it('posts a plain-text body with Title header for ntfy.sh', async () => {
    const fetchImpl = mockFetch();
    await notify({ ALERT_WEBHOOK: 'https://ntfy.sh/roomboard-alerts' }, 'markets (HTTP 503)', fetchImpl);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Title).toBe('idlescreen health');
    expect(init.body).toBe('markets (HTTP 503)');
  });
  // Delivery signal drives at-least-once persistence (see nextFailingState).
  it('reports true when there is no channel to deliver to (unwired, not a failure to retry)', async () => {
    expect(await notify({}, 'x', vi.fn())).toBe(true);
  });
  it('reports true on a 2xx delivery', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
    expect(await notify({ ALERT_WEBHOOK: 'https://hooks.slack.com/services/x' }, 'x', fetchImpl)).toBe(true);
  });
  it('reports false when a wired channel returns non-2xx', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false, status: 500 }));
    expect(await notify({ ALERT_WEBHOOK: 'https://hooks.slack.com/services/x' }, 'x', fetchImpl)).toBe(false);
  });
  it('reports false when the POST throws', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('network')));
    expect(await notify({ ALERT_WEBHOOK: 'https://hooks.slack.com/services/x' }, 'x', fetchImpl)).toBe(false);
  });
});

describe('nextFailingState (at-least-once persistence)', () => {
  it('holds the previous set when an alert was attempted but NOT delivered (re-pages next run)', () => {
    const plan = { changed: true, text: '🔴 njt down', failing: ['njt'] };
    expect(nextFailingState(plan, [], false)).toEqual([]);
  });
  it('advances to this run\'s set once the alert is delivered', () => {
    const plan = { changed: true, text: '🔴 njt down', failing: ['njt'] };
    expect(nextFailingState(plan, [], true)).toEqual(['njt']);
  });
  it('advances when there was nothing to send (unchanged set)', () => {
    const plan = { changed: false, text: null, failing: ['njt'] };
    expect(nextFailingState(plan, ['njt'], true)).toEqual(['njt']);
  });
});

describe('alertPlan (alert only on change)', () => {
  const mk = (name, ok, detail = 'ok') => ({ name, ok, detail });
  const rep = (results) => ({ at: '2026-07-22T00:00:00Z', results });

  it('stays silent when the failing set is unchanged (ongoing outage)', () => {
    const plan = alertPlan(rep([mk('njt', false, 'stale 500 min old'), mk('site', true)]), ['njt']);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBeNull();
    expect(plan.failing).toEqual(['njt']);
  });
  it('stays silent when all green and nothing was failing', () => {
    expect(alertPlan(rep([mk('site', true), mk('njt', true)]), []).changed).toBe(false);
  });
  it('alerts on a newly-failing check', () => {
    const plan = alertPlan(rep([mk('njt', false, 'stale 500 min old'), mk('site', true)]), []);
    expect(plan.changed).toBe(true);
    expect(plan.text).toContain('🔴');
    expect(plan.text).toContain('idlescreen health:'); // lowercase always, brand rule
    expect(plan.text).toContain('njt (stale 500 min old)');
    expect(plan.failing).toEqual(['njt']);
  });
  it('sends a recovery notice when the last failure clears', () => {
    const plan = alertPlan(rep([mk('njt', true), mk('site', true)]), ['njt']);
    expect(plan.changed).toBe(true);
    expect(plan.text).toContain('✅');
    expect(plan.text).toContain('idlescreen health:');
    expect(plan.text).toContain('all clear');
    expect(plan.text).toContain('recovered: njt');
    expect(plan.failing).toEqual([]);
  });
  it('alerts when another check fails on top of an existing one', () => {
    const plan = alertPlan(rep([mk('njt', false, 'stale 500 min old'), mk('markets', false, 'HTTP 502')]), ['njt']);
    expect(plan.changed).toBe(true);
    expect(plan.text).toContain('markets (HTTP 502)');
    expect(plan.failing.sort()).toEqual(['markets', 'njt']);
  });
  it('notes a partial recovery while another stays down', () => {
    const plan = alertPlan(rep([mk('njt', false, 'stale 500 min old'), mk('markets', true)]), ['njt', 'markets']);
    expect(plan.changed).toBe(true);
    expect(plan.text).toContain('njt (stale 500 min old)');
    expect(plan.text).toContain('recovered: markets');
  });
});
