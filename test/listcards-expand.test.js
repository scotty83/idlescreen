/**
 * @vitest-environment happy-dom
 */
// Tap-to-expand for the four remaining count cards: Cloud Services, TfL Status,
// World Clock and Citi Bike. Every count card wears the "+N" corner badge, and
// these four earned their taps back when the badge still carried an expand
// glyph that promised a destination they did not have. The glyph is gone
// (2026-08-02); the destinations it forced are the lasting part.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { closeExpand, isExpandOpen } from '../site/js/expand.js';
import { closeTextViewer, defersToExpand } from '../site/js/textviewer.js';
import { ledgerColumns, ledgerBody } from '../site/js/ledger.js';
// Namespaces, so the scaffold can mount each widget's REAL card off its own
// meta instead of labelling it with the bare widget id.
import * as services from '../site/js/widgets/services.js';
import * as tfl from '../site/js/widgets/tfl.js';
import * as worldclock from '../site/js/widgets/worldclock.js';
import * as citibike from '../site/js/widgets/citibike.js';
import { board as mountBoard } from './helpers/board.js';

const { render: renderServices, serviceItems, serviceNotes } = services;
const { render: renderTfl, tflItems } = tfl;
const { render: renderWorldclock, worldTimes, fitWorldFace, startWorldFaceRepaint } = worldclock;
const { render: renderCitibike, bikeWells } = citibike;
const MODS = { services, tfl, worldclock, citibike };

const overlay = () => document.querySelector('#expand-view');
const reader = () => document.querySelector('#text-viewer');
const readerOpen = () => reader()?.hidden === false;

// A one-card board with BOTH delegated listeners wired, exactly as main.js does
// — the deferral only means anything when the reader and the expand engine are
// both listening on the same grid.
const board = (widget, renderFn, vm, cfg = {}, [w, h] = [3, 3]) =>
  mountBoard(MODS[widget], { rect: { w, h }, vm, cfg, render: renderFn, textviewer: true });

const svc = (id, state, extra = {}) => ({
  id, label: id.toUpperCase(), state, note: `${id} note`, incidents: [], ...extra,
});
const servicesVm = (list) => ({ updatedAt: 1783000000, services: list });

const tflLine = (id, ok, extra = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), mode: 'Tube', ok,
  status: ok ? 'Good Service' : 'Severe Delays', reason: ok ? '' : `${id} is a mess`, ...extra,
});
const tflCfg = (ids) => ({ tfl: { lines: ids } });

const station = (id, name, live) => ({ id, name, live });
const citibikeVm = (stations) => ({
  updatedAt: 1783000000,
  stations: stations.filter((s) => s.live).map((s) => ({ id: s.id, ...s.live })),
});
const citibikeCfg = (stations) => ({
  citibike: { stations: stations.map((s) => ({ id: s.id, name: s.name })) },
});

const CITIES = [
  { label: 'London', zone: 'Europe/London' },
  { label: 'Tokyo', zone: 'Asia/Tokyo' },
  { label: 'Sydney', zone: 'Australia/Sydney' },
  { label: 'Berlin', zone: 'Europe/Berlin' },
  { label: 'Mumbai', zone: 'Asia/Kolkata' },
];
const wcCfg = (cities) => ({ worldclock: { cities } });
const wcVm = (cities) => worldTimes(new Date(), cities, false);

