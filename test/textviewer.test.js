/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initTextViewer, openTextViewer, openStoryViewer, fitStoryDesc, descLineBudget,
} from '../site/js/textviewer.js';

describe('text viewer', () => {
  it('opens on tap of truncated text with the card title, closes on tap', () => {
    document.body.innerHTML = `<div id="grid">
      <article class="card card--subway"><h2 class="card__title">Subway Status</h2>
        <div class="card__body"><div class="linestatus">
          <span class="linestatus__text">Downtown [1][2][3] trains are running with delays after severe weather</span>
        </div></div>
      </article></div>`;
    const grid = document.querySelector('#grid');
    initTextViewer(grid, { truncated: () => true });
    grid.querySelector('.linestatus__text').click();
    const viewer = document.querySelector('#text-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer.hidden).toBe(false);
    expect(viewer.textContent).toContain('severe weather');
    expect(viewer.textContent).toContain('Subway Status');
    viewer.click();
    expect(viewer.hidden).toBe(true);
  });

  it('ignores taps on text that fits', () => {
    document.body.innerHTML = `<div id="grid"><article class="card"><div class="talert"><span class="talert__text">Short</span></div></article></div>`;
    const grid = document.querySelector('#grid');
    initTextViewer(grid, { truncated: () => false });
    grid.querySelector('.talert__text').click();
    expect(document.querySelector('#text-viewer')?.hidden ?? true).toBe(true);
  });

  // A subway alert row draws the lines its prose names as bullets (routeBullets),
  // and the reader is the same sentence at reading size — so it has to be the
  // same sentence, bullets and all. Read as textContent the spans collapse to
  // bare numerals: "In Manhattan, no 1 between 14 St and South Ferry".
  const bulletRow = () => {
    document.body.innerHTML = `<div id="grid">
      <article class="card card--subway"><h2 class="card__title">Subway Status</h2>
        <div class="card__body"><div class="linestatus linestatus--alert">
          <span class="bullet bullet--1">1</span>
          <span class="linestatus__text">In Manhattan, no <span class="bullet bullet--1 bullet--inline">1</span> between 14 St and South Ferry, and no <span class="bullet bullet--2 bullet--inline">2</span> service.</span>
        </div></div>
      </article></div>`;
    const grid = document.querySelector('#grid');
    initTextViewer(grid, { truncated: () => true });
    grid.querySelector('.linestatus__text').click();
    return document.querySelector('.text-viewer__body');
  };

  it('carries the route bullets into the reader rather than flattening them', () => {
    const body = bulletRow();
    expect([...body.querySelectorAll('.bullet--inline')].map((b) => b.textContent)).toEqual(['1', '2']);
    // Each keeps its own line colour class, and the sentence is intact around them.
    expect(body.querySelector('.bullet--1.bullet--inline')).not.toBeNull();
    expect(body.querySelector('.bullet--2.bullet--inline')).not.toBeNull();
    expect(body.textContent).toContain('between 14 St and South Ferry');
    // The ROW's own leading bullet stays on the card: the reader shows the text
    // that was clamped, not the row around it.
    expect(body.querySelectorAll('.bullet').length).toBe(2);
  });

  it('escapes a row with no bullets in it — the markup path is opt-in', () => {
    // Rail alert banners are plain escaped text (renderAlertRows), so the
    // reader must keep treating them as text: feed copy that LOOKS like markup
    // reads as words, exactly as it does on the card.
    document.body.innerHTML = `<div id="grid"><article class="card"><div class="talert">
      <span class="talert__text">Delays &lt;b&gt;east&lt;/b&gt; of Babylon</span></div></article></div>`;
    const grid = document.querySelector('#grid');
    initTextViewer(grid, { truncated: () => true });
    grid.querySelector('.talert__text').click();
    const body = document.querySelector('.text-viewer__body');
    expect(body.querySelector('b')).toBeNull();
    expect(body.textContent).toContain('Delays <b>east</b> of Babylon');
  });

  it('escapes by default on the direct API too, and takes markup only on request', () => {
    document.body.innerHTML = '';
    openTextViewer('Cloud Services', 'Sign-in <b>degraded</b>');
    expect(document.querySelector('.text-viewer__body b')).toBeNull();
    openTextViewer('Subway Status', 'no <span class="bullet bullet--1 bullet--inline">1</span> service', { html: true });
    expect(document.querySelector('.text-viewer__body .bullet--inline')?.textContent).toBe('1');
  });

  it('pins the close hint to the viewer, outside the panel, for both views', () => {
    // Out of the panel's flow, so it reads in the same spot as the tap view's
    // hint and costs the story summary's height budget nothing.
    document.body.innerHTML = '';
    openTextViewer('Cloud Services', 'Sign-in degraded');
    const viewer = document.querySelector('#text-viewer');
    const hintOf = () => viewer.querySelector('.text-viewer__hint');
    expect(hintOf().textContent).toBe('Tap anywhere to close');
    expect(hintOf().parentElement).toBe(viewer);
    expect(viewer.querySelector('.text-viewer__panel .text-viewer__hint')).toBeNull();
    openStoryViewer({ title: 'Headline', source: 'NYT', age: '2m', desc: 'Summary', link: 'https://example.com/a' });
    expect(viewer.querySelectorAll('.text-viewer__hint')).toHaveLength(1);
    expect(hintOf().parentElement).toBe(viewer);
    expect(viewer.querySelector('.text-viewer__panel .text-viewer__hint')).toBeNull();
  });

  it('auto-dismisses after 20 seconds so an abandoned board recovers', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    openTextViewer('LIRR · Penn Station', 'There are some delays on the Montauk branch east of Babylon');
    const viewer = document.querySelector('#text-viewer');
    expect(viewer.hidden).toBe(false);
    expect(viewer.textContent).toContain('Montauk');
    vi.advanceTimersByTime(20001);
    expect(viewer.hidden).toBe(true);
    vi.useRealTimers();
  });
});

