/**
 * @vitest-environment happy-dom
 */
// The /info scroll-spy. happy-dom lays nothing out, so the page's geometry is
// scripted: every section keeps a document-space top and the viewport reports
// where it currently is, which is exactly the input syncNav reads.
import { describe, it, expect, vi } from 'vitest';

const SECTIONS = ['yours', 'commute', 'screensavers', 'whatsnew'];
const TOP = { yours: 800, commute: 2000, screensavers: 4200, whatsnew: 5400 };

// A 1440-tall viewport on a 6000-tall page: the real 2560x1440 case, where the
// last section is shorter than the screen.
const view = { scrollY: 0, innerHeight: 1440, scrollHeight: 6000 };

document.body.innerHTML = `
  <nav class="nav"><div class="nav__inner">
    ${SECTIONS.map((id) => `<a class="nav__link" href="#${id}">${id}</a>`).join('')}
  </div></nav>
  <h1 class="hero__title"><span class="imark imark--led"><span class="imark__idle">idle</span><span class="imark__screen">screen</span></span></h1>
  ${SECTIONS.map((id) => `<section id="${id}" data-nav-section="${id}"></section>`).join('')}
`;
for (const el of document.querySelectorAll('[data-nav-section]')) {
  el.getBoundingClientRect = () => ({ top: TOP[el.dataset.navSection] - view.scrollY });
}

// ---------- the power tittle's two measurements ----------
// The probe reads two things a layout-less DOM cannot produce: where the line's
// baseline landed (measured with a 1em-wide inline-block dropped into the
// word, whose own rect width is the em ruler) and an ink-scan of the rendered
// "i" on a canvas. Both are scripted here, the same way the spy's geometry
// above is.
const idleEl = document.querySelector('.hero__title .imark__idle');
const IDLE_FS = parseFloat(getComputedStyle(idleEl).fontSize) || 16;
// 0.9219em is the generic-sans figure from the mockup round: a real value from
// a real face, so the assertions read as a face rather than as a magic number.
// `zoom` models util.js's fitViewport scaling <html> to fit a desktop window:
// getBoundingClientRect comes back multiplied by it, computed font-size does
// not. Every rect this mock hands out is in that zoomed space, the way a real
// browser's are.
const PROBE = { baseline: IDLE_FS * 0.9219, zoom: 1 };
Element.prototype.getBoundingClientRect = function boxOf() {
  const probe = this.style?.display === 'inline-block';
  return {
    top: 0,
    bottom: probe ? PROBE.baseline * PROBE.zoom : 0,
    left: 0,
    right: 0,
    width: probe ? IDLE_FS * PROBE.zoom : 0,
    height: 0,
  };
};

// A synthetic 200x400 bitmap of "i" at weight 300, in exactly the frame the
// scan draws in: pen at x=50, baseline at y=300. Tittle rows 156-173 over
// columns 66-77, stem rows 190-299 over columns 68-75.
const SCAN_S = 200;
const SCAN_H = 400;
function iBitmap() {
  const data = new Uint8ClampedArray(SCAN_S * SCAN_H * 4);
  const ink = (y0, y1, x0, x1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[(y * SCAN_S + x) * 4 + 3] = 255;
  };
  ink(156, 173, 66, 77);
  ink(190, 299, 68, 75);
  return data;
}
// null is happy-dom's own answer and the one the page must survive: no canvas,
// no measurement, and the stylesheet's static fallbacks left standing.
let canvasCtx = null;
document.createElement('canvas').constructor.prototype.getContext = () => canvasCtx;

// The web font landing is what makes the probe run for real; hold the promise
// so a test can decide when that happens.
let fontsLanded;
const fontsReady = new Promise((resolve) => { fontsLanded = resolve; });
Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: fontsReady } });
Object.defineProperty(window, 'scrollY', { configurable: true, get: () => view.scrollY });
Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => view.innerHeight });
Object.defineProperty(document.documentElement, 'scrollHeight', {
  configurable: true,
  get: () => view.scrollHeight,
});
Element.prototype.scrollIntoView ??= () => {};
// Run the spy's frame inline. The handle must be 0: syncNav stores whatever
// this returns as its "a frame is already queued" flag, and a synchronous
// callback clears that flag BEFORE the assignment lands.
vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 0; });

await import('../site/js/info.js'); // module-scoped: reads the DOM built above

