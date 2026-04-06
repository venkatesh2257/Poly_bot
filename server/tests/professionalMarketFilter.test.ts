import { describe, expect, it } from "vitest";
import { shouldSkipMarket, anchorChopCount } from "../src/strategies/professionalTrader/marketFilter.js";
import type { OhlcCandle } from "../src/strategies/professionalTrader/professionalTypes.js";

function c(
  open: number,
  high: number,
  low: number,
  close: number,
  t = 0
): OhlcCandle {
  return { tOpenMs: t, open, high, low, close };
}

describe("shouldSkipMarket", () => {
  it("skips when fewer than 5 candles", () => {
    const r = shouldSkipMarket({
      candles: [c(1, 1, 1, 1), c(1, 1, 1, 1), c(1, 1, 1, 1), c(1, 1, 1, 1)],
      imbalanceFlipsLast10: 0,
      anchorUsd: 100
    });
    expect(r.skip).toBe(true);
  });

  it("skips on book flip count >= 3", () => {
    const candles = [c(1, 1.1, 0.9, 1.02, 1), c(1.02, 1.03, 1.01, 1.04, 2), c(1.04, 1.05, 1.03, 1.06, 3), c(1.06, 1.07, 1.05, 1.08, 4), c(1.08, 1.09, 1.07, 1.1, 5)];
    const r = shouldSkipMarket({
      candles,
      imbalanceFlipsLast10: 3,
      anchorUsd: 100
    });
    expect(r.skip).toBe(true);
    expect(r.reason).toContain("book_flip");
  });

  it("allows clean trending structure with low flips", () => {
    const candles = [
      c(100, 100.5, 99.8, 100.2, 1),
      c(100.2, 100.8, 100.0, 100.6, 2),
      c(100.6, 101.0, 100.4, 100.9, 3),
      c(100.9, 101.2, 100.7, 101.1, 4),
      c(101.1, 101.5, 100.9, 101.4, 5)
    ];
    const r = shouldSkipMarket({
      candles,
      imbalanceFlipsLast10: 0,
      anchorUsd: 90
    });
    expect(r.skip).toBe(false);
  });
});

describe("anchorChopCount", () => {
  it("counts sign changes of close vs anchor", () => {
    const candles = [
      c(100, 101, 99, 98, 1),
      c(98, 99, 97, 102, 2),
      c(102, 103, 101, 97, 3)
    ];
    expect(anchorChopCount(candles, 100)).toBeGreaterThanOrEqual(1);
  });
});
