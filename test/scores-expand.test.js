/**
 * @vitest-environment happy-dom
 *
 * Full-screen views for the four score/arrival cards: My Teams, Golf, Tennis
 * and Express Bus. Three things are under test and they are not the same
 * thing:
 *
 *   1. REGISTRATION is unconditional in every populated render path (the
 *      history precedent) — a card that fits all its data still opens, because
 *      the rows cover the card and one card has to mean one destination. Only
 *      the corner badge tracks what is hidden.
 *   2. CLEARING is unconditional in every empty path. Before this batch those
 *      paths returned early, leaving the previous render's dataset.more in the
 *      corner: a card promising rows it no longer held.
 *   3. LIVE MINUTES on the bus board are derived at RENDER time from the
 *      absolute arrival instant, so a view opened late in a refresh cycle
 *      counts down from now rather than from the last fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeExpand, isExpandOpen } from '../site/js/expand.js';
// Namespaces, so the scaffold can mount each widget's REAL card off its own
// meta instead of labelling it with the bare widget id.
import * as sports from '../site/js/widgets/sports.js';
import * as golf from '../site/js/widgets/golf.js';
import * as tennis from '../site/js/widgets/tennis.js';
import * as bus from '../site/js/widgets/bus.js';
import { board as mountBoard } from './helpers/board.js';

const { render: renderSports, BOARD_TEAMS } = sports;
const { render: renderGolf, BOARD_ROWS, BOARD_PLAYERS } = golf;
const { render: renderTennis, BOARD_MATCHES, BOARD_ROWS: TENNIS_BOARD_ROWS, boardDay, roundAbbrev } = tennis;
const { render: renderBus, mapBus, busMin } = bus;
const MODS = { sports, golf, tennis, bus };

const overlay = () => document.querySelector('#expand-view');
const text = () => overlay().textContent.replace(/\s+/g, ' ').trim();

// A one-card board with the delegated expand listener wired, as main.js does.
const board = (widget, renderFn, vm, { size = [4, 4], cfg = {} } = {}) =>
  mountBoard(MODS[widget], { rect: { w: size[0], h: size[1] }, vm, cfg, render: renderFn });

beforeEach(() => {
  closeExpand();
  document.body.innerHTML = '';
});

/* ============================ MY TEAMS ============================ */

const team = (i, over = {}) => ({
  lg: 'mlb',
  abbr: `T${i}`,
  name: `Team ${i}`,
  record: `${10 + i}-${i}`,
  logo: `https://a.espncdn.com/i/teamlogos/mlb/500/t${i}.png`,
  state: 'pre',
  line: `vs OPP ${i}, 7:05 PM`,
  lastLine: `W 5-${i} vs OPP`,
  nextLine: `Fri vs OPP ${i}`,
  ...over,
});
const sportsVm = (n, over = {}) => ({ rows: Array.from({ length: n }, (_, i) => team(i + 1, over)) });

