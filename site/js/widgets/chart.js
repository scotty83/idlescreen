// Statista Chart of the Day — an image-forward card mirroring the NASA Daily
// Photo (reuses the .artwork card styles + the shared full-screen viewer).
// One infographic per day from the worker's /chart digest; tap opens the
// viewer with the title, description, and Statista credit (their charts are
// CC BY-ND — attribution required, and the branding is baked into the image).

import { WORKER_URL } from '../env.js';
import { clearImageCard, openImageViewer, renderImageCard } from '../imageshow.js';

export const meta = { id: 'chart', title: 'Chart of the Day', refreshMs: 30 * 60 * 1000 };

// Built-in politics/Trump terms, gated by cfg.chart.excludePolitics. Matched
// against title+desc case-insensitively (see pickChart). Kept conservative so
// an on-topic economics chart isn't dropped for a passing mention.
const POLITICS_TERMS = [
  'trump', 'biden', 'election', 'congress', 'senate', 'republican', 'democrat',
  'gop', 'white house', 'campaign', 'poll', 'ballot', 'voter',
];

// From the newest-first charts[], pick the first whose title+desc mentions no
// politics terms (when the hide-politics filter is on); fall back to charts[0]
// if every card matches (a filtered-to-empty card is worse than one off-topic).
export function pickChart(charts, cfg) {
  const list = Array.isArray(charts) ? charts : [];
  if (!list.length) return null;
  const c = cfg?.chart ?? {};
  const terms = (c.excludePolitics === false ? [] : POLITICS_TERMS)
    .map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  if (!terms.length) return list[0];
  const clean = list.find((ch) => {
    const hay = `${ch.title ?? ''} ${ch.desc ?? ''}`.toLowerCase();
    return !terms.some((t) => hay.includes(t));
  });
  return clean ?? list[0];
}

export function render(el, vm, cfg) {
  // Worker now returns charts[] (newest-first); pick the first non-excluded.
  // Legacy `chart` singular kept as a fallback for a stale cached payload.
  const c = pickChart(vm.charts, cfg) ?? vm.chart;
  if (!c || !c.url) {
    el.innerHTML = '<div class="empty">Chart unavailable</div>';
    clearImageCard(el); // yesterday's tap and mark must not outlive the chart
    return;
  }
  // The shared image surface (2026-08-01), which this card had been hand-rolling
  // a copy of: it brings the decode-before-swap cross-fade, and — the reason for
  // the change — the one place that makes the WHOLE CARD the tap target, instead
  // of a role="button" figure whose title row and padding were dead glass.
  //
  // No card caption: the infographic embeds its own title and the Statista
  // branding — a caption would just repeat both (Sean flagged the duplicate).
  // The tap viewer still shows title/description/credit.
  //
  // The infographic changes once a day but the card refreshes every 30 minutes,
  // so the unchanged-src early return is what stops it re-decoding and
  // re-painting the same chart all day, and the day's new one decodes before it
  // dissolves in. (The old markup rebuilt a fresh lazy-loading image element on
  // every render, which left the card black for seconds at boot: lazy loading
  // is for content below a fold, and a board has none.)
  renderImageCard(el, {
    src: c.url,
    alt: c.title,
    label: 'View chart full screen',
    contain: true, // a data image is never cropped
    // No caption: Statista bakes the title/source into the infographic, so the
    // overlay would just repeat it and cover part of the image.  No info strip
    // either: there's no room to place it without covering chart content, and a
    // full-screen chart is a quick glance, not a lingering screensaver.
    onOpen: () => openImageViewer(
      { img: c.url, title: c.title, artist: 'Statista', desc: c.desc },
      cfg,
      { list: [], caption: false, strip: false },
    ),
  });
}

// Deterministic rotation slot: which of the selected topics to show right now.
// Keyed off wall-clock so every board lands on the same topic within a slot
// (fleet-consistent, no per-device drift), and advances once per refresh
// window. '' (empty/non-array topics) asks for the newest charts overall.
export function currentTopic(topics, now = Date.now(), slotMs = meta.refreshMs) {
  if (!Array.isArray(topics) || !topics.length) return '';
  return topics[Math.floor(now / slotMs) % topics.length];
}

export async function fetchData(cfg, net) {
  // A configured topic asks the worker for that topic's newest charts: it keeps
  // a classified index of Statista's recent charts and filters it, falling back
  // to the newest overall when the topic has nothing recent, so the card never
  // blanks. It validates the slug and caches under `chart:<topic>` (the global
  // default stays one fleet-wide entry). Client-side filtering picks the card.
  // Multiple topics cycle deterministically on each refresh (see currentTopic).
  const topic = currentTopic(cfg?.chart?.topics);
  const qs = topic ? `?topic=${encodeURIComponent(topic)}` : '';
  return net.fetchJSON(`${WORKER_URL}/chart${qs}`);
}
