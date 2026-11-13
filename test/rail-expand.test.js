/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { closeExpand, isExpandOpen, openExpand } from '../site/js/expand.js';
// Namespaces, so the scaffold can mount each widget's REAL card off its own
// meta instead of a placeholder title.
import * as lirr from '../site/js/widgets/lirr.js';
import * as mnr from '../site/js/widgets/mnr.js';
import * as njt from '../site/js/widgets/njt.js';
import * as ferry from '../site/js/widgets/ferry.js';
import * as amtrak from '../site/js/widgets/amtrak.js';
import { board as mountBoard } from './helpers/board.js';

const { render: renderLirr } = lirr;
const { render: renderMnr } = mnr;
const { render: renderNjt } = njt;
const { render: renderFerry } = ferry;
const MODS = { lirr, mnr, njt, ferry };

const overlay = () => document.querySelector('#expand-view');

// A one-card board with the delegated expand listener wired, as main.js does.
// Rail capacity at 3x2 is two rows (RAIL_ROWS), so five departures hide three.
const railBoard = (widget, renderFn, vm, cfg = {}, [w, h] = [3, 2]) =>
  mountBoard(MODS[widget], { rect: { w, h }, vm, cfg, render: renderFn });

const lirrDep = (i) => ({
  t: 1000 + i * 600, min: 10 + i * 10, dest: `Stop ${i}`, destId: String(i),
  branch: 'Babylon', routeId: '1', trainNum: String(100 + i),
  track: i === 0 ? '18' : null, origin: 'penn',
});
const lirrVm = (n) => ({ departures: Array.from({ length: n }, (_, i) => lirrDep(i)), destName: 'Rockville Centre' });

beforeEach(() => {
  closeExpand();
  document.body.innerHTML = '';
});

