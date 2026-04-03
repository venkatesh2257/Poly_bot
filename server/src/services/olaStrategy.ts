/**
 * OLA — Oracle / Latency Alpha: Binance aggTrade vs Polymarket price-to-beat + CLOB discount snipe.
 * Risk constants are intentionally fixed (spec); tune edge only via OLA_THRESHOLD_USD / snipe ask cap.
 */

import type { Direction, MarketContext } from "../types/index.js";

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

/** Hardcoded risk (spec) — change only via code review */
export const OLA_LAST_SECONDS_ABORT = 10;
export const OLA_KILL_SWITCH_LOSS_FRAC = 0.05;
export const OLA_KILL_WINDOW_MS = 3_600_000;
export const OLA_MAX_WINDOW_USDC_DEFAULT = 500;
export const OLA_SLIPPAGE_FRAC = 0.005;
export const OLA_SNIPE_MAX_ASK_DEFAULT = 0.9;

export type OlaOracleResult =
  | { kind: "up"; edgeUsd: number }
  | { kind: "down"; edgeUsd: number }
  | { kind: "flat"; edgeUsd: number };

/**
 * Binance (signal) vs Gamma / engine price-to-beat (resolution reference).
 * UP if spot > target + threshold; DOWN if spot < target - threshold.
 */
export function olaOracleVersusTarget(
  binanceUsd: number,
  targetUsd: number,
  thresholdUsd: number
): OlaOracleResult {
  if (!Number.isFinite(binanceUsd) || !Number.isFinite(targetUsd) || binanceUsd <= 0 || targetUsd <= 0) {
    return { kind: "flat", edgeUsd: 0 };
  }
  const th = Math.max(0, thresholdUsd);
  if (binanceUsd > targetUsd + th) {
    return { kind: "up", edgeUsd: binanceUsd - targetUsd };
  }
  if (binanceUsd < targetUsd - th) {
    return { kind: "down", edgeUsd: targetUsd - binanceUsd };
  }
  return { kind: "flat", edgeUsd: Math.abs(binanceUsd - targetUsd) };
}

export function olaDirectionFromOracle(oracle: OlaOracleResult): Direction | null {
  if (oracle.kind === "up") return "UP";
  if (oracle.kind === "down") return "DOWN";
  return null;
}

/**
 * Buy only if the winning side is still cheap on the CLOB (latency gap).
 * UP signal → require upMid < maxAsk; DOWN → downMid < maxAsk.
 */
export function olaBookSnipeAllowed(
  direction: Direction,
  up: MarketContext,
  down: MarketContext,
  maxAskMid: number
): { ok: true } | { ok: false; detail: string } {
  const cap = Math.min(0.99, Math.max(0.01, maxAskMid));
  if (direction === "UP") {
    if (up.mid < cap) return { ok: true };
    return { ok: false, detail: `OLA: UP mid ${up.mid.toFixed(4)} ≥ snipe cap ${cap} (no discount)` };
  }
  if (down.mid < cap) return { ok: true };
  return { ok: false, detail: `OLA: DOWN mid ${down.mid.toFixed(4)} ≥ snipe cap ${cap} (no discount)` };
}

export function olaSecondsToExpiryAbort(secLeft: number | null, minSec = OLA_LAST_SECONDS_ABORT): boolean {
  if (secLeft == null) return false;
  return secLeft >= 0 && secLeft < minSec;
}

export function olaSlippageExceeded(p0: number, p1: number, maxFrac = OLA_SLIPPAGE_FRAC): boolean {
  if (!Number.isFinite(p0) || !Number.isFinite(p1) || p0 <= 0) return true;
  return Math.abs(p1 - p0) / p0 > maxFrac;
}

export function olaWindowSpendCap(): number {
  return Math.max(10, envNum("OLA_MAX_WINDOW_USDC", OLA_MAX_WINDOW_USDC_DEFAULT));
}

export function olaSnipeAskCap(): number {
  return Math.min(0.99, Math.max(0.05, envNum("OLA_SNIPE_MAX_ASK", OLA_SNIPE_MAX_ASK_DEFAULT)));
}

export function olaThresholdUsd(): number {
  return Math.max(0, envNum("OLA_THRESHOLD_USD", 8));
}
