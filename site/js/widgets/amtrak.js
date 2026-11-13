// Amtrak departures from Moynihan / New York Penn (NYP) via the worker's
// /amtrak/departures digest (keyless Amtraker proxy). LIRR-shaped board: the
// origin is pinned to NYP, and cfg.amtrak.dest optionally filters to trains that
// stop at the chosen station — matched client-side against each departure's
// downstream stops, showing the arrival time there; unfiltered rows show the
// train's terminus.
import { escapeHtml, fmtMin, fmtTime, fmtClock, setupPrompt } from '../util.js';
import { setCardNote } from '../card.js';
import { WORKER_URL } from '../env.js';
import { renderAlertRows } from '../transit-alerts.js';
import { fitList } from '../capacity.js';
import { wireTrainExpand } from '../train-expand.js';

export const meta = { id: 'amtrak', title: 'Amtrak', refreshMs: 60 * 1000 };

const statusClass = (s) => (/cancel/i.test(s) ? 'is-bad' : /(late|delay)/i.test(s) ? 'is-warn' : '');

export function render(el, vm, cfg) {
  // No destination picked yet (fetchData sets the flag): prompt instead of an
  // unfiltered board. Demo fixtures never carry the flag, so ?demo=1 and the
  // renderer tests still show rows.
  if (vm.needsStation) {
    setCardNote(el, null);
    el.classList.remove('has-alerts');
    el.innerHTML = setupPrompt('amtrak', 'pick a destination', 'Amtrak');
    wireTrainExpand(el, { title: meta.title, rows: [] }); // clears any prior pill
    return;
  }
  const dest = cfg?.amtrak?.dest || '';
  const showAlerts = cfg?.amtrak?.alerts !== false;
  const nowSec = Math.floor(Date.now() / 1000);
  let deps = vm.departures ?? [];
  if (dest) {
    deps = deps
      .map((d) => {
        const s = (d.stops ?? []).find((x) => x[0] === dest);
        return s ? { ...d, arr: s[1] } : null;
      })
      .filter(Boolean);
  }
  // "as of" is a clock reading (honors cfg.clock24); the arrival/departure times
  // in the rows below stay on fmtTime (schedule times, always 12h).
  setCardNote(el, dest && vm.destName ? `to ${vm.destName}` : (vm.updatedAt ? `as of ${fmtClock(vm.updatedAt, cfg?.clock24)}` : null));

  const alerts = showAlerts ? (vm.alerts ?? []) : [];
  el.classList.toggle('has-alerts', Boolean(alerts.length));

  const row = (d) => {
    const min = Math.max(0, Math.round((d.t - nowSec) / 60));
    const primary = dest ? `Arrives ${fmtTime(d.arr)}` : escapeHtml(d.dest);
    const line = `${escapeHtml(d.route)} ${escapeHtml(d.num)} · <span class="train__nb">${fmtTime(d.t)}</span>${d.platform ? ` · <span class="train__nb">Track ${escapeHtml(d.platform)}</span>` : ''}`;
    return `<div class="train">
      <div class="train__min"><span>${fmtMin(min)}</span><small>min</small></div>
      <div class="train__info">
        <span class="train__dest">${primary}</span>
        <span class="train__line">${line}</span>
      </div>
      ${d.status ? `<span class="train__status ${statusClass(d.status)}">${escapeHtml(d.status)}</span>` : ''}
    </div>`;
  };

  // Each alert banner costs roughly one train row of space.
  // Banners are not pre-charged a row (see the lirr note): the measured fit
  // sheds what cannot fit, into the pill. The estimate is the whole slice
  // here; wireTrainExpand's fitTrainRows does the measuring.
  fitList(el, {
    id: meta.id,
    items: deps,
    min: 1,
    draw: (n) => {
      const shown = deps.slice(0, n);
      el.innerHTML = renderAlertRows(alerts) + '<div class="trains">' +
        (shown.length ? shown.map(row).join('') : '<div class="empty">No departures</div>') + '</div>';
    },
  });
  const note = dest && vm.destName ? `to ${vm.destName}` : '';
  wireTrainExpand(el, { title: meta.title, note, rows: deps.map(row), alerts });
}

let stationsCache = null;
async function stationNames(net) {
  if (!stationsCache) {
    try {
      stationsCache = await net.fetchJSON('data/stations-amtrak.json');
    } catch {
      return {}; // leave the cache unset so the next refresh retries
    }
  }
  return Object.fromEntries(stationsCache.map((s) => [s.id, s.name]));
}

export async function fetchData(cfg, net) {
  // No destination picked yet: skip the fetch and let the card prompt.
  const dest = cfg?.amtrak?.dest || '';
  if (!dest) return { departures: [], needsStation: true };
  const vm = await net.fetchJSON(`${WORKER_URL}/amtrak/departures`);
  vm.destName = (await stationNames(net))[dest] || null;
  return vm;
}
