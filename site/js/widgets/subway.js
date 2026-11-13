// NYC Subway line-status board: one row per selected line showing Good
// Service or the current alert (per Sean: no departure times, just alerts
// for the lines you pick). Data is the Worker's cached digest of the MTA
// alert feed — the raw feed runs ~800 KB, the digest ~2 KB.

import { escapeHtml, fmtClock, setupPrompt } from '../util.js';
import { routeBullets } from '../transit-alerts.js';
import { WORKER_URL } from '../env.js';
import { fitList } from '../capacity.js';
import { setExpandSource, OVERLAY_BODY_H } from '../expand.js';

export const meta = { id: 'subway', title: 'Subway Status', refreshMs: 2 * 60 * 1000 };

// Kept for the settings line chips.
export const SUBWAY_LINES = ['1', '2', '3', '4', '5', '6', '7', 'A', 'C', 'E', 'B', 'D', 'F', 'M', 'G', 'J', 'Z', 'L', 'N', 'Q', 'R', 'W', 'S', 'SI'];

// A picked line can carry alerts under sibling feed route ids: shuttles are
// tagged GS/FS/H (never 'S'), and express variants 6X/7X/FX. Match any.
const LINE_ALIASES = {
  S: ['S', 'GS', 'FS', 'H'],
  6: ['6', '6X'],
  7: ['7', '7X'],
  F: ['F', 'FX'],
};

// digest alerts: [{routes, header}]. Returns one row per selected line.
export function mapSubwayStatus(alerts, lines) {
  return lines.map((line) => {
    const ids = LINE_ALIASES[line] ?? [line];
    const hits = (alerts ?? []).filter((a) => a.routes.some((r) => ids.includes(r)));
    return {
      line,
      ok: hits.length === 0,
      headers: hits.slice(0, 2).map((a) => a.header),
    };
  });
}

// ---------- tap-to-expand: the full status board ----------

// Overlay geometry, browser-measured on the 1920-wide overlay (the width is the
// same on every supported device, so these are fixed pixels — the same reasoning
// capacity.js uses for card rows). .expand__body's content box measures 1776
// wide; its height is the shared overlay canvas, which since 2026-07-28 is the
// BOARD's 814 rather than the headless harness's 854.
const WALL_H = OVERLAY_BODY_H;
const BAND_ROW = 60; // one row of Good Service bullets
const BAND_GAP = 16;
// Bullets that fit on one band row beside the "Good Service" label and the
// count. Browser-measured at 18 with the longest count string ("24 of 24
// lines"); 17 keeps one bullet of headroom, because the board's font falls back
// to whatever RoomOS has and a wider label steals the last slot. Erring low
// only over-reserves 76px of canvas, which costs a rung at worst.
const BAND_PER_ROW = 17;
const RULE_BLOCK = 53; // .wall__rule: a 1px hairline plus its 26px margins
// The gap between problem wells, uniform everywhere: every well sits exactly
// this far below the one above it, in both columns. It replaced an elastic
// 18-36px gap that existed only to fill the row tracks of the old shared grid —
// once each column packs its own wells from the hairline down there is nothing
// left to fill, and one pitch reads as one rhythm across both columns.
const ALERT_GAP = 20;