const navInner = document.querySelector('.nav__inner');
const scrollTo = (y) => {
  view.scrollY = y;
  window.dispatchEvent(new Event('scroll'));
};
const active = () => document.querySelector('.nav__link.is-active')?.getAttribute('href')?.slice(1) ?? '';

describe('/info scroll-spy', () => {
  it('lights the section whose top has passed the nav offset', () => {
    scrollTo(2500);
    expect(active()).toBe('commute');
  });

  it('lights the LAST section once the page bottoms out', () => {
    // The bug: at the very end of a tall viewport the last section's heading is
    // on screen but still 840px down, so the offset math never reaches it and
    // "Screensavers" stayed lit while the reader looked at "What's new".
    scrollTo(view.scrollHeight - view.innerHeight);
    expect(active()).toBe('whatsnew');
  });

  it('holds the last section through the slack at the very end', () => {
    scrollTo(view.scrollHeight - view.innerHeight - 3); // a fractional-pixel zoom
    expect(active()).toBe('whatsnew');
  });

  it('goes back to the first pill at the top, and sends the rail home with it', () => {
    scrollTo(3000);
    navInner.scrollLeft = 120; // the reader dragged the pill row while scrolling
    scrollTo(0);
    expect(active()).toBe('yours');
    expect(navInner.scrollLeft).toBe(0);
  });

  it('keeps the first pill on a page short enough to be top and bottom at once', () => {
    const tall = view.scrollHeight;
    view.scrollHeight = view.innerHeight; // nothing to scroll
    try {
      scrollTo(0);
      expect(active()).toBe('yours');
    } finally {
      view.scrollHeight = tall;
    }
  });
});

describe('/info places the power tittle off the face it actually rendered', () => {
  const h1 = document.querySelector('.hero__title');
  const varsOf = () => ['--im-base', '--im-tx', '--im-ty', '--im-tb', '--im-st', '--im-td', '--im-sx']
    .map((k) => h1.style.getPropertyValue(k));

  it('publishes the baseline alone when there is no canvas to scan with', () => {
    // The module has already run once by now, with a perfectly good baseline
    // available and getContext answering null. The two measurements fail
    // separately, so they publish separately (2026-08-26; the first stance
    // here was all-or-nothing, and a Desk Pro wearing the welcome mark
    // visibly low off the Helvetica Neue static baseline is what refuted it):
    // the baseline is real and the construction's dominant term, so it stands,
    // and the six ink offsets stay silent for the stylesheet's fallbacks.
    expect(varsOf()).toEqual(['0.9219', '', '', '', '', '', '']);
  });

  it('publishes the six measurements once the face has landed', async () => {
    canvasCtx = {
      font: '',
      textBaseline: '',
      fillStyle: '',
      fillText() {},
      getImageData: () => ({ data: iBitmap() }),
    };
    fontsLanded();
    await fontsReady;
    await new Promise((r) => setTimeout(r, 0)); // let the .then run

    // Every one of these falls out of the bitmap above, in em off the pen
    // origin and the baseline: the tittle spans rows 156-173 (so its bottom
    // edge is row 174) over columns 66-77, and the stem starts at row 190.
    expect(h1.style.getPropertyValue('--im-base')).toBe('0.9219'); // 0.9219em, probed
    expect(h1.style.getPropertyValue('--im-tx')).toBe('0.1100'); // tittle centre x
    expect(h1.style.getPropertyValue('--im-ty')).toBe('0.6750'); // tittle centre y
    expect(h1.style.getPropertyValue('--im-tb')).toBe('0.6300'); // tittle bottom
    expect(h1.style.getPropertyValue('--im-st')).toBe('0.5500'); // stem top
    expect(h1.style.getPropertyValue('--im-td')).toBe('0.1170'); // 1.3x the larger dimension
    expect(h1.style.getPropertyValue('--im-sx')).toBe('0.1100'); // stem centre x
  });

  it('reads the same baseline through a desktop fit-to-window zoom', async () => {
    // util.js's fitViewport lays a zoom on <html> for any window narrower than
    // 1920px, and getBoundingClientRect comes back multiplied by it while the
    // computed font-size does not. Dividing across the two spaces is how the
    // welcome mark shipped ~7.5px high on every desktop preview (2026-08-26:
    // base read 0.9664 times the 0.891 of zoom, so 0.8611). The probe measures
    // its em with its own zoomed rect width, so the answer is zoom-invariant.
    const { placeTittle } = await import('../site/js/tittle-probe.js');
    PROBE.zoom = 0.891;
    try {
      placeTittle(h1);
    } finally {
      PROBE.zoom = 1;
    }
    expect(h1.style.getPropertyValue('--im-base')).toBe('0.9219');
  });

  it('leaves the word itself untouched, probe and all', () => {
    // The probe is a span appended INTO the mark and pulled straight back out.
    // If it ever survived a run, the page would ship a stray element inside the
    // wordmark, and the one thing this construction exists to protect is that
    // the DOM keeps the plain word.
    const mark = document.querySelector('.hero__title .imark--led');
    expect(mark.textContent).toBe('idlescreen');
    expect(mark.querySelectorAll('span').length).toBe(2);
  });
});

