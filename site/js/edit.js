// Edit mode: arrange, resize, remove and re-add widgets on the 12×8 grid.
// Geometry decisions live in layout.js (placeWithPush displaces neighbors to
// make room); this module renders the overlay and translates pointer
// gestures. During a gesture a cell-snapped placeholder previews the target
// (green = will commit, red = unsolvable) and neighbor blocks preview their
// pushed positions live. The drag ghost moves via transform only.

import { GRID, MIN_SIZE, MAX_SIZE, minAlternatives, firstFit, firstFitAny, placeWithPush, contentMaxH } from './layout.js';
import { capacityLabel } from './capacity.js';
import { WIDGET_GROUPS, isAddable } from './config.js';

// Diagonal two-headed arrow (↖↘ — the axis a corner-resize actually moves
// along). Lives inside the filled resize chip; stroke follows the chip color.
const RESIZE_ICON = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9 4 4m0 0v5m0-5h5M15 15l5 5m0 0v-5m0 5h-5"/></svg>`;

// Add-tray category order: the same groups as Settings/setup, but the BIG
// categories render LAST, each behind its own expander, so revealing one pushes
// nothing above it. Every other group flows inline; chips sort alpha within
// group.
// THE RULE, so this list stops being a judgement call re-litigated every
// regrouping: a group collapses iff it offers FOUR OR MORE cards, and the
// expanders render largest first, ties alphabetical. Order here is that render
// order — Commute 10 · Images 5 · Sports 5 · Daily 4 (Images is 6 nominal but
// Live Video is double-gated; Sports reached 5 when Sports News landed and takes
// the tie on the alphabet). Below four a drawer costs a tap to save one or two
// chips, so Weather & Air 3, News & Social 3, Markets 2 and Reference 2 all flow
// inline. Each label must exist in WIDGET_GROUPS, and the set must match the
// rule (both asserted in test/edit.test.js).
const TRAY_COLLAPSIBLE = ['Commute', 'Images', 'Sports', 'Daily'];
const TRAY_INLINE_GROUPS = WIDGET_GROUPS.filter((g) => !TRAY_COLLAPSIBLE.includes(g.label));
const TRAY_COLLAPSIBLE_GROUPS = TRAY_COLLAPSIBLE
  .map((label) => WIDGET_GROUPS.find((g) => g.label === label))
  .filter(Boolean);

// Edit mode's own, SHORTER register, and it stays its own on purpose: these
// names are printed inside a grid tile that can be two cells wide, so the card
// the catalogue calls "This Day in History" is "History" here and "LIRR (Penn
// Station)" is just "LIRR". The catalogue's label answers "which card is this?"
// in a settings list with a full line to spend; this answers it in a box.
// It must still cover every card, or a tile renders its raw id, so it is
// exported for test/catalog.test.js to hold it to that.
export const TITLES = {
  apod: 'NASA Daily Photo',
  chart: 'Chart of the Day',
  citibike: 'Citi Bike',
  tfl: 'TfL Status',
  services: 'Cloud Services',
  weather: 'Weather',
  subway: 'Subway',
  lirr: 'LIRR',
  mnr: 'Metro-North',
  njt: 'NJ Transit',
  amtrak: 'Amtrak',
  path: 'PATH',
  ferry: 'NYC Ferry',
  bus: 'Express Bus',
  markets: 'Markets',
  marketsnews: 'Markets News',
  art: 'Art',
  landscapes: 'Landscapes',
  photos: 'iCloud Photos',
  gdrivephotos: 'GDrive Photos',
  history: 'History',
  aqi: 'Air & Sky',
  surf: 'Surf',
  quote: 'Quote',
  wotd: 'Word',
  worldclock: 'World Clock',
  sports: 'My Teams',
  sportsnews: 'Sports News',
  f1: 'Formula 1',
  golf: 'Golf',
  tennis: 'Tennis',
  iptv: 'Live Video',
  news: 'Headlines',
  substack: 'Substack',
  bsky: 'Bluesky',
};

