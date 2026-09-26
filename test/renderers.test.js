/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEMO_VMS } from '../site/demo/fixtures.js';
import * as weather from '../site/js/widgets/weather.js';
import * as subway from '../site/js/widgets/subway.js';
import * as lirr from '../site/js/widgets/lirr.js';
import * as mnr from '../site/js/widgets/mnr.js';
import * as busw from '../site/js/widgets/bus.js';
import * as sports from '../site/js/widgets/sports.js';
import * as news from '../site/js/widgets/news.js';
import * as substack from '../site/js/widgets/substack.js';
import * as bsky from '../site/js/widgets/bsky.js';
import * as njt from '../site/js/widgets/njt.js';
import * as pathw from '../site/js/widgets/path.js';
import * as ferry from '../site/js/widgets/ferry.js';
import * as wotd from '../site/js/widgets/wotd.js';
import * as art from '../site/js/widgets/art.js';
import * as history from '../site/js/widgets/history.js';
import * as aqi from '../site/js/widgets/aqi.js';
import * as quote from '../site/js/widgets/quote.js';
import * as markets from '../site/js/widgets/markets.js';
import * as worldclock from '../site/js/widgets/worldclock.js';
import * as photos from '../site/js/widgets/photos.js';
import * as landscapes from '../site/js/widgets/landscapes.js';
import { CURATED_SOURCES } from '../site/js/config.js';
import * as marketsnews from '../site/js/widgets/marketsnews.js';
import * as services from '../site/js/widgets/services.js';
import * as apod from '../site/js/widgets/apod.js';
import * as chart from '../site/js/widgets/chart.js';
import * as citibike from '../site/js/widgets/citibike.js';
import * as tfl from '../site/js/widgets/tfl.js';
import * as f1 from '../site/js/widgets/f1.js';
import * as golf from '../site/js/widgets/golf.js';
import * as tennis from '../site/js/widgets/tennis.js';
import * as iptv from '../site/js/widgets/iptv.js';
import * as amtrak from '../site/js/widgets/amtrak.js';
import * as clock from '../site/js/widgets/clock.js';
import { fmtClock, editPrompt } from '../site/js/util.js';
import { setMode } from '../site/js/screensaver.js';
// Every card below is the REAL card the board mounts, tier classes and all,
// which is the point: these renderers branch on the card they are handed.
import { applyCardRect } from '../site/js/card.js';
import { mountCard, board } from './helpers/board.js';
import { sparkPath, sparkDividerX, yForValue, colorSplit, splitAtX, normalizeSymbol } from '../site/js/widgets/markets.js';
import { chaikin } from '../site/js/util.js';

const CFG = { name: 'Sean' };
const el = () => document.createElement('div');

describe('normalizeSymbol (ticker entry)', () => {
  it('maps a £ prefix to the LSE .L suffix (UK-user notation)', () => {
    expect(normalizeSymbol('£CBG')).toBe('CBG.L');
    expect(normalizeSymbol('£cbg')).toBe('CBG.L');
    expect(normalizeSymbol('£CBG.L')).toBe('CBG.L'); // no double suffix
  });
  it('strips a $ prefix and trims/uppercases', () => {
    expect(normalizeSymbol('$AAPL')).toBe('AAPL');
    expect(normalizeSymbol('  aapl ')).toBe('AAPL');
  });
  it('leaves indexes and suffixed symbols alone', () => {
    expect(normalizeSymbol('^GSPC')).toBe('^GSPC');
    expect(normalizeSymbol('SAP.DE')).toBe('SAP.DE');
  });
});

describe('clock (topbar) time format', () => {
  const time = (cfg) => { const d = el(); clock.render(d, null, cfg); return d.querySelector('.topbar__time').textContent; };
  it('renders 24-hour time (2-digit hour, no AM/PM) when clock24 is set', () => {
    const t = time({ clock24: true });
    expect(t).toMatch(/^\d{2}:\d{2}$/);
    expect(t).not.toMatch(/[AP]M/);
  });
  it('renders 12-hour time with AM/PM by default', () => {
    expect(time({ clock24: false })).toMatch(/^\d{1,2}:\d{2}\s?[AP]M$/);
  });
});

describe('fmtClock ("as of"/freshness reading, honors clock24)', () => {
  const at = Math.floor(new Date('2026-01-15T15:45:00').getTime() / 1000); // local instant
  it('12-hour with AM/PM by default (matches the departures fmtTime style)', () => {
    expect(fmtClock(at)).toMatch(/^\d{1,2}:\d{2}\s?[AP]M$/);
  });
  it('24-hour (2-digit hour, no AM/PM) when clock24 is set', () => {
    const t = fmtClock(at, true);
    expect(t).toMatch(/^\d{2}:\d{2}$/);
    expect(t).not.toMatch(/[AP]M/);
  });
});

describe('card "as of" freshness note honors clock24 (via render → fmtClock)', () => {
  const noteFor = (clock24) => {
    const c = mountCard(amtrak, null, { parent: null });
    amtrak.render(
      c.querySelector('.card__body'),
      { updatedAt: Math.floor(new Date('2026-01-15T15:45:00').getTime() / 1000), departures: [] },
      { clock24, amtrak: {} },
    );
    return c.querySelector('.card__asof')?.textContent ?? '';
  };
  it('renders the note 24-hour when clock24 is set', () => {
    expect(noteFor(true)).toMatch(/^as of \d{2}:\d{2}$/);
  });
  it('renders the note 12-hour otherwise', () => {
    expect(noteFor(false)).toMatch(/^as of \d{1,2}:\d{2}\s?[AP]M$/);
  });
});

const CASES = [
  ['weather', weather, ['84', 'Mostly clear', 'Extreme Heat Watch', '9 AM']],
  ['subway', subway, ['Good Service', 'rerouted', 'delays']],
  ['lirr', lirr, ['Port Washington', '8', 'Track 17']],
  ['mnr', mnr, ['Southeast', 'Harlem', 'Poughkeepsie']],
  ['bus', busw, ['QM24', 'Madison Av / E 34 St', 'Wall St', '8']],
  ['sports', sports, ['Mets', 'Bot 7th', 'W 24-17', 'Last:', 'Next: vs MIA']],
  ['news', news, ['Council reaches deal', 'Gothamist', 'Federal Reserve']],
  ['substack', substack, ['AI Superforecasters', 'Astral Codex Ten', 'Hidden Cost of Meetings']],
  ['bsky', bsky, ['ferry pier opens', 'NYT', 'Jane Dev']],
  ['njt', njt, ['Trenton', 'Northeast Corridor', '12']],
  ['path', pathw, ['Journal Square', 'Hoboken', 'min']],
  ['ferry', ferry, ['Wall St./Pier 11', 'East River', 'min']],
  ['wotd', wotd, ['petrichor', 'PET-rih-kor', 'noun', 'earthy smell']],
  ['art', art, ['Wheat Fields', 'Jacob van Ruisdael']],
  ['history', history, ['1776', 'Continental Congress']],
  ['aqi', aqi, ['66', 'Moderate', 'UV index', 'High', 'Waning Gibbous']],
  ['quote', quote, ['predict the future', 'Alan Kay']],
  ['markets', markets, ['Dow Jones', 'S&P 500', '0.45']],
  ['worldclock', worldclock, ['Hyderabad', '5:43 PM', 'Hong Kong', '+1d']],
  ['photos', photos, ['Beach']],
  ['marketsnews', marketsnews, ['Fed holds rates']],
  // A degraded row's lines are its INCIDENTS now (mockup A, 2026-08-02), which
  // is the same prose the expansion has always shown — so a one-incident
  // service names the thing that broke instead of repeating its state word.
  ['services', services, ['Zoom', 'Operational', 'Cloudflare', 'Minor',
    'Cloudflare Dashboard and API service issues', 'Microsoft Teams: service degradation']],
  ['apod', apod, ['Messier 24', 'Chuck Ayoub']],
];

// The render half of the RETIRED_AFTER mechanism, kept under test with no
// retired card in the tree (World Cup 2026 was the last one and left on
// 2026-07-29): the prompt must be tappable into edit mode and must name the
// pencil button, because a card that has stopped fetching and says nothing is
// indistinguishable from a broken one.
describe('editPrompt (retired-card sunset prompt)', () => {
  it('taps into edit mode and points at the pencil, carrying the caller message', () => {
    const host = el();
    host.innerHTML = editPrompt('The season is over.');
    const prompt = host.querySelector('[data-edit]');
    expect(prompt).toBeTruthy(); // main.js turns [data-edit] into an edit-mode tap
    expect(host.textContent).toContain('The season is over.');
    expect(host.textContent).toContain('replace this card');
    expect(host.textContent).toContain('Edit layout');
    expect(prompt.querySelector('svg')).toBeTruthy(); // pencil glyph
  });
});