// The ladder a problem well walks down as the morning gets worse. The wall
// spends its slack on SIZE first: one full-width column in the biggest type,
// then two columns in that same type, and only then does the type itself step
// down — so a meltdown still shows every line and every word rather than
// clipping the tail. Bottom rung is 20px alert text: exactly what the CARD
// already asks a reader to take, never less.
//
// Which is why the ladder ends on a COLUMN and not on a type step: the last two
// rungs are the same 20px scale, dealt into two columns and then three. The
// ladder used to stop at the two-column 20px rung and simply clip whatever did
// not fit past it — 27px of a twelve-alert meltdown on the 854px harness canvas,
// and 67px once that canvas was corrected to the board's real 814. A third
// column costs no CSS (.wall__col is flex:1 1 0) and no legibility floor, and it
// buys back more than the correction took.
//
// Each rung carries BOTH halves of its own bargain: `css` is the --well-* scale
// it renders at (main.css holds the top rung as its defaults), and the rest is
// that scale browser-measured — `chars` the alert copy that fits one line at
// this size in a column of this count, `line` the line box, `para` the gap
// between a line's stacked headers, `pad` the well's top+bottom padding,
// `bullet` its bullet. Model and render therefore cannot drift apart.
export const ALERT_STEPS = [
  { cols: 1, chars: 115, line: 41, para: 9, pad: 40, bullet: 80, css: '' },
  { cols: 2, chars: 50, line: 41, para: 9, pad: 40, bullet: 80, css: '' },
  {
    cols: 2, chars: 57, line: 37, para: 8, pad: 36, bullet: 70,
    css: '--well-fs:27px;--well-bullet:70px;--well-bfs:37px;--well-pad:18px;--well-px:26px;--well-gap:24px;--well-para:8px;',
  },
  {
    cols: 2, chars: 65, line: 33, para: 8, pad: 32, bullet: 60,
    css: '--well-fs:24px;--well-bullet:60px;--well-bfs:32px;--well-pad:16px;--well-px:24px;--well-gap:22px;--well-para:8px;',
  },
  {
    cols: 2, chars: 80, line: 28, para: 7, pad: 24, bullet: 48,
    css: '--well-fs:20px;--well-bullet:48px;--well-bfs:26px;--well-pad:12px;--well-px:20px;--well-gap:18px;--well-para:7px;',
  },
  // Same 20px scale as the rung above, one more column. Browser-measured on the
  // 1776px canvas the same way the rungs above it were: two columns give the
  // text 770px and three give it 470px, and 47 characters of prose fit that
  // 470px line once WORD wrapping has had its share (a bare character count
  // would say 52). That is the same 47 the two-column 30px rung measures — the
  // column narrows by a third exactly as the type does.
  {
    cols: 3, chars: 47, line: 28, para: 7, pad: 24, bullet: 48,
    css: '--well-fs:20px;--well-bullet:48px;--well-bfs:26px;--well-pad:12px;--well-px:20px;--well-gap:18px;--well-para:7px;',
  },
];

// ---------- the status pill ----------

// A well leads with ONE amber pill naming what is wrong, read off the lead
// alert's own prose. The MTA writes its headers to a small set of phrasings, and
// this is that set in priority order — FIRST MATCH WINS, so a train that is both
// rerouted and making local stops reads REROUTE, the bigger fact. `label` may
// reference the pattern's capture groups. Matching nothing is not a failure:
// SERVICE ALERT is true of every alert the feed can carry, so the pill is never
// wrong, only sometimes unspecific.
export const STATUS_RULES = [
  { re: /\breroute[ds]?\b/i, label: 'Reroute' },
  { re: /\blocal (?:stops|service)\b/i, label: 'Local stops' },
  { re: /\b(?:skip(?:s|ped|ping)?|stops? at|stopping at)\b/i, label: 'Skipped stops' },
  { re: /\brunning every (\d+) minutes?\b/i, label: 'Every $1 min' },
  { re: /\bdelay(?:s|ed|ing)?\b/i, label: 'Delays' },
  { re: /\bsuspended\b/i, label: 'Suspended' },
];
export const STATUS_FALLBACK = 'Service alert';

export function statusLabel(header) {
  const text = String(header ?? '');
  for (const { re, label } of STATUS_RULES) {
    const m = text.match(re);
    if (m) return label.replace(/\$(\d)/g, (_, n) => m[Number(n)]);
  }
  return STATUS_FALLBACK;
}

// What the pill costs the well, priced in the same `chars` currency the ladder
// measures wrapping in. The pill's type is 0.74em of the body's, but it is
// uppercase with 0.06em of tracking, which puts a pill glyph back at about one
// body character — so its width is its label plus three characters for the
// padding and the gap after it. Both halves are em-relative in the CSS, so that
// price holds at every rung (browser-checked at rung 2: a 20px pill on 27px body
// copy measures 111px against a 12.0px average character).
//
// It is spent WHERE IT SITS — at the head of the lead's first line, inside the
// wrap arithmetic — and not as a fraction of a line added afterwards. The
// fractional charge was the ladder's one real modelling error, and it was the
// error the "only when the lead is within nine characters of a wrap boundary"
// caveat described without pricing: a 113-character header is 1.98 lines of a
// 57-character rung, so the pill IS what pushes it to three, and the model went
// on reading 2.175 lines where the browser drew 3. Browser-measured on the real
// classes at every rung: a 57-char line takes 58 characters of prose bare and 47
// with the pill in front of it, and the model has to answer 3 for both.
// Charging it inside the ceiling costs nothing when the lead is not near a
// boundary — ceil((113+10)/80) and ceil(113/80) are the same two lines.
const PILL_CHARS = 3;
const pillChars = (header) => statusLabel(header).length + PILL_CHARS;

