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

/** WebSocket URL for dashboard live updates (server `WS_PORT`, default 4001). */
export function resolveWsUrl(): string {
  const env = String(import.meta.env.VITE_WS_URL ?? "").trim();
  if (env) return env;

  if (typeof window === "undefined") {
    return "ws://localhost:4001";
  }

  const { protocol, hostname, port } = window.location;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const wsPort = String(import.meta.env.VITE_WS_PORT ?? "").trim() || "4001";
  const wsProto = protocol === "https:" ? "wss:" : "ws:";

  if (isLocal) {
    return `${wsProto}//${hostname}:${wsPort}`;
  }

  // Same host: assume reverse-proxy maps `/` WS or use explicit VITE_WS_URL in deployment.
  const sameOriginWs = `${wsProto}//${hostname}${port ? `:${port}` : ""}`;
  return sameOriginWs;
}
