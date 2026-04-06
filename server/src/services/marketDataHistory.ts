/**
 * Bounded in-memory rolling history for Synthesis vs native observability (dashboard only).
 */

import type {
  DriftStatusLevel,
  SynthesisMarketDataHealthPayload,
  SynthesisMarketDataHistoryWirePayload
} from "../types/index.js";

export type SynthesisHistoryEventKind =
  | "drift_warn"
  | "drift_crit"
  | "drift_ok"
  | "syn_stale"
  | "syn_ok"
  | "nat_stale"
  | "nat_ok"
  | "fb_drift"
  | "fb_ok";

export type SynthesisHistoryConfig = {
  maxPoints: number;
  sampleMs: number;
  maxEvents: number;
};

export function loadSynthesisHistoryConfigFromEnv(): SynthesisHistoryConfig {
  const envNum = (k: string, fb: number) => {
    const n = Number(process.env[k]);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    maxPoints: Math.min(2000, Math.max(50, Math.floor(envNum("SYNTHESIS_HISTORY_MAX_POINTS", 500)))),
    sampleMs: Math.max(250, Math.floor(envNum("SYNTHESIS_HISTORY_SAMPLE_MS", 2000))),
    maxEvents: Math.min(200, Math.max(8, Math.floor(envNum("SYNTHESIS_HISTORY_MAX_EVENTS", 48))))
  };
}

/** 0 = ok, 1 = warn, 2 = critical — compact for charts. */
export function driftLevelToCode(level: DriftStatusLevel): 0 | 1 | 2 {
  if (level === "warn") return 1;
  if (level === "critical") return 2;
  return 0;
}

type Sample = {
  t: number;
  mb: number;
  lv: 0 | 1 | 2;
  ub: number;
  ua: number;
  db: number;
  da: number;
  na: number | null;
  so: number | null;
  sp: number | null;
  fb: 0 | 1;
};

export class SynthesisMarketDataHistory {
  private cfg: SynthesisHistoryConfig;
  private samples: Sample[] = [];
  private events: Array<{ t: number; k: SynthesisHistoryEventKind; d?: string }> = [];
  private lastSampleAt = 0;
  private prevLevel: DriftStatusLevel | null = null;
  private prevSynAnyStale: boolean | null = null;
  private prevNatStale: boolean | null = null;
  private prevFallbackEligible: boolean | null = null;

  constructor(cfg?: SynthesisHistoryConfig) {
    this.cfg = cfg ?? loadSynthesisHistoryConfigFromEnv();
  }

  /** For tests — replace config. */
  setConfig(cfg: SynthesisHistoryConfig): void {
    this.cfg = cfg;
  }

  observe(nowMs: number, health: SynthesisMarketDataHealthPayload): void {
    this.recordTransitions(nowMs, health);
    this.maybeAppendSample(nowMs, health);
  }

  private recordTransitions(nowMs: number, health: SynthesisMarketDataHealthPayload): void {
    const level = health.drift.level;
    const synAnyStale =
      health.staleness.synthesisOrderbook.stale || health.staleness.synthesisPrices.stale;
    const natStale = health.staleness.nativeOrderbook.stale;
    const eligible = health.fallbackEligible;

    if (this.prevLevel !== null) {
      if (level === "warn" && this.prevLevel === "ok") {
        this.pushEvent(nowMs, "drift_warn", `mb=${health.drift.maxBps.toFixed(0)}`);
      } else if (level === "critical" && (this.prevLevel === "ok" || this.prevLevel === "warn")) {
        this.pushEvent(nowMs, "drift_crit", `mb=${health.drift.maxBps.toFixed(0)}`);
      } else if (level === "ok" && this.prevLevel !== "ok") {
        this.pushEvent(nowMs, "drift_ok");
      }
    }

    if (this.prevSynAnyStale !== null) {
      if (synAnyStale && !this.prevSynAnyStale) {
        this.pushEvent(nowMs, "syn_stale");
      } else if (!synAnyStale && this.prevSynAnyStale) {
        this.pushEvent(nowMs, "syn_ok");
      }
    }

    if (this.prevNatStale !== null) {
      if (natStale && !this.prevNatStale) {
        this.pushEvent(nowMs, "nat_stale");
      } else if (!natStale && this.prevNatStale) {
        this.pushEvent(nowMs, "nat_ok");
      }
    }

    if (this.prevFallbackEligible !== null) {
      if (!eligible && this.prevFallbackEligible && health.fallbackBlockReason === "drift_too_high") {
        this.pushEvent(nowMs, "fb_drift");
      } else if (eligible && !this.prevFallbackEligible) {
        this.pushEvent(nowMs, "fb_ok");
      }
    }

    this.prevLevel = level;
    this.prevSynAnyStale = synAnyStale;
    this.prevNatStale = natStale;
    this.prevFallbackEligible = eligible;
  }

  private maybeAppendSample(nowMs: number, health: SynthesisMarketDataHealthPayload): void {
    if (nowMs - this.lastSampleAt < this.cfg.sampleMs && this.samples.length > 0) {
      return;
    }
    this.lastSampleAt = nowMs;

    const up = health.drift.perOutcome.find((p) => p.outcome === "up");
    const down = health.drift.perOutcome.find((p) => p.outcome === "down");
    const ub = up?.bidBps ?? 0;
    const ua = up?.askBps ?? 0;
    const db = down?.bidBps ?? 0;
    const da = down?.askBps ?? 0;

    const s: Sample = {
      t: nowMs,
      mb: Number.isFinite(health.drift.maxBps) ? health.drift.maxBps : 0,
      lv: driftLevelToCode(health.drift.level),
      ub,
      ua,
      db,
      da,
      na: health.staleness.nativeOrderbook.ageMs,
      so: health.staleness.synthesisOrderbook.ageMs,
      sp: health.staleness.synthesisPrices.ageMs,
      fb: health.fallbackEligible ? 1 : 0
    };

    this.samples.push(s);
    while (this.samples.length > this.cfg.maxPoints) {
      this.samples.shift();
    }
  }

  private pushEvent(t: number, k: SynthesisHistoryEventKind, d?: string): void {
    this.events.push(d === undefined ? { t, k } : { t, k, d });
    while (this.events.length > this.cfg.maxEvents) {
      this.events.shift();
    }
  }

  getWirePayload(): SynthesisMarketDataHistoryWirePayload {
    const last = this.events.length > 0 ? this.events[this.events.length - 1] : undefined;
    return {
      maxPoints: this.cfg.maxPoints,
      sampleMs: this.cfg.sampleMs,
      maxEvents: this.cfg.maxEvents,
      t: this.samples.map((x) => x.t),
      mb: this.samples.map((x) => x.mb),
      lv: this.samples.map((x) => x.lv),
      ub: this.samples.map((x) => x.ub),
      ua: this.samples.map((x) => x.ua),
      db: this.samples.map((x) => x.db),
      da: this.samples.map((x) => x.da),
      na: this.samples.map((x) => x.na),
      so: this.samples.map((x) => x.so),
      sp: this.samples.map((x) => x.sp),
      fb: this.samples.map((x) => x.fb),
      events: this.events.map((e) => (e.d === undefined ? { t: e.t, k: e.k } : { t: e.t, k: e.k, d: e.d })),
      lastEvent: last ? { t: last.t, k: last.k, ...(last.d !== undefined ? { d: last.d } : {}) } : undefined
    };
  }

  /** Test helpers */
  getSampleCount(): number {
    return this.samples.length;
  }

  getEventCount(): number {
    return this.events.length;
  }
}
