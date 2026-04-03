/**
 * Binance REST candle helpers for Lag Snipe.
 * We always use only *closed* 1m candles (skip the forming bar).
 */

export type KlineOhlc = {
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime: number;
};

function parseRow(k: unknown[]): KlineOhlc | null {
  if (!Array.isArray(k) || k.length < 7) return null;
  const open = Number(k[1]);
  const high = Number(k[2]);
  const low = Number(k[3]);
  const close = Number(k[4]);
  const closeTime = Number(k[6]);
  if (![open, high, low, close, closeTime].every((x) => Number.isFinite(x))) return null;
  return { open, high, low, close, closeTime };
}

async function fetchLastClosed1mCandlesUsdt(symbol: string, limit: number): Promise<KlineOhlc[] | null> {
  const safeLimit = Math.max(2, Math.min(30, Math.floor(limit)));
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
    symbol
  )}&interval=1m&limit=${safeLimit + 6}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const raw = (await res.json()) as unknown[];
  if (!Array.isArray(raw)) return null;
  const now = Date.now();
  const closed = raw
    .map((row) => parseRow(row as unknown[]))
    .filter((x): x is KlineOhlc => x != null && x.closeTime < now - 800);
  if (closed.length < safeLimit) return null;
  return closed.slice(closed.length - safeLimit);
}

/** Fetch last two fully closed 1m BTCUSDT candles (not the forming bar). */
export async function fetchLastTwoClosed1mBtcUsdt(): Promise<[KlineOhlc, KlineOhlc] | null> {
  const candles = await fetchLastClosed1mCandlesUsdt("BTCUSDT", 2);
  if (!candles) return null;
  return [candles[0]!, candles[1]!];
}

/** Fetch last five fully closed 1m BTCUSDT candles for 4-min candle analysis. */
export async function fetchLastFiveClosed1mBtcUsdt(): Promise<KlineOhlc[] | null> {
  return fetchLastClosed1mCandlesUsdt("BTCUSDT", 5);
}

/** Fetch last five fully closed 1m ETHUSDT candles for 4-min candle analysis. */
export async function fetchLastFiveClosed1mEthUsdt(): Promise<KlineOhlc[] | null> {
  return fetchLastClosed1mCandlesUsdt("ETHUSDT", 5);
}
