import { describe, expect, it } from "vitest";
import {
  classifyDriftLevel,
  computeAgeStale,
  computeNativeOrderbookStale,
  computeNativeSynthesisDrift,
  evaluateSynthesisBotFallbackEligibility,
  hasValidTopOfBook,
  loadSynthesisGuardrailConfigFromEnv,
  priceDiffBps
} from "../src/services/marketDataHealth.js";
import type { DirectionalContext, MarketContext } from "../src/types/index.js";

const mc = (bid: number, ask: number): MarketContext => ({
  tokenID: "t",
  bestBid: bid,
  bestAsk: ask,
  mid: (bid + ask) / 2,
  spread: ask - bid,
  liquidity: 100
});

const guard = (): ReturnType<typeof loadSynthesisGuardrailConfigFromEnv> => ({
  driftWarnBps: 150,
  driftCriticalBps: 400,
  driftRequireBothSides: true,
  driftLogThrottleMs: 10_000,
  nativeBookStaleMs: 15_000,
  synthesisOrderbookStaleMs: 15_000,
  synthesisPriceStaleMs: 15_000,
  synthesisTradesStaleMs: 60_000,
  botFallbackMaxDriftBps: 300,
  botFallbackRequireMatchedBooks: true
});

describe("marketDataHealth", () => {
  it("priceDiffBps matches 0–1 scale", () => {
    expect(priceDiffBps(0.5, 0.51)).toBeCloseTo(100, 5);
  });

  it("classifyDriftLevel", () => {
    expect(classifyDriftLevel(50, 150, 400)).toBe("ok");
    expect(classifyDriftLevel(200, 150, 400)).toBe("warn");
    expect(classifyDriftLevel(500, 150, 400)).toBe("critical");
  });

  it("hasValidTopOfBook rejects empty cross", () => {
    expect(hasValidTopOfBook(mc(0, 1))).toBe(false);
    expect(hasValidTopOfBook(mc(0.4, 0.6))).toBe(true);
  });

  it("computeNativeSynthesisDrift ok when books align", () => {
    const native: DirectionalContext = { up: mc(0.4, 0.42), down: mc(0.58, 0.6) };
    const syn: DirectionalContext = { up: mc(0.4, 0.42), down: mc(0.58, 0.6) };
    const d = computeNativeSynthesisDrift(native, syn.up, syn.down, guard(), Date.now());
    expect(d.incomplete).toBe(false);
    expect(d.level).toBe("ok");
    expect(d.maxBps).toBe(0);
  });

  it("computeNativeSynthesisDrift warns on moderate drift", () => {
    const native: DirectionalContext = { up: mc(0.4, 0.42), down: mc(0.58, 0.6) };
    const syn: DirectionalContext = { up: mc(0.42, 0.44), down: mc(0.56, 0.58) };
    const d = computeNativeSynthesisDrift(native, syn.up, syn.down, guard(), Date.now());
    expect(d.level).toBe("warn");
    expect(d.maxBps).toBeGreaterThan(150);
    expect(d.maxBps).toBeLessThan(400);
  });

  it("computeNativeSynthesisDrift incomplete when native books incomplete and requireBothSides", () => {
    const g = { ...guard(), driftRequireBothSides: true };
    const native: DirectionalContext = { up: mc(0, 1), down: mc(0.58, 0.6) };
    const syn: DirectionalContext = { up: mc(0.4, 0.42), down: mc(0.58, 0.6) };
    const d = computeNativeSynthesisDrift(native, syn.up, syn.down, g, Date.now());
    expect(d.incomplete).toBe(true);
    expect(d.incompleteReason).toBe("native_books_incomplete");
  });

  it("evaluateSynthesisBotFallbackEligibility blocks excessive drift", () => {
    const g = guard();
    const drift = {
      comparedAtMs: Date.now(),
      maxBps: 350,
      level: "warn" as const,
      perOutcome: [],
      incomplete: false
    };
    const r = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: true,
      botFallbackEnabled: true,
      nativeBookStale: true,
      synthesisOrderbookStale: false,
      synthesisReady: true,
      drift,
      guard: g
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("drift_too_high");
  });

  it("evaluateSynthesisBotFallbackEligibility allows when drift below max", () => {
    const g = guard();
    const drift = {
      comparedAtMs: Date.now(),
      maxBps: 100,
      level: "ok" as const,
      perOutcome: [],
      incomplete: false
    };
    const r = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: true,
      botFallbackEnabled: true,
      nativeBookStale: true,
      synthesisOrderbookStale: false,
      synthesisReady: true,
      drift,
      guard: g
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("fallback_ok");
  });

  it("evaluateSynthesisBotFallbackEligibility native_fresh blocks", () => {
    const r = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: true,
      botFallbackEnabled: true,
      nativeBookStale: false,
      synthesisOrderbookStale: false,
      synthesisReady: true,
      drift: null,
      guard: guard()
    });
    expect(r.reason).toBe("native_fresh");
  });

  it("evaluateSynthesisBotFallbackEligibility incomplete_book_match when native books incomplete", () => {
    const drift = {
      comparedAtMs: Date.now(),
      maxBps: Number.POSITIVE_INFINITY,
      level: "critical" as const,
      perOutcome: [] as [],
      incomplete: true,
      incompleteReason: "native_books_incomplete" as const
    };
    const r = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: true,
      botFallbackEnabled: true,
      nativeBookStale: true,
      synthesisOrderbookStale: false,
      synthesisReady: true,
      drift,
      guard: guard()
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("incomplete_book_match");
  });

  it("evaluateSynthesisBotFallbackEligibility drift_unavailable when require matched and drift incomplete", () => {
    const g = { ...guard(), botFallbackRequireMatchedBooks: true };
    const drift = {
      comparedAtMs: Date.now(),
      maxBps: 0,
      level: "ok" as const,
      perOutcome: [],
      incomplete: true
    };
    const r = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: true,
      botFallbackEnabled: true,
      nativeBookStale: true,
      synthesisOrderbookStale: false,
      synthesisReady: true,
      drift,
      guard: g
    });
    expect(r.reason).toBe("drift_unavailable");
  });

  it("evaluateSynthesisBotFallbackEligibility allows fallback when drift incomplete but matched-books not required", () => {
    const g = { ...guard(), botFallbackRequireMatchedBooks: false };
    const drift = {
      comparedAtMs: Date.now(),
      maxBps: 0,
      level: "ok" as const,
      perOutcome: [],
      incomplete: true
    };
    const r = evaluateSynthesisBotFallbackEligibility({
      synthesisEnabled: true,
      botFallbackEnabled: true,
      nativeBookStale: true,
      synthesisOrderbookStale: false,
      synthesisReady: true,
      drift,
      guard: g
    });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("fallback_ok");
  });

  it("computeNativeOrderbookStale and computeAgeStale expose staleReason", () => {
    const now = 1_000_000;
    const ob = computeNativeOrderbookStale(null, now, 5000);
    expect(ob.stale).toBe(true);
    expect(ob.staleReason).toBe("never_updated");
    expect(ob.lastUpdateMs).toBeNull();

    const ob2 = computeNativeOrderbookStale(now - 10_000, now, 5000);
    expect(ob2.stale).toBe(true);
    expect(ob2.staleReason).toBe("age_exceeded");
    expect(ob2.lastUpdateMs).toBe(now - 10_000);

    const ag = computeAgeStale(now - 100, now, 5000);
    expect(ag.stale).toBe(false);
    expect(ag.staleReason).toBeUndefined();
  });
});
