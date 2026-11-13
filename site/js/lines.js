// Official line colors for the LIRR, Metro-North and NJ Transit departure
// boards. A row's line name renders as a filled signage chip in the agency's
// own color, which is what makes it read as the LINE at a glance — as plain dim
// text it just looked like a repeat of the destination above it ("Babylon ·
// 8:46 PM" under "Babylon"). Keys are the strings the widgets already carry
// (lirr.js ROUTE_NAMES + TT_BRANCH_NAMES, mnr.js ROUTE_NAMES, and for NJT the
// verbatim feed LINE value, which config.js NJT_LINES already pins), so the
// table is a straight lookup with no extra mapping layer.
//
// `ink` is stored per line rather than derived at render time: it's a
// legibility call on the exact hue, and one table beats luminance math running
// once per row per minute. test/transit.test.js gates every pair at the 4.5:1
// AA floor (New Haven red is the one documented exception — see there).
//
// `label` is the optional short chip text, for the same reason `ink` is stored:
// data, not cleverness. NJT's feed names are long enough to crowd a 3-wide card
// ("Northeast Corridor Line · 8:46 PM"), and the drop is a suffix strip for
// five of the six and a whole word for the sixth — so it's written out per line
// instead of regex-guessed. Entries without a `label` show their key, which is
// every MTA line, unchanged.

import { escapeHtml } from './util.js';

export const LINE_COLORS = Object.freeze({
  // LIRR branches
  Babylon: Object.freeze({ bg: '#00985F', ink: '#000' }),
  Hempstead: Object.freeze({ bg: '#CE8E00', ink: '#000' }),
  'Oyster Bay': Object.freeze({ bg: '#00AF3F', ink: '#000' }),
  Ronkonkoma: Object.freeze({ bg: '#A626AA', ink: '#fff' }),
  Montauk: Object.freeze({ bg: '#006983', ink: '#fff' }),
  'Long Beach': Object.freeze({ bg: '#FF6319', ink: '#000' }),
  'Far Rockaway': Object.freeze({ bg: '#6E3219', ink: '#fff' }),
  'West Hempstead': Object.freeze({ bg: '#00A1DE', ink: '#000' }),
  'Port Washington': Object.freeze({ bg: '#C60C30', ink: '#fff' }),
  'Port Jefferson': Object.freeze({ bg: '#0039A6', ink: '#fff' }),
  'Belmont Park': Object.freeze({ bg: '#60269E', ink: '#fff' }),
  'City Terminal': Object.freeze({ bg: '#4D5357', ink: '#fff' }),
  // Metro-North lines. The three New Haven branches share the trunk's red,
  // exactly as MTA signage and maps color them.
  Hudson: Object.freeze({ bg: '#009B3A', ink: '#000' }),
  Harlem: Object.freeze({ bg: '#0039A6', ink: '#fff' }),
  'New Haven': Object.freeze({ bg: '#EE0034', ink: '#fff' }),
  'New Canaan': Object.freeze({ bg: '#EE0034', ink: '#fff' }),
  Danbury: Object.freeze({ bg: '#EE0034', ink: '#fff' }),
  Waterbury: Object.freeze({ bg: '#EE0034', ink: '#fff' }),
  'Port Jervis': Object.freeze({ bg: '#FF7900', ink: '#000' }),
  'Pascack Valley': Object.freeze({ bg: '#4D5357', ink: '#fff' }),
  // NJ Transit rail, keyed by the feed's verbatim LINE string. Every one of the
  // six takes black ink: NJT's palette is a bright one, so black is the
  // higher-contrast pick on all six (5.44:1 at the tightest, on the Northeast
  // Corridor red) — no exception needed here.
  'Northeast Corridor Line': Object.freeze({ bg: '#EF3E42', ink: '#000', label: 'Northeast Corridor' }),
  'North Jersey Coast Line': Object.freeze({ bg: '#00A4E4', ink: '#000', label: 'North Jersey Coast' }),
  'Morris & Essex Line': Object.freeze({ bg: '#00A94F', ink: '#000', label: 'Morris & Essex' }),
  'Montclair-Boonton Line': Object.freeze({ bg: '#E66B5B', ink: '#000', label: 'Montclair-Boonton' }),
  'Gladstone Branch': Object.freeze({ bg: '#A2D5AE', ink: '#000', label: 'Gladstone' }),
  'Raritan Valley Line': Object.freeze({ bg: '#FAA634', ink: '#000', label: 'Raritan Valley' }),
});

// Chip markup for one line name, in three cases:
//   known line  -> the filled chip in its official color, showing the entry's
//                  short `label` where it has one
//   unmapped    -> the escaped name as plain text, i.e. today's rendering, so
//                  a renamed branch or an undocumented TrainTime code still
//                  shows something true instead of vanishing (never shortened —
//                  we only shorten names we recognise)
//   no name     -> '' (the caller drops its separator too)
export function lineChip(name) {
  const line = String(name ?? '').trim();
  if (!line) return '';
  const c = LINE_COLORS[line];
  if (!c) return escapeHtml(line);
  return `<b class="train__linechip" style="background:${c.bg};color:${c.ink}">${escapeHtml(c.label ?? line)}</b>`;
}

// A departure's meta line (origin tag, line chip, clock time, status) as
// tokens that wrap WHOLE. Each token is its own no-wrap span and carries the
// separator in front of it, so a narrow card can only break the line between
// "· token" units: the old template let the dot ride at the end of a line and
// the time drop to the next ("[Port Washington] ·" over "9:54 AM"). Empty
// tokens drop out with their separator, so a nameless branch still reads
// "8:46 PM" rather than "· 8:46 PM". `cls` tags a token for the size-tier rules
// in main.css (train__time is the clock time Amtrak sheds on narrow cards).
// Token html is the caller's, already escaped.
export function metaLine(tokens) {
  return tokens
    .filter((t) => t?.html)
    .map((t, i) => `<span class="train__nb${t.cls ? ` ${t.cls}` : ''}">${i ? '· ' : ''}${t.html}</span>`)
    .join(' ');
}
