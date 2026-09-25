// "My Teams" composite: ESPN's team endpoint (record, logo, live/next event)
// plus the last completed game from the schedule endpoint. The schedule runs
// ~2 MB — far too heavy for gen1 boards — so it's digested here and cached
// long (results change at most a few times a day).
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

export function pickLogo(logos = []) {
  const dark = logos.find((l) => l.rel?.includes('dark') && !l.rel?.includes('scoreboard'));
  return (dark ?? logos[0])?.href ?? null;
}

export function mapTeamSummary(teamJson, lastLine, lg, liveComp = null, nextLine = null) {
  const team = teamJson?.team;
  if (!team) return null;
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
  };
  const comp = liveComp ?? team.nextEvent?.[0]?.competitions?.[0];
  if (comp) {
    row.state = comp.status?.type?.state ?? 'pre';
    row.line = eventLine(comp, team.abbreviation, { withWL: row.state === 'post' });
  }
  return row;
}

// The schedule payload runs ~2 MB and its lines change a few times a day,
// but the /sports/team summary is only 120s-cached (for live scores). Cache
// the digested last-game + next-game lines on their own 30-min Cache-API
// entry so the heavy schedule isn't re-downloaded every 120s per team.
// (Key is sched2 — the old sched entries carried lastLine only.)
async function cachedSchedLines(origin, lg, id, abbr, base) {
  const cache = caches.default;
  const key = origin && new Request(`${origin}/__cache/sched2/${lg}:${id}`);
  if (key) {
    const hit = await cache.match(key);
    if (hit) {
      const j = await hit.json();
      return { lastLine: j.lastLine ?? null, nextLine: j.nextLine ?? null, fromCache: true };
    }
  }
  let lastLine = null;
  let nextLine = null;
  try {
    const schedRes = await fetch(`${base}/schedule`, {
      headers: { 'User-Agent': ESPN_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (schedRes.ok) {
      const sched = await schedRes.json();
      lastLine = digestSchedule(sched, abbr);
      nextLine = digestNext(sched, abbr);
    }
  } catch {
    lastLine = null;
    nextLine = null;
  }
  if (key) {
    try {
      await cache.put(key, new Response(JSON.stringify({ lastLine, nextLine }), { headers: { 'Cache-Control': 'max-age=1800' } }));
    } catch {
      // best-effort
    }
  }
  return { lastLine, nextLine, fromCache: false };
}

// The competition fields eventLine and mapTeamSummary read, and nothing else:
// the status and each side's home/away, abbreviation and score, keyed by event
// id so every followed team in the league joins the same digest. A 'pre' game
// is left out on purpose. The join only runs for a team the team endpoint
// already calls live, and a digest cached just before first pitch would flip
// that row back to pre-game for up to a minute; a missing event degrades to
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
// same ~300 KB whichever team asks, so it is digested (above) onto one 60s
// Cache-API entry per league rather than downloaded again for every followed
// team that is playing. Worker-side only: the scoreboard never reaches a board,
// and it is fetched solely while a followed team is actually playing. A failed
// fetch is not cached; the next live team simply tries again, as each always did.
//
// useCache is the subrequest budget (see the top of this file). The cached path
// costs up to 3 (match, fetch, put) against the bare fetch's 1, so it runs only
// when this invocation did not also pay for a schedule download (match, fetch,
// put: another 3). That miss comes once per team per half hour; on that one
// call the scoreboard is fetched directly and the digest is neither read nor
// written.
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
      await cache.put(key, new Response(JSON.stringify(games), { headers: { 'Cache-Control': 'max-age=60' } }));
    } catch {
      // best-effort
    }
  }
  return Object.hasOwn(games, eventId) ? games[eventId] : null;
}

export async function fetchTeamSummary(lg, id, origin) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE_PATHS[lg]}/teams/${id}`;
  const teamRes = await fetch(base, {
    headers: { 'User-Agent': ESPN_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!teamRes.ok) throw new Error(`espn team ${teamRes.status}`);
  const teamJson = await teamRes.json();
  const abbr = teamJson?.team?.abbreviation ?? '';

  const { lastLine, nextLine, fromCache } = await cachedSchedLines(origin, lg, id, abbr, base);
  // Join the live game's scores by event id (see cachedLiveComp).
  let liveComp = null;
  const nextEv = teamJson?.team?.nextEvent?.[0];
  if (nextEv?.competitions?.[0]?.status?.type?.state === 'in') {
    liveComp = await cachedLiveComp(origin, lg, nextEv.id, fromCache);
  }
  return { row: mapTeamSummary(teamJson, lastLine || null, lg, liveComp, nextLine || null) };
}
