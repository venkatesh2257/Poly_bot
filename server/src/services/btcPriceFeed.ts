/** Public spot BTC/USD — delegates to cryptoPriceFeed so cache + fallbacks stay unified. */

import { fetchUsdSpot } from "./cryptoPriceFeed.js";

export async function fetchBtcUsd(): Promise<number> {
  return fetchUsdSpot("BTC");
}