/*
 * The story view has no scroller by design, so a panel taller than the viewport
 * used to lose content at BOTH ends — and the top end silently, because
 * `align-items: center` overflows a too-tall flex item past the start edge where
 * nothing can reach it. Two things now stop that: safe centring in the
 * stylesheet, and the summary being fitted to the measured screen here.
 *
 * The pixel numbers below were measured in headless Chrome at 1920 wide on the
 * shipped classes: a 30px/1.5 summary is a 45px line, and the fixed blocks —
 * meta + headline + QR block + 144px of panel padding (60 top, 84 bottom) +
 * gaps — cost 586px behind a two-line headline and 640px behind a three-line
 * one. The close hint is not among them: it is pinned to the viewer, out of the
 * panel's flow, and the 84px bottom padding is what keeps the QR card a block
 * gap above it (re-measured 2026-11-12; with the hint in flow and 60px all
 * round these were 610 and 664).
 */
const LINE_H = 45;
const RESERVED_2LINE_TITLE = 586;
const RESERVED_3LINE_TITLE = 640;
const BOARD_H = 1040;      // Board Pro, the height the fit has to survive
const NAVIGATOR_H = 1200;  // Room Navigator PWA

describe('story view: the summary is fitted to the screen', () => {
  it('gives a long summary only the lines that honestly remain', () => {
    // 1040 - 586 = 454px of slack, which is 10 whole 45px lines and a 4px
    // remainder that must NOT be handed out — a partial line is a clipped line.
    expect(descLineBudget(BOARD_H, RESERVED_2LINE_TITLE, LINE_H)).toBe(10);
    expect(descLineBudget(1080, RESERVED_2LINE_TITLE, LINE_H)).toBe(10);
    expect(descLineBudget(NAVIGATOR_H, RESERVED_2LINE_TITLE, LINE_H)).toBe(13);
  });

  it('keeps the whole panel inside the viewport, so the QR can never be clipped', () => {
    // The reservation INCLUDES the QR block, so this identity is the guarantee:
    // whatever the budget comes out at, the panel still fits. The hint lives
    // inside the panel's bottom padding, so a fitting panel never covers it.
    for (const viewportH of [1040, 1080, 1200]) {
      for (const reserved of [RESERVED_2LINE_TITLE, RESERVED_3LINE_TITLE]) {
        const panelH = reserved + descLineBudget(viewportH, reserved, LINE_H) * LINE_H;
        expect(panelH, `panel at H=${viewportH} reserved=${reserved}`).toBeLessThanOrEqual(viewportH);
      }
    }
  });

  it('leaves a summary that already fits alone', () => {
    // A three-line summary against a ten-line budget: the clamp is above the
    // natural line count, so it never bites and the text is untouched.
    expect(descLineBudget(BOARD_H, RESERVED_2LINE_TITLE, LINE_H)).toBeGreaterThan(3);
  });

  it('keeps one line even when the fixed blocks alone overflow the screen', () => {
    expect(descLineBudget(BOARD_H, 1400, LINE_H)).toBe(1);
  });

  it('reports 0 — leave it unclamped — when there is nothing to measure', () => {
    expect(descLineBudget(0, 610, LINE_H)).toBe(0);   // viewer not laid out
    expect(descLineBudget(BOARD_H, 610, NaN)).toBe(0); // no computed line-height
  });

  const story = (desc) => ({
    title: 'Markets close higher as the central bank holds rates steady',
    source: 'MarketWatch', age: '12m', desc,
    link: 'https://www.marketwatch.com/story/example',
  });
  const LONG = 'Stocks rose broadly in afternoon trading. '.repeat(13);
  const SHORT = 'Stocks rose broadly in afternoon trading.';
  const stub = (reservedH, viewportH = BOARD_H) => () => ({ viewportH, reservedH, lineH: LINE_H });
  const descLines = (v) => v.querySelector('.story__desc').style.getPropertyValue('--desc-lines');

  it('writes the budget onto the summary, with the QR block still in the panel', () => {
    document.body.innerHTML = '';
    openStoryViewer(story(LONG));
    const viewer = document.querySelector('#text-viewer');
    expect(fitStoryDesc(viewer, stub(RESERVED_2LINE_TITLE))).toBe(10);
    expect(descLines(viewer)).toBe('10');
    // The affordance a truncated summary hands off to is still there.
    expect(viewer.querySelector('.story__qr')).not.toBeNull();
    expect(viewer.textContent).toContain('Read the full story');
  });

  it('re-measures on reuse: long story, short story, long story again', () => {
    document.body.innerHTML = '';
    // A three-line headline reserves more, so the same viewport yields fewer
    // summary lines — the fit has to follow the story, not the last story.
    openStoryViewer(story(LONG));
    const viewer = document.querySelector('#text-viewer');
    expect(fitStoryDesc(viewer, stub(RESERVED_3LINE_TITLE))).toBe(8);
    expect(descLines(viewer)).toBe('8');

    openStoryViewer(story(SHORT));
    expect(descLines(viewer)).toBe(''); // rebuilt panel carries nothing stale
    expect(fitStoryDesc(viewer, stub(RESERVED_2LINE_TITLE))).toBe(10);
    expect(descLines(viewer)).toBe('10');

    openStoryViewer(story(LONG));
    expect(fitStoryDesc(viewer, stub(RESERVED_3LINE_TITLE))).toBe(8);
    expect(descLines(viewer)).toBe('8');
    // And the taller viewport re-measures too, rather than reusing the board's.
    expect(fitStoryDesc(viewer, stub(RESERVED_3LINE_TITLE, NAVIGATOR_H))).toBe(12);
  });

  it('leaves a story with no summary alone', () => {
    document.body.innerHTML = '';
    openStoryViewer(story(''));
    const viewer = document.querySelector('#text-viewer');
    expect(viewer.querySelector('.story__desc')).toBeNull();
    expect(fitStoryDesc(viewer, stub(RESERVED_2LINE_TITLE))).toBe(0);
  });

  it('unclamps rather than guesses when there is no layout engine', () => {
    document.body.innerHTML = '';
    openStoryViewer(story(LONG)); // openStoryViewer fits with the REAL measure
    const viewer = document.querySelector('#text-viewer');
    expect(descLines(viewer)).toBe('');
  });
});

