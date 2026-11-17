import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { isExpressRoute } from '../tools/build-express-bus-data.js';

// Hoisted above the import: the build script used to run on import, pulling six
// MTA GTFS zips and rewriting site/data/express-bus.json on every test run. CI
// went red the day MTA started answering its runners 403 (2026-11-17).
const fetchSpy = vi.hoisted(() => {
  const spy = vi.fn(async () => { throw new Error('a unit test must not reach the network'); });
  vi.stubGlobal('fetch', spy);
  return spy;
});

describe('importing the build script', () => {
  it('does not start a build', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('isExpressRoute', () => {
  it('matches express prefixes only', () => {
    for (const r of ['QM24', 'BM5', 'SIM4C', 'X27', 'X17A']) expect(isExpressRoute(r)).toBe(true);
    for (const r of ['M15', 'Bx12', 'B44', 'S53', '', undefined]) expect(isExpressRoute(r)).toBe(false);
  });
});

describe('express-bus.json shape', () => {
  const path = new URL('../site/data/express-bus.json', import.meta.url);
  it('has the documented shape (run the build script first)', () => {
    if (!existsSync(path)) return; // build is a manual step; skip until generated
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(Array.isArray(data.routes)).toBe(true);
    expect(data.routes.length).toBeGreaterThan(40);
    expect(typeof data.stops).toBe('object');
    for (const r of data.routes) {
      expect(typeof r.id).toBe('string');
      expect(r.lineRef).toMatch(/^(MTABC_|MTA NYCT_)/);
      expect(Array.isArray(r.dirs)).toBe(true);
      for (const d of r.dirs) {
        expect([0, 1]).toContain(d.id);
        expect(Array.isArray(d.stops)).toBe(true);
        for (const s of d.stops) expect(typeof data.stops[s]).toBe('string');
      }
    }
    const ids = data.routes.map((r) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
  });
});