describe('widget renderers', () => {
  for (const [id, mod, expectedTexts] of CASES) {
    it(`${id} renders its demo fixture`, () => {
      const host = el();
      mod.render(host, DEMO_VMS[id], CFG);
      const text = host.textContent;
      for (const t of expectedTexts) expect(text).toContain(t);
    });
  }

  // Substack/Bluesky route through renderHeadlines, so a row with a link is
  // tap-to-read (.headline--more + data-link → the shared story view + QR).
  it('substack and bsky rows are tap-to-read', () => {
    for (const [id, mod] of [['substack', substack], ['bsky', bsky]]) {
      const host = el();
      mod.render(host, DEMO_VMS[id], CFG);
      const more = host.querySelector('.headline--more[data-link]');
      expect(more, id).toBeTruthy();
      expect(more.getAttribute('data-link'), id).toMatch(/^https:\/\//);
    }
  });

  it('chart renders the infographic image only — no caption (title/branding are in the image)', () => {
    const host = el();
    chart.render(host, DEMO_VMS.chart, CFG);
    const img = host.querySelector('.artwork__img');
    expect(img.getAttribute('src')).toContain('cdn.statcdn.com/Infographic/images/normal/28744.jpeg');
    expect(img.getAttribute('alt')).toContain('Population Growth');
    expect(host.querySelector('.artwork--contain')).toBeTruthy(); // data images never crop
    expect(host.querySelector('.artwork__caption')).toBeNull();
    expect(host.textContent.trim()).toBe('');
  });

  it('citibike joins config station names with live counts, dims closed stations', () => {
    const host = el();
    // Names come from cfg; counts from the digest — ids must line up (they do
    // here, mirroring the default config the demo digest was recorded against).
    const cfg = { citibike: { stations: [
      { id: '66dc7c31-0aca-11e7-82f6-3863bb44ef7c', name: 'W 29 St & 9 Ave' },
      { id: '66dc51e9-0aca-11e7-82f6-3863bb44ef7c', name: '10 Ave & W 28 St' },
      { id: '1869743938848725856', name: '9 Ave & W 33 St' },
    ] } };
    citibike.render(host, DEMO_VMS.citibike, cfg);
    const text = host.textContent;
    expect(text).toContain('W 29 St & 9 Ave');
    expect(text).toContain('bikes');
    expect(text).toContain('not renting'); // the ok:false demo station
  });

  it('tfl shows line status, dims + makes tappable a disrupted line', () => {
    const host = el();
    const cfg = { tfl: { lines: ['central', 'district', 'northern'] } }; // northern absent from digest
    tfl.render(host, DEMO_VMS.tfl, cfg);
    const text = host.textContent;
    expect(text).toContain('Central');
    expect(text).toContain('Good Service');
    expect(text).toContain('Part Closure');
    expect(host.querySelector('.tfl--tap')).not.toBeNull();
  });

  it('subway renders route bullets and flags alerting lines', () => {
    const host = el();
    subway.render(host, DEMO_VMS.subway, CFG);
    expect(host.querySelector('.bullet--1')).not.toBeNull();
    expect(host.querySelectorAll('.linestatus--alert').length).toBe(2);
  });

  it('subway draws the route tokens inside alert copy as bullets, not brackets', () => {
    const host = el();
    subway.render(host, DEMO_VMS.subway, CFG);
    // The demo alert is real MTA copy: "Downtown [3] trains are rerouted via
    // the [2] line…" — a reader six feet away gets the line's own bullet.
    const alertRow = host.querySelector('.linestatus--alert .linestatus__text');
    expect(alertRow.textContent).not.toContain('[');
    expect([...alertRow.querySelectorAll('.bullet--inline')].map((b) => b.textContent)).toEqual(['3', '2']);
    expect(alertRow.textContent).toContain('trains are rerouted via the');
    // The row's own leading bullet is untouched (and is not an inline one).
    expect(host.querySelector('.linestatus--alert > .bullet').classList.contains('bullet--inline')).toBe(false);
  });

  it('subway leaves copy the palette does not know exactly as written, and escapes it', () => {
    const host = el();
    subway.render(host, { lines: [{ line: 'E', ok: false, headers: ['[LIRR] riders: <b>see</b> the [E] board.'] }] }, CFG);
    const text = host.querySelector('.linestatus__text');
    expect(text.querySelector('b')).toBeNull(); // escaped first, substituted after
    expect(text.textContent).toContain('[LIRR] riders: <b>see</b> the');
    expect(text.querySelectorAll('.bullet--inline').length).toBe(1); // only the E
  });

  // The three surfaces that render this class set their copy at 20px (the card
  // row), the wall's rung (30px and down) and 42px (the text reader), and one
  // em-relative rule has to sit right on all of them. happy-dom has no cascade,
  // so the contract is pinned in the stylesheet text — the same way the story
  // view's clamp and the overlay's geometry are.
  describe('inline route bullets: the stylesheet contract', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../site/css/main.css'), 'utf8');
    const rule = (selector) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, `no rule for "${selector}" in main.css`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };

    it('centres the circle on the cap band, and only ever moves it after layout', () => {
      const body = rule('.bullet--inline');
      // `middle` anchors the box midpoint at baseline + half the parent's
      // x-height: the centre of the x-BAND. A circle taller than the caps is
      // read against the CAP band, whose centre is (cap - x)/2 higher — in
      // CiscoSansTT ~0.099em of the parent, or 0.14em in the bullet's own
      // 0.7em face. Measured on a live board: middle alone left the circle
      // flush with the cap tops and hanging 5px under the 20px row's baseline.
      expect(body).toContain('vertical-align: middle');
      // The lift MUST ride on position: relative (applied after layout, costs
      // the line no height). A vertical-align offset in either direction is
      // the bug this rule has already shipped once: -0.3em hung the circle a
      // line low AND grew every alert row it landed on.
      expect(body).toContain('position: relative');
      expect(body).toContain('top: -0.14em');
      expect(body, 'offsets belong on top:, never on vertical-align').not.toMatch(/vertical-align:\s*[-0-9]/);
      // And it stays sized off the text it lands in, never in px.
      expect(body).toContain('font-size: 0.7em');
      expect(body).toContain('width: 1.5em; height: 1.5em');
      expect(body).not.toMatch(/(width|height|font-size):\s*\d+px/);
    });

    it('lets the wall size its lead bullet without touching the ones in the copy', () => {
      // Scoped to the well's direct child. As a descendant selector this was
      // (0,2,0) against .bullet--inline's (0,1,0), so every token inside a
      // sentence rendered at the 80px lead size.
      expect(rule('.sbalert > .bullet')).toContain('var(--well-bullet, 80px)');
      expect(css, 'a descendant .sbalert .bullet rule reaches the inline ones')
        .not.toMatch(/\.sbalert\s+\.bullet\s*[,{]/);
    });
  });



  it('news and history surface overflow as a title badge, not an in-flow row', () => {
    const mkCard = (mod) => mountCard(mod, { w: 3, h: 2 });
    const nc = mkCard(news);
    news.render(nc.querySelector('.card__body'), { nowMs: Date.now(), items: Array.from({ length: 20 }, (_, i) => ({ title: `Story ${i}`, t: Date.now() - i * 1000, source: 'X' })) }, CFG);
    expect(nc.querySelector('.card__more')?.textContent).toBe('+18'); // cap 2 at 3x2
    expect(nc.querySelector('.card__more svg')).toBeNull(); // the count alone
    expect(nc.classList.contains('has-more')).toBe(true);
    expect(nc.querySelector('.more-hint')).toBeNull();
    nc.remove();
    const hc = mkCard(history);
    history.render(hc.querySelector('.card__body'), { events: Array.from({ length: 20 }, (_, i) => ({ year: 1900 + i, text: `Event ${i}` })) }, CFG);
    // History expands and news does not, and the corner says exactly the same
    // thing on both: one form board-wide (2026-08-01), text only (2026-08-02).
    expect(hc.querySelector('.card__more')?.textContent).toBe('+18');
    expect(hc.querySelector('.card__more svg')).toBeNull();
    expect(hc.classList.contains('has-more')).toBe(true);
    hc.remove();
  });
  it('setMoreBadge removes the badge and fade class when nothing is hidden', () => {
    const c = mountCard(news, { w: 4, h: 8 });
    const body = c.querySelector('.card__body');
    const items = (n) => ({ nowMs: Date.now(), items: Array.from({ length: n }, (_, i) => ({ title: `S${i}`, t: 0, source: 'X' })) });
    news.render(body, items(20), CFG); // overflows → badge on
    expect(c.querySelector('.card__more')).not.toBeNull();
    news.render(body, items(2), CFG); // all fit → badge off
    expect(c.querySelector('.card__more')).toBeNull();
    expect(c.classList.contains('has-more')).toBe(false);
    c.remove();
  });

  it('markets colors gains and losses differently', () => {
    const host = el();
    markets.render(host, DEMO_VMS.markets, CFG);
    expect(host.querySelector('.delta--up')).not.toBeNull();
    expect(host.querySelector('.delta--down')).not.toBeNull();
    expect(host.querySelectorAll('svg.spark').length).toBe(3);
  });

  it('markets rows live in one shared grid so spark/delta columns align', () => {
    const host = el();
    markets.render(host, DEMO_VMS.markets, CFG);
    const wrap = host.querySelector('.indexes');
    expect(wrap).not.toBeNull();
    expect(wrap.querySelectorAll('.index')).toHaveLength(3);
  });

  it('weather omits the alert banner when there is none', () => {
    const host = el();
    weather.render(host, { ...DEMO_VMS.weather, alert: null }, CFG);
    expect(host.querySelector('.alert')).toBeNull();
  });

  it('weather adds the hourly precip row only on tall cards, and only with data', () => {
    const card = mountCard(weather, { w: 4, h: 5 });
    const body = card.querySelector('.card__body');

    weather.render(body, DEMO_VMS.weather, CFG);
    const row = card.querySelector('.wx-trend__row--precip');
    expect(row).not.toBeNull();
    // One cell per shown hour, column-aligned with the temps row above it.
    expect([...row.children].map((s) => s.textContent))
      .toEqual(['0%', '0%', '5%', '20%', '45%', '70%', '55%', '30%']);
    // 30% and up carries the sky-blue accent; below that stays quiet.
    expect([...row.querySelectorAll('.wx-pp--wet')].map((s) => s.textContent))
      .toEqual(['45%', '70%', '55%', '30%']);
    // Every reading leads with a droplet, dry hours included.
    expect([...row.children].map((s) => s.querySelectorAll('svg.wx-pp__drop').length))
      .toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // The glyph must carry no colour of its own: currentColor is what makes it
    // follow its cell between --ink-dim and the wet accent.
    const drop = row.querySelector('svg.wx-pp__drop');
    expect(drop.getAttribute('fill')).toBe('currentColor');
    expect(drop.getAttribute('aria-hidden')).toBe('true');
    expect(drop.outerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(|stroke=|style=/i);
    // Directly under the hourly temperatures, above the chart.
    const rows = [...card.querySelectorAll('.wx-trend > *')].map((n) => n.getAttribute('class'));
    expect(rows).toEqual(['wx-trend__row', 'wx-trend__row wx-trend__row--precip', 'wx-trend__chart', 'wx-trend__row wx-trend__row--hours']);

    // The NWS banner shifts the tall-card height budget, so the trend block is
    // flagged for the measured-fit chart heights that account for it.
    expect(card.querySelector('.wx-trend').classList.contains('wx-trend--banner')).toBe(true);
    weather.render(body, { ...DEMO_VMS.weather, alert: null }, CFG);
    expect(card.querySelector('.wx-trend__row--precip')).not.toBeNull();
    expect(card.querySelector('.wx-trend').classList.contains('wx-trend--banner')).toBe(false);

    // Shorter cards keep their existing layout.
    applyCardRect(card, { w: 4, h: 4 });
    weather.render(body, DEMO_VMS.weather, CFG);
    expect(card.querySelector('.wx-trend__row--precip')).toBeNull();
    expect(card.querySelector('.wx-trend').classList.contains('wx-trend--banner')).toBe(false);

    // No readings (older cached payload) → no row of blanks.
    applyCardRect(card, { w: 4, h: 5 });
    weather.render(body, { ...DEMO_VMS.weather, hourly: DEMO_VMS.weather.hourly.map((x) => ({ ...x, pp: null })) }, CFG);
    expect(card.querySelector('.wx-trend__row--precip')).toBeNull();

    // A gap in the readings holds its column with a bare span: no number, and
    // no orphan droplet either.
    weather.render(body, { ...DEMO_VMS.weather, hourly: DEMO_VMS.weather.hourly.map((x, i) => ({ ...x, pp: i < 2 ? null : x.pp })) }, CFG);
    const gappy = card.querySelector('.wx-trend__row--precip');
    expect([...gappy.children].map((s) => s.querySelectorAll('svg.wx-pp__drop').length))
      .toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
    expect(gappy.children[0].innerHTML).toBe('');
    card.remove();
  });

  it('weather widens the trend domain with the card height, not the width', () => {
    const card = mountCard(weather);
    const body = card.querySelector('.card__body');
    // A 4-degree overnight drift: the case that looked like a plunge once the
    // chart grew to 420px at h=8.
    const flat = [69, 68, 68, 67, 66, 66, 65, 67];
    const vm = { ...DEMO_VMS.weather, alert: null, hourly: DEMO_VMS.weather.hourly.map((x, i) => ({ ...x, temp: flat[i] })) };
    const extentAt = (w, h) => {
      applyCardRect(card, { w, h });
      weather.render(body, vm, CFG);
      const d = card.querySelector('.wx-trend__line').getAttribute('d');
      const ys = d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(extentAt(3, 5)).toBeCloseTo(44.25, 1); // 6-degree window (unchanged)
    expect(extentAt(3, 6)).toBeCloseTo(26.55, 1); // 10
    expect(extentAt(3, 7)).toBeCloseTo(18.97, 1); // 14
    expect(extentAt(3, 8)).toBeCloseTo(14.75, 1); // 18
    // Width must not move the window: a 12-wide, 5-tall card keeps the default.
    expect(extentAt(12, 5)).toBeCloseTo(extentAt(3, 5), 1);
    card.remove();
  });

  it('train widgets show the scheduled departure time next to the line', () => {
    for (const [mod, vm] of [[lirr, DEMO_VMS.lirr], [mnr, DEMO_VMS.mnr], [njt, DEMO_VMS.njt]]) {
      const host = el();
      mod.render(host, vm, CFG);
      expect(host.querySelector('.train__line').textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    }
  });

  it('sports shows the Next line only after finals/postponed/offseason', () => {
    const rowBase = { lg: 'mlb', abbr: 'X', name: 'X', record: '', logo: null, lastLine: null, nextLine: 'vs LAD · 7/20 - 7:10 PM' };
    const host1 = el();
    sports.render(host1, { rows: [{ ...rowBase, state: 'pre', line: 'vs LAD · 7/20 - 7:10 PM' }] }, CFG);
    expect(host1.textContent).not.toContain('Next:'); // upcoming line IS the next game already
    const host2 = el();
    sports.render(host2, { rows: [{ ...rowBase, state: 'pre', line: 'T 0-0 vs LAD · Postponed' }] }, CFG);
    expect(host2.textContent).toContain('Next:'); // postponed: look past the stuck pointer
    const host3 = el();
    sports.render(host3, { rows: [{ ...rowBase, state: 'none', line: 'No scheduled games' }] }, CFG);
    expect(host3.textContent).toContain('Next:');
  });

  it('rail cards prompt for a station when fetchData flags needsStation', () => {
    for (const [mod, msg] of [
      [lirr, '→ LIRR'],
      [mnr, '→ Metro-North'],
      [amtrak, '→ Amtrak'],
    ]) {
      const host = el();
      mod.render(host, { departures: [], needsStation: true }, CFG);
      expect(host.querySelector('.empty').textContent).toContain(msg);
      expect(host.querySelector('.train')).toBeNull();
    }
  });

  it('lirr rows tag their terminal only when both origins are shown', () => {
    const vm = { departures: [{ t: 1783000000, min: 5, dest: 'Mineola', origin: 'gct', branch: 'Hempstead', track: null }] };
    const both = el();
    lirr.render(both, vm, { ...CFG, lirr: { dest: '102', origin: 'both' } });
    expect(both.querySelector('.train__line').textContent).toContain('GCT · ');
    // The terminal tag stays ahead of the line chip: "GCT · Hempstead · 8:46 PM".
    expect(both.querySelector('.train__line').textContent).toMatch(/^GCT · Hempstead · \d{1,2}:\d{2}/);
    const single = el();
    lirr.render(single, vm, { ...CFG, lirr: { dest: '102', origin: 'gct' } });
    expect(single.querySelector('.train__line').textContent).not.toContain('GCT · ');
  });

  it('lirr/mnr render the line name as a chip in its official MTA color', () => {
    for (const [mod, vm, name, bg] of [
      [lirr, DEMO_VMS.lirr, 'Port Washington', '#C60C30'],
      [mnr, DEMO_VMS.mnr, 'Harlem', '#0039A6'],
    ]) {
      const host = el();
      mod.render(host, vm, CFG);
      const chip = host.querySelector('.train__line .train__linechip');
      expect(chip.textContent).toBe(name);
      expect(chip.getAttribute('style')).toContain(bg);
      // Chip first, then the time — the row reads "Harlem · 8:55 PM".
      expect(host.querySelector('.train__line').textContent).toMatch(
        new RegExp(`^${name} · \\d{1,2}:\\d{2}\\s?[AP]M$`),
      );
    }
  });

  it('lirr/mnr drop the chip and its separator when a branch has no name', () => {
    for (const [mod, key] of [[lirr, 'lirr'], [mnr, 'mnr']]) {
      const host = el();
      const vm = { departures: [{ t: 1783000000, min: 5, dest: 'Mineola', branch: '', track: null }] };
      mod.render(host, vm, { ...CFG, [key]: { dest: '102', origin: 'penn' } });
      expect(host.querySelector('.train__linechip')).toBeNull();
      // No stray leading "· " — an unnamed branch leaves just the time.
      expect(host.querySelector('.train__line').textContent).toMatch(/^\d{1,2}:\d{2}\s?[AP]M$/);
    }
  });

  it('an unmapped line keeps its plain name (no chip) so new branches still read', () => {
    const host = el();
    mnr.render(host, { departures: [{ t: 1783000000, min: 5, dest: 'New London', branch: 'Shore Line East', track: null }] }, CFG);
    expect(host.querySelector('.train__linechip')).toBeNull();
    expect(host.querySelector('.train__line').textContent).toMatch(/^Shore Line East · \d{1,2}:\d{2}/);
  });

  it('njt chips its lines in NJ Transit colors, under their short names', () => {
    const host = el();
    njt.render(host, DEMO_VMS.njt, CFG);
    const chips = [...host.querySelectorAll('.train__line .train__linechip')];
    expect(chips.length).toBeGreaterThan(2);
    const byText = new Map(chips.map((c) => [c.textContent, c.getAttribute('style')]));
    // The feed says "Northeast Corridor Line"; the chip says the short name.
    expect(byText.get('Northeast Corridor')).toContain('#EF3E42');
    expect(byText.get('Morris & Essex')).toContain('#00A94F');
    expect(byText.get('North Jersey Coast')).toContain('#00A4E4');
    expect(host.textContent).not.toContain('Corridor Line');
  });

  it('njt keeps the chip ahead of the time and the status behind it', () => {
    const base = { min: 12, time: 1783000720, dest: 'Trenton', line: 'Northeast Corridor Line', track: '3' };
    const withStatus = el();
    njt.render(withStatus, { trains: [{ ...base, status: 'BOARDING' }], alerts: [] }, CFG);
    expect(withStatus.querySelector('.train__line').textContent).toMatch(
      /^Northeast Corridor · \d{1,2}:\d{2}\s?[AP]M · BOARDING$/,
    );
    const noStatus = el();
    njt.render(noStatus, { trains: [{ ...base, status: '' }], alerts: [] }, CFG);
    expect(noStatus.querySelector('.train__line').textContent).toMatch(
      /^Northeast Corridor · \d{1,2}:\d{2}\s?[AP]M$/,
    );
  });

  it('njt falls back to plain text for a line string it does not know, and drops an empty one', () => {
    const unknown = el();
    njt.render(unknown, { trains: [{ min: 4, time: 1783000000, dest: 'Princeton', line: 'Princeton Dinky', track: null, status: '' }], alerts: [] }, CFG);
    expect(unknown.querySelector('.train__linechip')).toBeNull();
    expect(unknown.querySelector('.train__line').textContent).toMatch(/^Princeton Dinky · \d{1,2}:\d{2}/);
    const nameless = el();
    njt.render(nameless, { trains: [{ min: 4, time: 1783000000, dest: 'Princeton', line: '', track: null, status: 'DELAYED' }], alerts: [] }, CFG);
    expect(nameless.querySelector('.train__linechip')).toBeNull();
    // No stray leading "· " when the feed omits the line name.
    expect(nameless.querySelector('.train__line').textContent).toMatch(/^\d{1,2}:\d{2}\s?[AP]M · DELAYED$/);
  });

  it('lirr/mnr title-note the destination filter, and clear it when unset', () => {
    const card = mountCard(lirr);
    const body = card.querySelector('.card__body');
    lirr.render(body, { ...DEMO_VMS.lirr, destName: 'Mineola' }, CFG);
    expect(card.querySelector('.card__asof').textContent).toBe('stops at Mineola');
    lirr.render(body, { ...DEMO_VMS.lirr, destName: null }, CFG);
    expect(card.querySelector('.card__asof')).toBeNull();
    mnr.render(body, { ...DEMO_VMS.mnr, destName: 'Rye' }, CFG);
    expect(card.querySelector('.card__asof').textContent).toBe('stops at Rye');
    card.remove();
  });

  it('path and ferry title-note their station/landing', () => {
    const card = mountCard(pathw);
    const body = card.querySelector('.card__body');
    pathw.render(body, DEMO_VMS.path, CFG);
    expect(card.querySelector('.card__asof').textContent).toBe('33rd Street');
    ferry.render(body, DEMO_VMS.ferry, CFG);
    expect(card.querySelector('.card__asof').textContent).toBe('East 34th Street');
    ferry.render(body, { ...DEMO_VMS.ferry, landingName: '' }, CFG);
    expect(card.querySelector('.card__asof')).toBeNull();
    card.remove();
  });

  it('mnr slices departures to card capacity like lirr (regression)', () => {
    const card = mountCard(mnr, { w: 3, h: 2 });
    const many = { departures: Array.from({ length: 12 }, (_, i) => ({ min: i + 2, t: 1783000000 + i * 300, dest: `D${i}`, branch: 'Harlem', track: null })) };
    mnr.render(card.querySelector('.card__body'), many, CFG);
    expect(card.querySelectorAll('.train').length).toBe(2); // itemCapacity('mnr', 3, 2)
    card.remove();
  });

  // The rail/ferry capacities are browser-measured row counts (see
  // capacity.test.js); this is the wiring check that each board actually fills
  // them, and that fitTrainRows (a measured backstop) stands down where there
  // is no layout engine instead of shedding every row.
  it('rail and ferry boards fill the measured row count at each size', () => {
    const t0 = 1783000000;
    const many = (n) => Array.from({ length: n }, (_, i) => ({ min: i + 2, t: t0 + i * 300, dest: `Station ${i}`, branch: 'Harlem', track: null }));
    const vms = {
      lirr: { departures: many(12), destName: null },
      mnr: { departures: many(12) },
      njt: { trains: many(12).map((d) => ({ ...d, time: d.t, line: 'Northeast Corridor', status: '' })) },
      amtrak: { departures: many(12).map((d) => ({ ...d, route: 'Northeast Regional', num: '171', status: 'On time', platform: null, stops: [] })) },
      ferry: { departures: many(12).map((d) => ({ ...d, route: { name: 'East River', color: '00839C' } })), landingName: null },
    };
    for (const [id, mod] of [['lirr', lirr], ['mnr', mnr], ['njt', njt], ['amtrak', amtrak], ['ferry', ferry]]) {
      for (const [w, h, want] of [[6, 3, 4], [6, 4, 5], [6, 6, 9], [6, 8, 12]]) {
        const card = mountCard(mod, { w, h });
        mod.render(card.querySelector('.card__body'), structuredClone(vms[id]), CFG);
        expect(card.querySelectorAll('.train').length, `${id} ${w}x${h}`).toBe(want);
        card.remove();
      }
    }
  });

  it('path flattens both directions into a timed list in shallow cards', () => {
    const card = mountCard(pathw, { w: 6, h: 2 });
    const body = card.querySelector('.card__body');
    const vmBoth = { station: '33S', sections: [
      { dir: 'ToNY', label: 'To New York', rows: [{ min: 4, t: 1783000240, dest: '33rd Street', colors: [] }] },
      { dir: 'ToNJ', label: 'To New Jersey', rows: [{ min: 3, t: 1783000180, dest: 'Journal Square', colors: [] }] },
    ] };
    pathw.render(body, vmBoth, {});
    expect(body.querySelector('.path-section__label')).toBeNull();
    expect(body.textContent).toContain('To NJ ·');
    // Sorted by time across directions: the sooner NJ-bound train leads.
    expect(body.querySelector('.train__dest').textContent).toContain('Journal Square');
    applyCardRect(card, { w: 6, h: 4 });
    pathw.render(body, vmBoth, {});
    expect(body.querySelectorAll('.path-section__label')).toHaveLength(2);
    card.remove();
  });

  it('wotd hides the example sentence in 2-wide portrait cards', () => {
    const card = mountCard(wotd, { w: 2, h: 3 });
    const body = card.querySelector('.card__body');
    wotd.render(body, DEMO_VMS.wotd, CFG);
    expect(body.querySelector('.wotd__ex')).toBeNull();
    expect(body.textContent).toContain('petrichor');
    card.remove();
  });

  it('wotd hides the example sentence in shallow cards', () => {
    const card = mountCard(wotd, { w: 3, h: 2 });
    const body = card.querySelector('.card__body');
    wotd.render(body, DEMO_VMS.wotd, CFG);
    expect(body.textContent).not.toContain('first storm');
    applyCardRect(card, { w: 3, h: 4 });
    wotd.render(body, DEMO_VMS.wotd, CFG);
    expect(body.textContent).toContain('first storm');
    card.remove();
  });

  // Declared BEFORE the pool test on purpose: quote.js keeps the bundled list
  // once it has been fetched, exactly as a running board does, so this is the
  // only place in the file where the module has not seen one yet.
  it('quote still paints the cached saying before the list has loaded', () => {
    // A board painting from localStorage at boot has no pool yet: it shows the
    // day's quote from the cache rather than an empty card (this host has no
    // .card around it, so it also covers the bare-div default size).
    const host = el();
    quote.render(host, DEMO_VMS.quote, CFG);
    expect(host.querySelector('.quote__text').textContent).toContain(DEMO_VMS.quote.text);
  });

  it('quote picks a saying that fits the card instead of clamping one in half', async () => {
    const SHORT = { text: 'What we think, we become.', author: 'Buddha' };
    const LONG = { text: "I have not failed. I've just found 10,000 ways that won't work.", author: 'Thomas Edison' };
    // Seed the module-side pool the way a board does, then render the Quick
    // Start card (3x2): only the short saying can be whole on two lines.
    await quote.fetchData({}, { fetchJSON: async () => [SHORT, LONG] });
    const card = mountCard(quote, { w: 3, h: 2 });
    const body = card.querySelector('.card__body');
    quote.render(body, LONG, CFG);
    expect(body.querySelector('.quote__text').textContent).toContain(SHORT.text);
    expect(body.querySelector('.quote__author').textContent).toContain('Buddha');
    // The clamp is stamped with the same line count the pick was measured
    // against, and a deeper card is allowed more of them.
    expect(body.style.getPropertyValue('--quote-lines')).toBe('2');
    applyCardRect(card, { w: 3, h: 4 });
    quote.render(body, LONG, CFG);
    expect(Number(body.style.getPropertyValue('--quote-lines'))).toBeGreaterThan(2);
    card.remove();
  });

  it('empty transit states render a friendly message', () => {
    const host = el();
    subway.render(host, { lines: [] }, CFG);
    expect(host.textContent).toMatch(/Pick your lines/i);
    const host2 = el();
    lirr.render(host2, { departures: [] }, CFG);
    expect(host2.textContent).toMatch(/No departures/i);
  });
});

// Sean: "make the services with an outage bubble to the top like we do with
// subways, so if an affected service is outside the card size it's more likely
// to be visible." Severity decides the capacity slice; config order is the
// tiebreak inside a tier.
describe('services severity ordering', () => {
  const svc = (id, state) => ({ id, label: id.toUpperCase(), state, note: `${id} note`, incidents: [] });
  // A card the size the widget actually reads (data-w/h → cardSize), with the
  // title element setMoreBadge hangs the +N off. Out of the document on
  // purpose: nothing here needs it there.
  const card = (w, h) => mountCard(services, { w, h }, { parent: null });
  const labels = (host) => [...host.querySelectorAll('.svc__name')].map((n) => n.textContent);

  it('ranks major outages first, then minor, then unknown, then operational', () => {
    const rows = services.bySeverity([
      svc('a', 'ok'), svc('b', 'unknown'), svc('c', 'minor'), svc('d', 'major'),
    ]);
    expect(rows.map((s) => s.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('places unknown above operational but below any confirmed trouble', () => {
    // A failed status fetch is "might be a problem" — worth a look, but it must
    // never outrank a service we KNOW is down.
    const rows = services.bySeverity([svc('ok1', 'ok'), svc('dead', 'unknown'), svc('bad', 'minor')]);
    expect(rows.map((s) => s.id)).toEqual(['bad', 'dead', 'ok1']);
  });

  it('treats a state it has never seen as unknown, not as green', () => {
    const rows = services.bySeverity([svc('fine', 'ok'), svc('weird', 'maintenance-ish')]);
    expect(rows.map((s) => s.id)).toEqual(['weird', 'fine']);
  });

  it('keeps config order as the tiebreak inside a severity tier', () => {
    const rows = services.bySeverity([
      svc('ok1', 'ok'), svc('down1', 'major'), svc('ok2', 'ok'), svc('down2', 'major'), svc('ok3', 'ok'),
    ]);
    expect(rows.map((s) => s.id)).toEqual(['down1', 'down2', 'ok1', 'ok2', 'ok3']);
  });

  it('leaves an all-operational board exactly as configured, and never mutates the vm', () => {
    const input = [svc('webex', 'ok'), svc('slack', 'ok'), svc('m365', 'ok')];
    expect(services.bySeverity(input).map((s) => s.id)).toEqual(['webex', 'slack', 'm365']);
    const mixed = [svc('a', 'ok'), svc('b', 'major')];
    services.bySeverity(mixed);
    expect(mixed.map((s) => s.id)).toEqual(['a', 'b']); // sorted a copy
  });

  it('handles a single-service config and an all-down board', () => {
    expect(services.bySeverity([svc('only', 'major')]).map((s) => s.id)).toEqual(['only']);
    const allDown = [svc('a', 'major'), svc('b', 'major'), svc('c', 'major')];
    expect(services.bySeverity(allDown).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  // The point of the whole change: visibility, not just position.
  it('shows a down service configured LAST in a card too small to hold the list', () => {
    const c = card(3, 3); // capacity model: 5 rows at 3x3
    document.body.appendChild(c);
    const body = c.querySelector('.card__body');
    const vm = { updatedAt: 1783000000, services: [
      svc('one', 'ok'), svc('two', 'ok'), svc('three', 'ok'),
      svc('four', 'ok'), svc('five', 'ok'), svc('last', 'major'),
    ] };
    services.render(body, vm, CFG);
    const shown = labels(body);
    expect(shown).toHaveLength(5);            // sliced to capacity
    expect(shown[0]).toBe('LAST');            // the outage survived the slice
    expect(shown).not.toContain('FIVE');      // the quiet tail is what got cut
    expect(c.querySelector('.card__more').textContent).toBe('+1'); // badge math unchanged
    c.remove();
  });

  it('the reorder carries each row\'s own prose with it', () => {
    // Rows stopped being individual tap targets (Sean 2026-08-27), so the
    // property to hold is no longer an index: it is that the severity sort
    // floats the degraded service to the top AND that the ledger the card
    // opens shows that service's own words, not a neighbour's.
    const c = card(3, 5);
    document.body.appendChild(c);
    const body = c.querySelector('.card__body');
    services.render(body, { services: [
      svc('quiet', 'ok'),
      { ...svc('broken', 'major'), note: 'Everything is on fire', incidents: [] },
    ] }, CFG);
    const first = body.querySelector('.svc');
    expect(first.querySelector('.svc__name').textContent).toBe('BROKEN');
    expect(first.querySelector('.svc__note').textContent).toBe('Everything is on fire');
    c.remove();
  });
});

// Sean's pick 2026-08-02, mockup A ("Every line"): when a provider has several
// things wrong at once, the card lists each affected piece instead of the one
// summary line. Green services yield the space; the severity sort, the
// fill-to-fit loops and the corner +N already handle the bumping.
describe('services incident lines', () => {
  const card = (w, h) => mountCard(services, { w, h });
  const notes = (host) => [...host.querySelectorAll('.svc__note')].map((n) => n.textContent);
  const rowNotes = (host, i) => [...host.querySelectorAll('.svc')[i].querySelectorAll('.svc__note')]
    .map((n) => n.textContent);
  // The real Microsoft digest of 2026-08-02, worker-sorted (core workloads
  // first) and already carrying the Worker's title wording.
  const M365 = {
    id: 'm365', label: 'Microsoft 365', state: 'minor', note: 'Exchange Online: service degradation',
    incidents: [
      { title: 'Exchange Online: service degradation', since: '', update: 'Mailbox access is delayed.' },
      { title: 'Microsoft 365 suite: service degradation', since: '', update: 'Sign-in errors.' },
      { title: 'Microsoft Teams: service degradation', since: '', update: 'Chats load slowly.' },
    ],
  };
  const ok = (id) => ({ id, label: id.toUpperCase(), state: 'ok', note: 'All systems operational', incidents: [] });
  // happy-dom has no layout engine, so the measured loops are driven by hand:
  // a real element everywhere else, with the two numbers the loops read derived
  // from the markup actually rendered (a .svc row plus a line per note).
  const measure = (body, clientHeight, { rowPx = 30, notePx = 22 } = {}) => {
    Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(body, 'scrollHeight', {
      configurable: true,
      get: () => body.querySelectorAll('.svc').length * rowPx
        + body.querySelectorAll('.svc__note').length * notePx,
    });
  };

  it('gives a multi-incident service one amber line per incident, in the order given', () => {
    const c = card(3, 5);
    const body = c.querySelector('.card__body');
    services.render(body, { services: [ok('webex'), M365] }, CFG);
    // No re-sorting client-side: the Worker's core-first order is the order.
    expect(rowNotes(body, 0)).toEqual([
      'Exchange Online: service degradation',
      'Microsoft 365 suite: service degradation',
      'Microsoft Teams: service degradation',
    ]);
    expect(rowNotes(body, 1)).toEqual([]); // operational rows stay one line tall
    c.remove();
  });

  it('keeps the single summary line for a degraded service with no incident list', () => {
    const c = card(3, 5);
    const body = c.querySelector('.card__body');
    services.render(body, { services: [
      { id: 'zoom', label: 'Zoom', state: 'major', note: 'Major Service Outage', incidents: [] },
    ] }, CFG);
    expect(notes(body)).toEqual(['Major Service Outage']);
    c.remove();
  });

  it('keeps an unknown row at its one "Status unavailable" line', () => {
    const c = card(3, 5);
    const body = c.querySelector('.card__body');
    services.render(body, { services: [
      { id: 'aws', label: 'AWS', state: 'unknown', note: 'Status unavailable', incidents: [] },
    ] }, CFG);
    expect(notes(body)).toEqual(['Status unavailable']);
    c.remove();
  });

  it('spends leftover slack by dropping EVERY note line of the final row', () => {
    const c = card(3, 5);
    const body = c.querySelector('.card__body');
    // A(30+3*22=96) + B(30+2*22=74) = 170 overflows 130, so the fit loop lands
    // on one row; B's row alone (30) fits in what is left, so it comes back
    // without any of its notes. The tap still shows them.
    measure(body, 130);
    services.render(body, { services: [
      M365,
      { id: 'slack', label: 'Slack', state: 'minor', note: 'Degraded', incidents: [
        { title: 'Message sending is delayed', since: '', update: '' },
        { title: 'Huddles are failing to connect', since: '', update: '' },
      ] },
    ] }, CFG);
    expect(body.querySelectorAll('.svc')).toHaveLength(2);
    expect(rowNotes(body, 0)).toHaveLength(3); // the worse service keeps all of its lines
    expect(rowNotes(body, 1)).toEqual([]);     // ALL of the last row's notes yielded, not just one
    c.remove();
  });

  it('sheds incident lines from the bottom when one service alone overflows', () => {
    const c = card(3, 2);
    const body = c.querySelector('.card__body');
    measure(body, 80); // 30 + 3*22 = 96 overflows; 30 + 2*22 = 74 fits
    services.render(body, { services: [M365, ok('webex'), ok('slack')] }, CFG);
    expect(body.querySelectorAll('.svc')).toHaveLength(1);
    expect(notes(body)).toEqual([
      'Exchange Online: service degradation',
      'Microsoft 365 suite: service degradation',
    ]);
    // Trimmed LINES are not hidden SERVICES: the badge still counts the two
    // services that got bumped, which is what the expansion will show.
    expect(c.querySelector('.card__more').textContent).toBe('+2');
    c.remove();
  });

  it('never silences a degraded row: the last line stays even when it cannot fit', () => {
    const c = card(3, 2);
    const body = c.querySelector('.card__body');
    measure(body, 40); // even 30 + 22 = 52 overflows, and there is nothing else to give
    services.render(body, { services: [M365] }, CFG);
    expect(notes(body)).toEqual(['Exchange Online: service degradation']);
    c.remove();
  });
});

describe('art full-screen viewer', () => {
  it('opens on card tap and closes on viewer tap', () => {
    const host = el();
    art.render(host, DEMO_VMS.art, CFG);
    host.querySelector('.artwork').click();
    const viewer = document.querySelector('#art-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer.hidden).toBe(false);
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe(DEMO_VMS.art.img);
    expect(viewer.textContent).toContain('Wheat Fields');
    viewer.click();
    expect(viewer.hidden).toBe(true);
  });
});

describe('landscapes widget (curated GDrive source)', () => {
  it('carries its own title and fetches the curated folder', async () => {
    expect(landscapes.meta.id).toBe('landscapes');
    expect(landscapes.meta.title).toBe('Landscapes');
    let url = '';
    const vm = await landscapes.fetchData(CFG, { fetchJSON: async (u) => {
      url = u;
      return { photos: [{ url: 'https://x.test/l.jpg', ar: 1.6, caption: '', date: '2026-07-20' }] };
    } });
    expect(url).toContain(`/gdrive/album?folder=${CURATED_SOURCES.landscapes.folder}`);
    expect(vm.photos[0].img).toBe('https://x.test/l.jpg');
  });

  it('renders a photo card that opens the full-screen viewer', () => {
    document.querySelector('#art-viewer')?.remove();
    const host = el();
    landscapes.render(host, { photos: [{ img: 'https://x.test/l.jpg', ar: 1.6, title: '', date: '2026-07-20' }] }, CFG);
    expect(host.querySelector('.artwork__img').getAttribute('src')).toBe('https://x.test/l.jpg');
    host.querySelector('.artwork').click();
    expect(document.querySelector('#art-viewer')).not.toBeNull();
    document.querySelector('#art-viewer').remove();
  });
});

describe('art viewer strip + swipes', () => {
  it('viewer shows the ambient strip with a clock', () => {
    const host = el();
    art.render(host, DEMO_VMS.art, CFG);
    host.querySelector('.artwork').click();
    const viewer = document.querySelector('#art-viewer');
    const strip = viewer.querySelector('.strip');
    expect(strip).not.toBeNull();
    expect(strip.textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
    viewer.click();
    expect(viewer.hidden).toBe(true);
  });

  it('chart viewer (strip:false) opens with no info strip', async () => {
    document.querySelector('#art-viewer')?.remove();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    openImageViewer(
      { img: 'https://x.test/chart.png', title: 'Chart of the Day', artist: 'Statista' },
      CFG,
      { list: [], caption: false, strip: false },
    );
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.hidden).toBe(false);
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/chart.png');
    expect(viewer.querySelector('.strip')).toBeNull(); // no info band over the chart
    viewer.remove();
  });

  it('viewer swipes to the next and previous artwork', async () => {
    const list = [
      DEMO_VMS.art,
      { img: 'https://x.test/two.jpg', title: 'Second Work', artist: 'B', year: '1901', ar: 1.5 },
    ];
    vi.stubGlobal('Image', class { set src(v) { queueMicrotask(() => this.onload?.()); } });
    // Pre-populate artList so the viewer receives the full manifest for swiping.
    await art.fetchData({ art: {} }, { fetchJSON: async () => list });
    const host = el();
    art.render(host, DEMO_VMS.art, CFG);
    host.querySelector('.artwork').click();
    const viewer = document.querySelector('#art-viewer');
    // No async manifest load — list is seeded synchronously from artList.
    const swipe = (fromX, toX) => {
      viewer.dispatchEvent(new MouseEvent('pointerdown', { clientX: fromX, clientY: 100 }));
      viewer.dispatchEvent(new MouseEvent('pointerup', { clientX: toX, clientY: 104 }));
      return new Promise((r) => setTimeout(r, 420)); // preload + the 380ms dark beat (swipeFadeThrough)
    };
    await swipe(600, 400); // left: next
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/two.jpg');
    expect(viewer.textContent).toContain('Second Work');
    await swipe(400, 600); // right: back to the first
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe(DEMO_VMS.art.img);
    expect(viewer.hidden).toBe(false); // swipes never close
    vi.unstubAllGlobals();
    // A genuine tap (down/up/click at the same spot) still closes.
    viewer.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, clientY: 300 }));
    viewer.dispatchEvent(new MouseEvent('pointerup', { clientX: 502, clientY: 301 }));
    viewer.dispatchEvent(new MouseEvent('click', { clientX: 502, clientY: 301 }));
    expect(viewer.hidden).toBe(true);
  });
});

describe('markets freshness note', () => {
  it('writes an as-of time into the card header', () => {
    const card = mountCard(markets);
    markets.render(card.querySelector('.card__body'), DEMO_VMS.markets, CFG);
    const asof = card.querySelector('.card__title .card__asof');
    expect(asof).not.toBeNull();
    expect(asof.textContent).toMatch(/^as of \d{1,2}:\d{2}\s?(AM|PM)$/);
    card.remove();
  });
});

// Closed markets. The worker says of each quote whether its market trades now
// (`open`) and when that quote was fetched (`fetchedAt`); the header dates the
// open quotes only, and a closed row in a list still partly trading says so
// under its deltas.
describe('markets closed-market treatment', () => {
  const UPDATED = 1790000000;
  const q = (symbol, extra = {}) => ({
    symbol, name: symbol, price: 100, change: 1, changePct: 1, spark: [1, 2, 3], ...extra,
  });
  // Tuesday late morning in New York: London shut at 11:30, Tokyo overnight,
  // Bitcoin never. The oldest OPEN fetch is BTC's, and the oldest fetch of all
  // (Tokyo's) must not date the header.
  const MIXED = [
    q('^GSPC', { open: true, fetchedAt: UPDATED + 600 }),
    q('^FTSE', { open: false, fetchedAt: UPDATED + 60 }),
    q('BTC-USD', { open: true, fetchedAt: UPDATED + 480 }),
    q('^N225', { open: false, fetchedAt: UPDATED }),
  ];
  const ALL_CLOSED = MIXED.map((ix) => ({ ...ix, open: false }));
  const vmOf = (indices) => ({ updatedAt: UPDATED, stale: false, indices });
  const mount = (indices, [w, h] = [4, 4]) => {
    const card = mountCard(markets, { w, h });
    markets.render(card.querySelector('.card__body'), vmOf(indices), CFG);
    return card;
  };
  const noteOf = (card) => card.querySelector('.card__title .card__asof')?.textContent;
  const labelled = (card) =>
    [...card.querySelectorAll('.index')]
      .filter((row) => row.querySelector('.index__closed'))
      .map((row) => row.querySelector('.index__name').textContent);

  it('dates the header from the oldest OPEN quote, not the oldest quote', () => {
    const card = mount(MIXED);
    expect(noteOf(card)).toBe(`as of ${fmtClock(UPDATED + 480)}`);
    card.remove();
  });

  it('says "Closed" in the header when every quote is closed', () => {
    const card = mount(ALL_CLOSED);
    expect(noteOf(card)).toBe('Closed');
    card.remove();
  });

  it('renders a payload without the new fields exactly as before: as of updatedAt, no labels', () => {
    const legacy = MIXED.map(({ open, fetchedAt, ...rest }) => rest);
    const card = mount(legacy);
    expect(noteOf(card)).toBe(`as of ${fmtClock(UPDATED)}`);
    expect(card.querySelector('.index__closed')).toBeNull();
    expect(card.querySelector('.index--closed')).toBeNull();
    // A quote missing only its fetchedAt falls back to updatedAt, too.
    expect(markets.marketsNote(vmOf([q('A', { open: true }), q('B', { open: true, fetchedAt: UPDATED + 9 })])))
      .toBe(`as of ${fmtClock(UPDATED)}`);
    card.remove();
  });

  it('labels only the closed rows of a mixed list, flush in the percentage cell', () => {
    // 3x3 shows three rows, so Tokyo falls behind the tap there.
    for (const [w, h, want] of [[4, 4, ['^FTSE', '^N225']], [3, 3, ['^FTSE']], [4, 8, ['^FTSE', '^N225']]]) {
      const card = mount(MIXED, [w, h]);
      expect(labelled(card)).toEqual(want);
      const label = card.querySelector('.index__closed');
      expect(label.textContent).toBe('Closed');
      expect(label.parentElement.classList.contains('delta__pct')).toBe(true);
      expect(card.querySelectorAll('.index--closed')).toHaveLength(want.length);
      card.remove();
    }
  });

  it('puts no row labels on an all-closed list: the header says it once', () => {
    const card = mount(ALL_CLOSED);
    expect(card.querySelector('.index__closed')).toBeNull();
    expect(card.querySelector('.index--closed')).toBeNull();
    card.remove();
  });

  it('keeps the 2-row card to the header rule: no row labels', () => {
    for (const w of [3, 4]) {
      const card = mount(MIXED, [w, 2]);
      expect(card.classList.contains('t-s')).toBe(true);
      expect(noteOf(card)).toBe(`as of ${fmtClock(UPDATED + 480)}`);
      expect(card.querySelector('.index__closed')).toBeNull();
      card.remove();
    }
  });
});

// The regression test for the /markets cache bug. The Worker sorts its cache
// key on purpose (AAPL,MSFT and MSFT,AAPL coalesce to one entry, ~20 Yahoo
// subrequests saved per permutation) while fetchMarkets answers in REQUEST
// order — so a reorder used to hit the same cached payload and render the old
// order for up to 300s. Order is applied here, at render, on both surfaces.
describe('orderBySymbols — config order reaches the screen', () => {
  const quote = (symbol, price) => ({
    symbol, name: symbol, price, change: 1, changePct: 0.1, spark: [1, 2, 3],
  });
  const syms = (list) => list.map((s, i) => quote(s, 100 + i));
  const order = (payload, cfgSyms) => markets.orderBySymbols(payload, cfgSyms).map((ix) => ix.symbol);

  it('re-seats a payload that arrived in a stale order', () => {
    // What the 300s-old cache entry holds vs what the user just saved.
    const cached = syms(['AAPL', 'MSFT', 'CSCO']);
    expect(order(cached, ['CSCO', 'AAPL', 'MSFT'])).toEqual(['CSCO', 'AAPL', 'MSFT']);
  });

  // The pre-existing partial: true case — a symbol Yahoo failed on is dropped
  // from `indices`, and every later ticker used to silently shift up a slot.
  it('holds the surviving order when a symbol is missing', () => {
    const partial = syms(['^DJI', 'AAPL', 'CSCO']); // MSFT failed upstream
    expect(order(partial, ['^DJI', 'MSFT', 'AAPL', 'CSCO'])).toEqual(['^DJI', 'AAPL', 'CSCO']);
  });

  it('appends quotes the config never named rather than dropping them', () => {
    // The defaults path: an empty/unsent symbols list means the Worker picked.
    const payload = syms(['^DJI', '^IXIC', '^GSPC']);
    expect(order(payload, ['^GSPC'])).toEqual(['^GSPC', '^DJI', '^IXIC']);
    expect(order(payload, [])).toEqual(['^DJI', '^IXIC', '^GSPC']); // no config: leave it alone
    expect(order(payload, undefined)).toEqual(['^DJI', '^IXIC', '^GSPC']);
  });

  it('renders the card and the wall behind the tap in the SAME config order', () => {
    // Shallow: capacity 3, so a 4th falls behind the tap.
    const card = mountCard(markets, { w: 4, h: 2 });
    const body = card.querySelector('.card__body');
    const vm = { updatedAt: null, stale: false, indices: syms(['^DJI', 'AAPL', 'MSFT', 'CSCO']) };
    markets.render(body, vm, { markets: { symbols: ['CSCO', '^DJI', 'MSFT', 'AAPL'] } });
    expect([...body.querySelectorAll('.index__name')].map((e) => e.textContent))
      .toEqual(['CSCO', '^DJI', 'MSFT']); // the card fills from the top of the list down
    const wall = document.createElement('div');
    wall.innerHTML = markets.tileWall(markets.orderBySymbols(vm.indices, ['CSCO', '^DJI', 'MSFT', 'AAPL']));
    // ^DJI still LEADS on its own shelf (that band is the wall's, not the
    // list's), and the stocks below it keep the order the user wrote.
    expect([...wall.querySelectorAll('.wall__shelf .tile__sym')].map((e) => e.textContent)).toEqual(['^DJI']);
    expect([...wall.querySelectorAll('.wall__grid .tile__sym')].map((e) => e.textContent))
      .toEqual(['CSCO', 'MSFT', 'AAPL']);
    card.remove();
  });
});

describe('setCardNote', () => {
  it('creates, updates and removes the title note', async () => {
    const { setCardNote } = await import('../site/js/card.js');
    // No widget behind this one: the operation is what is under test, so the
    // meta is invented.
    const card = mountCard({ id: 'note', title: 'X' });
    const body = card.querySelector('.card__body');
    setCardNote(body, 'stops at Mineola');
    expect(card.querySelector('.card__title .card__asof').textContent).toBe('stops at Mineola');
    setCardNote(body, 'stops at Rye');
    expect(card.querySelectorAll('.card__asof')).toHaveLength(1);
    expect(card.querySelector('.card__asof').textContent).toBe('stops at Rye');
    setCardNote(body, null);
    expect(card.querySelector('.card__asof')).toBeNull();
    setCardNote(document.createElement('div'), 'orphan'); // no card ancestor: no throw
    card.remove();
  });
});

describe('symbolKnown', () => {
  const ok = (body) => ({ ok: true, json: async () => body });
  it('accepts a symbol the quote source returns', async () => {
    const fetchFn = async (url) => {
      expect(url).toContain('/markets?symbols=AAPL');
      return ok({ indices: [{ symbol: 'AAPL', name: 'Apple Inc.' }] });
    };
    expect(await markets.symbolKnown('AAPL', fetchFn)).toBe(true);
  });
  it('rejects unknown symbols, upstream failures and network errors', async () => {
    expect(await markets.symbolKnown('FLKJSDF', async () => ({ ok: false }))).toBe(false); // worker 502
    expect(await markets.symbolKnown('FLKJSDF', async () => ok({ indices: [] }))).toBe(false);
    expect(await markets.symbolKnown('AAPL', async () => { throw new Error('offline'); })).toBe(false);
  });
});

describe('sparkPath', () => {
  it('produces a normalized SVG path', () => {
    const d = sparkPath([0, 5, 10], 100, 30);
    expect(d.startsWith('M')).toBe(true);
    expect(d.split('L')).toHaveLength(3); // three points
    expect(d).toContain('98.0'); // spans to width minus padding
    expect(sparkPath([], 100, 30)).toBe('');
    expect(sparkPath([7], 100, 30)).toBe('');
  });
});

describe('markets 2-day sparkline', () => {
  it('sparkDividerX is the midpoint of the split gap in sparkPath coords', () => {
    // 10-point series split at 5: step = (90-4)/9; divider at index 4.5.
    const step = 86 / 9;
    expect(sparkDividerX(10, 5)).toBeCloseTo(2 + 4.5 * step, 5);
  });
  it('draws the divider only on wide cards that carry two sessions', () => {
    const mk = (w) => {
      const card = mountCard(markets, { w, h: 3 });
      markets.render(card.querySelector('.card__body'), DEMO_VMS.markets, CFG);
      return card;
    };
    const wide = mk(4); // markets' max width — fixture carries spark2/split
    expect(wide.querySelectorAll('.spark__div').length).toBe(3); // one per index
    expect(wide.querySelectorAll('.spark__prev').length).toBe(3); // white yesterday segment
    // Non-scaling stroke → uniform line width despite the non-uniform (wide)
    // preserveAspectRatio scale, otherwise steep parts render fat.
    expect(wide.querySelector('.spark__prev').getAttribute('vector-effect')).toBe('non-scaling-stroke');
    // Today is baseline-coloured with plain paths — NO clip-paths (gen1 WebEngine
    // drops clipped SVG). Every sparkline has at least one coloured today path.
    expect(wide.querySelector('clipPath')).toBeNull();
    expect(wide.querySelectorAll('.spark__up, .spark__down').length).toBeGreaterThanOrEqual(3);
    wide.remove();
    const narrow = mk(3); // the 3-wide min → compact 1-day spark, no divider
    expect(narrow.querySelector('.spark__div')).toBeNull();
    expect(narrow.querySelector('.spark__prev')).toBeNull();
    expect(narrow.querySelector('clipPath')).toBeNull();
    expect(narrow.querySelectorAll('.spark__up, .spark__down').length).toBeGreaterThanOrEqual(3);
    narrow.remove();
  });

  it('yForValue maps a value to its plotted y within a series range', () => {
    // value at the max sits at the top pad; at the min, the bottom pad.
    expect(yForValue(10, [0, 10], 28, 2)).toBeCloseTo(2, 5);
    expect(yForValue(0, [0, 10], 28, 2)).toBeCloseTo(26, 5);
    expect(yForValue(5, [0, 10], 28, 2)).toBeCloseTo(14, 5); // midpoint
  });

  it('colorSplit cuts a crossing polyline into green/red subpaths at the baseline', () => {
    // (0,4) is above yBase=10, (10,16) below → crossing interpolated at x=5.
    const cross = colorSplit([[0, 4], [10, 16]], 10);
    expect(cross.up).toBe('M0.0,4.0L5.0,10.0');   // green: above → baseline
    expect(cross.down).toBe('M5.0,10.0L10.0,16.0'); // red: baseline → below
    // A same-side segment stays one colour, the other path empty.
    const above = colorSplit([[0, 2], [10, 4]], 10);
    expect(above.up).toBe('M0.0,2.0L10.0,4.0');
    expect(above.down).toBe('');
  });

  it('chaikin smooths a polyline, keeping endpoints and never overshooting', () => {
    const raw = [[0, 0], [10, 20], [20, 0]];
    const s = chaikin(raw, 2);
    expect(s.length).toBeGreaterThan(raw.length); // denser (curve-like)
    expect(s[0]).toEqual([0, 0]); // exact endpoints kept (divider/baseline anchors)
    expect(s[s.length - 1]).toEqual([20, 0]);
    const ys = s.map((p) => p[1]);
    expect(Math.max(...ys)).toBeLessThanOrEqual(20); // stays within the data — no phantom crossings
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it('splitAtX interpolates the join so both halves meet at x (seamless divider)', () => {
    const { left, right } = splitAtX([[0, 0], [10, 10], [20, 6]], 5);
    expect(left[left.length - 1]).toEqual([5, 5]); // white ends exactly at the divider
    expect(right[0]).toEqual([5, 5]); // colour begins exactly at the divider — no kink
    expect(right[right.length - 1]).toEqual([20, 6]); // rest of today intact
  });
});

describe('imageshow module', () => {
  it('imageshow exposes the shared viewer + slideshow', async () => {
    const m = await import('../site/js/imageshow.js');
    expect(typeof m.createSlideshow).toBe('function');
    expect(typeof m.openImageViewer).toBe('function');
    // swipeAction is NOT here any more: the gesture rule belongs to gesture.js,
    // and the image surface is one of its callers like everybody else.
    expect(m.swipeAction).toBeUndefined();
  });
});

describe('newscore module', () => {
  it('newscore exposes the shared news engine', async () => {
    const m = await import('../site/js/widgets/newscore.js');
    for (const fn of ['parseRss', 'mergeNews', 'ageLabel', 'renderHeadlines', 'fetchHeadlines']) {
      expect(typeof m[fn]).toBe('function');
    }
  });
});

describe('viewer caption meta — photos vs art', () => {
  beforeAll(() => {
    document.querySelector('#art-viewer')?.remove();
  });
  afterAll(() => {
    document.querySelector('#art-viewer')?.remove();
  });

  it('photo item (no artist) shows the title with no meta line — and no "undefined"', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const photo = { img: 'https://x.test/photo.jpg', title: 'Sunset', date: '2024-06-01', ar: 1.78 };
    openImageViewer(photo, CFG, { list: [photo] });
    const viewer = document.querySelector('#art-viewer');
    const cap = viewer.querySelector('.slide-caption');
    expect(cap.querySelector('.slide-caption__title').textContent).toBe('Sunset');
    // The meta span is dropped, not emitted blank: a childful-but-textless box
    // defeats `.slide-caption:empty` and paints as a grey rectangle.
    expect(viewer.querySelector('.slide-caption__meta')).toBeNull();
    expect(cap.textContent).not.toContain('undefined');
  });

  it('untitled photo (Landscapes/GDrive) renders NO caption box at all', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    // mapPhotos gives an uncaptioned GDrive file title:'' and no artist.
    const photo = { img: 'https://x.test/landscape.jpg', title: '', ar: 1.78 };
    openImageViewer(photo, CFG, { list: [photo], fit: 'cover' });
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.querySelector('.slide-caption')).toBeNull();
    expect(viewer.querySelector('.slide-caption__title')).toBeNull();
    expect(viewer.querySelector('.strip')).not.toBeNull(); // the info band is untouched
  });

  it('whitespace-only caption fields count as no caption', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const photo = { img: 'https://x.test/blank.jpg', title: '   ', artist: ' ', desc: '\n ', ar: 1.5 };
    openImageViewer(photo, CFG, { list: [photo] });
    expect(document.querySelector('#art-viewer').querySelector('.slide-caption')).toBeNull();
  });

  it('missing title/artist entirely renders no caption box', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const photo = { img: 'https://x.test/bare.jpg', ar: 1.5 };
    openImageViewer(photo, CFG, { list: [photo] });
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.querySelector('.slide-caption')).toBeNull();
    expect(viewer.querySelector('.art-viewer__img').getAttribute('alt')).toBe(''); // not "undefined"
  });

  it('apod-style desc still renders its clamped third line', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const apod = { img: 'https://x.test/apod.jpg', title: 'Andromeda', artist: 'NASA', desc: 'A spiral galaxy.' };
    openImageViewer(apod, CFG, { list: [apod] });
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.querySelector('.slide-caption__title').textContent).toBe('Andromeda');
    expect(viewer.querySelector('.slide-caption__meta').textContent).toBe('NASA');
    expect(viewer.querySelector('.slide-caption__desc').textContent).toBe('A spiral galaxy.');
  });

  it('a desc-only item still gets its box (content, not title, decides)', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const item = { img: 'https://x.test/d.jpg', title: '', desc: 'Explanation only.' };
    openImageViewer(item, CFG, { list: [item] });
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.querySelector('.slide-caption')).not.toBeNull();
    expect(viewer.querySelector('.slide-caption__title')).toBeNull();
    expect(viewer.querySelector('.slide-caption__desc').textContent).toBe('Explanation only.');
  });

  it('caption:false (chart) never builds a caption box', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const chart = { img: 'https://x.test/chart.png', title: 'Chart of the Day', artist: 'Statista', desc: 'why' };
    openImageViewer(chart, CFG, { list: [chart], caption: false, strip: false });
    expect(document.querySelector('#art-viewer').querySelector('.slide-caption')).toBeNull();
  });

  it('art item (with artist) still renders artist · year in meta', async () => {
    vi.resetModules();
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const artwork = { img: 'https://x.test/art.jpg', title: 'Wheat Fields', artist: 'Jacob van Ruisdael', year: '1670', ar: 1.5 };
    openImageViewer(artwork, CFG, { list: [artwork] });
    const viewer = document.querySelector('#art-viewer');
    const meta = viewer.querySelector('.slide-caption__meta');
    expect(meta.textContent).toBe('Jacob van Ruisdael · 1670');
  });
});

