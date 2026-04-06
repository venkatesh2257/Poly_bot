/**
 * Polymarket crypto Up/Down ~5m window: maker-style quote eligibility (passive liquidity).
 * Uses YES outcome token bid/ask/spread/depth per side — not generic exchange metrics.
 * Live CLOB post-only / GTC bid lifecycle is not implemented: MM_LIVE_ENABLED is opt-in for future wiring only.
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

export type Polymarket5mMarketMakingConfig = {
  enabled: boolean;
  /** Polymarket CLOB maker stack not wired — when false, LIVE never quotes (SIM logs only). */
  liveMakerEnabled: boolean;
  /** Minimum YES-token bid–ask spread (0–1 Polymarket share price) each side. */
  minOutcomeSpread: number;
  minLiquidityPerOutcome: number;
  /** Max |YES_UP − YES_DOWN| notional (USD proxy) for inventory skew. */
  maxInventorySkewUsd: number;
  maxTotalNotionalUsdPerGammaWindow: number;
  repriceMinMs: number;
  /** Stop quoting when Gamma expiry is closer than this (seconds). */
  stopQuoteSecBeforeExpiry: number;
  /** Optional: do not quote in the first N seconds after window open (warmup). */
  minSecAfterWindowOpen: number;
  /** Optional: cap each outcome token’s simulated inventory (0 = disabled). */
  maxPerOutcomeNotionalUsd: number;
};

export function loadPolymarket5mMarketMakingConfigFromEnv(): Polymarket5mMarketMakingConfig {
  const maxPer = envNum("MM_PM5M_MAX_PER_OUTCOME_NOTIONAL_USD", 0);
  return {
    enabled: envBool("MM_ENABLED", false),
    liveMakerEnabled: envBool("MM_LIVE_ENABLED", false),
    minOutcomeSpread: Math.max(0, envNum("MM_PM5M_MIN_OUTCOME_SPREAD", envNum("MM_SPREAD_FLOOR", 0.02))),
    minLiquidityPerOutcome: Math.max(0, envNum("MM_PM5M_MIN_LIQUIDITY_PER_OUTCOME", envNum("MM_MIN_LIQUIDITY_PER_SIDE", 80))),
    maxInventorySkewUsd: Math.max(0, envNum("MM_PM5M_MAX_INVENTORY_SKEW_USD", envNum("MM_MAX_INVENTORY_IMBALANCE", 500))),
    maxTotalNotionalUsdPerGammaWindow: Math.max(
      0,
      envNum("MM_PM5M_MAX_NOTIONAL_PER_WINDOW_USD", envNum("MM_MAX_NOTIONAL_USD_PER_WINDOW", 250))
    ),
    repriceMinMs: Math.max(50, envNum("MM_REPRICE_MIN_MS", 2000)),
    stopQuoteSecBeforeExpiry: Math.max(0, envNum("MM_PM5M_STOP_QUOTE_SEC_BEFORE_EXPIRY", envNum("MM_STOP_QUOTE_SEC_LEFT", 45))),
    minSecAfterWindowOpen: Math.max(0, envNum("MM_PM5M_MIN_SEC_AFTER_WINDOW_OPEN", 0)),
    maxPerOutcomeNotionalUsd: maxPer > 0 ? maxPer : 0
  };
}

/** @deprecated use loadPolymarket5mMarketMakingConfigFromEnv */
export const loadMarketMakingConfigFromEnv = loadPolymarket5mMarketMakingConfigFromEnv;

export type Polymarket5mMarketMakingInputs = {
  isPolymarketCryptoUpDown5m: boolean;
  gammaWindowKey: string;
  secToGammaExpiry: number | null;
  secSinceWindowOpen: number | null;
  /** YES token for “UP” / higher price wins (Polymarket outcome). */
  yesUpOutcome: { bestBid: number; bestAsk: number; spread: number; depthLiquidity: number };
  /** YES token for “DOWN” / lower price wins. */
  yesDownOutcome: { bestBid: number; bestAsk: number; spread: number; depthLiquidity: number };
  inventoryYesUpUsd: number;
  inventoryYesDownUsd: number;
  isLive: boolean;
};

export type Polymarket5mMarketMakingResult = StrategyEvaluation & { quoteNote: string };

/**
 * Eligibility for quoting both outcome tokens (maker intent). Never authorizes taker BUY.
 */