describe('My Teams: the grand centered column', () => {
  it('registers unconditionally — a card showing every team still opens', () => {
    // A 4x8 card fits ten teams, so six hide nothing and there is no badge.
    // The card is expandable all the same: the rows cover it, so its one tap
    // owes a destination.
    const { card } = board('sports', renderSports, sportsVm(6), { size: [4, 8] });
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelector('.expand__title').textContent).toBe('My Teams');
    expect(overlay().querySelectorAll('.team--board').length).toBe(6);
  });

  it('shows everything the card row shows, at reading size', () => {
    const vm = sportsVm(1, { state: 'in', line: 'BOT 7, 4-3', lastLine: 'W 5-1 vs OPP', nextLine: 'Fri vs OPP' });
    const { card } = board('sports', renderSports, vm, { size: [4, 3] });
    card.click();
    const row = overlay().querySelector('.team--board');
    expect(row.classList.contains('team--live')).toBe(true);
    // The card's own artwork, asked of ESPN's combiner at board size.
    expect(row.querySelector('.team__logo').getAttribute('src')).toContain('h=120');
    expect(row.querySelector('.team__name').textContent).toContain('Team 1');
    expect(row.querySelector('.team__name small').textContent).toBe('11-1'); // record beside the name
    expect(row.querySelector('.team__livedot')).not.toBeNull(); // live dot on the status line
    expect(row.querySelector('.team__line').textContent).toContain('BOT 7, 4-3');
    // In-progress: "Last" belongs, "Next" does not (the card's own rules).
    expect(text()).toContain('Last: W 5-1 vs OPP');
    expect(text()).not.toContain('Next:');
  });

  it('follows the card\'s Last/Next rules: a finished game shows Next, not Last', () => {
    const vm = sportsVm(1, { state: 'post', line: 'W 6-2 vs OPP', lastLine: 'W 6-2 vs OPP', nextLine: 'Fri vs OPP 1' });
    const { card } = board('sports', renderSports, vm, { size: [4, 3] });
    card.click();
    expect(text()).toContain('Next: Fri vs OPP 1');
    expect(text()).not.toContain('Last:');
    expect(overlay().querySelector('.team__livedot')).toBeNull();
  });

  it('falls back to the abbreviation when a team has no logo', () => {
    const { card } = board('sports', renderSports, sportsVm(1, { logo: null }), { size: [4, 3] });
    card.click();
    expect(overlay().querySelector('.team__logo')).toBeNull();
    expect(overlay().querySelector('.team__abbr').textContent).toBe('T1');
  });

  it('opens on a single team without collapsing (the degenerate column)', () => {
    const { card } = board('sports', renderSports, sportsVm(1), { size: [4, 3] });
    card.click();
    expect(overlay().querySelectorAll('.team--board').length).toBe(1);
    expect(overlay().querySelector('.team-board')).not.toBeNull(); // still the centered board, not a bare row
  });

  it('caps at the six teams the config allows', () => {
    // Nothing can hand it seven today (DEFAULT_CONFIG.sports is capped), but
    // the view must not overrun its canvas if something ever does.
    const { card } = board('sports', renderSports, sportsVm(9), { size: [4, 8] });
    card.click();
    expect(BOARD_TEAMS).toBe(6);
    expect(overlay().querySelectorAll('.team--board').length).toBe(6);
    expect(text()).toContain('Team 6');
    expect(text()).not.toContain('Team 7');
  });

  it('clears the registration AND the badge when the teams go away', () => {
    // The latent over-promise: the empty path used to return early, leaving
    // the previous render's "+N" in the corner of a "pick your teams" card.
    const { card, render } = board('sports', renderSports, sportsVm(5), { size: [4, 3] });
    expect(card.querySelector('.card__more').textContent).toBe('+2');
    render({ rows: [] });
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.dataset.more).toBeUndefined();
    expect(card.classList.contains('is-expandable')).toBe(false);
    expect(card.querySelector('[data-setup="sports"]')).not.toBeNull(); // the prompt owns the tap now
    card.click();
    expect(isExpandOpen()).toBe(false);
  });

  it('keeps the snapshot when the card re-renders underneath it', () => {
    const { card, render } = board('sports', renderSports, sportsVm(3), { size: [4, 3] });
    card.click();
    const before = overlay().innerHTML;
    render(sportsVm(1));
    expect(overlay().innerHTML).toBe(before);
  });
});

/* ============================== GOLF ============================== */

const player = (i) => ({
  pos: i,
  name: `P. Layer ${i}`,
  flag: 'https://a.espncdn.com/i/teamlogos/countries/500/usa.png',
  score: i <= 3 ? `-${11 - i}` : `+${i}`,
  today: i % 2 ? '-2' : '+1',
});
const golfVm = (n, over = {}) => ({
  name: 'The Open',
  round: '3',
  state: 'in',
  startsAt: null,
  players: Array.from({ length: n }, (_, i) => player(i + 1)),
  ...over,
});

