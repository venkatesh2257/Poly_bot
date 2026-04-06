/**
 * Native Polymarket vs Synthesis drift + bot-fallback guardrails (pure helpers, testable).
 * Does not touch execution — only eligibility for optional Synthesis book use in strategy evaluation.
 */

import type { DirectionalContext, MarketContext } from "../types/index.js";

export type DriftStatusLevel = "ok" | "warn" | "critical";

export type SynthesisFallbackBlockReason =
  | "native_fresh"
  | "synthesis_stale"
  | "drift_too_high"
  | "incomplete_book_match"
  | "synthesis_disabled"
  | "bot_fallback_disabled"
  | "drift_unavailable"
  /** Fallback to Synthesis books for strategy eval is allowed. */
  | "fallback_ok";

export type SynthesisGuardrailConfig = {
  driftWarnBps: number;
  driftCriticalBps: number;
  driftRequireBothSides: boolean;
  driftLogThrottleMs: number;
  nativeBookStaleMs: number;
  synthesisOrderbookStaleMs: number;
  synthesisPriceStaleMs: number;
  synthesisTradesStaleMs: number;
  botFallbackMaxDriftBps: number;
  botFallbackRequireMatchedBooks: boolean;
};

export function loadSynthesisGuardrailConfigFromEnv(): SynthesisGuardrailConfig {
  const envNum = (k: string, fb: number) => {
    const n = Number(process.env[k]);
    return Number.isFinite(n) ? n : fb;
  };
  const envBool = (k: string, fb: boolean) => {
    const v = process.env[k];
    if (v == null || v === "") return fb;
    const s = String(v).toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  };
  const synStale = Math.max(500, envNum("SYNTHESIS_STALE_MS", 15_000));
  return {
    driftWarnBps: Math.max(1, envNum("SYNTHESIS_DRIFT_WARN_BPS", 150)),
    driftCriticalBps: Math.max(1, envNum("SYNTHESIS_DRIFT_CRITICAL_BPS", 400)),
    driftRequireBothSides: envBool("SYNTHESIS_DRIFT_REQUIRE_BOTH_SIDES", true),
    driftLogThrottleMs: Math.max(500, envNum("SYNTHESIS_DRIFT_LOG_THROTTLE_MS", 10_000)),
    nativeBookStaleMs: Math.max(500, envNum("NATIVE_BOOK_STALE_MS", synStale)),
    synthesisOrderbookStaleMs: synStale,
    synthesisPriceStaleMs: Math.max(500, envNum("SYNTHESIS_PRICE_STALE_MS", synStale)),
    synthesisTradesStaleMs: Math.max(500, envNum("SYNTHESIS_TRADES_STALE_MS", 60_000)),
    botFallbackMaxDriftBps: Math.max(1, envNum("SYNTHESIS_BOT_FALLBACK_MAX_DRIFT_BPS", 300)),
    botFallbackRequireMatchedBooks: envBool("SYNTHESIS_BOT_FALLBACK_REQUIRE_MATCHED_BOOKS", true)
  };
}

/** Absolute price difference on 0–1 share scale → basis points (1.00 = 10_000 bps). */
export function priceDiffBps(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) * 10_000;
}

export type PerOutcomeDrift = {
  outcome: "up" | "down";
  bidBps: number;
  askBps: number;
  midBps: number;
  spreadDeltaBps: number;
};

export type NativeSynthesisDriftResult = {
  comparedAtMs: number;
  maxBps: number;
  level: DriftStatusLevel;
  perOutcome: PerOutcomeDrift[];
  incomplete: boolean;
  incompleteReason?: string;
};

/** True when native CLOB has a usable bid/ask cross for drift comparison. */
export function hasValidTopOfBook(mc: MarketContext): boolean {
  const { bestBid, bestAsk } = mc;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return false;
  if (bestBid <= 0 || bestAsk >= 1 || bestAsk <= bestBid) return false;
  return true;
}

function driftOne(native: MarketContext, syn: MarketContext, outcome: "up" | "down"): PerOutcomeDrift {
  const bidBps = priceDiffBps(native.bestBid, syn.bestBid);
  const askBps = priceDiffBps(native.bestAsk, syn.bestAsk);
  const midBps = priceDiffBps(native.mid, syn.mid);
  const spreadDeltaBps = priceDiffBps(native.spread, syn.spread);
  return { outcome, bidBps, askBps, midBps, spreadDeltaBps };
}

export function classifyDriftLevel(maxBps: number, warnBps: number, criticalBps: number): DriftStatusLevel {
  if (!Number.isFinite(maxBps)) return "critical";
  if (maxBps >= criticalBps) return "critical";
  if (maxBps >= warnBps) return "warn";
  return "ok";
}

/**
 * Compare native CLOB top-of-book vs Synthesis for UP/DOWN YES tokens.
 */