// The guide is the one page a stranger reads first, so the brand it prints is
// worth a guard. Source text, not a DOM: the point is what ships on disk.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const html = await readFile(resolve(process.cwd(), 'site/info.html'), 'utf8');
const css = await readFile(resolve(process.cwd(), 'site/css/info.css'), 'utf8');
const shell = await readFile(resolve(process.cwd(), 'site/css/main.css'), 'utf8');
const macro = await readFile(resolve(process.cwd(), 'macro/Dashboard.js'), 'utf8');
const terms = await readFile(resolve(process.cwd(), 'site/terms.html'), 'utf8');
const frontdoor = await readFile(resolve(process.cwd(), 'tools/build-frontdoor.js'), 'utf8');
const settings = await readFile(resolve(process.cwd(), 'site/js/settings/settings.js'), 'utf8');
// The shell's boot script, read as TEXT: it boots a board at module scope, so
// importing it here would run the whole thing. The welcome card is a template
// literal inside it, which makes main.js the index.html of that surface.
const shellJs = await readFile(resolve(process.cwd(), 'site/js/main.js'), 'utf8');
const whatsnew = await readFile(resolve(process.cwd(), 'site/js/settings/whatsnew.js'), 'utf8');
const infoJs = await readFile(resolve(process.cwd(), 'site/js/info.js'), 'utf8');
const probeJs = await readFile(resolve(process.cwd(), 'site/js/tittle-probe.js'), 'utf8');

