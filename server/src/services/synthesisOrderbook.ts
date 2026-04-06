/**
 * In-memory Polymarket orderbook state from Synthesis WS (snapshot + deltas).
 */

import type { MarketContext } from "../types/index.js";
import type { SynthesisOrderbookEnvelope } from "./synthesisTypes.js";

export type TokenBookState = {
  tokenId: string;
  bids: Map<string, number>;
  asks: Map<string, number>;
  lastUpdateMs: number;
  hash?: string;
};

function numFromStr(s: string | undefined): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function bestBid(bids: Map<string, number>): number {
  let best = -Infinity;
  for (const p of bids.keys()) {
    const n = Number(p);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best === -Infinity ? 0 : best;
}

function bestAsk(asks: Map<string, number>): number {
  let best = Infinity;
  for (const p of asks.keys()) {
    const n = Number(p);
    if (Number.isFinite(n) && n < best) best = n;
  }
  return best === Infinity ? 1 : best;
}

/** Best bids first (highest price = near touch). */
function bidDepthSumNearTouch(m: Map<string, number>, take: number): number {
  const entries = [...m.entries()]
    .map(([k, v]) => ({ p: Number(k), v }))
    .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.v));
  entries.sort((a, b) => b.p - a.p);
  let s = 0;
  for (let i = 0; i < Math.min(take, entries.length); i++) {
    s += entries[i]!.v;
  }
  return s;
}

/** Best asks first (lowest price = near touch). */
function askDepthSumNearTouch(m: Map<string, number>, take: number): number {
  const entries = [...m.entries()]
    .map(([k, v]) => ({ p: Number(k), v }))
    .filter((x) => Number.isFinite(x.p) && Number.isFinite(x.v));
  entries.sort((a, b) => a.p - b.p);
  let s = 0;
  for (let i = 0; i < Math.min(take, entries.length); i++) {
    s += entries[i]!.v;
  }
  return s;
}

export class SynthesisPolymarketOrderbookStore {
  private byToken = new Map<string, TokenBookState>();

  clear(): void {
    this.byToken.clear();
  }

  getState(tokenId: string): TokenBookState | undefined {
    return this.byToken.get(tokenId);
  }

  ingestRawMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const env = parsed as SynthesisOrderbookEnvelope;
    const resp = env.response;
    if (!resp) return;

    if (Array.isArray(resp.orderbooks)) {
      for (const ob of resp.orderbooks) {
        if (ob?.venue !== "polymarket" || !ob.orderbook?.token_id) continue;
        this.applySnapshot(ob.orderbook);
      }
      return;
    }

    if (resp.venue === "polymarket" && resp.delta?.token_id) {
      this.applyDelta(resp.delta);
    }
  }

  private applySnapshot(ob: {
    token_id: string;
    bids: Record<string, string>;
    asks: Record<string, string>;
    best_bid?: string;
    best_ask?: string;
    hash?: string;
  }): void {
    const bids = new Map<string, number>();
    const asks = new Map<string, number>();
    for (const [k, v] of Object.entries(ob.bids ?? {})) {
      const sz = Number(v);
      if (Number.isFinite(sz) && sz > 0) bids.set(k, sz);
    }
    for (const [k, v] of Object.entries(ob.asks ?? {})) {
      const sz = Number(v);
      if (Number.isFinite(sz) && sz > 0) asks.set(k, sz);
    }
    this.byToken.set(ob.token_id, {
      tokenId: ob.token_id,
      bids,
      asks,
      lastUpdateMs: Date.now(),
      hash: ob.hash
    });
  }

  private applyDelta(delta: NonNullable<SynthesisOrderbookEnvelope["response"]>["delta"]): void {
    if (!delta?.token_id) return;
    const cur =
      this.byToken.get(delta.token_id) ??
      ({
        tokenId: delta.token_id,
        bids: new Map(),
        asks: new Map(),
        lastUpdateMs: Date.now()
      } as TokenBookState);

    const side = String(delta.side ?? "").toUpperCase();
    const price = delta.price != null ? String(delta.price) : null;
    const amt = numFromStr(delta.amount);
    if (price && amt != null) {
      const map = side === "SELL" ? cur.asks : cur.bids;
      if (amt <= 0) {
        map.delete(price);
      } else {
        map.set(price, amt);
      }
    }

    const bbNum = numFromStr(delta.best_bid != null ? String(delta.best_bid) : undefined);
    if (bbNum != null) {
      for (const p of [...cur.bids.keys()]) {
        const pk = Number(p);
        if (Number.isFinite(pk) && pk > bbNum + 1e-9) cur.bids.delete(p);
      }
    }
    const baNum = numFromStr(delta.best_ask != null ? String(delta.best_ask) : undefined);
    if (baNum != null) {
      for (const p of [...cur.asks.keys()]) {
        const pk = Number(p);
        if (Number.isFinite(pk) && pk < baNum - 1e-9) cur.asks.delete(p);
      }
    }
    cur.lastUpdateMs = Date.now();
    if (delta.hash) cur.hash = delta.hash;
    this.byToken.set(delta.token_id, cur);
  }

  toMarketContext(tokenId: string): MarketContext | null {
    const st = this.byToken.get(tokenId);
    if (!st) return null;
    const bb = bestBid(st.bids);
    const ba = bestAsk(st.asks);
    if (!(ba > bb) || !(bb >= 0 && ba <= 1)) {
      return {
        tokenID: tokenId,
        mid: 0.5,
        spread: 1,
        liquidity: 0,
        bestBid: bb,
        bestAsk: ba
      };
    }
    const mid = (bb + ba) / 2;
    const spread = ba - bb;
    const liquidity = bidDepthSumNearTouch(st.bids, 6) + askDepthSumNearTouch(st.asks, 6);
    return {
      tokenID: tokenId,
      mid,
      spread,
      liquidity,
      bestBid: bb,
      bestAsk: ba
    };
  }

  isStale(tokenId: string, staleMs: number, nowMs: number): boolean {
    const st = this.byToken.get(tokenId);
    if (!st) return true;
    return nowMs - st.lastUpdateMs > staleMs;
  }
}
