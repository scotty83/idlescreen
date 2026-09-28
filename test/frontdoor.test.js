// What search engines are told. Before 2026-09-27 no page declared a home, so
// Google indexed the guide under quadrille.io (its oldest copy) and a search
// for "idlescreen" returned only quadrille results; /robots.txt and
// /sitemap.xml fell through to the guide's HTML with a 200. These run the real
// front-door build into a temp dir, because what matters is the bytes that
// ship, and read the app's pages as source text for the same reason.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, existsSync,
  cpSync, mkdirSync, writeFileSync, symlinkSync, realpathSync,
} from 'node:fs';
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

describe('the build only wipes its own output directory', () => {
  // The build empties its output directory before copying, and a relative
  // argument resolves against the repo, so `node tools/build-frontdoor.js site`
  // used to delete site/: the old guard only refused a directory that held the
  // repo, and compared string prefixes. Every case here runs a COPY of the
  // script inside a sandbox repo in a temp dir, so a guard that lets one
  // through deletes sandbox files, never this checkout's. The sandbox is
  // rebuilt per test so one wipe cannot starve the cases after it.
  let box;
  let sandbox;
  beforeEach(() => {
    // Real path, so the sandbox paths below match the repo path the script
    // derives from its own location (macOS tmpdir sits behind /var -> /private/var).
    box = realpathSync(mkdtempSync(join(tmpdir(), 'frontdoor-guard-')));
    sandbox = join(box, 'repo-x');
    cpSync(resolve(repo, 'site'), join(sandbox, 'site'), { recursive: true });
    mkdirSync(join(sandbox, 'tools'));
    cpSync(resolve(repo, 'tools/build-frontdoor.js'), join(sandbox, 'tools/build-frontdoor.js'));
    for (const dir of ['worker', '.git']) {
      mkdirSync(join(sandbox, dir));
      writeFileSync(join(sandbox, dir, 'sentinel'), dir);
    }
    symlinkSync(sandbox, join(box, 'link'));
  });
  afterEach(() => rmSync(box, { recursive: true, force: true }));

  const build = (...args) => spawnSync(process.execPath, ['tools/build-frontdoor.js', ...args], { cwd: sandbox, encoding: 'utf8' });
  const tree = (dir = box) => readdirSync(dir, { recursive: true }).sort();
  const refuses = (arg) => {
    const before = tree();
    const run = build(arg);
    expect(tree()).toEqual(before);
    expect(run.status, run.stdout).toBe(1);
    expect(run.stderr).toContain('front door only builds into dist/frontdoor or a directory outside the repo');
  };

  it.each([
    ['site', 'the app source'],
    ['worker', 'the worker source'],
    ['.git', 'the repo history'],
    ['.', 'the repo root, relative'],
    ['dist', 'the directory above the default output'],
    ['dist/../site', 'a path that climbs back into source'],
  ])('refuses %s (%s) and deletes nothing', (arg) => refuses(arg));

  it('refuses the repo root and its parent, named absolutely', () => {
    refuses(sandbox);
    refuses(box);
  });

  it('refuses a repo directory reached through a symlink', () => {
    // A string comparison sees box/link/site as outside the repo; rmSync
    // follows the link and deletes the sandbox's site/.
    refuses(join(box, 'link', 'site'));
  });

  it('refuses a repo directory spelled in another case, where the disk ignores case', ({ skip }) => {
    // macOS disks are case-insensitive by default, so REPO-X/site is site/.
    if (!existsSync(join(box, 'REPO-X'))) skip();
    refuses(join(box, 'REPO-X', 'site'));
  });

  it('still builds into, and wipes, the default dist/frontdoor', () => {
    const site = tree(join(sandbox, 'site'));
    mkdirSync(join(sandbox, 'dist/frontdoor'), { recursive: true });
    writeFileSync(join(sandbox, 'dist/frontdoor/stale.html'), 'stale');
    const run = build();
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(sandbox, 'dist/frontdoor/index.html'))).toBe(true);
    expect(existsSync(join(sandbox, 'dist/frontdoor/stale.html'))).toBe(false);
    expect(tree(join(sandbox, 'site'))).toEqual(site);
  });

  it.each([
    ['<box>/out', 'a directory beside the repo'],
    ['<box>/repo', 'a sibling whose path is a string prefix of the repo\'s'],
    ['<box>/repo-x2', 'a sibling the repo\'s path is a string prefix of'],
  ])('still builds into %s (%s)', (arg) => {
    const dir = arg.replace('<box>', box);
    const repoFiles = tree(sandbox);
    const run = build(dir);
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
    expect(tree(sandbox)).toEqual(repoFiles);
  });
});
