// Health monitor. Probes the key endpoints and validates the RESPONSE CONTENT —
// not just up/down — so it catches the real failure mode: an upstream that
// returns HTTP 200 with reshaped garbage (e.g. Yahoo changing its JSON), or a
// worker route quietly serving hours-old cache (e.g. NJT after its daily token
// cap is hit). Runs from the worker's scheduled() cron and on-demand via GET
// /health, and posts to ALERT_WEBHOOK on failure.
//
// Checks with `path` are the worker's OWN routes: they run in-process via
// selfFetch (a Worker fetching its own custom domain over the network loops →
// Cloudflare 522). Checks with `url` are external and use plain fetch. A check
// with `canary` runs code instead of probing an endpoint, for the dependency
// that has no route to watch (the CODES KV setup-code service; see codeCanary).
// `maxStaleSec` (own-route checks only): the maximum age the payload's updatedAt
// may reach before the check FAILS, enforced regardless of the `stale` flag. It
// catches two silent degradations: the worker serving last-good cache
// (`stale: true`) while an upstream refresh keeps failing, AND a frozen upstream
// that keeps answering 200 with `stale: false` but an ever-older feed clock (the
// ferry feed does exactly this). A brief blip inside the window is tolerated;
// past it the data is misleading — how the NJT token cap and similar show up.
// Self-hosters: change the hosts/paths (or delete the [triggers] block in
// wrangler.toml to turn the cron off).

const STALE_MAX = 3600; // 1h: past this, stale cache means the upstream is really down

