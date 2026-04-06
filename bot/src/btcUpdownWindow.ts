/**
 * Polymarket BTC up/down event window math (must match Gamma slug scheme).
 * Current markets use 15-minute windows: btc-updown-15m-{unixStart}
 */

export const BTC_UPDOWN_MARKET_WINDOW_SEC = 900;

/** Floor of wall-clock seconds to the active market window start (UTC epoch seconds). */
export function currentBtcUpdownWindowStartSec(nowSec: number): number {
  return Math.floor(nowSec / BTC_UPDOWN_MARKET_WINDOW_SEC) * BTC_UPDOWN_MARKET_WINDOW_SEC;
}

/** Gamma event slug for a given window start (seconds). */
export function btcUpdown15mEventSlug(windowStartSec: number): string {
  return `btc-updown-15m-${windowStartSec}`;
}