// The swap path is the sneaky one: it updates the open viewer in place, so a
// mixed album could leave a captioned box stranded (or emptied) over a photo
// that has no caption of its own.
describe('viewer caption on the swipe/swap path', () => {
  beforeAll(() => {
    // Fresh element so its listeners bind to this module instance's step().
    document.querySelector('#art-viewer')?.remove();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    document.querySelector('#art-viewer')?.remove();
  });

  it('drops the box swapping captioned → uncaptioned, and restores it swapping back', async () => {
    vi.resetModules();
    vi.stubGlobal('Image', class { set src(v) { queueMicrotask(() => this.onload?.()); } });
    const { openImageViewer } = await import('../site/js/imageshow.js');
    const artwork = { img: 'https://x.test/art.jpg', title: 'Wheat Fields', artist: 'Ruisdael', year: '1670' };
    const bare = { img: 'https://x.test/bare.jpg', title: '', ar: 1.78 };
    openImageViewer(artwork, CFG, { list: [artwork, bare] });
    const viewer = document.querySelector('#art-viewer');
    expect(viewer.querySelector('.slide-caption__title').textContent).toBe('Wheat Fields');

    const swipe = (fromX, toX) => {
      viewer.dispatchEvent(new MouseEvent('pointerdown', { clientX: fromX, clientY: 100 }));
      viewer.dispatchEvent(new MouseEvent('pointerup', { clientX: toX, clientY: 104 }));
      return new Promise((r) => setTimeout(r, 420)); // preload + the 380ms dark beat (swipeFadeThrough)
    };

    await swipe(600, 400); // next: the untitled photo
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/bare.jpg');
    expect(viewer.querySelector('.slide-caption')).toBeNull(); // no stale box, no empty box
    expect(viewer.textContent).not.toContain('Wheat Fields');

    await swipe(600, 400); // wraps back to the artwork
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/art.jpg');
    const cap = viewer.querySelector('.slide-caption');
    expect(cap).not.toBeNull(); // the box comes back
    expect(cap.querySelector('.slide-caption__title').textContent).toBe('Wheat Fields');
    expect(cap.querySelector('.slide-caption__meta').textContent).toBe('Ruisdael · 1670');
    // A re-created caption stays ahead of the info band it must not cover.
    const kids = [...viewer.children].map((n) => n.className);
    expect(kids.indexOf('slide-caption')).toBeLessThan(kids.indexOf('strip'));
    expect(viewer.querySelectorAll('.slide-caption').length).toBe(1); // never duplicated
    expect(viewer.querySelectorAll('.strip').length).toBe(1); // the strip is untouched
  });
});

