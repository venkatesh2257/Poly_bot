import { describe, expect, it } from "vitest";
import {
  anchorEntryPreflight,
  evaluateAnchorStrategy,
  type AnchorStrategyConfig,
  type OrderBookSnapshot
} from "../src/strategies/anchorStrategy.js";

const baseCfg = (): AnchorStrategyConfig => ({
  enabled: true,
  stabilityTicks: 3,
  upBidDepthShareMin: 0.7,
  downBidDepthShareMax: 0.3,
  chainlinkMomThreshold: 0.0003,
  chainlinkMomReverseThreshold: -0.0005,
  anchorPriceMin: 0.4,
  anchorPriceMax: 0.65,
  tradeSize: 1,
  exitBufferSeconds: 30,
  maxYesMid: 0.7,
  minSecondsToExpiry: 60,
  maxOracleAgeMs: 15_000,
  momentumLookbackPrices: 4,
  anchorDebugLogs: false
});

/** bid/(bid+ask) = share */
function bookUp(imb: number): OrderBookSnapshot {
  const bid = imb * 100;
  const ask = (1 - imb) * 100;
  return { bidDepthUp: bid, askDepthUp: ask, bidDepthDown: 50, askDepthDown: 50 };
}

function bookDown(imb: number): OrderBookSnapshot {
  const bid = imb * 100;
  const ask = (1 - imb) * 100;
  return { bidDepthUp: 50, askDepthUp: 50, bidDepthDown: bid, askDepthDown: ask };
}

describe("evaluateAnchorStrategy", () => {
  const freshOracle = 2000;

  it("imbalance 0.75 (3 ticks) + mom +0.04% + YES 0.52 → UP trade", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.52,
      0.48,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(true);
    expect(sig.side).toBe("UP");
  });

  it("only 2 stable ticks → shouldTrade false (stability)", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.52,
      0.48,
      [0.75, 0.75],
      [0.5, 0.5],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("STABILITY_NOT_MET");
    expect(sig.reason.toLowerCase()).toContain("stability");
  });

  it("3 ticks UP + wrong chainlink direction → false", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 99.96];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.52,
      0.48,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("MOMENTUM_MISMATCH");
  });

  it("YES 0.80 → rejected by anchor gate (maxYesMid)", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.8,
      0.2,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("YES_MID_TOO_HIGH");
  });

  it("DOWN pattern: low DOWN bid-share x3 + mom -0.04% + NO 0.52 → DOWN trade", () => {
    const ob = bookDown(0.25);
    const hist = [100, 100, 100, 99.96];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.48,
      0.52,
      [0.5, 0.5, 0.5],
      [0.25, 0.25, 0.25],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(true);
    expect(sig.side).toBe("DOWN");
    expect(sig.downBidDepthShare).toBeCloseTo(0.25, 5);
  });

  it("DOWN semantics: higher downBidDepthShare (0.6) must NOT satisfy DOWN entry (needs ask-heavy, not buy DOWN)", () => {
    const ob = bookDown(0.6);
    const hist = [100, 100, 100, 99.96];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.4,
      0.6,
      [0.5, 0.5, 0.5],
      [0.6, 0.6, 0.6],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("STABILITY_NOT_MET");
  });

  it("invalid anchor YES price outside [0,1] returns no trade", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      1.2,
      0.48,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      baseCfg(),
      freshOracle
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INVALID_ANCHOR_PRICE");
  });

  it("invalid order book (zero depth) returns no trade", () => {
    const ob: OrderBookSnapshot = { bidDepthUp: 0, askDepthUp: 0, bidDepthDown: 50, askDepthDown: 50 };
    const hist = [100, 100, 100, 100.01];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INVALID_ORDERBOOK");
  });

  it("insufficient chainlink samples returns no trade", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INSUFFICIENT_HISTORY");
  });

  it("stale oracle age from engine feed returns no trade", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.52,
      0.48,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      baseCfg(),
      60_000
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("ORACLE_STALE");
  });

  it("stale buffer timestamp returns no trade when timestamps provided", () => {
    const cfg = baseCfg();
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const old = Date.now() - 120_000;
    const ts = [old, old, old, old];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.52,
      0.48,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      cfg,
      1000,
      ts
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("ORACLE_STALE");
  });
});

