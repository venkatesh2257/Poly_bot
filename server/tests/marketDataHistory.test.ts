import { describe, expect, it } from "vitest";
import { driftLevelToCode, SynthesisMarketDataHistory } from "../src/services/marketDataHistory.js";
import type { SynthesisMarketDataHealthPayload } from "../src/types/index.js";

function baseHealth(over: Partial<SynthesisMarketDataHealthPayload> = {}): SynthesisMarketDataHealthPayload {
  const h: SynthesisMarketDataHealthPayload = {
    drift: {
      level: "ok",
      maxBps: 10,
      comparedAtMs: 1,
      perOutcome: [
        { outcome: "up", bidBps: 5, askBps: 5, midBps: 2, spreadDeltaBps: 1 },
        { outcome: "down", bidBps: 6, askBps: 4, midBps: 1, spreadDeltaBps: 0 }
      ],
      incomplete: false
    },
    staleness: {
      nativeOrderbook: { stale: false, ageMs: 100, thresholdMs: 15_000, lastUpdateMs: 1, staleReason: undefined },
      synthesisOrderbook: { stale: false, ageMs: 200, thresholdMs: 15_000, lastUpdateMs: 2, staleReason: undefined },
      synthesisTrades: { stale: false, ageMs: 300, thresholdMs: 60_000, lastUpdateMs: 3, staleReason: undefined },
      synthesisPrices: { stale: false, ageMs: 400, thresholdMs: 15_000, lastUpdateMs: 4, staleReason: undefined }
    },
    fallbackEligible: false,
    fallbackBlockReason: "native_fresh",
    ...over
  };
  return h;
}

describe("marketDataHistory", () => {
  it("driftLevelToCode", () => {
    expect(driftLevelToCode("ok")).toBe(0);
    expect(driftLevelToCode("warn")).toBe(1);
    expect(driftLevelToCode("critical")).toBe(2);
  });

  it("caps samples at maxPoints", () => {
    const h = new SynthesisMarketDataHistory({ maxPoints: 5, sampleMs: 0, maxEvents: 20 });
    let t = 1000;
    for (let i = 0; i < 12; i++) {
      h.observe(t, baseHealth());
      t += 10;
    }
    expect(h.getSampleCount()).toBe(5);
    const w = h.getWirePayload();
    expect(w.t.length).toBe(5);
    expect(w.mb.length).toBe(5);
  });

  it("samples respect sampleMs spacing", () => {
    const h = new SynthesisMarketDataHistory({ maxPoints: 100, sampleMs: 1000, maxEvents: 20 });
    h.observe(1000, baseHealth());
    h.observe(1500, baseHealth());
    expect(h.getSampleCount()).toBe(1);
    h.observe(2000, baseHealth());
    expect(h.getSampleCount()).toBe(2);
  });

  it("records drift warn transition", () => {
    const h = new SynthesisMarketDataHistory({ maxPoints: 50, sampleMs: 0, maxEvents: 20 });
    h.observe(1, baseHealth({ drift: { ...baseHealth().drift, level: "ok", maxBps: 10 } }));
    h.observe(2, baseHealth({ drift: { ...baseHealth().drift, level: "warn", maxBps: 200 } }));
    const w = h.getWirePayload();
    const kinds = w.events.map((e) => e.k);
    expect(kinds).toContain("drift_warn");
  });

  it("records fallback blocked by drift", () => {
    const h = new SynthesisMarketDataHistory({ maxPoints: 50, sampleMs: 0, maxEvents: 20 });
    const okFb = baseHealth({
      fallbackEligible: true,
      fallbackBlockReason: "fallback_ok",
      drift: { ...baseHealth().drift, level: "ok", maxBps: 50 }
    });
    h.observe(1, okFb);
    const blocked = baseHealth({
      fallbackEligible: false,
      fallbackBlockReason: "drift_too_high",
      drift: { ...baseHealth().drift, level: "warn", maxBps: 500 }
    });
    h.observe(2, blocked);
    expect(h.getWirePayload().events.some((e) => e.k === "fb_drift")).toBe(true);
  });

  it("serializes wire shape with parallel arrays", () => {
    const h = new SynthesisMarketDataHistory({ maxPoints: 10, sampleMs: 0, maxEvents: 8 });
    h.observe(100, baseHealth());
    const w = h.getWirePayload();
    expect(w.maxPoints).toBe(10);
    expect(w.sampleMs).toBe(0);
    expect(Array.isArray(w.t)).toBe(true);
    expect(w.t.length).toBe(w.mb.length);
    expect(w.t.length).toBe(w.lv.length);
    expect(w.t.length).toBe(w.ub.length);
    expect(w.fb.length).toBe(w.mb.length);
    expect(w.events.length).toBeGreaterThanOrEqual(0);
    expect(w.lastEvent == null || typeof w.lastEvent.t === "number").toBe(true);
  });

  it("caps events", () => {
    const h = new SynthesisMarketDataHistory({ maxPoints: 100, sampleMs: 0, maxEvents: 3 });
    for (let i = 0; i < 10; i++) {
      h.observe(i * 2, baseHealth({ drift: { ...baseHealth().drift, level: i % 2 === 0 ? "ok" : "warn", maxBps: 100 + i } }));
    }
    expect(h.getEventCount()).toBeLessThanOrEqual(3);
    expect(h.getWirePayload().events.length).toBeLessThanOrEqual(3);
  });
});
