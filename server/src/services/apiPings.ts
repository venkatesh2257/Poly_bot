import { getRtdsManager } from "../realtime.js";
import { resolvePolygonRpcFallbackUrl, resolvePolygonRpcUrl } from "./rpcEnv.js";

const TIMEOUT_MS = 12_000;
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_BASE = "https://data-api.polymarket.com";
const RTDS_WSS = "wss://ws-live-data.polymarket.com";

export type PingResult = {
  id: string;
  label: string;
  url: string;
  ms: number;
  ok: boolean;
  httpStatus: number;
  error?: string;
  note?: string;
};

async function pingHttp(
  id: string,
  label: string,
  url: string,
  init?: RequestInit
): Promise<PingResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/json, text/plain, */*",
        ...(init?.headers as Record<string, string>)
      }
    });
    const ms = Date.now() - t0;
    return {
      id,
      label,
      url,
      ms,
      ok: res.ok,
      httpStatus: res.status,
      note: res.ok ? undefined : `HTTP ${res.status}`
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      id,
      label,
      url,
      ms,
      ok: false,
      httpStatus: 0,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

async function pingJsonRpc(id: string, label: string, rpcUrl: string): Promise<PingResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [], id: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const ms = Date.now() - t0;
    const ok = res.ok;
    return { id, label, url: rpcUrl, ms, ok, httpStatus: res.status };
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      id,
      label,
      url: rpcUrl,
      ms,
      ok: false,
      httpStatus: 0,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * RTDS critical path: shared persistent socket + RFC6455 PING→PONG (not a cold connect each refresh).
 * Handshake time is reported in `note` when relevant; `ms` is the warm RTT when PONG is seen.
 */
async function pingRtdsWarmPath(): Promise<PingResult> {
  const id = "rtds-ws";
  const label = "Polymarket RTDS — PING→PONG (shared connection, low-latency `ws`)";
  const url = RTDS_WSS;
  const mgr = getRtdsManager();
  mgr.start();
  const tHand = Date.now();
  try {
    await mgr.connect();
  } catch (e) {
    const ms = Date.now() - tHand;
    return {
      id,
      label,
      url,
      ms,
      ok: false,
      httpStatus: 0,
      error: e instanceof Error ? e.message : String(e)
    };
  }
  const handshakeMs = Date.now() - tHand;
  if (!mgr.isOpen()) {
    return {
      id,
      label,
      url,
      ms: handshakeMs,
      ok: false,
      httpStatus: 0,
      error: "WebSocket not open after connect"
    };
  }
  const rtt = await mgr.measurePongRttMs();
  const ms = rtt ?? handshakeMs;
  const noteParts: string[] = [];
  if (rtt != null) noteParts.push(`PONG RTT ${rtt}ms`);
  else noteParts.push("PONG not observed; ms = handshake");
  if (handshakeMs > 50) noteParts.push(`handshake ${handshakeMs}ms (first connect or reconnect)`);
  noteParts.push("perMessageDeflate off · TCP_NODELAY · singleton `RtdsManager`");
  return {
    id,
    label,
    url,
    ms,
    ok: true,
    httpStatus: 0,
    note: noteParts.join(" · ")
  };
}

/** `/activity` requires `user`; prefer CLOB funder (proxy wallet). */
function dataActivityPingUser(): string | null {
  const candidates = [
    process.env.CLOB_FUNDER_ADDRESS,
    process.env.DATA_API_ACTIVITY_USER,
    process.env.POLYMARKET_ACTIVITY_USER
  ];
  for (const c of candidates) {
    const a = c?.trim();
    if (a && /^0x[a-fA-F0-9]{40}$/i.test(a)) return a.toLowerCase();
  }
  return null;
}

function pingDataActivity(): Promise<PingResult> {
  const user = dataActivityPingUser();
  if (!user) {
    return Promise.resolve({
      id: "data-activity",
      label: "Data API — /activity?user=&limit=… (requires proxy wallet)",
      url: `${DATA_BASE}/activity?user=…&limit=1`,
      ms: 0,
      ok: false,
      httpStatus: 0,
      note: "Skipped — API returns 400 without user. Set CLOB_FUNDER_ADDRESS or DATA_API_ACTIVITY_USER"
    });
  }
  return pingHttp(
    "data-activity",
    "Data API — /activity (getActivity / proxy wallet)",
    `${DATA_BASE}/activity?user=${encodeURIComponent(user)}&limit=1`
  );
}