export function openEditMode(cfg, { root, onDone, onCancel, cellSize } = {}) {
  root ??= document.querySelector('#edit-root');
  let layout = cfg.layout.map((r) => ({ ...r }));
  // Labels of the currently-expanded tray groups. One Set rather than a flag
  // per group so each expander is independent, and it lives out here so the
  // open ones stay open across the re-render that adding a widget triggers.
  const trayOpen = new Set();

  root.innerHTML = `
    <div class="editor">
      <div class="editor__stage">
        <div class="editor__cells">${'<div class="editor__cell"></div>'.repeat(GRID.cols * GRID.rows)}</div>
        <div class="editor__blocks"></div>
      </div>
      <div class="editor__bar">
        <div class="edit-tray"></div>
        <div class="editor__actions">
          <button class="btn btn--primary" data-done>Done</button>
          <button class="btn btn--ghost" data-cancel>Cancel</button>
        </div>
      </div>
    </div>`;

  const stage = root.querySelector('.editor__stage');
  const blocksHost = root.querySelector('.editor__blocks');
  const tray = root.querySelector('.edit-tray');

  const cell = () => {
    if (cellSize) return cellSize;
    const rect = stage.getBoundingClientRect();
    return { w: rect.width / GRID.cols, h: rect.height / GRID.rows };
  };

  // Content-aware height caps (worldclock/markets): computed once — the
  // followed lists can't change while edit mode is open. soft:false drops the
  // advisory caps (services), whose height is set by what a card SAYS rather
  // than how many things it lists: a person resizing by hand is answering that
  // question better than the count-based search can.
  const caps = contentMaxH(cfg, { soft: false });
  const rectOf = (id) => layout.find((r) => r.id === id);
  const capOf = (id, w, h) => capacityLabel(id, w, h, cfg) ?? '';
  const sizeLabel = (r) => {
    // A widget with more than one legal minimum (wotd, World Clock) is named by
    // the alternative the card is ACTUALLY in, so a perfectly legal 3×2 never
    // reads "3×2 · min 2×3" and contradicts itself on the tile. Falls back to
    // the canonical entry, which is what a card below every alternative will
    // grow to anyway.
    const alts = minAlternatives(r.id);
    const [mw, mh] = alts.find(([aw, ah]) => r.w >= aw && r.h >= ah) ?? alts[0] ?? [1, 1];
    const [Mw] = MAX_SIZE[r.id] ?? [];
    const Mh = caps[r.id];
    const wCap = Mw && Mw < GRID.cols;
    const hCap = Mh && Mh < GRID.rows;
    // One compact "max WxH" when both axes cap — the two-phrase form wrapped
    // into the corner controls on small tiles.
    const max = wCap && hCap ? ` · max ${Mw}×${Mh}` : wCap ? ` · max ${Mw} wide` : hCap ? ` · max ${Mh} tall` : '';
    return `${r.w}×${r.h} · min ${mw}×${mh}${max}`;
  };

  /* ----- grid operations ----- */

  function commit(next) {
    if (!next) return false;
    layout = next;
    render();
    return true;
  }

  const move = (id, x, y) => {
    const start = rectOf(id);
    return commit(placeWithPush(layout, { ...start, x, y }, { dx: x - start.x, dy: y - start.y }, caps));
  };
  const resize = (id, w, h) => {
    const start = rectOf(id);
    return commit(placeWithPush(layout, { ...start, w, h }, { dx: w - start.w, dy: h - start.h }, caps));
  };

  function remove(id) {
    layout = layout.filter((r) => r.id !== id);
    render();
  }

  function add(id) {
    const rect = firstFitAny(layout, id, caps);
    if (!rect) return false;
    layout = [...layout, rect];
    render();
    return true;
  }

  /* ----- rendering ----- */

  function positionEl(el, r) {
    el.style.gridColumn = `${r.x + 1} / span ${r.w}`;
    el.style.gridRow = `${r.y + 1} / span ${r.h}`;
  }

  function render() {
    // data-w is the tile's width signal for CSS (the size hint changes shape on
    // 2-wide tiles). A block's own footprint changes only here: a resize
    // gesture previews on the placeholder and re-renders on release, so the
    // attribute is never stale mid-gesture.
    blocksHost.innerHTML = layout
      .map(
        (r) => `<div class="edit-block" data-id="${r.id}" data-w="${r.w}"
          style="grid-column:${r.x + 1} / span ${r.w}; grid-row:${r.y + 1} / span ${r.h}">
          <span class="edit-grip" aria-hidden="true"></span>
          <span class="edit-block__title">${TITLES[r.id] ?? r.id}</span>
          <span class="edit-block__size">${sizeLabel(r)}${capOf(r.id, r.w, r.h) ? `<br>${capOf(r.id, r.w, r.h)}` : ''}</span>
          <button class="edit-remove" data-remove="${r.id}" aria-label="Remove ${TITLES[r.id]}"><span class="edit-remove__bar"></span></button>
          <span class="edit-handle" data-resize="${r.id}" aria-label="Resize ${TITLES[r.id]}">${RESIZE_ICON}</span>
        </div>`,
      )
      .join('');
    // Blocked chips are dimmed (plus one shared legend line) rather than each
    // carrying a "(no room)" suffix — with 20+ widgets the repeated text
    // wrapped the tray to 5 rows and squeezed the grid preview above it.
    let anyBlocked = false;
    const chip = (id) => {
      const fits = firstFitAny(layout, id, caps) !== null;
      if (!fits) anyBlocked = true;
      const [mw, mh] = MIN_SIZE[id];
      // Enabled chips are just the title; the min-size hint shows only on blocked
      // ones (where "needs MxM, no room" is the relevant fact).
      return `<button class="edit-tray__chip" data-add="${id}"${fits ? '' : ' disabled title="No room at its minimum size"'}>${TITLES[id]}${fits ? '' : ` <small>${mw}×${mh}</small>`}</button>`;
    };
    const chipsFor = (g) => g.ids.filter((id) => !rectOf(id) && isAddable(id, cfg))
      .sort((a, b) => TITLES[a].localeCompare(TITLES[b]))
      .map(chip).join('');
    const inlineChips = TRAY_INLINE_GROUPS.map(chipsFor).join('');
    // One toggle + hidden group per collapsible category, in TRAY_COLLAPSIBLE
    // order, after every inline chip. A category with nothing left to add
    // drops out entirely rather than offering an empty drawer.
    const expanders = TRAY_COLLAPSIBLE_GROUPS.map((g) => {
      const n = g.ids.filter((id) => !rectOf(id) && isAddable(id, cfg)).length;
      if (!n) return '';
      const open = trayOpen.has(g.label);
      return `<button class="edit-tray__toggle" data-tray-toggle="${g.label}" aria-expanded="${open}"><span class="edit-tray__caret">${open ? '▾' : '▸'}</span> ${g.label} <span class="edit-tray__count">· ${n}</span></button>`
        + `<span class="edit-tray__group" data-tray-group="${g.label}"${open ? '' : ' hidden'}>${chipsFor(g)}</span>`;
    }).join('');
    tray.innerHTML =
      '<p class="edit-tray__head">Add a widget</p>' +
      '<div class="edit-tray__chips">' + inlineChips + expanders + '</div>' +
      (anyBlocked ? '<p class="edit-tray__legend">faded = no room at its minimum size</p>' : '');

    blocksHost.querySelectorAll('[data-remove]').forEach((btn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        remove(btn.dataset.remove);
      }),
    );
    tray.querySelectorAll('[data-add]').forEach((btn) =>
      btn.addEventListener('click', () => add(btn.dataset.add)),
    );
    blocksHost.querySelectorAll('.edit-block').forEach(bindDrag);
    blocksHost.querySelectorAll('[data-resize]').forEach(bindResize);
  }

  /* ----- live gesture preview ----- */

  function placeholder() {
    let ph = blocksHost.querySelector('.edit-placeholder');
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'edit-placeholder';
      blocksHost.prepend(ph);
    }
    return ph;
  }

  function showPlaceholder(ph, r, valid) {
    positionEl(ph, {
      x: Math.min(Math.max(r.x, 0), GRID.cols - 1),
      y: Math.min(Math.max(r.y, 0), GRID.rows - 1),
      w: Math.min(r.w, GRID.cols),
      h: Math.min(r.h, GRID.rows),
    });
    ph.classList.toggle('edit-placeholder--invalid', !valid);
    ph.hidden = false;
  }

  function previewPositions(preview, dragId) {
    for (const el of blocksHost.querySelectorAll('.edit-block')) {
      if (el.dataset.id === dragId) continue;
      const r = preview.find((p) => p.id === el.dataset.id);
      if (r) positionEl(el, r);
    }
  }

  function gesture(block, start, computeTarget) {
    const id = block.dataset.id;
    const startLayout = layout.map((r) => ({ ...r }));
    const ph = placeholder();
    let lastValid = null;
    let lastKey = '';

    const update = (e) => {
      const target = computeTarget(e);
      const key = `${target.x},${target.y},${target.w},${target.h}`;
      if (key === lastKey) return;
      lastKey = key;
      const dir = { dx: target.x - start.x + (target.w - start.w), dy: target.y - start.y + (target.h - start.h) };
      const preview = placeWithPush(startLayout, target, dir, caps);
      if (preview) {
        lastValid = preview;
        previewPositions(preview, id);
        showPlaceholder(ph, target, true);
      } else {
        showPlaceholder(ph, target, false);
      }
      const cap = capOf(id, target.w, target.h);
      block.querySelector('.edit-block__size').innerHTML =
        sizeLabel(target) + (cap ? `<br>${cap}` : '');
    };

    const finish = () => {
      ph.hidden = true;
      block.classList.remove('is-dragging', 'is-resizing');
      block.style.transform = '';
      if (lastValid) {
        layout = lastValid;
      }
      render(); // restores positions when nothing valid was previewed
    };
    // Abort (pointercancel): clean up the preview without committing — leaves
    // the layout unchanged.
    const cancel = () => {
      ph.hidden = true;
      block.classList.remove('is-dragging', 'is-resizing');
      block.style.transform = '';
      render();
    };
    return { update, finish, cancel };
  }

  function bindDrag(block) {
    block.addEventListener('pointerdown', (down) => {
      if (down.target.closest('[data-remove],[data-resize]')) return;
      const start = rectOf(block.dataset.id);
      const origin = { x: down.clientX, y: down.clientY };
      block.classList.add('is-dragging');
      block.setPointerCapture?.(down.pointerId);
      const g = gesture(block, start, (e) => {
        const { w: cw, h: ch } = cell();
        return {
          ...start,
          x: start.x + Math.round((e.clientX - origin.x) / cw),
          y: start.y + Math.round((e.clientY - origin.y) / ch),
        };
      });
      const unbind = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
      };
      // Only the initiating pointer drives the gesture: a palm or 2nd finger on
      // the wall panel fires window pointermove/up with a DIFFERENT pointerId,
      // and without this guard its pointerup would commit the layout at a spot
      // the user never chose.
      const onMove = (e) => {
        if (e.pointerId !== down.pointerId) return;
        block.style.transform = `translate(${e.clientX - origin.x}px, ${e.clientY - origin.y}px)`;
        g.update(e);
      };
      const onUp = (e) => { if (e.pointerId !== down.pointerId) return; unbind(); g.update(e); g.finish(); };
      // pointercancel (system gesture / palm) for THIS pointer: drop the
      // listeners and abort, or the next stray pointerup would commit it.
      const onCancel = (e) => { if (e.pointerId !== down.pointerId) return; unbind(); g.cancel(); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  }

  function bindResize(handle) {
    handle.addEventListener('pointerdown', (down) => {
      down.stopPropagation();
      const block = handle.closest('.edit-block');
      const start = rectOf(block.dataset.id);
      const origin = { x: down.clientX, y: down.clientY };
      block.classList.add('is-resizing');
      // While resizing, the placeholder paints ABOVE the blocks (CSS keys off
      // this class): a shrink target sits entirely inside the block's current
      // footprint and would otherwise be hidden under its opaque background —
      // the only feedback left was the NxN label.
      blocksHost.classList.add('is-resize-gesture');
      const g = gesture(block, start, (e) => {
        const { w: cw, h: ch } = cell();
        return {
          ...start,
          w: start.w + Math.round((e.clientX - origin.x) / cw),
          h: start.h + Math.round((e.clientY - origin.y) / ch),
        };
      });
      const unbind = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        blocksHost.classList.remove('is-resize-gesture');
      };
      const onMove = (e) => { if (e.pointerId !== down.pointerId) return; g.update(e); };
      const onUp = (e) => { if (e.pointerId !== down.pointerId) return; unbind(); g.update(e); g.finish(); };
      const onCancel = (e) => { if (e.pointerId !== down.pointerId) return; unbind(); g.cancel(); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  }

  /* ----- lifecycle ----- */

  function destroy() {
    root.innerHTML = '';
  }

  // One delegated handler for every collapsible category. Bound once, on the
  // tray element that outlives each render's innerHTML swap, so adding an
  // expander is a WIDGET_GROUPS + TRAY_COLLAPSIBLE edit and nothing else.
  // The group is found by scanning rather than by an interpolated attribute
  // selector — group labels are free text ("News & Social") and would need
  // escaping.
  tray.addEventListener('click', (e) => {
    const tog = e.target.closest('[data-tray-toggle]');
    if (!tog) return;
    const label = tog.dataset.trayToggle;
    const open = !trayOpen.has(label);
    if (open) trayOpen.add(label); else trayOpen.delete(label);
    const grp = [...tray.querySelectorAll('[data-tray-group]')].find((el) => el.dataset.trayGroup === label);
    if (grp) grp.hidden = !open;
    tog.setAttribute('aria-expanded', String(open));
    tog.querySelector('.edit-tray__caret').textContent = open ? '▾' : '▸';
  });

  root.querySelector('[data-done]').addEventListener('click', () => {
    const result = layout;
    destroy();
    onDone?.(result);
  });
  root.querySelector('[data-cancel]').addEventListener('click', () => {
    destroy();
    onCancel?.();
  });

  render();

  return {
    layout: () => layout.map((r) => ({ ...r })),
    destroy,
    _test: { move, resize, remove, add },
  };
}
