/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openEditMode } from '../site/js/edit.js';
import { WIDGET_IDS, WIDGET_GROUPS, isRetired, isAddable } from '../site/js/config.js';
import { writeProbe, spotKey } from '../site/js/surf-gate.js';
import { installLocalStorage } from './stubs/localstorage.js';

// Surf is place-gated (isOceanHidden), so the tray only carries the FULL widget
// inventory on a board whose ocean probe has answered.
const COAST = { lat: 40.9384, lon: -72.3037, label: 'Bridgehampton', units: 'F' };

const CFG = {
  layout: [
    { id: 'weather', x: 0, y: 0, w: 6, h: 4 },
    { id: 'aqi', x: 6, y: 0, w: 2, h: 2 },
  ],
};

let root;
beforeEach(() => {
  document.body.innerHTML = '<div id="edit-root"></div>';
  root = document.querySelector('#edit-root');
});

describe('openEditMode', () => {
  it('renders placed widgets, tray for the rest, and applies moves', () => {
    const editor = openEditMode(CFG, { root, cellSize: { w: 100, h: 100 } });
    expect(root.querySelectorAll('.edit-block')).toHaveLength(2);
    const trayIds = [...root.querySelectorAll('.edit-tray [data-add]')].map((b) => b.dataset.add);
    expect(trayIds).toContain('subway');
    expect(trayIds).not.toContain('weather');

    expect(editor._test.move('aqi', 10, 6)).toBe(true);
    expect(editor.layout().find((r) => r.id === 'aqi')).toMatchObject({ x: 10, y: 6 });
    // overlapping move now PUSHES the neighbor instead of failing
    expect(editor._test.move('aqi', 1, 1)).toBe(true);
    expect(editor.layout().find((r) => r.id === 'aqi')).toMatchObject({ x: 1, y: 1 });
    const weather = editor.layout().find((r) => r.id === 'weather');
    expect(weather.x === 0 && weather.y === 0).toBe(false); // displaced
  });

  it('labels every widget in the tray and on blocks (no raw ids, no undefined)', () => {
    installLocalStorage();
    writeProbe({ key: spotKey(COAST), t: Date.now(), ocean: true, km: 7.12, bearing: 171.8 });
    openEditMode({ layout: [{ id: 'weather', x: 0, y: 0, w: 6, h: 4 }], nerdMode: true, loc: COAST }, { root, cellSize: { w: 100, h: 100 } });
    const chips = [...root.querySelectorAll('.edit-tray [data-add]')];
    expect(chips.map((b) => b.dataset.add).sort()).toEqual(
      WIDGET_IDS.filter((id) => id !== 'weather' && !isRetired(id)).sort(), // retired ids leave the tray
    );
    for (const chip of chips) expect(chip.textContent).not.toContain('undefined');
    const block = root.querySelector('.edit-block__title');
    expect(block.textContent).toBe('Weather');
  });

  it('rejects moves when the push is unsolvable', () => {
    const full = { layout: [
      { id: 'weather', x: 0, y: 0, w: 6, h: 4 },
      { id: 'subway', x: 6, y: 0, w: 6, h: 4 },
      { id: 'art', x: 0, y: 4, w: 6, h: 4 },
      { id: 'lirr', x: 6, y: 4, w: 6, h: 4 },
    ]};
    const editor = openEditMode(full, { root, cellSize: { w: 100, h: 100 } });
    expect(editor._test.move('weather', 1, 0)).toBe(false);
    expect(editor.layout().find((r) => r.id === 'weather')).toMatchObject({ x: 0, y: 0 });
  });

  it('rejects resizes below the minimum and applies valid ones', () => {
    const editor = openEditMode(CFG, { root, cellSize: { w: 100, h: 100 } });
    expect(editor._test.resize('weather', 2, 2)).toBe(false); // min 3x4
    expect(editor._test.resize('weather', 6, 6)).toBe(true);
    expect(editor.layout().find((r) => r.id === 'weather')).toMatchObject({ w: 6, h: 6 });
    // growing over aqi pushes it aside now
    expect(editor._test.resize('weather', 8, 4)).toBe(true);
    const aqi = editor.layout().find((r) => r.id === 'aqi');
    expect(aqi.x >= 8 || aqi.y >= 4).toBe(true);
  });

  it('supports remove and tray re-add round-trip', () => {
    const editor = openEditMode(CFG, { root, cellSize: { w: 100, h: 100 } });
    editor._test.remove('aqi');
    expect(editor.layout().map((r) => r.id)).toEqual(['weather']);
    expect(root.querySelector('.edit-tray [data-add="aqi"]')).not.toBeNull();
    editor._test.add('aqi');
    expect(editor.layout().map((r) => r.id)).toContain('aqi');
  });

  it('commits via Done and discards via Cancel', () => {
    const onDone = vi.fn();
    const editor = openEditMode(CFG, { root, cellSize: { w: 100, h: 100 }, onDone });
    editor._test.move('aqi', 10, 6);
    root.querySelector('[data-done]').click();
    expect(onDone).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'aqi', x: 10, y: 6 })]),
    );

    const onCancel = vi.fn();
    openEditMode(CFG, { root, cellSize: { w: 100, h: 100 }, onCancel });
    root.querySelector('[data-cancel]').click();
    expect(onCancel).toHaveBeenCalled();
    expect(root.innerHTML).toBe('');
  });

  it('moves a widget through a pointer drag sequence with live placeholder', () => {
    const editor = openEditMode(CFG, { root, cellSize: { w: 100, h: 100 } });
    const block = root.querySelector('.edit-block[data-id="aqi"]');
    const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 1 });
    block.dispatchEvent(new PointerEvent('pointerdown', opts(350, 50)));
    window.dispatchEvent(new PointerEvent('pointermove', opts(360, 260))); // +0 cols, +2 rows
    const ph = root.querySelector('.edit-placeholder');
    expect(ph).not.toBeNull();
    expect(ph.hidden).toBe(false);
    expect(ph.classList.contains('edit-placeholder--invalid')).toBe(false);
    window.dispatchEvent(new PointerEvent('pointerup', opts(360, 260)));
    expect(editor.layout().find((r) => r.id === 'aqi')).toMatchObject({ x: 6, y: 2 });
    expect(root.querySelector('.edit-placeholder')?.hidden ?? true).toBe(true);
  });

  it('shows size labels with minimums on every block', () => {
    openEditMode(CFG, { root, cellSize: { w: 100, h: 100 } });
    const label = root.querySelector('.edit-block[data-id="weather"] .edit-block__size');
    expect(label.textContent).toContain('6×4 · min 3×4');
    expect(label.textContent).toContain('hourly'); // capacity impact line
  });

  it('tags every block with its width, kept current across a resize', () => {
    // CSS left-aligns the size hint on 2-wide tiles (data-w="2") so it clears
    // the resize handle; a stale width would leave the hint under the handle.
    const editor = openEditMode(CFG, { root, cellSize: { w: 100, h: 100 } });
    const w = (id) => root.querySelector(`.edit-block[data-id="${id}"]`).dataset.w;
    expect(w('weather')).toBe('6');
    expect(w('aqi')).toBe('2');
    expect(editor._test.resize('aqi', 3, 2)).toBe(true);
    expect(w('aqi')).toBe('3');
  });
});

