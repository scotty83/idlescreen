import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  meta, mapWeather, wmoInfo, inUS, fetchData, trendSvg,
  hourLabel, timeLabel, compass, fmtWind, fmtAmount, meteoBoard, meteoCanvas,
} from '../site/js/widgets/weather.js';
import { mapAqi, moonPhase } from '../site/js/widgets/aqi.js';
import { DEMO_VMS } from '../site/demo/fixtures.js';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// F09: the weather cache fingerprint keys on location alone. A move is a new
// source (refetch), a unit or label change is presentation (re-render).
describe('weather cache fingerprint inputs', () => {
  const nyc = { loc: { lat: 40.71, lon: -73.99, units: 'F', label: 'New York' } };
  it('keys on lat/lon only, excluding units and label', () => {
    expect(meta.cacheInputs(nyc)).toEqual({ lat: 40.71, lon: -73.99 });
    const unitsChanged = { loc: { ...nyc.loc, units: 'C', label: 'NYC métrique' } };
    expect(meta.cacheInputs(unitsChanged)).toEqual({ lat: 40.71, lon: -73.99 });
  });
  it('changes when the board moves', () => {
    const chicago = { loc: { lat: 41.88, lon: -87.63, units: 'F', label: 'Chicago' } };
    expect(meta.cacheInputs(chicago)).toEqual({ lat: 41.88, lon: -87.63 });
  });
});

