// NYC Ferry departure board for one landing, from the Worker's GTFS-RT
// digest joined against bundled static data (data/ferry.json). The realtime
// feed has no route ids, so trip identity comes from the static trips map;
// when that map is stale (schedule change), destination falls back to the
// trip's final stop name and the route chip is omitted — labels degrade,
// correctness doesn't.

import { escapeHtml, fmtMin, fmtTime } from '../util.js';
import { setCardNote } from '../card.js';
import { WORKER_URL } from '../env.js';
import { fitList } from '../capacity.js';
import { wireTrainExpand } from '../train-expand.js';

export const meta = { id: 'ferry', title: 'NYC Ferry', refreshMs: 60 * 1000 };

export function mapFerry(digest, data, landing, nowSec) {
  const stopName = (id) => data?.stops?.find((s) => s.id === id)?.name ?? '';
  const departures = [];
  for (const trip of digest?.trips ?? []) {
    const idx = trip.stops.findIndex((s) => s.stopId === landing);
    if (idx === -1) continue;
    const t = trip.stops[idx].t;
    if (!t || t <= nowSec) continue;
    const onward = trip.stops.slice(idx + 1);
    if (!onward.length) continue; // terminating here: an arrival, not a departure
    const known = data?.trips?.[trip.tripId];
    const route = known ? data?.routes?.[known[0]] : null;
    departures.push({
      min: Math.max(1, Math.round((t - nowSec) / 60)),
      t,
      dest: known?.[1] || stopName(onward[onward.length - 1].stopId) || 'Ferry',
      route: route ? { name: route.name, color: route.color } : null,
    });
  }
  departures.sort((a, b) => a.t - b.t);
  return { landing, landingName: stopName(landing), departures: departures.slice(0, 12) };
}

export function render(el, vm, _cfg) {
  setCardNote(el, vm.landingName || null);
  const row = (d) => {
    const chip = d.route && /^[0-9A-Fa-f]{6}$/.test(d.route.color)
      ? `<i class="ferryroute" style="background:#${d.route.color}"></i>`
      : '';
    return `<div class="train">
            <div class="train__min"><span>${fmtMin(d.min)}</span><small>min</small></div>
            <div class="train__info">
              <span class="train__dest">${chip}${escapeHtml(d.dest)}</span>
              <span class="train__line">${d.route ? `${escapeHtml(d.route.name)} · ` : ''}<span class="train__nb">${fmtTime(d.t)}</span></span>
            </div>
          </div>`;
  };
  const rows = (vm.departures ?? []).map(row);
  // No alert banners here, but the same contract as the rail boards: the
  // estimate slices, and fitTrainRows sheds what the browser cannot hold.
  fitList(el, {
    id: meta.id,
    items: rows,
    fallback: 4,
    draw: (n) => {
      el.innerHTML = '<div class="trains">' + (rows.length
        ? rows.slice(0, n).join('')
        : '<div class="empty">No departures</div>') + '</div>';
    },
  });
  wireTrainExpand(el, { title: meta.title, note: vm.landingName || '', rows });
}

let dataCache = null;
async function ferryData(net) {
  if (!dataCache) {
    try {
      dataCache = await net.fetchJSON('data/ferry.json');
    } catch {
      dataCache = null;
    }
  }
  return dataCache;
}

export async function fetchData(cfg, net) {
  const [digest, data] = await Promise.all([
    net.fetchJSON(`${WORKER_URL}/ferry/departures`),
    ferryData(net),
  ]);
  const vm = mapFerry(digest, data, cfg.ferry.landing, Math.floor(Date.now() / 1000));
  vm.stale = Boolean(digest.stale);
  vm.updatedAt = digest.updatedAt;
  return vm;
}
