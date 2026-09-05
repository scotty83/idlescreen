// Formula 1 digest, from Jolpica (the keyless community successor to Ergast).
// Four endpoints — next race, last-race results, driver + constructor standings —
// fanned out and merged into one digest, cached 1h at the route. Team colours
// and driver flags are added on the site, not here (this stays generic data).
//
// The digest serves two surfaces: the small CARD (next race, podium, top of both
// standings) and the full-screen SEASON VIEW behind a tap (the whole weekend
// schedule, the whole classification, both championships). The card's fields are
// therefore frozen — `podium` in particular stays exactly as it was — and the
// view's richer fields sit BESIDE them. Any of the view's fields may be missing
// from a board's cached digest, so the view drops the affected block rather
// than assuming it is there.

const JOLPICA = 'https://api.jolpi.ca/ergast/f1/current';
// Full browser UA — thin datacenter agents get bounced by some hosts.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Four SEQUENTIAL fetches at 10s each could stack to ~40s — far past the board's
// 15s fetch (site/js/net.js) and health's 13s self-probe (worker/src/health.js),
// so a couple of slow blocks failed the whole card. This overall budget shrinks
// each fetch's timeout to the time left and skips the remaining blocks once it
// lapses; a skipped block is a rejection like any other, so it degrades to null
// and marks the digest partial (mendF1 backfills it from the 24h backup).
export const F1_DEADLINE_MS = 12000; // under the 13s probe, with margin for merge + cache writes
const F1_MIN_ATTEMPT_MS = 1200; // don't open a fetch with less budget than this

const num = (x) => Number(x);

// The weekend's sessions, in the payload's own vocabulary. Ids are stable and
// short because the SITE owns the wording; labels ride along so a future
// session type the site has never heard of still has something to print.
// Order comes from the DATES, not this list: on a sprint weekend qualifying
// falls after the sprint, and the schedule has to read the way it happens.
const SESSIONS = [
  ['FirstPractice', 'fp1', 'Practice 1'],
  ['SecondPractice', 'fp2', 'Practice 2'],
  ['ThirdPractice', 'fp3', 'Practice 3'],
  ['SprintQualifying', 'sq', 'Sprint Qualifying'],
  ['Sprint', 'sprint', 'Sprint'],
  ['Qualifying', 'q', 'Qualifying'],
];

