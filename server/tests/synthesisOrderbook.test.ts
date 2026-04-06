import { describe, expect, it } from "vitest";
import { SynthesisPolymarketOrderbookStore } from "../src/services/synthesisOrderbook.js";

describe("SynthesisPolymarketOrderbookStore", () => {
  it("applies snapshot and produces MarketContext", () => {
    const s = new SynthesisPolymarketOrderbookStore();
    const raw = JSON.stringify({
      success: true,
      response: {
        orderbooks: [
          {
            venue: "polymarket",
            orderbook: {
              token_id: "tok1",
              bids: { "0.40": "100", "0.39": "50" },
              asks: { "0.42": "90", "0.43": "60" },
              best_bid: "0.40",
              best_ask: "0.42"
            }
          }
        ]
      }
    });
    s.ingestRawMessage(raw);
    const mc = s.toMarketContext("tok1");
    expect(mc).not.toBeNull();
    expect(mc!.bestBid).toBeCloseTo(0.4, 5);
    expect(mc!.bestAsk).toBeCloseTo(0.42, 5);
    expect(mc!.mid).toBeGreaterThan(0.4);
  });

  it("marks stale when no updates beyond threshold", () => {
    const s = new SynthesisPolymarketOrderbookStore();
    const raw = JSON.stringify({
      success: true,
      response: {
        orderbooks: [
          {
            venue: "polymarket",
            orderbook: {
              token_id: "tok1",
              bids: { "0.5": "10" },
              asks: { "0.51": "10" }
            }
          }
        ]
      }
    });
    s.ingestRawMessage(raw);
    expect(s.isStale("tok1", 60_000, Date.now() + 120_000)).toBe(true);
  });
});
