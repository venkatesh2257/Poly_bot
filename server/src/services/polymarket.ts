const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";

function isProxyWalletAddress(a: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(a.trim());
}

function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>) {
  const url = new URL(path, base);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}

async function readJson(url: string) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Request failed (${res.status})`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class PolymarketPublicService {
  gammaMarkets(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(GAMMA_BASE, "/markets", query));
  }

  gammaEvents(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(GAMMA_BASE, "/events", query));
  }

  gammaSearch(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(GAMMA_BASE, "/search", query));
  }

  gammaTags(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(GAMMA_BASE, "/tags", query));
  }

  dataPositions(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(DATA_BASE, "/positions", query));
  }

  /**
   * Polymarket Data API `/activity` **requires** `user` (proxy wallet). Calling without it returns HTTP 400.
   */
  dataActivity(query: Record<string, string | number | undefined>) {
    const user = query.user;
    if (typeof user !== "string" || !isProxyWalletAddress(user)) {
      throw new Error("Data API /activity requires user (0x + 40 hex, Polymarket proxy wallet)");
    }
    return readJson(buildUrl(DATA_BASE, "/activity", { ...query, user: user.trim().toLowerCase() }));
  }

  dataTrades(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(DATA_BASE, "/trades", query));
  }

  dataHolders(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(DATA_BASE, "/holders", query));
  }
}

/**
 * Fetch `/activity` for one wallet; on non-OK logs and returns [] (no throw).
 * @param walletAddress Polymarket **proxy** wallet (often same as CLOB funder).
 */
export async function getActivity(walletAddress: string, limit = 20): Promise<unknown[]> {
  const w = walletAddress.trim();
  if (!isProxyWalletAddress(w)) {
    console.warn("[PolymarketPublicService] Activity skip: invalid wallet address");
    return [];
  }
  const url = buildUrl(DATA_BASE, "/activity", { user: w.toLowerCase(), limit });
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn("[PolymarketPublicService] Activity skip:", response.status, body.slice(0, 240));
    return [];
  }
  const text = await response.text();
  try {
    const j = JSON.parse(text) as unknown;
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}
