import type { Direction } from "../types/index.js";

export type OracleStrikeTrend = "UP" | "DOWN" | "FLAT" | "NA";

export type OracleWindowState = {
  windowSec: number;
  strikePrice: number | null;
  lastPrice: number | null;
  lastUpdateMs: number;
  lastSideAboveStrike: "UP" | "DOWN" | null;
  flipCountInWindow: number;
  consecutiveOppositeTicks: number;
  lastFlipMs: number | null;
  trend: OracleStrikeTrend;
  trendDeltaBps: number;
  lastDeltaBps: number;
};

export type OracleGateEnv = {
  softStaleMs: number;
  hardStaleMs: number;
  trendBps: number;
  flipDeadbandBps: number;
  flipBlockCount: number;
  oppositeTicksBlock: number;
  mismatchEarlyWindowMs: number;
  mismatchStrongBps: number;
  minWindowDeltaBps: number;
};

const ORACLE_CHAINLINK_ENTRY_ASSETS = new Set(["BTC", "ETH", "SOL", "XRP"]);

export function isOracleChainlinkEntryAsset(assetUpper: string): boolean {
  return ORACLE_CHAINLINK_ENTRY_ASSETS.has(assetUpper.trim().toUpperCase());
}

export function loadOracleGateEnv(): OracleGateEnv {
  const soft = (() => {
    const n = Number(process.env.ORACLE_SOFT_STALE_MS ?? 15_000);
    return Number.isFinite(n) && n >= 1000 ? n : 15_000;
  })();
  let hard = (() => {
    const n = Number(process.env.ORACLE_HARD_STALE_MS ?? 45_000);
    return Number.isFinite(n) && n >= 2000 ? n : 45_000;
  })();
  if (hard <= soft) hard = soft + 1000;
  const trendBps = (() => {
    const n = Number(process.env.ORACLE_TREND_BPS ?? 4);
    return Number.isFinite(n) && n > 0 ? n : 4;
  })();
  const flipDeadbandBps = (() => {
    const n = Number(process.env.ORACLE_FLIP_DEADBAND_BPS ?? 3);
    return Number.isFinite(n) && n >= 0 ? n : 3;
  })();
  const flipBlockCount = (() => {
    const n = Number(process.env.ORACLE_FLIP_BLOCK_COUNT ?? 1);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  })();
  const oppositeTicksBlock = (() => {
    const n = Number(process.env.ORACLE_OPPOSITE_TICKS_BLOCK ?? 2);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  })();
  const mismatchEarlyWindowMs = (() => {
    const n = Number(process.env.ORACLE_MISMATCH_EARLY_WINDOW_MS ?? 60_000);
    return Number.isFinite(n) && n >= 0 ? n : 60_000;
  })();
  const mismatchStrongBps = (() => {
    const n = Number(process.env.ORACLE_MISMATCH_STRONG_BPS ?? 8);
    return Number.isFinite(n) && n > 0 ? n : 8;
  })();
  const minWindowDeltaBps = (() => {
    const n = Number(process.env.MIN_WINDOW_DELTA_BPS ?? 4);
    return Number.isFinite(n) && n > 0 ? n : 4;
  })();
  return {
    softStaleMs: soft,
    hardStaleMs: hard,
    trendBps,
    flipDeadbandBps,
    flipBlockCount,
    oppositeTicksBlock,
    mismatchEarlyWindowMs,
    mismatchStrongBps,
    minWindowDeltaBps
  };
}

export function freshOracleWindowState(
  windowSec: number,
  strikePrice: number | null,
  nowMs: number
): OracleWindowState {
  return {
    windowSec,
    strikePrice,
    lastPrice: null,
    lastUpdateMs: nowMs,
    lastSideAboveStrike: null,
    flipCountInWindow: 0,
    consecutiveOppositeTicks: 0,
    lastFlipMs: null,
    trend: "NA",
    trendDeltaBps: 0,
    lastDeltaBps: 0
  };
}

/** Trend vs 5m window strike/open; delta in basis points. */
export function computeTrendFromStrike(
  price: number,
  strike: number,
  trendBps: number
): { trend: OracleStrikeTrend; deltaBps: number } {
  if (!Number.isFinite(price) || !Number.isFinite(strike) || strike <= 0) {
    return { trend: "NA", deltaBps: 0 };
  }
  const deltaBps = ((price - strike) / strike) * 10_000;
  if (!Number.isFinite(deltaBps)) return { trend: "NA", deltaBps: 0 };
  if (deltaBps >= trendBps) return { trend: "UP", deltaBps };
  if (deltaBps <= -trendBps) return { trend: "DOWN", deltaBps };
  return { trend: "FLAT", deltaBps };
}

function sideFromDeadband(deltaBps: number, deadBps: number): "UP" | "DOWN" | null {
  if (deltaBps > deadBps) return "UP";
  if (deltaBps < -deadBps) return "DOWN";
  return null;
}

