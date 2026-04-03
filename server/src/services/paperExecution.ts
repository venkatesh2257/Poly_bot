/**
 * Paper execution: same live CLOB order books, virtual fills (book walk, latency, limit timeout, fees, no-fill).
 * Live mode must not import this for order routing — engine gates on SIMULATION only.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * When true (default), paper BUY lifts to best ask if limit (mid) sits inside the spread — otherwise
 * mid < bestAsk never crosses and you only get no_fill_limit_uncrossed_or_no_liquidity.
 * Set PAPER_AGGRESSIVE_CROSS=false to require limit >= best ask (strict mid-only).
 */
function paperAggressiveCross(): boolean {
  const v = process.env.PAPER_AGGRESSIVE_CROSS;
  if (v == null || v === "") return true;
  const s = String(v).toLowerCase();
  return s !== "false" && s !== "0" && s !== "no";
}

export interface NormalizedLevel {
  price: number;
  size: number;
}

export interface NormalizedBook {
  bids: NormalizedLevel[];
  asks: NormalizedLevel[];
  bestBid: number | null;
  bestAsk: number | null;
}

export function normalizeRawOrderBook(raw: unknown): NormalizedBook | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { bids?: unknown; asks?: unknown };
  const bidsRaw = Array.isArray(o.bids) ? o.bids : [];
  const asksRaw = Array.isArray(o.asks) ? o.asks : [];

  const toPrice = (x: unknown) => {
    if (x && typeof x === "object" && "price" in x) return Number((x as { price: unknown }).price);
    return NaN;
  };
  const toSize = (x: unknown) => {
    if (x && typeof x === "object" && "size" in x) return Number((x as { size: unknown }).size);
    return 0;
  };

  const bids = bidsRaw
    .map((b) => ({ price: toPrice(b), size: toSize(b) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => b.price - a.price);

  const asks = asksRaw
    .map((a) => ({ price: toPrice(a), size: toSize(a) }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => a.price - b.price);

  const bestBid = bids.length ? bids[0]!.price : null;
  const bestAsk = asks.length ? asks[0]!.price : null;
  return { bids, asks, bestBid, bestAsk };
}

function randomLatencyMs(): number {
  const lo = envNum("PAPER_LATENCY_MS_MIN", 50);
  const hi = envNum("PAPER_LATENCY_MS_MAX", 280);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.round(a + Math.random() * (b - a));
}

function simulatedExecutionFailure(): boolean {
  const pct = envNum("PAPER_EXEC_FAILURE_PCT", 5);
  const p = Math.min(100, Math.max(0, pct)) / 100;
  return Math.random() < p;
}

/** BUY: walk asks up to limitPrice; return vwap and filled shares. */
function walkBuyLimit(
  asks: NormalizedLevel[],
  sizeShares: number,
  limitPrice: number
): { filled: number; cost: number; partial: boolean } {
  let filled = 0;
  let cost = 0;
  for (const lvl of asks) {
    if (lvl.price > limitPrice + 1e-12) break;
    if (filled >= sizeShares - 1e-12) break;
    const need = sizeShares - filled;
    const take = Math.min(need, lvl.size);
    if (take <= 0) continue;
    cost += take * lvl.price;
    filled += take;
  }
  const partial = filled > 0 && filled < sizeShares - 1e-9;
  return { filled, cost, partial };
}

/** SELL: walk bids down from best; limit is minimum acceptable price. */
function walkSellLimit(
  bids: NormalizedLevel[],
  sizeShares: number,
  limitPrice: number
): { filled: number; proceeds: number; partial: boolean } {
  let filled = 0;
  let proceeds = 0;
  for (const lvl of bids) {
    if (lvl.price < limitPrice - 1e-12) break;
    if (filled >= sizeShares - 1e-12) break;
    const need = sizeShares - filled;
    const take = Math.min(need, lvl.size);
    if (take <= 0) continue;
    proceeds += take * lvl.price;
    filled += take;
  }
  const partial = filled > 0 && filled < sizeShares - 1e-9;
  return { filled, proceeds, partial };
}

function slippageBps(reference: number, vwap: number): number {
  if (!Number.isFinite(reference) || reference <= 0 || !Number.isFinite(vwap)) return 0;
  return Math.round(((vwap - reference) / reference) * 10_000);
}

export interface PaperFillSuccess {
  ok: true;
  vwap: number;
  filledShares: number;
  notionalUsd: number;
  feesUsd: number;
  partial: boolean;
  latencyMs: number;
  slippageBps: number;
  referencePrice: number;
}

export interface PaperFillFailure {
  ok: false;
  reason: string;
  latencyMs: number;
}

export type PaperFillResult = PaperFillSuccess | PaperFillFailure;

export interface PaperLimitBuyParams {
  limitPrice: number;
  sizeShares: number;
  fetchBook: () => Promise<unknown | null>;
  feeRate?: number;
  limitTimeoutSec?: number;
}

/**
 * Mirrors GTC-style limit at `limitPrice`: after latency, if bid does not cross, wait `limitTimeoutSec`, re-fetch once.
 * Crossing BUY: limitPrice >= best ask. Fill by walking the ask ladder up to limitPrice.
 */
export async function simulatePaperLimitBuy(params: PaperLimitBuyParams): Promise<PaperFillResult> {
  const feeRate = params.feeRate ?? envNum("PAPER_TAKER_FEE_RATE", 0.003);
  const limitTimeoutSec = params.limitTimeoutSec ?? envNum("PAPER_LIMIT_TIMEOUT_SEC", 1.5);
  const t0 = Date.now();
  await sleep(randomLatencyMs());
  const latencyPre = Date.now() - t0;

  if (simulatedExecutionFailure()) {
    return { ok: false, reason: "simulated_execution_failure", latencyMs: latencyPre };
  }

  const tryOnce = async (): Promise<PaperFillSuccess | null> => {
    const raw = await params.fetchBook();
    const nb = normalizeRawOrderBook(raw);
    if (!nb || nb.bestAsk == null) return null;
    let walkLimit = params.limitPrice;
    if (paperAggressiveCross() && nb.bestAsk > params.limitPrice + 1e-12) {
      walkLimit = Math.min(0.999, Math.max(params.limitPrice, nb.bestAsk));
    }
    if (walkLimit + 1e-12 < nb.bestAsk) return null;
    const ref = nb.bestAsk;
    const { filled, cost, partial } = walkBuyLimit(nb.asks, params.sizeShares, walkLimit);
    if (filled <= 0) return null;
    const vwap = cost / filled;
    const feesUsd = cost * feeRate;
    return {
      ok: true,
      vwap,
      filledShares: filled,
      notionalUsd: cost,
      feesUsd,
      partial,
      latencyMs: Date.now() - t0,
      slippageBps: slippageBps(ref, vwap),
      referencePrice: ref
    };
  };

  const first = await tryOnce();
  if (first) return first;

  await sleep(Math.max(0, limitTimeoutSec) * 1000);

  if (simulatedExecutionFailure()) {
    return { ok: false, reason: "simulated_execution_failure_after_wait", latencyMs: Date.now() - t0 };
  }

  const second = await tryOnce();
  if (second) return second;

  return { ok: false, reason: "no_fill_limit_uncrossed_or_no_liquidity", latencyMs: Date.now() - t0 };
}

export interface PaperMarketSellParams {
  sizeShares: number;
  fetchBook: () => Promise<unknown | null>;
  /** Minimum bid price to hit (default 0.01 ≈ sweep bids). */
  minBid?: number;
  feeRate?: number;
}

/** Aggressive exit: walk bid side (market-style). */
export async function simulatePaperMarketSell(params: PaperMarketSellParams): Promise<PaperFillResult> {
  const feeRate = params.feeRate ?? envNum("PAPER_TAKER_FEE_RATE", 0.003);
  const minBid = params.minBid ?? envNum("PAPER_EXIT_MIN_BID", 0.01);
  const t0 = Date.now();
  await sleep(randomLatencyMs());

  if (simulatedExecutionFailure()) {
    return { ok: false, reason: "simulated_execution_failure_exit", latencyMs: Date.now() - t0 };
  }

  const raw = await params.fetchBook();
  const nb = normalizeRawOrderBook(raw);
  if (!nb || nb.bestBid == null) {
    return { ok: false, reason: "no_book_exit", latencyMs: Date.now() - t0 };
  }
  const ref = nb.bestBid;
  const { filled, proceeds, partial } = walkSellLimit(nb.bids, params.sizeShares, minBid);
  if (filled <= 0) {
    return { ok: false, reason: "no_bid_liquidity_exit", latencyMs: Date.now() - t0 };
  }
  const vwap = proceeds / filled;
  const feesUsd = proceeds * feeRate;
  return {
    ok: true,
    vwap,
    filledShares: filled,
    notionalUsd: proceeds,
    feesUsd,
    partial,
    latencyMs: Date.now() - t0,
    slippageBps: slippageBps(ref, vwap),
    referencePrice: ref
  };
}

/** Unified hook: paper vs live is decided by caller; this is paper-only fill. */
export async function executePaperLimitBuyOrder(
  params: PaperLimitBuyParams
): Promise<PaperFillResult> {
  return simulatePaperLimitBuy(params);
}
