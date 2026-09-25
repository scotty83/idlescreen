// Amtrak departures from Moynihan / New York Penn (NYP) via the keyless
// (unofficial) Amtraker v3 all-trains feed. We fetch every active train once,
// keep those departing NYP in the future, and return a slim digest; each
// departure carries its downstream stops so the widget can filter by
// destination client-side. Amtraker isn't built for direct browser calls and
// returns a large payload -> worker-proxied + fleet-cached (Cache API, 90s).
const V3_TRAINS = 'https://api.amtraker.com/v3/trains';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const NYP = 'NYP';

const sec = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Pure: Amtraker /v3/trains payload -> NYP departure digest. `nowMs` injected
// for deterministic tests. Tolerant of a missing/empty feed (returns []).
export function mapAmtrak(trainsJson, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  const departures = [];
  const alertSet = new Set();
  const trains = trainsJson && typeof trainsJson === 'object' ? Object.values(trainsJson) : [];
  for (const entry of trains) {
    const t = Array.isArray(entry) ? entry[0] : entry;
    const stops = Array.isArray(t?.stations) ? t.stations : [];
    const idx = stops.findIndex((s) => s?.code === NYP);
    if (idx === -1 || idx >= stops.length - 1) continue; // not served, or terminates at NYP
    const nyp = stops[idx];
    if (nyp.status === 'Departed') continue;
    const dep = sec(nyp.dep ?? nyp.schDep);
    if (dep === null || dep < nowSec) continue;
    const downstream = stops.slice(idx + 1)
      .map((s) => [s?.code, sec(s?.arr ?? s?.schArr)])
      .filter(([c, a]) => typeof c === 'string' && Number.isFinite(a));
    departures.push({
      t: dep,
      sch: sec(nyp.schDep),
      dest: clean(t.destName) || t.destCode || '',
      destCode: t.destCode || '',
      route: clean(t.routeName),
      num: String(t.trainNum ?? ''),
      status: clean(nyp.depCmnt),
      platform: nyp.platform ? String(nyp.platform) : null,
      stops: downstream,
    });
    for (const a of (Array.isArray(t.alerts) ? t.alerts : [])) {
      const h = clean(a?.message).slice(0, 160);
      if (h) alertSet.add(h);
    }
  }
  departures.sort((a, b) => a.t - b.t);
  return {
    station: NYP,
    departures: departures.slice(0, 25),
    alerts: [...alertSet].slice(0, 3).map((header) => ({ header })),
  };
}

export async function fetchAmtrak() {
  const res = await fetch(V3_TRAINS, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`amtrak upstream ${res.status}`);
  return mapAmtrak(await res.json(), Date.now());
}
