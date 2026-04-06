/**
 * Detect Polymarket crypto Up/Down markets with ~5m (300s) Gamma windows (BTC/ETH/SOL/XRP).
 * Used by PM5m-specific strategies only — does not change anchor/momentum/lag-snipe behavior.
 */

const CRYPTO_UPDOWN_ASSETS = new Set(["BTC", "ETH", "SOL", "XRP"]);

const WINDOW_MS_MIN = 285_000;
const WINDOW_MS_MAX = 315_000;

/**
 * True when the active market is a configured crypto asset and Gamma window length ≈ 300s.
 */
export function isPolymarketCryptoUpDown5mWindow(
  asset: string | null | undefined,
  meta: { endDateIso: string; windowStartSec?: number } | null | undefined
): boolean {
  const a = String(asset ?? "")
    .trim()
    .toUpperCase();
  if (!CRYPTO_UPDOWN_ASSETS.has(a) || !meta?.endDateIso) return false;
  const end = new Date(meta.endDateIso).getTime();
  if (Number.isNaN(end)) return false;
  const ws = meta.windowStartSec;
  if (ws == null || !Number.isFinite(ws)) return false;
  const durMs = end - ws * 1000;
  return durMs >= WINDOW_MS_MIN && durMs <= WINDOW_MS_MAX;
}

export function polymarket5mWindowKey(meta: { slug?: string | null; windowStartSec?: number } | null | undefined): string {
  if (!meta) return "unknown|?";
  const slug = meta.slug != null ? String(meta.slug) : "unknown";
  const ws = meta.windowStartSec != null && Number.isFinite(meta.windowStartSec) ? String(meta.windowStartSec) : "?";
  return `${slug}|${ws}`;
}
