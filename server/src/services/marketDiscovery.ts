/** Gamma API: active "{asset} Up or Down" 5m windows use slug `{asset}-updown-5m-{windowStartUnix}`. */

export type UpDownAsset = "BTC" | "ETH" | "SOL" | "XRP";

export interface ResolvedUpDownMarket {
  tokenIdUp: string;
  tokenIdDown: string;
  label: string;
  endDate: string;
  slug: string;
}

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const WINDOW_SEC = 300;

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
  if (u === "BTC" || u === "ETH" || u === "SOL" || u === "XRP") return u;
  return null;
}

/**
 * Resolves the currently active Polymarket 5m Up/Down market for the asset by exact event slug.
 * Tries the current 300s UTC window start, then next and previous windows for rollover edge cases.
 */
export async function resolveActiveUpDown5m(asset: string): Promise<ResolvedUpDownMarket | null> {
  const a = normalizeAsset(asset);
  if (!a) return null;
  const prefix = `${a.toLowerCase()}-updown-5m`;
  const nowSec = Math.floor(Date.now() / 1000);
  const blockStart = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;
  const candidates = [blockStart, blockStart + WINDOW_SEC, blockStart - WINDOW_SEC];

  for (const ts of candidates) {
    const slug = `${prefix}-${ts}`;
    const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
    let events: unknown;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      events = await res.json();
    } catch {
      continue;
    }
    if (!Array.isArray(events) || events.length === 0) continue;
    const ev = events[0] as { slug?: string; title?: string; markets?: unknown[] };
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
    const endMs = market.endDate ? new Date(market.endDate).getTime() : 0;
    if (!endMs || endMs <= Date.now()) continue;
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
      endDate: String(market.endDate ?? ""),
      slug: String(ev.slug ?? slug)
    };
  }
  return null;
}
