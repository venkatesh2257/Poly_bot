/** High-selectivity strategy: Chainlink anchor + Polymarket book only (no classic TA). */

export type ProfessionalState = "IDLE" | "SETUP" | "CONFIRMED" | "IN_TRADE" | "COOLDOWN";

export type ProfessionalDirection = "UP" | "DOWN";

export type OhlcCandle = {
  tOpenMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type ProfessionalTickInput = {
  nowMs: number;
  anchorUsd: number;
  spotUsd: number;
  upBidDepthShare: number;
  downBidDepthShare: number;
  /** Approximate imbalance direction from book (UP = bid-heavy on UP token). */
  bookBias: ProfessionalDirection | null;
  /** Mid of UP outcome token (0–1) for in-trade P&L proxy. */
  upMid: number;
  downMid: number;
  baseEntryUsd: number;
  minDeviationUsd: number;
};

export type ProfessionalDecision =
  | { kind: "none" }
  | {
      kind: "enter";
      direction: ProfessionalDirection;
      score: number;
      sizeMultiplier: number;
      reason: string;
    }
  | { kind: "exit_open"; tradeId: string; reason: string };

export type ProfessionalLogLevel = "INFO" | "SKIP" | "EXIT" | "STATE";
