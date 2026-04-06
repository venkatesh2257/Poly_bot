/**
 * Coordinates Synthesis orderbook, trades, and data WebSockets for Polymarket PM5m markets.
 * Execution-critical paths remain on native CLOB — this hub is analytics / optional fallback only.
 */

import type { DirectionalContext, MarketContext } from "../types/index.js";
import type { SynthesisRuntimeConfig } from "./synthesisConfig.js";
import { SynthesisReconnectingSocket } from "./synthesisClient.js";
import { SynthesisPolymarketOrderbookStore } from "./synthesisOrderbook.js";
import { SynthesisTradesBuffer, type NormalizedSynthesisTrade } from "./synthesisTrades.js";
import { SynthesisPriceSeriesBuffer, type PriceChartPoint } from "./synthesisPrices.js";

export type SynthesisTelemetry = {
  enabled: boolean;
  orderbookConnected: boolean;
  tradesConnected: boolean;
  dataConnected: boolean;
  subscribedTokenIds: string[];
  conditionId: string | null;
  activeAsset: string | null;
  lastOrderbookMsgMs: number | null;
  lastTradesMsgMs: number | null;
  lastDataMsgMs: number | null;
  stale: boolean;
  dashboardPreferred: boolean;
  botFallbackEnabled: boolean;
  lastError?: string;
};

export type SynthesisHubSnapshot = {
  telemetry: SynthesisTelemetry;
  books: {
    up: MarketContext | null;
    down: MarketContext | null;
    stale: boolean;
  };
  trades: NormalizedSynthesisTrade[];
  priceSeries: PriceChartPoint[];
};

function chainlinkSymbolForAsset(asset: string): string {
  const a = asset.trim().toUpperCase();
  if (a === "BTC") return "btc/usd";
  if (a === "ETH") return "eth/usd";
  if (a === "SOL") return "sol/usd";
  if (a === "XRP") return "xrp/usd";
  return "btc/usd";
}

export class SynthesisMarketDataHub {
  readonly orderbooks = new SynthesisPolymarketOrderbookStore();
  readonly trades: SynthesisTradesBuffer;
  readonly prices: SynthesisPriceSeriesBuffer;

  private cfg: SynthesisRuntimeConfig;
  private obSocket: SynthesisReconnectingSocket | null = null;
  private trSocket: SynthesisReconnectingSocket | null = null;
  private dataSocket: SynthesisReconnectingSocket | null = null;

  private lastObMsgMs: number | null = null;
  private lastTrMsgMs: number | null = null;
  private lastDataMsgMs: number | null = null;
  private lastErr: string | undefined;

  private tokenUp: string | null = null;
  private tokenDown: string | null = null;
  private conditionId: string | null = null;
  private activeAsset: string | null = null;

  private obConnected = false;
  private trConnected = false;
  private dataConnected = false;

  constructor(cfg: SynthesisRuntimeConfig) {
    this.cfg = cfg;
    this.trades = new SynthesisTradesBuffer(cfg.tradesHistoryLimit);
    this.prices = new SynthesisPriceSeriesBuffer(500);
  }

  updateConfig(cfg: SynthesisRuntimeConfig): void {
    this.cfg = cfg;
  }

  start(): void {
    if (!this.cfg.enabled) return;
    this.stop();
    this.orderbooks.clear();
    this.trades.clear();
    this.prices.clear();

    this.obSocket = new SynthesisReconnectingSocket(
      this.cfg,
      "/api/v1/orderbook/ws",
      "synthesis-ob",
      {
        onOpen: () => {
          this.obConnected = true;
          this.sendOrderbookSubscribe();
        },
        onMessage: (text) => {
          this.lastObMsgMs = Date.now();
          this.orderbooks.ingestRawMessage(text);
        },
        onClose: () => {
          this.obConnected = false;
        },
        onError: (e) => {
          this.lastErr = e.message;
        }
      }
    );

    this.trSocket = new SynthesisReconnectingSocket(
      this.cfg,
      "/api/v1/trades/ws",
      "synthesis-tr",
      {
        onOpen: () => {
          this.trConnected = true;
          this.sendTradesSubscribe();
        },
        onMessage: (text) => {
          this.lastTrMsgMs = Date.now();
          this.trades.ingestRawMessage(text);
        },
        onClose: () => {
          this.trConnected = false;
        },
        onError: (e) => {
          this.lastErr = e.message;
        }
      }
    );

    this.dataSocket = new SynthesisReconnectingSocket(
      this.cfg,
      "/api/v1/data/ws",
      "synthesis-data",
      {
        onOpen: () => {
          this.dataConnected = true;
          this.sendDataSubscribe();
        },
        onMessage: (text) => {
          this.lastDataMsgMs = Date.now();
          this.prices.ingestRawMessage(text);
        },
        onClose: () => {
          this.dataConnected = false;
        },
        onError: (e) => {
          this.lastErr = e.message;
        }
      }
    );

    this.obSocket.start();
    this.trSocket.start();
    this.dataSocket.start();
  }

