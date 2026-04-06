import { describe, expect, it } from "vitest";
import { resolveDashboardChartMode, resolveDashboardOrderbookSource } from "../src/services/marketDataProvider.js";

describe("marketDataProvider", () => {
  it("resolveDashboardOrderbookSource prefers native when synthesis off", () => {
    expect(
      resolveDashboardOrderbookSource({
        synthesisEnabled: false,
        dashboardPreferred: true,
        synthesisStale: false,
        synthesisHasBooks: true
      })
    ).toBe("native_polymarket");
  });

  it("resolveDashboardOrderbookSource falls back when stale", () => {
    expect(
      resolveDashboardOrderbookSource({
        synthesisEnabled: true,
        dashboardPreferred: true,
        synthesisStale: true,
        synthesisHasBooks: true
      })
    ).toBe("synthesis_stale_fallback_native");
  });

  it("resolveDashboardChartMode is native_only without prices", () => {
    expect(
      resolveDashboardChartMode({
        synthesisEnabled: true,
        synthesisHasPrices: false
      })
    ).toBe("native_only");
  });
});