describe('art fullscreen swipes via artList', () => {
  beforeAll(() => {
    // Remove any #art-viewer left by earlier tests so the fresh module instance
    // gets its own element with event listeners bound to its own step closure.
    document.querySelector('#art-viewer')?.remove();
  });
  afterAll(() => {
    document.querySelector('#art-viewer')?.remove();
  });

  it('art fullscreen browses the whole filtered manifest after fetchData', async () => {
    // Reset modules so this test gets fresh manifestCache / artList state,
    // independent of any previous test that may have already cached a manifest.
    vi.resetModules();
    const artFresh = await import('../site/js/widgets/art.js');
    const list = [
      DEMO_VMS.art,
      { img: 'https://x.test/artlist.jpg', title: 'ArtList Work', artist: 'AL', year: '1902', ar: 1.5 },
    ];
    vi.stubGlobal('Image', class { set src(v) { queueMicrotask(() => this.onload?.()); } });
    // fetchData populates artList; render's click handler passes it to openImageViewer.
    await artFresh.fetchData({ art: {} }, { fetchJSON: async () => list });
    const host = el();
    artFresh.render(host, DEMO_VMS.art, CFG);
    host.querySelector('.artwork').click();
    const viewer = document.querySelector('#art-viewer');
    const swipe = (fromX, toX) => {
      viewer.dispatchEvent(new MouseEvent('pointerdown', { clientX: fromX, clientY: 100 }));
      viewer.dispatchEvent(new MouseEvent('pointerup', { clientX: toX, clientY: 104 }));
      return new Promise((r) => setTimeout(r, 420)); // preload + the 380ms dark beat (swipeFadeThrough)
    };
    await swipe(600, 400); // swipe left → next
    expect(viewer.querySelector('.art-viewer__img').getAttribute('src')).toBe('https://x.test/artlist.jpg');
    expect(viewer.textContent).toContain('ArtList Work');
    vi.unstubAllGlobals();
  });
});