describe('/info wears the brand', () => {
  it('is titled for the product, and never title-cases it', () => {
    // The tab carries the tagline, not "Widget Guide": the page is the
    // product's front door now, and this string is also what search results
    // and link previews show (Sean's call, 2026-08-18).
    expect(html).toContain('<title>idlescreen · A dashboard for your idle screen</title>');
    // Lowercase, always. The one place a capital I could sneak back in is a
    // sentence start, so the rule is checked against the whole file — and the
    // camel-cased "IdleScreen" is named too, because one word means one word.
    expect(html).not.toMatch(/Idlescreen|IdleScreen/);
    expect(css).not.toMatch(/Idlescreen|IdleScreen/);
    // The retired name kept its own lowercase rule, and this still catches
    // residue: a sentence that was rewritten around "unsleep" and left
    // title-cased is a rename that only half landed.
    expect(html).not.toMatch(/Unsleep/);
    expect(css).not.toMatch(/Unsleep/);
  });

  it('carries no display mention of the retired names (URLs are a separate phase)', () => {
    // unsleep addresses are exempt: unsleep.app still answers, and the lede
    // says so on purpose. What must not survive is the retired name as the
    // PRODUCT's name in a sentence. quadrille gets no exemption at all: its
    // hosts retired to redirects 2026-09-26, so the page may not name them
    // even as addresses, and the whole file is checked, not the prose.
    const prose = html.replace(/https?:\/\/[^\s"'<>]+|>[^<]*unsleep\.(?:app|io)[^<]*</gi, '');
    expect(html).not.toMatch(/quadrill/i);
    expect(css).not.toMatch(/quadrill/i);
    expect(prose).not.toMatch(/unsleep/i);
    expect(css).not.toMatch(/unsleep/i);
  });

  it('sets the wordmark as two plain spans holding the exact word', () => {
    // Live, selectable text: no aria-hidden twin, no clip, nothing drawn twice.
    // The whole word has to come out of textContent in order.
    const mark = /<span class="imark(?: imark--led)?"><span class="imark__idle">idle<\/span><span class="imark__screen">screen<\/span><\/span>/g;
    expect(html.match(mark)).toHaveLength(3); // nav brand, masthead (LED), footer lockup
    expect(html).not.toMatch(/qmark|umark/);
    // Selectors, not the words: info.css still names the retired qmark in
    // prose, because why that construction was abandoned is the reason this
    // one is built the way it is.
    expect(css).not.toMatch(/\.(?:qmark|umark)\b/);
    expect(shell).not.toMatch(/\.(?:qmark|umark)\b/);

    // What the reader COPIES, which is the whole reason the accent is drawn
    // rather than typed. The brand sheet set the LED over a dotless ı (U+0131);
    // that spells "ıdlescreen" into a clipboard, a find bar, and a screen
    // reader, so it is banned on sight in both spellings.
    const host = document.createElement('div');
    host.innerHTML = html.match(mark)[0];
    expect(host.firstElementChild.textContent).toBe('idlescreen');
    // Comments are stripped first: both stylesheets name the glyph in prose,
    // and the comment explaining the ban is not a breach of it.
    expect(html.replace(/<!--[^]*?-->/g, '')).not.toMatch(/&#305;|ı/);
    expect(css.replace(/\/\*[^]*?\*\//g, '')).not.toMatch(/&#305;|ı/);
    expect(shell.replace(/\/\*[^]*?\*\//g, '')).not.toMatch(/&#305;|ı/);
  });

  it('spends the accent once per lockup, and the masthead alone wears the LED', () => {
    // The rule: wherever the mark is present it is the mark's lit card that
    // carries the blue, and the word beside it keeps its plain tittle at
    // every size — so the nav and footer lockups never take the modifier.
    // The masthead DOES (Sean's call at the rename vet, 2026-08-21): the
    // word stands alone at display scale there, the panel's cards being the
    // hero illustration's scenery rather than a lockup mark, and the LED
    // tittle is the wordmark's signature. Exactly one instance, on the h1.
    expect(html.match(/imark--led/g)).toHaveLength(1);
    expect(html).toMatch(/hero__title"><span class="imark imark--led"/);
    expect(html).not.toMatch(/nav__brand[^\n]*imark--led/);
    expect(html).not.toMatch(/footer__brand[^\n]*imark--led/);
    // The modifier exists identically in both sheets.
    expect(css).toMatch(/\.imark--led \.imark__idle::before/);
    expect(shell).toMatch(/\.imark--led \.imark__idle::before/);
  });

  it('draws the LED tittle as the power symbol, over a cover the surface supplies', () => {
    for (const sheet of [css, shell]) {
      // Two pseudo-elements and no third element: ::before covers the letter's
      // own tittle, ::after draws the ring on top of it.
      expect(sheet).toMatch(/\.imark--led \.imark__idle::after/);
      // The glyph is a MASK carrying the accent as a background-color, the
      // same idiom --cog uses, so the ink stays themable and no <svg> has to
      // enter the markup beside the word.
      const after = /\.imark--led \.imark__idle::after\s*\{[^}]*\}/.exec(sheet)?.[0] ?? '';
      expect(after).toContain('background-color: var(--accent)');
      expect(after).toMatch(/-webkit-mask: var\(--im-power\)/);
      expect(after).toMatch(/[^-]mask: var\(--im-power\)/);
      // The IEC 5009 geometry itself, in the 24-unit box: the stem, the ring's
      // arc, and the 2.6 stroke. These are the numbers the mockup round
      // settled on and they are what makes the mark the mark.
      expect(sheet).toContain("stroke-width='2.6'");
      expect(sheet).toContain("d='M12 4.5 V12.6'");
      expect(sheet).toContain("d='M7.76 8.94 A6.6 6.6 0 1 0 16.24 8.94'");

      // THE COUPLING. The ring is hollow, so the cover disc is mandatory, and
      // it can only be painted in the background it is actually worn on. That
      // used to be the literal #05070a of the guide's masthead panel; the
      // welcome card adopting the modifier made a second colour true at once,
      // so the constant became --im-cover, which every surface sets for itself.
      // What is pinned is that the disc still reads its colour from the surface
      // and still falls back to a real opaque one, plus the sentence saying why
      // a hollow ring forces the whole arrangement.
      const before = /\.imark--led \.imark__idle::before\s*\{[^}]*\}/.exec(sheet)?.[0] ?? '';
      expect(before).toContain('background: var(--im-cover, #05070a)');
      expect(sheet).toMatch(/hollow[^]{0,600}--im-cover|--im-cover[^]{0,600}hollow/);

      // The small-size fallback: below the size where the ring holds its hole,
      // ::after stands down and the cover disc becomes the accent dot this
      // modifier wore before. Keyed on device pixels as well as width.
      const small = /@media \(max-width: 687px\) and \(max-resolution: 1\.5dppx\) \{[^]*?\n\}/.exec(sheet)?.[0] ?? '';
      expect(small).toContain('.imark--led .imark__idle::before { background: var(--accent); }');
      expect(small).toContain('.imark--led .imark__idle::after { display: none; }');
    }
    // On paper the panel is white, so the cover disc would print as a blot in
    // whatever near-black --im-cover resolved to. Both halves stand down there
    // and the letter prints its own tittle. (Only the guide has a print block;
    // the shell has never had one, and a board does not print.)
    const print = /@media print \{[^]*$/.exec(css)?.[0] ?? '';
    expect(print).toMatch(/\.imark--led \.imark__idle::before,\n\s*\.imark--led \.imark__idle::after \{ display: none; \}/);
  });

  it('states every tittle offset against a variable the probe can replace', () => {
    // The lesson of the mockup round: three static baselines, each measured on
    // a face the page does not actually render, each confidently wrong. Every
    // offset is now a var() with a static fallback, so info.js can correct it
    // per face and a page with no script still lands somewhere true.
    for (const sheet of [css, shell]) {
      // Line-anchored, so the indented overrides inside the small-size media
      // query are not mistaken for the component's own two rules.
      const led = /^\.imark--led \.imark__idle::(?:before|after)\s*\{[^}]*\}/gm;
      const rules = sheet.match(led) ?? [];
      expect(rules).toHaveLength(2);
      for (const rule of rules) {
        for (const decl of ['left', 'top']) {
          const value = new RegExp(`\\n\\s*${decl}: ([^;]+);`).exec(rule)?.[1] ?? '';
          expect(value).toMatch(/var\(--im-[a-z]+, [0-9.]+\)/); // a variable AND a fallback
        }
      }
    }
    // The one number that is not a property of the face stays a constant.
    expect(css).toContain('--im-glyph: 0.26em');
    expect(shell).toContain('--im-glyph: 0.26em');
  });

  it('lights exactly one card on the masthead panel, and nothing sits behind the word', () => {
    // "The accent marks what is awake" is the system rule the hero draws, so
    // one solid accent card and three at descending light.
    expect((html.match(/class="hero__card /g) || []).length).toBe(4);
    expect((html.match(/hero__card--lit/g) || []).length).toBe(1);
    // The old field's class names stay dead; the RULING itself came back at
    // Sean's call (2026-08-18): the faint grid may run under the word, the
    // way the first masthead drew it, but it must stay a drawn ruling, never
    // imagery. So the panel's background-image is allowed to be exactly
    // linear-gradients, and a url() behind the letters is still a failure.
    expect(css).not.toMatch(/hero__field|hero__mod/);
    const screen = /\.hero__screen\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(screen).toContain('linear-gradient');
    expect(screen).not.toContain('url(');
  });

  it('points the head icons at the new masters', () => {
    expect(html).toContain('href="assets/idlescreen-quad.svg"');
    // PNGs, not SVGs, for the raster slots: iOS ignores an SVG
    // apple-touch-icon and would fall back to a page screenshot.
    expect(html).toContain('href="assets/idlescreen-favicon-32.png"');
    expect(html).toContain('href="assets/idlescreen-icon-180.png"');
  });

  it('keeps the shell\'s copy of the wordmark identical to this one', () => {
    // Two stylesheets, one component: the guide and the app shell both set the
    // mark, and a value that drifts between them ships two brands. Compare the
    // declarations rather than the prose around them.
    const rules = (sheet) => [...sheet.matchAll(/^\.imark[^{]*\{[^}]*\}/gms)]
      .map((m) => m[0].replace(/\/\*.*?\*\//gs, '').replace(/\s+/g, ' ').trim());
    expect(rules(shell)).toEqual(rules(css));
    expect(rules(css).length).toBeGreaterThan(3);
  });
});

// The second surface to wear the standalone form, and the first one on the
// product itself. Read as source text on both sides: main.js boots a board at
// module scope, so the welcome card can only be inspected as the template
// literal it is.
describe('the board\'s welcome card wears the standalone wordmark', () => {
  const brand = /<div class="welcome__brand"[^]*?<\/div>/.exec(shellJs)?.[0] ?? '';

  it('shows the word alone, with no mark left to compete with the tittle', () => {
    // The accent-once rule, applied to the board's one brand moment: with no
    // mark on the surface the word takes the accent, so the little SVG mark
    // that used to lead this lockup is gone from it entirely. Not shrunk, not
    // dimmed, but gone, because two saturated things read as decoration.
    expect(brand).toContain('<span class="imark imark--led welcome__word">');
    expect(brand).not.toMatch(/<svg/);
    expect(shellJs).not.toContain('welcome__mark');
    expect(shell).not.toContain('.welcome__mark');
    // Exactly one, the same guard the guide's masthead carries: a second LED
    // anywhere in the shell would be a second accent on some surface.
    expect(shellJs.match(/imark--led/g)).toHaveLength(1);
    // ...and every OTHER shell lockup keeps mark and plain word. The settings
    // rail is the one that could plausibly drift, so it is named.
    expect(whatsnew).toContain('<span class="settings__lockup imark" aria-hidden="true">');
    expect(whatsnew).not.toContain('imark--led');
  });

  it('keeps the word plain, copyable text spelling exactly "idlescreen"', () => {
    // Same contract as the masthead's: no glyph substitution, no dotless i, no
    // aria-hidden twin. The accent is DRAWN over the letter, so the DOM holds
    // the ordinary word and a board's find/copy/read-aloud all get it.
    const word = /<span class="imark imark--led welcome__word">.*?<\/span><\/span>/.exec(brand)?.[0];
    expect(word).toBeTruthy();
    const host = document.createElement('div');
    host.innerHTML = word;
    expect(host.firstElementChild.textContent).toBe('idlescreen');
    expect(host.firstElementChild.querySelectorAll('span').length).toBe(2);
    expect(shellJs.replace(/\/\*[^]*?\*\/|<!--[^]*?-->/g, '')).not.toMatch(/&#305;|ı/);
  });

  it('paints the cover disc in the card\'s own background, not the guide\'s panel', () => {
    // The whole reason #05070a became a variable. This surface is #121212, and
    // a cover painted in the guide's panel colour would read as a dark fleck
    // beside the blue ring at 72px on a board nobody can zoom.
    const rule = /^\.welcome__brand \{[^}]*\}/m.exec(shell)?.[0] ?? '';
    expect(rule).toContain('--im-cover: var(--bg-card)');
    // And --bg-card has to stay OPAQUE: an alpha surface colour would let the
    // letter's own tittle show through the disc that exists to hide it.
    expect(shell).toContain('--bg-card: #121212');
  });

  it('sets the word big enough that the ring holds its hole at 1x', () => {
    // The sharp constraint, and the reason this size is not a taste call. A
    // Board Pro is 1920x1080 LOGICAL on a 1920x1080 panel: one CSS pixel is one
    // device pixel, with no retina density to hide a soft raster in. The glyph
    // box is 0.26em and the ring needs ~11 device px across before its hole
    // survives (info.css's raster study), so the word has a hard floor of about
    // 44px and no reason to sit anywhere near it.
    const rule = /^\.welcome__word \{[^}]*\}/m.exec(shell)?.[0] ?? '';
    const px = Number(/font-size: (\d+)px/.exec(rule)?.[1]);
    expect(px).toBeGreaterThanOrEqual(48);
    expect(px * 0.26).toBeGreaterThan(11);
  });

  it('runs the guide\'s probe rather than a second copy of it', () => {
    // 150 lines of canvas ink-scanning that must produce the same mark on two
    // very different faces (a desktop Helvetica Neue or SF, and the board's
    // CiscoSansTT). Two copies would be two marks the first time one is fixed.
    expect(infoJs).toContain("import { trackTittle } from './tittle-probe.js'");
    expect(infoJs).toContain("trackTittle(document.querySelector('.hero__title'))");
    expect(shellJs).toContain("import { trackTittle } from './tittle-probe.js'");
    expect(shellJs).toContain("trackTittle(welcome.querySelector('.welcome__brand'))");
    // The scan lives in exactly one file.
    expect(probeJs).toContain('getImageData');
    expect(infoJs).not.toContain('getImageData');
    expect(shellJs).not.toContain('getImageData');
    // Gen1 Qt WebEngine safety, which is the same posture as the no-JS case:
    // every capability is felt for, and a panel that cannot answer keeps the
    // stylesheet's static placement instead of getting a broken one.
    expect(probeJs).toContain("cv.getContext?.('2d')");
    expect(probeJs).toContain("typeof ctx.fillText !== 'function'");
    expect(probeJs).toContain('document.fonts?.ready?.then?.');
  });

  it('ships the probe to the front door, which no HTML reference could catch', () => {
    // info.js imports it, and build-frontdoor's original guard only reads
    // index.html's href/src, so a module extracted out of info.js would 404 on
    // idlescreen.io with every HTML reference still resolving. The list entry
    // and the guard that enforces it are both pinned.
    expect(frontdoor).toContain("['js/tittle-probe.js', 'js/tittle-probe.js']");
    expect(frontdoor).toContain('RELATIVE_IMPORT');
    expect(frontdoor).toMatch(/front door modules import files it does not ship/);
  });
});

describe('/info says how idlescreen gets on a board', () => {
  // The gap this closes: the guide serves from idlescreen.io and the dashboard
  // from idlescreen.app, so before 2026-08-19 a stranger could not work out the
  // address to point a board at from anything on the page.
  it('answers the question before the page assumes the answer', () => {
    const board = html.indexOf('id="board"');
    const yours = html.indexOf('id="yours"');
    expect(board).toBeGreaterThan(-1);
    // Everything under Making it yours assumes a board already showing
    // idlescreen, so the install cannot come after it.
    expect(board).toBeLessThan(yours);
    expect(html).toContain('<a class="nav__link" href="#board">');
  });

  it('agrees with the macro about the address', () => {
    // The README once claimed this default had already moved while the macro
    // still shipped app.quadrille.io — a drift nobody could see from either
    // file alone, and the page teaches whatever the macro does not. Two
    // sources, one assertion, and it has now survived two renames AND the
    // 2026-08-26 slimming: the xConfiguration block moved to the docs, so the
    // page's copy of the address is now the lede's link.
    const macroUrl = /const SIGNAGE_URL = '([^']+)'/.exec(macro)?.[1];
    expect(macroUrl).toBe('https://idlescreen.app');
    expect(html).toContain('<a href="https://idlescreen.app">https://idlescreen.app</a>');
  });

  it('sends the reader to the install detail it no longer carries', () => {
    // The section slimmed to a teaser 2026-08-26 (Sean's pick, variant B);
    // the contract it took on in exchange: every door it closed opens in the
    // docs. The touch setting, the configurations, the macro file and the
    // non-touch path all live behind these three links now, so the links ARE
    // the content — a teaser that loses one silently strands that reader.
    expect(html).toContain('https://idlescreen.io/docs/board/point-your-board/');
    expect(html).toContain('https://idlescreen.io/docs/board/the-macro/');
    expect(html).toContain('https://idlescreen.io/docs/board/non-touch-devices/');
  });

  it('keeps the anchors old deep links land on', () => {
    // Display Modes moved to the docs, but /info#modes is in the wild; the
    // bare anchor keeps it landing inside Making it yours.
    expect(html).toContain('id="modes"');
  });
});

describe('/terms', () => {
  it('wears the same name and the same icons as the guide', () => {
    expect(terms).toContain('<title>Terms · idlescreen</title>');
    expect(terms).not.toMatch(/Idlescreen|IdleScreen|Unsleep/);
    expect(terms).not.toMatch(/umark|&#305;|ı/);
    expect(terms).toContain('href="assets/idlescreen-quad.svg"');
    expect(terms).toContain('href="assets/idlescreen-favicon-32.png"');
    expect(terms).toContain('href="assets/idlescreen-icon-180.png"');
  });

  it('the service clause names the current pair and stays quiet about the rest', () => {
    // Sean's call at the rename vet (2026-08-21): the roll-call of every
    // earlier address read as archaeology, and the page serves on all of
    // those domains anyway — whoever reads it from unsleep.app/terms is
    // reading THIS page. The clause names the current pair only.
    const service = /The service<\/h2>\s*<p class="row__desc">([^]*?)<\/p>/.exec(terms)?.[1] ?? '';
    for (const host of ['idlescreen.io', 'idlescreen.app']) expect(service).toContain(host);
    expect(service).not.toContain('quadrille');
    expect(service).not.toContain('roomboard');
  });

  it('is reachable from the guide and reaches back', () => {
    expect(html).toContain('<a class="footer__link" href="terms.html">Terms &amp; privacy</a>');
    expect(terms).toContain('href="info.html"');
  });

  it('keeps every internal link relative, because it serves from two origins', () => {
    // The same bytes answer on idlescreen.io (where the guide is the root) and
    // idlescreen.app (where it is /info). A root-absolute link resolves on one
    // and 404s on the other, and nothing in CI would notice.
    const internal = [...terms.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((h) => !/^https?:/.test(h) && !h.startsWith('#'));
    expect(internal.length).toBeGreaterThan(0);
    for (const href of internal) expect(href.startsWith('/')).toBe(false);
  });

  it('ships to the front door as well as the app', () => {
    // build-frontdoor.js fails the build when the guide references a file it
    // does not copy, so this is belt to that brace: it catches the case where
    // BOTH the footer link and the copy are dropped together.
    expect(frontdoor).toContain("['terms.html', 'terms.html']");
  });

  it('keeps every superseded icon set shipping beside the current one', () => {
    // The front door caches normally, and Pages propagates PER-ASSET, so HTML
    // cached under an earlier name is still being served after the rename and
    // still asks for the icons that name used. Dropping a set 404s them on a
    // page nobody can force to refresh, so the list only ever grows.
    for (const name of ['idlescreen', 'unsleep']) {
      expect(frontdoor).toContain(`['assets/${name}-quad.svg', 'assets/${name}-quad.svg']`);
      expect(frontdoor).toContain(`['assets/${name}-favicon-32.png', 'assets/${name}-favicon-32.png']`);
      expect(frontdoor).toContain(`['assets/${name}-icon-180.png', 'assets/${name}-icon-180.png']`);
    }
    expect(frontdoor).toContain("['assets/quadrille-favicon-32.png', 'assets/quadrille-favicon-32.png']");
    expect(frontdoor).toContain("['assets/quadrille-icon-180.png', 'assets/quadrille-icon-180.png']");
  });

  it('carries the clauses a reviewer looks for, not just the honest ones', () => {
    expect(terms).toMatch(/as is and as available/i);
    expect(terms).toMatch(/warranties are disclaimed/i);
    expect(terms).toMatch(/Cloudflare/);
    // The security posture is a strength and the page used to omit it, which
    // left a reviewer's most-asked question answered by silence.
    expect(terms).toMatch(/Content-Security-Policy/);
    // The examples of "it got something wrong" have to be things idlescreen
    // actually shows. It has no calendar and never has (Sean's catch,
    // 2026-08-19), so a late meeting was promising a feature. The macro
    // clause's `wake-at-meeting-start` is a RoomOS config name and stays.
    expect(terms).not.toMatch(/a meeting joined late/);
    // Sean's call, 2026-08-19: the page names no individual. The liability
    // exclusion runs to "the maintainer", and LICENSE stays the one place
    // the copyright holder is named (MIT requires that notice be kept).
    expect(terms).not.toMatch(/Sean Scott/);
  });

  it('answers the corporate checklist by name, with facts verified in-tree', () => {
    // 2026-08-27: the page is what an employee sends to legal, so the items a
    // reviewer ticks off have to be findable by their names. Each fact here
    // was checked before it was written; a test keeps the copy from drifting
    // away from the code it describes.
    for (const id of ['privacy', 'security', 'counts', 'liability']) expect(terms).toContain(`id="${id}"`);
    // Privacy is a NAME on two rows, not a group label: a subhead over the
    // middle of a flat list claimed every row after it (Sean's catch,
    // 2026-08-27), so the pair carries the word in its own labels instead.
    expect(terms).not.toMatch(/class="subhead/);
    expect(terms).toMatch(/Privacy: what it keeps/);
    expect(terms).toMatch(/Privacy: what it counts/);
    expect(terms).toMatch(/no cookies/i); // no document.cookie / Set-Cookie anywhere in site or worker
    expect(terms).toMatch(/three months/); // Analytics Engine's documented retention
    expect(terms).toMatch(/capped at what you.{1,7}ve paid/); // the cap behind the exclusion
    expect(terms).toMatch(/the rest still stand/); // severability
    expect(terms).toMatch(/the licence wins/); // MIT governs the code, the terms govern the service
    // The fleet off-switch is only true because encodeConfig keeps a non-default
    // beacon on the wire; if that strip line ever flips, this sentence is a lie.
    expect(terms).toMatch(/Get signage URL/);
    expect(html).toContain('id="whatsnew"'); // the Changes clause links here
  });

  it('names the beacon opt-out exactly as the board spells it', () => {
    // Terms that point at a setting by the wrong name are worse than terms
    // that omit it: the reader hunts, fails, and concludes there is no
    // opt-out. Two files, one assertion, same guard as the macro URL.
    expect(settings).toContain('Anonymous usage ping');
    expect(terms).toContain('Anonymous usage ping');
  });

  it('borrows the guide\'s stylesheet instead of growing its own', () => {
    expect(terms).toContain('href="css/info.css"');
    expect(terms).not.toMatch(/<script/);
  });
});