describe('Golf: the two-column leaderboard', () => {
  it('registers unconditionally and carries event + round in the small text', () => {
    const { card } = board('golf', renderGolf, golfVm(4), { size: [3, 8] });
    expect(card.querySelector('.card__more')).toBeNull(); // a 3x8 holds twenty rows
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.click();
    expect(overlay().querySelector('.expand__title').textContent).toBe('Golf');
    expect(overlay().querySelector('.expand__note').textContent).toBe('The Open · Rd 3');
  });

  it('renders the card\'s four fields per row: pos, player, today, total', () => {
    const { card } = board('golf', renderGolf, golfVm(3), { size: [3, 4] });
    card.click();
    const row = overlay().querySelector('.golf-board__row');
    expect(row.querySelector('.golf-row__pos').textContent).toBe('1');
    expect(row.querySelector('.golf-row__name').textContent).toBe('P. Layer 1');
    expect(row.querySelector('.golf-row__today').textContent).toBe('-2');
    const score = row.querySelector('.golf-row__score');
    expect(score.textContent).toBe('-10');
    expect(score.classList.contains('golf-row__score--under')).toBe(true);
    // Flags stay on the card: two dozen of them turn a leaderboard into bunting.
    expect(overlay().querySelector('.golf-row__flag')).toBeNull();
  });

  it('stays one column while the field fits it, and balances beyond', () => {
    const { card, render } = board('golf', renderGolf, golfVm(BOARD_ROWS), { size: [3, 4] });
    card.click();
    let b = overlay().querySelector('.golf-board');
    expect(b.classList.contains('golf-board--split')).toBe(false);
    expect(b.style.getPropertyValue('--board-rows')).toBe(String(BOARD_ROWS));
    closeExpand();
    render(golfVm(BOARD_ROWS + 1));
    card.click();
    b = overlay().querySelector('.golf-board');
    expect(b.classList.contains('golf-board--split')).toBe(true);
    // 13 balance as 7 + 6, the left column the fuller of the two.
    expect(b.style.getPropertyValue('--board-rows')).toBe('7');
  });

  it('caps the field at two full columns', () => {
    const { card } = board('golf', renderGolf, golfVm(70), { size: [3, 8] });
    card.click();
    expect(BOARD_PLAYERS).toBe(BOARD_ROWS * 2);
    expect(overlay().querySelectorAll('.golf-board__row').length).toBe(BOARD_PLAYERS);
    expect(overlay().querySelector('.golf-board').style.getPropertyValue('--board-rows')).toBe(String(BOARD_ROWS));
  });

  it('an off week arrives with nothing to open: the card goes inert', () => {
    // Degenerate case, stated: between tournaments mapGolf returns an empty
    // players list, the card shows its quiet sentence, and NOTHING opens — a
    // tap has no leaderboard to show, so the card refuses rather than raising
    // an empty canvas. The count in the corner goes with it.
    const { card, render } = board('golf', renderGolf, golfVm(9), { size: [3, 3] });
    expect(card.querySelector('.card__more')).not.toBeNull();
    render(golfVm(0, { name: 'Travelers', round: null, state: 'pre', startsAt: Date.parse('2026-08-06T06:00Z') }));
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.dataset.more).toBeUndefined();
    expect(card.classList.contains('is-expandable')).toBe(false);
    expect(card.querySelector('.empty').textContent).toContain('Travelers');
    card.click();
    expect(isExpandOpen()).toBe(false);
  });

  it('a feed with no event at all is equally inert', () => {
    const { card } = board('golf', renderGolf, { name: null, state: 'none', round: null, players: [] }, { size: [3, 3] });
    expect(card.querySelector('.empty').textContent).toBe('No tournament this week');
    card.click();
    expect(isExpandOpen()).toBe(false);
  });
});

/* ============================= TENNIS ============================= */

const match = (i, over = {}) => ({
  id: `m${i}`,
  tour: 'ATP',
  state: 'post',
  t: 1000 + i,
  round: 'Quarterfinal',
  a: `A. Player ${i}`,
  b: `B. Player ${i}`,
  aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/esp.png',
  bFlag: null,
  sets: '6-4 6-2',
  winner: 'a',
  detail: 'Final',
  ...over,
});
const tennisVm = (n, over = {}) => ({
  name: 'Wimbledon',
  rows: Array.from({ length: n }, (_, i) => match(i + 1)),
  ...over,
});

