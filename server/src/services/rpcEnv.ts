/** Public Polygon HTTPS JSON-RPC when primary returns 401/403 (invalid/expired Alchemy key, etc.). */
export const DEFAULT_POLYGON_RPC_FALLBACK = "https://rpc.ankr.com/polygon";

/**
 * JSON-RPC endpoint the app should call (pings, future provider use).
 * Order: edge proxy → direct premium RPC → legacy `RPC_URL`.
 * Set `POLYGON_RPC_PROXY_URL` to your Cloudflare Worker URL after deploying `workers/polygon-rpc-proxy.js`.
 */
export function resolvePolygonRpcUrl(): string {
  const candidates = [
    process.env.POLYGON_RPC_PROXY_URL,
    // Back-compat with older env var names used in this repo's `.env`.
    process.env.PROXY_URL,
    process.env.POLYGON_RPC_URL,
    process.env.RPC_URL
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);

  // If the only values are placeholders, return "" so callers can fail gracefully.
  for (const c of candidates) {
    if (!polygonRpcUrlLooksPlaceholder(c)) return c;
  }
  return "";
}

/**
 * Fallback RPC for `eth_chainId` when primary is unauthorized.
 * Set `POLYGON_RPC_FALLBACK_URL=` (empty) to disable; unset uses Ankr public Polygon.
 */
export function resolvePolygonRpcFallbackUrl(): string | null {
  const raw = process.env.POLYGON_RPC_FALLBACK_URL;
  if (raw === "") return null;
  const u = (raw ?? DEFAULT_POLYGON_RPC_FALLBACK).trim();
  return u || null;
}

export function polygonRpcUrlLooksPlaceholder(url: string): boolean {
  if (!url) return true;
  return /your-key|YOUR_VALID_KEY|REPLACE_WITH|your_key|your_proxy_url|your_proxy_secret/i.test(url);
}
