/**
 * Polymarket RTDS — one persistent WebSocket for the whole process.
 * @see https://docs.polymarket.com/developers/RTDS/RTDS-crypto-prices
 */
import WebSocket from "ws";

const RTDS_URL = "wss://ws-live-data.polymarket.com";

const DEFAULT_SUBSCRIPTIONS = [
  { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' },
  { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"eth/usd"}' },
  { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"sol/usd"}' },
  { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"xrp/usd"}' },
  // NOTE: we intentionally do not subscribe to `crypto_prices` (DOGE) here.
  // The RTDS server rejects that subscription shape, which prevents chainlink subscriptions from validating.
] as const;

const ASSET_TO_RTD_KEY: Record<string, string> = {
  BTC: "btc/usd",
  ETH: "eth/usd",
  SOL: "sol/usd",
  XRP: "xrp/usd",
  DOGE: "dogeusdt"
};

const RECONNECT_MS = 2500;
const PING_MS = 5000;

/** Low-latency `ws` options: no per-frame deflate; Nagle off on TCP after open. */
const WS_CONNECT_OPTS = { perMessageDeflate: false, handshakeTimeout: 12_000 } as const;

/** Single RTDS socket + coalesced `connect()` for the Node process. */
export class RtdsManager {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** In-flight handshake so parallel `connect()` share one socket attempt. */
  private connectInFlight: Promise<void> | null = null;
  private readonly last = new Map<string, number>();
  private readonly lastTs = new Map<string, number>();

  getUsdForAsset(asset: string): number | null {
    const u = asset.trim().toUpperCase();
    const key = ASSET_TO_RTD_KEY[u];
    if (!key) return null;
    return this.last.get(key) ?? null;
  }

  getAgeMsForAsset(asset: string): number | null {
    const u = asset.trim().toUpperCase();
    const key = ASSET_TO_RTD_KEY[u];
    if (!key) return null;
    const ts = this.lastTs.get(key);
    if (ts == null) return null;
    return Math.max(0, Date.now() - ts);
  }

  isOpen(): boolean {
    return this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Alias for status payloads that used `isSocketOpen`. */
  isSocketOpen(): boolean {
    return this.isOpen();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.connect().catch(() => {
      /* reconnect scheduled from close handler */
    });
  }

  /** Idempotent: one live connection; concurrent callers await the same handshake. */
  async connect(): Promise<void> {
    if (!this.started) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.ws?.readyState === WebSocket.CONNECTING && this.connectInFlight) {
      return this.connectInFlight;
    }
    if (this.connectInFlight) return this.connectInFlight;

    this.connectInFlight = this.openSocket();
    try {
      await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  /**
   * RFC6455 PING→PONG round-trip on the live socket (critical-path latency; typically tens of ms).
   * Does not open a new connection (unlike cold dashboard probes).
   */
  measurePongRttMs(timeoutMs = 2500): Promise<number | null> {
    const w = this.ws;
    if (!w || w.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const to = setTimeout(() => resolve(null), timeoutMs);
      w.once("pong", () => {
        clearTimeout(to);
        resolve(Date.now() - t0);
      });
      try {
        w.ping();
      } catch {
        clearTimeout(to);
        resolve(null);
      }
    });
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private openSocket(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(RTDS_URL, WS_CONNECT_OPTS);
      } catch (e) {
        this.scheduleReconnect();
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      this.ws = socket;

      const settled = { done: false };
      const finishOk = () => {
        if (settled.done) return;
        settled.done = true;
        resolve();
      };
      const finishErr = (e: unknown) => {
        if (settled.done) return;
        settled.done = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      socket.on("open", () => {
        const tcp = (socket as unknown as { _socket?: { setNoDelay?: (v: boolean) => void } })._socket;
        tcp?.setNoDelay?.(true);
        // RTDS occasionally applies partial subscription sets when all symbols are bundled.
        // Subscribe one-by-one to ensure all requested assets validate.
        for (const sub of DEFAULT_SUBSCRIPTIONS) {
          socket.send(JSON.stringify({ action: "subscribe", subscriptions: [sub] }));
        }
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          try {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
          } catch {
            /* ignore */
          }
        }, PING_MS);
        finishOk();
      });

      socket.on("message", (raw) => {
        const sRaw = typeof raw === "string" ? raw : raw.toString();
        // RTDS frames may include leading whitespace/BOM; trim before parsing.
        const s = sRaw.trim();
        if (!s.startsWith("{")) return;
        try {
          const j = JSON.parse(s) as {
            topic?: string;
            payload?: { symbol?: string; value?: number };
          };
          const sym = j.payload?.symbol;
          // RTDS payloads may encode numeric values as strings; coerce safely.
          const val = Number(j.payload?.value);
          if (sym == null || !Number.isFinite(val)) return;
          const k = String(sym).toLowerCase();
          if (j.topic === "crypto_prices_chainlink" || j.topic === "crypto_prices") {
            this.last.set(k, val);
            this.lastTs.set(k, Date.now());
          }
        } catch {
          /* ignore */
        }
      });

      socket.on("error", (err) => {
        finishErr(err);
      });

      socket.on("close", () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.ws = null;
        if (this.started) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started) return;
      void this.connect().catch(() => {
        /* next close/reconnect cycle */
      });
    }, RECONNECT_MS);
  }
}

let rtdsSingleton: RtdsManager | null = null;

/** Process-wide RTDS connection (engine + any future readers share one socket). */
export function getRtdsManager(): RtdsManager {
  if (!rtdsSingleton) rtdsSingleton = new RtdsManager();
  return rtdsSingleton;
}
