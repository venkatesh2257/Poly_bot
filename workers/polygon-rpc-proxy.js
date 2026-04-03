/**
 * Cloudflare Worker — Polygon JSON-RPC edge proxy (critical path latency).
 *
 * - Caches `eth_chainId` in-memory for the isolate (first request hits origin; all later ~sub-ms).
 * - Caches `eth_blockNumber` for ~2s (reduces thundering herd on block polls).
 * - Everything else: passthrough POST to your Alchemy/Infura URL (secret).
 *
 * Deploy:
 *   cd workers
 *   npx wrangler secret put POLYGON_RPC_UPSTREAM
 *     → paste full URL e.g. https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   npx wrangler deploy
 *
 * Server .env:
 *   POLYGON_RPC_PROXY_URL=https://polygon-rpc-proxy.<account>.workers.dev
 *
 * Keep `POLYGON_RPC_URL` as the direct URL for fallback or non-proxied tools.
 */

/** @type {string | null} */
let cachedEthChainIdResponse = null;

const blockNumberCache = { at: 0, body: /** @type {string | null} */ (null) };
const BLOCK_NUMBER_TTL_MS = 2000;

/**
 * @param {string} body
 * @param {number} [status=200]
 */
function jsonResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

/**
 * @param {Request} request
 * @param {{ POLYGON_RPC_UPSTREAM?: string }} env
 */
async function handlePost(request, env) {
  const upstream = env.POLYGON_RPC_UPSTREAM?.trim();
  if (!upstream) {
    return jsonResponse(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "POLYGON_RPC_UPSTREAM not set" } }), 503);
  }

  const text = await request.text();
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  if (Array.isArray(msg)) {
    return fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text
    });
  }

  const method = msg && typeof msg === "object" ? msg.method : undefined;

  if (method === "eth_chainId") {
    if (cachedEthChainIdResponse) return jsonResponse(cachedEthChainIdResponse);
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text
    });
    cachedEthChainIdResponse = await res.text();
    return jsonResponse(cachedEthChainIdResponse, res.status);
  }

  if (method === "eth_blockNumber") {
    const now = Date.now();
    if (blockNumberCache.body && now - blockNumberCache.at < BLOCK_NUMBER_TTL_MS) {
      return jsonResponse(blockNumberCache.body);
    }
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text
    });
    const t = await res.text();
    blockNumberCache.at = now;
    blockNumberCache.body = t;
    return jsonResponse(t, res.status);
  }

  return fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text
  });
}

export default {
  /**
   * @param {Request} request
   * @param {{ POLYGON_RPC_UPSTREAM?: string }} env
   */
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400"
        }
      });
    }

    if (request.method !== "POST") {
      return new Response("POST JSON-RPC only", { status: 405 });
    }

    const res = await handlePost(request, env);
    const h = new Headers(res.headers);
    h.set("access-control-allow-origin", "*");
    return new Response(res.body, { status: res.status, headers: h });
  }
};
