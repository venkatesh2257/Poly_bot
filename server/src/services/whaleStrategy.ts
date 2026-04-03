/**
 * Whale-edge entry gates for 5m Up/Down: time-in-window, spread, mid band, book tilt, optional oracle.
 * Not a guarantee of profit — reduces obviously bad entries seen in naive orderbook mode (CSV logs).
 */

import type { Direction, MarketContext } from "../types/index.js";

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, defaultTrue: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === "") return defaultTrue;
  const s = String(v).toLowerCase();
  if (defaultTrue) return s !== "false" && s !== "0" && s !== "no";
  return s === "true" || s === "1" || s === "yes";
}

export type WhaleGateInput = {
  direction: Direction;
  up: MarketContext;
  down: MarketContext;
  secondsSinceWindowStart: number | null;
  secondsToExpiry: number | null;
  warmupWindow: boolean;
  /** spotUsd - priceToBeatUsd for active asset; null if unknown */
  oracleDiffUsd: number | null;
};

export type WhaleGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Gates auto-entries when ENTRY_STRATEGY=whale_edge (dashboard can override to whale_edge).
 * Tune via WHALE_* env vars (see server/.env.example).
 */
export function evaluateWhaleEdgeGate(input: WhaleGateInput): WhaleGateResult {
  const minElapsed = envNum("WHALE_MIN_SEC_IN_WINDOW", 120);
  const minRemain = envNum("WHALE_MIN_SEC_TO_EXPIRY", 55);
  const maxSpread = envNum("WHALE_MAX_SPREAD", 0.055);
  const midMin = envNum("WHALE_ENTRY_MID_MIN", 0.1);
  const midMax = envNum("WHALE_ENTRY_MID_MAX", 0.78);
  const minBookEdge = envNum("WHALE_MIN_BOOK_EDGE", 0.03);
  const skipWarmup = envBool("WHALE_SKIP_WARMUP", true);

  if (skipWarmup && input.warmupWindow) {
    return { ok: false, reason: "whale: post-open warmup (MARKET_WARMUP_SEC)" };
  }
  if (input.secondsSinceWindowStart != null && input.secondsSinceWindowStart < minElapsed) {
    return {
      ok: false,
      reason: `whale: only ${input.secondsSinceWindowStart}s in window (need ≥${minElapsed}s)`
    };
  }
  if (input.secondsToExpiry != null && input.secondsToExpiry >= 0 && input.secondsToExpiry < minRemain) {
    return {
      ok: false,
      reason: `whale: ${input.secondsToExpiry}s to expiry (need ≥${minRemain}s)`
    };
  }

  const side = input.direction === "UP" ? input.up : input.down;
  if (side.spread > maxSpread) {
    return {
      ok: false,
      reason: `whale: ${input.direction} spread ${side.spread.toFixed(3)} > ${maxSpread}`
    };
  }
  if (side.mid < midMin || side.mid > midMax) {
    return {
      ok: false,
      reason: `whale: ${input.direction} mid ${side.mid.toFixed(3)} outside [${midMin},${midMax}]`
    };
  }
  const edge = Math.abs(input.up.mid - input.down.mid);
  if (edge < minBookEdge) {
    return {
      ok: false,
      reason: `whale: |UP−DN| edge ${edge.toFixed(3)} < ${minBookEdge} (coin-flip zone)`
    };
  }

  if (envBool("WHALE_REQUIRE_ORACLE_ALIGN", false)) {
    const eps = envNum("WHALE_ORACLE_EPS_USD", 0);
    if (input.oracleDiffUsd == null || !Number.isFinite(input.oracleDiffUsd)) {
      return { ok: false, reason: "whale: oracle diff unavailable (RTDS/priceToBeat)" };
    }
    if (input.direction === "UP" && input.oracleDiffUsd <= eps) {
      return {
        ok: false,
        reason: `whale: UP needs spot > priceToBeat+ε (diff ${input.oracleDiffUsd.toFixed(2)} USD)`
      };
    }
    if (input.direction === "DOWN" && input.oracleDiffUsd >= -eps) {
      return {
        ok: false,
        reason: `whale: DOWN needs spot < priceToBeat−ε (diff ${input.oracleDiffUsd.toFixed(2)} USD)`
      };
    }
  }

  return { ok: true };
}

/** Target mid for paper TP: entry * (1 + relative); capped below 1. */
export function whalePaperTakeProfitMid(entryVwap: number, relativeGain: number): number {
  const r = Math.max(0, relativeGain);
  return Math.min(0.985, entryVwap * (1 + r));
}
