/** Env-backed knobs for the professional Chainlink + book state machine. */

export type ProfessionalTraderEnvConfig = {
  minDeviationUsd: number;
  cooldownUpdates: number;
  maxTradesPer10Updates: number;
  earlyPhaseUpdates: number;
  profitProtectionDrawdown: number;
  softSlMid: number;
  maxTradeMs: number;
  minScore: number;
  lossStreakSoft: number;
  lossStreakSafe: number;
  safeModeMinScore: number;
};

function n(raw: string | undefined, def: number): number {
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

export function loadProfessionalTraderConfigFromEnv(): ProfessionalTraderEnvConfig {
  return {
    minDeviationUsd: Math.max(1e-6, n(process.env.PROFESSIONAL_MIN_DEVIATION_USD, 12)),
    cooldownUpdates: Math.max(1, Math.floor(n(process.env.PROFESSIONAL_COOLDOWN_UPDATES, 6))),
    maxTradesPer10Updates: Math.max(1, Math.floor(n(process.env.PROFESSIONAL_MAX_TRADES_PER_10_UPDATES, 1))),
    earlyPhaseUpdates: Math.max(1, Math.floor(n(process.env.PROFESSIONAL_EARLY_PHASE_UPDATES, 3))),
    profitProtectionDrawdown: Math.max(0.001, n(process.env.PROFESSIONAL_PEAK_GIVEBACK_MID, 0.06)),
    softSlMid: Math.max(0.01, n(process.env.PROFESSIONAL_SOFT_SL_MID, 0.1)),
    maxTradeMs: Math.max(10_000, n(process.env.PROFESSIONAL_MAX_TRADE_MS, 180_000)),
    minScore: Math.max(0, Math.min(100, n(process.env.PROFESSIONAL_MIN_SCORE, 50))),
    lossStreakSoft: Math.max(1, Math.floor(n(process.env.PROFESSIONAL_LOSS_STREAK_SOFT, 2))),
    lossStreakSafe: Math.max(2, Math.floor(n(process.env.PROFESSIONAL_LOSS_STREAK_SAFE, 3))),
    safeModeMinScore: Math.max(50, Math.min(100, n(process.env.PROFESSIONAL_SAFE_MODE_MIN_SCORE, 80)))
  };
}
