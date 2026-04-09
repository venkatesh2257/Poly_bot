import type { OhlcCandle } from "./professionalTypes.js";

export type OracleSpotSample = { tMs: number; price: number };

/** Build 1m OHLC buckets from Chainlink spot samples (no external TA feeds). */
export function buildOneMinuteCandles(samples: OracleSpotSample[], nowMs: number, maxBars: number): OhlcCandle[] {
  if (samples.length === 0 || maxBars <= 0) return [];
  const bucketMs = 60_000;
  const startMs = nowMs - maxBars * bucketMs;
  const filtered = samples.filter((s) => s.tMs >= startMs && s.tMs <= nowMs && Number.isFinite(s.price) && s.price > 0);
  if (filtered.length === 0) return [];

  const byBucket = new Map<number, number[]>();
  for (const s of filtered) {
    const b = Math.floor(s.tMs / bucketMs) * bucketMs;
    let arr = byBucket.get(b);
    if (!arr) {
      arr = [];
      byBucket.set(b, arr);
    }
    arr.push(s.price);
  }

  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  const out: OhlcCandle[] = [];
  for (const k of keys) {
    const px = byBucket.get(k)!;
    if (px.length === 0) continue;
    const open = px[0]!;
    const close = px[px.length - 1]!;
    let high = open;
    let low = open;
    for (const p of px) {
      high = Math.max(high, p);
      low = Math.min(low, p);
    }
    out.push({ tOpenMs: k, open, high, low, close });
  }
  return out.slice(-maxBars);
}
