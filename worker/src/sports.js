// "My Teams" composite: ESPN's team endpoint (record, logo, live/next event)
// plus the last completed game from the schedule endpoint. The schedule runs
// ~2 MB — far too heavy for gen1 boards — so it's digested here and cached
// long (results change at most a few times a day). How long a composed row
// stays fresh depends on its game state (see teamFreshS).
//
// Subrequest budget: the Workers Free plan allows 50 per invocation, and
// fetch, Cache API match and Cache API put each count as one. /sports/team
// spends at most 8: cached()'s fresh-entry match and its fresh + stale puts
// (3), the team fetch (1), and 4 in here whichever way the two cached lookups
// below go (see cachedLiveComp).
//
// Every fetch here MUST carry ESPN_UA — ESPN's edge 403s a request without it.
// See worker/src/espn.js for why the string looks the way it does.

import { ESPN_UA } from './espn.js';

export const LEAGUE_PATHS = {
  mlb: 'baseball/mlb',
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  nhl: 'hockey/nhl',
  mls: 'soccer/usa.1',
  epl: 'soccer/eng.1',
};

const score = (c) => {
  const v = c?.score?.value ?? c?.score?.displayValue ?? c?.score;
  return v === undefined || v === null || v === '' ? null : String(v);
};

function eventLine(comp, ourAbbr, { withWL = false } = {}) {
  const status = comp.status?.type ?? {};
  const us = (comp.competitors ?? []).find((c) => c.team?.abbreviation === ourAbbr);
  const them = (comp.competitors ?? []).find((c) => c !== us);
  const vsAt = us?.homeAway === 'home' ? 'vs' : '@';
  const opp = them?.team?.abbreviation ?? '?';
  if (status.state === 'pre') return `${vsAt} ${opp} · ${status.shortDetail ?? ''}`.trim();
  const usS = score(us);
  const themS = score(them);
  const wl = withWL && status.state === 'post'
    ? (Number(usS) > Number(themS) ? 'W ' : Number(usS) < Number(themS) ? 'L ' : 'T ')
    : '';
  // ESPN's team endpoint nulls scores mid-game (the scoreboard join below
  // usually fills them); a scoreless live line drops the score fragment
  // rather than printing dashes.
  const scores = usS === null && themS === null ? '' : `${usS ?? '–'}-${themS ?? '–'} `;
  return `${wl}${scores}${vsAt} ${opp} · ${status.shortDetail ?? ''}`.trim();
}

// Most recent completed game from a schedule payload -> compact line.
export function digestSchedule(schedJson, ourAbbr) {
  const done = (schedJson?.events ?? []).filter(
    (e) => e.competitions?.[0]?.status?.type?.state === 'post',
  );
  if (!done.length) return null;
  const last = done[done.length - 1];
  return eventLine(last.competitions[0], ourAbbr, { withWL: true });
}

// Next FUTURE scheduled game -> compact line ("vs LAD · 7/20 - 7:10 PM EDT").
// The date check matters: postponed games keep state 'pre' with their ORIGINAL
// (past) date, and ESPN's team nextEvent pointer can sit on them for hours —
// this digest looks past that to the next real fixture.
export function digestNext(schedJson, ourAbbr, nowMs = Date.now()) {
  const future = (schedJson?.events ?? []).filter((e) => {
    const c = e.competitions?.[0];
    return c?.status?.type?.state === 'pre' && Date.parse(e.date ?? c?.date ?? '') > nowMs;
  });
  if (!future.length) return null;
  future.sort((a, b) => Date.parse(a.date ?? '') - Date.parse(b.date ?? ''));
  return eventLine(future[0].competitions[0], ourAbbr);
}

// ESPN dates read "2026-09-24T23:05Z" (no seconds; checked live 2026-09-25)
// -> epoch seconds, or null when absent or unparseable.
const epochS = (iso) => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

// A 'pre' game dated in the past is either running late (a rain delay, or the
// second game of a doubleheader waiting on the first) or postponed, and ESPN
// keeps both 'pre'. Up to this long past its date it is treated as about to
// start; past it, as postponed.
const LATE_START_S = 6 * 3600;

