import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateOracleWindowMinTrendGate,
  freshOracleWindowState,
  loadOracleGateEnv,
  type OracleWindowState
} from "../src/services/oracleWindowGate.js";

describe("anchor primary path vs generic oracle window min-trend gate", () => {
  it("FLAT window state fails evaluateOracleWindowMinTrendGate (momentum still uses this gate)", () => {
    const env = loadOracleGateEnv();
    const base = freshOracleWindowState(1_700_000_000, 100_000, Date.now());
    const flat: OracleWindowState = {
      ...base,
      strikePrice: 100_000,
      trend: "FLAT",
      trendDeltaBps: 1.3
    };
    const r = evaluateOracleWindowMinTrendGate("BTC", flat, env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WINDOW_ORACLE_FLAT");
  });

  it("engine anchor branch does not call evaluateOracleWindowMinTrendGate before maybeRunAnchorStrategy", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const enginePath = path.join(dir, "../src/services/engine.ts");
    const src = readFileSync(enginePath, "utf8");
    const anchorIdx = src.indexOf("if (isAnchor)");
    const anchorEnd = src.indexOf('if (strategy === "market_making")', anchorIdx);
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    expect(anchorEnd).toBeGreaterThan(anchorIdx);
    const anchorBlock = src.slice(anchorIdx, anchorEnd);
    expect(anchorBlock).not.toContain("evaluateOracleWindowMinTrendGate");
    expect(anchorBlock).toContain("maybeRunAnchorStrategy");
  });
});
