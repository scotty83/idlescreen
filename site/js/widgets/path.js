// PATH departure board from the Worker's RidePATH digest. PATH has no line
// letters — line identity is the official line color, shown as 1-2 dots
// (two colors = a train serving a joint line, e.g. HOB-33 via JSQ). The
// direction filter 'both' renders two labeled sections.

import { escapeHtml, fmtMin, fmtTime } from '../util.js';
import { setCardNote } from '../card.js';
import { WORKER_URL } from '../env.js';
import { fitList, cardSize, sizeTier } from '../capacity.js';

export const meta = { id: 'path', title: 'PATH', refreshMs: 60 * 1000 };

// ridepath.json consideredStation codes, NY -> NJ order for the settings list.
export const PATH_STATIONS = {
  '33S': '33rd Street',
  '23S': '23rd Street',
  '14S': '14th Street',
  '09S': '9th Street',
  CHR: 'Christopher St',
  WTC: 'World Trade Center',
  HOB: 'Hoboken',
  NEW: 'Newport',
  EXP: 'Exchange Place',
  GRV: 'Grove St',
  JSQ: 'Journal Square',
  HAR: 'Harrison',
  NWK: 'Newark',
};

export const PATH_DIRS = [
  ['ToNJ', 'To New Jersey'],
  ['ToNY', 'To New York'],
  ['both', 'Both directions'],
];

const DIR_LABELS = { ToNY: 'To New York', ToNJ: 'To New Jersey' };

export function mapPath(digest, cfgPath, nowSec) {
  const st = digest?.stations?.[cfgPath.station] ?? {};
  const dirs = cfgPath.dir === 'both' ? ['ToNY', 'ToNJ'] : [cfgPath.dir];
  const sections = dirs.map((dir) => ({
    dir,
    label: DIR_LABELS[dir],
    rows: (st[dir] ?? [])
      .filter((m) => m.t > nowSec)
      .map((m) => ({
        min: Math.max(1, Math.round((m.t - nowSec) / 60)),
        t: m.t,
        dest: m.headSign,
        colors: (m.lineColors ?? []).filter((c) => /^[0-9A-Fa-f]{6}$/.test(c)),
      }))
      .slice(0, 12),
  }));
  return { station: cfgPath.station, sections };
}

export function render(el, vm, _cfg) {
  setCardNote(el, PATH_STATIONS[vm.station] ?? null);
  // Height alone, and only for the tier branch below: the row counts come from
  // the fits.
  const [, h] = cardSize(el, [4, 4]);
  const sections = vm.sections ?? [];
  const both = sections.length > 1;
  const shallow = sizeTier(h) === 's';
  const row = (r, dirShort) => `<div class="train train--path">
      <div class="train__min"><span>${fmtMin(r.min)}</span><small>min</small></div>
      <div class="train__info">
        <span class="train__dest">${r.colors
          .map((c) => `<i class="pathdot" style="background:#${c}"></i>`)
          .join('')}${escapeHtml(r.dest)}</span>
        <span class="train__line">${dirShort ? `${dirShort} · ` : ''}<span class="train__nb">${fmtTime(r.t)}</span></span>
      </div>
    </div>`;
  // Shallow cards can't afford section headers: flatten both directions into
  // one time-sorted list with the direction inline on each row instead.
  if (both && shallow) {
    fitList(el, {
      id: meta.id,
      min: 1,
      fallback: 2,
      draw: (n) => {
        const flat = sections
          .flatMap((s) => s.rows.map((r) => ({ ...r, dirShort: s.dir === 'ToNY' ? 'To NY' : 'To NJ' })))
          .sort((a, b) => a.t - b.t)
          .slice(0, n);
        el.innerHTML = flat.length
          ? flat.map((r) => row(r, r.dirShort)).join('')
          : '<div class="empty">No trains</div>';
      },
    });
    return;
  }
  // Drop an empty direction entirely — terminal stations (e.g. the default
  // 33S) run one way only, so a fixed 50/50 split would waste half the card on
  // a permanent "To New York — No trains". Budget is allocated by availability.
  const live = sections.filter((s) => s.rows.length);
  if (!live.length) {
    el.innerHTML = '<div class="empty">No trains</div>';
    return;
  }
  const showBoth = live.length > 1;
  // A two-section board spends one row on its direction labels, and never
  // drops below one row per section. The count is a budget shared by the two
  // sections rather than a slice of one list, so nothing is handed over to
  // count against and there is no corner badge to stamp.
  fitList(el, {
    id: meta.id,
    min: showBoth ? 2 : 1,
    fallback: 4,
    reserve: showBoth ? 1 : 0,
    draw: (cap) => {
      // Fair share to each section, then hand any unused budget to the other.
      let per0 = showBoth ? Math.min(live[0].rows.length, Math.ceil(cap / 2)) : cap;
      const per1 = showBoth ? Math.min(live[1].rows.length, cap - per0) : 0;
      if (showBoth) per0 = Math.min(live[0].rows.length, cap - per1);
      const counts = showBoth ? [per0, per1] : [cap];
      el.innerHTML = live
        .map((s, i) => `<div class="path-section">
      ${showBoth ? `<div class="path-section__label">${escapeHtml(s.label)}</div>` : ''}
      ${s.rows.slice(0, counts[i]).map((r) => row(r)).join('')}
    </div>`)
        .join('');
    },
  });
}

export async function fetchData(cfg, net) {
  const digest = await net.fetchJSON(`${WORKER_URL}/path/realtime`);
  const vm = mapPath(digest, cfg.path, Math.floor(Date.now() / 1000));
  vm.stale = Boolean(digest.stale);
  vm.updatedAt = digest.updatedAt;
  return vm;
}