describe('rail +N badge and whole-card expand', () => {
  it('shows the quiet "+N" badge when departures overflow: no well, no reserve', () => {
    // Sean 07-31: the tappable pill's reserve cost a visible row, so the
    // trigger is the whole card (the markets grammar) and the badge went back
    // to the quiet corner text. 08-01: that text became the one board-wide
    // form. 08-02: the expand glyph beside it went too, leaving the count.
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    const badge = card.querySelector('.card__more');
    expect(badge).not.toBeNull();
    expect(badge.classList.contains('card__more--pill')).toBe(false);
    expect(badge.textContent).toBe('+3');
    expect(badge.querySelector('svg')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(true);
    expect(card.classList.contains('is-expandable-pill')).toBe(false);
  });

  it('opens from anywhere on the card, like markets', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
  });

  it('expands to every departure the card knows, in the standard rows', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    expect(card.querySelectorAll('.train').length).toBe(2); // capped card
    card.querySelector('.card__more').click();
    expect(overlay().querySelectorAll('.train').length).toBe(5);
    expect(overlay().querySelector('.expand__title').textContent).toBe('LIRR');
    expect(overlay().querySelector('.expand__note').textContent).toBe('stops at Rockville Centre');
    expect(overlay().textContent).toContain('Track 18'); // tracks carried through
    expect(overlay().querySelector('.trains--board')).not.toBeNull();
  });

  it('scales the board to its content: one grand column up to six trains', () => {
    // Sean 07-31: six small rows huddled on a 1920px canvas read as a bug.
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    card.querySelector('.card__more').click();
    const board = overlay().querySelector('.trains--board');
    expect(board.classList.contains('trains--board--grand')).toBe(true);
    expect(board.classList.contains('trains--board--split')).toBe(false);
  });

  it('splits into two balanced columns beyond six trains', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(9));
    card.querySelector('.card__more').click();
    const board = overlay().querySelector('.trains--board');
    expect(board.classList.contains('trains--board--split')).toBe(true);
    // 9 trains balance as 5 + 4, not 6 + 3.
    expect(board.style.getPropertyValue('--board-rows')).toBe('5');
  });

  // Every card opens when tapped (Sean, 2026-11-13): a card that fits all its
  // trains still opens the board at reading size. Only the badge tracks hidden.
  it('still opens the board when everything fits: no badge, every train', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(2));
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.querySelectorAll('.train').length).toBe(2); // the card shows them all
    expect(card.classList.contains('is-expandable')).toBe(true);
    expect(card.getAttribute('role')).toBe('button');
    expect(card.classList.contains('is-expandable-pill')).toBe(false);
    card.click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelectorAll('.train').length).toBe(2);
    expect(overlay().querySelector('.trains--board--grand')).not.toBeNull();
  });

  it('opens a lone departure as the grand column too', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(1));
    card.click();
    expect(overlay().querySelectorAll('.train').length).toBe(1);
    expect(overlay().querySelector('.trains--board--grand')).not.toBeNull();
  });

  it('stays inert with no departures, and on the station prompt', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    renderLirr(card.querySelector('.card__body'), lirrVm(0), {});
    expect(card.textContent).toContain('No departures');
    expect(card.classList.contains('is-expandable')).toBe(false);
    expect(card.hasAttribute('tabindex')).toBe(false);
    card.click();
    expect(isExpandOpen()).toBe(false);

    renderLirr(card.querySelector('.card__body'), { needsStation: true }, {});
    expect(card.classList.contains('is-expandable')).toBe(false);
    card.click();
    expect(isExpandOpen()).toBe(false);
  });

  it('alert banners no longer pre-charge a train row (the fit and the badge absorb them)', () => {
    // A 3x2 card promises 2 rows. The old pre-deduction charged each banner a
    // row BEFORE measuring (a 72px banner charged as a 61px row under-filled
    // the card); now the full promise renders and fitTrainRows sheds what
    // genuinely does not fit into the badge count.
    const vm = { ...lirrVm(5), alerts: [{ routes: [], stops: [], header: 'Delays.' }] };
    const { card } = railBoard('lirr', renderLirr, vm);
    expect(card.querySelectorAll('.train').length).toBe(2);
    expect(card.querySelector('.card__more').textContent).toBe('+3');
  });

  it('never reserves space for the badge: the row count matches capacity exactly', () => {
    // The whole point of retiring the pill: a 3x2 card promises 2 rows and
    // draws 2 rows even while the badge is up.
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    expect(card.querySelectorAll('.train').length).toBe(2);
    expect(card.querySelector('.trains').style.paddingBottom).toBe('');
  });

  it('a three-digit countdown widens the whole card\'s min column so rows stay aligned', () => {
    // Three tabular digits need ~95px against the 76px exact two-digit fit,
    // so the card carrying one pays a wider column while it is on the board —
    // and only then. (Same mechanism the 99+ cap era used for the plus.)
    const vm = lirrVm(2);
    vm.departures[1].min = 120;
    const { card } = railBoard('lirr', renderLirr, vm);
    expect(card.querySelectorAll('.train__min span')[1].textContent).toBe('120');
    expect(card.querySelector('.trains').classList.contains('trains--widemin')).toBe(true);
    renderLirr(card.querySelector('.card__body'), lirrVm(2), {});
    expect(card.querySelector('.trains').classList.contains('trains--widemin')).toBe(false);
  });

  it('drops only the badge when a refresh leaves nothing hidden: the board stays', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    expect(card.querySelector('.card__more')).not.toBeNull();
    renderLirr(card.querySelector('.card__body'), lirrVm(2), {});
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(true);
    expect(card.classList.contains('is-expandable-pill')).toBe(false);
    card.click();
    expect(overlay().querySelectorAll('.train').length).toBe(2);
  });

  it('tapping an alert banner reads that alert full screen, not the schedule', () => {
    const vm = { ...lirrVm(5), alerts: [
      { routes: [], stops: [], header: 'First alert header.', body: 'The long detail of the first alert.' },
      { routes: [], stops: [], header: 'Second alert header.', body: '' },
    ] };
    const { card } = railBoard('lirr', renderLirr, vm);
    card.querySelectorAll('.talert')[0].click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelector('.expand__note').textContent).toBe('service alert');
    expect(overlay().textContent).toContain('First alert header.');
    expect(overlay().textContent).toContain('The long detail of the first alert.');
    expect(overlay().querySelector('.train')).toBeNull();
    closeExpand();
    // The second banner reads the second alert.
    card.querySelectorAll('.talert')[1].click();
    expect(overlay().textContent).toContain('Second alert header.');
    expect(overlay().textContent).not.toContain('First alert header.');
  });

  it('tapping outside the banner still opens the schedule', () => {
    const vm = { ...lirrVm(5), alerts: [{ routes: [], stops: [], header: 'Alert here.', body: '' }] };
    const { card } = railBoard('lirr', renderLirr, vm);
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.train').length).toBe(5);
  });

  it('keeps the banner/board split when no departures overflow', () => {
    // No +N now, but the card still opens: the banner reads its alert, every
    // other tap opens the board.
    const vm = { ...lirrVm(2), alerts: [{ routes: [], stops: [], header: 'Alert on a quiet card.', body: 'Detail.' }] };
    const { card } = railBoard('lirr', renderLirr, vm);
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.talert').click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().textContent).toContain('Alert on a quiet card.');
    expect(overlay().querySelector('.train')).toBeNull();
    closeExpand();
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.train').length).toBe(2);
    expect(overlay().querySelector('.alert-view')).toBeNull();
  });

  it('a banner on a card with no departures still reads, while the rest of the card stays inert', () => {
    const vm = { ...lirrVm(0), alerts: [{ routes: [], stops: [], header: 'Service suspended.', body: 'Detail.' }] };
    const { card } = railBoard('lirr', renderLirr, vm);
    expect(card.classList.contains('is-expandable')).toBe(false);
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(false);
    card.querySelector('.talert').click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().textContent).toContain('Service suspended.');
  });

  it('keeps the snapshot when the source card re-renders underneath it', () => {
    const { card } = railBoard('lirr', renderLirr, lirrVm(5));
    card.querySelector('.card__more').click();
    const before = overlay().innerHTML;
    expect(overlay().textContent).toContain('Stop 4');
    renderLirr(card.querySelector('.card__body'), lirrVm(3), {});
    expect(overlay().innerHTML).toBe(before);
  });
});

