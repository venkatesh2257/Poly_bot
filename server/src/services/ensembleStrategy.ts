/**
 * Ensemble: combines momentum, orderbook, mean-revert, chart, mid-flip, last-second collapse, reversal snipe.
 * Positive score ⇒ UP bias; negative ⇒ DOWN. Weights from ENSEMBLE_W_* env vars.
 */

import type { Direction, MarketContext } from "../types/index.js";

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

export type MidSample = { t: number; upMid: number; downMid: number };

export type EnsembleInputs = {
  samples: MidSample[];
  up: MarketContext;
  down: MarketContext;
  secondsToExpiry: number | null;
  /** Normalized momentum ∈ [-1, 1]; positive = spot/chart drift UP */
  momentumTrend: number;
  /** Latest synthetic chart UP% (1–99); null if unavailable */
  chartUpPct: number | null;
  /** Flip sign of momentum contribution (contrarian leg) */
  useContrarianMomentum: boolean;
};

export type EnsembleResult = {
  score: number;
  direction: Direction;
  parts: string[];
};

function detectMidFlip(samples: MidSample[]): { sign: number; tag: string } | null {
  if (samples.length < 3) return null;
  const lo = samples[0]!;
  const hi = samples[samples.length - 1]!;
  const d0 = lo.upMid - lo.downMid;
  const d1 = hi.upMid - hi.downMid;
  if (d0 * d1 > 0) return null;
  if (Math.abs(d0) < 0.008 && Math.abs(d1) < 0.008) return null;
  const sign = d1 > 0 ? 1 : -1;
  return { sign, tag: d1 > 0 ? "flip→UP" : "flip→DN" };
}

/** Near expiry: favorite side mid dropped sharply → flow to other side; vote that direction. */
function detectLastSecondCollapse(
  samples: MidSample[],
  secLeft: number | null,
  upMid: number,
  downMid: number
): { sign: number; tag: string } | null {
  const maxSec = envNum("ENSEMBLE_LSC_MAX_SEC_LEFT", 38);
  const minSec = envNum("ENSEMBLE_LSC_MIN_SEC_LEFT", 4);
  if (secLeft == null || secLeft > maxSec || secLeft < minSec) return null;
  if (samples.length < 5) return null;
  const look = Math.min(samples.length - 1, 8);
  const ago = samples[samples.length - 1 - look]!;
  const dropThresh = envNum("ENSEMBLE_LSC_DROP", 0.11);
  const favThresh = envNum("ENSEMBLE_LSC_FAV_MIN", 0.52);
  const dropUp = ago.upMid - upMid;
  const dropDown = ago.downMid - downMid;
  if (dropUp >= dropThresh && ago.upMid >= favThresh) {
    return { sign: -1, tag: "LSC:UP_crowd_dump→DN" };
  }
  if (dropDown >= dropThresh && ago.downMid >= favThresh) {
    return { sign: 1, tag: "LSC:DN_crowd_dump→UP" };
  }
  return null;
}

/** Fade a side that was extreme and is bleeding mid over recent ticks. */
function detectReversalSnipe(samples: MidSample[]): { sign: number; tag: string } | null {
  if (samples.length < 5) return null;
  const ext = envNum("ENSEMBLE_REV_EXTREME", 0.72);
  const dd = envNum("ENSEMBLE_REV_DROP", 0.065);
  const old = samples[samples.length - 5]!;
  const cur = samples[samples.length - 1]!;
  if (old.upMid >= ext && cur.upMid <= old.upMid - dd) {
    return { sign: -1, tag: "REV:fade_UP" };
  }
  if (old.downMid >= ext && cur.downMid <= old.downMid - dd) {
    return { sign: 1, tag: "REV:fade_DN" };
  }
  return null;
}

export function computeEnsemble(inputs: EnsembleInputs): EnsembleResult {
  const parts: string[] = [];
  let score = 0;

  const wMom = envNum("ENSEMBLE_W_MOMENTUM", 1);
  const wOb = envNum("ENSEMBLE_W_ORDERBOOK", 1);
  const wMr = envNum("ENSEMBLE_W_MEAN_REVERT", 0.65);
  const wChart = envNum("ENSEMBLE_W_CHART", 0.7);
  const wFlip = envNum("ENSEMBLE_W_MID_FLIP", 1.15);
  const wLsc = envNum("ENSEMBLE_W_LAST_SECOND_COLLAPSE", 1.45);
  const wRev = envNum("ENSEMBLE_W_REVERSAL_SNIPE", 1.2);

  let momSign = inputs.momentumTrend >= 0 ? 1 : -1;
  if (inputs.useContrarianMomentum) momSign *= -1;
  score += wMom * momSign;
  parts.push(`mom×${wMom.toFixed(2)}:${momSign > 0 ? "UP" : "DN"}`);

  const obSign = inputs.up.mid >= inputs.down.mid ? 1 : -1;
  score += wOb * obSign;
  parts.push(`book×${wOb.toFixed(2)}:${obSign > 0 ? "UP" : "DN"}`);

  if (inputs.chartUpPct != null) {
    const mrSign = inputs.chartUpPct >= 50 ? -1 : 1;
    score += wMr * mrSign;
    parts.push(`mr×${wMr.toFixed(2)}:${mrSign > 0 ? "UP" : "DN"}`);

    const chSign = inputs.chartUpPct >= 50 ? 1 : -1;
    score += wChart * chSign;
    parts.push(`ch×${wChart.toFixed(2)}:${chSign > 0 ? "UP" : "DN"}`);
  }

  const flip = detectMidFlip(inputs.samples);
  if (flip) {
    score += wFlip * flip.sign;
    parts.push(`flip×${wFlip.toFixed(2)}:${flip.tag}`);
  }

  const lsc = detectLastSecondCollapse(
    inputs.samples,
    inputs.secondsToExpiry,
    inputs.up.mid,
    inputs.down.mid
  );
  if (lsc) {
    score += wLsc * lsc.sign;
    parts.push(`lsc×${wLsc.toFixed(2)}:${lsc.tag}`);
  }

  const rev = detectReversalSnipe(inputs.samples);
  if (rev) {
    score += wRev * rev.sign;
    parts.push(`rev×${wRev.toFixed(2)}:${rev.tag}`);
  }

  const direction: Direction = score >= 0 ? "UP" : "DOWN";
  return { score, direction, parts };
}
