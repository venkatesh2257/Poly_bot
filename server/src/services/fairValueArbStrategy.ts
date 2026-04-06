/**
 * Polymarket crypto Up/Down ~5m: fair value of the binary (spot vs strike / price-to-beat at window)
 * vs executable cost to buy each YES outcome token (best ask), after fees + slippage buffer — no mid-only shortcuts.
 */

import type { Direction } from "../types/index.js";
import type { StrategyEvaluation } from "../strategy/strategyTypes.js";

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  const s = String(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-0.5 * x * x);
  const p =
    d *
    t *
    (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

export type Polymarket5mFairValueArbConfig = {
  enabled: boolean;
  /** Min edge (0–1) after fees + slippage buffer — Polymarket share price units. */
  minEdgeAfterCosts: number;
  /** Taker fee / adverse selection buffer (share price units). */
  feeBuffer: number;
  /** Extra buffer for slippage / partial fill (share price units). */
  slippageBuffer: number;
  volAnnual: number;
  minSecToExpiry: number;
  /** If >0: only enter when seconds-to-Gamma-expiry is at most this (skip early window). 0 = off. */
  maxSecRemainingForEntry: number;
};

export function loadPolymarket5mFairValueArbConfigFromEnv(): Polymarket5mFairValueArbConfig {
  const maxSec = envNum("FVA_PM5M_MAX_SEC_REMAINING_FOR_ENTRY", envNum("FVA_PM5M_MAX_SEC_TO_EXPIRY", 0));
  return {
    enabled: envBool("FVA_ENABLED", false),
    minEdgeAfterCosts: Math.max(0, envNum("FVA_MIN_EDGE", 0.02)),
    feeBuffer: Math.max(0, envNum("FVA_FEE_BUFFER", 0.01)),
    slippageBuffer: Math.max(0, envNum("FVA_SLIPPAGE_BUFFER", envNum("FVA_PM5M_SLIPPAGE_BUFFER", 0.005))),
    volAnnual: Math.max(0.01, envNum("FVA_VOL_ANNUAL", 0.85)),
    minSecToExpiry: Math.max(0, envNum("FVA_MIN_SEC_LEFT", envNum("FVA_PM5M_MIN_SEC_TO_EXPIRY", 30))),
    maxSecRemainingForEntry: maxSec > 0 ? maxSec : 0
  };
}

export const loadFairValueArbConfigFromEnv = loadPolymarket5mFairValueArbConfigFromEnv;

export type Polymarket5mFairValueArbInputs = {
  isPolymarketCryptoUpDown5m: boolean;
  /** Oracle / Chainlink spot for the asset (USD). */
  spotUsd: number | null;
  /** Window strike: price-to-beat / window-open reference (USD). */
  strikeUsd: number | null;
  /** YES token for UP outcome — executable ask = buy price. */
  yesUpTokenBestAsk: number;
  yesUpTokenBestBid: number;
  /** YES token for DOWN outcome. */
  yesDownTokenBestAsk: number;
  yesDownTokenBestBid: number;
  /** Seconds until Gamma `endDateIso` (Polymarket window end). */
  secToGammaExpiry: number | null;
};

const costPerSide = (cfg: Polymarket5mFairValueArbConfig) => cfg.feeBuffer + cfg.slippageBuffer;

/**
 * Digital call on spot > strike at expiry; compares to Polymarket YES token asks (cost to go long).
 */
export function evaluatePolymarket5mFairValueArb(
  cfg: Polymarket5mFairValueArbConfig,
  input: Polymarket5mFairValueArbInputs
): StrategyEvaluation {
  const prediction: Direction = "UP";
  const confidence = 70;
  const prefix = "FVA[PM5m]";

  if (!cfg.enabled) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: disabled (FVA_ENABLED=false)`
    };
  }

  if (!input.isPolymarketCryptoUpDown5m) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: not a Polymarket crypto ~5m Up/Down window`
    };
  }

  const S = input.spotUsd;
  const K = input.strikeUsd;
  if (S == null || K == null || !Number.isFinite(S) || !Number.isFinite(K) || K <= 0 || S <= 0) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: missing spot or strike (oracle / price-to-beat for this Gamma window)`
    };
  }

  if (
    !Number.isFinite(input.yesUpTokenBestAsk) ||
    !Number.isFinite(input.yesDownTokenBestAsk) ||
    !Number.isFinite(input.yesUpTokenBestBid) ||
    !Number.isFinite(input.yesDownTokenBestBid) ||
    input.yesUpTokenBestAsk <= input.yesUpTokenBestBid ||
    input.yesDownTokenBestAsk <= input.yesDownTokenBestBid
  ) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: non-executable Polymarket YES token book (need bid<ask)`,
    };
  }

  const sec = input.secToGammaExpiry;
  if (sec != null && sec >= 0 && sec < cfg.minSecToExpiry) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: ${sec}s to Gamma expiry < min ${cfg.minSecToExpiry}s (too close to resolution)`
    };
  }

  if (cfg.maxSecRemainingForEntry > 0 && sec != null && sec >= 0 && sec > cfg.maxSecRemainingForEntry) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: ${sec}s to expiry > FVA_PM5M_MAX_SEC_REMAINING_FOR_ENTRY=${cfg.maxSecRemainingForEntry} (only last ${cfg.maxSecRemainingForEntry}s of window)`
    };
  }

  const T = Math.max(1, sec ?? 120) / (365 * 24 * 3600);
  const sigma = cfg.volAnnual;
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const fairUp = normCdf(d2);
  const fairDown = 1 - fairUp;

  const askUp = input.yesUpTokenBestAsk;
  const askDn = input.yesDownTokenBestAsk;
  const buffer = costPerSide(cfg);

  const edgeUp = fairUp - askUp - buffer;
  const edgeDown = fairDown - askDn - buffer;

  const pick: Direction = edgeUp >= edgeDown ? "UP" : "DOWN";
  const bestEdge = Math.max(edgeUp, edgeDown);

  if (bestEdge < cfg.minEdgeAfterCosts) {
    return {
      prediction: pick,
      confidence: 60,
      recommendation: "NO_TRADE",
      reason: `${prefix}: edge ${bestEdge.toFixed(4)} < FVA_MIN_EDGE=${cfg.minEdgeAfterCosts} (fairUp=${fairUp.toFixed(
        3
      )} askUp=${askUp.toFixed(3)} fairDn=${fairDown.toFixed(3)} askDn=${askDn.toFixed(
        3
      )} fees+slip=${buffer.toFixed(3)})`
    };
  }

  return {
    prediction: pick,
    confidence: Math.min(96, 75 + bestEdge * 120),
    recommendation: "TRADE",
    reason: `${prefix}: ${pick} edge=${bestEdge.toFixed(4)} fairUp=${fairUp.toFixed(3)} fairDn=${fairDown.toFixed(
      3
    )} execAskUp=${askUp.toFixed(3)} execAskDn=${askDn.toFixed(3)} spot=${S.toFixed(2)} strike=${K.toFixed(
      2
    )} TTE=${sec ?? "?"}s`
  };
}

/** @deprecated use evaluatePolymarket5mFairValueArb */
export function evaluateFairValueArb(
  cfg: Polymarket5mFairValueArbConfig,
  input: Polymarket5mFairValueArbInputs
): StrategyEvaluation {
  return evaluatePolymarket5mFairValueArb(cfg, input);
}
