// Golf + Tennis digests for the config-less cards. The raw ESPN scoreboards
// run 0.6-2.4 MB — far too heavy for gen1 boards at a 5-min cadence — so they
// are digested here (~2 KB) through the shared mappers and cached 5 min at
// the route, with cached()'s 24h stale fallback on upstream failure.

import { mapGolf, mapTennis } from '../../site/js/espn-scores.js';
import { ESPN_UA } from './espn.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';

// scoreboard() is the ONLY thing in this file that reaches ESPN — golf and both
// tennis tours all come through here — so the shared ESPN_UA belongs on this one
// fetch. This used to send a full browser UA; ESPN's edge started 403ing that on
// 2026-08-05 and took golf and tennis down with it. See worker/src/espn.js.
async function scoreboard(path) {
  const res = await fetch(`${ESPN}/${path}/scoreboard`, {
    headers: { 'User-Agent': ESPN_UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`espn ${path} ${res.status}`);
  return res.json();
}

export async function fetchGolf() {
  return mapGolf(await scoreboard('golf/pga'));
}

export async function fetchTennis() {
  // One tour failing is a partial (the other still renders); both failing
  // throws so cached() serves its stale copy instead of an empty card.
  const [atp, wta] = await Promise.allSettled([scoreboard('tennis/atp'), scoreboard('tennis/wta')]);
  if (atp.status === 'rejected' && wta.status === 'rejected') throw new Error('tennis: both tours failed');
  // Mark the one-tour-down case partial so cached() gives it the short TTL and,
  // crucially, never lets the tour-only digest overwrite the complete 24h backup
  // (same flag f1.js sets). Without it the comment above was aspirational: a WTA
  // outage cached ATP-only data at full TTL and erased the last good backup.
  const partial = atp.status === 'rejected' || wta.status === 'rejected';
  return {
    ...mapTennis(
      atp.status === 'fulfilled' ? atp.value : null,
      wta.status === 'fulfilled' ? wta.value : null,
    ),
    ...(partial && { partial: true }),
  };
}
