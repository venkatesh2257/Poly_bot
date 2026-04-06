/**
 * Synthesis Polymarket trades buffer (historical + live).
 */

import type { SynthesisTradesEnvelope } from "./synthesisTypes.js";

export type NormalizedSynthesisTrade = {
  venue: "polymarket";
  tokenId: string;
  price: number;
  shares: number;
  notionalUsd: number;
  side: "buy" | "sell" | "unknown";
  aggressor: "buy" | "sell" | "unknown";
  txHash?: string;
  createdAtMs: number;
  /** Raw source timestamp string if parse failed */
  createdAtRaw?: string;
};

export class SynthesisTradesBuffer {
  private ring: NormalizedSynthesisTrade[] = [];
  private readonly cap: number;

  constructor(maxItems: number) {
    this.cap = Math.max(10, Math.min(10_000, maxItems));
  }

  clear(): void {
    this.ring = [];
  }

  getRecent(): NormalizedSynthesisTrade[] {
    return [...this.ring];
  }

  ingestRawMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const env = parsed as SynthesisTradesEnvelope;
    const resp = env.response;
    if (!resp) return;

    if (Array.isArray(resp.trades)) {
      for (const row of resp.trades) {
        if (row?.venue !== "polymarket" || !row.trade) continue;
        const n = this.normalize(row.trade);
        if (n) this.push(n);
      }
      return;
    }

    if (resp.venue === "polymarket" && resp.trade?.token_id) {
      const n = this.normalize(resp.trade);
      if (n) this.push(n);
    }
  }

  private push(t: NormalizedSynthesisTrade): void {
    this.ring = [t, ...this.ring].slice(0, this.cap);
  }

  private normalize(tr: {
    token_id?: string;
    price?: string;
    shares?: string;
    amount?: string;
    side?: boolean;
    tx_hash?: string;
    created_at?: string;
  }): NormalizedSynthesisTrade | null {
    const tokenId = String(tr.token_id ?? "");
    if (!tokenId) return null;
    const price = Number(tr.price ?? NaN);
    const shares = Number(tr.shares ?? tr.amount ?? NaN);
    if (!Number.isFinite(price) || !Number.isFinite(shares)) return null;
    const notional = Math.abs(price * shares);
    const sideBool = tr.side;
    const side: NormalizedSynthesisTrade["side"] =
      typeof sideBool === "boolean" ? (sideBool ? "buy" : "sell") : "unknown";
    const createdAtRaw = String(tr.created_at ?? "");
    const createdAtMs = Date.parse(createdAtRaw);
    return {
      venue: "polymarket",
      tokenId,
      price,
      shares,
      notionalUsd: notional,
      side,
      aggressor: side,
      txHash: tr.tx_hash ? String(tr.tx_hash) : undefined,
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      createdAtRaw: Number.isFinite(createdAtMs) ? undefined : createdAtRaw || undefined
    };
  }
}