beforeEach(() => {
  closeExpand();
  closeTextViewer();
  document.querySelector('#text-viewer')?.remove();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------- the ledger

describe('the shared ledger', () => {
  it('deals the quiet group into two balanced columns, filled down the first', () => {
    // Subway's rule: seven split 4 + 3, never 6 + 1.
    expect(ledgerColumns([1, 2, 3, 4, 5, 6, 7]).map((c) => c.length)).toEqual([4, 3]);
    expect(ledgerColumns([1, 2, 3, 4]).map((c) => c.length)).toEqual([2, 2]);
    expect(ledgerColumns([1, 2, 3, 4])[0]).toEqual([1, 2]); // down the first, then the second
  });

  it('gives a lone quiet row one column rather than a lonely pair', () => {
    expect(ledgerColumns(['only'])).toEqual([['only']]);
    expect(ledgerColumns([])).toEqual([]);
  });

  it('renders only the groups that have rows', () => {
    const allQuiet = ledgerBody([{ name: 'A', state: 'Operational', alert: false }]);
    expect(allQuiet).not.toContain('ledger__lead');
    expect(allQuiet).toContain('ledger__quiet');
    const allLoud = ledgerBody([{ name: 'A', state: 'Major outage', alert: true }]);
    expect(allLoud).toContain('ledger__lead');
    expect(allLoud).not.toContain('ledger__quiet');
  });

  it('escapes every value it is handed', () => {
    const html = ledgerBody([{
      name: '<script>x</script>', state: '"bad"', alert: true, tone: 'major',
      dot: '#fff" onload="x', notes: [{ text: '<b>no</b>', meta: '&', more: "'" }],
    }]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>no</b>');
    expect(html).not.toContain('onload="x"');
  });
});

// -------------------------------------------------------------- cloud services

describe('Cloud Services expand', () => {
  const seven = [
    svc('down', 'major', { note: 'Everything is on fire', incidents: [
      { title: 'API errors', since: '2026-07-11T14:12:00.000Z', update: 'Still investigating.' },
    ] }),
    svc('slow', 'minor'), svc('dark', 'unknown'),
    svc('a', 'ok'), svc('b', 'ok'), svc('c', 'ok'), svc('d', 'ok'),
  ];

  it('registers the expansion and the badge together when services overflow', () => {
    const { card } = board('services', renderServices, servicesVm(seven));
    expect(card.querySelector('.card__more').textContent).toBe('+2'); // cap 5 of 7
    expect(card.classList.contains('is-expandable')).toBe(true);
  });

  it('opens from anywhere on the card and shows EVERY service, outages first', () => {
    const { card } = board('services', renderServices, servicesVm(seven));
    expect(card.querySelectorAll('.svc').length).toBe(5); // the capped card
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
    const rows = overlay().querySelectorAll('.ledger__row');
    expect(rows.length).toBe(7); // all seven, nothing sliced
    // The three that are not ok lead, in the card's own severity order.
    const lead = [...overlay().querySelectorAll('.ledger__row--lead .ledger__name')];
    expect(lead.map((n) => n.textContent)).toEqual(['DOWN', 'SLOW', 'DARK']);
    expect(overlay().querySelector('.expand__title').textContent).toBe('Cloud Services');
    expect(overlay().querySelector('.expand__hint').textContent).toBe('Tap anywhere to close');
  });

  it('carries the full status prose the row tap used to reveal, uncut', () => {
    const { card } = board('services', renderServices, servicesVm(seven));
    card.querySelector('.card__body').click();
    const note = overlay().querySelector('.ledger__row--lead .ledger__note');
    expect(note.textContent).toContain('API errors');
    expect(note.textContent).toContain('since');           // the stamp, as its own quiet span
    expect(note.textContent).toContain('Still investigating.'); // and the operator's update
    expect(note.querySelector('.ledger__since')).not.toBeNull();
    expect(note.querySelector('.ledger__update')).not.toBeNull();
    // No clamp on this surface: the card's one-line .svc__note is not reused.
    expect(overlay().querySelector('.svc__note')).toBeNull();
  });

  it('falls back to the summary note when a status page lists no incidents', () => {
    expect(serviceNotes(svc('x', 'major', { note: 'Degraded', incidents: [] })))
      .toEqual([{ text: 'Degraded', meta: '', more: '' }]);
    // Nothing to say at all is an empty list, not a blank paragraph.
    expect(serviceNotes(svc('x', 'major', { note: '', incidents: [] }))).toEqual([]);
  });

  it('gives unknown its own tone, so the amber it earns is never the red it has not', () => {
    // The card says "Status unavailable" in --warn under an unknown row, and
    // the ledger carries that amber on the state word (overlay-chrome.test.js
    // pins the colour). What must NOT happen is unknown collapsing into the
    // outage tones: a failed status fetch is a "might be", and the tone stays
    // its own class so a junk state out of a status page cannot borrow one.
    const items = serviceItems([svc('dark', 'unknown'), svc('bad', 'major'), svc('meh', 'minor')]);
    expect(items[0].tone).toBe('unknown');
    expect(items[0].tone).not.toBe('major');
    expect(items[0].tone).not.toBe('minor');
    expect(items[1].tone).toBe('major');
    expect(items[2].tone).toBe('minor');
    expect(items[0].alert).toBe(true);     // and it leads, above operational
    // The tone reaches the markup as its own selector, not a shared one.
    const html = ledgerBody(items);
    expect(html).toContain('ledger__state--unknown');
    expect(html).toContain('ledger__state--major');
  });

  it('tones a state it has never heard of as unknown, never inventing a selector', () => {
    // bySeverity already reads a junk state as unknown; the tone follows it, so
    // a status page cannot put arbitrary text into a class name.
    const [odd] = serviceItems([svc('weird', 'maintenance-ish')]);
    expect(odd.tone).toBe('unknown');
    expect(odd.alert).toBe(true);
  });

  it('the operational tail is the quiet two-column group', () => {
    const { card } = board('services', renderServices, servicesVm(seven));
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.ledger__quiet .ledger__col').length).toBe(2);
    const quiet = [...overlay().querySelectorAll('.ledger__col .ledger__name')];
    expect(quiet.map((n) => n.textContent)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a tap on a row goes to the ledger, like a tap anywhere else', () => {
    const { card } = board('services', renderServices, servicesVm(seven));
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.svc').click();
    expect(readerOpen()).toBe(false); // there is no per-row reader any more
    expect(isExpandOpen()).toBe(true); // one tap, one destination, from anywhere
  });

  it('a card with nothing hidden STILL opens (Sean 2026-08-27)', () => {
    // The badge counts hidden rows and the expansion is the card's one
    // destination; they are answering different questions, so a card that
    // happens to fit every service still opens. It has to: the ledger is the
    // only place the note appears uncut, and the only place Microsoft's
    // advisories appear at all.
    const { card } = board('services', renderServices, servicesVm([
      svc('down', 'major', { note: 'Everything is on fire' }), svc('a', 'ok'),
    ]));
    expect(card.querySelector('.card__more')).toBeNull(); // nothing hidden, no badge
    expect(card.classList.contains('is-expandable')).toBe(true); // but it opens
    card.querySelector('.svc').click();
    expect(readerOpen()).toBe(false);
    expect(isExpandOpen()).toBe(true);
    expect(overlay().textContent).toContain('Everything is on fire');
  });

  it('a single-service card carries no count but still opens', () => {
    const { card } = board('services', renderServices, servicesVm([svc('only', 'ok')]));
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.card__body').click();
    // Even one service has more to say here than the card shows: the ledger
    // is where its note runs uncut.
    expect(isExpandOpen()).toBe(true);
    expect(overlay().textContent).toContain('ONLY');
  });

  it('an unconfigured card taps into Settings, never an empty ledger', () => {
    const { card } = board('services', renderServices, servicesVm([]));
    expect(card.classList.contains('is-expandable')).toBe(false);
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(false);
  });

  it('drops the BADGE when a refresh leaves nothing hidden, and keeps the expansion', () => {
    const { card, body } = board('services', renderServices, servicesVm(seven));
    expect(card.classList.contains('is-expandable')).toBe(true);
    renderServices(body, servicesVm([svc('a', 'ok')]), {});
    expect(card.querySelector('.card__more')).toBeNull(); // the count is honest about hidden rows
    expect(card.classList.contains('is-expandable')).toBe(true); // the destination does not move
  });

  it('carries the card stale stamp through to the overlay', () => {
    const { card } = board('services', renderServices, servicesVm(seven));
    const stamp = card.querySelector('.card__stamp');
    stamp.hidden = false;
    stamp.textContent = 'as of 9:14 AM';
    card.querySelector('.card__body').click();
    expect(overlay().querySelector('.expand__stamp').textContent).toBe('as of 9:14 AM');
    expect(overlay().classList.contains('is-stale')).toBe(true);
  });
});

// ------------------------------------------------------------------ tfl status

describe('Cloud Services advisories', () => {
  // Microsoft's long-running advisories (Sean's pick 2026-08-27, mockup A):
  // kept out of the row's state by the Worker, kept ON this surface because
  // "why is Outlook odd this week" is exactly what a tap is asking.
  const withAdvisories = (state, extra = {}) => svc('m365', state, {
    label: 'Microsoft 365',
    advisories: [
      { service: 'Exchange Online', feature: 'Mailbox Migrations', since: '2026-08-20T12:23:15Z' },
      { service: 'Microsoft Teams', feature: 'Teams and Channels', since: '2026-06-30T07:00:00Z' },
    ],
    ...extra,
  });

  it('renders the advisory group under the incident, one compact line each', () => {
    const [item] = serviceItems([withAdvisories('minor', {
      incidents: [{ title: 'SharePoint Online: service degradation', since: '2026-08-25T16:58:38Z', update: 'Search is down.' }],
    })]);
    expect(item.advisories).toHaveLength(2);
    expect(item.advisories[0]).toMatchObject({ text: 'Exchange Online \u00b7 Mailbox Migrations', meta: 'Aug 20' });
    // The heading states the size and the AGE, which is what tells a reader
    // this is a standing backlog rather than this morning's news.
    expect(item.advisoriesNote).toBe('2 open \u00b7 oldest Jun 30');

    const html = ledgerBody([item]);
    expect(html).toContain('ledger__adv');
    expect(html).toContain('Exchange Online \u00b7 Mailbox Migrations');
    // The incident still leads; advisories never take the alert colour.
    expect(html).toContain('SharePoint Online: service degradation');
    expect(html).not.toMatch(/ledger__advrow[^>]*ledger__state--minor/);
  });

  it('a green service carrying advisories still LEADS, so the backlog is never hidden', () => {
    // The ordinary day: nothing is actually broken, but the backlog exists. An
    // ok row normally sinks into the quiet two-column group, which has no room
    // to show it, so advisories promote the row to a lead.
    const items = serviceItems([withAdvisories('ok'), svc('slack', 'ok')]);
    const html = ledgerBody(items);
    const lead = html.slice(html.indexOf('ledger__lead'), html.indexOf('ledger__quiet'));
    expect(lead).toContain('Microsoft 365');
    expect(lead).toContain('ledger__adv');
    // Leading costs it no alarm: an ok row has no tone, so the state word is
    // the plain one and nothing on the row goes amber.
    expect(html).toContain('Operational');
    expect(lead).not.toContain('ledger__state--minor');
    // The service with nothing to say still settles into the quiet group.
    expect(html.slice(html.indexOf('ledger__quiet'))).toContain('SLACK');
  });

  it('no advisories means no group and no reserved space', () => {
    const [plain] = serviceItems([svc('slack', 'minor')]);
    expect(plain.advisories).toEqual([]);
    expect(plain.advisoriesNote).toBe('');
    expect(ledgerBody([plain])).not.toContain('ledger__adv');
  });
});

describe('TfL Status expand', () => {
  const lines = ['central', 'victoria', 'district', 'circle'];
  const tflVm = { updatedAt: 1783000000, lines: [
    tflLine('central', true), tflLine('victoria', true),
    tflLine('district', false), tflLine('circle', false),
  ] };

  it('registers the expansion and the badge together when lines overflow', () => {
    const { card } = board('tfl', renderTfl, tflVm, tflCfg(lines), [3, 2]);
    expect(card.querySelector('.card__more').textContent).toBe('+2'); // cap 2 of 4
    expect(card.classList.contains('is-expandable')).toBe(true);
  });

  it('shows every configured line, alerting first, with its prose and colour dot', () => {
    const { card } = board('tfl', renderTfl, tflVm, tflCfg(lines), [3, 2]);
    expect(card.querySelectorAll('.tfl').length).toBe(2); // the capped card
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.ledger__row').length).toBe(4);
    const lead = [...overlay().querySelectorAll('.ledger__row--lead .ledger__name')];
    expect(lead.map((n) => n.textContent)).toEqual(['District', 'Circle']);
    expect(overlay().querySelector('.ledger__row--lead .ledger__note').textContent)
      .toContain('district is a mess');
    // Every row wears its line colour, in both groups.
    expect(overlay().querySelectorAll('.ledger__dot').length).toBe(4);
    expect(overlay().querySelector('.expand__title').textContent).toBe('TfL Status');
  });

  it('a line with no reason text still leads, carrying no prose', () => {
    const items = tflItems([tflLine('quiet', true), { ...tflLine('bad', false), reason: '' }]);
    expect(items[0].name).toBe('Bad');
    expect(items[0].alert).toBe(true);
    expect(items[0].notes).toEqual([]);
  });

  it('a tap on a disrupted row opens the ledger, never the one-line reader', () => {
    const { card } = board('tfl', renderTfl, tflVm, tflCfg(lines), [3, 2]);
    card.querySelector('.tfl--alert').click();
    expect(readerOpen()).toBe(false);
    expect(isExpandOpen()).toBe(true);
  });

  // Every card opens when tapped (Sean, 2026-11-13), the Cloud Services rule:
  // the per-row reader a fitting card used to keep is gone, and the ledger
  // carries its prose uncut.
  it('a card showing every line still opens the ledger with all of them', () => {
    const two = { updatedAt: 1, lines: [tflLine('district', false), tflLine('central', true)] };
    const { card } = board('tfl', renderTfl, two, tflCfg(['district', 'central']), [3, 2]);
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.querySelectorAll('.tfl').length).toBe(2);
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.tfl--alert').click();
    expect(readerOpen()).toBe(false);
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelectorAll('.ledger__row').length).toBe(2);
    expect(overlay().textContent).toContain('district is a mess');
    expect(overlay().querySelector('.expand__note').textContent).toBe('1 of 2 lines with alerts');
  });

  it('a one-line, all-good card opens too, and its note reads in the singular', () => {
    const one = { updatedAt: 1, lines: [tflLine('central', true)] };
    const { card } = board('tfl', renderTfl, one, tflCfg(['central']), [3, 2]);
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.ledger__row').length).toBe(1);
    expect(overlay().querySelector('.expand__note').textContent).toBe('1 line good');
  });

  it('an unconfigured card taps into Settings', () => {
    const { card } = board('tfl', renderTfl, { lines: [] }, tflCfg([]), [3, 2]);
    expect(card.classList.contains('is-expandable')).toBe(false);
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(false);
  });
});

// ------------------------------------------------------------------ world clock

describe('World Clock expand', () => {
  it('registers UNCONDITIONALLY: the analog face is a richer re-read, not a longer list', () => {
    // The history/weather precedent. worldCities injects the local zone as a
    // home dial, which the card never shows, so even a card displaying every
    // configured city still owes a tap something it does not have.
    const cities = CITIES.slice(0, 2);
    const { card } = board('worldclock', renderWorldclock, wcVm(cities), wcCfg(cities), [3, 3]);
    expect(card.querySelector('.card__more')).toBeNull(); // nothing hidden: no badge
    expect(card.classList.contains('is-expandable')).toBe(true); // but it still opens
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
  });

  it('opens the screensaver world face verbatim, one dial per city plus Local', () => {
    const { card } = board('worldclock', renderWorldclock, wcVm(CITIES), wcCfg(CITIES), [3, 2]);
    expect(card.querySelectorAll('.wc-row').length).toBe(3); // the capped card, on the shallow tier's 28px row
    card.querySelector('.card__body').click();
    const face = overlay().querySelector('.cf.cf--world');
    expect(face).not.toBeNull();
    // Five configured cities plus the injected local dial.
    expect(overlay().querySelectorAll('.cf-dial').length).toBe(6);
    expect(overlay().querySelectorAll('.cf-dial__svg').length).toBe(6);
    expect(overlay().querySelector('.cf-dial--home')).not.toBeNull();
    expect(overlay().querySelector('.expand__title').textContent).toBe('World Clock');
    expect(overlay().querySelector('.expand__hint').textContent).toBe('Tap anywhere to close');
  });

  it('a card with no cities configured still opens something sensible: the local dial', () => {
    const { card } = board('worldclock', renderWorldclock, wcVm([]), wcCfg([]), [3, 3]);
    expect(card.querySelector('.card__more')).toBeNull();
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelectorAll('.cf-dial').length).toBe(1);
    expect(overlay().querySelector('.cf-dial--home')).not.toBeNull();
  });

  it('reads the clock at TAP time, not at the last card refresh', () => {
    // The vm is deliberately stale here (built from a fixed past instant); the
    // face must not be built from it.
    const cities = CITIES.slice(0, 2);
    const stale = worldTimes(new Date('2020-01-01T00:00:00Z'), cities, false);
    const { card } = board('worldclock', renderWorldclock, stale, wcCfg(cities), [3, 3]);
    card.querySelector('.card__body').click();
    const now = new Date();
    const hh = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true }).format(now);
    // The home dial shows the current local hour, whatever the vm said.
    expect(overlay().querySelector('.cf-dial--home .cf-dial__time').textContent)
      .toContain(hh.replace(/\s?[AP]M$/, ''));
  });

  describe('the measured dial backstop', () => {
    // Six dials is the ONE count that overflows the 814px overlay canvas:
    // planRows deals 3 + 3 and gridScale draws them at the biggest 330px dial.
    // Two rows of (dial + 94) on a 44px row gap is the geometry.
    const faceFixture = (availH, { dial = 330, gap = 104, rows = 2 } = {}) => {
      const props = new Map([['--dial', `${dial}px`], ['--dgap', `${gap}px`]]);
      const dials = {
        style: {
          getPropertyValue: (k) => props.get(k) ?? '',
          setProperty: (k, v) => props.set(k, v),
        },
        get offsetHeight() {
          const d = parseFloat(props.get('--dial'));
          return rows * (d + 94) + (rows - 1) * 44;
        },
      };
      return {
        props,
        body: { querySelector: (sel) => (sel === '.cf' ? { clientHeight: availH } : dials) },
      };
    };

    it('does nothing at all when the face already fits', () => {
      const { props, body } = faceFixture(814, { dial: 285 }); // the 7-to-8 dial case
      expect(fitWorldFace(body)).toBe(0);
      expect(props.get('--dial')).toBe('285px'); // verbatim, untouched
    });

    it('steps the six-dial case down until it fits, and no further', () => {
      const { props, body } = faceFixture(814, { dial: 330 }); // 892px of cells
      expect(fitWorldFace(body)).toBe(3); // 330 -> 315 -> 300 -> 285
      expect(props.get('--dial')).toBe('285px');
      expect(props.get('--dgap')).toBe('86px');
    });

    it('stops at the legibility floor rather than shrinking forever', () => {
      const { props, body } = faceFixture(120); // no dial size can fit this
      fitWorldFace(body);
      // The DIAL floor is what ends the walk (330 to 200 in nine 15px steps);
      // the gap simply rides along and its own 40px floor is a guard that is
      // never reached, not a target.
      expect(parseFloat(props.get('--dial'))).toBe(200);
      expect(parseFloat(props.get('--dgap'))).toBe(50);
      expect(parseFloat(props.get('--dgap'))).toBeGreaterThanOrEqual(40);
    });

    it('is a no-op without a layout engine', () => {
      const body = document.createElement('div');
      body.innerHTML = '<div class="cf"><div class="cf-dials"></div></div>';
      expect(fitWorldFace(body)).toBe(0); // happy-dom: clientHeight is 0
    });
  });

  describe('the minute-aligned repaint', () => {
    // A fake clock: `schedule` hands back an id the way setTimeout does, and
    // `cancel` records the id it was asked to drop.
    const fakeTimers = () => {
      const armed = [];
      const cancelled = [];
      return {
        armed,
        cancelled,
        schedule: (fn, ms) => armed.push({ fn, ms }), // push returns the new length: the id
        cancel: (id) => cancelled.push(id),
      };
    };

    it('repaints on the minute boundary and re-arms itself', () => {
      const body = document.createElement('div');
      document.body.appendChild(body);
      body.innerHTML = '<div class="cf cf--world"><div class="cf-dials"></div></div>';
      const t = fakeTimers();
      startWorldFaceRepaint(body, wcCfg(CITIES.slice(0, 2)), t.schedule, t.cancel);
      expect(t.armed).toHaveLength(1);
      // Aligned to the next minute, plus the engine's 80ms of slack.
      expect(t.armed[0].ms).toBeGreaterThan(80);
      expect(t.armed[0].ms).toBeLessThanOrEqual(60080);
      t.armed[0].fn();
      expect(body.querySelectorAll('.cf-dial').length).toBe(3); // repainted from cfg
      expect(t.armed).toHaveLength(2);                          // and re-armed
    });

    it('hands back the stop, and the stop cancels the tick that is armed', () => {
      // No liveness poll any more: the view is TOLD it is going away (the
      // engine's onClose) instead of deducing it from a detached element.
      const body = document.createElement('div');
      document.body.appendChild(body);
      const t = fakeTimers();
      const stop = startWorldFaceRepaint(body, wcCfg(CITIES), t.schedule, t.cancel);
      expect(t.armed).toHaveLength(1);
      t.armed[0].fn();          // one minute passes, so the timer id moves on
      expect(t.armed).toHaveLength(2);
      stop();
      expect(t.cancelled).toEqual([2]); // the tick currently armed, not the first one
    });

    it('leaves no timer running once the engine closes the view', () => {
      // The whole point, wired end to end: tap the card, the face starts
      // repainting; close the view and NOTHING of it is still scheduled. Before
      // the close hook this timer outlived the overlay and only stopped at the
      // next tick, once it noticed its body had been detached.
      vi.useFakeTimers();
      const { card } = board('worldclock', renderWorldclock, wcVm(CITIES), wcCfg(CITIES), [3, 2]);
      card.querySelector('.card__body').click();
      expect(isExpandOpen()).toBe(true);
      // The idle auto-close and the minute repaint, both live.
      expect(vi.getTimerCount()).toBe(2);
      closeExpand();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });
  });
});

