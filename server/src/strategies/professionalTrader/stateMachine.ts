import type {
  ProfessionalDecision,
  ProfessionalDirection,
  ProfessionalState,
  ProfessionalTickInput,
  OhlcCandle
} from "./professionalTypes.js";
import type { ProfessionalTraderEnvConfig } from "./config.js";
import { shouldSkipMarket } from "./marketFilter.js";

export type ProfessionalStepResult = {
  logs: string[];
  decision: ProfessionalDecision;
};

type OpenTrade = {
  tradeId: string;
  direction: ProfessionalDirection;
  entryMs: number;
  /** Mid of the outcome token at entry (UP or DOWN leg). */
  entryTokenMid: number;
  peakProfit: number;
  updates: number;
  lastMid: number;
  stallCount: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function imbalanceSign(upShare: number): -1 | 0 | 1 {
  if (upShare > 0.55) return 1;
  if (upShare < 0.45) return -1;
  return 0;
}

function countImbalanceFlips(historyUpShare: number[]): number {
  if (historyUpShare.length < 2) return 0;
  let flips = 0;
  for (let i = 1; i < historyUpShare.length; i++) {
    const a = imbalanceSign(historyUpShare[i - 1]!);
    const b = imbalanceSign(historyUpShare[i]!);
    if (a !== 0 && b !== 0 && a !== b) flips += 1;
  }
  return flips;
}

function scoreTrade(input: ProfessionalTickInput, candles: OhlcCandle[], dir: ProfessionalDirection): number {
  const dev = Math.abs(input.spotUsd - input.anchorUsd);
  const minD = Math.max(1e-6, input.minDeviationUsd);
  const flow = Math.abs(input.upBidDepthShare - 0.5);
  const orderFlow = clamp(flow * 60, 0, 30);
  const anchorPts = clamp((dev / minD) * 12.5, 0, 25);
  const last = candles[candles.length - 1];
  let struct = 12;
  if (dir === "UP") {
    const hh = candles.slice(-4).every((c, i, a) => i === 0 || c.close > a[i - 1]!.close);
    struct = hh ? 25 : 8;
  } else {
    const ll = candles.slice(-4).every((c, i, a) => i === 0 || c.close < a[i - 1]!.close);
    struct = ll ? 25 : 8;
  }
  let volQ = 10;
  if (last) {
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    const wickRatio = range > 1e-12 ? 1 - body / range : 0;
    volQ = clamp(20 - wickRatio * 20, 0, 20);
  }
  return Math.round(orderFlow + anchorPts + struct + volQ);
}

function sizeMultiplier(score: number): number {
  if (score < 50) return 0;
  if (score < 70) return 0.5;
  if (score < 85) return 1;
  return 1.75;
}

function spotContinuation(
  spots: number[],
  dir: ProfessionalDirection
): { secondPush: boolean; breakHiLo: boolean } {
  if (spots.length < 3) return { secondPush: false, breakHiLo: false };
  const d1 = spots[spots.length - 1]! - spots[spots.length - 2]!;
  const d2 = spots[spots.length - 2]! - spots[spots.length - 3]!;
  const secondPush =
    dir === "UP" ? d1 > 0 && d2 > 0 : d1 < 0 && d2 < 0;
  const recent = spots.slice(-4);
  if (recent.length < 4) return { secondPush, breakHiLo: false };
  const last = recent[recent.length - 1]!;
  const prevMax = Math.max(...recent.slice(0, 3));
  const prevMin = Math.min(...recent.slice(0, 3));
  const breakHiLo = dir === "UP" ? last > prevMax : last < prevMin;
  return { secondPush, breakHiLo };
}

/**
 * High-selectivity FSM: IDLE → SETUP → CONFIRMED → IN_TRADE → COOLDOWN.
 */
export class ProfessionalTradingStateMachine {
  private state: ProfessionalState = "IDLE";
  private imbalanceStreak = 0;
  private streakDir: ProfessionalDirection | null = null;
  private spotHistory: number[] = [];
  private tradeTicks: number[] = [];
  private tickIndex = 0;
  private consecutiveLosses = 0;
  private safeMode = false;
  private open: OpenTrade | null = null;
  private cooldownLeft = 0;
  private lossSizeMul = 1;
  /** After `enter` until `attachOpenTrade` / `abortPendingEntry`. */
  private awaitingFill = false;

  constructor(private readonly cfg: ProfessionalTraderEnvConfig) {}

  reset(): void {
    this.state = "IDLE";
    this.imbalanceStreak = 0;
    this.streakDir = null;
    this.spotHistory = [];
    this.open = null;
    this.cooldownLeft = 0;
    this.awaitingFill = false;
  }

  /** After simulated/live exit, feed outcome for streak / safe mode. */
  onPositionClosed(pnlPositive: boolean): void {
    if (pnlPositive) {
      this.consecutiveLosses = 0;
      this.lossSizeMul = 1;
      this.safeMode = false;
      return;
    }
    this.consecutiveLosses += 1;
    if (this.consecutiveLosses >= this.cfg.lossStreakSoft) {
      this.lossSizeMul = 0.65;
    }
    if (this.consecutiveLosses >= this.cfg.lossStreakSafe) {
      this.safeMode = true;
    }
  }

  attachOpenTrade(payload: {
    tradeId: string;
    direction: ProfessionalDirection;
    entryTokenMid: number;
  }): void {
    this.awaitingFill = false;
    this.open = {
      tradeId: payload.tradeId,
      direction: payload.direction,
      entryMs: Date.now(),
      entryTokenMid: payload.entryTokenMid,
      peakProfit: 0,
      updates: 0,
      lastMid: payload.entryTokenMid,
      stallCount: 0
    };
    this.state = "IN_TRADE";
    this.tradeTicks.push(this.tickIndex);
  }

  /** Call when `trade()` failed after an `enter` decision so the FSM can arm again. */
  abortPendingEntry(): void {
    this.awaitingFill = false;
    this.resetEntryPath();
  }

  clearOpenTrade(): void {
    this.open = null;
    this.state = "COOLDOWN";
    this.cooldownLeft = this.cfg.cooldownUpdates;
  }

  step(input: ProfessionalTickInput, candles: OhlcCandle[], imbalanceHistoryUp: number[]): ProfessionalStepResult {
    this.tickIndex += 1;
    const logs: string[] = [];

    this.spotHistory.push(input.spotUsd);
    while (this.spotHistory.length > 12) this.spotHistory.shift();

    if (this.awaitingFill && !this.open) {
      logs.push(`[PROFESSIONAL] awaiting entry fill tick=${this.tickIndex}`);
      return { logs, decision: { kind: "none" } };
    }

    if (this.state === "COOLDOWN") {
      this.cooldownLeft -= 1;
      if (this.cooldownLeft <= 0) {
        this.state = "IDLE";
        logs.push(`[PROFESSIONAL] state=IDLE after cooldown tick=${this.tickIndex}`);
      } else {
        logs.push(`[PROFESSIONAL] COOLDOWN left=${this.cooldownLeft}`);
      }
      return { logs, decision: { kind: "none" } };
    }

    if (this.state === "IN_TRADE" && this.open) {
      const exit = this.evaluateExit(input, logs);
      if (exit) {
        return { logs, decision: { kind: "exit_open", tradeId: this.open.tradeId, reason: exit } };
      }
      return { logs, decision: { kind: "none" } };
    }

    const flips = countImbalanceFlips(imbalanceHistoryUp.slice(-10));
    const filter = shouldSkipMarket({
      candles,
      imbalanceFlipsLast10: flips,
      anchorUsd: input.anchorUsd
    });

    if (filter.skip) {
      this.resetEntryPath();
      logs.push(`[PROFESSIONAL][SKIP] market_filter=${filter.reason}`);
      return { logs, decision: { kind: "none" } };
    }

    const dev = Math.abs(input.spotUsd - input.anchorUsd);
    if (dev < input.minDeviationUsd) {
      this.resetEntryPath();
      logs.push(
        `[PROFESSIONAL][SKIP] anchor_filter deviation=${dev.toFixed(4)} < MIN_DEVIATION=${input.minDeviationUsd}`
      );
      return { logs, decision: { kind: "none" } };
    }

    const trades10 = this.tradeTicks.filter((t) => this.tickIndex - t < 10).length;
    if (trades10 >= this.cfg.maxTradesPer10Updates) {
      logs.push(`[PROFESSIONAL][SKIP] throttle trades_last_10=${trades10}`);
      return { logs, decision: { kind: "none" } };
    }

    const bias = input.bookBias;
    if (bias == null) {
      this.resetEntryPath();
      logs.push(`[PROFESSIONAL][SKIP] book_bias_neutral`);
      return { logs, decision: { kind: "none" } };
    }

    if (this.streakDir !== bias) {
      this.streakDir = bias;
      this.imbalanceStreak = 1;
    } else {
      this.imbalanceStreak += 1;
    }

    if (this.imbalanceStreak < 5) {
      this.state = "IDLE";
      logs.push(`[PROFESSIONAL] setup_imbalance ${this.imbalanceStreak}/5 dir=${bias}`);
      return { logs, decision: { kind: "none" } };
    }

    this.state = "SETUP";
    const setupDir = bias;

    const { secondPush, breakHiLo } = spotContinuation(this.spotHistory, setupDir);
    const execAligned =
      input.bookBias === setupDir &&
      this.spotHistory.length >= 2 &&
      (() => {
        const d = this.spotHistory[this.spotHistory.length - 1]! - this.spotHistory[this.spotHistory.length - 2]!;
        return setupDir === "UP" ? d > 0 : d < 0;
      })();

    const confirmed = (secondPush || breakHiLo) && execAligned;

    if (!confirmed) {
      this.resetEntryPath();
      logs.push(
        `[PROFESSIONAL][SKIP] no_confirmation secondPush=${secondPush} breakHiLo=${breakHiLo} execAligned=${execAligned}`
      );
      return { logs, decision: { kind: "none" } };
    }

    this.state = "CONFIRMED";
    const score = scoreTrade(input, candles, setupDir);
    if (score < this.cfg.minScore) {
      this.resetEntryPath();
      logs.push(`[PROFESSIONAL][SKIP] trade_score=${score} < min=${this.cfg.minScore}`);
      return { logs, decision: { kind: "none" } };
    }
    if (this.safeMode && score < this.cfg.safeModeMinScore) {
      this.resetEntryPath();
      logs.push(`[PROFESSIONAL][SKIP] safe_mode needs score>=${this.cfg.safeModeMinScore} got=${score}`);
      return { logs, decision: { kind: "none" } };
    }

    let mult = sizeMultiplier(score) * this.lossSizeMul;
    mult = clamp(mult, 0.25, 2.5);

    const reason = `PROFESSIONAL: score=${score} dir=${setupDir} dev=${dev.toFixed(2)} flips=${flips} conf=secondPush=${secondPush} break=${breakHiLo}`;
    logs.push(`[PROFESSIONAL][ENTER] ${reason}`);

    this.awaitingFill = true;
    this.state = "SETUP";
    return {
      logs,
      decision: {
        kind: "enter",
        direction: setupDir,
        score,
        sizeMultiplier: mult,
        reason
      }
    };
  }

  private resetEntryPath(): void {
    if (this.state === "SETUP" || this.state === "CONFIRMED") {
      this.state = "IDLE";
    }
    this.imbalanceStreak = 0;
    this.streakDir = null;
  }

  private evaluateExit(input: ProfessionalTickInput, logs: string[]): string | null {
    const o = this.open;
    if (!o) return null;
    o.updates += 1;

    const mid = o.direction === "UP" ? input.upMid : input.downMid;
    const profitUse = mid - o.entryTokenMid;

    if (profitUse > o.peakProfit) o.peakProfit = profitUse;

    const moved = Math.abs(mid - o.lastMid);
    o.lastMid = mid;
    if (moved < 0.002) o.stallCount += 1;
    else o.stallCount = 0;

    const early = o.updates <= this.cfg.earlyPhaseUpdates;
    if (early && o.stallCount >= 2 && profitUse <= 0.005) {
      logs.push(`[PROFESSIONAL][EXIT] early_stall updates=${o.updates}`);
      return "early_stall_no_movement";
    }

    if (Date.now() - o.entryMs > this.cfg.maxTradeMs) {
      logs.push(`[PROFESSIONAL][EXIT] time_limit`);
      return "time_limit_exceeded";
    }

    if (profitUse < -this.cfg.softSlMid) {
      logs.push(`[PROFESSIONAL][EXIT] soft_sl pnlProxy=${profitUse.toFixed(4)}`);
      return "soft_sl_adverse";
    }

    if (o.peakProfit > 0.04 && profitUse < o.peakProfit - this.cfg.profitProtectionDrawdown) {
      logs.push(`[PROFESSIONAL][EXIT] profit_giveback peak=${o.peakProfit.toFixed(4)} now=${profitUse.toFixed(4)}`);
      return "profit_giveback";
    }

    const opp =
      o.direction === "UP"
        ? input.upBidDepthShare < 0.45
        : input.downBidDepthShare < 0.45;
    if (o.peakProfit > 0.02 && opp && input.bookBias != null && input.bookBias !== o.direction) {
      logs.push(`[PROFESSIONAL][EXIT] opposing_flow`);
      return "opposing_order_flow";
    }

    if (o.updates > this.cfg.earlyPhaseUpdates + 2 && o.stallCount >= 4 && profitUse < o.peakProfit * 0.5) {
      logs.push(`[PROFESSIONAL][EXIT] momentum_lost_stall`);
      return "momentum_lost_stall";
    }

    return null;
  }
}