// When the next game could start, for the row's TTL (epoch seconds, or null
// with nothing ahead). Unlike digestNext, which looks for the next fixture to
// PRINT, this keeps a 'pre' game dated up to LATE_START_S ago: game two of a
// doubleheader keeps its nominal time while game one runs long, and missing it
// here would cache the finished game one's row for the idle maximum right up to
// game two's first pitch. An 'in' game counts as starting now, whatever its
// date: the schedule can call game two live while the team endpoint still
// shows game one's final, and that row must not idle through game two.
export function nextStartAt(schedJson, nowMs = Date.now()) {
  let next = null;
  for (const e of schedJson?.events ?? []) {
    const c = e.competitions?.[0];
    const state = c?.status?.type?.state;
    const at = state === 'in' ? Math.floor(nowMs / 1000) : epochS(e.date ?? c?.date);
    if ((state !== 'pre' && state !== 'in') || at === null || at * 1000 <= nowMs - LATE_START_S * 1000) continue;
    if (next === null || at < next) next = at;
  }
  return next;
}

export function pickLogo(logos = []) {
  const dark = logos.find((l) => l.rel?.includes('dark') && !l.rel?.includes('scoreboard'));
  return (dark ?? logos[0])?.href ?? null;
}

// startsAt and nextStartsAt (epoch seconds) are what teamFreshS reads; the
// card ignores them. startsAt is the row's own game, from the team endpoint's
// nextEvent (the same event the scoreboard join matches by id), null with no
// game. nextStartsAt is the schedule's nextStartAt: null when the schedule has
// no game ahead, and left OFF the row when the schedule could not be read, so
// "nothing scheduled" and "could not find out" stay two different answers.
export function mapTeamSummary(teamJson, lastLine, lg, liveComp = null, nextLine = null, nextStartsAt) {
  const team = teamJson?.team;
  if (!team) return null;
  const ev = team.nextEvent?.[0];
  const row = {
    lg,
    abbr: team.abbreviation ?? '',
    name: team.shortDisplayName ?? team.displayName ?? '',
    record: team.record?.items?.[0]?.summary ?? '',
    // Prefer the dark-background variant (light marks) — default logos like
    // the Yankees' navy NY disappear on the dashboard's dark cards.
    logo: pickLogo(team.logos),
    state: 'none',
    line: 'No scheduled games',
    lastLine: lastLine ?? null,
    nextLine: nextLine ?? null,
    startsAt: epochS(ev?.date ?? ev?.competitions?.[0]?.date),
    ...(nextStartsAt !== undefined && { nextStartsAt }),
  };
  const comp = liveComp ?? ev?.competitions?.[0];
  if (comp) {
    row.state = comp.status?.type?.state ?? 'pre';
    row.line = eventLine(comp, team.abbreviation, { withWL: row.state === 'post' });
  }
  return row;
}

// /sports/team TTL by game state. A live score is the one thing on the card
// that moves minute to minute, so a live row, and one whose first pitch is
// close, lives SPORTS_LIVE_S; a row with nothing about to happen lives until
// shortly before the next game could, capped at SPORTS_IDLE_MAX_S, so a board's
// browser answers its own polls from cache for most of the day. The long TTL is
// only ever given to a state known to be idle: anything unrecognized, or an
// idle row whose next game could not be looked up, gets SPORTS_UNSURE_S (the
// flat TTL this route had before).
export const SPORTS_LIVE_S = 60;
export const SPORTS_IDLE_MAX_S = 900;
export const SPORTS_UNSURE_S = 180;
// A game this close to its start is treated as live.
const SOON_S = 20 * 60;
// An idle row expires this long before the next start, so the refetch that
// sees the game coming lands inside the SOON_S window, not after first pitch.
const LEAD_S = 10 * 60;

// Seconds a row may live, given when the next game starts: undefined is "could
// not find out", null is "nothing scheduled". A game starting within SOON_S, or
// started under LATE_START_S ago (a rain delay, a late start, a doubleheader's
// game two while game one's final is still the row), is treated as live.
function idleFreshS(nextAt, nowS) {
  if (nextAt === undefined) return SPORTS_UNSURE_S;
  if (nextAt === null) return SPORTS_IDLE_MAX_S;
  if (nextAt - nowS <= SOON_S && nowS - nextAt < LATE_START_S) return SPORTS_LIVE_S;
  return Math.max(SPORTS_LIVE_S, Math.min(SPORTS_IDLE_MAX_S, nextAt - LEAD_S - nowS));
}

