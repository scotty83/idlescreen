// Jittered periodic runner with exponential backoff on failure. Jitter keeps
// a fleet of boards from hitting upstream feeds in lockstep.

// `startDelayMs` offsets only the FIRST run (default 0 = the historic
// setTimeout(0) behaviour). The runtime uses it to deal each widget its own
// boot slot: without it every card on the board opened its first connection in
// the same tick, ~20 sockets across ~7 hosts on gen1's embedded stack. Callers
// pass an explicit number rather than the scheduler rolling a random one, so
// boot order stays deterministic and testable.
// `intervalMs` is usually a fixed number, multiplied by the backoff between
// failures. It may instead be a function `({ failed }) => ms`, called after each
// run to compute the next delay itself — the seam daily widgets use to schedule
// against the local calendar rather than a fixed period (see dailyRefresh). When
// it is a function the backoff multiply steps aside; the function owns timing.
export function schedule(fn, intervalMs, { jitter = 0.15, startDelayMs = 0 } = {}) {
  let cancelled = false;
  let timer = null;
  let backoff = 1;

  const jittered = (ms) => {
    if (!jitter) return ms;
    const spread = ms * jitter;
    return Math.round(ms - spread + Math.random() * 2 * spread);
  };

  const run = async () => {
    if (cancelled) return;
    let failed = false;
    try {
      await fn();
      backoff = 1;
    } catch {
      failed = true;
      backoff = Math.min(backoff * 2, 8);
    }
    if (!cancelled) {
      const base = typeof intervalMs === 'function'
        ? intervalMs({ failed, attempt: backoff })
        : intervalMs * backoff;
      timer = setTimeout(run, jittered(base));
    }
  };

  timer = setTimeout(run, Math.max(0, startDelayMs) || 0);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

// Milliseconds from `now` to the next LOCAL midnight. Local, not UTC: the daily
// widgets are keyed to the local date (This Day in History, Word of the Day), so
// their rollover has to land on the board's own day boundary.
export function msUntilNextLocalMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

// Interval function for a daily widget: refresh at the next local midnight (plus
// a small jitter so a fleet does not stampede the feed at 00:00), NOT 24h after
// whenever it last happened to fetch. A jittered 24h interval drifts off the date
// boundary, so a board left on across midnight kept yesterday's pick until the
// nightly reload. On a failed fetch, retry on a short bounded delay rather than
// waiting a whole day, then resume the daily cadence once a run succeeds.
export function dailyRefresh({ retryMs = 5 * 60 * 1000, jitterMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  return ({ failed } = {}) => {
    const toMidnight = msUntilNextLocalMidnight(new Date(now()));
    return failed ? Math.min(retryMs, toMidnight) : toMidnight + Math.floor(Math.random() * jitterMs);
  };
}
