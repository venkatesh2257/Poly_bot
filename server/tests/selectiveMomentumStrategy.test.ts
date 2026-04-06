import { describe, expect, it } from "vitest";
import { evaluatePolymarket5mSelectiveMomentum } from "../src/services/selectiveMomentumStrategy.js";

describe("selectiveMomentumStrategy (Polymarket crypto ~5m)", () => {
  const cfg = {
    enabled: true,
    minImpulse: 0.01,
    persistenceTicks: 3,
    maxOutcomeSpread: 0.2,
    requireBookConfirm: true,
    minSecRemainingToExpiry: 10,
    maxSecRemainingToExpiry: 400,
    maxYesTokenAsk: 0.85
  };

  const books = {
    yesUpOutcome: { mid: 0.5, spread: 0.04, bestBid: 0.48, bestAsk: 0.52 },
    yesDownOutcome: { mid: 0.5, spread: 0.04, bestBid: 0.48, bestAsk: 0.52 }
  };

  const baseIn = {
    isPolymarketCryptoUpDown5m: true,
    momentumScalar: 0.05,
    recentScalars: [0.04, 0.045],
    ...books,
    chosenYesTokenAsk: 0.52,
    chosenYesTokenBid: 0.48,
    secToGammaExpiry: 100
  };

  it("NO_TRADE when not Polymarket crypto ~5m window", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(cfg, {
      ...baseIn,
      isPolymarketCryptoUpDown5m: false
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("not a Polymarket crypto");
  });

  it("NO_TRADE when impulse too low", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(cfg, {
      ...baseIn,
      momentumScalar: 0.001
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("impulse");
  });

  it("NO_TRADE when persistence insufficient", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(cfg, {
      ...baseIn,
      recentScalars: [0.01]
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("samples");
  });

  it("NO_TRADE when too close to Gamma expiry (TTE below min)", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(
      { ...cfg, minSecRemainingToExpiry: 45 },
      { ...baseIn, secToGammaExpiry: 20 }
    );
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("SM_PM5M_MIN_SEC_REMAINING");
    expect(r.reason).toContain("too close to Gamma expiry");
  });

  it("NO_TRADE when too early in window (TTE above max remaining)", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(
      { ...cfg, minSecRemainingToExpiry: 10, maxSecRemainingToExpiry: 240 },
      { ...baseIn, secToGammaExpiry: 280 }
    );
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("SM_PM5M_MAX_SEC_REMAINING");
    expect(r.reason).toContain("too early in window");
  });

  it("NO_TRADE when executable ask too high (overpay guard)", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(
      { ...cfg, maxYesTokenAsk: 0.5 },
      { ...baseIn, chosenYesTokenAsk: 0.52 }
    );
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("SM_PM5M_MAX_YES_ASK");
  });

  it("NO_TRADE when chosen side book crossed (executable sanity)", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(cfg, {
      ...baseIn,
      chosenYesTokenAsk: 0.45,
      chosenYesTokenBid: 0.48
    });
    expect(r.recommendation).toBe("NO_TRADE");
    expect(r.reason).toContain("crossed");
  });

  it("TRADE when impulse, persistence, YES-token book, TTE, ask pass", () => {
    const r = evaluatePolymarket5mSelectiveMomentum(cfg, baseIn);
    expect(r.recommendation).toBe("TRADE");
    expect(r.prediction).toBe("UP");
    expect(r.reason).toMatch(/^SM\[PM5m\]:/);
  });
});