describe('mapWeather', () => {
  it('maps the open-meteo fixture', async () => {
    const vm = mapWeather(await fixture('open-meteo-forecast.json'), null);
    expect(vm.now.temp).toBe(83); // 82.9 rounded
    expect(vm.now.feels).toBe(92);
    expect(vm.now.label).toBe('Clear');
    // A full day of hours is kept for the tap-for-detail view; the card slices
    // the first 6-8 off the front of the same array.
    expect(vm.hourly).toHaveLength(24);
    // current.time is 02:15 → first hourly slot is 03:00 (next full hour)
    expect(vm.hourly[0].h).toBe('3 AM');
    // This fixture predates forecast_days=7, so it carries 6 days — and the
    // mapper no longer slices, it keeps whatever the payload has.
    expect(vm.daily).toHaveLength(6);
    expect(vm.daily[0].hi).toBe(105);
    expect(vm.daily[0].lo).toBe(80);
    expect(vm.sunrise).toBe('2026-07-02T05:28');
    expect(vm.sunset).toBe('2026-07-02T20:30');
    expect(vm.alert).toBeNull();
  });

  it('surfaces the most severe active alert', async () => {
    const vm = mapWeather(
      await fixture('open-meteo-forecast.json'),
      await fixture('nws-alerts.json'),
    );
    expect(vm.alert).not.toBeNull();
    expect(vm.alert.event).toMatch(/Heat/);
    expect(typeof vm.alert.headline).toBe('string');
  });

  it('never banners a CAP test, exercise, or cancellation as a live warning', async () => {
    // The real payload from 2026-08-11: the National Tsunami Warning Center's
    // routine communications test carries status "Test" and severity
    // "Extreme", and the word TEST appears only in the headline the banner
    // does not show. It outranked everything and real boards read
    // "Tsunami Warning" over Manhattan.
    const props = (over) => ({
      event: 'Tsunami Warning', severity: 'Extreme', status: 'Actual',
      messageType: 'Alert', headline: 'TEST Tsunami Warning until 1:25PM EDT', ...over,
    });
    const forecast = await fixture('open-meteo-forecast.json');
    for (const fake of [{ status: 'Test' }, { status: 'Exercise' }, { messageType: 'Cancel' }]) {
      expect(mapWeather(forecast, { features: [{ properties: props(fake) }] }).alert).toBeNull();
    }
    // And the same alert marked Actual still banners: the filter is about
    // status, not about tsunamis.
    const vm = mapWeather(forecast, { features: [{ properties: props({}) }] });
    expect(vm.alert?.event).toBe('Tsunami Warning');
  });

  it('carries the hourly chance of precipitation', async () => {
    const vm = mapWeather(await fixture('open-meteo-forecast.json'), null);
    expect(vm.hourly.slice(0, 8).map((x) => x.pp)).toEqual([0, 0, 5, 10, 25, 45, 60, 30]);
  });

  it('nulls the chance of precipitation when the payload lacks it', async () => {
    const forecast = await fixture('open-meteo-forecast.json');
    delete forecast.hourly.precipitation_probability;
    const vm = mapWeather(forecast, null);
    expect(vm.hourly).toHaveLength(24);
    expect(vm.hourly.every((x) => x.pp === null)).toBe(true);
    // A payload that carries the key but runs short (partial response) also
    // nulls out rather than leaking undefined/NaN into the markup.
    const short = await fixture('open-meteo-forecast.json');
    short.hourly.precipitation_probability = [0, 0, 0, 0, 0];
    expect(mapWeather(short, null).hourly.slice(0, 8).map((x) => x.pp))
      .toEqual([0, 0, null, null, null, null, null, null]);
  });

  it('keeps the full-view extras from the same single call', async () => {
    const vm = mapWeather(await fixture('open-meteo-full-nyc.json'), null);
    // current: the four fields that ride the block the card's temp comes from.
    expect(vm.now.humidity).toBe(68);
    expect(vm.now.wind).toBe(14);
    expect(vm.now.dir).toBe(148);
    expect(vm.now.gust).toBeCloseTo(18.8, 5);
    // hourly: an iso stamp (so the hour label can follow cfg.clock24, and the
    // night wash can find the right day) and the amount actually falling.
    expect(vm.hourly).toHaveLength(24);
    expect(vm.hourly[0].iso).toBe('2026-07-28T16:00'); // current.time 15:15 → next full hour
    expect(vm.hourly[0].h).toBe('4 PM');
    expect(vm.hourly.every((x) => Number.isFinite(x.precip))).toBe(true);
    // daily: the full 7-day horizon, each day carrying its own sun times.
    expect(vm.daily).toHaveLength(7);
    expect(vm.daily.map((d) => d.day)).toEqual(['Today', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']);
    expect(vm.daily[0].ppMax).toBe(59);
    expect(vm.daily[0].uvMax).toBeCloseTo(4.15, 5);
    expect(vm.daily[0].precipSum).toBeCloseTo(0.059, 5);
    expect(vm.daily[0].windMax).toBeCloseTo(16.9, 5);
    expect(vm.daily[0].sunrise).toBe('2026-07-28T05:49');
    expect(vm.daily[6].sunset).toBe('2026-08-03T20:09');
  });

  it('degrades every extra to null on a payload that predates them', async () => {
    // Exactly the situation on a board that boots the new build against a vm the
    // OLD build cached: the fields simply are not there, and nothing may become
    // NaN or undefined.
    const vm = mapWeather(await fixture('open-meteo-forecast.json'), null);
    for (const k of ['humidity', 'wind', 'dir', 'gust']) expect(vm.now[k]).toBeNull();
    for (const k of ['ppMax', 'uvMax', 'precipSum', 'windMax']) expect(vm.daily[0][k]).toBeNull();
    expect(vm.hourly.every((x) => x.precip === 0)).toBe(true);
    expect(vm.daily[0].sunrise).toBe('2026-07-02T05:28'); // this one WAS already requested
  });

  it('tolerates malformed alerts payloads', async () => {
    const forecast = await fixture('open-meteo-forecast.json');
    expect(mapWeather(forecast, {}).alert).toBeNull();
    expect(mapWeather(forecast, { features: 'nope' }).alert).toBeNull();
  });
});

describe('wmoInfo', () => {
  it('maps representative codes', () => {
    expect(wmoInfo(0)).toEqual({ label: 'Clear', icon: 'clear' });
    expect(wmoInfo(3).label).toBe('Overcast');
    expect(wmoInfo(45).icon).toBe('fog');
    expect(wmoInfo(63).icon).toBe('rain');
    expect(wmoInfo(75).icon).toBe('snow');
    expect(wmoInfo(95).icon).toBe('thunder');
    expect(wmoInfo(9999)).toEqual({ label: '—', icon: 'clear' });
  });
});

describe('trendSvg domain window', () => {
  // The line path's y span, in viewBox units. The drawing band is TOP..BOT =
  // 14..86, so 72 units is a curve that fills the chart top to bottom.
  const SPAN = 72;
  const yExtent = (svg) => {
    const d = svg.match(/class="wx-trend__line" d="([^"]+)"/)[1];
    const ys = d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number)
      .filter((_, i) => i % 2 === 1);
    return Math.max(...ys) - Math.min(...ys);
  };
  // The user's own calm night: 4 degrees of drift across the strip.
  const FLAT = [69, 68, 68, 67, 66, 66, 65, 67];

  it('keeps a flat night calm as the chart grows (window 6/10/14/18 by tier)', () => {
    // Default (h <= 5, 100px chart): unchanged, 4 degrees over a 6-degree
    // window is most of the band.
    expect(yExtent(trendSvg(FLAT, 'g'))).toBeCloseTo(44.25, 1);
    expect(yExtent(trendSvg(FLAT, 'g', 6))).toBeCloseTo(44.25, 1);
    // Taller tiers widen the window in step with the CSS chart-height ladder,
    // so the same drift stops reading as a plunge.
    expect(yExtent(trendSvg(FLAT, 'g', 10))).toBeCloseTo(26.55, 1); // h=6
    expect(yExtent(trendSvg(FLAT, 'g', 14))).toBeCloseTo(18.97, 1); // h=7
    expect(yExtent(trendSvg(FLAT, 'g', 18))).toBeCloseTo(14.75, 1); // h=8
    // At the tallest tier the calm night uses a fifth of the band, not two thirds.
    expect(yExtent(trendSvg(FLAT, 'g', 18)) / SPAN).toBeLessThan(0.25);
    expect(yExtent(trendSvg(FLAT, 'g', 6)) / SPAN).toBeGreaterThan(0.55);
  });

  it('leaves a real swing byte-identical at every tier', () => {
    // 20 degrees exceeds even the widest window, so the domain is the actual
    // range +/- 1 and the path must not move at all.
    const swing = [58, 62, 67, 72, 76, 78, 71, 63];
    const base = trendSvg(swing, 'g');
    for (const mw of [6, 10, 14, 18]) expect(trendSvg(swing, 'g', mw)).toBe(base);
  });
});

