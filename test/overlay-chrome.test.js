/**
 * @vitest-environment happy-dom
 *
 * The shared chrome of the full-screen views, and the two things about it that
 * a DOM test can hold but a browser sweep cannot repeat cheaply:
 *
 *  - the hint band's arithmetic, which is split between main.css (the pixels)
 *    and expand.js (the canvas the widget models reserve against). Nothing
 *    re-measures those two against each other at runtime, so they are pinned
 *    here: the stylesheet is read back and the sum re-done.
 *  - the constructions that must not depend on the RENDERING FONT's metrics.
 *    The board runs CiscoSansTT and every measurement in this repo was taken in
 *    a browser running the desktop fallback, so anything whose size or centring
 *    follows ascent/descent behaves differently on the two.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OVERLAY_BODY_H, BOARD_VIEWPORT_H } from '../site/js/expand.js';
import { imageFit, CURATED_SOURCES, SCREENSAVER_SOURCES } from '../site/js/config.js';
import { openImageViewer } from '../site/js/imageshow.js';

// happy-dom swaps the global URL for a document-relative one, so resolve the
// stylesheet through node's own path helpers rather than new URL(..., meta.url).
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../site/css/main.css'), 'utf8');

// The body of a rule, by exact selector. Deliberately literal: if someone
// renames or splits the rule this throws rather than silently passing.
function rule(selector) {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for "${selector}" in main.css`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}
// One declaration's value out of a rule body.
function decl(selector, prop) {
  const m = rule(selector).match(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;}]+)`));
  expect(m, `no ${prop} in "${selector}"`).not.toBeNull();
  return m[1].trim();
}
const px = (v) => {
  const n = Number.parseFloat(v);
  expect(Number.isFinite(n), `not a number: ${v}`).toBe(true);
  return n;
};

// The overlay is position:fixed, so every offset below is measured from the
// VIEWPORT's bottom edge — 1040 on a Board Pro (measured on-device 2026-07-28),
// 1200 on a Room Navigator, 1080 in the headless harness. The band's shape has
// to be the same on all three, so the arithmetic here is done in H.
const BOARD_H = 1040;
const HARNESS_H = 1080;

describe('full-screen overlay chrome: the hint band', () => {
  const padTop = px(decl('.expand', 'padding'));
  const headH = px(decl('.expand__head', 'height'));
  const bodyTop = px(decl('.expand__body', 'margin-top'));
  const band = px(decl('.expand__body', 'padding-bottom'));
  const hintFs = px(decl('.expand__hint', 'font-size'));
  const hintLh = px(decl('.expand__hint', 'line-height'));
  const hintLift = px(decl('.expand__hint', 'bottom'));

  const contentFloor = (H) => H - band;                       // a widget's last pixel
  const hintTop = (H) => H - hintLift - hintFs * hintLh;
  const gap = (H) => hintTop(H) - contentFloor(H);

  it('puts real air between the data and the hint', () => {
    // Was ~22px, which read as part of the data rather than as chrome.
    expect(gap(BOARD_H)).toBeCloseTo(41.6, 1);
    expect(gap(BOARD_H)).toBeGreaterThan(2 * 22.7 * 0.8);
    expect(contentFloor(BOARD_H)).toBeLessThan(hintTop(BOARD_H));
  });

  it('gives the same band on a board, a Navigator and the harness', () => {
    // Nothing here is keyed to a device height: .expand is fixed to the viewport
    // and .expand__body flexes, so the whole band is viewport-relative.
    for (const H of [BOARD_H, HARNESS_H, 1200]) expect(gap(H)).toBeCloseTo(41.6, 1);
  });

  it('reserves no band for an OS bar that is not there', () => {
    // Corrected 2026-07-28: the Board Pro's viewport is 1920x1040 and RoomOS
    // paints its "Tap here to start" bar in the 40 physical px BELOW it, not
    // over page content. The hint's old 52px lift was clearance for a bar that
    // never overlapped it; that clearance is now air above the hint instead.
    expect(hintLift).toBeLessThan(52);
    // Still a margin, not flush: the hint is type, not a decorative band.
    expect(hintLift).toBeGreaterThanOrEqual(24);
  });

  it('sizes the canvas both overlay models reserve against to the BOARD', () => {
    // expand.js cannot read the stylesheet, so this is the join: change a pixel
    // in main.css and OVERLAY_BODY_H has to move with it. The height it is
    // measured at is the board's 1040 — the smallest viewport any supported
    // device gives — so a wall modelled against it fits every one of them.
    expect(BOARD_VIEWPORT_H).toBe(BOARD_H);
    expect(BOARD_H - padTop - headH - bodyTop - band).toBe(OVERLAY_BODY_H);
    expect(OVERLAY_BODY_H).toBe(814);
    // The harness and the Navigator are TALLER, so the models under-fill there.
    // That slack is deliberate and stays unspent — see the DECIDED note on
    // OVERLAY_BODY_H in expand.js: a measured canvas would give a Navigator
    // 160px no model has been checked at, and markets' wall has no measured
    // backstop to catch it. A model tuned to the harness's 1080 is exactly how
    // a wall came to over-pack a real board by 40px.
    for (const H of [HARNESS_H, 1200]) {
      expect(H - padTop - headH - bodyTop - band).toBeGreaterThan(OVERLAY_BODY_H);
    }
  });

  it('keeps the fixed PAGE and the device VIEWPORT as separate numbers', () => {
    // The mistake this whole correction undid was reading one as the other.
    // main.css pins html/body to a fixed 1920x1080 page that every device gets
    // identically — which is why js/capacity.js's per-size row tables are NOT
    // device-derived and did not move when the board's real viewport turned out
    // to be 1040. Only the position:fixed overlays see the viewport.
    expect(px(decl('html, body', 'width'))).toBe(1920);
    expect(px(decl('html, body', 'height'))).toBe(1080);
    expect(decl('html, body', 'overflow')).toBe('hidden');
    expect(decl('.expand', 'position')).toBe('fixed');
    // The page's last 40px fall off a board's screen, and the --safe-bottom
    // reserve is what keeps the grid clear of that edge. Browser-verified: the
    // grid ends at y=996, so it clears 1040 by 44px at every card size.
    const safeBottom = px(/--safe-bottom:\s*([^;]+)/.exec(css)[1]);
    expect(safeBottom).toBeGreaterThan(1080 - BOARD_VIEWPORT_H);
  });

  it('lets an alert well overflow the wall rather than silently squashing', () => {
    // .sbalert is a flex item of a height-constrained column in the wall's
    // single-column rung. Without flex:none it shrank to fit and cropped its own
    // text away inside overflow:hidden — with scrollHeight still equal to
    // clientHeight, so the ladder could not even tell it had failed.
    expect(decl('.sbalert', 'flex')).toBe('none');
    expect(decl('.wall__good', 'flex')).toBe('none');
    expect(decl('.wall__rule', 'flex')).toBe('none');
  });

  it('pins the hint band against the rendering font', () => {
    // A `normal` line-height is read off the font, so the same rule would leave
    // a different gap on the board than in the browser this was measured in.
    expect(decl('.expand__hint', 'line-height')).toBe('1.2');
    // Same reason the head has an explicit height: it is baseline-aligned type,
    // and its natural height follows the font's ascent.
    expect(headH).toBe(34);
  });
});

describe('font-metric-independent boxed labels', () => {
  const face = css.slice(css.indexOf('@font-face {'), css.indexOf('}', css.indexOf('@font-face {')));

  it('pins the centred face so ascent - descent is a cap height', () => {
    // CSS centres the LINE BOX, never the glyphs: the baseline always lands at
    // box-centre + (ascent - descent)/2. Pin that difference to a cap height and
    // the caps come out centred whatever font the OS supplies. Browser-measured
    // over five synthetic metric profiles: 7px of spread collapses to 0.2px.
    const asc = px(face.match(/ascent-override:\s*([\d.]+)%/)[1]);
    const desc = px(face.match(/descent-override:\s*([\d.]+)%/)[1]);
    expect(asc - desc).toBe(72);
    expect(face).toContain('line-gap-override: 0%');
  });

  it('resolves to the same physical font as the body copy beside it', () => {
    // If the alias picked a different local face from --font-board, a badge
    // would render in a different typeface from the words next to it.
    // Named families only: local() cannot express -apple-system or a generic.
    const named = (v) => v
      .replace(/local\(|\)/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s && s !== 'sans-serif' && !s.startsWith('-'));
    const board = named(decl(':root', '--font-board'));
    const alias = named(face.match(/src:([^;]+)/s)[1]);
    expect(alias.slice(0, board.length)).toEqual(board);
    // ...and falls back to the plain stack if none of the names resolve.
    expect(decl(':root', '--font-centred')).toBe("'RB Centred', var(--font-board)");
  });

  it('centres the subway status pill by layout, on the pinned face', () => {
    // Both halves are needed: measured, the metrics alone still leave the label
    // a pixel high under a line-height construction, and the flex centring alone
    // moves it not at all (all three constructions measured identical).
    expect(decl('.sbstatus', 'display')).toBe('inline-flex');
    expect(decl('.sbstatus', 'align-items')).toBe('center');
    expect(decl('.sbstatus', 'justify-content')).toBe('center');
    expect(decl('.sbstatus', 'font-family')).toBe('var(--font-centred)');
    // The box the alert-type ladder was measured against is unchanged, as the
    // default: the rungs whose 0.74em would fall under 18px override it (see the
    // 18px-tier test beside the ladder in expand.test.js).
    expect(decl('.sbstatus', 'height')).toBe('var(--well-sh, 1.5em)');
    expect(decl('.sbstatus', 'font-size')).toBe('var(--well-sfs, 0.74em)');
    expect(decl('.sbstatus', 'vertical-align')).toBe('0.1em');
  });

  it('covers the other fixed-size boxes in the same family', () => {
    // The line bullet is the same idiom (a fixed circle, one glyph centred in
    // it) and had the same latent offset; the well's copy is pinned so the
    // pill's fit inside its line box stops depending on the OS font's ascent.
    expect(decl('.bullet', 'font-family')).toBe('var(--font-centred)');
    expect(decl('.sbalert__text', 'font-family')).toBe('var(--font-centred)');
  });
});

// ---------------------------------------------------------------------------
// A full-screen view is a RE-READ of the card that opened it, so the things
// that carry a card's identity — the shape a logo sits in, the colour of a
// leading numeral, the amber on a status word — have to survive the tap. Every
// item below is a place the expand wave of 2026-08-01 dropped one, found by
// Sean on the boards the next morning. They are all one declaration each, which
// is exactly why they are cheap to lose and worth pinning.
// ---------------------------------------------------------------------------
describe('a view keeps the treatment of the card it came from', () => {
  // border-radius on a replaced element trims its content to the CONTENT-EDGE
  // curve, whose radius shrinks by the padding — so a rounded <img> masks the
  // mark with a small circle NO padding value can escape (two shipped padding
  // "fixes" proved it; Sean read the ring mask straight off the glass). The
  // only correct shape is structural: the disc is a wrapper painting behind an
  // unclipped image. These pins hold that structure, not a tuned number.
  const crest = (sel, imgSel) => {
    const disc = px(decl(sel, 'width'));
    expect(px(decl(sel, 'height'))).toBe(disc); // a circle, so it must be square
    const mark = px(decl(imgSel, 'width'));
    return { disc, mark };
  };

  it('paints the disc behind the mark and never clips it, card and view alike', () => {
    // The load-bearing ABSENCE: the img must carry no radius and no padding —
    // either one re-arms the content-edge mask. (decl() asserts presence, so
    // absence reads the raw rule text.)
    expect(rule('.team__logo')).not.toMatch(/border-radius|padding/);
    expect(decl('.team__logo', 'object-fit')).toBe('contain');
    // The radius lives ONCE, on the base disc; overrides only resize it.
    expect(decl('.team__crest', 'border-radius')).toBe('50%');
    const card = crest('.team__crest', '.team__logo');
    const view = crest('.team--board .team__crest', '.team--board .team__logo');
    expect(view.disc).toBeGreaterThan(card.disc); // the view reads at reading size
    expect(view.mark).toBeGreaterThan(card.mark);
    // Optical containment (nothing clips; this keeps the mark's diagonal
    // inside the disc so the composition reads as a badge, not an overflow).
    expect(card.mark * Math.SQRT2).toBeLessThanOrEqual(card.disc);
    expect(view.mark * Math.SQRT2).toBeLessThanOrEqual(view.disc);
  });

  it('leads the day view with the card\'s accent years', () => {
    // The years are the column the card leads its rows with, and the tap that
    // opened the view was a tap on those. The view had them in plain --ink.
    expect(decl('.history__year', 'color')).toBe('var(--accent)');
    expect(decl('.history-board .history__year', 'color')).toBe('var(--accent)');
  });

  it('keeps the card\'s amber on an unavailable service, on the state word', () => {
    // The card says it twice over: the state word rests quiet, but the note
    // under it ("Status unavailable") is --warn. The ledger has no second line
    // to carry that — its note slot holds the operator's prose — so the amber
    // rides the state word, which is where every ledger tone lives.
    expect(decl('.svc__note', 'color')).toBe('var(--warn)');
    expect(decl('.ledger__state--unknown', 'color')).toBe('var(--warn)');
    // Still not a confirmed outage: --bad stays reserved for major.
    expect(decl('.ledger__state--unknown', 'color')).not.toBe('var(--bad)');
    expect(decl('.ledger__state--major', 'color')).toBe('var(--bad)');
    // ...and the prose beneath stays quiet, so the row has exactly one alarm.
    expect(decl('.ledger__note', 'color')).toBe('var(--ink-dim)');
  });

  it('sets the reading list at regular weight, and leaves the card bold', () => {
    // Bold buys salience by being RARE. Three headlines on a card are three
    // things worth noticing; twenty-one of them are a wall where nothing leads
    // (Sean: "heavy/thick/loud... not comfortable to scan"). Size and full ink
    // still separate a headline from its metadata in the list.
    expect(px(decl('.headline__title', 'font-weight'))).toBe(600);
    expect(px(decl('.headline__src', 'font-weight'))).toBe(600);
    expect(px(decl('.news-board .headline__title', 'font-weight'))).toBe(400);
    expect(px(decl('.news-board .headline__src', 'font-weight'))).toBe(400);
    // Colours are untouched, and the list still reads BIGGER than the card.
    expect(css).not.toMatch(/\.news-board \.headline__title \{[^}]*color:/);
    const size = px(decl('.news-board .headline__title', 'font-size'));
    expect(size).toBeGreaterThan(px(decl('.headline__title', 'font-size')));
    // Bulk reading wants air between the lines; the pinned pixels are ~1.3.
    expect(px(decl('.news-board .headline__title', 'line-height')) / size)
      .toBeGreaterThanOrEqual(1.3);
  });
});

describe('full-screen image fit', () => {
  it('matches each widget to how its OWN screensaver shows the same photo', () => {
    // Curated scenery fills the glass; art and a viewer's own album letterbox
    // (you do not crop a painting, and a personal album is full of portraits).
    expect(imageFit('landscapes')).toBe('cover');
    expect(imageFit('photos')).toBe('contain');
    expect(imageFit('gdrivephotos')).toBe('contain');
    expect(imageFit('art')).toBe('contain');
    expect(imageFit('apod')).toBe('contain');
    expect(imageFit('chart')).toBe('contain');
  });

  it('is one rule, so a new curated source cannot disagree with itself', () => {
    for (const id of Object.keys(CURATED_SOURCES)) {
      expect(imageFit(id), id).toBe('cover');
      expect(SCREENSAVER_SOURCES).toContain(id);
    }
  });

  it('has a fill mode in the viewer stylesheet, contain by default', () => {
    expect(decl('.art-viewer__img', 'object-fit')).toBe('contain');
    expect(decl('.art-viewer--fill .art-viewer__img', 'object-fit')).toBe('cover');
  });
});

describe('the viewer applies the fit it is opened with', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  const open = (fit) =>
    openImageViewer({ img: 'x.jpg', title: 'A' }, { widgets: [] }, { list: [], caption: false, strip: false, fit });

  it('fills on cover and letterboxes on contain, across reopens', () => {
    open('cover');
    expect(document.querySelector('#art-viewer').classList.contains('art-viewer--fill')).toBe(true);
    // The viewer element is shared by every image card, so the class has to be
    // set per open, not once at creation.
    open('contain');
    expect(document.querySelector('#art-viewer').classList.contains('art-viewer--fill')).toBe(false);
    open('cover');
    expect(document.querySelector('#art-viewer').classList.contains('art-viewer--fill')).toBe(true);
  });

  it('letterboxes when no fit is asked for', () => {
    openImageViewer({ img: 'x.jpg', title: 'A' }, { widgets: [] }, { list: [], caption: false, strip: false });
    expect(document.querySelector('#art-viewer').classList.contains('art-viewer--fill')).toBe(false);
  });
});
