import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJSON, fetchText, NetError } from '../site/js/net.js';

// net.js's whole job is the hard timeout. The interesting case is not a dead
// socket (fetch itself rejects) but a server that sends 200 headers and then
// goes silent mid-body: the deadline only bites if the abort timer is still
// live while the body is drained. These pin that the drain happens inside the
// window.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// A Response whose body never arrives: the consume promise only settles when
// the request's own signal aborts, exactly like a stalled TCP stream.
const stallingBody = (signal) => new Promise((_res, rej) => {
  if (signal.aborted) return rej(abortError());
  signal.addEventListener('abort', () => rej(abortError()), { once: true });
});

describe('fetchWithTimeout body consumption', () => {
  it('aborts a stalled JSON body within the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => ({
      ok: true,
      status: 200,
      json: () => stallingBody(opts.signal),
    })));

    const p = fetchJSON('https://example.com/x', { timeoutMs: 1000 });
    // Attach the rejection expectation before advancing so the timeout's
    // rejection is never seen as unhandled.
    const settled = expect(p).rejects.toMatchObject({ name: 'NetError', message: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('aborts a stalled text body within the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, opts) => ({
      ok: true,
      status: 200,
      text: () => stallingBody(opts.signal),
    })));

    const p = fetchText('https://example.com/x', { timeoutMs: 1000 });
    const settled = expect(p).rejects.toBeInstanceOf(NetError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('still returns a parsed body when it arrives in time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: 'here' }),
    })));
    expect(await fetchJSON('https://example.com/x', { timeoutMs: 1000 })).toEqual({ ok: 'here' });
  });
});
