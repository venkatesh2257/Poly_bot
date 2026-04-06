import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("professional trader engine safeguards", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const enginePath = path.join(dir, "../src/services/engine.ts");
  const src = readFileSync(enginePath, "utf8");

  it("resets professional FSM when window rotates", () => {
    expect(src).toContain('if (this.effectiveEntryStrategy() === "professional_trader")');
    expect(src).toContain("this.professionalSpotSamples = [];");
    expect(src).toContain("this.professionalTradingFsm?.reset();");
  });

  it("clears pending-entry state if professional trade() throws", () => {
    expect(src).toContain("let result: Awaited<ReturnType<TradingEngine[\"trade\"]>>;");
    expect(src).toContain("result = await this.trade(decision.direction, sized, \"AUTO\", decision.reason);");
    expect(src).toContain("fsm.abortPendingEntry();");
    expect(src).toContain("throw e;");
  });
});
