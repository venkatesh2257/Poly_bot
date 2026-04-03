/**
 * Binance spot aggTrade streams — low-latency last trade price per asset (BTC, ETH, …).
 * Used by OLA to compare vs Polymarket price-to-beat before CLOB updates.
 */

import WebSocket from "ws";

const BINANCE_WS = "wss://stream.binance.com:9443/stream";

/** Map dashboard asset symbol → Binance stream name fragment */
export function assetToAggTradeStream(asset: string): string | null {
  const a = asset.trim().toUpperCase();
  const map: Record<string, string> = {
    BTC: "btcusdt@aggTrade",
    ETH: "ethusdt@aggTrade",
    SOL: "solusdt@aggTrade",
    XRP: "xrpusdt@aggTrade",
    DOGE: "dogeusdt@aggTrade"
  };
  return map[a] ?? null;
}

export type LastTradeTick = { price: number; ts: number };

export class BinanceAggTradeFeed {
  private ws: WebSocket | null = null;
  private readonly last = new Map<string, LastTradeTick>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private streamsKey = "";
  private started = false;

  /** Latest trade price (USDT ≈ USD for crypto majors). */
  getPrice(asset: string): number | null {
    const k = asset.trim().toUpperCase();
    const x = this.last.get(k);
    return x && Number.isFinite(x.price) && x.price > 0 ? x.price : null;
  }

  ageMs(asset: string): number {
    const k = asset.trim().toUpperCase();
    const x = this.last.get(k);
    if (!x) return Number.POSITIVE_INFINITY;
    return Date.now() - x.ts;
  }

  start(assets: string[]) {
    const streams = [...new Set(assets.map((a) => assetToAggTradeStream(a)).filter(Boolean))] as string[];
    if (streams.length === 0) return;
    const key = streams.sort().join("|");
    this.streamsKey = key;
    this.started = true;
    this.connect(streams);
  }

  stop() {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* */
      }
      this.ws = null;
    }
  }

  private connect(streams: string[]) {
    if (!this.started) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* */
      }
      this.ws = null;
    }

    const url = `${BINANCE_WS}?streams=${streams.join("/")}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("message", (buf: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(String(buf)) as {
          stream?: string;
          data?: { e?: string; p?: string; s?: string };
        };
        const d = msg.data;
        if (!d || d.e !== "aggTrade" || !d.p) return;
        const sym = String(d.s ?? "").toUpperCase();
        const px = Number(d.p);
        if (!Number.isFinite(px) || px <= 0) return;
        const asset = binanceSymbolToAsset(sym);
        if (!asset) return;
        this.last.set(asset, { price: px, ts: Date.now() });
      } catch {
        /* ignore bad frame */
      }
    });

    ws.on("close", () => {
      this.ws = null;
      if (!this.started) return;
      this.reconnectTimer = setTimeout(() => this.connect(streams), 2_000);
    });

    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        /* */
      }
    });
  }
}

function binanceSymbolToAsset(s: string): string | null {
  if (s === "BTCUSDT") return "BTC";
  if (s === "ETHUSDT") return "ETH";
  if (s === "SOLUSDT") return "SOL";
  if (s === "XRPUSDT") return "XRP";
  if (s === "DOGEUSDT") return "DOGE";
  return null;
}