describe('mapAqi', () => {
  it('maps AQI value, category and its own sun times', async () => {
    // Sun times come from the widget's own forecast call, not the weather
    // widget's cache (which may not exist or may be disabled entirely).
    const sunJson = await fixture('open-meteo-forecast.json');
    const vm = mapAqi(await fixture('open-meteo-aq.json'), sunJson, new Date('2026-07-02T12:00:00'));
    expect(vm.aqi).toBe(66);
    expect(vm.category).toBe('Moderate');
    expect(vm.sunrise).toBe('2026-07-02T05:28');
    expect(vm.sunset).toBe('2026-07-02T20:30');
    expect(vm.uv).toBe(5); // CURRENT uv (4.6 rounded), not the daily max
    expect(vm.moonPhase.name).toBeTypeOf('string');
  });

  it('falls back to the daily max when the current uv reading is missing', () => {
    const sun = { daily: { sunrise: ['x'], sunset: ['x'], uv_index_max: [7.8] } };
    expect(mapAqi({ current: { us_aqi: 40 } }, sun, new Date('2026-07-02')).uv).toBe(8);
  });

  it('degrades to null sun times when the forecast call fails', async () => {
    const vm = mapAqi(await fixture('open-meteo-aq.json'), null, new Date('2026-07-02T12:00:00'));
    expect(vm.aqi).toBe(66);
    expect(vm.sunrise).toBeNull();
    expect(vm.sunset).toBeNull();
  });

  it('categorizes boundaries', async () => {
    const aq = (v) => ({ current: { us_aqi: v } });
    const d = new Date('2026-07-02');
    expect(mapAqi(aq(50), null, d).category).toBe('Good');
    expect(mapAqi(aq(101), null, d).category).toBe('Sensitive groups');
    expect(() => mapAqi({ current: { us_aqi: null } }, null, d)).toThrow();
    expect(() => mapAqi({ current: {} }, null, d)).toThrow();
    expect(mapAqi(aq(101), null, d).uv).toBeNull();
    expect(mapAqi(aq(40), { daily: { uv_index_max: [6.4] } }, d).uv).toBe(6);
    expect(mapAqi(aq(250), null, d).category).toBe('Very Unhealthy');
  });
});