describe("evaluateAnchorStrategy edge cases", () => {
  const freshOracle = 2000;

  it("NaN anchor YES price returns INVALID_ANCHOR_PRICE", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, NaN, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INVALID_ANCHOR_PRICE");
  });

  it("negative anchor YES price returns INVALID_ANCHOR_PRICE", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, -0.1, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INVALID_ANCHOR_PRICE");
  });

  it("NaN in order book depths returns INVALID_ORDERBOOK", () => {
    const ob: OrderBookSnapshot = { bidDepthUp: NaN, askDepthUp: 50, bidDepthDown: 50, askDepthDown: 50 };
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INVALID_ORDERBOOK");
  });

  it("negative depths return INVALID_ORDERBOOK", () => {
    const ob: OrderBookSnapshot = { bidDepthUp: -10, askDepthUp: 50, bidDepthDown: 50, askDepthDown: 50 };
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("INVALID_ORDERBOOK");
  });

  it("flat momentum history (zero mom) fails UP with MOMENTUM_MISMATCH", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("MOMENTUM_MISMATCH");
  });

  it("non-finite oracle age is ignored for ORACLE_STALE (null path)", () => {
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], baseCfg(), NaN);
    expect(sig.shouldTrade).toBe(true);
    expect(sig.side).toBe("UP");
  });

  it("maxYesMid boundary: exactly at max passes YES gate when anchor range allows", () => {
    const cfg = { ...baseCfg(), maxYesMid: 0.65, anchorPriceMax: 0.65 };
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, cfg.maxYesMid, 1 - cfg.maxYesMid, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], cfg, freshOracle);
    expect(sig.shouldTrade).toBe(true);
    expect(sig.side).toBe("UP");
  });

  it("maxYesMid: epsilon above max rejects with YES_MID_TOO_HIGH", () => {
    const cfg = baseCfg();
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      cfg.maxYesMid + 1e-6,
      0.2,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      cfg,
      freshOracle
    );
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("YES_MID_TOO_HIGH");
  });

  it("upBidDepthShareMin boundary: exactly at threshold fails UP stability (needs strictly greater)", () => {
    const cfg = { ...baseCfg(), upBidDepthShareMin: 0.7 };
    const ob = bookUp(0.7);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.7, 0.7, 0.7], [0.5, 0.5, 0.5], cfg, freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("STABILITY_NOT_MET");
  });

  it("downBidDepthShareMax boundary: exactly at threshold fails DOWN stability (needs strictly less)", () => {
    const cfg = { ...baseCfg(), downBidDepthShareMax: 0.3 };
    const ob = bookDown(0.3);
    const hist = [100, 100, 100, 99.96];
    const sig = evaluateAnchorStrategy(ob, hist, 0.48, 0.52, [0.5, 0.5, 0.5], [0.3, 0.3, 0.3], cfg, freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("STABILITY_NOT_MET");
  });

  it("chainlinkMomThreshold: UP rejects when mom is at or below threshold (strict >)", () => {
    const cfg = { ...baseCfg(), chainlinkMomThreshold: 0.000401 };
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const sig = evaluateAnchorStrategy(ob, hist, 0.52, 0.48, [0.75, 0.75, 0.75], [0.5, 0.5, 0.5], cfg, freshOracle);
    expect(sig.shouldTrade).toBe(false);
    expect(sig.skipCategory).toBe("MOMENTUM_MISMATCH");
  });

  it("mismatched history vs timestamps length still evaluates (uses last timestamp only)", () => {
    const cfg = baseCfg();
    const ob = bookUp(0.75);
    const hist = [100, 100, 100, 100.04];
    const tsShort = [Date.now() - 1000];
    const sig = evaluateAnchorStrategy(
      ob,
      hist,
      0.52,
      0.48,
      [0.75, 0.75, 0.75],
      [0.5, 0.5, 0.5],
      cfg,
      freshOracle,
      tsShort
    );
    expect(sig.shouldTrade).toBe(true);
  });
});

describe("anchorEntryPreflight", () => {
  it("does not allow entry when another strategy already claimed the window", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: true
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.category).toBe("WINDOW_ALREADY_CLAIMED");
      expect(r.reason).toMatch(/window/i);
    }
  });

  it("allows entry when window not claimed and gates pass", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(true);
  });

  it("blocks when env disabled", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: false,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("DISABLED");
  });

  it("blocks when runtime disabled", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: false,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("DISABLED");
  });

  it("blocks when lag snipe enabled", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: true,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("LAG_SNIPE_BLOCK");
  });

  it("blocks when no live market data", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: false,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("NO_LIVE_BOOK");
  });

  it("blocks when no directional context", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: false,
      secondsToExpiry: 120,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("NO_LIVE_BOOK");
  });

  it("blocks when pending trade exists", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: 120,
      hasPendingTrade: true,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("PENDING_TRADE_BLOCK");
  });

  it("blocks when secondsToExpiry at minSecondsToExpiry boundary", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: cfg.minSecondsToExpiry,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe("LAST_60S_BLOCK");
  });

  it("allows when secondsToExpiry one second above minimum", () => {
    const cfg = baseCfg();
    const r = anchorEntryPreflight({
      cfg,
      envEnabled: true,
      runtimeEnabled: true,
      lagSnipeEnabled: false,
      hasLiveMarketData: true,
      hasDirectionalContext: true,
      secondsToExpiry: cfg.minSecondsToExpiry + 1,
      hasPendingTrade: false,
      anchorTradedThisWindow: false
    });
    expect(r.ok).toBe(true);
  });
});
