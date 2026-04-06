import { describe, expect, it } from "vitest";
import {
  evaluatePolymarket5mMarketMaking,
  loadPolymarket5mMarketMakingConfigFromEnv
} from "../src/services/marketMakingStrategy.js";

const baseYesBooks = {
  yesUpOutcome: { bestBid: 0.4, bestAsk: 0.46, spread: 0.06, depthLiquidity: 1000 },
  yesDownOutcome: { bestBid: 0.54, bestAsk: 0.6, spread: 0.06, depthLiquidity: 1000 }
};

const basePm5m = {
  isPolymarketCryptoUpDown5m: true,
  gammaWindowKey: "btc-updown-5m|123",
  secToGammaExpiry: 120,
  secSinceWindowOpen: 60,
  ...baseYesBooks,
  inventoryYesUpUsd: 10,
  inventoryYesDownUsd: 10,
  isLive: false
};

describe("marketMakingStrategy (Polymarket crypto ~5m)", () => {
  it("loadPolymarket5mMarketMakingConfigFromEnv returns finite numeric fields", () => {
    const cfg = loadPolymarket5mMarketMakingConfigFromEnv();
    expect(Number.isFinite(cfg.minOutcomeSpread)).toBe(true);
    expect(cfg.repriceMinMs).toBeGreaterThan(0);
  });

  it("returns NO_TRADE when disabled", () => {
    const cfg = {
      enabled: false,
      liveMakerEnabled: false,
      minOutcomeSpread: 0.02,
      minLiquidityPerOutcome: 80,
      maxInventorySkewUsd: 500,
      maxTotalNotionalUsdPerGammaWindow: 250,
      repriceMinMs: 2000,
      stopQuoteSecBeforeExpiry: 45,
      minSecAfterWindowOpen: 0,
      maxPerOutcomeNotionalUsd: 0
    };
    const r = evaluatePolymarket5mMarketMaking(cfg, basePm5m);
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("disabled");
  });

  it("returns NO_TRADE when not a Polymarket crypto ~5m window", () => {
    const cfg = {
      enabled: true,
      liveMakerEnabled: false,
      minOutcomeSpread: 0.02,
      minLiquidityPerOutcome: 80,
      maxInventorySkewUsd: 500,
      maxTotalNotionalUsdPerGammaWindow: 250,
      repriceMinMs: 2000,
      stopQuoteSecBeforeExpiry: 45,
      minSecAfterWindowOpen: 0,
      maxPerOutcomeNotionalUsd: 0
    };
    const r = evaluatePolymarket5mMarketMaking(cfg, { ...basePm5m, isPolymarketCryptoUpDown5m: false });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.quoteNote).toBe("not_pm5m");
  });

  it("stops quoting near Gamma expiry (expiry gating)", () => {
    const cfg = {
      enabled: true,
      liveMakerEnabled: false,
      minOutcomeSpread: 0.02,
      minLiquidityPerOutcome: 80,
      maxInventorySkewUsd: 500,
      maxTotalNotionalUsdPerGammaWindow: 250,
      repriceMinMs: 2000,
      stopQuoteSecBeforeExpiry: 45,
      minSecAfterWindowOpen: 0,
      maxPerOutcomeNotionalUsd: 0
    };
    const r = evaluatePolymarket5mMarketMaking(cfg, { ...basePm5m, secToGammaExpiry: 30 });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.quoteNote).toBe("near_expiry");
    expect(r.reason).toContain("MM[PM5m]");
  });

  it("enforces per-window YES-token inventory skew", () => {
    const cfg = {
      enabled: true,
      liveMakerEnabled: false,
      minOutcomeSpread: 0.02,
      minLiquidityPerOutcome: 80,
      maxInventorySkewUsd: 50,
      maxTotalNotionalUsdPerGammaWindow: 250,
      repriceMinMs: 2000,
      stopQuoteSecBeforeExpiry: 45,
      minSecAfterWindowOpen: 0,
      maxPerOutcomeNotionalUsd: 0
    };
    const r = evaluatePolymarket5mMarketMaking(cfg, {
      ...basePm5m,
      inventoryYesUpUsd: 0,
      inventoryYesDownUsd: 200
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.quoteNote).toBe("skew");
  });

  it("returns TRADE in SIM when gates pass (YES-token spread/depth)", () => {
    const cfg = {
      enabled: true,
      liveMakerEnabled: false,
      minOutcomeSpread: 0.02,
      minLiquidityPerOutcome: 80,
      maxInventorySkewUsd: 500,
      maxTotalNotionalUsdPerGammaWindow: 250,
      repriceMinMs: 2000,
      stopQuoteSecBeforeExpiry: 45,
      minSecAfterWindowOpen: 0,
      maxPerOutcomeNotionalUsd: 0
    };
    const r = evaluatePolymarket5mMarketMaking(cfg, basePm5m);
    expect(r.recommendation).toBe("TRADE");
    expect(r.quoteNote).toBe("quote_ok");
    expect(r.reason).toContain("MM[PM5m]");
  });

  it("blocks LIVE when MM_LIVE_ENABLED false (maker lifecycle incomplete)", () => {
    const cfg = {
      enabled: true,
      liveMakerEnabled: false,
      minOutcomeSpread: 0.02,
      minLiquidityPerOutcome: 80,
      maxInventorySkewUsd: 500,
      maxTotalNotionalUsdPerGammaWindow: 250,
      repriceMinMs: 2000,
      stopQuoteSecBeforeExpiry: 45,
      minSecAfterWindowOpen: 0,
      maxPerOutcomeNotionalUsd: 0
    };
    const r = evaluatePolymarket5mMarketMaking(cfg, { ...basePm5m, isLive: true });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.quoteNote).toBe("live_disabled");
    expect(r.reason).toContain("CLOB");
  });
});
