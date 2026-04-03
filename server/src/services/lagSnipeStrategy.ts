/**
 * Lag Snipe (King Algo):
 * - Early entry window (default 80s remaining in 5m window)
 * - Direction from CLOB UP probability (min 0.75)
 * - 4-minute candle analysis from last 5×1m BTC/ETH candles
 * - 3-confirmation scoring: candles + liquidity + S/R cap + premium direction
 * - Dynamic size from book depth: $1-$50
 * - Auto-exit is disabled in engine; this module only decides entries.
 */

import type { Direction, MarketContext } from "../types/index.js";
import type { KlineOhlc } from "./binance1mKlines.js";

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

/** Seconds remaining in 5m window must be <= this (default 80). */
export function lagSnipeMaxSecondsLeft(): number {
  return Math.max(5, Math.min(120, envNum("LAG_SNIPE_LAST_SEC", 85)));
}

/** Min CLOB UP probability for a direction decision (default 0.75). */
export function lagSnipeMinProb(): number {
  return Math.min(0.99, Math.max(0.5, envNum("LAG_SNIPE_MIN_PROB", 0.65)));
}

/** How many confirmations (out of up to 4) are required to enter (default 3). */
export function lagSnipeConfirmationsRequired(): number {
  const raw = process.env.CONFIRM_MIN ?? process.env.LAG_SNIPE_CONFIRMATIONS ?? "2";
  const n = Number(raw);
  return Math.max(1, Math.min(4, Math.floor(Number.isFinite(n) ? n : 2)));
}

/** 4-minute momentum threshold (default 0.2%). */
export function lagSnipeCandleMomentumThreshold(): number {
  return Math.max(0, envNum("LAG_SNIPE_MOM_THR", 0.002));
}

/** Outcome mid must stay below this so there is “room” (simple S/R cap). */
export function lagSnipeMaxOutcomeMid(): number {
  const x = envNum("LAG_SNIPE_MAX_OUTCOME_MID", 0.92);
  return Math.min(0.99, Math.max(0.5, x));
}

/** Direction from CLOB UP probability (min-prob fee-hunt gate). */
export function lagSnipeDirectionFromUpProb(upProb: number, minProb = lagSnipeMinProb()): Direction | null {
  if (!Number.isFinite(upProb)) return null;
  if (upProb >= minProb) return "UP";
  const downProb = 1 - upProb;
  if (downProb >= minProb) return "DOWN";
  return null;
}

/**
 * 4-minute candle signal:
 * Uses first->last close across the provided candles (expected length 5 for ~4min span).
 * Returns UP if momentum > threshold; else DOWN.
 */
export function candleSignalFromFive(candles: KlineOhlc[]): Direction | null {
  if (!candles || candles.length < 2) return null;
  const first = candles[0];
  const last = candles[candles.length - 1]!;
  const denom = Math.max(1e-12, first.close);
  const momentum = (last.close - first.close) / denom;
  const thr = lagSnipeCandleMomentumThreshold();
  return momentum > thr ? "UP" : "DOWN";
}

export function lagSnipeInWindow(secondsToExpiry: number | null, maxSec = lagSnipeMaxSecondsLeft()): boolean {
  if (secondsToExpiry == null || !Number.isFinite(secondsToExpiry)) return false;
  return secondsToExpiry >= 0 && secondsToExpiry <= maxSec;
}

/** Dynamic $ sizing from depth. */
export function lagSnipeCalcSizeFromDepth(depth: number): number {
  if (!Number.isFinite(depth) || depth <= 0) return 1;
  if (depth > 1000) return 50;
  if (depth > 200) return 20;
  if (depth > 50) return 10;
  return 1;
}

export function lagSnipeLiquidityConfirmation(depth: number, sizeUsd: number): boolean {
  if (!Number.isFinite(depth) || !Number.isFinite(sizeUsd) || sizeUsd <= 0) return false;
  return depth >= sizeUsd * 2;
}

export function lagSnipeSrOk(direction: Direction, up: MarketContext, down: MarketContext, cap = lagSnipeMaxOutcomeMid()): boolean {
  if (direction === "UP") return up.mid <= cap;
  return down.mid <= cap;
}

/** Premium direction: whether oracle (spot) is above price-to-beat. */
export function lagSnipePremiumDirectionFromOracleDiff(oracleDiffUsd: number | null): Direction | null {
  if (oracleDiffUsd == null || !Number.isFinite(oracleDiffUsd)) return null;
  return oracleDiffUsd >= 0 ? "UP" : "DOWN";
}