// The big categories hide behind expanders (Commute 10 cards, Images 5, Daily
// 4, Sports 4 offered) so the tray stays a short list. Everything here is about
// that mechanism being per-group rather than the single Commute flag it grew
// out of.
describe('add-tray collapsible groups', () => {
  const idsOf = (label) => WIDGET_GROUPS.find((g) => g.label === label).ids;
  // OFFERED, not merely present: the tray counts what isAddable lets through on
  // THIS cfg, which is how Images reads 5 with six ids (Live Video is nerd-mode
  // gated). Sports reads 4 from 4 since the World Cup card was deleted
  // (2026-07-29); it read 4 from 5 while it was merely retired.
  const offeredIn = (label) => idsOf(label).filter((id) => isAddable(id, CFG));
  const SPORTS_OFFERED = offeredIn('Sports');
  const IMAGES_OFFERED = offeredIn('Images');
  // Sports reached five when Sports News landed (2026-07-31), so it ties Images
  // and takes the alphabetically-earlier slot ahead of the four-card Daily.
  const COLLAPSED = ['Commute', 'Images', 'Sports', 'Daily'];
  const open = (cfg = CFG) => openEditMode(cfg, { root, cellSize: { w: 100, h: 100 } });
  const toggles = () => [...root.querySelectorAll('[data-tray-toggle]')];
  const toggle = (label) => toggles().find((t) => t.dataset.trayToggle === label);
  const group = (label) => [...root.querySelectorAll('[data-tray-group]')].find((g) => g.dataset.trayGroup === label);
  const chipsIn = (label) => [...group(label).querySelectorAll('[data-add]')].map((b) => b.textContent.trim());

  it('collapses exactly Commute, Images, Sports and Daily, all closed, with a caret and a count', () => {
    open();
    // largest-offered-first, ties alphabetical: Commute 10 · Images 5 · Sports 5 · Daily 4
    expect(toggles().map((t) => t.dataset.trayToggle)).toEqual(COLLAPSED);
    for (const label of COLLAPSED) {
      expect(toggle(label).getAttribute('aria-expanded')).toBe('false');
      expect(toggle(label).querySelector('.edit-tray__caret').textContent).toBe('▸');
      expect(group(label).hidden).toBe(true);
    }
    expect(toggle('Commute').textContent).toContain('· 10');
    // 5, not 6: Live Video is BETA_ONLY + ADVANCED_WIDGETS and this cfg has no
    // nerd mode, so it never reaches the tray.
    expect(toggle('Images').textContent).toContain(`· ${IMAGES_OFFERED.length}`);
    expect(IMAGES_OFFERED).toHaveLength(5);
    expect(IMAGES_OFFERED).not.toContain('iptv');
    expect(toggle('Daily').textContent).toContain('· 4');
    expect(toggle('Sports').textContent).toContain(`· ${SPORTS_OFFERED.length}`);
    expect(SPORTS_OFFERED).toEqual(['sports', 'sportsnews', 'f1', 'golf', 'tennis']);
    // no other category is behind a tap
    expect(root.querySelector('[data-tray-toggle="Markets"]')).toBeNull();
    expect(root.querySelector('[data-tray-toggle="Ambient"]')).toBeNull(); // retired outright
    const marketsChip = root.querySelector('.edit-tray__chips > [data-add="markets"]');
    expect(marketsChip).not.toBeNull(); // Markets flows inline, not in a drawer
    // Reference is two cards and stays inline: a two-item drawer would cost a
    // tap to save one chip.
    expect(root.querySelector('[data-tray-toggle="Reference"]')).toBeNull();
    expect(root.querySelector('.edit-tray__chips > [data-add="worldclock"]')).not.toBeNull();
    expect(root.querySelector('.edit-tray__chips > [data-add="services"]')).not.toBeNull();
    // apod moved INTO the Images drawer, so it is no longer a loose inline chip
    expect(root.querySelector('.edit-tray__chips > [data-add="apod"]')).toBeNull();
    expect(group('Images').querySelector('[data-add="apod"]')).not.toBeNull();
    // …and the daily reads moved into theirs
    expect(root.querySelector('.edit-tray__chips > [data-add="quote"]')).toBeNull();
    expect(group('Daily').querySelector('[data-add="quote"]')).not.toBeNull();
  });

  // THE RULE the expander list encodes (see TRAY_COLLAPSIBLE in edit.js): a
  // group collapses iff it offers four or more cards, largest first, ties
  // alphabetical. Without this, "should Daily collapse?" gets re-litigated by
  // taste at every regrouping — Daily Extras carried five cards inline while a
  // four-card Sports sat behind a tap, and nothing caught it.
  it('the expander set and its order are exactly what the four-or-more rule derives', () => {
    const derived = WIDGET_GROUPS
      .map((g) => ({ label: g.label, n: offeredIn(g.label).length }))
      .filter((g) => g.n >= 4)
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
      .map((g) => g.label);
    expect(derived).toEqual(COLLAPSED);
    open();
    expect(toggles().map((t) => t.dataset.trayToggle)).toEqual(derived);
  });

  it('renders the expanders after every inline chip, so opening one pushes nothing above it', () => {
    open();
    const chips = root.querySelector('.edit-tray__chips');
    const kids = [...chips.children];
    const firstToggle = kids.findIndex((el) => el.matches('[data-tray-toggle]'));
    expect(firstToggle).toBeGreaterThan(0);
    // nothing after the first toggle is a loose inline chip
    expect(kids.slice(firstToggle).every((el) => el.matches('[data-tray-toggle],[data-tray-group]'))).toBe(true);
  });

  it('opens and closes each group independently', () => {
    open();
    toggle('Sports').click();
    expect(group('Sports').hidden).toBe(false);
    expect(toggle('Sports').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Sports').querySelector('.edit-tray__caret').textContent).toBe('▾');
    // every other expander is untouched
    for (const label of COLLAPSED.filter((l) => l !== 'Sports')) {
      expect(group(label).hidden, label).toBe(true);
      expect(toggle(label).getAttribute('aria-expanded'), label).toBe('false');
    }

    toggle('Commute').click();
    expect(group('Commute').hidden).toBe(false); // two open at once
    expect(group('Sports').hidden).toBe(false);
    expect(group('Images').hidden).toBe(true); // and the rest still closed
    expect(group('Daily').hidden).toBe(true);

    toggle('Sports').click();
    expect(group('Sports').hidden).toBe(true);
    expect(toggle('Sports').getAttribute('aria-expanded')).toBe('false');
    expect(group('Commute').hidden).toBe(false); // closing one leaves the other open
  });

  it('opens every expander at once — no expander closes another', () => {
    open();
    for (const label of COLLAPSED) toggle(label).click();
    for (const label of COLLAPSED) {
      expect(group(label).hidden, label).toBe(false);
      expect(toggle(label).getAttribute('aria-expanded'), label).toBe('true');
      expect(toggle(label).querySelector('.edit-tray__caret').textContent, label).toBe('▾');
    }
  });

  it('sorts chips alphabetically by title inside a group', () => {
    open();
    expect(chipsIn('Sports')).toEqual(['Formula 1', 'Golf', 'My Teams', 'Sports News', 'Tennis']);
    expect(chipsIn('Images')).toEqual(['Art', 'GDrive Photos', 'iCloud Photos', 'Landscapes', 'NASA Daily Photo']);
    expect(chipsIn('Daily')).toEqual(['Chart of the Day', 'History', 'Quote', 'Word']);
    expect(chipsIn('Commute')).toEqual([...chipsIn('Commute')].sort((a, b) => a.localeCompare(b)));
  });

  it('adds a widget from an expander and keeps that group open across the re-render', () => {
    const editor = open();
    toggle('Sports').click();
    group('Sports').querySelector('[data-add="f1"]').click();
    expect(editor.layout().map((r) => r.id)).toContain('f1');
    // the re-render must not slam the drawer the user is picking from
    expect(group('Sports').hidden).toBe(false);
    expect(toggle('Sports').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Sports').textContent).toContain(`· ${SPORTS_OFFERED.length - 1}`); // count drops with the pick
    expect(group('Commute').hidden).toBe(true); // still independent after a re-render
    expect(group('Images').hidden).toBe(true);
  });

  it('adds a widget from the Images drawer and keeps Images open across the re-render', () => {
    const editor = open();
    toggle('Images').click();
    group('Images').querySelector('[data-add="landscapes"]').click();
    expect(editor.layout().map((r) => r.id)).toContain('landscapes');
    expect(group('Images').hidden).toBe(false);
    expect(toggle('Images').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Images').textContent).toContain(`· ${IMAGES_OFFERED.length - 1}`);
    expect(group('Sports').hidden).toBe(true);
    expect(group('Commute').hidden).toBe(true);
  });

  // Daily is the newest drawer (2026-07-29) and the one whose membership just
  // changed, so exercise the same add path through it.
  it('adds a widget from the Daily drawer and keeps Daily open across the re-render', () => {
    const editor = open();
    toggle('Daily').click();
    group('Daily').querySelector('[data-add="wotd"]').click();
    expect(editor.layout().map((r) => r.id)).toContain('wotd');
    expect(group('Daily').hidden).toBe(false);
    expect(toggle('Daily').textContent).toContain('· 3');
    // Cloud Services is NOT in this drawer — it left for Reference and flows inline
    expect(group('Daily').querySelector('[data-add="services"]')).toBeNull();
    expect(root.querySelector('.edit-tray__chips > [data-add="services"]')).not.toBeNull();
  });

  // Reference is inline, so its chips must be addable straight off the tray
  // with no expander in the way.
  it('adds a Reference widget straight from the inline chips', () => {
    const editor = open();
    root.querySelector('.edit-tray__chips > [data-add="services"]').click();
    expect(editor.layout().map((r) => r.id)).toContain('services');
    root.querySelector('.edit-tray__chips > [data-add="worldclock"]').click();
    expect(editor.layout().map((r) => r.id)).toContain('worldclock');
  });

  // TRAY_COLLAPSIBLE names groups by label, and a label that no longer matches
  // WIDGET_GROUPS fails open: the expander just disappears and its cards spill
  // back inline. Catch the rename here rather than on the board.
  it('every expander label is a real WIDGET_GROUPS label', () => {
    open();
    const valid = new Set(WIDGET_GROUPS.map((g) => g.label));
    for (const t of toggles()) expect(valid.has(t.dataset.trayToggle), t.dataset.trayToggle).toBe(true);
  });

  it('drops a category whose widgets are all placed rather than offering an empty drawer', () => {
    const editor = open();
    for (const id of SPORTS_OFFERED) editor._test.add(id);
    expect(toggle('Sports')).toBeUndefined();
    expect(toggle('Commute')).toBeDefined();
    expect(toggle('Images')).toBeDefined();
  });
});