export const CHECKS = [
  {
    name: 'site',
    url: 'https://roomboard.app/version.json',
    ok: (j) => typeof j.version === 'string' && j.version.length > 3,
  },
  {
    // The earlier flagship name (added 2026-08-21, when nothing watched it;
    // the copy has since moved on to idlescreen.app but boards configured
    // during the unsleep era still load this URL, so it is watched for as
    // long as it serves). Same Pages project, so like the aliases only the
    // custom-domain attachment and DNS can fail alone.
    name: 'site-unsleep',
    url: 'https://unsleep.app/version.json',
    ok: (j) => typeof j.version === 'string' && j.version.length > 3,
  },
  {
    // The flagship name since the 2026-08-21 rename (added 2026-08-20 as an
    // alias): a second custom domain on the SAME Pages project, so the bytes
    // are identical to `site`'s and the content can never be what differs.
    // What CAN differ is the custom-domain attachment and its DNS record — a
    // detach or a zone edit drops this name alone while the others keep
    // serving, and this is the address all the current copy points at.
    name: 'site-idlescreen',
    url: 'https://idlescreen.app/version.json',
    ok: (j) => typeof j.version === 'string' && j.version.length > 3,
  },
  {
    // Yahoo (unofficial), the flakiest dependency. updatedAt is the OLDEST
    // quote's fetch, and a closed market's quote lives up to 30 min
    // (QUOTE_IDLE_MAX_S), so a healthy night reads up to half an hour old: well
    // inside STALE_MAX. An outage still pages once the last good quote passes
    // an hour, as before.
    name: 'markets',
    path: '/markets',
    maxStaleSec: STALE_MAX,
    ok: (j) => Array.isArray(j.indices) && j.indices.length > 0 && Number.isFinite(j.indices[0].price),
  },
  {
    name: 'weather', // Open-Meteo, browser-direct (not proxied) — core dependency
    url: 'https://api.open-meteo.com/v1/forecast?latitude=40.75&longitude=-73.99&hourly=temperature_2m&forecast_days=1',
    ok: (j) => Array.isArray(j.hourly?.temperature_2m) && j.hourly.temperature_2m.length > 0,
  },
  {
    name: 'gdrive', // curated photos + backdrops; also proves GDRIVE_KEY works
    path: '/gdrive/album?folder=1RHow60mcBwzMturimQSbziK3hqCvP2lz',
    maxStaleSec: STALE_MAX,
    ok: (j) => Array.isArray(j.photos) && j.photos.length > 0,
  },
  {
    name: 'amtrak', // Amtraker (unofficial) transit proxy
    path: '/amtrak/departures',
    maxStaleSec: STALE_MAX,
    ok: (j) => typeof j.station === 'string' && Array.isArray(j.departures),
  },
  {
    // The public front door (unsleep.io, a SEPARATE Pages project deployed by
    // its own CI job) exists precisely for the moment nobody would notice it
    // silently broken (cert lapse, custom-domain removal, a build that stopped
    // shipping). changelog.json is the probe because the health framework
    // parses JSON and that file rides every front-door deploy.
    // Probed EXTERNALLY on purpose: DNS + TLS + routing are the failure modes
    // under test, which selfFetch would bypass. A check against ANY of this
    // worker's own custom domains (api.roomboard.app, api.quadrille.io,
    // api.unsleep.app, api.idlescreen.app) must NEVER be added here: the worker
    // fetching its OWN custom domain gets a Cloudflare 522 every time, proven
    // live 2026-07-31 after one night of false paging, while the domain serves
    // perfectly from outside. (Replaced backup-site 2026-08-07 when rvc.tech was
    // retired; followed the front door to unsleep.io 2026-08-18.)
    name: 'frontdoor',
    url: 'https://unsleep.io/data/changelog.json',
    ok: (j) => Array.isArray(j) && j.length > 0,
  },
  {
    // The front door's idlescreen alias (2026-08-20), same Pages project as
    // unsleep.io and therefore the same changelog byte for byte: the failure it
    // catches is the alias's custom-domain attachment or DNS going away on its
    // own, which the `frontdoor` check above cannot see. Probed externally for
    // the identical reason — DNS, TLS and routing ARE the test. Note the third
    // idlescreen name, api.idlescreen.app, deliberately gets NO check: it is one
    // of this worker's own custom domains, and the 522 rule above governs it too.
    name: 'frontdoor-idlescreen',
    url: 'https://idlescreen.io/data/changelog.json',
    ok: (j) => Array.isArray(j) && j.length > 0,
  },
  {
    // Microsoft 365 is the status row most likely to rot silently: it is the
    // only one assembled from two feeds, and its previous endpoint went to a
    // permanent 404 without anyone noticing that the row had been reading
    // "Status unavailable" for weeks. An unknown m365 state is exactly that
    // failure, so it is what this check tests — not merely that the route
    // answered. Only m365 is requested, so another provider's outage cannot
    // page for Microsoft. selfFetch hands the route the same env the request
    // handler gets, so on a worker with the optional MS_* tenant secrets set
    // this check exercises the Graph source too — though a broken tenant alone
    // won't page, since the public sources still answer the row.
    name: 'm365',
    path: '/services/status?ids=m365',
    maxStaleSec: STALE_MAX,
    ok: (j) => Array.isArray(j.services)
      && j.services.some((s) => s?.id === 'm365' && s.state !== 'unknown'),
  },
  {
    // ESPN is one upstream behind three cards: My Teams, Golf and Tennis all
    // read from site.api.espn.com, so this single check covers all three — if
    // the team row can be built, the golf and tennis scoreboards are reachable
    // too. It exists because ESPN's edge started 403ing the board's requests
    // and the row sat on yesterday's game for days before a person noticed;
    // the routes were 502ing the whole time and nothing paged. Checks the
    // CONTENT — a row with a real abbreviation — because the shape is what
    // rots: a 200 with a row that lost its team is the failure worth paging
    // for. A fixed, always-in-season team (the Yankees) so an offseason
    // league can never make the check flap.
    name: 'espn',
    path: '/sports/team?lg=mlb&id=nyy',
    maxStaleSec: STALE_MAX,
    ok: (j) => typeof j.row?.abbr === 'string' && j.row.abbr.length > 0,
  },
  {
    name: 'njt', // NJTransit — getStationSchedule is a STATIC daily timetable, so
    // "old" is not "wrong": healthy = the schedule still has a future departure.
    // A prior-day timetable (every train already in the past) is the real
    // failure. No maxStaleSec — staleness is meaningless for static daily data,
    // and NJT's own endpoint is chronically flaky (recovers only at its midnight
    // reset), so paging on age would just be nightly noise. See the redesign
    // plan in docs/superpowers/plans for fetch-once-per-day.
    path: '/njt/departures',
    ok: (j) => typeof j.station === 'string' && Array.isArray(j.trains) && j.trains.some((t) => Number(t?.time) > Date.now() / 1000),
  },
  {
    // PATH runs 24/7, so a missing station map is never a quiet hour: it is the
    // RidePATH feed having been reshaped under us. The individual direction
    // arrays DO empty out between trains, so only the skeleton is asserted
    // (every station still carries both ToNY and ToNJ), which is exactly what a
    // reshape takes away. Until this existed the route could serve 24h-old
    // cache while the monitor read green.
    name: 'path',
    path: '/path/realtime',
    maxStaleSec: STALE_MAX,
    ok: (j) => {
      const st = j.stations;
      if (!st || typeof st !== 'object' || Array.isArray(st)) return false;
      const dirs = Object.values(st);
      return dirs.length > 0 && dirs.every((d) => Array.isArray(d?.ToNY) && Array.isArray(d?.ToNJ));
    },
  },
  {
    // Stands in for the whole /alerts/{subway,lirr,mnr} family: one upstream
    // (the camsys feeds), one route, one mapper, so three checks would page
    // three times for a single MTA outage. A day with no active alerts is good
    // news and common, so an empty array passes; what rots is the row shape (an
    // alert that lost its header). maxStaleSec is the real watchdog here: an
    // alerts digest that stopped refreshing is how a resolved delay lingers on
    // a wall for a day.
    name: 'subway',
    path: '/alerts/subway',
    maxStaleSec: STALE_MAX,
    ok: (j) => Array.isArray(j.alerts) && j.alerts.every((a) => typeof a?.header === 'string'),
  },
  {
    // NYC Ferry has genuinely quiet periods (midday, overnight), and an empty
    // board then is correct rather than broken, so the validator asserts shape
    // only; a check that flapped every night would be worse than no check (same
    // reasoning as espn's always-in-season team). maxStaleSec does the real
    // work: a feed that stopped refreshing shows up as sustained staleness.
    name: 'ferry',
    path: '/ferry/departures',
    maxStaleSec: STALE_MAX,
    ok: (j) => Array.isArray(j.trips),
  },
  {
    // The setup-code service is the one dependency with no route worth probing:
    // a broken namespace, an exhausted quota or a KV outage stays invisible
    // until somebody is standing at a board typing a code that will never work.
    // So this check is a canary rather than an HTTP probe, and it appears in
    // EVERY report under the one name in both of its modes (see codeCanary), so
    // alertPlan treats it as a single concept and pages once.
    name: 'code',
    canary: codeCanary,
  },
];