  stop(): void {
    this.obSocket?.stop();
    this.trSocket?.stop();
    this.dataSocket?.stop();
    this.obSocket = null;
    this.trSocket = null;
    this.dataSocket = null;
    this.obConnected = false;
    this.trConnected = false;
    this.dataConnected = false;
  }

  /**
   * Point hub at active PM5m market token ids + optional condition id for trades stream.
   */
  resyncSubscription(input: {
    tokenIdUp: string;
    tokenIdDown: string;
    conditionId?: string;
    asset: string;
  }): void {
    this.tokenUp = input.tokenIdUp;
    this.tokenDown = input.tokenIdDown;
    this.conditionId = input.conditionId ?? null;
    this.activeAsset = input.asset;
    if (!this.cfg.enabled) return;
    this.orderbooks.clear();
    this.trades.clear();
    this.prices.clear();
    this.sendOrderbookSubscribe();
    this.sendTradesSubscribe();
    this.sendDataSubscribe();
  }

  getTelemetry(): SynthesisTelemetry {
    const now = Date.now();
    const tokens = [this.tokenUp, this.tokenDown].filter((x): x is string => Boolean(x));
    const obStale =
      this.tokenUp != null && this.orderbooks.isStale(this.tokenUp, this.cfg.staleMs, now);
    const stale =
      !this.cfg.enabled ||
      obStale ||
      (this.lastObMsgMs != null && now - this.lastObMsgMs > this.cfg.staleMs);

    return {
      enabled: this.cfg.enabled,
      orderbookConnected: this.obConnected,
      tradesConnected: this.trConnected,
      dataConnected: this.dataConnected,
      subscribedTokenIds: tokens,
      conditionId: this.conditionId,
      activeAsset: this.activeAsset,
      lastOrderbookMsgMs: this.lastObMsgMs,
      lastTradesMsgMs: this.lastTrMsgMs,
      lastDataMsgMs: this.lastDataMsgMs,
      stale,
      dashboardPreferred: this.cfg.dashboardPreferred,
      botFallbackEnabled: this.cfg.botFallbackEnabled,
      lastError: this.lastErr
    };
  }

  getSnapshot(): SynthesisHubSnapshot {
    const tel = this.getTelemetry();
    const up = this.tokenUp ? this.orderbooks.toMarketContext(this.tokenUp) : null;
    const down = this.tokenDown ? this.orderbooks.toMarketContext(this.tokenDown) : null;
    const now = Date.now();
    const bookStale =
      (this.tokenUp != null && this.orderbooks.isStale(this.tokenUp, this.cfg.staleMs, now)) ||
      (this.tokenDown != null && this.orderbooks.isStale(this.tokenDown, this.cfg.staleMs, now));

    return {
      telemetry: tel,
      books: { up, down, stale: bookStale || tel.stale },
      trades: this.trades.getRecent(),
      priceSeries: this.prices.getPoints()
    };
  }

  /**
   * When bot fallback is enabled and books are usable, return a DirectionalContext from Synthesis.
   */
  /** Last time the in-memory price series was updated (Chainlink/data WS). */
  getPricesBufferLastUpdateMs(): number {
    return this.prices.getLastUpdateMs();
  }

  getDirectionalContextFromSynthesis(): DirectionalContext | null {
    const up = this.tokenUp ? this.orderbooks.toMarketContext(this.tokenUp) : null;
    const down = this.tokenDown ? this.orderbooks.toMarketContext(this.tokenDown) : null;
    if (!up || !down) return null;
    const now = Date.now();
    if (this.orderbooks.isStale(this.tokenUp!, this.cfg.staleMs, now)) return null;
    if (this.orderbooks.isStale(this.tokenDown!, this.cfg.staleMs, now)) return null;
    return { up, down };
  }

  private sendOrderbookSubscribe(): void {
    if (!this.obSocket || !this.tokenUp || !this.tokenDown) return;
    this.obSocket.sendJson({
      type: "subscribe",
      venue: "polymarket",
      markets: [this.tokenUp, this.tokenDown]
    });
  }

  private sendTradesSubscribe(): void {
    if (!this.trSocket) return;
    if (!this.conditionId) {
      return;
    }
    this.trSocket.sendJson({
      type: "subscribe",
      venue: "polymarket",
      markets: [this.conditionId],
      limit: this.cfg.tradesHistoryLimit,
      offset: 0
    });
  }

  private sendDataSubscribe(): void {
    if (!this.dataSocket || !this.activeAsset) return;
    const sym = chainlinkSymbolForAsset(this.activeAsset);
    this.dataSocket.sendJson({
      type: "subscribe",
      data_type: "prices_chainlink",
      params: { symbol: sym }
    });
  }
}
