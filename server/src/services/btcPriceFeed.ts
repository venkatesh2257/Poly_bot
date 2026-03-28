/** Public spot BTC/USD — not Polymarket’s internal Chainlink stream; matches typical exchange spot. */

const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

let lastGoodUsd = 0;

export async function fetchBtcUsd(): Promise<number> {
  try {
    const r = await fetch(COINBASE_SPOT, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    const j = (await r.json()) as { data?: { amount?: string } };
    const n = Number(j?.data?.amount);
    if (Number.isFinite(n) && n > 0) {
      lastGoodUsd = n;
      return n;
    }
  } catch {
    /* try binance */
  }
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
      signal: AbortSignal.timeout(10_000)
    });
    if (!r.ok) throw new Error(`binance ${r.status}`);
    const j = (await r.json()) as { price?: string };
    const n = Number(j?.price);
    if (Number.isFinite(n) && n > 0) {
      lastGoodUsd = n;
      return n;
    }
  } catch {
    /* fall through */
  }
  if (lastGoodUsd > 0) return lastGoodUsd;
  throw new Error("BTC/USD unavailable");
}
