import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

const raw = await readFile(new URL('../site/data/changelog.json', import.meta.url), 'utf8');
const groups = JSON.parse(raw);

// The /info changelog is read by end users, so the guard here is editorial as
// much as structural: shape info.js can render, and copy free of the vocabulary
// that only means something to whoever deploys the thing.
describe('changelog.json', () => {
  it('is a non-empty array of dated groups', () => {
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(typeof g.date).toBe('string');
      expect(g.date.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(g.items)).toBe(true);
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  it('gives every item real text, and a short lead when it has one', () => {
    for (const g of groups) {
      for (const item of g.items) {
        expect(typeof item.text).toBe('string');
        expect(item.text.trim().length).toBeGreaterThan(0);
        if ('lead' in item) {
          expect(typeof item.lead).toBe('string');
          expect(item.lead.trim().length).toBeGreaterThan(0);
          expect(item.lead.length).toBeLessThanOrEqual(40); // stays one label, not a sentence
        }
      }
    }
  });

  it('keeps the copy user-facing: no infrastructure vocabulary, no em-dashes', () => {
    // Word boundaries on purpose: "Cisco" must not trip the CI check, and
    // "recurated" must not trip cron.
    const banned = [/\bworkers?\b/i, /\bKV\b/, /\bcron\b/i, /\bCI\b/];
    for (const g of groups) {
      for (const item of g.items) {
        const copy = (item.lead ? item.lead + ' ' : '') + item.text;
        expect(copy).not.toMatch(/[—–]/); // page rule: no em/en dashes in prose
        for (const re of banned) expect(copy).not.toMatch(re);
      }
    }
  });

  it('reads newest first, and starts at the latest shipped day', () => {
    // August 18's rename note was removed 2026-08-21 with the idlescreen
    // rename (each rename retires the previous rename's entry — the Quadrillé
    // note went the same way); the idlescreen entry lands at promote.
    expect(groups[0].date).toBe('September 1');
    expect(groups[groups.length - 1].date).toBe('Early July');
  });
});
