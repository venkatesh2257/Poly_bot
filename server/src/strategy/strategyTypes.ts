import type { Direction } from "../types/index.js";

/** Shared shape for dashboard + auto-trade (explicit strategy id in `reason` prefixes). */
export type StrategyEvaluation = {
  prediction: Direction;
  confidence: number;
  recommendation: "TRADE" | "NO_TRADE";
  reason: string;
};