describe('fmtTemp', () => {
  it('passes Fahrenheit through and converts to Celsius (rounded)', () => {
    expect(weather.fmtTemp(84, 'F')).toBe('84°');
    expect(weather.fmtTemp(84, 'C')).toBe('29°');   // (84-32)*5/9 = 28.9 → 29
    expect(weather.fmtTemp(32, 'C')).toBe('0°');
    expect(weather.fmtTemp(212, 'C')).toBe('100°');
    expect(weather.fmtTemp(70, 'F')).toBe('70°');
  });
});

describe('weather render honors cfg.loc.units', () => {
  const vm = {
    now: { temp: 84, feels: 92, code: 0, label: 'Clear', icon: 'sun' },
    hourly: [{ h: '1 PM', temp: 80, code: 0 }],
    daily: [{ day: 'Mon', hi: 88, lo: 70, code: 0 }],
    sunrise: '2026-07-06T05:30', sunset: '2026-07-06T20:30', alert: null,
  };
  it('renders Celsius when cfg.loc.units is C', async () => {
    const el = document.createElement('div');
    weather.render(el, vm, { loc: { units: 'C' } });
    expect(el.textContent).toContain('29°');   // 84°F → 29°C
    expect(el.textContent).not.toContain('84°');
  });
});

describe('f1 render', () => {
  it('renders next race, podium, and both standings from the demo VM', () => {
    const el = document.createElement('div');
    f1.render(el, DEMO_VMS.f1, CFG);
    // Next race as heading + date/location beneath it.
    expect(el.textContent).toContain('Belgian Grand Prix');
    expect(el.textContent).toContain('Spa-Francorchamps');
    // Previous-race podium.
    expect(el.textContent).toContain('British Grand Prix');
    expect(el.textContent).toContain('Leclerc');
    expect(el.textContent).toContain('Russell');
    expect(el.textContent).toContain('Hamilton');
    // Driver + constructor standings.
    expect(el.textContent).toContain('Antonelli');
    expect(el.textContent).toContain('Mercedes');
    expect(el.textContent).toContain('Ferrari');
    // Team-color dots and a driver country flag.
    expect(el.querySelector('.f1-dot')).toBeTruthy();
    expect(el.querySelector('.f1-flag')).toBeTruthy();
  });

  it('falls back to the raw team name when the constructorId is unknown', () => {
    const el = document.createElement('div');
    const vm = {
      updatedAt: 1783000000, stale: false, next: null, lastRace: null, podium: null,
      drivers: [{ pos: 1, name: 'Doe', nat: 'British', cid: 'brand_new_team', pts: 10 }],
      teams: [{ pos: 1, cid: 'brand_new_team', name: 'Brand New Team', pts: 10 }],
    };
    f1.render(el, vm, CFG);
    expect(el.textContent).toContain('Doe');
    expect(el.textContent).toContain('Brand New Team');
  });

  it('shows a non-empty state when there is no data', () => {
    const el = document.createElement('div');
    f1.render(el, { updatedAt: 0, stale: false, next: null, lastRace: null, podium: null, drivers: [], teams: [] }, CFG);
    expect(el.textContent.length).toBeGreaterThan(0);
  });
});