// -------------------------------------------------------------------- citi bike

describe('Citi Bike expand', () => {
  const four = [
    station('a', 'W 21 St & 6 Ave', { bikes: 7, ebikes: 3, docks: 12, ok: true }),
    station('b', 'E 33 St & 2 Ave', { bikes: 0, ebikes: 0, docks: 25, ok: true }),
    station('c', 'Broadway & W 58 St', { bikes: 4, ebikes: 0, docks: 9, ok: true }),
    station('d', 'Dead Station', { bikes: 4, ebikes: 1, docks: 0, ok: false }),
  ];

  it('registers the expansion and the badge together when stations overflow', () => {
    const { card } = board('citibike', renderCitibike, citibikeVm(four), citibikeCfg(four), [3, 2]);
    expect(card.querySelector('.card__more').textContent).toBe('+2'); // cap 2 of 4
    expect(card.classList.contains('is-expandable')).toBe(true);
  });

  it('opens a well per configured station, bikes leading', () => {
    const { card } = board('citibike', renderCitibike, citibikeVm(four), citibikeCfg(four), [3, 2]);
    expect(card.querySelectorAll('.cb').length).toBe(2); // the capped card
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.cbwell').length).toBe(4);
    const names = [...overlay().querySelectorAll('.cbwell__name')].map((n) => n.textContent);
    expect(names).toEqual(['W 21 St & 6 Ave', 'E 33 St & 2 Ave', 'Broadway & W 58 St', 'Dead Station']);
    const first = overlay().querySelector('.cbwell');
    expect(first.querySelector('.cbwell__n').textContent).toBe('7');
    expect(first.querySelector('.cbwell__unit').textContent).toBe('bikes');
    expect(first.querySelector('.cbwell__sub').textContent).toContain('12 docks');
    expect(overlay().querySelector('.expand__title').textContent).toBe('Citi Bike');
  });

  it('calls out e-bikes in the accent only where there are some', () => {
    const html = bikeWells(
      four.map((s) => ({ id: s.id, name: s.name })),
      new Map(four.filter((s) => s.live).map((s) => [s.id, s.live])),
    );
    const host = document.createElement('div');
    host.innerHTML = html;
    const wells = [...host.querySelectorAll('.cbwell')];
    expect(wells[0].querySelector('.cbwell__e').textContent).toBe('3 e-bikes');
    expect(wells[1].querySelector('.cbwell__e')).toBeNull(); // 0 e-bikes stays silent
    expect(wells[2].querySelector('.cbwell__e')).toBeNull();
  });

  it('a station that is not renting says so instead of showing a count', () => {
    const { card } = board('citibike', renderCitibike, citibikeVm(four), citibikeCfg(four), [3, 2]);
    card.querySelector('.card__body').click();
    const dead = [...overlay().querySelectorAll('.cbwell')].at(-1);
    expect(dead.classList.contains('cbwell--off')).toBe(true);
    expect(dead.querySelector('.cbwell__offword').textContent).toBe('not renting');
    expect(dead.querySelector('.cbwell__n')).toBeNull();
    expect(dead.querySelector('.cbwell__sub')).toBeNull();
  });

  it('a station with no live reading at all reads as not renting, never as zero', () => {
    const html = bikeWells([{ id: 'ghost', name: 'Ghost Station' }], new Map());
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('.cbwell--off')).not.toBeNull();
    expect(host.querySelector('.cbwell__n')).toBeNull();
  });

  // Every card opens when tapped (Sean, 2026-11-13); the badge counts hidden
  // stations and nothing else.
  it('still opens the wells when every station fits', () => {
    const two = four.slice(0, 2);
    const { card } = board('citibike', renderCitibike, citibikeVm(two), citibikeCfg(two), [3, 2]);
    expect(card.querySelector('.card__more')).toBeNull();
    expect(card.querySelectorAll('.cb').length).toBe(2);
    expect(card.classList.contains('is-expandable')).toBe(true);
    card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(true);
    expect(overlay().querySelectorAll('.cbwell').length).toBe(2);
    expect(overlay().querySelector('.expand__note').textContent).toBe('2 stations');
  });

  it('a single station opens one well, with the note in the singular', () => {
    const one = four.slice(0, 1);
    const { card } = board('citibike', renderCitibike, citibikeVm(one), citibikeCfg(one), [3, 2]);
    card.querySelector('.card__body').click();
    expect(overlay().querySelectorAll('.cbwell').length).toBe(1);
    expect(overlay().querySelector('.expand__note').textContent).toBe('1 station');
  });

  it('is inert when no stations are configured', () => {
    const empty = board('citibike', renderCitibike, { stations: [] }, citibikeCfg([]), [3, 2]);
    expect(empty.card.classList.contains('is-expandable')).toBe(false);
    empty.card.querySelector('.card__body').click();
    expect(isExpandOpen()).toBe(false);
  });
});

// ------------------------------------------------------------- the shared rule

describe('defersToExpand', () => {
  it('is true only inside a card that actually opens something', () => {
    document.body.innerHTML = `
      <article class="card is-expandable"><i class="open"></i></article>
      <article class="card"><i class="inert"></i></article>`;
    expect(defersToExpand(document.querySelector('.open'))).toBe(true);
    expect(defersToExpand(document.querySelector('.inert'))).toBe(false);
  });

  it('survives a caller with no closest() and a null element', () => {
    expect(defersToExpand(null)).toBe(false);
    expect(defersToExpand({})).toBe(false);
  });
});
