/**
 * Polymarket CLOB public batch order books — one POST /books replaces N GET /book round-trips.
 * Mirrors `@polymarket/clob-client` `getOrderBooks` (same endpoint and body shape).
 */
import { Side } from "@polymarket/clob-client";

const DEFAULT_CHUNK = 50;

function normalizeHost(host: string): string {
  return host.replace(/\/$/, "");
}

/**
 * @returns Map token_id (asset_id) → raw order book JSON (bids/asks arrays).
 */
/** Batch public CLOB books — `getBooks(tokenIds)` equivalent (POST `/books`). */
export async function batchBook(
  clobHost: string,
  tokenIds: string[],
  timeoutMs: number,
  maxPerRequest = DEFAULT_CHUNK
): Promise<Map<string, unknown>> {
  const host = normalizeHost(clobHost);
  const unique = [...new Set(tokenIds.map((t) => String(t).trim()).filter(Boolean))];
  const out = new Map<string, unknown>();

  for (let i = 0; i < unique.length; i += maxPerRequest) {
    const chunk = unique.slice(i, i + maxPerRequest);
    const body = chunk.map((token_id) => ({ token_id, side: Side.BUY }));
    try {
      const res = await fetch(`${host}/books`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "PolyBot/1.0 (batch book)"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) continue;
      const arr = (await res.json()) as unknown;
      if (!Array.isArray(arr)) continue;
      for (const book of arr) {
        const b = book as { asset_id?: string | number };
        if (b?.asset_id == null) continue;
        out.set(String(b.asset_id), book);
      }
    } catch {
      /* chunk failed — caller may fall back per-token */
    }
  }

  return out;
}

/** Same as {@link batchBook} — maps to Polymarket `getOrderBooks` / REST `POST /books`. */
export async function getBooks(
  clobHost: string,
  tokenIds: string[],
  timeoutMs: number,
  maxPerRequest?: number
): Promise<Map<string, unknown>> {
  return batchBook(clobHost, tokenIds, timeoutMs, maxPerRequest ?? DEFAULT_CHUNK);
}