// Dates and times stay exactly as the payload gives them: `date` is a plain
// YYYY-MM-DD and `time` is UTC ("13:00:00Z") or ''. The site formats both in
// the board's own timezone at the board's 12/24h preference — a worker cached
// for an hour has no business deciding what o'clock it is for a reader.
function mapSessions(r) {
  const out = [];
  for (const [key, id, label] of SESSIONS) {
    const s = r?.[key];
    if (s?.date) out.push({ id, label, date: String(s.date), time: String(s.time ?? '') });
  }
  if (r?.date) out.push({ id: 'race', label: 'Race', date: String(r.date), time: String(r.time ?? '') });
  return out.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

function mapNext(j) {
  const r = j?.MRData?.RaceTable?.Races?.[0];
  if (!r) return null;
  return {
    name: String(r.raceName ?? ''),
    date: String(r.date ?? ''),
    // The race's own UTC start, kept beside the date so a countdown and a
    // schedule row can both be exact rather than assuming an hour.
    time: String(r.time ?? ''),
    circuit: String(r.Circuit?.circuitName ?? ''),
    // Keys the bundled track outline (site/data/f1-tracks.json). An id with no
    // bundled outline simply draws no map.
    circuitId: String(r.Circuit?.circuitId ?? ''),
    country: String(r.Circuit?.Location?.country ?? ''),
    round: num(r.round) || null, // the calendar's ROUND N; the season total is not in this payload
    sessions: mapSessions(r),
  };
}

// One classification row, as a table: where they started, where they finished,
// what they scored, and how far back they were.
//
// A finishing time, a gap, or nothing. Ergast puts the winner's TOTAL race time
// and everyone else's gap-to-winner in the same `Time.time` field ("1:27:11.335"
// / "+0.427"); a lapped or retired car has no Time at all and only `status`
// says what happened. Both are forwarded raw — deciding which of them is a
// result and which is a failure (and what tone it earns) is the site's job.
function mapResults(r) {
  return (r?.Results ?? []).map((x) => ({
    pos: num(x.position),
    driver: String(x.Driver?.familyName ?? ''),
    // The view draws the same flagcdn flags the card does, so the rows need
    // the same demonym the podium rows carry.
    nat: String(x.Driver?.nationality ?? ''),
    cid: String(x.Constructor?.constructorId ?? ''),
    // Starting position. Ergast writes 0 for a pit-lane start.
    grid: num(x.grid) || 0,
    // Points scored in THIS race (0 for everyone outside the top ten, plus the
    // fastest-lap point where the season awards one) — not the championship
    // total, which is what the standings block carries.
    pts: num(x.points) || 0,
    time: String(x.Time?.time ?? ''),
    status: String(x.status ?? ''),
    // Rank 1 across the field, not the driver's own best lap.
    fastest: String(x.FastestLap?.rank ?? '') === '1',
  }));
}

function mapLast(j) {
  const r = j?.MRData?.RaceTable?.Races?.[0];
  if (!r?.Results?.length) {
    return { lastRace: null, lastDate: null, lastCircuit: null, lastCircuitId: null, podium: null, results: [] };
  }
  // Unchanged shape, unchanged field: the CARD reads this and must not move.
  const podium = r.Results.slice(0, 3).map((x) => ({
    pos: num(x.position),
    driver: String(x.Driver?.familyName ?? ''),
    nat: String(x.Driver?.nationality ?? ''),
    cid: String(x.Constructor?.constructorId ?? ''),
  }));
  return {
    lastRace: String(r.raceName ?? ''),
    lastDate: String(r.date ?? '') || null,
    lastCircuit: String(r.Circuit?.circuitName ?? '') || null,
    lastCircuitId: String(r.Circuit?.circuitId ?? '') || null,
    podium,
    results: mapResults(r),
  };
}

function mapDrivers(j) {
  const list = j?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings ?? [];
  return list.map((s) => ({
    pos: num(s.position),
    name: String(s.Driver?.familyName ?? ''),
    nat: String(s.Driver?.nationality ?? ''),
    // A driver's CURRENT team is the last constructor listed for the season.
    cid: String(s.Constructors?.[s.Constructors.length - 1]?.constructorId ?? ''),
    pts: num(s.points),
    wins: num(s.wins) || 0,
  }));
}

// The season the digest describes. The /next payload carries it on the race;
// the standings carry it on the list. Either will do — whichever block came
// back — and a digest with neither simply has no season to name.
function seasonOf(...jsons) {
  for (const j of jsons) {
    const s = j?.MRData?.RaceTable?.Races?.[0]?.season
      ?? j?.MRData?.RaceTable?.season
      ?? j?.MRData?.StandingsTable?.StandingsLists?.[0]?.season
      ?? j?.MRData?.StandingsTable?.season;
    if (s) return String(s);
  }
  return null;
}

function mapConstructors(j) {
  const list = j?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings ?? [];
  return list.map((s) => ({
    pos: num(s.position),
    cid: String(s.Constructor?.constructorId ?? ''),
    name: String(s.Constructor?.name ?? ''),
    pts: num(s.points),
  }));
}

// Pure: each argument is a parsed Jolpica JSON object (or null for a block that
// failed to fetch). Null blocks degrade to null/[] rather than throwing.
export function mapF1(nextJson, lastJson, driversJson, teamsJson) {
  return {
    season: seasonOf(nextJson, driversJson, teamsJson, lastJson),
    next: mapNext(nextJson),
    ...mapLast(lastJson),
    drivers: mapDrivers(driversJson),
    teams: mapConstructors(teamsJson),
  };
}

// deadlineMs is injectable only so a test can exercise the budget path in a
// fraction of a second; the route always takes the default.
export async function fetchF1({ deadlineMs = F1_DEADLINE_MS } = {}) {
  const deadline = Date.now() + deadlineMs;
  const get = async (path) => {
    // Shrink each fetch's timeout to the remaining budget so the last block
    // can't outlive the overall deadline.
    const res = await fetch(`${JOLPICA}/${path}/?format=json`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(Math.min(10000, deadline - Date.now())),
    });
    if (!res.ok) throw new Error(`jolpica ${path} ${res.status}`);
    return res.json();
  };
  // SEQUENTIAL, with air between the calls — never parallel. Jolpica's
  // unauthenticated burst limit sits at about four requests a second, and four
  // parallel fetches land exactly on it: one to three of them draw a 429
  // depending on timing, which is how the board spent a night showing a
  // drivers-only card while every endpoint answered 200 to a polite client
  // (live diagnosis 2026-08-02). A cache-missing fetch happens at most every
  // hour when healthy, so ~1.5s of serialization costs nothing.
  const paths = ['next', 'last/results', 'driverStandings', 'constructorStandings'];
  const settled = [];
  for (const path of paths) {
    // Out of budget: skip the rest (they degrade to null and mark the digest
    // partial) rather than overrun the deadline and take the whole card down.
    if (deadline - Date.now() < F1_MIN_ATTEMPT_MS) { settled.push({ status: 'rejected' }); continue; }
    try {
      settled.push({ status: 'fulfilled', value: await get(path) });
    } catch (err) {
      // Named per endpoint: the original incident was invisible because the
      // rejections were swallowed silently and only a TOTAL wipeout logged.
      console.warn(`[f1] ${path} failed: ${String(err?.message ?? err)}`);
      settled.push({ status: 'rejected' });
    }
    // Only pause between blocks we can still afford — never past the deadline.
    if (settled.length < paths.length && deadline - Date.now() > F1_MIN_ATTEMPT_MS) await new Promise((r) => setTimeout(r, 250));
  }
  if (settled.every((s) => s.status === 'rejected')) throw new Error('jolpica: all endpoints failed');
  const val = (s) => (s.status === 'fulfilled' ? s.value : null);
  const digest = mapF1(...settled.map(val));
  // A partial digest is fine to serve fresh but must not overwrite the complete
  // 24h stale backup (same guard as /markets).
  const partial = settled.some((s) => s.status === 'rejected');
  return { ...digest, ...(partial && { partial: true }) };
}

// Fill a partial digest's missing blocks from the 24h stale backup. F1 data
// changes on race weekends, not by the minute, so a day-old next-race block or
// constructors table is the truth for a reader — and a card should never look
// gutted over one bounced upstream call. The result KEEPS partial: true (so it
// caches briefly and never overwrites the stale backup) and adds mended: true
// for diagnosability.
export function mendF1(fresh, stale) {
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const out = { ...fresh };
  for (const [k, v] of Object.entries(stale ?? {})) {
    if (k === 'updatedAt' || k === 'stale' || k === 'partial' || k === 'mended') continue;
    if (empty(out[k])) out[k] = v;
  }
  return { ...out, mended: true };
}
