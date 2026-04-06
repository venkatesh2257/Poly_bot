/**
 * Reconnecting WebSocket helper for Synthesis endpoints (Node `ws`).
 */

import WebSocket from "ws";
import type { SynthesisRuntimeConfig } from "./synthesisConfig.js";

export type SynthesisWsHandlers = {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
};

export class SynthesisReconnectingSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempt = 0;
  private readonly path: string;
  private readonly label: string;

  constructor(
    private readonly cfg: SynthesisRuntimeConfig,
    path: string,
    label: string,
    private readonly handlers: SynthesisWsHandlers
  ) {
    this.path = path.startsWith("/") ? path : `/${path}`;
    this.label = label;
  }

  private wsUrl(): string {
    const base = this.cfg.wsBaseUrl.replace(/\/$/, "");
    return `${base}${this.path}`;
  }

  start(): void {
    this.stopped = false;
    this.scheduleConnect(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client_stop");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private scheduleConnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connectNow(), delayMs);
  }

  private backoffMs(): number {
    const min = this.cfg.reconnectMinMs;
    const max = this.cfg.reconnectMaxMs;
    const exp = Math.min(max, min * Math.pow(2, Math.min(10, this.attempt)));
    const jitter = Math.floor(Math.random() * Math.min(500, min));
    return Math.min(max, exp + jitter);
  }

  private connectNow(): void {
    if (this.stopped) return;
    this.reconnectTimer = null;
    const url = this.wsUrl();
    const headers: Record<string, string> = { "User-Agent": "PolyBot/1.0 (synthesis)" };
    if (this.cfg.apiKey) {
      headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    }
    try {
      this.ws = new WebSocket(url, { headers });
    } catch (e) {
      this.attempt += 1;
      this.handlers.onError(e instanceof Error ? e : new Error(String(e)));
      this.scheduleConnect(this.backoffMs());
      return;
    }

    this.ws.on("open", () => {
      this.attempt = 0;
      this.handlers.onOpen();
    });
    this.ws.on("message", (data: WebSocket.RawData) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      this.handlers.onMessage(text);
    });
    this.ws.on("close", (code: number, reason: Buffer) => {
      this.ws = null;
      this.handlers.onClose(code, reason.toString("utf8"));
      if (!this.stopped) {
        this.attempt += 1;
        this.scheduleConnect(this.backoffMs());
      }
    });
    this.ws.on("error", (err: Error) => {
      this.handlers.onError(err);
    });
  }
}
