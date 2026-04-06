/**
 * Synthesis data WS — `prices` / `prices_chainlink` rolling series for dashboard charts.
 */

import type { SynthesisDataPricesEnvelope } from "./synthesisTypes.js";

export type PriceChartPoint = {
  t: number;
  priceUsd: number;
  source: "prices" | "prices_chainlink";
};

export class SynthesisPriceSeriesBuffer {
  private points: PriceChartPoint[] = [];
  private lastUpdateMs = 0;
  private readonly maxPoints: number;

  constructor(maxPoints = 400) {
    this.maxPoints = Math.max(50, Math.min(2000, maxPoints));
  }

  clear(): void {
    this.points = [];
    this.lastUpdateMs = 0;
  }

  getLastUpdateMs(): number {
    return this.lastUpdateMs;
  }

  getPoints(): PriceChartPoint[] {
    return [...this.points];
  }

  getLastPriceUsd(): number | null {
    const p = this.points.at(-1);
    return p ? p.priceUsd : null;
  }

  ingestRawMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const env = parsed as SynthesisDataPricesEnvelope;
    const resp = env.response;
    if (!resp?.data_type || !resp.data) return;
    const dt = String(resp.data_type);
    if (dt !== "prices" && dt !== "prices_chainlink") return;

    const src: PriceChartPoint["source"] = dt === "prices_chainlink" ? "prices_chainlink" : "prices";
    const d = resp.data;

    if (typeof d.price === "number" && Number.isFinite(d.price) && typeof d.timestamp === "number") {
      this.pushPoint(d.timestamp, d.price, src);
      return;
    }

    const prices = Array.isArray(d.prices) ? d.prices : [];
    const times = Array.isArray(d.timestamps) ? d.timestamps : [];
    if (prices.length === 0) {
      const cp = typeof d.current_price === "number" ? d.current_price : null;
      if (cp != null && Number.isFinite(cp)) {
        this.pushPoint(Date.now(), cp, src);
      }
      return;
    }
    for (let i = 0; i < prices.length; i++) {
      const px = prices[i];
      const ts = typeof times[i] === "number" ? (times[i] as number) : Date.now() - (prices.length - i) * 1000;
      if (typeof px === "number" && Number.isFinite(px)) {
        this.pushPoint(ts, px, src);
      }
    }
  }

  private pushPoint(t: number, priceUsd: number, source: PriceChartPoint["source"]): void {
    const last = this.points.at(-1);
    if (last && last.t === t && last.priceUsd === priceUsd) {
      this.lastUpdateMs = Date.now();
      return;
    }
    this.points = [...this.points, { t, priceUsd, source }].slice(-this.maxPoints);
    this.lastUpdateMs = Date.now();
  }
}