describe('moonPhase', () => {
  it('finds the new moon on 2026-01-18', () => {
    const p = moonPhase(new Date(Date.UTC(2026, 0, 18, 20, 0)));
    expect(p.fraction).toBeLessThan(0.04);
    expect(p.name).toBe('New Moon');
  });
  it('finds the full moon on 2026-02-01', () => {
    const p = moonPhase(new Date(Date.UTC(2026, 1, 1, 22, 0)));
    expect(Math.abs(p.fraction - 0.5)).toBeLessThan(0.02);
    expect(p.name).toBe('Full Moon');
  });
});

describe('inUS + alerts gating', () => {
  it('covers NYC, Honolulu, Anchorage; excludes London and Berlin', () => {
    expect(inUS(40.75, -73.99)).toBe(true);
    expect(inUS(21.3, -157.8)).toBe(true);
    expect(inUS(61.2, -149.9)).toBe(true);
    expect(inUS(51.5, -0.12)).toBe(false);
    expect(inUS(52.52, 13.4)).toBe(false);
  });
  it('fetchData skips the NWS alerts call for a non-US point', async () => {
    const urls = [];
    const net = { fetchJSON: async (u) => { urls.push(u); return EMPTY_FORECAST; } };
    await fetchData({ loc: { lat: 51.5, lon: -0.12, units: 'C' } }, net);
    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain('api.weather.gov');
  });
  it('asks for the whole board in ONE call, in canonical units', async () => {
    const urls = [];
    const net = { fetchJSON: async (u) => { urls.push(u); return EMPTY_FORECAST; } };
    await fetchData({ loc: { lat: 51.5, lon: -0.12, units: 'C' } }, net);
    const [url] = urls;
    expect(url).toContain('&current=temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
    expect(url).toContain('&hourly=temperature_2m,weather_code,precipitation_probability,precipitation');
    expect(url).toContain('&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max,precipitation_sum,wind_speed_10m_max');
    expect(url).toContain('&forecast_days=7');
    // Canonical units, converted per cfg at render — a metric board asks for the
    // same numbers as an imperial one.
    expect(url).toContain('&temperature_unit=fahrenheit');
    expect(url).toContain('&wind_speed_unit=mph');
    expect(url).toContain('&precipitation_unit=inch');
    // Open-Meteo weights a request by its variable count (weight = vars / 10):
    // 7 current + 4 hourly + 9 daily = 20 → 2.0 weighted calls, and 288 a day at
    // the 10-minute refresh against a free ceiling of 10,000.
    const vars = ['current', 'hourly', 'daily']
      .map((k) => url.match(new RegExp(`&${k}=([^&]+)`))[1].split(',').length)
      .reduce((a, b) => a + b, 0);
    expect(vars).toBe(20);
  });
});

// A structurally valid but data-free forecast: enough for fetchData to map.
const EMPTY_FORECAST = {
  current: { time: '2026-07-12T10:00', temperature_2m: 70, apparent_temperature: 70, weather_code: 0 },
  hourly: { time: [], temperature_2m: [], weather_code: [] },
  daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [], sunrise: ['x'], sunset: ['x'] },
};