describe('Tennis: the one-line ledger rows', () => {
  it('registers unconditionally and carries tournament + day in the small text', () => {
    const { card } = board('tennis', renderTennis, tennisVm(3), { size: [3, 8] });
    expect(card.querySelector('.card__more')).toBeNull(); // a 3x8 holds seventeen
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.click();
    expect(overlay().querySelector('.expand__title').textContent).toBe('Tennis');
    // Derived from the widget's own formatter: CI runs UTC.
    expect(overlay().querySelector('.expand__note').textContent).toBe(`Wimbledon · ${boardDay()}`);
  });

  it('names the day alone when no tournament is named', () => {
    const { card } = board('tennis', renderTennis, tennisVm(2, { name: null }), { size: [3, 4] });
    card.click();
    expect(overlay().querySelector('.expand__note').textContent).toBe(boardDay());
  });

  it('lines up round chip, matchup and score, winner-first when the match is done', () => {
    const { card } = board('tennis', renderTennis, tennisVm(1, { rows: [match(1, { round: 'Round of 16' })] }), { size: [3, 4] });
    card.click();
    const row = overlay().querySelector('.tennis-board__row');
    expect(row.querySelector('.tennis-board__round').textContent).toBe('R16');
    expect(row.querySelector('.tennis-board__match b').textContent).toBe('A. Player 1'); // the winner carries the weight
    expect(row.querySelector('.tennis-board__match').textContent).toContain('d.');
    expect(row.querySelector('.tennis-board__match img')).not.toBeNull(); // flags survive
    expect(row.querySelector('.tennis-board__score').textContent).toBe('6-4, 6-2');
    expect(row.querySelector('.tennis-row__live')).toBeNull();
  });

  it('compresses every feed-real round name and never guesses at one it does not know', () => {
    expect(roundAbbrev('Round of 16')).toBe('R16'); // slam draw sheets
    expect(roundAbbrev('Round 3')).toBe('R3'); // regular tour weeks
    expect(roundAbbrev('Quarterfinal')).toBe('QF');
    expect(roundAbbrev('Semifinals')).toBe('SF');
    expect(roundAbbrev('Final')).toBe('F');
    expect(roundAbbrev('Qualifying 2nd Round')).toBe('Qual');
    expect(roundAbbrev('Group Stage')).toBe('');
    expect(roundAbbrev(undefined)).toBe(''); // a feed row with no round at all
  });

  it('puts the live dot on the matchup line and the running score beneath', () => {
    const { card } = board('tennis', renderTennis, tennisVm(1, { rows: [match(1, { state: 'in', winner: null, sets: '6-4 3-2' })] }), { size: [3, 4] });
    card.click();
    const row = overlay().querySelector('.tennis-board__row');
    expect(row.classList.contains('tennis-row--live')).toBe(true);
    expect(row.querySelector('.tennis-board__match .tennis-row__live')).not.toBeNull();
    expect(row.querySelector('.tennis-board__match').textContent).toContain('vs');
    expect(row.querySelector('.tennis-board__score').textContent).toBe('6-4, 3-2');
  });

  it('shows the schedule line for a match that has not started', () => {
    const { card } = board('tennis', renderTennis, tennisVm(1, { rows: [match(1, { state: 'pre', winner: null, sets: '', detail: '9:00 AM' })] }), { size: [3, 4] });
    card.click();
    expect(overlay().querySelector('.tennis-board__score').textContent).toBe('9:00 AM');
    expect(overlay().querySelector('.tennis-board__match').textContent).toContain('vs');
  });

  it('falls back to the detail line for a walkover (finished, no sets)', () => {
    const { card } = board('tennis', renderTennis, tennisVm(1, { rows: [match(1, { sets: '', detail: 'Walkover' })] }), { size: [3, 4] });
    card.click();
    expect(overlay().querySelector('.tennis-board__score').textContent).toBe('Walkover');
  });

  it('keeps a short board to one column', () => {
    const { card } = board('tennis', renderTennis, tennisVm(9), { size: [3, 4] });
    card.click();
    const grid = overlay().querySelector('.tennis-board');
    expect(grid.classList.contains('tennis-board--split')).toBe(false);
    expect(grid.getAttribute('style')).toContain('--board-rows:9');
  });

  it('deals a deep board into two balanced columns and caps at twenty-six', () => {
    const { card } = board('tennis', renderTennis, tennisVm(30), { size: [3, 8] });
    card.click();
    expect(BOARD_MATCHES).toBe(26);
    const grid = overlay().querySelector('.tennis-board');
    expect(grid.classList.contains('tennis-board--split')).toBe(true);
    expect(grid.getAttribute('style')).toContain(`--board-rows:${TENNIS_BOARD_ROWS}`);
    expect(overlay().querySelectorAll('.tennis-board__row').length).toBe(26);
  });

  it('clears the registration AND the badge between tournaments', () => {
    const { card, render } = board('tennis', renderTennis, tennisVm(9), { size: [3, 3] });
    expect(card.querySelector('.card__more').textContent).toBe('+4');
    render({ name: null, rows: [] });
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.dataset.more).toBeUndefined();
    expect(card.classList.contains('is-expandable')).toBe(false);
    card.click();
    expect(isExpandOpen()).toBe(false);
  });
});

