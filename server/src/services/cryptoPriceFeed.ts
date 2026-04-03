/** Spot USD for major symbols (Coinbase spot API; used when primary is not BTC). */
export async function fetchUsdSpot(symbol: string): Promise<number> {
  const u = symbol.trim().toUpperCase();
  const url = `https://api.coinbase.com/v2/prices/${encodeURIComponent(u)}-USD/spot`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Coinbase ${u}: HTTP ${r.status}`);
  const j = (await r.json()) as { data?: { amount?: string } };
  const n = Number(j?.data?.amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Coinbase ${u}: invalid amount`);
  return n;
}
