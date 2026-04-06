/**
 * Polymarket crypto Up/Down ~5m: sparse directional entries using oracle/chart momentum,
 * with Gamma expiry gating (TTE band: not too early, not too close) and executable YES-token ask checks.
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

export type Polymarket5mSelectiveMomentumConfig = {
  enabled: boolean;
  minImpulse: number;
  persistenceTicks: number;
  /** Max bid–ask spread on each YES outcome token (Polymarket 0–1). */
  maxOutcomeSpread: number;
  requireBookConfirm: boolean;
  /**
   * Minimum seconds **remaining** until Gamma expiry to allow entry.
   * If `secToGammaExpiry <` this, NO_TRADE (too close to resolution / illiquid tail).
   */
  minSecRemainingToExpiry: number;
  /**
   * Maximum seconds **remaining** until Gamma expiry to allow entry (upper bound on TTE).
   * If `secToGammaExpiry >` this, NO_TRADE (too **early** in the window — still too much time left).
   */
  maxSecRemainingToExpiry: number;
  /** Max executable ask (0–1) for the outcome we buy — avoids overpaying. */
  maxYesTokenAsk: number;
};

export function loadPolymarket5mSelectiveMomentumConfigFromEnv(): Polymarket5mSelectiveMomentumConfig {
  return {
    enabled: envBool("SM_ENABLED", false),
    minImpulse: Math.max(0, envNum("SM_MIN_IMPULSE", 0.015)),
    persistenceTicks: Math.max(1, Math.floor(envNum("SM_PERSISTENCE_TICKS", 3))),
    maxOutcomeSpread: Math.max(0.001, envNum("SM_PM5M_MAX_OUTCOME_SPREAD", envNum("SM_MAX_SPREAD", 0.12))),
    requireBookConfirm: envBool("SM_REQUIRE_BOOK_CONFIRM", true),
    minSecRemainingToExpiry: Math.max(
      0,
      envNum("SM_PM5M_MIN_SEC_REMAINING", envNum("SM_PM5M_MIN_SEC_TO_EXPIRY", envNum("SM_MIN_SEC_LEFT", 45)))
    ),
    maxSecRemainingToExpiry: Math.max(
      0,
      envNum("SM_PM5M_MAX_SEC_REMAINING", envNum("SM_PM5M_MAX_SEC_TO_EXPIRY", envNum("SM_MAX_SEC_LEFT", 240)))
    ),
    maxYesTokenAsk: Math.min(0.99, Math.max(0.01, envNum("SM_PM5M_MAX_YES_ASK", envNum("SM_MAX_ENTRY_ASK", 0.72))))
  };
}

export const loadSelectiveMomentumConfigFromEnv = loadPolymarket5mSelectiveMomentumConfigFromEnv;

export type Polymarket5mSelectiveMomentumInputs = {
  isPolymarketCryptoUpDown5m: boolean;
  momentumScalar: number;
  recentScalars: number[];
  /** UP YES token — for spread/mid checks. */
  yesUpOutcome: { mid: number; spread: number; bestBid: number; bestAsk: number };
  yesDownOutcome: { mid: number; spread: number; bestBid: number; bestAsk: number };
  /** Executable ask for the YES token we would buy. */
  chosenYesTokenAsk: number;
  chosenYesTokenBid: number;
  secToGammaExpiry: number | null;
};

function sign(x: number): -1 | 0 | 1 {
  if (x > 1e-12) return 1;
  if (x < -1e-12) return -1;
  return 0;
}

