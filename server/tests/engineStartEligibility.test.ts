import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeExecutionEligibility } from "../src/services/executionEligibility.js";
import { computeAnchorReadinessSnapshot } from "../src/services/anchorReadiness.js";

describe("engine start() execution truthfulness", () => {
  it("uses getExecutionEligibilitySnapshot, START][EXECUTION], and conditional TRADE log", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const enginePath = path.join(dir, "../src/services/engine.ts");
    const src = readFileSync(enginePath, "utf8");
    expect(src).toContain("getExecutionEligibilitySnapshot");
    expect(src).toContain("[START][EXECUTION]");
    expect(src).toContain("WARNING: Bot started, but no execution-eligible auto-trading strategy is enabled");
    expect(src).toContain("Bot started (${selectedLabel} auto-trading enabled)");
    expect(src).toContain("selectedEligible");
    expect(src).toContain("BTC_5M_TRADE_RESULT");
  });

  it("anchor LIVE + ANCHOR_STRATEGY_ENABLED path yields selectedEligible=true (no startup WARNING class)", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    const ex = computeExecutionEligibility({
      entryStrategyEffective: "anchor",
      mode: "LIVE",
      dryRunEnv: false,
      anchorReadiness: anchor,
      smEnabled: true,
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    expect(ex.selectedEligible).toBe(true);
    expect(ex.blockedReasons).toHaveLength(0);
  });
});
