// NJ Transit rail departures from New York Penn Station via the Cloudflare
// Worker (NJT's terms require their data be served from a non-NJT server; the
// Worker holds credentials and caches upstream responses). Penn-fixed like
// LIRR/Amtrak — the user filters to specific lines client-side (cfg.njt.lines,
// [] = all lines).

import { WORKER_URL } from '../env.js';
import { escapeHtml, fmtMin, fmtTime } from '../util.js';
import { setCardNote } from '../card.js';
import { renderAlertRows } from '../transit-alerts.js';
import { lineChipPrefix } from '../lines.js';
import { fitList } from '../capacity.js';
import { wireTrainExpand } from '../train-expand.js';

export const meta = { id: 'njt', title: 'NJ Transit', refreshMs: 2 * 60 * 1000 };

export function render(el, vm, _cfg) {
  // Station context lives in the corner note like PATH/Ferry/Weather — not
  // baked into the title (card-consistency contract).
  setCardNote(el, 'Penn Station');
  el.classList.toggle('has-alerts', Boolean(vm.alerts?.length));
  const row = (t) => `<div class="train">
            <div class="train__min"><span>${fmtMin(t.min)}</span><small>min</small></div>
            <div class="train__info">
              <span class="train__dest">${escapeHtml(t.dest)}</span>
              <span class="train__line">${lineChipPrefix(t.line)}<span class="train__nb">${fmtTime(t.time)}</span>${t.status ? ` · ${escapeHtml(t.status)}` : ''}</span>
            </div>
            ${t.track ? `<span class="train__track">Track ${escapeHtml(t.track)}</span>` : ''}
          </div>`;
  const rows = vm.trains.map(row);
  // Banners are not pre-charged a row (see the lirr note): the measured fit
  // sheds what cannot fit, into the pill.
  fitList(el, {
    id: meta.id,
    items: rows,
    min: 1,
    draw: (n) => {
      el.innerHTML = renderAlertRows(vm.alerts) + '<div class="trains">' + (rows.length
        ? rows.slice(0, n).join('')
        : '<div class="empty">No departures</div>') + '</div>';
    },
  });
  wireTrainExpand(el, { title: meta.title, note: 'Penn Station', rows, alerts: vm.alerts ?? [] });
}

export function mapNjt(payload, nowSec, showAlerts = true) {
  if (!payload || payload.error || !Array.isArray(payload.trains)) {
    return { updatedAt: null, stale: true, trains: [], alerts: [] };
  }
  const trains = payload.trains
    .filter((t) => {
      if (!Number.isFinite(t.time)) return false;
      if (t.time > nowSec) return true;
      // NJT times are static schedule stamps, not live predictions — a train
      // past its scheduled minute is still boardable if it hasn't departed.
      // Keep it for a 15-min grace window when its status says so.
      const s = (t.status ?? '').toUpperCase();
      return Boolean(s) && !s.includes('DEPART') && !s.includes('CANCEL') && t.time > nowSec - 15 * 60;
    })
    .slice(0, 12)
    .map((t) => ({
      time: t.time,
      min: Math.max(0, Math.round((t.time - nowSec) / 60)),
      dest: String(t.dest ?? ''),
      line: String(t.line ?? ''),
      track: t.track ? String(t.track) : null,
      status: String(t.status ?? ''),
    }));
  const alerts = showAlerts
    ? (payload.alerts ?? []).filter((a) => typeof a?.header === 'string').slice(0, 2)
    : [];
  // No "as of" stamp (updatedAt null): getStationSchedule is NJ Transit's static
  // daily timetable, not live predictions, so a cache-time stamp would frame it
  // as fresh intraday data. Outage staleness still shows via .is-stale dimming.
  return { updatedAt: null, stale: Boolean(payload.stale), trains, alerts };
}

export async function fetchData(cfg, net) {
  const payload = await net.fetchJSON(`${WORKER_URL}/njt/departures`);
  const vm = mapNjt(payload, Math.floor(Date.now() / 1000), cfg.njt.alerts);
  // Client-side line filter (mirrors Amtrak's dest filter): [] = all lines.
  const lines = cfg.njt.lines ?? [];
  if (lines.length) {
    const want = new Set(lines.map((l) => l.toLowerCase().trim()));
    vm.trains = vm.trains.filter((t) => want.has(t.line.toLowerCase().trim()));
  }
  return vm;
}
