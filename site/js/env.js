// Deployment endpoints. The Worker URL is the only environment-specific
// value in the shipped site; update it when deploying under your own domain.
// Name aware: a page served from an idlescreen host talks to the worker's
// idlescreen alias, an unsleep host talks to the unsleep alias, and every other
// origin (roomboard.app and friends) keeps the original worker domain. Each
// stack is deliberately self-contained end to end, so a name's pages and its
// API rise and fall together instead of one name's outage reaching across into
// another's boards. (The rvc.tech fallback pair was retired 2026-08-07, and the
// quadrille.io stack 2026-09-26: its hosts redirect to idlescreen's now.)
export const WORKER_URL = (() => {
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (host.endsWith('unsleep.app') || host.endsWith('unsleep.io')) return 'https://api.unsleep.app';
  if (host.endsWith('idlescreen.app') || host.endsWith('idlescreen.io')) return 'https://api.idlescreen.app';
  return 'https://api.roomboard.app';
})();
