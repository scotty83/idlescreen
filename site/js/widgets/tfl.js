// London TfL line status — a Subway-style board for the lines you pick, from
// the worker's /tfl/status digest. Colour dot + name + status; tap the card
// for every line with its full reason.

import { escapeHtml, setupPrompt } from '../util.js';
import { WORKER_URL } from '../env.js';
import { fitList } from '../capacity.js';
import { setExpandSource } from '../expand.js';
import { ledgerBody } from '../ledger.js';
import { TFL_LINES } from '../tfl-lines.js';

export const meta = { id: 'tfl', title: 'TfL Status', refreshMs: 2 * 60 * 1000 };
const LINE_META = new Map(TFL_LINES.map((l) => [l.id, l]));

// Every configured line as a ledger item, disrupted lines first — the same
// priority the card truncates by, applied to the whole list rather than to the
// slice that fits. The line colour rides along as the row's dot, so the wall
// keeps the one signal the card leads with. A line with no reason text still
// leads (its status word is the news); it simply carries no prose.
export const tflItems = (rows) => [...rows]
  .sort((a, b) => Number(a.ok) - Number(b.ok))
  .map((r) => ({
    name: r.name,
    state: r.status,
    alert: !r.ok,
    tone: r.ok ? '' : 'alert',
    dot: r.color,
    notes: r.reason ? [{ text: r.reason, meta: '', more: '' }] : [],
  }));

export function render(el, vm, cfg) {
  const chosen = cfg.tfl?.lines ?? [];
  if (!chosen.length) {
    el.innerHTML = setupPrompt('tfl', 'pick lines', 'TfL Status');
    setExpandSource(el, null); // an unconfigured card taps into Settings
    return;
  }
  const byId = new Map((vm.lines ?? []).map((l) => [l.id, l]));
  const rows = chosen.map((id) => {
    const m = LINE_META.get(id);
    const live = byId.get(id);
    return {
      name: m?.name ?? id, color: m?.color ?? '#888',
      ok: live ? live.ok : true, status: live ? live.status : '—', reason: live?.reason ?? '',
    };
  });
  fitList(el, {
    id: meta.id,
    items: rows,
    fallback: 4,
    badge: true,
    draw: (n) => {
      // Alerting lines take priority when truncating (Subway's rule). Drawing
      // fewer than every line IS the truncation, so that is the test.
      const ordered = n < rows.length
        ? [...rows].sort((a, b) => Number(a.ok) - Number(b.ok)).slice(0, n)
        : rows;
      el.style.setProperty('--n', String(ordered.length)); // elastic row-gap divisor
      el.innerHTML = ordered
        .map((r) => `<div class="tfl ${r.ok ? '' : 'tfl--alert'}">
        <span class="tfl__dot" style="background:${r.color}"></span>
        <span class="tfl__name">${escapeHtml(r.name)}</span>
        <span class="tfl__status">${escapeHtml(r.status)}</span>
      </div>`)
        .join('');
    },
  });
  // The card ALWAYS opens the ledger (Sean, 2026-11-13), the rule Cloud
  // Services took first: every card opens when tapped. This one used to follow
  // "no badge, no expansion" and keep a per-row reader for a disrupted line
  // when nothing overflowed. With the ledger always behind the card that reader
  // could never be reached (it deferred to any expandable card), and nothing is
  // lost with it gone: the ledger shows every line's reason uncut. The badge
  // fitList pinned still counts only hidden lines.
  const alerting = rows.filter((r) => !r.ok).length;
  // A one-line config reads "1 line good", never "all 1 lines good": the
  // ledger now opens on cards that small too.
  const good = rows.length === 1 ? '1 line good' : `all ${rows.length} lines good`;
  const note = alerting ? `${alerting} of ${rows.length} lines with alerts` : good;
  setExpandSource(el, () => ({ title: meta.title, note, bodyHtml: ledgerBody(tflItems(rows)) }));
}

export async function fetchData(_cfg, net) {
  return net.fetchJSON(`${WORKER_URL}/tfl/status`);
}
