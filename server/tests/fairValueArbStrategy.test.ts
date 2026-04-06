import { describe, expect, it } from "vitest";
import { evaluatePolymarket5mFairValueArb } from "../src/services/fairValueArbStrategy.js";

describe("fairValueArbStrategy (Polymarket crypto ~5m)", () => {
  const baseCfg = {
    enabled: true,
    minEdgeAfterCosts: 0.02,
    feeBuffer: 0.01,
    slippageBuffer: 0.005,
    volAnnual: 0.85,
    minSecToExpiry: 10,
    maxSecRemainingForEntry: 0
  };

  const baseIn = {
    isPolymarketCryptoUpDown5m: true,
    spotUsd: 101_000,
    strikeUsd: 100_000,
    yesUpTokenBestBid: 0.35,
    yesUpTokenBestAsk: 0.36,
    yesDownTokenBestBid: 0.63,
    yesDownTokenBestAsk: 0.65,
    secToGammaExpiry: 200
  };

  it("NO_TRADE when spot missing", () => {
    const r = evaluatePolymarket5mFairValueArb(baseCfg, {
      ...baseIn,
      spotUsd: null
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("missing");
  });

  it("NO_TRADE when not Polymarket crypto ~5m window", () => {
    const r = evaluatePolymarket5mFairValueArb(baseCfg, {
      ...baseIn,
      isPolymarketCryptoUpDown5m: false
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("not a Polymarket crypto");
  });

  it("NO_TRADE when YES token book is not executable (bid/ask)", () => {
    const r = evaluatePolymarket5mFairValueArb(baseCfg, {
      ...baseIn,
      yesUpTokenBestBid: 0.4,
      yesUpTokenBestAsk: 0.38
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("non-executable");
  });

  it("TRADE when executable edge exceeds threshold after fees+slippage (UP)", () => {
    const r = evaluatePolymarket5mFairValueArb(baseCfg, baseIn);
    expect(r.recommendation).toBe("TRADE");
    expect(r.prediction).toBe("UP");
    expect(r.reason).toMatch(/^FVA\[PM5m\]:/);
    expect(r.reason).toContain("execAsk");
  });

  it("NO_TRADE when edge too small after fee+slippage buffer", () => {
    const r = evaluatePolymarket5mFairValueArb(
      { ...baseCfg, minEdgeAfterCosts: 0.5 },
      {
        ...baseIn,
        spotUsd: 100_010,
        yesUpTokenBestBid: 0.48,
        yesUpTokenBestAsk: 0.49,
        yesDownTokenBestBid: 0.5,
        yesDownTokenBestAsk: 0.52
      }
    );
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("FVA_MIN_EDGE");
  });

  it("NO_TRADE when too close to Gamma expiry", () => {
    const r = evaluatePolymarket5mFairValueArb(
      { ...baseCfg, minSecToExpiry: 60 },
      { ...baseIn, secToGammaExpiry: 30 }
    );
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("too close");
  });

  it("NO_TRADE when too early in window (maxSecRemainingForEntry band)", () => {
    const r = evaluatePolymarket5mFairValueArb(
      { ...baseCfg, maxSecRemainingForEntry: 180 },
      { ...baseIn, secToGammaExpiry: 250 }
    );
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("FVA_PM5M_MAX_SEC_REMAINING_FOR_ENTRY");
  });

  it("fee+slippage buffer is included in edge — large buffer can flip TRADE to NO_TRADE", () => {
    const tight = evaluatePolymarket5mFairValueArb(
      { ...baseCfg, minEdgeAfterCosts: 0.001, feeBuffer: 0.005, slippageBuffer: 0.005 },
      baseIn
    );
    const heavy = evaluatePolymarket5mFairValueArb(
      { ...baseCfg, minEdgeAfterCosts: 0.001, feeBuffer: 0.45, slippageBuffer: 0.45 },
      baseIn
    );
    expect(tight.recommendation).toBe("TRADE");
    expect(heavy.recommendation).toBe("NO_TRADE");
    expect(heavy.reason).toContain("FVA_MIN_EDGE");
  });
});
