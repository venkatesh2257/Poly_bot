import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("execution truth + telemetry wiring", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const enginePath = path.join(dir, "../src/services/engine.ts");
  const src = readFileSync(enginePath, "utf8");

  it("exposes execution truth and session telemetry in status/trading-state snapshots", () => {
    expect(src).toContain("private executionTruth =");
    expect(src).toContain("private executionTruthSnapshot()");
    expect(src).toContain("private sessionTelemetrySnapshot()");
    expect(src).toContain("executionTruth: this.executionTruthSnapshot()");
    expect(src).toContain("sessionTelemetry: this.sessionTelemetrySnapshot()");
  });

  it("tracks operator-level readiness and blockers", () => {
    expect(src).toContain("[START][READINESS]");
    expect(src).toContain("markExecutionBlocked(");
    expect(src).toContain("bumpSessionCount(this.executionBlockCounts");
  });

  it("captures conditionId on trade entry and auto-reclaims live winners", () => {
    expect(src).toContain("conditionId: this.wallet.getDiscoveredMeta()?.conditionId");
    expect(src).toContain(".redeemWinningPosition(t.conditionId)");
    expect(src).toContain("AUTO_RECLAIM");
  });
});
