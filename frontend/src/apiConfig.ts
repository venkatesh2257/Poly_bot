/**
 * API + WebSocket base URLs: env override, else same-host `/api` in prod, local dev uses PORT defaults.
 */

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** e.g. `http://localhost:4000/api` or `https://app.example.com/api` */
export function resolveApiBase(): string {
  const env = String(import.meta.env.VITE_API_BASE ?? "").trim();
  if (env) return trimSlash(env);

  if (typeof window === "undefined") {
    return "http://localhost:4000/api";
  }

  const { protocol, hostname, port } = window.location;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const apiPort = String(import.meta.env.VITE_API_PORT ?? "").trim() || "4000";

  if (isLocal) {
    return `${protocol}//${hostname}:${apiPort}/api`;
  }

  return `${window.location.origin}/api`;
}

/**
 * WebSocket URL for dashboard live updates.
 * Defaults to the same host:port as the REST API (server shares WS with HTTP on `PORT`).
 * Override with `VITE_WS_URL`, or `VITE_WS_PORT` only when a legacy split-port WS is still in use.
 */
export function resolveWsUrl(): string {
  const env = String(import.meta.env.VITE_WS_URL ?? "").trim();
  if (env) return env;

  const legacyWsPort = String(import.meta.env.VITE_WS_PORT ?? "").trim();

  if (typeof window === "undefined") {
    const apiBase = trimSlash(resolveApiBase());
    let apiOriginStr = apiBase.replace(/\/api$/i, "");
    if (!/^https?:\/\//i.test(apiOriginStr)) {
      apiOriginStr = `http://${apiOriginStr}`;
    }
    try {
      const u = new URL(apiOriginStr);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      if (legacyWsPort) return `${wsProto}//${u.hostname}:${legacyWsPort}`;
      return `${wsProto}//${u.host}`;
    } catch {
      return `ws://localhost:${legacyWsPort || "4000"}`;
    }
  }

  const apiBase = trimSlash(resolveApiBase());
  let apiOriginStr = apiBase.replace(/\/api$/i, "");
  if (!/^https?:\/\//i.test(apiOriginStr)) {
    apiOriginStr = `http://${apiOriginStr}`;
  }

  let apiOriginUrl: URL;
  try {
    apiOriginUrl = new URL(apiOriginStr);
  } catch {
    const { protocol, hostname } = window.location;
    const wsProto = protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${hostname}:${legacyWsPort || "4000"}`;
  }

  const wsProto = apiOriginUrl.protocol === "https:" ? "wss:" : "ws:";
  const pageOrigin = window.location.origin;
  const apiOrigin = apiOriginUrl.origin;

  // SPA and API share origin (e.g. nginx terminates TLS and proxies `/api` + WebSocket).
  if (pageOrigin === apiOrigin) {
    const wsProtoPage = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtoPage}//${window.location.host}`;
  }

  // Same hostname as REST API; default = same port as API (WS attached to HTTP server).
  let host = apiOriginUrl.hostname;
  if (host === "localhost") host = "127.0.0.1";
  const port = legacyWsPort || apiOriginUrl.port || (apiOriginUrl.protocol === "https:" ? "443" : "80");
  return `${wsProto}//${host}:${port}`;
}