/* =========================== EXPRESS BUS =========================== */

describe('busMin: minutes derived at render, not at fetch', () => {
  it('counts down from the absolute arrival instant', () => {
    expect(busMin({ dest: 'A', at: 1600, min: 99, distance: '' }, 1000)).toBe(10);
    expect(busMin({ dest: 'A', at: 1600, min: 99, distance: '' }, 1300)).toBe(5);
  });

  it('never counts below one, however late the bus is', () => {
    expect(busMin({ at: 1030, min: null }, 1000)).toBe(1);
    expect(busMin({ at: 400, min: null }, 1000)).toBe(1); // already due
  });

  it('falls back to the stored minutes for a vm cached before `at` existed', () => {
    // Site and worker deploy independently and the vm cache outlives a deploy;
    // one refresh cycle later every entry carries `at`.
    expect(busMin({ dest: 'A', min: 7, distance: '' }, 1_000_000)).toBe(7);
  });

  it('is null for a distance-only row (no prediction either way)', () => {
    expect(busMin({ dest: 'A', at: null, min: null, distance: '2 stops away' }, 1000)).toBeNull();
    expect(busMin(null, 1000)).toBeNull();
  });

  it('mapBus carries the instant through beside the fetch-time minutes', () => {
    const vm = mapBus({ stops: [{ id: '1', name: 'X', arrivals: [
      { route: 'M4', dest: 'A', time: 1600, distance: '' },
      { route: 'M4', dest: 'B', time: null, distance: 'approaching' },
    ] }] }, 1000);
    expect(vm.stops[0].arrivals[0]).toMatchObject({ at: 1600, min: 10 });
    expect(vm.stops[0].arrivals[1]).toMatchObject({ at: null, min: null, distance: 'approaching' });
  });
});

const busStop = (i, arrivals) => ({ id: `55078${i}`, route: `QM${i}`, name: `Stop ${i} Av / E 34 St`, arrivals });
const busArr = (dest, at) => ({ dest, at, min: null, distance: '' });
const busVm = (stops) => ({ configured: true, stops });

