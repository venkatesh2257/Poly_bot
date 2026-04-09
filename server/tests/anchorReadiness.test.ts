import { describe, expect, it } from "vitest";
import {
  computeAnchorReadinessSnapshot,
  computeLiveReadiness,
  tradingDiagnosticTokenToMessage
} from "../src/services/anchorReadiness.js";

const liveOk = {
  dryRunEnv: false,
  walletMode: "LIVE" as const,
  canExecuteLiveOrders: true,
  anchorLiveExecutorEnvOk: true
};

const execOk = { executionEligible: true, executionBlockedReasons: [] as string[] };

describe("computeAnchorReadinessSnapshot", () => {
  it("when anchor is fully available with fast lane off, cadence is normal and live execution is available in LIVE", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    expect(a.anchorTradingEnabled).toBe(true);
    expect(a.anchorCadence).toBe("normal");
    expect(a.anchorFastLaneEnabled).toBe(false);
    expect(a.anchorBlockReason).toBeNull();
    expect(a.anchorStatusSummary).toBe("Normal cadence only");
    expect(a.anchorDiagnostics.some((d) => d.includes("Fast-lane"))).toBe(true);
    expect(a.liveExecutionAvailable).toBe(true);
    expect(a.liveExecutionReason).toBeNull();
    expect(a.liveExecutionBanner.indicator).toBe("green");
  });

  it("when only fast lane is off but anchor is enabled, trading stays enabled", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    expect(a.anchorTradingEnabled).toBe(true);
    expect(a.anchorBlockReason).toBeNull();
  });

  it("ANCHOR_STRATEGY_ENABLED=false → anchorTradingEnabled=false, ANCHOR_DISABLED_BY_ENV", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: false,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    expect(a.anchorTradingEnabled).toBe(false);
    expect(a.anchorBlockReason).toBe("ANCHOR_DISABLED_BY_ENV");
    expect(a.anchorCadence).toBe("off");
    expect(a.liveExecutionAvailable).toBe(false);
    expect(a.liveExecutionReason).toBeNull();
    const lr = computeLiveReadiness({
      entryStrategyEffective: "anchor",
      anchor: a,
      marketDataBlockReason: null,
      executionEligible: false,
      executionBlockedReasons: ["Anchor disabled by config"]
    });
    expect(lr.level).toBe("partial");
    expect(lr.summary).toContain("Bot running, but no selected auto-trading strategy can place orders");
  });

  it("ANCHOR_STRATEGY_ENABLED=true + DRY_RUN=true → liveExecutionAvailable=false, DRY_RUN_MODE", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: true,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    expect(a.liveExecutionAvailable).toBe(false);
    expect(a.liveExecutionReason).toBe("DRY_RUN_MODE");
    expect(a.liveExecutionBanner.indicator).toBe("yellow");
  });

  it("ANCHOR_STRATEGY_ENABLED=true + DRY_RUN=false + live path ok → liveExecutionAvailable=true, liveReadiness full", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    expect(a.liveExecutionAvailable).toBe(true);
    const lr = computeLiveReadiness({
      entryStrategyEffective: "anchor",
      anchor: a,
      marketDataBlockReason: null,
      ...execOk
    });
    expect(lr.level).toBe("full");
    expect(lr.summary).toContain("Ready — live BTC");
  });

  it("when strategy is not anchor, cadence is off and summary reflects non-anchor", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "momentum",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: true,
      ...liveOk
    });
    expect(a.anchorCadence).toBe("off");
    expect(a.anchorTradingEnabled).toBe(false);
    expect(a.anchorStatusSummary).toContain("Not using anchor");
  });

  it("SIMULATION mode yields SIMULATION_MODE for live execution", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "SIMULATION",
      canExecuteLiveOrders: false,
      anchorLiveExecutorEnvOk: true
    });
    expect(a.liveExecutionAvailable).toBe(false);
    expect(a.liveExecutionReason).toBe("SIMULATION_MODE");
  });

  it("LIVE but cannot execute live orders → LIVE_EXECUTOR_MISSING", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "LIVE",
      canExecuteLiveOrders: false,
      anchorLiveExecutorEnvOk: true
    });
    expect(a.liveExecutionAvailable).toBe(false);
    expect(a.liveExecutionReason).toBe("LIVE_EXECUTOR_MISSING");
  });

  it("ANCHOR_LIVE_EXECUTOR_AVAILABLE=false → LIVE_EXECUTOR_DISABLED_BY_CONFIG", () => {
    const a = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: false
    });
    expect(a.liveExecutionReason).toBe("LIVE_EXECUTOR_DISABLED_BY_CONFIG");
  });
});

describe("computeLiveReadiness", () => {
  it("partial when anchor selected but env disables anchor", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: false,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: false,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    const lr = computeLiveReadiness({
      entryStrategyEffective: "anchor",
      anchor,
      marketDataBlockReason: null,
      executionEligible: false,
      executionBlockedReasons: ["Anchor disabled by config"]
    });
    expect(lr.level).toBe("partial");
    expect(lr.summary).toContain("Bot running, but no selected auto-trading strategy can place orders");
  });

  it("degraded when market data block is set", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      ...liveOk
    });
    const lr = computeLiveReadiness({
      entryStrategyEffective: "anchor",
      anchor,
      marketDataBlockReason: "no_discovered_slots",
      ...execOk
    });
    expect(lr.level).toBe("degraded");
  });

  it("partial summary mentions live execution when anchor enabled but dry-run", () => {
    const anchor = computeAnchorReadinessSnapshot({
      entryStrategyEffective: "anchor",
      anchorEnvEnabled: true,
      anchorRuntimeEnabled: true,
      anchorFastLaneEnv: false,
      dryRunEnv: true,
      walletMode: "LIVE",
      canExecuteLiveOrders: true,
      anchorLiveExecutorEnvOk: true
    });
    const lr = computeLiveReadiness({
      entryStrategyEffective: "anchor",
      anchor,
      marketDataBlockReason: null,
      executionEligible: false,
      executionBlockedReasons: ["Anchor trading disabled (DRY_RUN=true)"]
    });
    expect(lr.level).toBe("partial");
    expect(lr.summary).toContain("Bot running, but no selected auto-trading strategy can place orders");
  });
});

describe("tradingDiagnosticTokenToMessage", () => {
  it("maps known tokens to human text without raw token in output for standard keys", () => {
    expect(tradingDiagnosticTokenToMessage("discovery_disabled")).not.toMatch(/^discovery_disabled$/);
    expect(tradingDiagnosticTokenToMessage("discovery_disabled").length).toBeGreaterThan(12);
  });
});