// A well is its frame, or its text when the text is taller — EVERY header the
// line carries, stacked (the card shows only the first, and clamps it). Only the
// lead header pays for the pill: one well, one pill. Route tokens are counted as
// the characters they are written as, which is a touch more than the bullet that
// replaces them draws — erring long here only ever buys a well more room.
export function wellLines(headers, step) {
  return headers.reduce(
    (n, h, i) => n + Math.max(1, Math.ceil((String(h).length + (i ? 0 : pillChars(h))) / step.chars)),
    0,
  );
}
export function wellHeight(headers, step) {
  const text = wellLines(headers, step) * step.line + Math.max(headers.length - 1, 0) * step.para;
  return Math.round(step.pad + Math.max(step.bullet, text));
}

// Band rows for n healthy lines (0 when none — the band does not render, and
// reserves nothing, the way the markets shelf folds).
export const bandRows = (n) => (n ? Math.ceil(n / BAND_PER_ROW) : 0);

// What the problem wells have left once the band has taken its share.
export function alertsAvail(rows) {
  return WALL_H - (rows ? rows * BAND_ROW + (rows - 1) * BAND_GAP + RULE_BLOCK : 0);
}

// The wells dealt into columns. Config order runs DOWN the first column and then
// down the second, so column c holds wells [c·rows, (c+1)·rows) — `rows` is the
// height of the FIRST column, and the second takes what is left (seven wells
// split 4 + 3, never 6 + 1).
export function alertColumns(alerting, step, rows) {
  return Array.from({ length: step.cols }, (_, c) => alerting.slice(c * rows, (c + 1) * rows))
    .filter((col) => col.length);
}

// Each column is its own top-packed stack: its wells at their own heights plus
// its own uniform gaps. The columns share no row tracks, so a short well beside a
// tall one costs nothing and the region is as tall as its TALLEST COLUMN — not,
// as it once was, the sum of the tallest well in each row.
export function alertColHeights(alerting, step, rows) {
  return alertColumns(alerting, step, rows).map(
    (col) => col.reduce((n, l) => n + wellHeight(l.headers, step), 0) + (col.length - 1) * ALERT_GAP,
  );
}

// The first step on the ladder that holds every well whole. One column while the
// wells fit it (five on a typical morning under a one-row band); past that they
// flow into two columns, and only then does the type step down.
export function alertStep(alerting, bRows = 0) {
  const avail = alertsAvail(bRows);
  for (const step of ALERT_STEPS) {
    const rows = Math.ceil(alerting.length / step.cols);
    if (Math.max(...alertColHeights(alerting, step, rows)) <= avail) return step;
  }
  return ALERT_STEPS[ALERT_STEPS.length - 1]; // the tightest step is the floor
}

