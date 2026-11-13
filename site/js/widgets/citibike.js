// Live Citi Bike availability at the user's chosen stations. Station names come
// from cfg (bundled dataset at pick time); this joins them with the worker's
// live counts and shows bikes (e-bikes called out) + open docks.

import { WORKER_URL } from '../env.js';
import { escapeHtml, setupPrompt } from '../util.js';
import { fitList } from '../capacity.js';
import { setExpandSource } from '../expand.js';

export const meta = { id: 'citibike', title: 'Citi Bike', refreshMs: 60 * 1000 };

// ---------- tap-to-expand: every configured station, one well each ----------

// Sean's pick 2026-08-01: the card's .cb__n emphasis taken to reading scale.
// BIKES is the operative number — the one fact that decides whether you walk
// over — so it leads each well at 60px with a small unit beneath it, and the
// docks/e-bikes line stays secondary. Two columns by three rows holds the
// configured maximum (config.js caps the station picker at six), so this grid
// has no scrolling case in practice.
//
// e-bikes appear only when there are some, exactly as the card's "(N⚡)" does:
// a row of "0 e-bikes" is noise on a wall, and the accent is meant to mark a
// thing that is there.
export function bikeWells(chosen, byId) {
  const well = (st) => {
    const live = byId.get(st.id);
    const off = !live || !live.ok;
    const count = off
      ? '<span class="cbwell__offword">not renting</span>'
      : `<b class="cbwell__n">${escapeHtml(live.bikes)}</b><span class="cbwell__unit">bikes</span>`;
    const sub = off
      ? ''
      : `<div class="cbwell__sub">${escapeHtml(live.docks)} docks${
        live.ebikes > 0 ? ` · <b class="cbwell__e">${escapeHtml(live.ebikes)} e-bikes</b>` : ''
      }</div>`;
    return `<div class="cbwell${off ? ' cbwell--off' : ''}">
        <div class="cbwell__count">${count}</div>
        <div class="cbwell__body">
          <div class="cbwell__name">${escapeHtml(st.name)}</div>${sub}
        </div>
      </div>`;
  };
  return `<div class="cbboard"><div class="cbboard__grid">${chosen.map(well).join('')}</div></div>`;
}

export function render(el, vm, cfg) {
  const chosen = cfg.citibike?.stations ?? [];
  if (!chosen.length) {
    el.innerHTML = setupPrompt('citibike', 'add stations', 'Citi Bike');
    setExpandSource(el, null); // an unconfigured card taps into Settings
    return;
  }
  const byId = new Map((vm.stations ?? []).map((s) => [s.id, s]));
  fitList(el, {
    id: meta.id,
    items: chosen,
    defaultSize: [3, 4],
    fallback: 4,
    badge: true,
    draw: (n) => {
      el.style.setProperty('--n', String(n)); // elastic row-gap divisor
      el.innerHTML = chosen
        .slice(0, n)
        .map((st) => {
          const live = byId.get(st.id);
          const stat = !live || !live.ok
            ? '<span class="cb__stat cb__stat--off">not renting</span>'
            : `<span class="cb__stat"><b class="cb__n">${live.bikes}</b> bikes${live.ebikes > 0 ? ` (<b class="cb__e">${live.ebikes}⚡</b>)` : ''} · ${live.docks} docks</span>`;
          return `<div class="cb"><span class="cb__name">${escapeHtml(st.name)}</span>${stat}</div>`;
        })
        .join('');
    },
  });
  // The rows here are not tappable, so the whole card is the target, and it
  // opens the wells whatever the card had room for (Sean, 2026-11-13): every
  // card opens when tapped. The badge fitList pinned counts hidden stations
  // and nothing else.
  setExpandSource(el, () => ({
    title: meta.title,
    note: `${chosen.length} ${chosen.length === 1 ? 'station' : 'stations'}`,
    bodyHtml: bikeWells(chosen, byId),
  }));
}

export async function fetchData(cfg, net) {
  const ids = (cfg.citibike?.stations ?? []).map((s) => s.id);
  if (!ids.length) return { updatedAt: 0, stale: false, stations: [] };
  return net.fetchJSON(`${WORKER_URL}/citibike/status?ids=${ids.join(',')}`);
}