// Can never collide with a real setup code: real keys are `code:` plus six
// characters of CODE_ALPHABET, which drops I, L, O and U, and HEALTH has an L.
const CANARY_KEY = 'code:HEALTH';

// Two modes on purpose, and the split is load-bearing. /health is public and
// unauthenticated (an external uptime pinger may poll it as fast as it likes),
// while KV writes are capped at 1000/day, and spending that cap is not
// hypothetical here: board polling once drained it through the shared CODES
// namespace and broke setup-code minting outright (see postCode in index.js).
// A write canary reachable from a public URL could spend the budget and cause
// the very outage it exists to watch for. Hence:
//   read mode (the default, used by the /health route): one KV get, zero
//     writes. A null answer is the SUCCESS case; it proves the binding exists,
//     the namespace answered, and the read quota is alive, which is everything
//     obtainable without spending a write.
//   write-cycle mode (cron only): the whole user path, mint then redeem,
//     through the real routes. The cron fires 72 times a day and each cycle
//     costs 2 writes (the put plus the single-use delete) and 2 reads, so about
//     144 writes/day against the 1000 cap, leaving ample room for real pairing
//     volume.
async function codeCanary({ env, selfFetch, writeCycle, sleep: sleepImpl }) {
  if (writeCycle) return codeWriteCycle(selfFetch, sleepImpl);
  if (!env?.CODES) return { ok: false, detail: 'CODES binding missing' };
  await env.CODES.get(CANARY_KEY); // null is healthy: the read itself is the test
  return { ok: true, detail: 'ok (read)' };
}

// Mint and redeem through the REAL route handlers (selfFetch, in-process). Each
// failure names the half that broke, because a dead mint and a dead redemption
// send an operator to different places.
//
// A 429 buys ONE retry, and that exception is the lesson of 2026-08-21. Cron
// delivery is at-least-once, so a run can double-fire; both twins mint through
// POST /code, and an in-process synthetic request carries no CF-Connecting-IP,
// so both land in the same 'anon' bucket of the route's 10 s per-IP throttle and
// the second is rejected by the first. That paged as an outage while the code
// service was perfectly healthy. So one 429 waits out the window and mints
// again, and the detail says it did — a pattern that recurs stays legible in the
// reports instead of hiding behind a plain 'ok'. Only 429 gets this: a 500, a
// 503 or a timeout is a real outage signal and stays an immediate failure.
const THROTTLE_RETRY_MS = 11000; // just past the route's 10 s window (see postCode)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function codeWriteCycle(selfFetch, sleepImpl = sleep) {
  const cfg = JSON.stringify({ canary: true });
  const mintOnce = () => selfFetch('/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cfg }),
  });
  let mint = await mintOnce();
  let retried = false;
  if (mint.status === 429) {
    await sleepImpl(THROTTLE_RETRY_MS);
    mint = await mintOnce();
    retried = true;
  }
  if (!mint.ok) return { ok: false, detail: `mint HTTP ${mint.status}` };
  const code = (await mint.json())?.code;
  if (typeof code !== 'string' || !code) return { ok: false, detail: 'mint returned no code' };
  const redeem = await selfFetch(`/code/${code}`);
  if (!redeem.ok) return { ok: false, detail: `redeem HTTP ${redeem.status}` };
  if ((await redeem.json())?.cfg !== cfg) return { ok: false, detail: 'cfg mismatch' };
  return { ok: true, detail: retried ? 'ok (mint+redeem, after throttle retry)' : 'ok (mint+redeem)' };
}