describe('rail +N on the other boards', () => {
  const njtVm = (n) => ({
    trains: Array.from({ length: n }, (_, i) => ({
      time: 1000 + i * 600, min: 10 + i * 10, dest: `Dest ${i}`, line: 'NEC',
      track: null, status: '',
    })),
    alerts: [{ header: 'Track work this weekend.' }],
  });

  it('NJT: alert banners stay on the card, never in the overlay', () => {
    // Banners are not pre-charged a row (the measured fit sheds instead), so
    // the 3x2 promise of 2 rows holds and three of five trains hide.
    const { card } = railBoard('njt', renderNjt, njtVm(5));
    expect(card.querySelector('.card__more').textContent).toBe('+3');
    card.querySelector('.card__more').click();
    expect(overlay().querySelectorAll('.train').length).toBe(5);
    expect(overlay().querySelector('.talert')).toBeNull();
  });

  it('Metro-North: badge and full board', () => {
    const vm = { departures: Array.from({ length: 5 }, (_, i) => ({
      t: 1000 + i * 600, min: 10 + i * 10, dest: `Stop ${i}`, destId: String(i),
      branch: 'Harlem', routeId: '2', track: null,
    })), destName: 'Southeast' };
    const { card } = railBoard('mnr', renderMnr, vm);
    expect(card.querySelector('.card__more').textContent).toBe('+3');
    card.querySelector('.card__more').click();
    expect(overlay().querySelectorAll('.train').length).toBe(5);
    expect(overlay().querySelector('.expand__title').textContent).toBe('Metro-North');
  });

  // One wiring, five boards: each one that fits every train still opens it,
  // and each one with no departures stays inert.
  const amtrakVm = (n) => ({
    updatedAt: 1000,
    departures: Array.from({ length: n }, (_, i) => ({
      t: Math.floor(Date.now() / 1000) + 600 * (i + 1), dest: `Station ${i}`, route: 'Northeast Regional',
      num: String(170 + i), platform: null, status: '', stops: [],
    })),
  });
  const mnrVm = (n) => ({ departures: Array.from({ length: n }, (_, i) => ({
    t: 1000 + i * 600, min: 10 + i * 10, dest: `Stop ${i}`, destId: String(i),
    branch: 'Harlem', routeId: '2', track: null,
  })), destName: 'Southeast' });
  const ferryVm = (n) => ({ landingName: 'Wall St/Pier 11', departures: Array.from({ length: n }, (_, i) => ({
    t: 1000 + i * 600, min: 10 + i * 10, dest: `Landing ${i}`, route: null,
  })) });
  const BOARDS = [
    ['lirr', lirr, lirrVm, 'LIRR'],
    ['njt', njt, (n) => ({ ...njtVm(n), alerts: [] }), 'NJ Transit'],
    ['mnr', mnr, mnrVm, 'Metro-North'],
    ['amtrak', amtrak, amtrakVm, 'Amtrak'],
    ['ferry', ferry, ferryVm, 'NYC Ferry'],
  ];
  for (const [id, mod, vmOf, title] of BOARDS) {
    it(`${id}: a card that fits every train still opens the board with all of them`, () => {
      const { card } = mountBoard(mod, { rect: { w: 3, h: 2 }, vm: vmOf(2), cfg: {} });
      expect(card.querySelector('.card__more')).toBeNull();
      expect(card.querySelectorAll('.train').length).toBe(2);
      expect(card.classList.contains('is-expandable')).toBe(true);
      card.querySelector('.card__body').click();
      expect(isExpandOpen()).toBe(true);
      expect(overlay().querySelectorAll('.train').length).toBe(2);
      expect(overlay().querySelector('.expand__title').textContent).toBe(title);
    });

    it(`${id}: a card with no departures stays inert`, () => {
      const { card } = mountBoard(mod, { rect: { w: 3, h: 2 }, vm: vmOf(0), cfg: {} });
      expect(card.textContent).toContain('No departures');
      expect(card.classList.contains('is-expandable')).toBe(false);
      card.querySelector('.card__body').click();
      expect(isExpandOpen()).toBe(false);
    });
  }

  it('Ferry: badge and full board', () => {
    const vm = { landingName: 'Wall St/Pier 11', departures: Array.from({ length: 5 }, (_, i) => ({
      t: 1000 + i * 600, min: 10 + i * 10, dest: `Landing ${i}`, route: null,
    })) };
    const { card } = railBoard('ferry', renderFerry, vm);
    expect(card.querySelector('.card__more').textContent).toBe('+3');
    card.querySelector('.card__more').click();
    expect(overlay().querySelectorAll('.train').length).toBe(5);
  });
});