export function evaluatePolymarket5mSelectiveMomentum(
  cfg: Polymarket5mSelectiveMomentumConfig,
  input: Polymarket5mSelectiveMomentumInputs
): StrategyEvaluation {
  const prediction: Direction = "UP";
  const confidence = 78;
  const prefix = "SM[PM5m]";

  if (!cfg.enabled) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: disabled (SM_ENABLED=false)`
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

  const u = input.yesUpOutcome;
  const d = input.yesDownOutcome;
  if (
    !Number.isFinite(u.bestBid) ||
    !Number.isFinite(u.bestAsk) ||
    !Number.isFinite(d.bestBid) ||
    !Number.isFinite(d.bestAsk) ||
    u.bestAsk <= u.bestBid ||
    d.bestAsk <= d.bestBid
  ) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: non-executable YES token books (bid<ask required on UP and DOWN)`
    };
  }

  const impulse = Math.abs(input.momentumScalar);
  if (impulse < cfg.minImpulse) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: impulse ${impulse.toFixed(5)} < SM_MIN_IMPULSE=${cfg.minImpulse}`
    };
  }

  const dirSign = sign(input.momentumScalar);
  if (dirSign === 0) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: zero momentum`
    };
  }

  const direction: Direction = dirSign > 0 ? "UP" : "DOWN";
  const hist = input.recentScalars;
  if (hist.length + 1 < cfg.persistenceTicks) {
    return {
      prediction: direction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: need ${cfg.persistenceTicks} momentum samples (have ${hist.length})`
    };
  }
  const window = [...hist.slice(-(cfg.persistenceTicks - 1)), input.momentumScalar];
  const allSame = window.every((v) => sign(v) === dirSign);
  if (!allSame) {
    return {
      prediction: direction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: sign not stable over SM_PERSISTENCE_TICKS`
    };
  }

  if (cfg.requireBookConfirm) {
    if (u.spread > cfg.maxOutcomeSpread || d.spread > cfg.maxOutcomeSpread) {
      return {
        prediction: direction,
        confidence,
        recommendation: "NO_TRADE",
        reason: `${prefix}: YES-token spread UP=${u.spread.toFixed(3)} DOWN=${d.spread.toFixed(3)} max=${cfg.maxOutcomeSpread}`
      };
    }
  }

  if (input.chosenYesTokenAsk > cfg.maxYesTokenAsk) {
    return {
      prediction: direction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: executable YES ask ${input.chosenYesTokenAsk.toFixed(3)} > SM_PM5M_MAX_YES_ASK=${cfg.maxYesTokenAsk}`
    };
  }

  if (input.chosenYesTokenAsk < input.chosenYesTokenBid) {
    return {
      prediction: direction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: crossed book on chosen side (ask < bid)`
    };
  }

  const sec = input.secToGammaExpiry;
  if (sec != null && sec >= 0) {
    if (sec < cfg.minSecRemainingToExpiry) {
      return {
        prediction: direction,
        confidence,
        recommendation: "NO_TRADE",
        reason: `${prefix}: TTE ${sec}s < SM_PM5M_MIN_SEC_REMAINING=${cfg.minSecRemainingToExpiry} (too close to Gamma expiry)`
      };
    }
    if (sec > cfg.maxSecRemainingToExpiry) {
      return {
        prediction: direction,
        confidence,
        recommendation: "NO_TRADE",
        reason: `${prefix}: TTE ${sec}s > SM_PM5M_MAX_SEC_REMAINING=${cfg.maxSecRemainingToExpiry} (too early in window — excess time before expiry)`
      };
    }
  }

  return {
    prediction: direction,
    confidence: Math.min(96, 80 + impulse * 200),
    recommendation: "TRADE",
    reason: `${prefix}: ${direction} impulse=${impulse.toFixed(4)} YES_ask=${input.chosenYesTokenAsk.toFixed(
      3
    )} YES_bid=${input.chosenYesTokenBid.toFixed(3)} TTE=${sec ?? "?"}s`
  };
}

/** @deprecated use evaluatePolymarket5mSelectiveMomentum */
export function evaluateSelectiveMomentum(
  cfg: Polymarket5mSelectiveMomentumConfig,
  input: Polymarket5mSelectiveMomentumInputs
): StrategyEvaluation {
  return evaluatePolymarket5mSelectiveMomentum(cfg, input);
}