describe('clock + unit formatting', () => {
  it('switches hour labels on cfg.clock24, 12-hour by default', () => {
    expect(hourLabel('2026-07-28T00:00')).toBe('12 AM');
    expect(hourLabel('2026-07-28T12:00')).toBe('12 PM');
    expect(hourLabel('2026-07-28T09:00')).toBe('9 AM');
    expect(hourLabel('2026-07-28T21:00')).toBe('9 PM');
    expect(hourLabel('2026-07-28T00:00', true)).toBe('00:00');
    expect(hourLabel('2026-07-28T09:00', true)).toBe('09:00');
    expect(hourLabel('2026-07-28T21:00', true)).toBe('21:00');
  });

  it('formats sun times the same way', () => {
    expect(timeLabel('2026-07-28T05:49')).toBe('5:49 AM');
    expect(timeLabel('2026-07-28T20:15')).toBe('8:15 PM');
    expect(timeLabel('2026-07-28T00:07')).toBe('12:07 AM');
    expect(timeLabel('2026-07-28T12:07')).toBe('12:07 PM');
    expect(timeLabel('2026-07-28T05:49', true)).toBe('05:49');
    expect(timeLabel('2026-07-28T20:15', true)).toBe('20:15');
  });

  it('names the wind direction on 16 points, and wraps at 360', () => {
    expect(compass(0)).toBe('N');
    expect(compass(148)).toBe('SSE');
    expect(compass(205)).toBe('SSW');
    expect(compass(270)).toBe('W');
    expect(compass(350)).toBe('N');
    expect(compass(360)).toBe('N');
  });

  it('converts wind and rain amounts from the canonical unit per cfg', () => {
    expect(fmtWind(14, 'F')).toBe('14 mph');
    expect(fmtWind(14, 'C')).toBe('23 km/h');   // 14 * 1.609344 = 22.5 → 23
    expect(fmtWind(4, 'C')).toBe('6 km/h');
    expect(fmtWind(16.9, 'F')).toBe('17 mph');
    expect(fmtAmount(0.059, 'F')).toBe('0.06 in');
    expect(fmtAmount(0.059, 'C')).toBe('1.5 mm');  // 0.059 * 25.4 = 1.499
    expect(fmtAmount(0, 'F')).toBe('0.00 in');
    expect(fmtAmount(0, 'C')).toBe('0.0 mm');
  });
});

