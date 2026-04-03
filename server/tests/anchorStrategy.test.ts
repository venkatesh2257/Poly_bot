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
});
