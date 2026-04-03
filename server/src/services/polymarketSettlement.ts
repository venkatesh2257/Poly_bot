import type { Direction } from "../types/index.js";

/**
 * Polymarket binary (YES/NO) redemption: winning outcome token pays $1/share, losing $0.
 * PnL = shares × finalPrice − (entryCostUsd + entryFeesUsd).
 */

/** Which side resolved (YES = UP token wins, NO = DOWN token wins) for Up/Down markets. */
export function marketWinningOutcome(direction: Direction, tokenWins: boolean): "YES" | "NO" {
  if (direction === "UP") return tokenWins ? "YES" : "NO";
  return tokenWins ? "NO" : "YES";
}

export function settleReal(params: {
  marketId: string;
  direction: Direction;
  entryPricePerShare: number;
  shares: number;
  entryCostUsd: number;
  entryFeesUsd: number;
  /** True if the outcome token you hold redeems at $1 (UP→YES token, DOWN→NO token). */
  tokenWins: boolean;
}): {
  marketId: string;
  outcome: "YES" | "NO";
  finalPrice: number;
  pnl: number;
  tokenWins: boolean;
} {
  const finalPrice = params.tokenWins ? 1 : 0;
  const payout = params.shares * finalPrice;
  const cost = params.entryCostUsd + params.entryFeesUsd;
  const pnl = payout - cost;
  return {
    marketId: params.marketId,
    outcome: marketWinningOutcome(params.direction, params.tokenWins),
    finalPrice,
    pnl,
    tokenWins: params.tokenWins
  };
}

export function logRealSettlement(args: {
  entry: number;
  outcome: "YES" | "NO";
  finalPrice: number;
  pnl: number;
  marketId?: string;
}) {
  console.log("REAL_SETTLEMENT", {
    entry: Number(args.entry.toFixed(4)),
    outcome: args.outcome,
    finalPrice: Number(args.finalPrice.toFixed(2)),
    pnl: Number(args.pnl.toFixed(4)),
    marketId: args.marketId ?? ""
  });
}
