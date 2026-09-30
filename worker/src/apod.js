// NASA Astronomy Picture of the Day, read from NASA's own RSS feed (the last
// ~30 days, one item per day). APOD moved from apod.nasa.gov to
// science.nasa.gov/apod on 2026-09-29; since then api.nasa.gov/planetary/apod
// times out and the old apod.nasa.gov image URLs are dead, so the feed is the
// source. No key needed (NASA_KEY is now unused). Cached 1h at the route.
// Original spec: docs/superpowers/specs/2026-07-11-nasa-daily-photo-design.md.

import { htmlToText } from './htmltext.js';

const FEED = 'https://science.nasa.gov/feed/apod-basic/';

// NASA's resizer upscales past the native size, so ask for at most this width
// and never more than the image actually has (the hdurl's own ?w=).
const MAX_W = 1280;

// The feed has no media_type; video days still carry a poster still in hdurl,
// so "is an image" means the hdurl's path ends in an image extension.
const IMAGE_PATH = /\.(?:jpe?g|png|gif|webp)$/i;

// Each item also embeds the whole article page as <content:encoded>, which
// has its own <title> and the like; cut those out before reading any field.
const EMBEDDED_PAGE = /<content:encoded\b[^>]*>[\s\S]*?<\/content:encoded>/gi;

// First <tag>…</tag> in an item, CDATA unwrapped; '' when absent. Callers run
// the result through htmlToText, which decodes the entities either way.
function field(item, tag) {
  const m = item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// hdurl (entity-encoded "&#038;" between params) -> the same image at board
// width. null unless it is an http(s) URL to an image file.
function imageUrl(raw) {
  let u;
  try { u = new URL(htmlToText(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !IMAGE_PATH.test(u.pathname)) return null;
  // Some items carry w=0 (size unknown to NASA's CMS): treat as unknown.
  const native = parseInt(u.searchParams.get('w'), 10);
  const w = native > 0 ? Math.min(MAX_W, native) : MAX_W;
  return `${u.origin}${u.pathname}?w=${w}`;
}

// APOD posts on US Eastern days; the pubDate is UTC (04:05 UTC = 00:05 EDT),
// so a UTC date would be a day ahead for anything published before 04:00 UTC.
const EASTERN_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Every explanation opens with a bold "Explanation:" label and ends, after a
// blank line (<br><br>), with NASA's housekeeping (site-move notices, gallery
// links, "Tomorrow's picture"). Keep the paragraph before the first blank line.
const HOUSEKEEPING = /<br\s*\/?>\s*<br\s*\/?>[\s\S]*$/i;
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

export function mapApod(xml) {
  const body = String(xml ?? '').replace(EMBEDDED_PAGE, '');
  let pick = null;
  for (const [, item] of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const url = imageUrl(field(item, 'apod:hdurl'));
    const at = Date.parse(htmlToText(field(item, 'pubDate')));
    if (!url || !Number.isFinite(at)) continue;
    // Newest by pubDate rather than trusting the feed's newest-first order.
    if (!pick || at > pick.at) pick = { item, url, at };
  }
  const photo = pick ? {
    url: pick.url,
    title: oneLine(htmlToText(field(pick.item, 'title'))),
    explanation: oneLine(htmlToText(field(pick.item, 'apod:explanation').replace(HOUSEKEEPING, '')))
      .replace(/^Explanation:\s*/i, ''),
    // A few credits carry their own "Image Credit:" label; the card adds "©".
    credit: oneLine(htmlToText(field(pick.item, 'apod:credit') || field(pick.item, 'apod:copyright')))
      .replace(/^(?:Image\s+)?Credit\s*:\s*/i, ''),
    date: EASTERN_DAY.format(pick.at),
  } : null;
  return { photo };
}

export async function fetchApod(_env) {
  const res = await fetch(FEED, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`apod ${res.status}`);
  // A 200 that yields no picture (a maintenance page, a reshaped feed) is a
  // failure, not an answer: throwing keeps cached() serving last-good instead
  // of caching { photo: null } and overwriting the backup with it.
  const digest = mapApod(await res.text());
  if (!digest.photo) throw new Error('apod: no usable photo in feed');
  return digest;
}
