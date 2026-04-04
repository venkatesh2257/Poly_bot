import { describe, expect, it, beforeEach } from "vitest";
import {
  ChainlinkPriceHistoryBuffer,
  computeOracleMicroTrendFromPrices,
  evaluateOracleTrendBufferGate,
  getChainlinkPriceHistoryBuffer,
  getChainlinkPriceHistoryBufferForAsset,
  getOracleAgeMsForTrend,
  resetChainlinkPriceBuffersForTests
} from "../src/realtime.js";

const MIN = 3;
const MAX_AGE = 10_000;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  resetChainlinkPriceBuffersForTests();
});

describe("per-asset ChainlinkPriceHistoryBuffer", () => {
  it("returns isolated history per asset (ETH does not read BTC samples)", () => {
    getChainlinkPriceHistoryBufferForAsset("BTC").push(100, NOW - 3000);
    getChainlinkPriceHistoryBufferForAsset("BTC").push(101, NOW - 2000);
    getChainlinkPriceHistoryBufferForAsset("BTC").push(102, NOW - 1000);

    getChainlinkPriceHistoryBufferForAsset("ETH").push(2000, NOW - 3000);
    getChainlinkPriceHistoryBufferForAsset("ETH").push(2010, NOW - 2000);
    getChainlinkPriceHistoryBufferForAsset("ETH").push(2020, NOW - 1000);

    const btc = getChainlinkPriceHistoryBufferForAsset("BTC").snapshot();
    const eth = getChainlinkPriceHistoryBufferForAsset("ETH").snapshot();
    expect(btc).toEqual([100, 101, 102]);
    expect(eth).toEqual([2000, 2010, 2020]);
  });

  it("getChainlinkPriceHistoryBuffer() aliases BTC buffer (Anchor compatibility)", () => {
    getChainlinkPriceHistoryBuffer().push(50, NOW);
    expect(getChainlinkPriceHistoryBufferForAsset("BTC").snapshot()).toEqual([50]);
    expect(getChainlinkPriceHistoryBuffer().snapshot()).toEqual([50]);
  });

  it("lastTimestampMs returns newest push time", () => {
    const b = new ChainlinkPriceHistoryBuffer(10);
    expect(b.lastTimestampMs()).toBeNull();
    b.push(1, 100);
    b.push(2, 200);
    expect(b.lastTimestampMs()).toBe(200);
  });
});

describe("evaluateOracleTrendBufferGate", () => {
  it("insufficient samples => insufficient (not ok)", () => {
    const buf = new ChainlinkPriceHistoryBuffer(10);
    buf.push(1, NOW - 2000);
    buf.push(1.01, NOW - 1000);
    const r = evaluateOracleTrendBufferGate(buf, NOW, MIN, MAX_AGE);
    expect(r).toEqual({ kind: "insufficient", samples: 2, min: 3 });
  });

  it("stale last sample => stale", () => {
    const buf = new ChainlinkPriceHistoryBuffer(10);
    buf.push(1, NOW - 50_000);
    buf.push(1.01, NOW - 40_000);
    buf.push(1.02, NOW - 15_000);
    const r = evaluateOracleTrendBufferGate(buf, NOW, MIN, MAX_AGE);
    expect(r.kind).toBe("stale");
    if (r.kind === "stale") {
      expect(r.ageMs).toBe(15_000);
      expect(r.max).toBe(MAX_AGE);
    }
  });

  it("fresh buffer with 3 rising prices => ok UP", () => {
    const buf = new ChainlinkPriceHistoryBuffer(10);
    buf.push(1, NOW - 3000);
    buf.push(1.01, NOW - 2000);
    buf.push(1.02, NOW - 1000);
    const r = evaluateOracleTrendBufferGate(buf, NOW, MIN, MAX_AGE);
    expect(r).toEqual({ kind: "ok", trend: "UP" });
  });

  it("fresh buffer with 3 falling prices => ok DOWN", () => {
    const buf = new ChainlinkPriceHistoryBuffer(10);
    buf.push(1.02, NOW - 3000);
    buf.push(1.01, NOW - 2000);
    buf.push(1, NOW - 1000);
    const r = evaluateOracleTrendBufferGate(buf, NOW, MIN, MAX_AGE);
    expect(r).toEqual({ kind: "ok", trend: "DOWN" });
  });
});

describe("computeOracleMicroTrendFromPrices", () => {
  it("returns null when fewer than 2 prices", () => {
    expect(computeOracleMicroTrendFromPrices([1])).toBeNull();
    expect(computeOracleMicroTrendFromPrices([])).toBeNull();
  });
});

describe("getOracleAgeMsForTrend", () => {
  it("returns min of chainlink and RTDS ages when both present", () => {
    expect(getOracleAgeMsForTrend(32_000, 2000)).toBe(2000);
  });

  it("uses chainlink when RTDS missing", () => {
    expect(getOracleAgeMsForTrend(32_000, null)).toBe(32_000);
  });

  it("uses RTDS when chainlink missing", () => {
    expect(getOracleAgeMsForTrend(null, 1500)).toBe(1500);
  });

  it("returns null when both missing", () => {
    expect(getOracleAgeMsForTrend(null, null)).toBeNull();
    expect(getOracleAgeMsForTrend(undefined, undefined)).toBeNull();
  });
});

/** Mirrors engine auto-trade skip when gate is ok but choice.direction !== oracleTrend. */
describe("DIRECTION_MISMATCH rule", () => {
  it("skips when direction differs from known oracle trend", () => {
    const wouldSkipDirectionMismatch = (dir: "UP" | "DOWN", trend: "UP" | "DOWN") => dir !== trend;
    expect(wouldSkipDirectionMismatch("UP", "DOWN")).toBe(true);
    expect(wouldSkipDirectionMismatch("DOWN", "UP")).toBe(true);
    expect(wouldSkipDirectionMismatch("UP", "UP")).toBe(false);
  });
});