describe('golf render', () => {
  it('renders the leaderboard from the demo VM', () => {
    const el = document.createElement('div');
    golf.render(el, DEMO_VMS.golf, CFG);
    expect(el.textContent).toContain('S. Burns');
    expect(el.textContent).toContain('-10');
    expect(el.querySelector('.golf-row__score--under')).toBeTruthy();
    expect(el.querySelectorAll('.golf-row').length).toBeGreaterThan(3);
  });

  it('shows the start date when the tournament has not begun', () => {
    const el = document.createElement('div');
    golf.render(el, { name: 'Travelers Championship', state: 'pre', startsAt: Date.UTC(2026, 6, 24), round: null, players: [] }, CFG);
    expect(el.textContent).toContain('Travelers Championship');
    expect(el.textContent).toContain('Starts Jul');
  });

  it('shows a non-empty state with no tournament', () => {
    const el = document.createElement('div');
    golf.render(el, { name: null, state: 'none', startsAt: null, round: null, players: [] }, CFG);
    expect(el.textContent).toContain('No tournament');
  });
});

describe('tennis render', () => {
  it('renders live, upcoming, and finished matches from the demo VM', () => {
    const el = document.createElement('div');
    tennis.render(el, DEMO_VMS.tennis, CFG);
    expect(el.textContent).toContain('C. Alcaraz vs A. Zverev');
    expect(el.textContent).toContain('6-4, 3-2');
    expect(el.querySelector('.tennis-row--live')).toBeTruthy();
    expect(el.querySelector('img.tennis-row__flag')).toBeTruthy();
    // Finished match uses defeated notation with the winner first.
    expect(el.textContent).toContain('M. Bulgaru d. V. Strakhova');
    // Upcoming match shows its start detail, not a score.
    expect(el.textContent).toContain('3:00 PM');
  });

  it('shows a non-empty state with no matches', () => {
    const el = document.createElement('div');
    tennis.render(el, { name: null, rows: [] }, CFG);
    expect(el.textContent).toContain('No tournament');
  });
});

