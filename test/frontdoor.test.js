// What search engines are told. Before 2026-09-27 no page declared a home, so
// Google indexed the guide under quadrille.io (its oldest copy) and a search
// for "idlescreen" returned only quadrille results; /robots.txt and
// /sitemap.xml fell through to the guide's HTML with a 200. These run the real
// front-door build into a temp dir, because what matters is the bytes that
// ship, and read the app's pages as source text for the same reason.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = process.cwd();
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
const CANONICAL = /<link rel="canonical" href="([^"]*)">/g;
const NOINDEX = '<meta name="robots" content="noindex">';
const canonicals = (html) => [...html.matchAll(CANONICAL)].map((m) => m[1]);

let out;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'frontdoor-'));
  execFileSync(process.execPath, ['tools/build-frontdoor.js', out], { cwd: repo, stdio: 'pipe' });
});
afterAll(() => rmSync(out, { recursive: true, force: true }));
const built = (p) => readFileSync(join(out, p), 'utf8');
const builtPages = () => readdirSync(out).filter((f) => f.endsWith('.html')).sort();

describe('the front door names idlescreen.io as its one home', () => {
  it('gives every page it ships exactly one canonical, at its idlescreen.io URL', () => {
    // index.html and info.html are the same guide (the root, and /info for old
    // links), so both name the root; a crawler that finds /info, or finds the
    // guide on unsleep.io, is sent to one URL instead of choosing among copies.
    // /terms is the clean URL because Pages 308s /terms.html to it, and a
    // canonical that points at a redirect is a mixed signal.
    const map = Object.fromEntries(builtPages().map((p) => [p, canonicals(built(p))]));
    expect(map).toEqual({
      'index.html': ['https://idlescreen.io/'],
      'info.html': ['https://idlescreen.io/'],
      'terms.html': ['https://idlescreen.io/terms'],
    });
  });

  it('carries the same canonical in the copy the app hosts serve', () => {
    // idlescreen.app/info and /terms are the source files themselves, and they
    // are exactly the duplicates the canonical exists to fold in.
    expect(canonicals(read('site/info.html'))).toEqual(['https://idlescreen.io/']);
    expect(canonicals(read('site/terms.html'))).toEqual(['https://idlescreen.io/terms']);
    expect(built('info.html')).toBe(read('site/info.html'));
  });

  it('keeps its public pages indexable', () => {
    for (const page of builtPages()) expect(built(page)).not.toContain('noindex');
  });
});

describe('the front door\'s sitemap', () => {
  const locs = () => [...built('sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

  it('lists exactly the homes the built pages declare, once each', () => {
    // Derived, not hand-listed: a page added to the build without a canonical
    // fails the build, and one added with a canonical lands here by itself.
    const declared = [...new Set(builtPages().flatMap((p) => canonicals(built(p))))];
    expect(locs().sort()).toEqual(declared.sort());
    expect(locs()).toEqual(['https://idlescreen.io/', 'https://idlescreen.io/terms']);
  });

  it('points every entry at a page this build actually ships', () => {
    for (const loc of locs()) {
      const path = new URL(loc).pathname;
      const file = path.endsWith('/') ? `${path.slice(1)}index.html` : `${path.slice(1)}.html`;
      expect(existsSync(join(out, file))).toBe(true);
    }
  });

  it('is a plain urlset with no invented dates', () => {
    const xml = built('sitemap.xml');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    // A build-time lastmod would claim every page changed on every deploy.
    expect(xml).not.toContain('lastmod');
  });
});

describe('robots.txt', () => {
  it('ships to the front door as the same bytes the app serves', () => {
    expect(built('robots.txt')).toBe(read('site/robots.txt'));
  });

  it('allows everything, so crawlers can read the noindex and canonical tags', () => {
    const rules = read('site/robots.txt').split('\n').filter((l) => l && !l.startsWith('#'));
    expect(rules).toContain('User-agent: *');
    expect(rules).toContain('Allow: /');
    // A Disallow with a path would hide the very tags this change relies on.
    expect(rules.filter((l) => /^Disallow:\s*\S/i.test(l))).toEqual([]);
  });

  it('names the front door\'s sitemap and the docs\' own index', () => {
    const robots = read('site/robots.txt');
    expect(robots).toContain('Sitemap: https://idlescreen.io/sitemap.xml\n');
    expect(robots).toContain('Sitemap: https://idlescreen.io/docs/sitemap-index.xml\n');
    // The docs' pointer is only true while Starlight builds the docs at that
    // origin and base: its sitemap integration derives the path from both.
    const astro = read('docs-site/astro.config.mjs');
    expect(astro).toContain("site: 'https://idlescreen.io'");
    expect(astro).toContain("base: '/docs'");
  });
});

describe('the app\'s own pages stay out of search', () => {
  const html = readdirSync(resolve(repo, 'site')).filter((f) => f.endsWith('.html')).sort();
  const FRONT_DOOR = ['info.html', 'terms.html'];

  it('marks the dashboard, the setup pages and the harnesses noindex', () => {
    for (const page of [
      'index.html',
      'setup.html',
      'photo-setup.html',
      'video-setup.html',
      '_audit.html',
      '_overlay-audit.html',
      '_settings-audit.html',
    ]) {
      expect(read(`site/${page}`), page).toContain(NOINDEX);
    }
  });

  it('leaves no page in site/ undecided', () => {
    // Every page is either a front-door page with a canonical or a noindexed
    // app page, never both (a canonical on a noindexed page asks a crawler to
    // index somewhere and nowhere at once) and never neither, which is how a
    // new page would slip into search unannounced.
    expect(html.length).toBeGreaterThan(5); // the walk actually walked
    for (const page of html) {
      const src = read(`site/${page}`);
      if (FRONT_DOOR.includes(page)) {
        expect(canonicals(src), page).toHaveLength(1);
        expect(src, page).not.toContain('noindex');
      } else {
        expect(src, page).toContain(NOINDEX);
        expect(canonicals(src), page).toEqual([]);
      }
    }
  });
});
