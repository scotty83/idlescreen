// Current tennis tournament from ESPN's public ATP + WTA scoreboards
// (CORS-open, keyless, browser-direct). Config-less: whatever tournament is
// on IS the card — live singles matches first, then today's upcoming, then
// the freshest finals. Doubles are skipped (no athlete names in the feed).

import { escapeHtml } from '../util.js';
import { setCardNote, setMoreBadge } from '../card.js';
import { fitList } from '../capacity.js';
import { WORKER_URL } from '../env.js';
import { setExpandSource } from '../expand.js';
import { dealColumns, gridStyle } from '../columns.js';
import { mapTennisEvent, mapTennis } from '../espn-scores.js';

export { mapTennisEvent, mapTennis }; // single shared mapper (site fallback + worker digest + tests)

export const meta = { id: 'tennis', title: 'Tennis', refreshMs: 5 * 60 * 1000 };

// ---------- one match, two renderings ----------
//
// The card and the board both pack a match onto ONE line (matchup left, score
// right); the board adds a quiet round chip. Everything that decides WHAT
// those strings say is shared so the surfaces can never disagree about who
// beat whom.

const flag = (href) => (href ? `<img class="tennis-row__flag" src="${escapeHtml(href)}" alt="">` : '');

// Finished: the winner carries the weight, the rest goes quiet — no tour tag,
// no labels; the typography does the explaining.
function matchLabel(m) {
  if (m.state === 'post' && m.winner) {
    const [wN, wF, lN, lF] = m.winner === 'a' ? [m.a, m.aFlag, m.b, m.bFlag] : [m.b, m.bFlag, m.a, m.aFlag];
    return `${flag(wF)}<b>${escapeHtml(wN)}</b> <span class="tennis-row__quiet">d.</span> ${flag(lF)}<span class="tennis-row__quiet">${escapeHtml(lN)}</span>`;
  }
  return `${flag(m.aFlag)}${escapeHtml(m.a)} <span class="tennis-row__quiet">vs</span> ${flag(m.bFlag)}${escapeHtml(m.b)}`;
}

// The right-hand (card) / lower (board) string: sets while they exist,
// otherwise the schedule line. Walkovers finish with no sets at all.
function matchScore(m) {
  // Commas keep multi-set lines scannable ("4-6, 6-4, 4-6").
  const sets = escapeHtml((m.sets || '').split(' ').join(', '));
  if (m.state === 'in') return sets;
  if (m.state === 'post') return sets || escapeHtml(m.detail);
  return escapeHtml(m.detail);
}

const LIVE_DOT = '<b class="tennis-row__live">●</b> ';

// The overlay's small text: the tournament, then the calendar day it is being
// read on. The feed carries no tournament day number, and the date is the fact
// a reader actually wants beside a mixed board of finals and start times.
export const boardDay = (date = new Date()) =>
  date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

// The board's round chip: the feed's displayName, compressed to the draw-sheet
// shorthand ("Round of 16" and "Round 3" are both feed-real; slams use one,
// regular tour weeks the other). Qualifying rounds collapse to one quiet word
// and anything unrecognized renders as an empty chip rather than a guess.
export function roundAbbrev(name = '') {
  const n = String(name);
  const of = n.match(/^round of (\d+)$/i) || n.match(/^round (\d+)$/i);
  if (of) return `R${of[1]}`;
  if (/^quarterfinals?$/i.test(n)) return 'QF';
  if (/^semifinals?$/i.test(n)) return 'SF';
  if (/^finals?$/i.test(n)) return 'F';
  if (/^qualifying/i.test(n)) return 'Qual';
  return '';
}

// The full-screen view (Sean's pick, mockup C, 2026-09-01): the card's own
// one-line row on hairline rules, dealt into two centered columns past
// thirteen — the golf leaderboard's deal. Twenty-six is the canvas: on the
// pinned line-heights in main.css a row is 11 + 27.5 + 11 + 1 = 50.5px, so
// thirteen per column are 656.5px inside the 814px body.
export const BOARD_ROWS = 13;
export const BOARD_MATCHES = BOARD_ROWS * 2;

function tennisBoard(rows) {
  const shown = rows.slice(0, BOARD_MATCHES);
  const { columns, rows: perColumn } = dealColumns(shown.length, { fitsOneColumn: BOARD_ROWS });
  const split = columns > 1;
  return `<div class="tennis-board ${split ? 'tennis-board--split' : ''}"${gridStyle('--board-rows', perColumn)}>${shown
    .map(
      (m) => `<div class="tennis-board__row ${m.state === 'in' ? 'tennis-row--live' : ''}">
        <span class="tennis-board__round">${escapeHtml(roundAbbrev(m.round))}</span>
        <span class="tennis-board__match">${m.state === 'in' ? LIVE_DOT : ''}${matchLabel(m)}</span>
        <span class="tennis-board__score">${matchScore(m)}</span>
      </div>`,
    )
    .join('')}</div>`;
}

const FEEDS = [
  ['ATP', 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard'],
  ['WTA', 'https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard'],
];

export function render(el, vm, _cfg) {
  setCardNote(el, vm.name);
  if (!vm.rows.length) {
    el.innerHTML = '<div class="empty">No tournament matches right now</div>';
    // No draw, no view. Both are cleared so a card that has gone quiet between
    // tournaments stops counting rows it no longer holds.
    setMoreBadge(el, 0);
    setExpandSource(el, null);
    return;
  }
  fitList(el, {
    id: meta.id,
    items: vm.rows,
    defaultSize: [3, 4],
    badge: true,
    draw: (n) => {
      const shown = vm.rows.slice(0, n);
      el.style.setProperty('--n', String(shown.length)); // elastic row-gap divisor
      el.innerHTML = shown
        .map(
          (m) => `<div class="tennis-row ${m.state === 'in' ? 'tennis-row--live' : ''}">
        <span class="tennis-row__match">${matchLabel(m)}</span>
        <span class="tennis-row__score">${m.state === 'in' ? LIVE_DOT : ''}${matchScore(m)}</span>
      </div>`,
        )
        .join('');
    },
  });
  // Unconditional, the history precedent: one card, one destination. The
  // tournament and the day ride the overlay's small text.
  setExpandSource(el, () => ({
    title: meta.title,
    note: [vm.name, boardDay()].filter(Boolean).join(' · '),
    bodyHtml: tennisBoard(vm.rows),
  }));
}

export async function fetchData(_cfg, net) {
  // Worker digest first (~2 KB + 24h stale fallback vs ~1.8 MB of raw
  // scoreboards); browser-direct fallback covers the route's rollout window
  // and worker outages. Either tour may be idle: partial is fine, both
  // failing throws so the scheduler backs off and keeps the last-good cache.
  try {
    return await net.fetchJSON(`${WORKER_URL}/tennis`);
  } catch {
    const [atp, wta] = await Promise.allSettled(FEEDS.map(([, u]) => net.fetchJSON(u)));
    if (atp.status === 'rejected' && wta.status === 'rejected') throw new Error('tennis: both tours failed');
    return mapTennis(
      atp.status === 'fulfilled' ? atp.value : null,
      wta.status === 'fulfilled' ? wta.value : null,
    );
  }
}