// The overlay body: every configured line at once. Healthy lines collapse into
// one compact bullet band that scales to a full 25-service config in a single
// sweep; each line WITH a problem gets its own well below, in config order,
// carrying all of its alert text — including the second alert the card drops.
// Either band renders only when it has lines, so an all-good morning is the
// bullet band alone (centered, no empty region) and a total meltdown is all
// wells on the full canvas.
// `rung` pins the ladder to one exact step, which is how fitStatusBoard puts a
// tape measure to each of them; null leaves the choice to the model. `clamp`
// cuts every well's prose to that many whole lines (fitStatusBoard's last stage,
// below); null draws every word.
export function statusBoard(lines, rung = null, clamp = null) {
  const good = lines.filter((l) => l.ok);
  const alerting = lines.filter((l) => !l.ok);
  const bullet = (l) => `<span class="bullet bullet--${escapeHtml(l.line)}">${escapeHtml(l.line)}</span>`;
  const bands = [];
  if (good.length) {
    bands.push(`<div class="wall__good">
      <span class="wall__goodlabel">Good Service</span>
      <span class="wall__bullets">${good.map(bullet).join('')}</span>
      <span class="wall__count">${good.length} of ${lines.length} lines</span>
    </div>`);
  }
  if (good.length && alerting.length) bands.push('<div class="wall__rule"></div>');
  if (alerting.length) {
    const step = rung == null ? alertStep(alerting, bandRows(good.length)) : ALERT_STEPS[rung];
    const rows = Math.ceil(alerting.length / step.cols);
    const pill = (h) => `<span class="sbstatus">${escapeHtml(statusLabel(h))}</span>`;
    const well = (l) => `<div class="sbalert">${bullet(l)}
        <div class="sbalert__text">${l.headers
          .map((h, i) => `<p>${i ? '' : pill(h)}${routeBullets(h)}</p>`)
          .join('')}</div>
      </div>`;
    // One column needs no wrapper; two get one each, so each packs independently.
    const body = step.cols > 1
      ? alertColumns(alerting, step, rows)
        .map((col) => `<div class="wall__col">${col.map(well).join('')}</div>`)
        .join('')
      : alerting.map(well).join('');
    // The rung rides on the element so fitStatusBoard knows where to resume.
    const cut = clamp == null ? '' : ' wall__alerts--clamped';
    const clampCss = clamp == null ? '' : `;--well-clamp:${clamp}`;
    bands.push(
      `<div class="wall__alerts${step.cols > 1 ? ' wall__alerts--split' : ''}${cut}" data-rung="${ALERT_STEPS.indexOf(step)}" style="${step.css}--well-space:${ALERT_GAP}px${clampCss}">${body}</div>`,
    );
  }
  // A band with no wells under it centers rather than stranding itself at the
  // top edge (the markets wall does the same with a lone shelf).
  return `<div class="wall${alerting.length ? '' : ' wall--good-only'}">${bands.join('')}</div>`;
}

// The browser gets the last word on the ladder. Every rung's `chars` is a
// measured average, and an average cannot be exact: whether a lead header lands
// just before or just after a word boundary moves its real line count by one in
// EITHER direction, so a rung the model accepts can render a well taller than it
// priced. Measured on the real classes: at the 30px rung a 138-character header
// wraps to three lines of one MTA sentence and four of another, a 40px swing per
// well that no character count can predict.
//
// So: estimate, then check — the identical contract the card runs (its own row
// loop), the rail boards run (fitTrainRows) and the services card runs. When the
// estimate was right, which is every morning short of a meltdown, this measures
// once and returns; nothing is re-rendered and nothing moves.
//
// When it was wrong the wall stops guessing and walks the whole ladder with a
// tape measure, taking the FIRST rung that genuinely holds — biggest type wins,
// same priority the model has. If none of them hold it keeps the rung that
// spills least, because down the ladder is not monotonically better: a narrower
// column wraps a well taller, so at sixteen alerting lines the three-column
// floor loses more of the wall than the two-column rung above it. Bounded by the
// six rungs, and only ever paid on a morning that was already going to clip.
//
// A rung that spills least still spills, and what it spills is the bottom row
// of wells cut through the middle of a sentence. So when no rung holds, one
// further stage gives up the right thing: not a line (which lines are affected
// is the fact the wall exists to state) but the TAIL of each well's prose. Every
// well is clamped to the same whole number of lines, with an ellipsis, at the
// largest clamp the tape measure says the wall holds, walking down one line at a
// time from the longest well the model prices at that rung (the model can be a
// line out either way, and a clamp at or past a well's real length cuts nothing
// and simply spills again, so the walk just steps on). A subway line's second
// alert is the first thing to go, because it sits at the tail.
//
// The rungs are tried in the order they spilled, least first, so the wall keeps
// the type the ladder would have chosen whenever a clamp can make it hold. A
// clamp cannot shrink a well below its bullet frame, though, so a rung can still
// spill at one line: sixteen alerting lines leave the two-column rung 15px over
// at a one-line clamp, while the three-column rung beside it holds at two. Hence
// every rung gets its turn before the wall settles for the (rung, clamp) that
// spilled least. Bounded by six rungs times a well's line count, and only ever
// paid on a morning that was already going to clip.
export function fitStatusBoard(body, lines) {
  const wall = () => body?.querySelector?.('.wall__alerts');
  if (!wall()?.clientHeight) return; // no layout engine (unit tests)
  const spill = () => wall().scrollHeight - wall().clientHeight;
  let best = { rung: Number(wall().dataset.rung ?? 0), spill: spill(), clamp: null };
  if (best.spill <= 0) return;
  const spills = [];
  for (let r = 0; r < ALERT_STEPS.length; r++) {
    body.innerHTML = statusBoard(lines, r);
    const s = spill();
    spills.push({ rung: r, spill: s });
    if (s < best.spill) best = { rung: r, spill: s, clamp: null };
    if (s <= 0) break;
  }
  if (best.spill > 0) {
    const alerting = lines.filter((l) => !l.ok);
    clampWalk:
    for (const { rung } of spills.sort((a, b) => a.spill - b.spill)) {
      const step = ALERT_STEPS[rung];
      const longest = Math.max(...alerting.map((l) => wellLines(l.headers, step)));
      for (let c = longest; c >= 1; c--) {
        body.innerHTML = statusBoard(lines, rung, c);
        const s = spill();
        if (s < best.spill) best = { rung, spill: s, clamp: c };
        if (s <= 0) break clampWalk;
      }
    }
  }
  body.innerHTML = statusBoard(lines, best.rung, best.clamp);
}

