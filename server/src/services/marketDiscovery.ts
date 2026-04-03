/** Gamma API: active "{asset} Up or Down" 5m windows use slug `{asset}-updown-5m-{windowStartUnix}`. */

export type UpDownAsset = "BTC" | "ETH" | "SOL" | "XRP" | "DOGE";

export interface ResolvedUpDownMarket {
  tokenIdUp: string;
  tokenIdDown: string;
  label: string;
  endDate: string;
  slug: string;
}

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const WINDOW_SEC = 300;

const gammaFetch = (url: string) =>
  fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "PolyBot/1.0 (market discovery)"
    },
    signal: AbortSignal.timeout(12_000)
  });

function parseJsonStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.map((x) => String(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeAsset(asset: string): UpDownAsset | null {
  const u = asset.trim().toUpperCase();
  if (u === "BTC" || u === "ETH" || u === "SOL" || u === "XRP" || u === "DOGE") return u;
  return null;
}

function normalizeEventsPayload(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: unknown[] }).data;
  }
  return [];
}

/**
 * Resolves the currently active Polymarket 5m Up/Down market for the asset by exact event slug.
 * Tries several 300s UTC window starts (clock skew / slow polls / rollover).
 */
export async function resolveActiveUpDown5m(asset: string): Promise<ResolvedUpDownMarket | null> {
  const a = normalizeAsset(asset);
  if (!a) return null;
  const prefix = `${a.toLowerCase()}-updown-5m`;
  const nowSec = Math.floor(Date.now() / 1000);
  const blockStart = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  const candidates: number[] = [];
  for (let k = -10; k <= 10; k++) {
    candidates.push(blockStart + k * WINDOW_SEC);
  }

  const now = Date.now();

  for (const ts of candidates) {
    const slug = `${prefix}-${ts}`;
    const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
    let json: unknown;
    try {
      const res = await gammaFetch(url);
      if (!res.ok) continue;
      json = await res.json();
    } catch {
      continue;
    }
    const events = normalizeEventsPayload(json);
    if (events.length === 0) continue;
    const ev = events[0] as {
      slug?: string;
      title?: string;
      endDate?: string;
      markets?: unknown[];
    };
    const market = ev.markets?.[0] as
      | {
          question?: string;
          outcomes?: unknown;
          clobTokenIds?: unknown;
          endDate?: string;
          closed?: boolean;
          acceptingOrders?: boolean;
        }
      | undefined;
    if (!market) continue;

    const endIso = market.endDate ?? ev.endDate;
    const endMs = endIso ? new Date(endIso).getTime() : 0;
    if (!endMs || endMs <= now) continue;
    if (market.closed === true) continue;

    const outcomes = parseJsonStringArray(market.outcomes);
    const tokens = parseJsonStringArray(market.clobTokenIds);
    if (outcomes.length !== 2 || tokens.length !== 2) continue;
    const upIdx = outcomes.findIndex((o) => /^up$/i.test(o.trim()));
    const downIdx = outcomes.findIndex((o) => /^down$/i.test(o.trim()));
    if (upIdx < 0 || downIdx < 0) continue;

    return {
      tokenIdUp: tokens[upIdx],
      tokenIdDown: tokens[downIdx],
      label: String(market.question ?? ev.title ?? slug),
      endDate: String(market.endDate ?? ev.endDate ?? ""),
      slug: String(ev.slug ?? slug)
    };
  }
  return null;
}