describe('story view: the stylesheet half of the fix', () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../site/css/main.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, `no rule for "${selector}" in main.css`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('centres SAFELY, with plain center ordered FIRST as the fallback', () => {
    const body = rule('.text-viewer');
    const plain = body.indexOf('align-items: center');
    const safe = body.indexOf('align-items: safe center');
    expect(plain, 'no plain `align-items: center` to fall back to').toBeGreaterThan(-1);
    expect(safe, 'no `align-items: safe center`').toBeGreaterThan(-1);
    // Order is the whole point: an engine that does not know `safe` drops that
    // declaration at parse time, so it has to be the LATER of the two or the
    // fallback would win on an engine that does support it.
    expect(safe).toBeGreaterThan(plain);
  });

  it('clamps the summary from --desc-lines and degrades to no clamp', () => {
    const body = rule('.story__desc');
    // -webkit-line-clamp only does anything inside a vertical -webkit-box.
    expect(body).toContain('display: -webkit-box');
    expect(body).toContain('-webkit-box-orient: vertical');
    expect(body).toContain('overflow: hidden');
    // Unset -- no layout engine, or a story with no summary -- must mean
    // "no clamp", i.e. exactly the behaviour before this fix.
    expect(body).toContain('-webkit-line-clamp: var(--desc-lines, none)');
  });

  it('pins the hint like the tap view: centred, 22px, 32px off the viewer bottom', () => {
    const hint = rule('.text-viewer__hint');
    for (const decl of ['position: absolute', 'bottom: 32px', 'text-align: center', 'font-size: 22px', 'line-height: 1.2', 'color: var(--ink-faint)']) {
      expect(hint).toContain(decl);
    }
  });

  it('fades the story in without sliding it', () => {
    const at = css.indexOf('@keyframes story-in');
    expect(at).toBeGreaterThan(-1);
    const frames = css.slice(at, css.indexOf('\n', at));
    expect(frames).toContain('opacity: 0');
    expect(frames).not.toContain('transform');
  });

  it('breaks a headline that has no break opportunity of its own', () => {
    // Feed text: one 160-character run with no space, slash or hyphen painted
    // 3468px past the right edge of a 1920 board before this.
    expect(rule('.story__title')).toContain('overflow-wrap: break-word');
  });
});
