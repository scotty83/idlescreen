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
import { metaLine } from '../lines.js';

export const meta = { id: 'amtrak', title: 'Amtrak', refreshMs: 60 * 1000 };

const statusClass = (s) => (/cancel/i.test(s) ? 'is-bad' : /(late|delay)/i.test(s) ? 'is-warn' : '');
// "On time" is the one status that is not news. Narrow cards drop it (main.css
// .card--amtrak.t-narrow .train__ontime), so a 3-wide row reads
// "Northeast Regional 171" and only a late or cancelled train spends the room.
export const isOnTime = (s) => /^\s*on[\s-]*time\s*$/i.test(s ?? '');

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
    // Floors at 1 like LIRR and Metro-North: a train still on the board reads
    // "1 min", never "0 min". (NJ Transit keeps its 0: a train past its
    // scheduled minute is still boarding there.)
    const min = Math.max(1, Math.round((d.t - nowSec) / 60));
    const primary = dest ? `Arrives ${fmtTime(d.arr)}` : escapeHtml(d.dest);
    // Same grammar as the other rail boards: the track is the right-column
    // chip, the status is the meta line's last token. Narrow cards shed the
    // clock time and an on-time status (main.css), since the route and number
    // already name the train and the big minutes say when; the tap view and
    // wider cards keep both.
    const line = metaLine([
      { html: `${escapeHtml(d.route)} ${escapeHtml(d.num)}`.trim() },
      { html: fmtTime(d.t), cls: 'train__time' },
      {
        html: d.status ? `<span class="train__state ${statusClass(d.status)}">${escapeHtml(d.status)}</span>` : '',
        cls: isOnTime(d.status) ? 'train__ontime' : '',
      },
    ]);
    return `<div class="train train--rail">
      <div class="train__min"><span>${fmtMin(min)}</span><small>min</small></div>
      <div class="train__info">
        <span class="train__dest">${primary}</span>
        <span class="train__line">${line}</span>
      </div>
      ${d.platform ? `<span class="train__track">Track ${escapeHtml(d.platform)}</span>` : ''}
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
