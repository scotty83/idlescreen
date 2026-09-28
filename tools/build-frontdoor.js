// Assemble the idlescreen.io front door from site/ into dist/frontdoor.
//
// The front door is the public widget guide served on its own origin so it
// can cache normally while the app keeps `no-cache` (see site/_headers). It
// used to be a hand-curled mirror of the live /info page, which meant it went
// stale whenever /info shipped without anyone re-running the mirror; this
// script makes it a build product of the same commit instead. CI deploys the
// output to the `quadrille-site` Pages project on every push to main
// (.github/workflows/test.yml), and `npm run deploy:frontdoor` is the manual
// fallback. That project name predates two renames now and is deliberately
// frozen: idlescreen.io and unsleep.io are both custom domains attached to it,
// so renaming the project would break those attachments to rename a string
// nobody sees.
//
// There are no brand rewrites here, and that absence is the design. The guide
// carries its own title, copy and app links, and this script serves the same
// bytes the app serves at /info. A rewrite layer would let the two origins
// drift, which is the exact failure the hand-curled mirror used to produce.
// Brand copy changes belong in site/info.html.
//
// The file list is EXPLICIT on purpose: the guide is self-contained (one
// stylesheet, one script, the changelog it fetches, and its images), and an
// explicit list fails loudly in CI when a new dependency is added to
// info.html without being shipped here — a silent partial copy would serve a
// broken page with a green build.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, relative, isAbsolute, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// An optional output directory, for the tests (test/frontdoor.test.js builds
// into a temp dir so it never clobbers a staged dist/). The directory is wiped
// before anything is copied, so only two kinds are accepted: the default
// dist/frontdoor, and a directory wholly outside the repo that does not hold
// it either. Everything else in the repo is source (`site`, `worker`, `.git`,
// `.`), and a relative argument resolves against the repo, not the caller's
// cwd, so a stray `site` would have wiped site/. The comparison is on path
// segments, not string prefixes (/a/b is not inside /a/bc), and on real
// paths: a symlink or a differently-cased spelling (macOS disks ignore case)
// can name a repo directory without looking like one. A path that does not
// exist yet is judged by its nearest existing ancestor.
const out = resolve(repo, process.argv[2] ?? 'dist/frontdoor');
const real = (p) => {
  const rest = [];
  while (!existsSync(p)) {
    rest.unshift(basename(p));
    p = dirname(p);
  }
  return resolve(realpathSync.native(p), ...rest);
};
const within = (dir, p) => {
  const rel = relative(dir, p);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
if (out !== resolve(repo, 'dist/frontdoor')) {
  const [realRepo, realOut] = [real(repo), real(out)];
  if (within(realRepo, realOut) || within(realOut, realRepo)) {
    console.error('front door only builds into dist/frontdoor or a directory outside the repo, not:', out);
    process.exit(1);
  }
}

const FILES = [
  // [source under site/, destination under dist/frontdoor/]
  ['info.html', 'index.html'], // the guide IS the front door's root...
  ['info.html', 'info.html'], // ...and /info keeps working for old links
  // The guide's footer links this relatively, so it must exist on BOTH
  // origins — idlescreen.io/terms and idlescreen.app/terms are the same bytes. The
  // reference guard below is what enforces that it keeps being shipped.
  ['terms.html', 'terms.html'],
  // The same bytes the app hosts serve: allow everything, name the sitemaps.
  // sitemap.xml itself is not copied; it is written below from these pages.
  ['robots.txt', 'robots.txt'],
  ['css/info.css', 'css/info.css'],
  ['js/info.js', 'js/info.js'],
  // info.js's only static import: the wordmark's power-tittle probe, shared
  // with the board shell. Nothing in index.html references it, so only the
  // module-import guard below can catch it going missing.
  ['js/tittle-probe.js', 'js/tittle-probe.js'],
  ['data/changelog.json', 'data/changelog.json'], // also the health probe
  // Icon filenames track site/assets and the guide's <link rel="icon">; they
  // are brand-named, so a rename on either side has to land on both.
  ['assets/idlescreen-quad.svg', 'assets/idlescreen-quad.svg'],
  ['assets/idlescreen-favicon-32.png', 'assets/idlescreen-favicon-32.png'],
  ['assets/idlescreen-icon-180.png', 'assets/idlescreen-icon-180.png'],
  // Every superseded set still ships, and the list only ever grows. The front
  // door caches normally (that is its point), so HTML cached under an earlier
  // name keeps resolving its icons until it expires instead of 404ing them —
  // and Pages propagates PER-ASSET, so a copy that stops shipping goes missing
  // while the page that references it is still being served.
  ['assets/unsleep-quad.svg', 'assets/unsleep-quad.svg'],
  ['assets/unsleep-favicon-32.png', 'assets/unsleep-favicon-32.png'],
  ['assets/unsleep-icon-180.png', 'assets/unsleep-icon-180.png'],
  ['assets/quadrille-favicon-32.png', 'assets/quadrille-favicon-32.png'],
  ['assets/quadrille-icon-180.png', 'assets/quadrille-icon-180.png'],
];
const DIRS = [['assets/info', 'assets/info']];

// Name the missing sources before copying. cpSync would fail anyway, but on
// the first one and with a bare ENOENT path; a renamed asset set is worth a
// sentence that says which side of the rename is out of step.
const absent = [...FILES.map(([s]) => s), ...DIRS.map(([s]) => s)].filter((s) => !existsSync(resolve(repo, 'site', s)));
if (absent.length) {
  console.error('front door cannot find these under site/:', absent);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [src, dest] of FILES) {
  const to = resolve(out, dest);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(resolve(repo, 'site', src), to);
}
for (const [src, dest] of DIRS) {
  cpSync(resolve(repo, 'site', src), resolve(out, dest), { recursive: true });
}

// Guard: the guide must not lean on app-relative URLs the front door cannot
// serve. Everything it references must be in the explicit list above, or an
// absolute URL into the app origin (the /setup pointer is absolute by design).
const html = readFileSync(resolve(out, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1]);
const missing = refs.filter((r) => !/^https?:/.test(r) && !FILES.some(([, d]) => d === r) && !r.startsWith('assets/info/'));
if (missing.length) {
  console.error('front door references files it does not ship:', missing);
  process.exit(1);
}

// The same guard one level down, because the scan above cannot see it. The
// guide's script is an ES MODULE, and a module's imports are requests the front
// door has to answer just as much as a <script src> is, but they live in the
// JavaScript, not in the HTML, so a shared module extracted out of info.js
// would 404 on this origin with every test and every HTML reference still
// green. That is the exact "broken page with a green build" this file exists to
// prevent, so relative specifiers get resolved against each shipped module's
// own destination and checked against the list too. Bare and absolute
// specifiers are somebody else's problem by construction: only a leading dot
// can name a file this build is responsible for.
const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g;
const unshipped = FILES.filter(([, d]) => d.endsWith('.js')).flatMap(([, dest]) => {
  const src = readFileSync(resolve(out, dest), 'utf8');
  return [...src.matchAll(RELATIVE_IMPORT)]
    .map((m) => posix.resolve('/', posix.dirname(dest), m[1]).slice(1))
    .filter((r) => !FILES.some(([, d]) => d === r))
    .map((r) => `${r} (imported by ${dest})`);
});
if (unshipped.length) {
  console.error('front door modules import files it does not ship:', unshipped);
  process.exit(1);
}

// Every page names its home, and the sitemap is those homes. The same bytes
// answer on idlescreen.io, unsleep.io and the app hosts, and with no declared
// home Google indexed the oldest copy, so each shipped page carries a
// canonical link into idlescreen.io that has to land on a page this build
// ships (Pages serves /terms from terms.html and / from index.html). The
// sitemap is the de-duplicated set of those links, which is why it cannot
// drift from the pages: index.html and info.html are one page to a crawler and
// one line here. No <lastmod>: this script copies files, and neither the build
// time nor CI's one-commit shallow clone can say when a page last changed.
const ORIGIN = 'https://idlescreen.io';
const CANONICAL = /<link rel="canonical" href="([^"]*)">/;
const pages = FILES.map(([, d]) => d).filter((d) => d.endsWith('.html'));
const homes = [];
const unhomed = [];
for (const page of pages) {
  const href = CANONICAL.exec(readFileSync(resolve(out, page), 'utf8'))?.[1];
  const path = href?.startsWith(`${ORIGIN}/`) ? href.slice(ORIGIN.length) : '';
  const file = path.endsWith('/') ? `${path.slice(1)}index.html` : `${path.slice(1)}.html`;
  if (!path || !pages.includes(file)) unhomed.push(`${page} (canonical: ${href ?? 'none'})`);
  else if (!homes.includes(href)) homes.push(href);
}
if (unhomed.length) {
  console.error(`front door pages without a canonical ${ORIGIN} page it ships:`, unhomed);
  process.exit(1);
}
writeFileSync(
  resolve(out, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + homes.map((u) => `  <url><loc>${u}</loc></url>\n`).join('')
    + '</urlset>\n',
);
console.log(`front door assembled: ${FILES.length} files + assets/info + sitemap (${homes.length} pages) -> ${out}`);