describe('iptv render', () => {
  it('shows the tappable setup prompt when no stream is configured', () => {
    const el = document.createElement('div');
    iptv.render(el, { url: '', label: '' }, CFG);
    expect(el.querySelector('[data-setup="iptv"]')).toBeTruthy();
    expect(el.textContent).toContain('add a stream');
  });

  it('plays a progressive .mp4 stream directly (no hls.js), not an iframe', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    try {
      iptv.render(el, { url: 'https://go2rtc.test/api/stream.mp4?src=front_door_med', label: 'Cam' }, CFG);
      const video = el.querySelector('video.iptv__video');
      expect(video).toBeTruthy();
      expect(video.getAttribute('src')).toBe('https://go2rtc.test/api/stream.mp4?src=front_door_med'); // direct src, no hls
      expect(el.querySelector('iframe')).toBeNull();
    } finally {
      iptv.render(el, { url: '', label: '' }, CFG);
      el.remove();
    }
  });

  it('isHlsUrl only matches .m3u8 playlists', () => {
    expect(iptv.isHlsUrl('https://x.test/a.m3u8')).toBe(true);
    expect(iptv.isHlsUrl('https://x.test/a.m3u8?src=cam')).toBe(true);
    expect(iptv.isHlsUrl('https://go2rtc.test/api/stream.mp4?src=cam')).toBe(false);
    expect(iptv.isHlsUrl('https://x.test/feed.mp4')).toBe(false);
  });

  it('mounts a UniFi share link as an iframe with a working expand toggle', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    try {
      iptv.render(el, { url: 'https://monitor.ui.com/e1d0e73e-8d15-4ab0-8c25-27bdc824b8be', label: 'Cam' }, CFG);
      expect(el.querySelector('video')).toBeNull();
      const frame = el.querySelector('iframe.iptv__frame');
      expect(frame).toBeTruthy();
      expect(frame.getAttribute('allow')).toContain('autoplay');
      const btn = el.querySelector('.iptv__expand');
      btn.click();
      expect(el.querySelector('.iptv--full')).toBeTruthy(); // CSS full screen, no reparent
      expect(el.querySelector('iframe')).toBe(frame); // same iframe: no reload
      btn.click();
      expect(el.querySelector('.iptv--full')).toBeNull();
      // Swapping to an HLS url tears the frame down for the video path.
      iptv.render(el, { url: 'https://x.test/c.m3u8', label: '' }, CFG);
      expect(el.querySelector('iframe')).toBeNull();
      expect(el.querySelector('video')).toBeTruthy();
    } finally {
      iptv.render(el, { url: '', label: '' }, CFG);
      el.remove();
    }
  });

  it('isCameraShare matches only monitor.ui.com links', () => {
    expect(iptv.isCameraShare('https://monitor.ui.com/abc')).toBe(true);
    expect(iptv.isCameraShare('https://evil.test/monitor.ui.com')).toBe(false);
    expect(iptv.isCameraShare('https://x.test/a.m3u8')).toBe(false);
    expect(iptv.isCameraShare('not a url')).toBe(false);
  });

  it('tap toggles full screen with a muted-by-default mute control', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    try {
      iptv.render(el, { url: 'https://x.test/fs.m3u8', label: '' }, CFG);
      const wrap = el.querySelector('.iptv');
      const video = el.querySelector('video');
      video.src = 'https://x.test/fs.m3u8'; // stand in for a live connection
      wrap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // Full screen is CSS-only IN PLACE: the wrap stays inside the card (never
      // reparented to body), so the video node and its live src are untouched.
      expect(wrap.classList.contains('iptv--full')).toBe(true);
      expect(el.contains(video)).toBe(true); // never left the card
      expect(video.getAttribute('src')).toBe('https://x.test/fs.m3u8'); // connection intact
      const btn = wrap.querySelector('.iptv__mute');
      expect(btn).toBeTruthy();
      expect(video.muted).toBe(true); // muted by default even in full screen
      // A real tap lands on the inner glyph, not the button. The click must
      // unmute AND stay full screen (not bubble to the wrap's exit handler).
      btn.querySelector('svg').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(video.muted).toBe(false); // glyph unmutes
      expect(wrap.classList.contains('iptv--full')).toBe(true); // did NOT exit full screen
      wrap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(wrap.classList.contains('iptv--full')).toBe(false);
      expect(el.contains(video)).toBe(true); // still the same node, still in the card
      expect(video.getAttribute('src')).toBe('https://x.test/fs.m3u8'); // still intact
      expect(video.muted).toBe(true); // sound never returns to the dashboard
    } finally {
      iptv.render(el, { url: '', label: '' }, CFG); // tear down the mount
      el.remove();
    }
  });

  it('tears the stream down in ambient mode and remounts on return', () => {
    // Driven through the ambient engine rather than by faking the body class:
    // the mode is the engine's to publish and the widget's to ask about. The
    // shell is index.html's ambient nodes, which the engine addresses by id;
    // the clock face is the source that needs no manifest and no network.
    const shell = document.createElement('div');
    shell.innerHTML = `
      <section id="grid"></section>
      <section id="ambient" hidden>
        <div id="backdrop" hidden></div>
        <div id="slideshow"></div>
        <div id="clockface" hidden></div>
        <div id="strip"></div>
      </section>`;
    document.body.appendChild(shell);
    const ambientCfg = { screensaver: { source: 'clock', strip: false, backdrop: false } };
    const el = document.createElement('div');
    document.body.appendChild(el);
    try {
      iptv.render(el, { url: 'https://x.test/b.m3u8', label: '' }, CFG);
      expect(el.querySelector('video')).toBeTruthy();
      setMode('ambient', ambientCfg);
      iptv.render(el, { url: 'https://x.test/b.m3u8', label: '' }, CFG);
      expect(el.querySelector('video')).toBeNull();
      setMode('dashboard', ambientCfg);
      iptv.render(el, { url: 'https://x.test/b.m3u8', label: '' }, CFG);
      expect(el.querySelector('video')).toBeTruthy();
    } finally {
      setMode('dashboard', ambientCfg);
      el.remove();
      shell.remove();
    }
  });

  it('mounts a muted video shell for a configured stream and survives re-render', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    try {
      iptv.render(el, { url: 'https://x.test/a.m3u8', label: 'Cam' }, CFG);
      const video = el.querySelector('video.iptv__video');
      expect(video).toBeTruthy();
      expect(video.hasAttribute('muted')).toBe(true);
      // Same URL re-render must NOT tear down the playing stream.
      iptv.render(el, { url: 'https://x.test/a.m3u8', label: 'Cam' }, CFG);
      expect(el.querySelector('video')).toBe(video);
      // A cleared URL tears it down and returns to the prompt.
      iptv.render(el, { url: '', label: '' }, CFG);
      expect(el.querySelector('video')).toBeNull();
      expect(el.querySelector('[data-setup="iptv"]')).toBeTruthy();
    } finally {
      el.remove();
    }
  });
});

