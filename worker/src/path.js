// PATH departures from the Port Authority's RidePATH JSON feed. The raw feed
// (~10 KB) is verbose; boards get a slim per-station digest. Times are
// projected epochs (fetch time + secondsToArrival) so boards recompute
// minutes client-side and the route's cache window never skews them.

const FEED = 'https://www.panynj.gov/bin/portauthority/ridepath.json';

export function mapRidePath(json, nowSec) {
  const stations = {};
  for (const st of json?.results ?? []) {
    const code = String(st?.consideredStation ?? '');
    if (!code) continue;
    const dirs = { ToNY: [], ToNJ: [] };
    for (const dest of st.destinations ?? []) {
      const label = dest?.label;
      if (!Object.hasOwn(dirs, label)) continue;
      for (const msg of dest.messages ?? []) {
        const secs = Number(msg?.secondsToArrival);
        if (!Number.isFinite(secs)) continue;
        const lineColors = String(msg?.lineColor ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter((c) => /^[0-9A-Fa-f]{6}$/.test(c))
          .slice(0, 2);
        dirs[label].push({ t: nowSec + secs, headSign: String(msg?.headSign ?? ''), lineColors });
      }
      dirs[label].sort((a, b) => a.t - b.t);
    }
    stations[code] = dirs;
  }
  return { stations };
}

export async function fetchPathRealtime() {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`ridepath ${res.status}`);
  return mapRidePath(await res.json(), Math.floor(Date.now() / 1000));
}
