/**
 * The type tier, held against the stylesheet itself (DESIGN.md, Typography):
 * primary text at 20px or larger, an 18px secondary tier for meta text, and
 * nothing a user reads under 18px. happy-dom cannot lay text out, so this reads
 * main.css the way overlay-chrome.test.js does and fails on any rule that
 * declares a px font-size under 18 for a selector that is not on the list below.
 *
 * The list is the whole exception, each entry with its reason. A new small size
 * for board-card or tap-view text belongs in the tier, not here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../site/css/main.css'), 'utf8');

const TIER = 18;

const ALLOWED = [
  // Not the board: the settings overlay, the setup page's shared rules, and the
  // edit-mode tray and size hints. Chrome read at arm's length while configuring.
  [/\.settings|\.pane|\.osk|\.key\b|\.setup|\.sched/, 'settings and setup surfaces'],
  [/\.edit-/, 'edit-mode chrome'],
  [/\.displaytest/, 'the display test page draws rulers, not data'],
  // Glyph-only marks: a live dot, a warning triangle, a line bullet. They carry
  // no words, so the tier does not apply.
  [/__livedot|\.tennis-row__live|__icon\b|\.bullet/, 'glyph-only marks'],
];

// Every innermost rule as { selectors, body }, comments stripped, @media and
// other at-rule blocks walked into. Enough of a parser for one hand-written
// stylesheet; it does not need to understand values.
function rules(text) {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const walk = (s) => {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
      const body = s.slice(open + 1, j - 1);
      if (head.startsWith('@')) {
        if (!/^@(font-face|keyframes)/.test(head)) walk(body);
      } else {
        out.push({ selectors: head.split(',').map((x) => x.trim()).filter(Boolean), body });
      }
      i = j;
    }
  };
  walk(src);
  return out;
}

const pxSize = (body) => {
  const m = body.match(/(?:^|[;\s])font-size:\s*(\d+(?:\.\d+)?)px/) ?? body.match(/(?:^|[;\s])font:\s*(?:[^;]*\s)?(\d+(?:\.\d+)?)px[\s/]/);
  return m ? Number(m[1]) : null;
};

describe('the 18px type tier', () => {
  it('finds the stylesheet rules it is checking', () => {
    // Guard the parser: if it silently matched nothing, the real test would pass
    // on an empty list.
    const sized = rules(css).filter((r) => pxSize(r.body) != null);
    expect(sized.length).toBeGreaterThan(300);
    expect(sized.some((r) => r.selectors.includes('.headline__src'))).toBe(true);
  });

  it('declares no px font-size under 18 for board-card or tap-view text', () => {
    const offenders = [];
    for (const r of rules(css)) {
      const px = pxSize(r.body);
      if (px == null || px >= TIER) continue;
      for (const sel of r.selectors) {
        if (!ALLOWED.some(([re]) => re.test(sel))) offenders.push(`${sel} (${px}px)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps every exception for a reason, with no temporary ones left', () => {
    // A reason per entry, so a future exception has to say why it is one.
    for (const [re, why] of ALLOWED) {
      expect(re).toBeInstanceOf(RegExp);
      expect(why.length).toBeGreaterThan(8);
    }
    expect(ALLOWED.filter(([, why]) => why.startsWith('TEMPORARY'))).toHaveLength(0);
  });
});