describe('amtrak render', () => {
  const now = Math.floor(Date.now() / 1000);
  const vm = {
    station: 'NYP', updatedAt: now, stale: false,
    alerts: [{ header: 'Reduced weekend service on the Northeast Regional.' }],
    departures: [
      { t: now + 720, sch: now + 720, dest: 'Washington', destCode: 'WAS', route: 'Northeast Regional', num: '171', status: 'On time', platform: null,
        stops: [['PHL', now + 4980], ['WAS', now + 9600]] },
      { t: now + 2280, sch: now + 2280, dest: 'Boston South', destCode: 'BOS', route: 'Acela', num: '2151', status: '5 min late', platform: '7',
        stops: [['NHV', now + 5000]] },
    ],
  };

  it('shows terminus, train, platform and an alert row when unfiltered', () => {
    const el = document.createElement('div');
    amtrak.render(el, vm, { amtrak: { dest: '', alerts: true } });
    expect(el.textContent).toContain('Washington');
    expect(el.textContent).toContain('Northeast Regional');
    expect(el.textContent).toContain('171');
    expect(el.textContent).toContain('Trk 7'); // platform shown when present
    expect(el.querySelector('.talert')).toBeTruthy();
    expect(el.querySelector('.train__status.is-warn')).toBeTruthy(); // "5 min late"
  });

  it('filters to trains that serve the chosen destination and drops the rest', () => {
    const el = document.createElement('div');
    amtrak.render(el, { ...vm, destName: 'Philadelphia' }, { amtrak: { dest: 'PHL', alerts: true } });
    expect(el.textContent).toContain('Northeast Regional'); // 171 serves PHL downstream
    expect(el.textContent).not.toContain('Acela'); // 2151 does not stop at PHL
    expect(el.textContent).toContain('Arrives'); // shows arrival time at the chosen stop
  });

  it('hides alert rows when the alerts toggle is off', () => {
    const el = document.createElement('div');
    amtrak.render(el, vm, { amtrak: { dest: '', alerts: false } });
    expect(el.querySelector('.talert')).toBeNull();
  });

  it('shows an empty state when there are no departures', () => {
    const el = document.createElement('div');
    amtrak.render(el, { station: 'NYP', updatedAt: now, stale: false, alerts: [], departures: [] }, { amtrak: { dest: '', alerts: true } });
    expect(el.textContent).toContain('No departures');
  });
});

// F08: the expanded reading list is labelled by the date the events are FOR
// (stamped into the vm by fetchData), not the day the card happens to be tapped.
// A board left on across midnight still shows yesterday's rows until the next
// fetch, and labelling them "today" is exactly the mismatch this closes.
describe('history labels its expanded view by the events’ date', () => {
  const overlayNote = () => document.querySelector('#expand-view .expand__note')?.textContent ?? '';

  it('reads the stamped date, not the wall clock at tap time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 4, 0, 30)); // it is now Sept 4, just past midnight
    const janFifteen = new Date(2026, 0, 15, 12, 0).getTime(); // but these events are Jan 15's
    const vm = { events: [{ year: 1776, text: 'Continental Congress convenes.' }], date: janFifteen };
    const { card } = board(history, { rect: { w: 6, h: 2 }, vm });
    card.querySelector('.card__body').click(); // open the grand reading list
    expect(overlayNote()).toBe('January 15');
    vi.useRealTimers();
  });
});
