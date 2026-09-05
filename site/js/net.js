// Fetch helpers with a hard timeout. The MTA endpoints reject HEAD requests,
// so everything here is plain GET.

import { WORKER_URL } from './env.js';

const TIMEOUT_MS = 15000;

// Worker round-trip timing, reported OUT to the beacon (site/js/fleet.js) via a
// registered hook rather than by importing fleet.js here. fleet.js already
// imports THIS module, so a static `import { reportWorkerFetch } from
// './fleet.js'` would be a real circular import; the hook keeps the dependency
// pointing one way (fleet -> net) and leaves net.js usable on its own — nothing
// is timed until something registers.
export let onWorkerFetch = null;
export const setWorkerFetchHook = (fn) => { onWorkerFetch = fn; };

export class NetError extends Error {
  constructor(message, { url, status = null } = {}) {
    super(message);
    this.name = 'NetError';
    this.url = url;
    this.status = status;
  }
}

// The caller hands in `consume` (res.json / res.arrayBuffer / res.text) so the
// body is read INSIDE the abort window: a server that sends 200 headers and
// then stalls mid-stream must still hit the deadline, and it only does if the
// abort timer is live while the body is drained. Returning the raw Response and
// clearing the timer first left a stalled body pending forever, freezing the
// widget's scheduled callback. The abort during a drain rejects as AbortError,
// which the catch maps to a 'timeout' NetError like any header-stage timeout.
async function fetchWithTimeout(url, opts = {}, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new NetError(`HTTP ${res.status}`, { url, status: res.status });
    return await consume(res);
  } catch (err) {
    if (err instanceof NetError) throw err;
    throw new NetError(err.name === 'AbortError' ? 'timeout' : String(err), { url });
  } finally {
    clearTimeout(timer);
  }
}

// Timed for OUR worker only: a third-party feed's latency says nothing about
// the deployment, and the beacon has one number to spend. `finally` on purpose —
// a timeout or a 5xx IS worker latency, and hiding the slow cases would make the
// median read healthiest exactly when the worker is worst. The worker's
// parseBeacon caps the reported value, so a pathological sample cannot run away.
export async function fetchJSON(url, opts) {
  const t0 = Date.now();
  try {
    return await fetchWithTimeout(url, opts, (res) => res.json());
  } finally {
    if (onWorkerFetch && String(url).startsWith(WORKER_URL)) onWorkerFetch(Date.now() - t0);
  }
}

export async function fetchBuffer(url, opts) {
  return fetchWithTimeout(url, opts, (res) => res.arrayBuffer());
}

export async function fetchText(url, opts) {
  return fetchWithTimeout(url, opts, (res) => res.text());
}