export function render(el, vm, cfg) {
  if (!vm.lines?.length) {
    el.innerHTML = setupPrompt('subway', 'pick your lines', 'Subway');
    setExpandSource(el, null); // a card that lost its lines must not still expand
    return;
  }
  const rowHtml = (row) => `<div class="linestatus ${row.ok ? '' : 'linestatus--alert'}">
        <span class="bullet bullet--${escapeHtml(row.line)}">${escapeHtml(row.line)}</span>
        <span class="linestatus__text">${
          row.ok ? 'Good Service' : routeBullets(row.headers[0])
        }</span>
        ${row.ok ? '' : '<span class="linestatus__icon" aria-hidden="true">⚠</span>'}
      </div>`;
  // When truncating, alerting lines take priority over Good Service rows.
  // The overflow count rides the title badge, so it costs no row.
  //
  // That order is settled ONCE, against the estimate, which is what the first
  // draw carries: a card whose estimate seats every line keeps line order, and
  // a row the measurement sheds after that comes off the bottom. Deciding it
  // again on each shrink would re-rank a board mid-fit and float an alert into
  // view a row at a time.
  let ranked = null;
  // Alert rows wrap taller than the capacity pitch budgets; when they push
  // past the body, shed rows to the corner badge (services-style trim) rather
  // than clipping — the capacity model and height caps assume this backstop.
  // Shrink only: there is nothing above the estimate to grow into, since the
  // rows past it were the ones the priority order already ruled out.
  fitList(el, {
    id: meta.id,
    items: vm.lines,
    measure: true,
    badge: true,
    draw: (n) => {
      ranked ??= vm.lines.length > n
        ? [...vm.lines].sort((a, b) => Number(a.ok) - Number(b.ok))
        : vm.lines;
      // Stamp the elastic row-gap divisor with every rebuild so the gap math
      // tracks the rows actually shown as the trim loop moves n.
      el.style.setProperty('--n', String(n));
      el.innerHTML = ranked.slice(0, n).map(rowHtml).join('');
    },
  });
  // Rows here are not tappable, so the whole card is the target, and it opens
  // the status board whatever the card had room for (Sean, 2026-11-13): a
  // commuter who taps the card on a good-service day gets the board, not a dead
  // tap. fitList has already pinned the +N badge to the hidden rows alone, so
  // the badge is information and the tap is the universal rule. The closure
  // captures THIS render's vm, so the overlay always shows what the card was
  // showing when it was tapped.
  const alerting = vm.lines.filter((l) => !l.ok).length;
  const note = [
    alerting ? `${alerting} of ${vm.lines.length} lines with alerts` : '',
    vm.updatedAt ? `as of ${fmtClock(vm.updatedAt, cfg?.clock24)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  setExpandSource(el, () => ({
    title: meta.title,
    note,
    bodyHtml: statusBoard(vm.lines),
    onOpen: (bodyEl) => fitStatusBoard(bodyEl, vm.lines),
  }));
}

export async function fetchData(cfg, net) {
  const digest = await net.fetchJSON(`${WORKER_URL}/alerts/subway`);
  return {
    updatedAt: digest.updatedAt,
    stale: Boolean(digest.stale),
    lines: mapSubwayStatus(digest.alerts, cfg.subway.lines),
  };
}