export function computeNativeSynthesisDrift(
  native: DirectionalContext | null,
  synthesisUp: MarketContext | null,
  synthesisDown: MarketContext | null,
  guard: SynthesisGuardrailConfig,
  nowMs: number
): NativeSynthesisDriftResult {
  if (!native) {
    return {
      comparedAtMs: nowMs,
      maxBps: Number.POSITIVE_INFINITY,
      level: "critical",
      perOutcome: [],
      incomplete: true,
      incompleteReason: "native_context_missing"
    };
  }
  if (
    guard.driftRequireBothSides &&
    (!hasValidTopOfBook(native.up) || !hasValidTopOfBook(native.down))
  ) {
    return {
      comparedAtMs: nowMs,
      maxBps: Number.POSITIVE_INFINITY,
      level: "critical",
      perOutcome: [],
      incomplete: true,
      incompleteReason: "native_books_incomplete"
    };
  }
  if (!synthesisUp || !synthesisDown) {
    return {
      comparedAtMs: nowMs,
      maxBps: Number.POSITIVE_INFINITY,
      level: "critical",
      perOutcome: [],
      incomplete: true,
      incompleteReason: "synthesis_books_incomplete"
    };
  }

  const up = driftOne(native.up, synthesisUp, "up");
  const down = driftOne(native.down, synthesisDown, "down");
  const perOutcome = [up, down];
  const candidates = [
    up.bidBps,
    up.askBps,
    up.midBps,
    down.bidBps,
    down.askBps,
    down.midBps
  ];
  const maxBps = Math.max(...candidates);
  const level = classifyDriftLevel(maxBps, guard.driftWarnBps, guard.driftCriticalBps);

  return {
    comparedAtMs: nowMs,
    maxBps,
    level,
    perOutcome,
    incomplete: false
  };
}

export type StalenessSlice = {
  stale: boolean;
  ageMs: number | null;
  thresholdMs: number;
  /** Wall-clock ms of last successful update (same as input last-msg / refresh time). */
  lastUpdateMs: number | null;
  staleReason?: "never_updated" | "age_exceeded";
};

export type SourceStalenessBundle = {
  nativeOrderbook: StalenessSlice;
  synthesisOrderbook: StalenessSlice;
  synthesisTrades: StalenessSlice;
  synthesisPrices: StalenessSlice;
};

export function computeNativeOrderbookStale(lastBookRefreshMs: number | null, nowMs: number, thresholdMs: number): StalenessSlice {
  if (lastBookRefreshMs == null) {
    return { stale: true, ageMs: null, thresholdMs, lastUpdateMs: null, staleReason: "never_updated" };
  }
  const ageMs = nowMs - lastBookRefreshMs;
  const stale = ageMs > thresholdMs;
  return {
    stale,
    ageMs,
    thresholdMs,
    lastUpdateMs: lastBookRefreshMs,
    staleReason: stale ? "age_exceeded" : undefined
  };
}

export function computeAgeStale(lastMsgMs: number | null, nowMs: number, thresholdMs: number): StalenessSlice {
  if (lastMsgMs == null) {
    return { stale: true, ageMs: null, thresholdMs, lastUpdateMs: null, staleReason: "never_updated" };
  }
  const ageMs = nowMs - lastMsgMs;
  const stale = ageMs > thresholdMs;
  return {
    stale,
    ageMs,
    thresholdMs,
    lastUpdateMs: lastMsgMs,
    staleReason: stale ? "age_exceeded" : undefined
  };
}

/** Serialize drift for WS/REST (matches `SynthesisDriftTelemetryPayload` in types). */
export function driftResultToTelemetryPayload(d: NativeSynthesisDriftResult): {
  level: DriftStatusLevel;
  maxBps: number;
  comparedAtMs: number | null;
  perOutcome: PerOutcomeDrift[];
  incomplete: boolean;
  incompleteReason?: string;
} {
  return {
    level: d.level,
    maxBps: Number.isFinite(d.maxBps) ? d.maxBps : 0,
    comparedAtMs: d.comparedAtMs,
    perOutcome: d.perOutcome,
    incomplete: d.incomplete,
    incompleteReason: d.incompleteReason
  };
}

export type BotFallbackEvaluation = {
  allowed: boolean;
  reason: SynthesisFallbackBlockReason;
};

/**
 * Decide whether Synthesis books may be used for PM5m strategy evaluation fallback (never execution).
 */
export function evaluateSynthesisBotFallbackEligibility(args: {
  synthesisEnabled: boolean;
  botFallbackEnabled: boolean;
  nativeBookStale: boolean;
  synthesisOrderbookStale: boolean;
  synthesisReady: boolean;
  drift: NativeSynthesisDriftResult | null;
  guard: SynthesisGuardrailConfig;
}): BotFallbackEvaluation {
  if (!args.synthesisEnabled) {
    return { allowed: false, reason: "synthesis_disabled" };
  }
  if (!args.botFallbackEnabled) {
    return { allowed: false, reason: "bot_fallback_disabled" };
  }
  if (!args.nativeBookStale) {
    return { allowed: false, reason: "native_fresh" };
  }
  if (args.synthesisOrderbookStale || !args.synthesisReady) {
    return { allowed: false, reason: "synthesis_stale" };
  }
  if (
    args.drift?.incompleteReason === "native_context_missing" ||
    args.drift?.incompleteReason === "synthesis_books_incomplete" ||
    args.drift?.incompleteReason === "native_books_incomplete"
  ) {
    return { allowed: false, reason: "incomplete_book_match" };
  }
  const driftBad =
    args.drift == null || args.drift.incomplete || !Number.isFinite(args.drift.maxBps);
  if (driftBad) {
    if (args.guard.botFallbackRequireMatchedBooks) {
      return { allowed: false, reason: "drift_unavailable" };
    }
    return { allowed: true, reason: "fallback_ok" };
  }
  if (args.drift!.maxBps >= args.guard.botFallbackMaxDriftBps) {
    return { allowed: false, reason: "drift_too_high" };
  }
  return { allowed: true, reason: "fallback_ok" };
}