// Age of a payload in seconds. Every one of our own routes answers through
// cached(), which stamps updatedAt as epoch seconds on the way out, so on a
// `path` check this is never legitimately null (see probe). null when
// absent/unparseable.
function ageSeconds(updatedAt) {
  const n = Number(updatedAt);
  if (!Number.isFinite(n)) return null;
  return Math.floor(Date.now() / 1000) - n;
}

// Rejects with a TimeoutError if p doesn't settle in ms; clears the timer on
// settle so it never dangles (matters for the in-process self checks, which
// have no fetch AbortSignal of their own).
function withTimeout(p, ms) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

async function probe(check, selfFetch, extFetch, ctx = {}) {
  try {
    // A canary reports {ok, detail} from its own logic rather than from a
    // response body, and inherits the same timeout discipline as the two HTTP
    // kinds: a KV read that never settles must not hang the whole report.
    // The write-cycle canary may sleep out the /code throttle window and mint
    // once more (see codeWriteCycle), so it gets that window as headroom on top
    // of the flat 13 s every other probe lives by — otherwise the very retry
    // that proves the service healthy would be cut off and reported a timeout.
    if (check.canary) {
      const budget = 13000 + (ctx.writeCycle ? THROTTLE_RETRY_MS : 0);
      return { name: check.name, ...(await withTimeout(check.canary(ctx), budget)) };
    }
    const res = check.path
      ? await withTimeout(selfFetch(check.path), 13000)
      : await extFetch(check.url, { signal: AbortSignal.timeout(12000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) {
      // An optional route the operator chose not to configure (NJT without
      // creds, bus without a key) returns 503 {error:'..._not_configured'} —
      // a choice, not an outage. Skip it rather than page forever.
      if (res.status === 503) {
        const b = await res.text().catch(() => '');
        if (/_not_configured/.test(b)) return { name: check.name, ok: true, detail: 'not configured (skipped)' };
      }
      return { name: check.name, ok: false, detail: `HTTP ${res.status}` };
    }
    const body = await res.text();
    let json;
    try { json = JSON.parse(body); } catch { return { name: check.name, ok: false, detail: 'unparseable response' }; }
    if (!check.ok(json)) return { name: check.name, ok: false, detail: 'unexpected shape/content' };
    const age = ageSeconds(json.updatedAt);
    // A body from one of OUR routes without a readable updatedAt is a broken
    // route, not a shrug. The old code let it pass: age came back null, the
    // staleness test below skipped on null, and the check reported ok. That
    // exempted precisely the feed that had stopped telling the truth about
    // itself from the one test built to catch it. External checks (`url`) are
    // third-party JSON that never agreed to carry a stamp, so they are judged by
    // their own validator alone.
    if (check.path && age === null) {
      return { name: check.name, ok: false, detail: 'no updatedAt (unstamped payload)' };
    }
    // Age first, independent of the stale flag. A frozen upstream that keeps
    // answering 200 reports stale:false but an ever-older updatedAt (the ferry
    // feed preserves the upstream feed clock and always clears stale on a live
    // response); nesting this test inside the stale branch let that sail through
    // forever. Past maxStaleSec the data is misleading whether or not the worker
    // itself flagged the cache stale, so FAIL either way.
    if (check.maxStaleSec && age !== null && age > check.maxStaleSec) {
      const mins = Math.round(age / 60);
      return { name: check.name, ok: false, detail: `stale ${mins} min old`, stale: json.stale === true, ageSec: age };
    }
    // stale=true within the age budget is a tolerable blip: the worker served
    // last-good cache because the upstream refresh failed, but the data is recent
    // enough to still trust. Report it descriptively, ok.
    if (json.stale === true) {
      const mins = age === null ? null : Math.round(age / 60);
      return { name: check.name, ok: true, detail: mins === null ? 'ok (stale cache)' : `ok (stale ${mins} min)`, stale: true, ageSec: age };
    }
    return { name: check.name, ok: true, detail: 'ok', stale: false };
  } catch (err) {
    const detail = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err).slice(0, 80);
    return { name: check.name, ok: false, detail };
  }
}

// Runs every check concurrently. selfFetch(path, init?)→Response dispatches the
// worker's own routes in-process; extFetch defaults to global fetch (injectable
// for tests). opts.writeCycle opts the code canary into its full mint-and-redeem
// path: the cron passes it, the public /health route must not (see codeCanary).
// opts.sleep replaces the canary's throttle-retry wait, so a test can exercise
// that path without spending 11 real seconds; production never passes it.
export async function runHealthChecks(env, selfFetch, extFetch = fetch, opts = {}) {
  const ctx = { env, selfFetch, writeCycle: opts.writeCycle === true, sleep: opts.sleep ?? sleep };
  const results = await Promise.all(CHECKS.map((c) => probe(c, selfFetch, extFetch, ctx)));
  return { ok: results.every((r) => r.ok), at: new Date().toISOString(), results };
}

// Decides whether to alert this run, given the set of checks that failed LAST
// run (persisted by the caller). Only a CHANGE pages: a check flipping fail↔ok.
// An ongoing outage stays silent after its first alert, so a stuck dependency
// (e.g. NJT's token cap all afternoon) doesn't page every 20 min. Returns the
// current failing-check names for the caller to persist for next time.
export function alertPlan(report, prevFailing = []) {
  const failing = report.results.filter((r) => !r.ok);
  const names = failing.map((r) => r.name);
  const sameSet = names.length === prevFailing.length && names.every((n) => prevFailing.includes(n));
  if (sameSet) return { changed: false, failing: names, text: null };
  const recovered = prevFailing.filter((n) => !names.includes(n));
  let text;
  if (failing.length) {
    text = `🔴 idlescreen health: ${failing.map((r) => `${r.name} (${r.detail})`).join(', ')}`;
    if (recovered.length) text += ` (recovered: ${recovered.join(', ')})`;
  } else {
    text = `✅ idlescreen health: all clear (recovered: ${recovered.join(', ')})`;
  }
  return { changed: true, failing: names, text: `${text} — ${report.at}` };
}

// Which failing-set to persist for the next run's comparison. An attempted page
// that was NOT delivered (Slack/ntfy blip) must hold the PREVIOUS set, so the
// next run still sees a change and re-pages — otherwise a transient webhook
// outage silently swallows the only alert (at-least-once). A delivered page (or
// a run with nothing to send) advances to this run's set.
export function nextFailingState(plan, prevFailing, delivered) {
  if (plan.changed && plan.text && !delivered) return prevFailing;
  return plan.failing;
}

// Dead-man's switch: the monitor cannot watch itself, so every completed
// scheduled run pings HEARTBEAT_URL (a healthchecks.io-style check that pages
// when pings STOP arriving). It fires whether or not dependencies are failing:
// the ping proves the cron RAN, dep health is the webhook's job. If the run
// throws before reaching this, no ping goes out and the external check pages —
// which is exactly the point. No-op until the secret is set, so it deploys
// ahead of the account setup. Returns whether a ping was delivered.
export async function heartbeat(env, fetchImpl = fetch) {
  const url = env?.HEARTBEAT_URL;
  if (!url) return false;
  try {
    const res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(8000) });
    if (!res.ok) console.error('[health] heartbeat non-2xx', res.status);
    return res.ok;
  } catch (err) {
    console.error('[health] heartbeat failed', err);
    return false;
  }
}

// Posts a prebuilt message to ALERT_WEBHOOK. Understands Slack incoming webhooks
// (JSON {text}) and ntfy.sh (plain body) by URL; no-ops with a log if the secret
// isn't set, so the monitor can deploy before the alert channel is wired.
// Returns true when the alert was DELIVERED (2xx) — or when there's no channel
// to deliver to, an unwired config state, not a transient failure worth
// retrying — and false when a wired channel rejected or errored, so the caller
// can hold its state and re-page next run (at-least-once) instead of advancing
// past an alert nobody received.
export async function notify(env, text, fetchImpl = fetch) {
  const url = env?.ALERT_WEBHOOK;
  if (!url) { console.error('[health]', text, '(ALERT_WEBHOOK not set)'); return true; }
  const ntfy = url.includes('ntfy.sh');
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: ntfy ? { Title: 'idlescreen health' } : { 'content-type': 'application/json' },
      body: ntfy ? text : JSON.stringify({ text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('[health] alert POST non-2xx', res.status);
    return res.ok;
  } catch (err) {
    console.error('[health] alert POST failed', err);
    return false;
  }
}
