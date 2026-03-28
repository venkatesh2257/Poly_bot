const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";

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

  dataActivity(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(DATA_BASE, "/activity", query));
  }

  dataTrades(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(DATA_BASE, "/trades", query));
  }

  dataHolders(query: Record<string, string | number | undefined>) {
    return readJson(buildUrl(DATA_BASE, "/holders", query));
  }
}
