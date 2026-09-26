// Yahoo Finance chart payload -> compact index summary served to boards.

export function mapYahooChart(json, name) {
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice) || !Number.isFinite(meta.chartPreviousClose)) {
    throw new Error('malformed yahoo chart payload');
  }
  const price = meta.regularMarketPrice;
  // Split bars by exchange-local trading day (fetched with range=2d). The
  // daily-change baseline is the PRIOR session's last close taken from the
  // bars themselves: after a foreign market closes, Yahoo rolls the session
  // into chartPreviousClose (price === prev), which read as a 0.00 change for
  // LSE tickers every evening. chartPreviousClose stays as the fallback when
  // the payload only carries one session (or no timestamps).
  const off = Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : 0;
  const stamps = result.timestamp ?? [];
  const rows = (result.indicators?.quote?.[0]?.close ?? [])
    .map((c, i) => [stamps[i], c])
    .filter(([t, c]) => Number.isFinite(t) && Number.isFinite(c));
  const dayOf = (t) => Math.floor((t + off) / 86400);
  const lastDay = rows.length ? dayOf(rows[rows.length - 1][0]) : null;
  const today = rows.filter(([t]) => dayOf(t) === lastDay).map(([, c]) => c);
  const prevRows = rows.filter(([t]) => dayOf(t) !== lastDay);
  const prevCloses = prevRows.map(([, c]) => c);
  const prev = prevRows.length ? prevRows[prevRows.length - 1][1] : meta.chartPreviousClose;
  // spark = last session (the compact 1-day shape small cards render).
  const spark = today.length ? today : rows.map(([, c]) => c);
  // spark2 = both sessions end-to-end, with `split` marking the first bar of
  // today — wide cards draw this with a divider at the day boundary. Only
  // populated when the payload actually carries a prior session AND today;
  // otherwise it mirrors spark with split 0 (no divider), so the client
  // degrades to the 1-day view.
  const twoDay = prevCloses.length > 0 && today.length > 0;
  // When the market last traded and the regular session Yahoo calls current,
  // for quoteFreshS; the card ignores both. Either may be null.
  const reg = meta.currentTradingPeriod?.regular;
  const session = Number.isFinite(reg?.start) && Number.isFinite(reg?.end)
    ? { start: reg.start, end: reg.end, gmtoffset: Number.isFinite(reg.gmtoffset) ? reg.gmtoffset : off }
    : null;
  return {
    symbol: meta.symbol,
    // longName is the humane one ("Close Brothers Group plc"); shortName for
    // LSE listings is the register entry ("CLOSE BROTHERS GROUP PLC ORD 25").
    // Curated INDEX_NAMES still win via the name argument.
    name: name ?? meta.longName ?? meta.shortName ?? meta.symbol,
    price,
    change: price - prev,
    changePct: ((price - prev) / prev) * 100,
    spark,
    spark2: twoDay ? [...prevCloses, ...today] : spark,
    split: twoDay ? prevCloses.length : 0,
    tradedAt: Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : null,
    session,
  };
}

// How long a quote stays fresh in the shared quote map, by whether its market
// is trading. While it trades a quote lives QUOTE_ACTIVE_S. Once it is closed
// nothing on the card can move until the next regular open, so the quote lives
// until just before it, within [QUOTE_ACTIVE_S, QUOTE_IDLE_MAX_S]: the cap is
// the backstop for an open this cannot foresee (a holiday's end, a futures
// Sunday-evening reopen), so a closed quote is never served more than 30 min
// into a session. A quote that says too little to tell is treated as trading.
export const QUOTE_ACTIVE_S = 240;
export const QUOTE_IDLE_MAX_S = 1800;
// Closed, with no session to project the next open from.
export const QUOTE_UNKNOWN_OPEN_S = 900;
// A trade this recent counts as trading even outside the session Yahoo names:
// the closing auction prints after the bell (the S&P's regularMarketTime read
// 21:00:58Z on a 20:00Z close in the recorded fixture).
const RECENT_TRADE_S = 15 * 60;
// Expire this long before a next open Yahoo states outright...
const OPEN_MARGIN_S = 60;
// ...and this long around one projected from an earlier session, which a
// daylight-saving change can move an hour either way in UTC (New York's open is
// 14:30Z the Friday before spring-forward and 13:30Z the Monday after; 13:30Z
// the Friday before fall-back and 14:30Z the Monday after).
const PROJECTED_MARGIN_S = 3600;
const DAY_S = 86400;
const SATURDAY = 6;

// When a quote from a closed market must expire (epoch seconds), or null. A
// time at or before nowS means the market is trading, or about to.
// Yahoo's currentTradingPeriod.regular names the next session once it rolls
// over, but that rollover is the exchange's own schedule, not the close: New
// York's read the NEXT day's session the evening of the recorded fixture,
// while Tokyo's still read Friday's at 13:52Z Friday, seven hours after it
// closed (checked live 2026-09-25). So a session already past is projected
// forward a day at a time, and the first projected session not yet over, open
// or not, is the answer: a session that opened since Yahoo last rolled over is
// trading, not skipped for tomorrow's. Holidays are not known here;
// QUOTE_IDLE_MAX_S covers them.
//
// Every exchange-local day but Saturday is a possible session day. Mon-Fri
// markets and the Sun-Thu ones (Tadawul, Qatar, Kuwait, Bahrain, Egypt) share
// that rule with no exchange table to keep, at a cost that errs toward
// freshness: a Mon-Fri quote is judged trading (QUOTE_ACTIVE_S) through its
// would-be Sunday session hours, and a Sun-Thu quote through its would-be
// Friday ones.
export function nextOpenS(session, nowS) {
  if (!session) return null;
  if (nowS < session.end) return session.start - OPEN_MARGIN_S;
  const len = session.end - session.start;
  for (let k = 1; k <= 7; k++) {
    const at = session.start + k * DAY_S;
    if (new Date((at + session.gmtoffset) * 1000).getUTCDay() === SATURDAY) continue;
    if (nowS < at + len + PROJECTED_MARGIN_S) return at - PROJECTED_MARGIN_S;
  }
  return null;
}

// sharedMapGet's freshS for the quote map: (quote, fetchedAtMs) => seconds.
// Judged at the quote's fetch, so its life is fixed from then on.
export function quoteFreshS(q, fetchedAtMs) {
  const t = fetchedAtMs / 1000;
  const s = q?.session;
  const inSession = Boolean(s) && s.start <= t && t < s.end;
  if (inSession || !Number.isFinite(q?.tradedAt) || t - q.tradedAt < RECENT_TRADE_S) return QUOTE_ACTIVE_S;
  const open = nextOpenS(s, t);
  if (open === null) return QUOTE_UNKNOWN_OPEN_S;
  // An open already reached (a projected session under way) floors to active.
  return Math.max(QUOTE_ACTIVE_S, Math.min(QUOTE_IDLE_MAX_S, open - t));
}