export function updateOracleWindowStateFromChainlink(
  prev: OracleWindowState,
  price: number,
  nowMs: number,
  env: OracleGateEnv
): OracleWindowState {
  const strike = prev.strikePrice;
  const { trend, deltaBps } = computeTrendFromStrike(price, strike ?? NaN, env.trendBps);
  const effectiveTrend: OracleStrikeTrend = strike == null || !Number.isFinite(strike) || strike <= 0 ? "NA" : trend;

  const side = strike != null && Number.isFinite(strike) && strike > 0 ? sideFromDeadband(deltaBps, env.flipDeadbandBps) : null;

  let flipCount = prev.flipCountInWindow;
  let lastFlipMs = prev.lastFlipMs;
  let lastSide = prev.lastSideAboveStrike;

  if (side != null && lastSide != null && side !== lastSide) {
    flipCount += 1;
    lastFlipMs = nowMs;
  }
  if (side != null) lastSide = side;

  let oppTicks = prev.consecutiveOppositeTicks;
  const ps = Math.sign(prev.lastDeltaBps);
  const cs = Math.sign(deltaBps);
  if (ps !== 0 && cs !== 0 && ps !== cs && Math.abs(deltaBps) > env.trendBps) {
    oppTicks = prev.consecutiveOppositeTicks + 1;
  } else if (ps === 0 || cs === 0 || ps === cs) {
    oppTicks = 0;
  }

  return {
    ...prev,
    lastPrice: price,
    lastUpdateMs: nowMs,
    lastSideAboveStrike: lastSide,
    flipCountInWindow: flipCount,
    consecutiveOppositeTicks: oppTicks,
    lastFlipMs,
    trend: effectiveTrend,
    trendDeltaBps: deltaBps,
    lastDeltaBps: deltaBps
  };
}

export type OracleStaleClass = "ok" | "soft" | "hard";

export function classifyOracleStale(ageMs: number | null, env: OracleGateEnv): OracleStaleClass {
  if (ageMs == null || ageMs > env.hardStaleMs) return "hard";
  if (ageMs > env.softStaleMs) return "soft";
  return "ok";
}

/** BTC/ETH/SOL/XRP: require non-FLAT strike trend and |deltaBps| ≥ min (window open vs spot). */
export function evaluateOracleWindowMinTrendGate(
  assetUpper: string,
  state: OracleWindowState,
  env: OracleGateEnv
): { ok: true } | { ok: false; code: "WINDOW_ORACLE_FLAT" | "WINDOW_DELTA_BELOW_MIN" } {
  if (!isOracleChainlinkEntryAsset(assetUpper)) return { ok: true };
  if (state.trend !== "UP" && state.trend !== "DOWN") {
    return { ok: false, code: "WINDOW_ORACLE_FLAT" };
  }
  if (Math.abs(state.trendDeltaBps) < env.minWindowDeltaBps) {
    return { ok: false, code: "WINDOW_DELTA_BELOW_MIN" };
  }
  return { ok: true };
}

export type OracleDirectionGateInput = {
  assetUpper: string;
  intendedDir: Direction;
  state: OracleWindowState;
  nowMs: number;
  windowStartMs: number | null;
  env: OracleGateEnv;
};

export type OracleDirectionGateResult =
  | {
      ok: true;
      trend: OracleStrikeTrend;
      deltaBps: number;
      flips: number;
      oppTicks: number;
    }
  | {
      ok: false;
      code:
        | "STRIKE_PENDING"
        | "TREND_MISMATCH_CONFIRMED"
        | "WINDOW_ORACLE_FLAT"
        | "WINDOW_DELTA_BELOW_MIN";
    };

/** Strike / flip-aware direction gate (call after soft/hard stale passes). */
export function evaluateOracleDirectionFlipGate(inp: OracleDirectionGateInput): OracleDirectionGateResult {
  const { assetUpper, env, intendedDir, state, nowMs, windowStartMs } = inp;
  if (state.strikePrice == null || !Number.isFinite(state.strikePrice) || state.strikePrice <= 0) {
    return { ok: false, code: "STRIKE_PENDING" };
  }
  const minTr = evaluateOracleWindowMinTrendGate(assetUpper, state, env);
  if (!minTr.ok) return minTr;

  const trend = state.trend;
  const deltaBps = state.trendDeltaBps;
  if (!isOracleChainlinkEntryAsset(assetUpper) && (trend === "NA" || trend === "FLAT")) {
    return {
      ok: true,
      trend,
      deltaBps,
      flips: state.flipCountInWindow,
      oppTicks: state.consecutiveOppositeTicks
    };
  }
  const opposed =
    (trend === "UP" && intendedDir === "DOWN") || (trend === "DOWN" && intendedDir === "UP");
  if (!opposed) {
    return {
      ok: true,
      trend,
      deltaBps,
      flips: state.flipCountInWindow,
      oppTicks: state.consecutiveOppositeTicks
    };
  }
  const elapsed = windowStartMs != null ? nowMs - windowStartMs : Number.POSITIVE_INFINITY;
  const early = elapsed < env.mismatchEarlyWindowMs;
  const weak = Math.abs(deltaBps) < env.mismatchStrongBps;
  if (early && weak) {
    return {
      ok: true,
      trend,
      deltaBps,
      flips: state.flipCountInWindow,
      oppTicks: state.consecutiveOppositeTicks
    };
  }
  const flipBlock = state.flipCountInWindow >= env.flipBlockCount;
  const oppBlock =
    state.consecutiveOppositeTicks >= env.oppositeTicksBlock && Math.abs(deltaBps) > env.trendBps;
  if (flipBlock || oppBlock) {
    return { ok: false, code: "TREND_MISMATCH_CONFIRMED" };
  }
  return {
    ok: true,
    trend,
    deltaBps,
    flips: state.flipCountInWindow,
    oppTicks: state.consecutiveOppositeTicks
  };
}
