/**
 * Typed shapes for Synthesis API WebSocket JSON (subset used by Poly_bot).
 */

export type SynthesisJson = Record<string, unknown>;

export type SynthesisOrderbookSnapshotEntry = {
  venue: string;
  orderbook: {
    condition_id?: string;
    token_id: string;
    bids: Record<string, string>;
    asks: Record<string, string>;
    best_bid?: string;
    best_ask?: string;
    hash?: string;
    created_at?: string;
  };
};

export type SynthesisOrderbookEnvelope = {
  success?: boolean;
  response?: {
    orderbooks?: SynthesisOrderbookSnapshotEntry[];
    venue?: string;
    delta?: {
      condition_id?: string;
      token_id: string;
      amount?: string;
      price?: string;
      side?: string;
      best_bid?: string;
      best_ask?: string;
      hash?: string;
      created_at?: string;
    };
  };
};

export type SynthesisTradeRow = {
  venue: string;
  trade: {
    tx_hash?: string;
    token_id: string;
    side?: boolean;
    amount?: string;
    shares?: string;
    price?: string;
    created_at?: string;
  };
  market?: { condition_id?: string };
};

export type SynthesisTradesEnvelope = {
  success?: boolean;
  response?: {
    trades?: SynthesisTradeRow[];
    venue?: string;
    trade?: SynthesisTradeRow["trade"];
    market?: SynthesisTradeRow["market"];
  };
};

export type SynthesisDataPricesEnvelope = {
  success?: boolean;
  response?: {
    type?: string;
    data_type?: string;
    asset_id?: string;
    symbol?: string;
    data?: {
      price?: number;
      timestamp?: number;
      prices?: number[];
      timestamps?: number[];
      current_price?: number;
      open_price?: number;
    };
  };
};