async function pingPolygonRpcWithFallback(): Promise<PingResult> {
  const id = "polygon-rpc";
  const label = "Polygon RPC — eth_chainId (401/403 → Ankr fallback)";
  const primary = resolvePolygonRpcUrl();
  const fallback = resolvePolygonRpcFallbackUrl();
  const urls: string[] = [];
  if (primary && /^https?:\/\//i.test(primary)) urls.push(primary);
  if (fallback && /^https?:\/\//i.test(fallback) && !urls.includes(fallback)) urls.push(fallback);

  if (urls.length === 0) {
    return {
      id,
      label,
      url: "(none)",
      ms: 0,
      ok: false,
      httpStatus: 0,
      note: "No RPC URL; set POLYGON_RPC_URL / RPC_URL / POLYGON_RPC_PROXY_URL or POLYGON_RPC_FALLBACK_URL"
    };
  }

  let last: PingResult | null = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    last = await pingJsonRpc(id, label, url);
    if (last.ok) {
      if (i > 0) {
        return {
          ...last,
          note: `OK via fallback after 401/403 on primary · ${last.note ?? ""}`.trim()
        };
      }
      return last;
    }
    const retryUnauthorized = (last.httpStatus === 401 || last.httpStatus === 403) && i < urls.length - 1;
    if (!retryUnauthorized) return last;
  }
  return last!;
}

function sampleTokenFromEnv(): string | null {
  for (const key of ["CLOB_TOKEN_ID_UP", "CLOB_TOKEN_ID_DOWN", "CLOB_TOKEN_ID"] as const) {
    const v = process.env[key]?.trim();
    if (v && !/^sim-/i.test(v) && v !== "unknown") return v;
  }
  return null;
}

export type PingEngineHelpers = {
  getMarketContext: (tokenID: string) => Promise<unknown>;
  getClobHost: () => string;
  getSampleTokenId: () => string | null;
};

/**
 * Latency for every outbound integration this app uses:
 * Gamma + Data API + CLOB (REST + public book + @polymarket/clob-client book path), RTDS WebSocket,
 * optional Polygon RPC, Coinbase/Binance spot (BTC + ETH as used by `cryptoPriceFeed` / `btcPriceFeed`).
 */
export async function runConnectivityPings(engine?: PingEngineHelpers): Promise<{
  ts: number;
  results: PingResult[];
}> {
  const clobHost = (engine?.getClobHost() ?? process.env.CLOB_HOST ?? "https://clob.polymarket.com").replace(/\/$/, "");
  const tokenId = engine?.getSampleTokenId() ?? sampleTokenFromEnv();

  const staticPings: Promise<PingResult>[] = [
    pingHttp("gamma-tags", "Gamma API — /tags (polymarket.ts, discovery)", `${GAMMA_BASE}/tags?limit=1`),
    pingHttp("gamma-markets", "Gamma API — /markets (polymarket.ts, UI)", `${GAMMA_BASE}/markets?limit=1&active=true`),
    pingHttp("gamma-events", "Gamma API — /events (marketDiscovery, gammaDisplayStats)", `${GAMMA_BASE}/events?limit=1`),
    pingDataActivity(),
    pingHttp("data-trades", "Data API — /trades (polymarket.ts)", `${DATA_BASE}/trades?limit=1`),
    pingHttp("clob-root", "CLOB — GET / (host reachability)", `${clobHost}/`),
    pingHttp("clob-time", "CLOB — GET /time (clob-client host, lightweight)", `${clobHost}/time`),
    pingHttp("coinbase-btc", "Coinbase — BTC-USD spot (btcPriceFeed)", "https://api.coinbase.com/v2/prices/BTC-USD/spot"),
    pingHttp("binance-btc", "Binance — BTCUSDT (btcPriceFeed fallback)", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
    pingHttp("coinbase-eth", "Coinbase — ETH-USD spot (cryptoPriceFeed)", "https://api.coinbase.com/v2/prices/ETH-USD/spot"),
    pingHttp("binance-eth", "Binance — ETHUSDT (cryptoPriceFeed fallback)", "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
    pingRtdsWarmPath()
  ];

  if (tokenId) {
    staticPings.push(
      pingHttp(
        "clob-book-public",
        "CLOB — public GET /book?token_id (WalletService.fetchPublicOrderBook)",
        `${clobHost}/book?token_id=${encodeURIComponent(tokenId)}`,
        { headers: { "User-Agent": "PolyBot/1.0 (public book)" } }
      )
    );
  } else {
    staticPings.push(
      Promise.resolve({
        id: "clob-book-public",
        label: "CLOB — public GET /book?token_id (WalletService.fetchPublicOrderBook)",
        url: `${clobHost}/book?token_id=…`,
        ms: 0,
        ok: false,
        httpStatus: 0,
        error: "No token ID (AUTO_DISCOVER_UPDOWN or CLOB_TOKEN_ID_UP/DOWN in .env)",
        note: "Skipped"
      })
    );
  }

  staticPings.push(pingPolygonRpcWithFallback());

  const results = await Promise.all(staticPings);

  if (engine) {
    const tokenForSdk = engine.getSampleTokenId();
    if (tokenForSdk) {
      const id = "clob-orderbook-sdk";
      const label = "CLOB — getOrderBook / getMarketContext (@polymarket/clob-client + WalletService)";
      const url = `${clobHost}/book (tokenID=${tokenForSdk.slice(0, 12)}…)`;
      const t0 = Date.now();
      try {
        await engine.getMarketContext(tokenForSdk);
        const ms = Date.now() - t0;
        results.push({ id, label, url, ms, ok: true, httpStatus: 200, note: "SDK or public book path" });
      } catch (e) {
        const ms = Date.now() - t0;
        results.push({
          id,
          label,
          url,
          ms,
          ok: false,
          httpStatus: 0,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    } else {
      results.push({
        id: "clob-orderbook-sdk",
        label: "CLOB — getOrderBook / getMarketContext (@polymarket/clob-client + WalletService)",
        url: `${clobHost}/book`,
        ms: 0,
        ok: false,
        httpStatus: 0,
        error: "No token ID (set discovery or CLOB_TOKEN_ID_UP/DOWN)",
        note: "Skipped — no sample token"
      });
    }
  }

  return { ts: Date.now(), results };
}