// cached()'s ttlS for /sports/team: (digest) => seconds, on the { row } digest.
//   in                                   -> SPORTS_LIVE_S
//   pre, starting within SOON_S, or
//     started under LATE_START_S ago     -> SPORTS_LIVE_S (rain delay, late start)
//   pre, dated LATE_START_S+ ago         -> postponed: as post, on the NEXT game
//   pre, further out                     -> idle until this game
//   post, none                           -> idle until the next game (a
//                                           doubleheader's second, say), or
//                                           SPORTS_LIVE_S once it is within
//                                           SOON_S or under way
//   no row, unknown state or start       -> SPORTS_UNSURE_S
export function teamFreshS(digest, nowMs = Date.now()) {
  const row = digest?.row;
  const nowS = nowMs / 1000;
  switch (row?.state) {
    case 'in':
      return SPORTS_LIVE_S;
    case 'pre': {
      const at = row.startsAt;
      if (!Number.isFinite(at)) return SPORTS_UNSURE_S;
      return idleFreshS(nowS - at >= LATE_START_S ? row.nextStartsAt : at, nowS);
    }
    case 'post':
    case 'none':
      return idleFreshS(row.nextStartsAt, nowS);
    default:
      return SPORTS_UNSURE_S;
  }
}

// The schedule payload runs ~2 MB and its lines change a few times a day,
// but a /sports/team summary can be as short-lived as a minute (for live
// scores). Cache the digested last-game + next-game lines, and when the next
// game could start, on their own 30-min Cache-API entry so the heavy schedule
// isn't re-downloaded on every summary miss per team.
// (Key is sched3: sched2 entries carried no nextAt, which teamFreshS would
// read as "could not find out" for up to half an hour after a deploy.)
//
// The key needs only lg and id, so this runs alongside the team fetch rather
// than after it; teamP is that fetch, awaited only to digest a fresh download.
// Never rejects: every failure here degrades to null lines.
async function cachedSchedLines(origin, lg, id, base, teamP) {
  const cache = caches.default;
  const key = origin && new Request(`${origin}/__cache/sched3/${lg}:${id}`);
  if (key) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const j = await hit.json();
        // nextAt is absent from a failure's entry (see below): unknown, not null.
        return { lastLine: j.lastLine ?? null, nextLine: j.nextLine ?? null, nextAt: j.nextAt, fromCache: true };
      }
    } catch {
      // An unreadable entry is a miss.
    }
  }
  let lastLine = null;
  let nextLine = null;
  let nextAt;
  let ok = false;
  try {
    const schedRes = await fetch(`${base}/schedule`, {
      headers: { 'User-Agent': ESPN_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (schedRes.ok) {
      const sched = await schedRes.json();
      // Digest against the team endpoint's abbreviation, as always. When that
      // fetch failed, the schedule names its own team (checked live 2026-09-24),
      // so the download just paid for still gets cached instead of repeated on
      // every retry while the team endpoint is down.
      const teamJson = await teamP.catch(() => null);
      const abbr = teamJson?.team?.abbreviation || sched?.team?.abbreviation || '';
      lastLine = digestSchedule(sched, abbr);
      nextLine = digestNext(sched, abbr);
      nextAt = nextStartAt(sched);
      ok = true;
    }
  } catch {
    lastLine = null;
    nextLine = null;
    nextAt = undefined;
  }
  // A failure is cached too, so an outage is retried at most once a minute per
  // team, but only for that minute: cached for the full half hour like a real
  // result, one ESPN blip hid a team's last and next game for 30 minutes.
  // JSON drops the undefined nextAt, so a failure's entry reads back unknown.
  if (key) {
    try {
      await cache.put(key, new Response(JSON.stringify({ lastLine, nextLine, nextAt }), { headers: { 'Cache-Control': `max-age=${ok ? 1800 : 60}` } }));
    } catch {
      // best-effort
    }
  }
  return { lastLine, nextLine, nextAt, fromCache: false };
}

// The competition fields eventLine and mapTeamSummary read, and nothing else:
// the status and each side's home/away, abbreviation and score, keyed by event
// id so every followed team in the league joins the same digest. A 'pre' game
// is left out on purpose. The join only runs for a team the team endpoint
// already calls live, and a digest cached just before first pitch would flip
// that row back to pre-game until it expired; a missing event degrades to
// the scoreless live line instead, which at least has the state right.
export function digestScoreboard(sbJson) {
  const games = {};
  for (const e of sbJson?.events ?? []) {
    const comp = e.competitions?.[0];
    const state = comp?.status?.type?.state;
    if (!e.id || !comp || state === 'pre') continue;
    games[e.id] = {
      status: { type: { state, shortDetail: comp.status?.type?.shortDetail } },
      competitors: (comp.competitors ?? []).map((c) => ({
        homeAway: c.homeAway,
        team: { abbreviation: c.team?.abbreviation },
        score: score(c),
      })),
    };
  }
  return games;
}

// The team endpoint nulls competitor scores while a game is live; only the
// league scoreboard carries them (verified 2026-07-03). That scoreboard is the
// same ~300 KB whichever team asks, so it is digested (above) onto one
// SCOREBOARD_TTL_S Cache-API entry per league rather than downloaded again for
// every followed team that is playing. Worker-side only: the scoreboard never
// reaches a board, and it is fetched solely while a followed team is actually
// playing. A failed fetch is not cached; the next live team simply tries again,
// as each always did.
//
// useCache is the subrequest budget (see the top of this file). The cached path
// costs up to 3 (match, fetch, put) against the bare fetch's 1, so it runs only
// when this invocation did not also pay for a schedule download (match, fetch,
// put: another 3). That miss comes once per team per half hour; on that one
// call the scoreboard is fetched directly and the digest is neither read nor
// written.
//
// SCOREBOARD_TTL_S stacks under the live row's SPORTS_LIVE_S: a score can be
// that old when a row is assembled from it, so the pair bounds a live score at
// ~90s old at the worker.
const SCOREBOARD_TTL_S = 30;

async function cachedLiveComp(origin, lg, eventId, useCache) {
  const cache = caches.default;
  const key = useCache && origin && new Request(`${origin}/__cache/sb/${lg}`);
  if (key) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const games = await hit.json();
        return Object.hasOwn(games, eventId) ? games[eventId] : null;
      }
    } catch {
      // An unreadable entry is a miss.
    }
  }
  let games = null;
  try {
    const sbRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${LEAGUE_PATHS[lg]}/scoreboard`, {
      headers: { 'User-Agent': ESPN_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (sbRes.ok) games = digestScoreboard(await sbRes.json());
  } catch {
    games = null;
  }
  if (!games) return null; // scoreless live line still renders cleanly
  if (key) {
    try {
      await cache.put(key, new Response(JSON.stringify(games), { headers: { 'Cache-Control': `max-age=${SCOREBOARD_TTL_S}` } }));
    } catch {
      // best-effort
    }
  }
  return Object.hasOwn(games, eventId) ? games[eventId] : null;
}

export async function fetchTeamSummary(lg, id, origin) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE_PATHS[lg]}/teams/${id}`;
  const teamP = fetch(base, {
    headers: { 'User-Agent': ESPN_UA },
    signal: AbortSignal.timeout(10000),
  }).then((teamRes) => {
    if (!teamRes.ok) throw new Error(`espn team ${teamRes.status}`);
    return teamRes.json();
  });
  // The team fetch and the schedule lines are independent, so they overlap.
  // allSettled, not all: a failed team fetch still waits for the schedule work
  // already under way, so a download that was paid for gets cached rather than
  // cut off when the response goes out. The team failure is then rethrown as
  // ever, so cached() serves stale.
  const [team, sched] = await Promise.allSettled([teamP, cachedSchedLines(origin, lg, id, base, teamP)]);
  if (team.status === 'rejected') throw team.reason;
  const teamJson = team.value;
  const { lastLine, nextLine, nextAt, fromCache } = sched.value;
  // Join the live game's scores by event id (see cachedLiveComp).
  let liveComp = null;
  const nextEv = teamJson?.team?.nextEvent?.[0];
  if (nextEv?.competitions?.[0]?.status?.type?.state === 'in') {
    liveComp = await cachedLiveComp(origin, lg, nextEv.id, fromCache);
  }
  return { row: mapTeamSummary(teamJson, lastLine || null, lg, liveComp, nextLine || null, nextAt) };
}
