/** Gamma fields Polymarket’s UI uses: outcomePrices + optional eventMetadata (priceToBeat / finalPrice). */

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const _gammaT = Number(process.env.GAMMA_FETCH_TIMEOUT_MS ?? 9_000);
const GAMMA_FETCH_MS = Number.isFinite(_gammaT) ? Math.min(30_000, Math.max(4_000, _gammaT)) : 9_000;

/** One in-flight request per slug — parallel engine paths share the same Promise (fresher, no duplicate HTTP). */
const gammaInflight = new Map<string, Promise<GammaDisplayStats | null>>();

function normalizeEventsPayload(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: unknown[] }).data;
  }
  return [];
}

export interface GammaDisplayStats {
  up: number;
  down: number;
  priceToBeat?: number;
  finalPrice?: number;
}

async function fetchGammaDisplayStatsOnce(slug: string): Promise<GammaDisplayStats | null> {
  const url = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "PolyBot/1.0 (gamma display)"
      },
      signal: AbortSignal.timeout(GAMMA_FETCH_MS)
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const events = normalizeEventsPayload(json);
    const ev = events[0] as
      | {
          eventMetadata?: { priceToBeat?: number; finalPrice?: number };
          markets?: Array<{ outcomePrices?: string }>;
        }
      | undefined;
    if (!ev) return null;
    const m = ev.markets?.[0];
    const raw = m?.outcomePrices;
    if (typeof raw !== "string") return null;
    let p: string[];
    try {
      p = JSON.parse(raw) as string[];
    } catch {
      return null;
    }
    if (!Array.isArray(p) || p.length < 2) return null;
    const up = Number(p[0]);
    const down = Number(p[1]);
    if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
    const meta = ev.eventMetadata;
    const priceToBeat =
      meta?.priceToBeat != null && Number.isFinite(meta.priceToBeat) ? meta.priceToBeat : undefined;
    const finalPrice =
      meta?.finalPrice != null && Number.isFinite(meta.finalPrice) ? meta.finalPrice : undefined;
    return { up, down, priceToBeat, finalPrice };
  } catch {
    return null;
  }
}

export async function fetchGammaDisplayStats(slug: string): Promise<GammaDisplayStats | null> {
  let p = gammaInflight.get(slug);
  if (!p) {
    p = fetchGammaDisplayStatsOnce(slug).finally(() => {
      gammaInflight.delete(slug);
    });
    gammaInflight.set(slug, p);
  }
  return p;
}
