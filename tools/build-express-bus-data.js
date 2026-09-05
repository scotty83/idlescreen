// Builds site/data/express-bus.json from MTA GTFS (express routes: QM/BM/SIM/X).
// Run: node tools/build-express-bus-data.js
// Re-run when MTA changes express routes/stops (rare). A stale file only means an
// occasional missing stop (its arrivals return empty). Mirrors build-ferry-data.js.
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GTFS feed + the SIRI LineRef agency prefix for its routes. VERIFY each URL
// returns a GTFS zip at build time; the MTA dev portal has been migrating to
// mta.info — if a URL 404s, find the current one and update it here + note it.
export const FEEDS = [
  { url: 'http://web.mta.info/developers/data/busco/google_transit.zip', prefix: 'MTABC_' },
  { url: 'http://web.mta.info/developers/data/nyct/bus/google_transit_manhattan.zip', prefix: 'MTA NYCT_' },
  { url: 'http://web.mta.info/developers/data/nyct/bus/google_transit_staten_island.zip', prefix: 'MTA NYCT_' },
  { url: 'http://web.mta.info/developers/data/nyct/bus/google_transit_bronx.zip', prefix: 'MTA NYCT_' },
  { url: 'http://web.mta.info/developers/data/nyct/bus/google_transit_brooklyn.zip', prefix: 'MTA NYCT_' },
  { url: 'http://web.mta.info/developers/data/nyct/bus/google_transit_queens.zip', prefix: 'MTA NYCT_' },
];

export const isExpressRoute = (shortName) => /^(QM|BM|SIM|X)\d+[A-Z]?$/.test(shortName || '');

// GTFS cells here are unquoted and free of embedded commas (verified across MTA
// bus feeds — stop names use '/', not ','). If a future feed adds quoted commas,
// this parser must be upgraded.
function table(zipPath, name) {
  const txt = execFileSync('unzip', ['-p', zipPath, name], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const unquote = (c) => c.replace(/^"|"$/g, '');
  const [header, ...lines] = txt.trim().split(/\r?\n/);
  const cols = header.split(',').map(unquote);
  return lines.map((line) => Object.fromEntries(cols.map((c, i) => [c, unquote(line.split(',')[i] ?? '')])));
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GTFS ${res.status} for ${url} — verify the URL (MTA portal moved?)`);
  const p = join(tmpdir(), `mta-${Buffer.from(url).toString('hex').slice(0, 12)}.zip`);
  await writeFile(p, Buffer.from(await res.arrayBuffer()));
  return p;
}

const routes = {};          // id -> { id, lineRef, dirStops: {0:Map,1:Map} }
const stops = {};           // stopId -> name

for (const feed of FEEDS) {
  const zip = await download(feed.url);
  const routeRows = table(zip, 'routes.txt').filter((r) => isExpressRoute(r.route_short_name));
  if (!routeRows.length) continue;
  const routeById = Object.fromEntries(routeRows.map((r) => [r.route_id, r.route_short_name]));
  for (const r of routeRows) {
    routes[r.route_short_name] ??= { id: r.route_short_name, lineRef: feed.prefix + r.route_short_name, dirStops: { 0: new Map(), 1: new Map() } };
  }
  const trips = table(zip, 'trips.txt').filter((t) => routeById[t.route_id]);
  const tripInfo = Object.fromEntries(trips.map((t) => [t.trip_id, { route: routeById[t.route_id], dir: Number(t.direction_id) || 0, headsign: t.trip_headsign }]));
  const headsign = {};      // `${route}|${dir}` -> first headsign seen
  for (const t of trips) headsign[`${tripInfo[t.trip_id].route}|${tripInfo[t.trip_id].dir}`] ??= t.trip_headsign;
  const stopNames = Object.fromEntries(table(zip, 'stops.txt').map((s) => [s.stop_id, s.stop_name]));
  for (const st of table(zip, 'stop_times.txt')) {
    const info = tripInfo[st.trip_id];
    if (!info) continue;
    const r = routes[info.route];
    r.headsigns ??= {};
    r.headsigns[info.dir] ??= headsign[`${info.route}|${info.dir}`] || '';
    if (!r.dirStops[info.dir].has(st.stop_id)) r.dirStops[info.dir].set(st.stop_id, Number(st.stop_sequence));
    if (stopNames[st.stop_id]) stops[st.stop_id] = stopNames[st.stop_id];
  }
}

const out = {
  routes: Object.values(routes).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).map((r) => ({
    id: r.id,
    lineRef: r.lineRef,
    dirs: [0, 1]
      .filter((d) => r.dirStops[d].size)
      .map((d) => ({
        id: d,
        headsign: (r.headsigns?.[d] || '').trim(),
        stops: [...r.dirStops[d].entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id),
      })),
  })),
  stops,
};

if (out.routes.length < 55 || out.routes.length > 95) {
  throw new Error(`express route count ${out.routes.length} outside 55-95 — verify FEEDS + isExpressRoute`);
}
await writeFile(new URL('../site/data/express-bus.json', import.meta.url), JSON.stringify(out));
console.log(`express-bus: ${out.routes.length} routes, ${Object.keys(out.stops).length} stops`);
console.log('routes:', out.routes.map((r) => r.id).join(', '));