export function evaluatePolymarket5mMarketMaking(
  cfg: Polymarket5mMarketMakingConfig,
  input: Polymarket5mMarketMakingInputs
): Polymarket5mMarketMakingResult {
  const prediction: Direction = "UP";
  const confidence = 55;
  const prefix = "MM[PM5m]";

  if (!cfg.enabled) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: disabled (MM_ENABLED=false)`,
      quoteNote: "off"
    };
  }

  if (!input.isPolymarketCryptoUpDown5m) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: not a Polymarket crypto ~5m Up/Down window (gamma duration ≈300s)`,
      quoteNote: "not_pm5m"
    };
  }

  if (input.isLive && !cfg.liveMakerEnabled) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: LIVE maker disabled — Polymarket CLOB bid/quote lifecycle not implemented (MM_LIVE_ENABLED=false or unset)`,
      quoteNote: "live_disabled"
    };
  }

  if (input.secToGammaExpiry != null && input.secToGammaExpiry >= 0 && input.secToGammaExpiry < cfg.stopQuoteSecBeforeExpiry) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: stop quoting — ${input.secToGammaExpiry}s to Gamma expiry < MM_PM5M_STOP_QUOTE_SEC_BEFORE_EXPIRY=${cfg.stopQuoteSecBeforeExpiry} (window=${input.gammaWindowKey})`,
      quoteNote: "near_expiry"
    };
  }

  if (
    input.secSinceWindowOpen != null &&
    input.secSinceWindowOpen >= 0 &&
    input.secSinceWindowOpen < cfg.minSecAfterWindowOpen
  ) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: post-open warmup — ${input.secSinceWindowOpen}s < MM_PM5M_MIN_SEC_AFTER_WINDOW_OPEN=${cfg.minSecAfterWindowOpen}`,
      quoteNote: "warmup"
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
      reason: `${prefix}: invalid YES/NO executable book (need bid<ask on both UP and DOWN outcome tokens)`,
      quoteNote: "bad_book"
    };
  }

  if (u.spread < cfg.minOutcomeSpread || d.spread < cfg.minOutcomeSpread) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: outcome spread floor — UP=${u.spread.toFixed(4)} DOWN=${d.spread.toFixed(
        4
      )} need≥${cfg.minOutcomeSpread} (bid/ask per token)`,
      quoteNote: "spread"
    };
  }

  if (u.depthLiquidity < cfg.minLiquidityPerOutcome || d.depthLiquidity < cfg.minLiquidityPerOutcome) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: CLOB depth — UP=${u.depthLiquidity.toFixed(0)} DOWN=${d.depthLiquidity.toFixed(
        0
      )} min=${cfg.minLiquidityPerOutcome}`,
      quoteNote: "depth"
    };
  }

  const skew = Math.abs(input.inventoryYesUpUsd - input.inventoryYesDownUsd);
  if (skew > cfg.maxInventorySkewUsd) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: YES_UP vs YES_DOWN skew ${skew.toFixed(2)} > MM_PM5M_MAX_INVENTORY_SKEW_USD=${cfg.maxInventorySkewUsd} (window=${input.gammaWindowKey})`,
      quoteNote: "skew"
    };
  }

  const total = input.inventoryYesUpUsd + input.inventoryYesDownUsd;
  if (total > cfg.maxTotalNotionalUsdPerGammaWindow) {
    return {
      prediction,
      confidence,
      recommendation: "NO_TRADE",
      reason: `${prefix}: total notional ${total.toFixed(2)} > MM_PM5M_MAX_NOTIONAL_PER_WINDOW_USD=${cfg.maxTotalNotionalUsdPerGammaWindow}`,
      quoteNote: "notional"
    };
  }

  if (cfg.maxPerOutcomeNotionalUsd > 0) {
    if (input.inventoryYesUpUsd > cfg.maxPerOutcomeNotionalUsd || input.inventoryYesDownUsd > cfg.maxPerOutcomeNotionalUsd) {
      return {
        prediction,
        confidence,
        recommendation: "NO_TRADE",
        reason: `${prefix}: per-outcome cap — UP=${input.inventoryYesUpUsd.toFixed(
          2
        )} DOWN=${input.inventoryYesDownUsd.toFixed(2)} max=${cfg.maxPerOutcomeNotionalUsd}`,
        quoteNote: "per_side"
      };
    }
  }

  const mode = input.isLive ? "LIVE" : "SIM";
  return {
    prediction,
    confidence: 72,
    recommendation: "TRADE",
    reason: `${prefix}: [${mode}] quote OK for UP/DOWN YES tokens (passive only; no taker) window=${input.gammaWindowKey}`,
    quoteNote: "quote_ok"
  };
}

/** @deprecated use evaluatePolymarket5mMarketMaking */
export function evaluateMarketMaking(
  cfg: Polymarket5mMarketMakingConfig,
  input: Polymarket5mMarketMakingInputs
): Polymarket5mMarketMakingResult {
  return evaluatePolymarket5mMarketMaking(cfg, input);
}