describe('meteoBoard (the tap-for-detail view)', () => {
  const US = { loc: { label: 'New York 10001', units: 'F' } };
  const UK = { loc: { label: 'London, England (GB)', units: 'C' }, clock24: true };
  const nyc = async () => mapWeather(await fixture('open-meteo-full-nyc.json'), null);
  const london = async () => mapWeather(await fixture('open-meteo-full-london.json'), null);
  const cols = (html, cls) => (html.match(new RegExp(`wxf__row--${cls}">(.*?)</div>`, 's'))?.[1] ?? '')
    .split('</span>').slice(0, -1).map((s) => s.replace(/^<span[^>]*>/, ''));

  it('shows a full day of hours, labelled every other column', async () => {
    const html = meteoBoard(await nyc(), US);
    expect(cols(html, 'hours')).toHaveLength(24);
    const labels = cols(html, 'hours').filter(Boolean);
    expect(labels).toEqual(['4 PM', '6 PM', '8 PM', '10 PM', '12 AM', '2 AM',
      '4 AM', '6 AM', '8 AM', '10 AM', '12 PM', '2 PM']);
    // Temps and rain chances print on the SAME columns, so each reading stacks.
    expect(cols(html, 'temp').filter(Boolean)).toHaveLength(12);
    expect(cols(html, 'pp').filter(Boolean)).toHaveLength(12);
    // The curve, the night wash and the rain bars keep all 24 hours, though.
    expect(html).toContain('viewBox="0 0 24 100"');
  });

  it('carries the whole quiet stats band', async () => {
    const html = meteoBoard(await nyc(), US);
    for (const s of ['14 mph SSE</b><span>Wind', '19 mph</b><span>Gusts',
      '68%</b><span>Humidity', '4</b><span>UV max today',
      '0.06 in</b><span>Rain today', '17 mph</b><span>Peak wind today']) {
      expect(html).toContain(`<b>${s}`);
    }
  });

  it('finally renders the sunrise and sunset the vm has always held', async () => {
    const html = meteoBoard(await nyc(), US);
    expect(html).toContain('<span>Sunrise</span><b>5:49 AM</b>');
    expect(html).toContain('<span>Sunset</span><b>8:15 PM</b>');
    // ...and shades the night between them, with a hairline at each boundary.
    expect((html.match(/wxf-canvas__night/g) ?? [])).toHaveLength(9); // 8 PM..5 AM
    expect((html.match(/wxf-canvas__sun/g) ?? [])).toHaveLength(2);   // dusk + dawn
  });

  it('shows today above the fold and the full 7-day horizon below the chart', async () => {
    const html = meteoBoard(await nyc(), US);
    expect(html).toContain('<span>High today</span><b>83°</b>');
    expect(html).toContain('<span>Low tonight</span><b>68°</b>');
    expect(html).toContain('<span>Chance of rain</span><b>59%</b>');
    expect(html.match(/<div class="wxf__day[ "]/g)).toHaveLength(7);
    expect(html).toContain('wxf__day--today'); // day 0 is called out
  });

  it('carries the current condition accent, as the card does', async () => {
    const vm = await nyc();
    expect(meteoBoard(vm, US)).toContain('class="wxf" data-cond="clear"');
    expect(meteoBoard({ ...vm, now: { ...vm.now, code: 95 } }, US)).toContain('data-cond="thunder"');
  });

  it('gates the alert banner on there BEING one (the NWS source is US-only)', async () => {
    const vm = await nyc();
    expect(meteoBoard(vm, US)).not.toContain('class="alert"');
    const alerted = { ...vm, alert: { event: 'Flood Watch', headline: 'Flood Watch until 8 AM' } };
    expect(meteoBoard(alerted, US)).toContain('<div class="alert">');
    expect(meteoBoard(alerted, US)).toContain('Flood Watch');
    // A non-US board never gets one, and nothing structural depends on it: the
    // London view renders the same sections without the banner.
    const uk = meteoBoard(await london(), UK);
    expect(uk).not.toContain('class="alert"');
    expect(uk).toContain('wxf__stats');
    expect(uk).toContain('wxf__todayrail');
  });

  it('is locale-proof: °C, 24-hour, km/h and mm on a London board', async () => {
    const html = meteoBoard(await london(), UK);
    expect(cols(html, 'hours').filter(Boolean)).toEqual(['13:00', '15:00', '17:00', '19:00',
      '21:00', '23:00', '01:00', '03:00', '05:00', '07:00', '09:00', '11:00']);
    expect(html).toContain('<span>Sunrise</span><b>05:29</b>');
    expect(html).toContain('<span>Sunset</span><b>20:44</b>');
    expect(html).toContain('<b>6 km/h W</b><span>Wind');
    expect(html).toContain('<b>24 km/h</b><span>Gusts');
    expect(html).toContain('<b>0.2 mm</b><span>Rain today');
    expect(html).toContain('<span>High today</span><b>30°</b>'); // 86.1F -> 30C
    expect(html).not.toMatch(/\d+ mph|\d+\.\d+ in/);
  });

  it('prints a dash, never NaN, for a vm cached before the extras existed', async () => {
    const legacy = mapWeather(await fixture('open-meteo-forecast.json'), null);
    const html = meteoBoard(legacy, US);
    expect(html).not.toMatch(/NaN|undefined/);
    expect(html).toContain('<b>—</b><span>Wind');
    expect(html).toContain('<b>—</b><span>Humidity');
    expect(html).toContain('<span>Chance of rain</span><b>—</b>');
    // The sun times ARE in a legacy vm, so those still read.
    expect(html).toContain('<span>Sunrise</span><b>5:28 AM</b>');
    // A vm with no iso stamps falls back to its baked 12-hour labels.
    const noIso = { ...legacy, hourly: legacy.hourly.map(({ iso, ...rest }) => rest) };
    expect(cols(meteoBoard(noIso, US), 'hours').filter(Boolean)[0]).toBe('3 AM');
    expect(meteoBoard(noIso, US)).not.toContain('wxf-canvas__night');
  });

  it('renders complete from the demo fixture (?demo=1 and the /info captures)', () => {
    const html = meteoBoard(DEMO_VMS.weather, US);
    expect(html).not.toMatch(/NaN|undefined|—/);
    expect(html).toContain('<b>12 mph SSW</b><span>Wind');
    expect(cols(html, 'hours')).toHaveLength(24);
  });

  it('meteoCanvas degrades to nothing rather than a broken path', () => {
    expect(meteoCanvas([], [], 'g')).toBe('');
    expect(meteoCanvas([{ temp: 70, pp: 0, precip: 0 }], [], 'g')).toBe('');
  });
});