describe('Express Bus: the stop-grouped board', () => {
  let now = 1_700_000_000;
  beforeEach(() => {
    now = 1_700_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now * 1000);
  });
  afterEach(() => vi.restoreAllMocks());

  const twoStops = () => busVm([
    busStop(1, [busArr('Wall St', now + 600), busArr('Wall St', now + 1500)]),
    busStop(2, [busArr('Midtown', now + 900)]),
  ]);

  it('registers unconditionally — a card showing every arrival still opens', () => {
    const { card } = board('bus', renderBus, twoStops(), { size: [4, 8] });
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelector('.expand__title').textContent).toBe('Express Bus');
  });

  it('groups by stop: a quiet stop header over route + destination rows', () => {
    const { card } = board('bus', renderBus, twoStops(), { size: [4, 8] });
    card.click();
    const groups = overlay().querySelectorAll('.bus-board__group');
    expect(groups.length).toBe(2);
    expect(groups[0].querySelector('.bus-board__stop').textContent).toBe('Stop 1 Av / E 34 St');
    const rows = groups[0].querySelectorAll('.train');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.train__min span').textContent).toBe('10');
    expect(rows[0].querySelector('.train__min small').textContent).toBe('min');
    expect(rows[0].querySelector('.train__dest').textContent).toBe('QM1'); // route takes the prominent slot
    expect(rows[0].querySelector('.train__line').textContent).toBe('to Wall St');
    expect(groups[1].querySelectorAll('.train').length).toBe(1);
  });

  it('shows every arrival the card had to cap away', () => {
    // A 4x3 card has five rows: stop 1 spends a header + 3, stop 2 gets one
    // more row than a header needs and is dropped whole.
    const vm = busVm([
      busStop(1, [busArr('A', now + 300), busArr('B', now + 600), busArr('C', now + 900)]),
      busStop(2, [busArr('D', now + 1200)]),
    ]);
    const { card } = board('bus', renderBus, vm, { size: [4, 3] });
    const onCard = card.querySelectorAll('.train').length;
    card.click();
    expect(overlay().querySelectorAll('.train').length).toBe(4);
    expect(overlay().querySelectorAll('.train').length).toBeGreaterThan(onCard);
    expect(text()).toContain('to D');
  });

  it('counts down from the moment the view OPENS, not the moment it was fetched', () => {
    // The whole reason `at` is plumbed through. The vm is five minutes old by
    // the time the finger lands; a frozen `min` would still read 10.
    const { card } = board('bus', renderBus, twoStops(), { size: [4, 8] });
    expect(card.querySelector('.train__min span').textContent).toBe('10');
    now += 300;
    card.click();
    expect(overlay().querySelector('.train__min span').textContent).toBe('5');
  });

  it('re-renders the CARD off the same derivation', () => {
    const { card, render } = board('bus', renderBus, twoStops(), { size: [4, 8] });
    const vm = twoStops();
    expect(card.querySelector('.train__min span').textContent).toBe('10');
    now += 480;
    render(vm); // the same view-model, eight minutes later
    expect(card.querySelector('.train__min span').textContent).toBe('2');
  });

  it('keeps Bus Time\'s own words when it has no prediction', () => {
    const vm = busVm([busStop(1, [{ dest: 'Wall St', at: null, min: null, distance: 'approaching' }])]);
    const { card } = board('bus', renderBus, vm, { size: [4, 8] });
    card.click();
    expect(overlay().querySelector('.train__min span')).toBeNull();
    expect(overlay().querySelector('.train__dist').textContent).toBe('approaching');
  });

  it('says so when a stop has nothing en route', () => {
    const vm = busVm([busStop(1, [busArr('Wall St', now + 600)]), busStop(2, [])]);
    const { card } = board('bus', renderBus, vm, { size: [4, 8] });
    card.click();
    expect(overlay().querySelectorAll('.bus-board__group').length).toBe(2);
    expect(overlay().querySelector('.bus-board__none').textContent).toBe('No buses en route');
  });

  it('names a stop by its id when the leg carries no name', () => {
    const vm = busVm([{ id: '404123', route: 'QM1', name: '', arrivals: [busArr('Wall St', now + 600)] }]);
    const { card } = board('bus', renderBus, vm, { size: [4, 8] });
    card.click();
    expect(overlay().querySelector('.bus-board__stop').textContent).toBe('Stop 404123');
  });

  it('clears the registration AND the badge when the routes go away', () => {
    const vm = busVm([
      busStop(1, [busArr('A', now + 300), busArr('B', now + 600), busArr('C', now + 900)]),
      busStop(2, [busArr('D', now + 1200)]),
    ]);
    const { card, render } = board('bus', renderBus, vm, { size: [4, 2] });
    expect(card.dataset.more).toBe('1'); // a 4x2 fits one stop only
    render(busVm([]));
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.dataset.more).toBeUndefined();
    expect(card.classList.contains('is-expandable')).toBe(false);
    expect(card.querySelector('[data-setup="bus"]')).not.toBeNull();
    card.click();
    expect(isExpandOpen()).toBe(false);
  });

  it('clears both when the server has no Bus Time key', () => {
    const vm = busVm([busStop(1, [busArr('A', now + 300)])]);
    const { card, render } = board('bus', renderBus, vm, { size: [4, 8] });
    expect(card.classList.contains('is-expandable')).toBe(true);
    render({ configured: false, stops: [] });
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(false);
    card.click();
    expect(isExpandOpen()).toBe(false);
  });

  it('keeps the snapshot when the card re-renders underneath it', () => {
    const { card, render } = board('bus', renderBus, twoStops(), { size: [4, 8] });
    card.click();
    const before = overlay().innerHTML;
    render(busVm([busStop(9, [busArr('Somewhere else', now + 60)])]));
    expect(overlay().innerHTML).toBe(before);
  });
});
