import type { OhlcCandle } from "./professionalTypes.js";

function wickDominanceLast3(candles: OhlcCandle[]): boolean {
  const last = candles.slice(-3);
  if (last.length < 3) return false;
  let bad = 0;
  for (const c of last) {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range <= 1e-12) continue;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const maxWick = Math.max(upperWick, lowerWick);
    if (maxWick > 1.5 * Math.max(body, range * 1e-6)) bad += 1;
  }
  return bad >= 2;
}

/** True = higher highs across last 4 closes. */
function higherHighs(candles: OhlcCandle[]): boolean {
  const c = candles.slice(-4).map((x) => x.close);
  if (c.length < 4) return false;
  for (let i = 1; i < c.length; i++) {
    if (!(c[i]! > c[i - 1]!)) return false;
  }
  return true;
}

function lowerLows(candles: OhlcCandle[]): boolean {
  const c = candles.slice(-4).map((x) => x.close);
  if (c.length < 4) return false;
  for (let i = 1; i < c.length; i++) {
    if (!(c[i]! < c[i - 1]!)) return false;
  }
  return true;
}

/** Anchor chop: price crosses anchor >= 3 times in last 5 candle closes vs opens. */
export function anchorChopCount(candles: OhlcCandle[], anchor: number): number {
  const last = candles.slice(-5);
  if (last.length < 2 || !Number.isFinite(anchor) || anchor <= 0) return 0;
  let crosses = 0;
  for (let i = 1; i < last.length; i++) {
    const a = last[i - 1]!.close - anchor;
    const b = last[i]!.close - anchor;
    if (a === 0 || b === 0) crosses += 1;
    else if (a * b < 0) crosses += 1;
  }
  return crosses;
}

export type MarketFilterResult = { skip: boolean; reason: string };

/**
 * Mandatory market filter — any TRUE → skip (stay IDLE).
 * Uses structure from OHLC only (no RSI/MACD etc.).
 */
export function shouldSkipMarket(input: {
  candles: OhlcCandle[];
  imbalanceFlipsLast10: number;
  anchorUsd: number;
}): MarketFilterResult {
  const { candles, imbalanceFlipsLast10, anchorUsd } = input;
  if (candles.length < 5) {
    return { skip: true, reason: "need>=5 synthetic 1m candles" };
  }
  if (wickDominanceLast3(candles)) {
    return { skip: true, reason: "wick_dominance_2of3" };
  }
  if (imbalanceFlipsLast10 >= 3) {
    return { skip: true, reason: `book_flip_count_${imbalanceFlipsLast10}` };
  }
  if (anchorChopCount(candles, anchorUsd) >= 3) {
    return { skip: true, reason: "anchor_chop>=3" };
  }
  if (!higherHighs(candles) && !lowerLows(candles)) {
    return { skip: true, reason: "no_follow_through_hh_or_ll_last4" };
  }
  return { skip: false, reason: "ok" };
}
