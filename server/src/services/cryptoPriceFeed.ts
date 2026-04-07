/**
 * Spot USD for major symbols.
 * Order: Coinbase spot → Binance REST ticker → last-good cache (survives transient failures).
 * Used by dashboard charts and bone latency; does not affect order routing.
 */

const FETCH_TIMEOUT_MS = 5_000;

const BINANCE_TICKERS: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
  DOGE: "DOGEUSDT"
};

const lastGoodUsd = new Map<string, number>();

/** Last successful USD spot per symbol (for engine fallback when REST is briefly down). */
export function getLastGoodUsd(symbol: string): number | undefined {
  const u = symbol.trim().toUpperCase();
  const v = lastGoodUsd.get(u);
  return v != null && Number.isFinite(v) && v > 0 ? v : undefined;
}

async function fetchCoinbaseSpot(symbol: string): Promise<number> {
  const url = `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Coinbase ${symbol}: HTTP ${r.status}`);
  const j = (await r.json()) as { data?: { amount?: string } };
  const n = Number(j?.data?.amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Coinbase ${symbol}: invalid amount`);
  return n;
}

async function fetchBinanceSpot(symbol: string): Promise<number> {
  const pair = BINANCE_TICKERS[symbol];
  if (!pair) throw new Error(`Binance ${symbol}: unsupported symbol`);
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Binance ${symbol}: HTTP ${r.status}`);
  const j = (await r.json()) as { price?: string };
  const n = Number(j?.price);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Binance ${symbol}: invalid price`);
  return n;
}

export async function fetchUsdSpot(symbol: string): Promise<number> {
  const u = symbol.trim().toUpperCase();
  try {
    const n = await fetchCoinbaseSpot(u);
    lastGoodUsd.set(u, n);
    return n;
  } catch {
    /* fall through to Binance */
  }
  try {
    const n = await fetchBinanceSpot(u);
    lastGoodUsd.set(u, n);
    return n;
  } catch {
    /* fall through to cached value */
  }
  const cached = lastGoodUsd.get(u);
  if (cached != null && Number.isFinite(cached) && cached > 0) return cached;
  throw new Error(`${u}/USD unavailable`);
}
