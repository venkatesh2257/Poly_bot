/**
 * Market Engine — Polymarket BTC 15m up/down markets (slug btc-updown-15m-*)
 * Uses EU proxy to bypass US geo-block
 */

import {
  BTC_UPDOWN_MARKET_WINDOW_SEC,
  btcUpdown15mEventSlug,
  currentBtcUpdownWindowStartSec,
} from "./btcUpdownWindow.js";

export {
  BTC_UPDOWN_MARKET_WINDOW_SEC,
  btcUpdown15mEventSlug,
  currentBtcUpdownWindowStartSec,
} from "./btcUpdownWindow.js";

export interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  endDate: string;
  windowStart: number;
  windowEnd: number;
  upTokenId: string;
  downTokenId: string;
  upPrice: number;
  downPrice: number;
  upBestBid: number; // highest buy offer on this token's book
  downBestBid: number; // highest buy offer on this token's book
  upBestAsk: number; // lowest sell offer on this token's book
  downBestAsk: number; // lowest sell offer on this token's book
  upAskDepth: number; // total size available at best ask
  downAskDepth: number;
  acceptingOrders: boolean;
}

const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

async function proxiedFetch(targetUrl: string): Promise<Response> {
  return fetch(PROXY_URL, {
    headers: {
      "x-target-url": targetUrl,
      "x-proxy-secret": PROXY_SECRET,
    },
  });
}

export async function findCurrentMarket(): Promise<MarketInfo | null> {
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = currentBtcUpdownWindowStartSec(now);
  const timeIntoWindow = now - currentWindowStart;

  // Only trade current window, skip if too close to end
  if (timeIntoWindow > BTC_UPDOWN_MARKET_WINDOW_SEC - 5) return null;

  const slug = btcUpdown15mEventSlug(currentWindowStart);

  try {
    const res = await proxiedFetch(`${GAMMA_BASE}/events/slug/${slug}`);
    if (!res.ok) return null;

    const event = (await res.json()) as any;
    if (!event?.id || !event?.markets?.length) return null;

    const market = event.markets[0];
    const clobTokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");
    const outcomes: string[] = JSON.parse(market.outcomes || "[]");
    const outcomePrices: string[] = JSON.parse(market.outcomePrices || '["0.5","0.5"]');

    if (clobTokenIds.length < 2) return null;

    const upIdx = outcomes.findIndex((o: string) => /up/i.test(o));
    const downIdx = outcomes.findIndex((o: string) => /down/i.test(o));

    const upTokenId = clobTokenIds[upIdx >= 0 ? upIdx : 0];
    const downTokenId = clobTokenIds[downIdx >= 0 ? downIdx : 1];
    const upMid = parseFloat(outcomePrices[upIdx >= 0 ? upIdx : 0]);
    const downMid = parseFloat(outcomePrices[downIdx >= 0 ? downIdx : 1]);

    // Fetch orderbook for both tokens — get best bids AND best asks
    let upBestBid = 0,
      downBestBid = 0;
    let upBestAsk = 0,
      downBestAsk = 0;
    let upAskDepth = 0,
      downAskDepth = 0;
    try {
      const upBookRes = await proxiedFetch(`https://clob.polymarket.com/book?token_id=${upTokenId}`);
      if (upBookRes.ok) {
        const book = (await upBookRes.json()) as any;
        const bids = book?.bids || [];
        const asks = book?.asks || [];
        if (bids.length > 0) {
          upBestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
        }
        if (asks.length > 0) {
          const sortedAsks = asks
            .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            .sort((a: any, b: any) => a.price - b.price);
          upBestAsk = sortedAsks[0].price;
          upAskDepth = sortedAsks[0].size;
        }
      }
      const downBookRes = await proxiedFetch(`https://clob.polymarket.com/book?token_id=${downTokenId}`);
      if (downBookRes.ok) {
        const book = (await downBookRes.json()) as any;
        const bids = book?.bids || [];
        const asks = book?.asks || [];
        if (bids.length > 0) {
          downBestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
        }
        if (asks.length > 0) {
          const sortedAsks = asks
            .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
            .sort((a: any, b: any) => a.price - b.price);
          downBestAsk = sortedAsks[0].price;
          downAskDepth = sortedAsks[0].size;
        }
      }
    } catch {
      // Fall back to mid prices if orderbook fetch fails
    }

    return {
      slug,
      question: market.question,
      conditionId: market.conditionId,
      endDate: market.endDate,
      windowStart: currentWindowStart,
      windowEnd: currentWindowStart + BTC_UPDOWN_MARKET_WINDOW_SEC,
      upTokenId,
      downTokenId,
      upPrice: upMid,
      downPrice: downMid,
      upBestBid,
      downBestBid,
      upBestAsk,
      downBestAsk,
      upAskDepth,
      downAskDepth,
      acceptingOrders: market.acceptingOrders ?? true,
    };
  } catch {
    return null;
  }
}

/**
 * Map resolved Gamma outcomePrices to Up/Down using the same Up/Down indices as `findCurrentMarket()`
 * (`/up/i` and `/down/i` on `market.outcomes`). Resolves from labeled indices, not array position.
 * Returns `pending` if not yet resolved; `null` if ambiguous or labels cannot be mapped.
 */
export function resolveBtcUpdownWinnerFromMarketData(
  outcomes: string[],
  outcomePrices: string[]
): "Up" | "Down" | "pending" | null {
  if (!outcomes.length || outcomes.length !== outcomePrices.length) return "pending";

  const upIdx = outcomes.findIndex((o: string) => /up/i.test(o));
  const downIdx = outcomes.findIndex((o: string) => /down/i.test(o));
  if (upIdx < 0 || downIdx < 0 || upIdx === downIdx) return null;

  const rawUp = String(outcomePrices[upIdx]).trim();
  const rawDown = String(outcomePrices[downIdx]).trim();
  const upWon = rawUp === "1" || parseFloat(rawUp) === 1;
  const downWon = rawDown === "1" || parseFloat(rawDown) === 1;

  if (upWon && !downWon) return "Up";
  if (downWon && !upWon) return "Down";
  if (!upWon && !downWon) return "pending";
  return null;
}

/**
 * Check market outcome after resolution (outcome order from Gamma may differ from [Up, Down]).
 */
export async function checkMarketOutcome(windowStart: number): Promise<"Up" | "Down" | "pending" | null> {
  const slug = btcUpdown15mEventSlug(windowStart);
  try {
    const res = await proxiedFetch(`${GAMMA_BASE}/events/slug/${slug}`);
    if (!res.ok) return null;
    const event = (await res.json()) as any;
    const market = event?.markets?.[0];
    if (!market) return null;
    const outcomes: string[] = JSON.parse(market.outcomes || "[]");
    const prices: string[] = JSON.parse(market.outcomePrices || "[]");
    return resolveBtcUpdownWinnerFromMarketData(outcomes, prices);
  } catch {
    return null;
  }
}
