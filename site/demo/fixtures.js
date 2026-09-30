// Canned view-models for ?demo=1 — renders the full dashboard with zero
// network. Also the substrate for renderer smoke tests and screenshots.

// The instant every fixture is built around: the transit `t`/`time` stamps are
// this plus their `min` (lirr min 8 -> +480s, njt min 12 -> +720s), and the news
// / posts fixtures use it as their `nowMs`. Consumers that derive a countdown
// from absolute times (see stripData in ambient.js) must pass this as "now",
// otherwise every demo departure reads as long past.
export const DEMO_NOW_MS = 1783000000000;

export const DEMO_VMS = {
  // Weather carries the FULL mapWeather shape: 24 hours and 7 days, because the
  // card's tap-for-detail overlay reads the whole window (the card itself still
  // draws only the first 6-8 hours and 4-5 days). The first 8 hours and first 5
  // days are frozen — the resting-card audit baselines and the renderer tests
  // pin their values. Canonical units, as the API is asked for them: °F, mph,
  // inch, converted at render.
  weather: {
    now: {
      temp: 84, feels: 92, code: 1, label: 'Mostly clear', icon: 'clear',
      humidity: 61, wind: 12, dir: 205, gust: 21,
    },
    hourly: [
      { iso: '2026-07-02T09:00', h: '9 AM', temp: 84, code: 1, pp: 0, precip: 0 },
      { iso: '2026-07-02T10:00', h: '10 AM', temp: 86, code: 1, pp: 0, precip: 0 },
      { iso: '2026-07-02T11:00', h: '11 AM', temp: 89, code: 2, pp: 5, precip: 0 },
      { iso: '2026-07-02T12:00', h: '12 PM', temp: 92, code: 2, pp: 20, precip: 0 },
      { iso: '2026-07-02T13:00', h: '1 PM', temp: 94, code: 3, pp: 45, precip: 0 },
      { iso: '2026-07-02T14:00', h: '2 PM', temp: 95, code: 95, pp: 70, precip: 0.12 },
      { iso: '2026-07-02T15:00', h: '3 PM', temp: 93, code: 95, pp: 55, precip: 0.08 },
      { iso: '2026-07-02T16:00', h: '4 PM', temp: 90, code: 80, pp: 30, precip: 0.02 },
      { iso: '2026-07-02T17:00', h: '5 PM', temp: 88, code: 80, pp: 25, precip: 0.01 },
      { iso: '2026-07-02T18:00', h: '6 PM', temp: 86, code: 3, pp: 15, precip: 0 },
      { iso: '2026-07-02T19:00', h: '7 PM', temp: 84, code: 3, pp: 10, precip: 0 },
      { iso: '2026-07-02T20:00', h: '8 PM', temp: 82, code: 2, pp: 5, precip: 0 },
      { iso: '2026-07-02T21:00', h: '9 PM', temp: 81, code: 1, pp: 0, precip: 0 },
      { iso: '2026-07-02T22:00', h: '10 PM', temp: 80, code: 1, pp: 0, precip: 0 },
      { iso: '2026-07-02T23:00', h: '11 PM', temp: 79, code: 0, pp: 0, precip: 0 },
      { iso: '2026-07-03T00:00', h: '12 AM', temp: 78, code: 0, pp: 0, precip: 0 },
      { iso: '2026-07-03T01:00', h: '1 AM', temp: 77, code: 0, pp: 0, precip: 0 },
      { iso: '2026-07-03T02:00', h: '2 AM', temp: 77, code: 0, pp: 0, precip: 0 },
      { iso: '2026-07-03T03:00', h: '3 AM', temp: 76, code: 0, pp: 0, precip: 0 },
      { iso: '2026-07-03T04:00', h: '4 AM', temp: 76, code: 0, pp: 0, precip: 0 },
      { iso: '2026-07-03T05:00', h: '5 AM', temp: 77, code: 1, pp: 5, precip: 0 },
      { iso: '2026-07-03T06:00', h: '6 AM', temp: 78, code: 1, pp: 5, precip: 0 },
      { iso: '2026-07-03T07:00', h: '7 AM', temp: 80, code: 2, pp: 10, precip: 0 },
      { iso: '2026-07-03T08:00', h: '8 AM', temp: 82, code: 2, pp: 10, precip: 0 },
    ],
    daily: [
      { iso: '2026-07-02', day: 'Today', hi: 95, lo: 78, code: 95, ppMax: 70, uvMax: 8.4, precipSum: 0.23, windMax: 22, sunrise: '2026-07-02T05:28', sunset: '2026-07-02T20:30' },
      { iso: '2026-07-03', day: 'Fri', hi: 91, lo: 77, code: 2, ppMax: 25, uvMax: 9.1, precipSum: 0, windMax: 14, sunrise: '2026-07-03T05:29', sunset: '2026-07-03T20:30' },
      { iso: '2026-07-04', day: 'Sat', hi: 88, lo: 74, code: 0, ppMax: 5, uvMax: 9.4, precipSum: 0, windMax: 11, sunrise: '2026-07-04T05:29', sunset: '2026-07-04T20:30' },
      { iso: '2026-07-05', day: 'Sun', hi: 85, lo: 71, code: 61, ppMax: 55, uvMax: 7.2, precipSum: 0.31, windMax: 16, sunrise: '2026-07-05T05:30', sunset: '2026-07-05T20:30' },
      { iso: '2026-07-06', day: 'Mon', hi: 82, lo: 69, code: 3, ppMax: 20, uvMax: 6.8, precipSum: 0.02, windMax: 12, sunrise: '2026-07-06T05:31', sunset: '2026-07-06T20:29' },
      { iso: '2026-07-07', day: 'Tue', hi: 84, lo: 70, code: 2, ppMax: 10, uvMax: 8, precipSum: 0, windMax: 10, sunrise: '2026-07-07T05:31', sunset: '2026-07-07T20:29' },
      { iso: '2026-07-08', day: 'Wed', hi: 87, lo: 72, code: 1, ppMax: 5, uvMax: 8.6, precipSum: 0, windMax: 9, sunrise: '2026-07-08T05:32', sunset: '2026-07-08T20:28' },
    ],
    sunrise: '2026-07-02T05:28',
    sunset: '2026-07-02T20:30',
    alert: { event: 'Extreme Heat Watch', headline: 'Extreme Heat Watch in effect until Saturday 9 PM' },
  },
  subway: {
    updatedAt: 0,
    lines: [
      { line: '1', ok: true, headers: [] },
      { line: '2', ok: true, headers: [] },
      { line: '3', ok: false, headers: ['Downtown [3] trains are rerouted via the [2] line after 34 St-Penn Station while we address a signal problem.'] },
      { line: 'A', ok: true, headers: [] },
      { line: 'E', ok: false, headers: ['[E] trains are running with delays in both directions.'] },
    ],
  },
  // The .train boards carry a full 12 departures (the same ceiling the live
  // feeds slice to), so the overflow audit (site/_audit.html) can fill the
  // tallest card at every size instead of running out of data after 3 rows.
  // The first rows stay put: the ambient strip test pins their minutes.
  lirr: {
    alerts: [{ header: 'Port Washington Branch trains may be delayed up to 15 minutes due to switch trouble at Woodside.' }],
    departures: [
      { min: 8, t: 1783000480, dest: 'Port Washington', branch: 'Port Washington', track: '17', trainNum: '706' },
      { min: 21, t: 1783001260, dest: 'Great Neck', branch: 'Port Washington', track: '19', trainNum: '712' },
      { min: 34, t: 1783002040, dest: 'Port Washington', branch: 'Port Washington', track: null, trainNum: '718' },
      { min: 42, t: 1783002520, dest: 'Babylon', branch: 'Babylon', track: '15', trainNum: '724' },
      { min: 49, t: 1783002940, dest: 'Hicksville', branch: 'Ronkonkoma', track: null, trainNum: '730' },
      { min: 57, t: 1783003420, dest: 'Long Beach', branch: 'Long Beach', track: '20', trainNum: '736' },
      { min: 64, t: 1783003840, dest: 'Great Neck', branch: 'Port Washington', track: null, trainNum: '742' },
      { min: 72, t: 1783004320, dest: 'Freeport', branch: 'Babylon', track: '18', trainNum: '748' },
      { min: 79, t: 1783004740, dest: 'Ronkonkoma', branch: 'Ronkonkoma', track: null, trainNum: '754' },
      { min: 87, t: 1783005220, dest: 'Far Rockaway', branch: 'Far Rockaway', track: '16', trainNum: '760' },
      { min: 94, t: 1783005640, dest: 'Port Washington', branch: 'Port Washington', track: null, trainNum: '766' },
      { min: 102, t: 1783006120, dest: 'Hempstead', branch: 'Hempstead', track: '19', trainNum: '772' },
    ],
  },
  mnr: {
    alerts: [],
    departures: [
      { min: 6, t: 1783000360, dest: 'Southeast', branch: 'Harlem', track: null },
      { min: 14, t: 1783000840, dest: 'Poughkeepsie', branch: 'Hudson', track: null },
      { min: 22, t: 1783001320, dest: 'New Haven-State St', branch: 'New Haven', track: null },
      { min: 29, t: 1783001740, dest: 'Stamford', branch: 'New Haven', track: null },
      { min: 37, t: 1783002220, dest: 'North White Plains', branch: 'Harlem', track: null },
      { min: 44, t: 1783002640, dest: 'Croton-Harmon', branch: 'Hudson', track: null },
      { min: 52, t: 1783003120, dest: 'New Canaan', branch: 'New Canaan', track: null },
      { min: 59, t: 1783003540, dest: 'Southeast', branch: 'Harlem', track: null },
      { min: 67, t: 1783004020, dest: 'Danbury', branch: 'Danbury', track: null },
      { min: 74, t: 1783004440, dest: 'Tarrytown', branch: 'Hudson', track: null },
      { min: 82, t: 1783004920, dest: 'Waterbury', branch: 'Waterbury', track: null },
      { min: 89, t: 1783005340, dest: 'White Plains', branch: 'Harlem', track: null },
    ],
  },
  njt: {
    updatedAt: 0,
    stale: false,
    alerts: [{ header: 'Northeast Corridor trains subject to 10-15 minute delays due to Amtrak signal issues.' }],
    trains: [
      // `line` carries the feed's verbatim LINE string (worker/src/njt.js passes
      // it through untouched), which is what lines.js keys the color chip on —
      // the chip itself renders the short name.
      { min: 12, time: 1783000720, dest: 'Trenton', line: 'Northeast Corridor Line', track: '3', status: 'BOARDING' },
      { min: 26, time: 1783001560, dest: 'Dover', line: 'Morris & Essex Line', track: null, status: '' },
      { min: 41, time: 1783002460, dest: 'Bay Head', line: 'North Jersey Coast Line', track: '5', status: '' },
      { min: 49, time: 1783002940, dest: 'Raritan', line: 'Raritan Valley Line', track: null, status: '' },
      { min: 56, time: 1783003360, dest: 'Trenton', line: 'Northeast Corridor Line', track: '7', status: '' },
      { min: 64, time: 1783003840, dest: 'Hackettstown', line: 'Montclair-Boonton Line', track: null, status: '' },
      { min: 71, time: 1783004260, dest: 'Long Branch', line: 'North Jersey Coast Line', track: '4', status: '' },
      { min: 79, time: 1783004740, dest: 'Summit', line: 'Morris & Essex Line', track: null, status: '' },
      { min: 86, time: 1783005160, dest: 'Rahway', line: 'Northeast Corridor Line', track: '2', status: '' },
      { min: 94, time: 1783005640, dest: 'High Bridge', line: 'Raritan Valley Line', track: null, status: '' },
      { min: 101, time: 1783006060, dest: 'Gladstone', line: 'Gladstone Branch', track: '6', status: '' },
      { min: 109, time: 1783006540, dest: 'Trenton', line: 'Northeast Corridor Line', track: null, status: '' },
    ],
  },
  amtrak: {
    station: 'NYP', updatedAt: 1783000000, stale: false,
    alerts: [{ header: 'Northeast Regional trains are operating with reduced frequency this weekend due to track work south of Philadelphia.' }],
    departures: [
      { t: 1783000720, sch: 1783000720, dest: 'Washington Union', destCode: 'WAS', route: 'Northeast Regional', num: '171', status: 'On time', platform: null,
        stops: [['NWK', 1783001200], ['TRE', 1783002400], ['PHL', 1783003600], ['BAL', 1783006000], ['WAS', 1783007800]] },
      { t: 1783001580, sch: 1783001280, dest: 'Boston South', destCode: 'BOS', route: 'Acela', num: '2151', status: '5 min late', platform: '7',
        stops: [['STM', 1783003000], ['NHV', 1783004500], ['BOS', 1783012000]] },
      { t: 1783002400, sch: 1783002400, dest: 'Albany-Rensselaer', destCode: 'ALB', route: 'Empire Service', num: '233', status: 'On time', platform: null,
        stops: [['YNY', 1783003000], ['CRT', 1783003600], ['POU', 1783005000], ['ALB', 1783010000]] },
      { t: 1783003300, sch: 1783003300, dest: 'Harrisburg', destCode: 'HAR', route: 'Keystone', num: '643', status: 'On time', platform: null,
        stops: [['NWK', 1783003800], ['TRE', 1783004800], ['PHL', 1783006000], ['LNC', 1783009000], ['HAR', 1783010800]] },
      { t: 1783004200, sch: 1783004200, dest: 'Boston South', destCode: 'BOS', route: 'Northeast Regional', num: '175', status: 'On time', platform: null,
        stops: [['NHV', 1783007000], ['PVD', 1783011000], ['BOS', 1783013000]] },
      { t: 1783005100, sch: 1783005100, dest: 'Washington Union', destCode: 'WAS', route: 'Acela', num: '2159', status: 'On time', platform: '10',
        stops: [['PHL', 1783008000], ['BAL', 1783010500], ['WAS', 1783012000]] },
      { t: 1783006000, sch: 1783006000, dest: 'Niagara Falls', destCode: 'NFL', route: 'Maple Leaf', num: '63', status: 'On time', platform: null,
        stops: [['CRT', 1783007000], ['ALB', 1783011000], ['NFL', 1783030000]] },
      { t: 1783006900, sch: 1783006900, dest: 'Harrisburg', destCode: 'HAR', route: 'Keystone', num: '651', status: 'On time', platform: null,
        stops: [['NWK', 1783007400], ['PHL', 1783009600], ['HAR', 1783014400]] },
      { t: 1783007800, sch: 1783007300, dest: 'Savannah', destCode: 'SAV', route: 'Palmetto', num: '89', status: '8 min late', platform: '12',
        stops: [['PHL', 1783011000], ['WAS', 1783018000], ['SAV', 1783050000]] },
      { t: 1783008700, sch: 1783008700, dest: 'Springfield', destCode: 'SPG', route: 'Valley Flyer', num: '495', status: 'On time', platform: null,
        stops: [['NHV', 1783012000], ['HFD', 1783015000], ['SPG', 1783017000]] },
      { t: 1783009600, sch: 1783009600, dest: 'Boston South', destCode: 'BOS', route: 'Northeast Regional', num: '179', status: 'On time', platform: null,
        stops: [['NHV', 1783013000], ['PVD', 1783017000], ['BOS', 1783019000]] },
      { t: 1783010500, sch: 1783010500, dest: 'Albany-Rensselaer', destCode: 'ALB', route: 'Empire Service', num: '241', status: 'On time', platform: null,
        stops: [['YNY', 1783011000], ['POU', 1783013000], ['ALB', 1783016000]] },
    ],
  },
  path: {
    station: '33S',
    sections: [
      {
        dir: 'ToNJ',
        label: 'To New Jersey',
        rows: [
          { min: 3, t: 1783000180, dest: 'Journal Square', colors: ['FF9900'] },
          { min: 9, t: 1783000540, dest: 'Hoboken', colors: ['4D92FB'] },
          { min: 16, t: 1783000960, dest: 'Newark', colors: ['D93A30'] },
        ],
      },
    ],
  },
  ferry: {
    landing: '17',
    landingName: 'East 34th Street',
    departures: [
      { min: 5, t: 1783000300, dest: 'Wall St./Pier 11', route: { name: 'East River', color: '00839C' } },
      { min: 18, t: 1783001080, dest: 'Hunters Point South', route: { name: 'East River', color: '00839C' } },
      { min: 33, t: 1783001980, dest: 'Soundview', route: { name: 'Soundview', color: '4E008E' } },
      { min: 41, t: 1783002460, dest: 'Roosevelt Island', route: { name: 'Astoria', color: 'F5A800' } },
      { min: 48, t: 1783002880, dest: 'Wall St./Pier 11', route: { name: 'East River', color: '00839C' } },
      { min: 56, t: 1783003360, dest: 'Greenpoint', route: { name: 'East River', color: '00839C' } },
      { min: 63, t: 1783003780, dest: 'Astoria', route: { name: 'Astoria', color: 'F5A800' } },
      { min: 71, t: 1783004260, dest: 'Soundview', route: { name: 'Soundview', color: '4E008E' } },
      { min: 78, t: 1783004680, dest: 'Hunters Point South', route: { name: 'East River', color: '00839C' } },
      { min: 86, t: 1783005160, dest: 'Wall St./Pier 11', route: { name: 'Lower East Side', color: 'C60C30' } },
      { min: 93, t: 1783005580, dest: 'Corlears Hook', route: { name: 'Lower East Side', color: 'C60C30' } },
      { min: 101, t: 1783006060, dest: 'Greenpoint', route: { name: 'East River', color: '00839C' } },
    ],
  },
  wotd: {
    w: 'petrichor',
    pr: 'PET-rih-kor',
    pos: 'noun',
    def: 'The pleasant, earthy smell that follows rain on dry ground.',
    ex: 'The first storm of the season filled the street with petrichor.',
  },
  bus: { configured: true, stops: [
    { id: '550789', route: 'QM24', name: 'Madison Av / E 34 St', arrivals: [
      { dest: 'Wall St', min: 8, distance: '' }, { dest: 'Wall St', min: 21, distance: '' } ] } ] },
  sports: {
    rows: [
      { lg: 'mlb', abbr: 'NYM', name: 'Mets', record: '48-37', state: 'in', line: '3-2 vs ATL · Bot 7th', logo: 'https://a.espncdn.com/i/teamlogos/mlb/500-dark/nym.png', lastLine: 'L 3-9 vs TOR · Final' },
      { lg: 'nba', abbr: 'NYK', name: 'Knicks', record: '', state: 'pre', line: 'vs BOS · 10/24 - 7:30 PM', logo: 'https://a.espncdn.com/i/teamlogos/nba/500-dark/nyk.png', lastLine: 'W 112-104 @ BOS · Final' },
      { lg: 'nfl', abbr: 'NYJ', name: 'Jets', record: '', state: 'post', line: 'W 24-17 @ NE · Final', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/nyj.png', lastLine: null, nextLine: 'vs MIA · 10/28 - 8:15 PM EDT' },
    ],
  },
  // No demo stream: rights sit with the user, so demo/audit shows the
  // unconfigured tap-to-set-up state.
  iptv: { url: '', label: '' },
  golf: {
    name: 'The Open', state: 'in', startsAt: null, round: '3',
    players: [
      { pos: 1, name: 'S. Burns', score: '-10', today: '+3', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/usa.png' },
      { pos: 2, name: 'R. Fox', score: '-8', today: '-2', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/nzl.png' },
      { pos: 3, name: 'S.W. Kim', score: '-8', today: 'E', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/kor.png' },
      { pos: 4, name: 'R. Gerard', score: '-7', today: '-1', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/usa.png' },
      { pos: 5, name: 'S. Scheffler', score: '-6', today: '+1', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/usa.png' },
      { pos: 6, name: 'R. McIlroy', score: '-5', today: '-3', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/irl.png' },
      { pos: 7, name: 'X. Schauffele', score: '-4', today: 'E', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/usa.png' },
      { pos: 8, name: 'J. Rahm', score: '-4', today: '-2', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/esp.png' },
      { pos: 9, name: 'L. Aberg', score: '-3', today: '+1', flag: 'https://a.espncdn.com/i/teamlogos/countries/500/swe.png' },
    ],
  },
  tennis: {
    name: 'Nordea Open',
    rows: [
      { tour: 'ATP', state: 'in', t: 1783000000000, round: 'Semifinal', a: 'C. Alcaraz', b: 'A. Zverev', aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/esp.png', bFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/ger.png', sets: '6-4 3-2', winner: null, detail: 'Set 2' },
      { tour: 'WTA', state: 'pre', t: 1783005000000, round: 'Final', a: 'I. Swiatek', b: 'A. Sabalenka', aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/pol.png', bFlag: null, sets: '', winner: null, detail: '3:00 PM' },
      { tour: 'WTA', state: 'post', t: 1782990000000, round: 'Quarterfinal', a: 'V. Strakhova', b: 'M. Bulgaru', aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/ukr.png', bFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/rou.png', sets: '6-2 6-2', winner: 'b', detail: 'Final' },
      { tour: 'ATP', state: 'post', t: 1782980000000, round: 'Quarterfinal', a: 'A. Tabilo', b: 'A. Rublev', aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/chi.png', bFlag: null, sets: '4-6 6-4 4-6', winner: 'b', detail: 'Final' },
      { tour: 'ATP', state: 'post', t: 1782970000000, round: 'Round of 16', a: 'T. Tirante', b: 'A. Tabilo', aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/arg.png', bFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/chi.png', sets: '', winner: 'b', detail: 'Walkover' },
      { tour: 'WTA', state: 'post', t: 1782960000000, round: 'Round of 16', a: 'E. Rybakina', b: 'M. Keys', aFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/kaz.png', bFlag: 'https://a.espncdn.com/i/teamlogos/countries/500/usa.png', sets: '7-6 6-3', winner: 'a', detail: 'Final' },
    ],
  },
  news: {
    nowMs: 1783000000000,
    items: [
      { title: 'Council reaches deal on city budget ahead of deadline', t: 1782998200000, source: 'NYT New York' },
      { title: 'Federal Reserve signals patience on rate cuts', t: 1782996000000, source: 'NYT Business' },
      { title: 'Subway platform doors pilot expands to five stations', t: 1782990000000, source: 'Gothamist' },
      { title: 'Summer crowds boost midtown restaurants', t: 1782980000000, source: 'NYT Top Stories' },
    ],
  },
  substack: {
    nowMs: 1783000000000,
    items: [
      { title: 'The AI Superforecasters Are Here', desc: 'What happens when the models start beating the humans at their own game', t: 1782998200000, source: 'Astral Codex Ten', link: 'https://astralcodexten.substack.com/p/the-ai-superforecasters' },
      { title: 'The Hidden Cost of Meetings', desc: 'A field guide to reclaiming your calendar one recurring invite at a time', t: 1782910000000, source: 'Pragmatic Engineer', link: 'https://newsletter.pragmaticengineer.com/p/the-hidden-cost-of-meetings' },
    ],
  },
  bsky: {
    nowMs: 1783000000000,
    items: [
      { title: 'Breaking: newest ferry pier opens with a ribbon cutting at sunrise', t: 1782998000000, source: 'NYT', link: 'https://bsky.app/profile/nytimes.com/post/3kdemoferry1' },
      { title: 'Shipped a new feature today. The trick was deleting more code than I wrote.', t: 1782990000000, source: 'Jane Dev', link: 'https://bsky.app/profile/janedev.bsky.social/post/3kdemoship2' },
    ],
  },
  art: {
    img: 'https://images.metmuseum.org/CRDImages/ep/web-large/DP145911.jpg',
    title: 'Wheat Fields',
    artist: 'Jacob van Ruisdael',
    year: 'ca. 1670',
    source: 'The Met',
  },
  history: {
    events: [
      { year: 1776, text: 'The Continental Congress votes for independence from Great Britain.' },
      { year: 1881, text: 'President James A. Garfield is shot at the Baltimore and Potomac Railroad Station.' },
      { year: 1937, text: 'Amelia Earhart disappears over the Pacific Ocean during her circumnavigation attempt.' },
      { year: 1964, text: 'President Lyndon B. Johnson signs the Civil Rights Act into law.' },
      { year: 2002, text: 'Steve Fossett completes the first solo balloon circumnavigation of the world.' },
    ],
  },
  aqi: {
    aqi: 66,
    category: 'Moderate',
    sunrise: '2026-07-02T05:28',
    sunset: '2026-07-02T20:30',
    uv: 7,
    moonPhase: { name: 'Waning Gibbous', fraction: 0.62 },
  },
  // Surf carries the FULL mapSurf shape: 49 hours (six of them past, so "now"
  // is an interior mark) and a 7-day outlook, because the tap-for-detail view
  // reads the whole window while the card draws only 6-8 columns of it. Shaped
  // on a real Bridgehampton build and re-based onto DEMO_NOW_MS: 3.3 ft now,
  // 8.5 ft twenty-one hours out. The peak sits where BOTH card windows reach it
  // (6 columns at 4-hour steps and 8 at 3-hour steps), so every audit size and
  // every screenshot tells the same story. Canonical units, as the API is asked
  // for them: feet, °F, mph, converted at render.
  surf: {
    ocean: true,
    spot: { lat: 40.9384, lon: -72.3037, label: 'Bridgehampton' },
    cell: { lat: 40.875, lon: -72.29166 },
    snapKm: 7.12,
    shoreBearing: 171.8, // pin -> snapped cell: the shore-facing normal, free
    now: { iso: '2026-07-02T08:00', wave: 3.3, period: 5.2, dir: 165, sst: 71.1 },
    swell: { h: 1.5, p: 6.2, d: 158 },
    windWave: { h: 2.4, p: 3.4, d: 172 },
    nowIdx: 6,
    hourly: [
      { iso: '2026-07-02T02:00', wave: 2.90, swell: 1.30 },
      { iso: '2026-07-02T03:00', wave: 2.93, swell: 1.31 },
      { iso: '2026-07-02T04:00', wave: 3.00, swell: 1.35 },
      { iso: '2026-07-02T05:00', wave: 3.10, swell: 1.40 },
      { iso: '2026-07-02T06:00', wave: 3.20, swell: 1.45 },
      { iso: '2026-07-02T07:00', wave: 3.27, swell: 1.49 },
      { iso: '2026-07-02T08:00', wave: 3.30, swell: 1.50 },
      { iso: '2026-07-02T09:00', wave: 3.35, swell: 1.51 },
      { iso: '2026-07-02T10:00', wave: 3.45, swell: 1.53 },
      { iso: '2026-07-02T11:00', wave: 3.55, swell: 1.55 },
      { iso: '2026-07-02T12:00', wave: 3.60, swell: 1.57 },
      { iso: '2026-07-02T13:00', wave: 3.66, swell: 1.59 },
      { iso: '2026-07-02T14:00', wave: 3.80, swell: 1.60 },
      { iso: '2026-07-02T15:00', wave: 3.94, swell: 1.62 },
      { iso: '2026-07-02T16:00', wave: 4.00, swell: 1.68 },
      { iso: '2026-07-02T17:00', wave: 4.09, swell: 1.75 },
      { iso: '2026-07-02T18:00', wave: 4.30, swell: 1.82 },
      { iso: '2026-07-02T19:00', wave: 4.51, swell: 1.88 },
      { iso: '2026-07-02T20:00', wave: 4.60, swell: 1.90 },
      { iso: '2026-07-02T21:00', wave: 4.81, swell: 1.98 },
      { iso: '2026-07-02T22:00', wave: 5.19, swell: 2.15 },
      { iso: '2026-07-02T23:00', wave: 5.40, swell: 2.32 },
      { iso: '2026-07-03T00:00', wave: 5.74, swell: 2.40 },
      { iso: '2026-07-03T01:00', wave: 6.36, swell: 2.54 },
      { iso: '2026-07-03T02:00', wave: 6.70, swell: 2.85 },
      { iso: '2026-07-03T03:00', wave: 7.40, swell: 3.16 },
      { iso: '2026-07-03T04:00', wave: 8.10, swell: 3.30 },
      { iso: '2026-07-03T05:00', wave: 8.50, swell: 3.60 },
      { iso: '2026-07-03T06:00', wave: 8.25, swell: 3.86 },
      { iso: '2026-07-03T07:00', wave: 8.00, swell: 4.34 },
      { iso: '2026-07-03T08:00', wave: 7.83, swell: 4.60 },
      { iso: '2026-07-03T09:00', wave: 7.45, swell: 4.76 },
      { iso: '2026-07-03T10:00', wave: 7.07, swell: 5.04 },
      { iso: '2026-07-03T11:00', wave: 6.90, swell: 5.20 },
      { iso: '2026-07-03T12:00', wave: 6.79, swell: 5.10 },
      { iso: '2026-07-03T13:00', wave: 6.51, swell: 4.90 },
      { iso: '2026-07-03T14:00', wave: 6.19, swell: 4.80 },
      { iso: '2026-07-03T15:00', wave: 5.91, swell: 4.73 },
      { iso: '2026-07-03T16:00', wave: 5.80, swell: 4.55 },
      { iso: '2026-07-03T17:00', wave: 5.71, swell: 4.35 },
      { iso: '2026-07-03T18:00', wave: 5.48, swell: 4.17 },
      { iso: '2026-07-03T19:00', wave: 5.22, swell: 4.10 },
      { iso: '2026-07-03T20:00', wave: 4.99, swell: 4.06 },
      { iso: '2026-07-03T21:00', wave: 4.90, swell: 3.96 },
      { iso: '2026-07-03T22:00', wave: 4.84, swell: 3.82 },
      { iso: '2026-07-03T23:00', wave: 4.69, swell: 3.68 },
      { iso: '2026-07-04T00:00', wave: 4.51, swell: 3.54 },
      { iso: '2026-07-04T01:00', wave: 4.36, swell: 3.44 },
      { iso: '2026-07-04T02:00', wave: 4.30, swell: 3.40 },
    ],
    daily: [
      { iso: '2026-07-02', day: 'Today', max: 5.4, period: 6.3, dir: 159 },
      { iso: '2026-07-03', day: 'Fri', max: 8.5, period: 6.7, dir: 142 },
      { iso: '2026-07-04', day: 'Sat', max: 5.1, period: 6.9, dir: 163 },
      { iso: '2026-07-05', day: 'Sun', max: 3.0, period: 7.8, dir: 144 },
      { iso: '2026-07-06', day: 'Mon', max: 2.5, period: 7.8, dir: 154 },
      { iso: '2026-07-07', day: 'Tue', max: 2.3, period: 6.7, dir: 162 },
      { iso: '2026-07-08', day: 'Wed', max: 3.5, period: 7.0, dir: 168 },
    ],
    sun: [
      { iso: '2026-07-01', sunrise: '2026-07-01T05:28', sunset: '2026-07-01T20:30' },
      { iso: '2026-07-02', sunrise: '2026-07-02T05:28', sunset: '2026-07-02T20:30' },
      { iso: '2026-07-03', sunrise: '2026-07-03T05:29', sunset: '2026-07-03T20:30' },
      { iso: '2026-07-04', sunrise: '2026-07-04T05:29', sunset: '2026-07-04T20:30' },
    ],
    wind: { speed: 15, dir: 168, quality: 'onshore' },
    air: 75,
    fetchedAt: DEMO_NOW_MS,
  },
  quote: {
    text: 'The best way to predict the future is to invent it.',
    author: 'Alan Kay',
  },
  worldclock: [
    { city: 'San Francisco', time: '5:13 AM', dayDiff: 0 },
    { city: 'New York', time: '8:13 AM', dayDiff: 0 },
    { city: 'London', time: '1:13 PM', dayDiff: 0 },
    { city: 'Hyderabad', time: '5:43 PM', dayDiff: 0 },
    { city: 'Hong Kong', time: '12:13 AM', dayDiff: 1 },
  ],
  markets: {
    updatedAt: 1783000500,
    stale: false,
    indices: [
      { symbol: '^DJI', name: 'Dow Jones', price: 52147.83, change: 231.44, changePct: 0.45, spark: [51900, 51950, 52020, 51980, 52080, 52147], spark2: [51700, 51820, 51760, 51900, 51900, 51950, 52020, 51980, 52080, 52147], split: 5 },
      { symbol: '^IXIC', name: 'Nasdaq', price: 24893.11, change: -87.62, changePct: -0.35, spark: [24980, 24950, 24870, 24910, 24860, 24893], spark2: [25100, 25040, 25010, 24980, 24980, 24950, 24870, 24910, 24860, 24893], split: 5 },
      { symbol: '^GSPC', name: 'S&P 500', price: 7483.23, change: -16.13, changePct: -0.22, spark: [7499, 7490, 7470, 7458, 7481, 7483], spark2: [7520, 7505, 7512, 7499, 7499, 7490, 7470, 7458, 7481, 7483], split: 5 },
    ],
  },
  photos: { updatedAt: 1783000000, stale: false, photos: [
    { img: 'https://images.metmuseum.org/CRDImages/ep/web-large/DP145911.jpg', ar: 1.33, title: 'Beach', date: '2026-02-24' },
  ] },
  gdrivephotos: { updatedAt: 1783000000, stale: false, photos: [
    { img: 'https://images.metmuseum.org/CRDImages/ep/web-large/DP145911.jpg', ar: 1.33, title: 'Harbor', date: '2026-02-25' },
  ] },
  marketsnews: { items: [{ title: 'Fed holds rates', source: 'CNBC', t: 1783000000000 }], nowMs: 1783000100000 },
  // `teams` carries the resolved match phrases, so the demo board shows the
  // Only-my-teams filter doing something rather than emptying the card.
  sportsnews: {
    items: [
      { title: 'Mets rally past Braves in the ninth', source: 'ESPN', t: 1783000000000, desc: 'Three runs with two outs turn a one-run deficit around at Citi Field.' },
      { title: 'Chiefs sign a veteran left tackle', source: 'CBS Sports', t: 1782999400000 },
      { title: 'Knicks open camp with a healthy roster', source: 'NYT Sports', t: 1782998800000 },
    ],
    nowMs: 1783000100000,
    teams: ['New York Mets', 'Mets'],
  },
  tfl: { updatedAt: 1783000000, lines: [
    { id: 'central', name: 'Central', mode: 'Tube', ok: true, status: 'Good Service', reason: '' },
    { id: 'victoria', name: 'Victoria', mode: 'Tube', ok: true, status: 'Good Service', reason: '' },
    { id: 'district', name: 'District', mode: 'Tube', ok: false, status: 'Part Closure', reason: 'No service between Turnham Green and Richmond this weekend; use replacement buses.' },
  ] },
  citibike: { updatedAt: 1783000000, stations: [
    { id: '66dc7c31-0aca-11e7-82f6-3863bb44ef7c', bikes: 7, ebikes: 3, docks: 12, ok: true },
    { id: '66dc51e9-0aca-11e7-82f6-3863bb44ef7c', bikes: 0, ebikes: 0, docks: 25, ok: true },
    { id: '1869743938848725856', bikes: 4, ebikes: 0, docks: 0, ok: false },
  ] },
  f1: { updatedAt: 1783000000, stale: false,
    next: { name: 'Belgian Grand Prix', date: '2026-07-19', circuit: 'Circuit de Spa-Francorchamps', country: 'Belgium' },
    lastRace: 'British Grand Prix',
    podium: [
      { pos: 1, driver: 'Leclerc', nat: 'Monegasque', cid: 'ferrari' },
      { pos: 2, driver: 'Russell', nat: 'British', cid: 'mercedes' },
      { pos: 3, driver: 'Hamilton', nat: 'British', cid: 'ferrari' },
    ],
    drivers: [
      { pos: 1, name: 'Antonelli', nat: 'Italian', cid: 'mercedes', pts: 179 },
      { pos: 2, name: 'Russell', nat: 'British', cid: 'mercedes', pts: 154 },
      { pos: 3, name: 'Hamilton', nat: 'British', cid: 'ferrari', pts: 147 },
      { pos: 4, name: 'Leclerc', nat: 'Monegasque', cid: 'ferrari', pts: 108 },
      { pos: 5, name: 'Norris', nat: 'British', cid: 'mclaren', pts: 97 },
      { pos: 6, name: 'Piastri', nat: 'Australian', cid: 'mclaren', pts: 82 },
      { pos: 7, name: 'Verstappen', nat: 'Dutch', cid: 'red_bull', pts: 76 },
      { pos: 8, name: 'Hadjar', nat: 'French', cid: 'rb', pts: 52 },
    ],
    teams: [
      { pos: 1, cid: 'mercedes', name: 'Mercedes', pts: 333 },
      { pos: 2, cid: 'ferrari', name: 'Ferrari', pts: 255 },
      { pos: 3, cid: 'mclaren', name: 'McLaren', pts: 179 },
      { pos: 4, cid: 'red_bull', name: 'Red Bull', pts: 128 },
      { pos: 5, cid: 'alpine', name: 'Alpine', pts: 60 },
      { pos: 6, cid: 'rb', name: 'RB F1 Team', pts: 59 },
    ] },
  chart: { updatedAt: 1783000000, charts: [{
    id: '28744',
    title: 'How Global Population Growth Is Slowing',
    desc: 'This chart shows the annual growth rate of the world population from 1950 to 2100 (projected).',
    date: '2026-07-10',
    url: 'https://cdn.statcdn.com/Infographic/images/normal/28744.jpeg',
    link: 'https://www.statista.com/chart/28744/world-population-growth-timeline-and-forecast/' }, {
    id: '28730',
    title: 'How Voters Rate the Economy',
    desc: 'A recent election-season poll of registered voters on the state of the economy.',
    date: '2026-07-09',
    url: 'https://cdn.statcdn.com/Infographic/images/normal/28730.jpeg',
    link: 'https://www.statista.com/chart/28730/how-voters-rate-the-economy/' }] },
  apod: { updatedAt: 1783000000, photo: {
    url: 'https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2026/september/m33m14_rasa3NM.jpg?w=1280',
    title: 'Messier 33: The Triangulum Galaxy',
    explanation: 'The small, northern constellation Triangulum harbors this magnificent face-on spiral galaxy, Messier 33. Its popular names include the Pinwheel Galaxy or just the Triangulum Galaxy. M33 is over 50,000 light-years in diameter, third largest in the Local Group of galaxies after the Andromeda Galaxy (M31), and our own Milky Way. About 3 million light-years from the Milky Way, M33 is itself thought to be a satellite of the Andromeda Galaxy and astronomers in these two galaxies would likely have spectacular views of each other\'s grand spiral star systems. As for the view from the Milky Way, this sharp telescopic image shows off M33\'s blue star clusters and pinkish star forming regions along the galaxy\'s loosely wound spiral arms. In fact, the cavernous NGC 604 is the brightest star forming region, seen here at about the 5 o\'clock position from the galaxy center. Like M31, M33\'s population of well-measured variable stars have helped make this nearby spiral a cosmic yardstick for establishing the distance scale of the Universe.',
    credit: 'George Chatzifrantzis', date: '2026-09-18' } },
  services: {
    updatedAt: 1783000000,
    services: [
      { id: 'webex', label: 'Webex', state: 'ok', note: 'All systems operational', incidents: [] },
      { id: 'zoom', label: 'Zoom', state: 'ok', note: 'All systems operational', incidents: [] },
      { id: 'slack', label: 'Slack', state: 'ok', note: 'All systems operational', incidents: [] },
      // Degraded sample modeled on the real Cloudflare incident recorded 2026-07-11.
      { id: 'cloudflare', label: 'Cloudflare', state: 'minor', note: 'Minor Service Outage', incidents: [
        { title: 'Cloudflare Dashboard and API service issues', since: '2026-07-11T14:12:00.000Z',
          update: 'Cloudflare is investigating elevated error rates on the Dashboard and API. Cached content and traffic proxying are unaffected.' },
      ] },
      // Multi-incident sample, mirroring the real Microsoft digest of 2026-08-02:
      // three core workloads degraded at once, core-first as the Worker sorts
      // them, and no timestamps (the consumer feed's clock is its own, not the
      // incident's). This is the case the card's per-incident note lines exist
      // for, so the audit harness has to be able to see it.
      { id: 'm365', label: 'Microsoft 365', state: 'minor', note: 'Exchange Online: service degradation', incidents: [
        { title: 'Exchange Online: service degradation', since: '',
          update: 'Users may be unable to access their mailboxes or may see delays sending and receiving mail.' },
        { title: 'Microsoft 365 suite: service degradation', since: '',
          update: 'Users may be unable to sign in to Microsoft 365 services or may see errors after signing in.' },
        { title: 'Microsoft Teams: service degradation', since: '',
          update: 'Users may see delays loading chats and channels, or may be unable to join meetings.' },
      ] },
      { id: 'aws', label: 'AWS', state: 'unknown', note: 'Status unavailable', incidents: [] },
    ],
  },
};
