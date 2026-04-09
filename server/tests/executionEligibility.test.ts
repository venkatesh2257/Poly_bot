import { describe, expect, it } from "vitest";
import { computeExecutionEligibility } from "../src/services/executionEligibility.js";
import { computeAnchorReadinessSnapshot } from "../src/services/anchorReadiness.js";

const liveOk = {
  dryRunEnv: false,
  walletMode: "LIVE" as const,
  canExecuteLiveOrders: true,
  anchorLiveExecutorEnvOk: true
};

describe("computeExecutionEligibility", () => {
  it("selective_momentum + SM_ENABLED=false => not eligible, blocked PM5M", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "selective_momentum",
      anchorEnvEnabled: false,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    const r = computeExecutionEligibility({
      entryStrategyEffective: "selective_momentum",
      mode: "SIMULATION",
      dryRunEnv: false,
      anchorReadiness: anchor,
      smEnabled: false,
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    expect(r.selectedEligible).toBe(false);
    expect(r.blockedReasons.some((b) => b.includes("SM_ENABLED"))).toBe(true);
    expect(r.eligibleStrategies.length).toBe(0);
  });

  it("anchor + env enabled + LIVE + no live executor => not eligible", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: false
    });
    const r = computeExecutionEligibility({
      entryStrategyEffective: "anchor",
      mode: "LIVE",
      dryRunEnv: false,
      anchorReadiness: anchor,
      smEnabled: true,
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: false
    });
    expect(r.selectedEligible).toBe(false);
    expect(r.primaryBlockedReason).toBeDefined();
    expect(r.blockedReasons.some((b) => b.includes("Anchor live executor"))).toBe(true);
  });

  it("momentum LIVE + canExecuteLiveOrders => eligible", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "momentum",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    const r = computeExecutionEligibility({
      entryStrategyEffective: "momentum",
      mode: "LIVE",
      dryRunEnv: false,
      anchorReadiness: anchor,
      smEnabled: false,
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    expect(r.selectedEligible).toBe(true);
    expect(r.eligibleStrategies).toContain("momentum");
    expect(r.primaryBlockedReason).toBeUndefined();
  });

  it("anchor + ANCHOR env + LIVE + executor => selectedEligible true and stable primary reason absent", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    const r = computeExecutionEligibility({
      entryStrategyEffective: "anchor",
      mode: "LIVE",
      dryRunEnv: false,
      anchorReadiness: anchor,
      smEnabled: true,
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    expect(r.selectedEligible).toBe(true);
    expect(r.eligibleStrategies).toContain("anchor");
    expect(r.blockedReasons).toHaveLength(0);
    expect(r.primaryBlockedReason).toBeUndefined();
  });
});
