import { describe, expect, it } from "vitest";
import { resolveBtcUpdownWinnerFromMarketData } from "./market-engine.js";

describe("resolveBtcUpdownWinnerFromMarketData", () => {
  it("maps winner by label when Gamma lists Up first", () => {
    expect(resolveBtcUpdownWinnerFromMarketData(["Up", "Down"], ["1", "0"])).toBe("Up");
    expect(resolveBtcUpdownWinnerFromMarketData(["Up", "Down"], ["0", "1"])).toBe("Down");
  });

  it("maps winner by label when outcomes are reversed (Down, Up)", () => {
    expect(resolveBtcUpdownWinnerFromMarketData(["Down", "Up"], ["0", "1"])).toBe("Up");
    expect(resolveBtcUpdownWinnerFromMarketData(["Down", "Up"], ["1", "0"])).toBe("Down");
  });

  it("returns pending when not resolved", () => {
    expect(resolveBtcUpdownWinnerFromMarketData(["Up", "Down"], ["0.5", "0.5"])).toBe("pending");
  });

  it("returns null when resolution is ambiguous", () => {
    expect(resolveBtcUpdownWinnerFromMarketData(["Up", "Down"], ["1", "1"])).toBe(null);
  });

  it("returns null when winning label is not Up/Down", () => {
    expect(resolveBtcUpdownWinnerFromMarketData(["Yes", "No"], ["1", "0"])).toBe(null);
  });
});
