/**
 * Structured skip reasons for logs and UI (engine maps engine-level guards here too).
 */
export type AnchorSkipCategory =
  | "DISABLED"
  | "LAG_SNIPE_BLOCK"
  | "NO_LIVE_BOOK"
  | "LAST_60S_BLOCK"
  | "PENDING_TRADE_BLOCK"
  | "WINDOW_ALREADY_CLAIMED"
  | "ORACLE_STALE"
  | "INSUFFICIENT_HISTORY"
  | "INVALID_ORDERBOOK"
  | "INVALID_ANCHOR_PRICE"
  | "STABILITY_NOT_MET"
  | "MOMENTUM_MISMATCH"
  | "ANCHOR_PRICE_OUT_OF_RANGE"
  | "YES_MID_TOO_HIGH"
  | "AMBIGUOUS_STABILITY";

export interface AnchorStrategyConfig {
  enabled: boolean;
  stabilityTicks: number;
  /**
   * UP signal: require upBidDepthShare to stay above this for N ticks.
   * Env: ANCHOR_IMBALANCE_THRESHOLD (legacy name; measures bid-side share, not a generic "imbalance").
   */
  upBidDepthShareMin: number;
  /**
   * DOWN signal: require downBidDepthShare to stay *below* this for N ticks (ask-heavy DOWN token book).
   * This is NOT "down dominance" as strong buying of DOWN — low bid share means asks dominate.
   * Env: ANCHOR_IMBALANCE_DOWN_WEAK (legacy; think: max bid share for DOWN pattern).
   */
  downBidDepthShareMax: number;
  chainlinkMomThreshold: number;
  chainlinkMomReverseThreshold: number;
  anchorPriceMin: number;
  anchorPriceMax: number;
  /**
   * USD notional per Anchor entry.
   * Env `ANCHOR_TRADE_SIZE` (e.g. 1.00); if unset or empty, uses engine risk `ENTRY_USD` / overrides passed into `loadAnchorConfigFromEnv(fallbackUsd)`.
   */
  tradeSize: number;
  exitBufferSeconds: number;
  maxYesMid: number;
  minSecondsToExpiry: number;
  /** Reject momentum if latest oracle tick is older than this (ms). */
  maxOracleAgeMs: number;
  /** Need at least this many prices (e.g. 4 → mom vs 3 steps ago). */
  momentumLookbackPrices: number;
  anchorDebugLogs: boolean;
}

export interface OrderBookSnapshot {
  bidDepthUp: number;
  askDepthUp: number;
  bidDepthDown: number;
  askDepthDown: number;
}

export interface AnchorSignal {
  shouldTrade: boolean;
  side: "UP" | "DOWN" | null;
  imbalanceScore: number;
  stabilityMet: boolean;
  chainlinkMom: number;
  anchorPrice: number;
  reason: string;
  skipCategory?: AnchorSkipCategory;
  oracleAgeMs?: number | null;
  /** Current book-derived shares (0–1): bid depth / (bid+ask) per outcome token. */
  upBidDepthShare?: number;
  downBidDepthShare?: number;
  stabilityDetail?: string;
}

/**
 * Book metrics (sum of top-of-book depth used in engine; same formula as history arrays):
 *
 * - upBidDepthShare = bidDepthUp / (bidDepthUp + askDepthUp)
 * - downBidDepthShare = bidDepthDown / (bidDepthDown + askDepthDown)
 *
 * Interpretation (each in [0,1] when denom > 0):
 * - Near 1.0: most displayed depth is on the bid side (resting buy interest for that outcome token).
 * - Near 0.0: most depth is on the ask side (sellers of that outcome token).
 *
 * UP trade: require upBidDepthShare > upBidDepthShareMin (e.g. 0.70) — strong bid interest in UP token.
 * DOWN trade: require downBidDepthShare < downBidDepthShareMax (e.g. 0.30) — ask-heavy DOWN token book
 *   (weak bids), per original product spec; NOT the same as "high conviction to buy DOWN" in one number.
 */
/** Parses numeric env without treating `0` as “unset” (unlike `Number(x) || default`). */
export function parseEnvFiniteNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : fallback;
}

export function bidDepthShare(bid: number, ask: number): number {
  const s = bid + ask;
  if (s <= 1e-12 || !Number.isFinite(s)) return NaN;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask < 0) return NaN;
  return bid / s;
}

export function validateOrderBookSnapshot(ob: OrderBookSnapshot): { ok: true } | { ok: false; reason: string } {
  const fields = [ob.bidDepthUp, ob.askDepthUp, ob.bidDepthDown, ob.askDepthDown];
  for (const v of fields) {
    if (!Number.isFinite(v) || v < 0) return { ok: false, reason: "depth NaN or negative" };
  }
  const du = ob.bidDepthUp + ob.askDepthUp;
  const dd = ob.bidDepthDown + ob.askDepthDown;
  if (du <= 1e-12 || dd <= 1e-12) return { ok: false, reason: "zero total depth on UP or DOWN book" };
  return { ok: true };
}

function priceInUnitInterval(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p <= 1;
}

/**
 * Engine-level guards before order book / evaluateAnchorStrategy (no side effects).
 */
export function anchorEntryPreflight(args: {
  cfg: AnchorStrategyConfig;
  envEnabled: boolean;
  runtimeEnabled: boolean;
  lagSnipeEnabled: boolean;
  hasLiveMarketData: boolean;
  hasDirectionalContext: boolean;
  secondsToExpiry: number | null;
  hasPendingTrade: boolean;
  anchorTradedThisWindow: boolean;
}): { ok: true } | { ok: false; category: AnchorSkipCategory; reason: string } {
  if (!args.envEnabled || !args.runtimeEnabled) {
    return { ok: false, category: "DISABLED", reason: "Anchor disabled (env or runtime toggle)" };
  }
  if (args.lagSnipeEnabled) {
    return { ok: false, category: "LAG_SNIPE_BLOCK", reason: "Lag Snipe mode active" };
  }
  if (!args.hasLiveMarketData || !args.hasDirectionalContext) {
    return { ok: false, category: "NO_LIVE_BOOK", reason: "Missing live CLOB / directional context" };
  }
  if (args.secondsToExpiry != null && args.secondsToExpiry <= args.cfg.minSecondsToExpiry) {
    return {
      ok: false,
      category: "LAST_60S_BLOCK",
      reason: `${args.secondsToExpiry}s to expiry <= ${args.cfg.minSecondsToExpiry}s`
    };
  }
  if (args.hasPendingTrade) {
    return { ok: false, category: "PENDING_TRADE_BLOCK", reason: "Open PENDING trade exists" };
  }
  if (args.anchorTradedThisWindow) {
    return {
      ok: false,
      category: "WINDOW_ALREADY_CLAIMED",
      reason: "Another auto trade already used this 5m window"
    };
  }
  return { ok: true };
}

/**
 * Steps 1–4: book bid-share + stability + Chainlink momentum + anchor price gates.
 * Pass oracleLatestAgeMs from engine (Chainlink/RTDS age); null/NaN fails ORACLE_STALE path when strict.
 */
export function evaluateAnchorStrategy(
  orderBook: OrderBookSnapshot,
  chainlinkPriceHistory: number[],
  anchorYesPrice: number,
  anchorNoPrice: number,
  imbalanceHistoryUp: number[],
  imbalanceHistoryDown: number[],
  config: AnchorStrategyConfig,
  oracleLatestAgeMs?: number | null,
  chainlinkTimestampsMs?: number[],
  nowMs?: number
): AnchorSignal {
  const clock = nowMs !== undefined && Number.isFinite(nowMs) ? nowMs : Date.now();
  const n = Math.max(1, Math.floor(config.stabilityTicks));
  const needMom = Math.max(4, config.momentumLookbackPrices);

  const ob = validateOrderBookSnapshot(orderBook);
  if (!ob.ok) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: 0,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR_SKIP INVALID_ORDERBOOK: ${ob.reason}`,
      skipCategory: "INVALID_ORDERBOOK"
    };
  }

  const upBidDepthShare = bidDepthShare(orderBook.bidDepthUp, orderBook.askDepthUp);
  const downBidDepthShare = bidDepthShare(orderBook.bidDepthDown, orderBook.askDepthDown);
  if (!Number.isFinite(upBidDepthShare) || !Number.isFinite(downBidDepthShare)) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: 0,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: "ANCHOR_SKIP INVALID_ORDERBOOK: bid depth share NaN",
      skipCategory: "INVALID_ORDERBOOK",
      upBidDepthShare,
      downBidDepthShare
    };
  }

  if (!priceInUnitInterval(anchorYesPrice) || !priceInUnitInterval(anchorNoPrice)) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: upBidDepthShare,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: "ANCHOR_SKIP INVALID_ANCHOR_PRICE: YES/NO mid outside [0,1]",
      skipCategory: "INVALID_ANCHOR_PRICE",
      upBidDepthShare,
      downBidDepthShare
    };
  }

  if (oracleLatestAgeMs != null && Number.isFinite(oracleLatestAgeMs) && oracleLatestAgeMs > config.maxOracleAgeMs) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: upBidDepthShare,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR_SKIP ORACLE_STALE: age ${Math.round(oracleLatestAgeMs)}ms > ${config.maxOracleAgeMs}ms`,
      skipCategory: "ORACLE_STALE",
      oracleAgeMs: oracleLatestAgeMs,
      upBidDepthShare,
      downBidDepthShare
    };
  }

  if (
    chainlinkTimestampsMs &&
    chainlinkTimestampsMs.length > 0 &&
    oracleLatestAgeMs != null &&
    Number.isFinite(oracleLatestAgeMs)
  ) {
    const lastTs = chainlinkTimestampsMs[chainlinkTimestampsMs.length - 1];
    if (lastTs != null && Number.isFinite(lastTs)) {
      const sampleAge = Math.max(0, clock - lastTs);
      if (sampleAge > config.maxOracleAgeMs) {
        return {
          shouldTrade: false,
          side: null,
          imbalanceScore: upBidDepthShare,
          stabilityMet: false,
          chainlinkMom: 0,
          anchorPrice: anchorYesPrice,
          reason: `ANCHOR_SKIP ORACLE_STALE: buffer sample age ${Math.round(sampleAge)}ms > ${config.maxOracleAgeMs}ms`,
          skipCategory: "ORACLE_STALE",
          oracleAgeMs: sampleAge,
          upBidDepthShare,
          downBidDepthShare
        };
      }
    }
  }

  if (chainlinkPriceHistory.length < needMom) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: upBidDepthShare,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR_SKIP INSUFFICIENT_HISTORY: need ${needMom} prices, have ${chainlinkPriceHistory.length}`,
      skipCategory: "INSUFFICIENT_HISTORY",
      upBidDepthShare,
      downBidDepthShare
    };
  }

  if (anchorYesPrice > config.maxYesMid) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: upBidDepthShare,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR_SKIP YES_MID_TOO_HIGH: ${anchorYesPrice.toFixed(3)} > ${config.maxYesMid}`,
      skipCategory: "YES_MID_TOO_HIGH",
      upBidDepthShare,
      downBidDepthShare
    };
  }

  const lookback = needMom - 1;
  const nowPx = chainlinkPriceHistory[chainlinkPriceHistory.length - 1]!;
  const agoPx = chainlinkPriceHistory[chainlinkPriceHistory.length - 1 - lookback]!;
  if (!Number.isFinite(nowPx) || !Number.isFinite(agoPx) || agoPx <= 0) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: upBidDepthShare,
      stabilityMet: false,
      chainlinkMom: 0,
      anchorPrice: anchorYesPrice,
      reason: "ANCHOR_SKIP INVALID_ORACLE: non-finite Chainlink prices for momentum",
      skipCategory: "INSUFFICIENT_HISTORY",
      upBidDepthShare,
      downBidDepthShare
    };
  }

  const chainlinkMom = (nowPx - agoPx) / agoPx;

  const upHist = imbalanceHistoryUp.slice(-n);
  const downHist = imbalanceHistoryDown.slice(-n);
  const upStable =
    upHist.length === n && upHist.every((v) => Number.isFinite(v) && v > config.upBidDepthShareMin);
  const downStable =
    downHist.length === n &&
    downHist.every((v) => Number.isFinite(v) && v < config.downBidDepthShareMax);

  const stabilityDetail = `need ${n} ticks: up ${upHist.length}/${n} (>${config.upBidDepthShareMin}) down ${downHist.length}/${n} (<${config.downBidDepthShareMax})`;

  let candidate: "UP" | "DOWN" | null = null;
  if (upStable && !downStable) candidate = "UP";
  else if (downStable && !upStable) candidate = "DOWN";
  else if (upStable && downStable) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: Math.max(upBidDepthShare, downBidDepthShare),
      stabilityMet: false,
      chainlinkMom,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR_SKIP AMBIGUOUS_STABILITY: both patterns ${n} ticks`,
      skipCategory: "AMBIGUOUS_STABILITY",
      upBidDepthShare,
      downBidDepthShare,
      stabilityDetail
    };
  }

  if (!candidate) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore: Math.max(upBidDepthShare, downBidDepthShare),
      stabilityMet: false,
      chainlinkMom,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR_SKIP STABILITY_NOT_MET: ${stabilityDetail} upStable=${upStable} downStable=${downStable}`,
      skipCategory: "STABILITY_NOT_MET",
      upBidDepthShare,
      downBidDepthShare,
      stabilityDetail
    };
  }

  const stabilityMet = true;
  const imbalanceScore = candidate === "UP" ? upBidDepthShare : downBidDepthShare;

  if (candidate === "UP") {
    if (chainlinkMom <= config.chainlinkMomThreshold) {
      return {
        shouldTrade: false,
        side: null,
        imbalanceScore,
        stabilityMet,
        chainlinkMom,
        anchorPrice: anchorYesPrice,
        reason: `ANCHOR_SKIP MOMENTUM_MISMATCH: UP needs mom > ${config.chainlinkMomThreshold}, got ${chainlinkMom.toFixed(6)}`,
        skipCategory: "MOMENTUM_MISMATCH",
        upBidDepthShare,
        downBidDepthShare,
        stabilityDetail,
        oracleAgeMs: oracleLatestAgeMs ?? undefined
      };
    }
    if (anchorYesPrice < config.anchorPriceMin || anchorYesPrice > config.anchorPriceMax) {
      return {
        shouldTrade: false,
        side: "UP",
        imbalanceScore,
        stabilityMet,
        chainlinkMom,
        anchorPrice: anchorYesPrice,
        reason: `ANCHOR_SKIP ANCHOR_PRICE_OUT_OF_RANGE: YES ${anchorYesPrice.toFixed(3)} not in [${config.anchorPriceMin}, ${config.anchorPriceMax}]`,
        skipCategory: "ANCHOR_PRICE_OUT_OF_RANGE",
        upBidDepthShare,
        downBidDepthShare,
        stabilityDetail
      };
    }
    return {
      shouldTrade: true,
      side: "UP",
      imbalanceScore,
      stabilityMet,
      chainlinkMom,
      anchorPrice: anchorYesPrice,
      reason: `ANCHOR OK: UP bid-share>${config.upBidDepthShareMin} x${n}, mom=${(chainlinkMom * 100).toFixed(4)}%, YES=${anchorYesPrice.toFixed(3)}`,
      upBidDepthShare,
      downBidDepthShare,
      stabilityDetail,
      oracleAgeMs: oracleLatestAgeMs ?? undefined
    };
  }

  if (chainlinkMom >= -config.chainlinkMomThreshold) {
    return {
      shouldTrade: false,
      side: null,
      imbalanceScore,
      stabilityMet,
      chainlinkMom,
      anchorPrice: anchorNoPrice,
      reason: `ANCHOR_SKIP MOMENTUM_MISMATCH: DOWN needs mom < ${-config.chainlinkMomThreshold}, got ${chainlinkMom.toFixed(6)}`,
      skipCategory: "MOMENTUM_MISMATCH",
      upBidDepthShare,
      downBidDepthShare,
      stabilityDetail
    };
  }
  if (anchorNoPrice < config.anchorPriceMin || anchorNoPrice > config.anchorPriceMax) {
    return {
      shouldTrade: false,
      side: "DOWN",
      imbalanceScore,
      stabilityMet,
      chainlinkMom,
      anchorPrice: anchorNoPrice,
      reason: `ANCHOR_SKIP ANCHOR_PRICE_OUT_OF_RANGE: NO ${anchorNoPrice.toFixed(3)} not in [${config.anchorPriceMin}, ${config.anchorPriceMax}]`,
      skipCategory: "ANCHOR_PRICE_OUT_OF_RANGE",
      upBidDepthShare,
      downBidDepthShare,
      stabilityDetail
    };
  }
  return {
    shouldTrade: true,
    side: "DOWN",
    imbalanceScore,
    stabilityMet,
    chainlinkMom,
    anchorPrice: anchorNoPrice,
    reason: `ANCHOR OK: DOWN token ask-heavy (bid-share<${config.downBidDepthShareMax}) x${n}, mom=${(chainlinkMom * 100).toFixed(4)}%, NO=${anchorNoPrice.toFixed(3)}`,
    upBidDepthShare,
    downBidDepthShare,
    stabilityDetail,
    oracleAgeMs: oracleLatestAgeMs ?? undefined
  };
}

export function anchorShouldExitUpOnMomentum(
  chainlinkMom: number,
  config: Pick<AnchorStrategyConfig, "chainlinkMomReverseThreshold">
): boolean {
  return chainlinkMom < config.chainlinkMomReverseThreshold;
}

export function anchorShouldExitDownOnMomentum(chainlinkMom: number, posThreshold: number): boolean {
  return chainlinkMom > posThreshold;
}

/**
 * USD size for Anchor entries. Uses `ANCHOR_TRADE_SIZE` when set to a positive number; otherwise `fallbackEntryUsd`
 * (typically engine `effEntryUsd()` from `ENTRY_USD` / risk API).
 * For LIVE smoke tests, ANCHOR_TRADE_SIZE overrides generic entry sizing.
 */
export function resolveAnchorTradeSizeUsd(fallbackEntryUsd: number): number {
  const raw = process.env.ANCHOR_TRADE_SIZE;
  if (raw != null && String(raw).trim() !== "") {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fb = Number(fallbackEntryUsd);
  return Number.isFinite(fb) && fb > 0 ? fb : 1;
}

/**
 * Live-test oriented env (documented in `.env.example`):
 * ```env
 * MODE=LIVE
 * ENTRY_STRATEGY=anchor
 * ANCHOR_STRATEGY_ENABLED=true
 * ANCHOR_ALLOW_FALLBACK=false
 * ANCHOR_TRADE_SIZE=1.00
 * ANCHOR_FAST_LANE=false
 * ANCHOR_DEBUG_LOGS=true
 * ```
 */
export function loadAnchorConfigFromEnv(fallbackEntryUsd = 1): AnchorStrategyConfig {
  return {
    enabled: String(process.env.ANCHOR_STRATEGY_ENABLED ?? "").toLowerCase() === "true",
    stabilityTicks: parseEnvFiniteNumber("ANCHOR_STABILITY_TICKS", 3),
    upBidDepthShareMin: parseEnvFiniteNumber("ANCHOR_IMBALANCE_THRESHOLD", 0.7),
    downBidDepthShareMax: parseEnvFiniteNumber("ANCHOR_IMBALANCE_DOWN_WEAK", 0.3),
    chainlinkMomThreshold: parseEnvFiniteNumber("ANCHOR_CHAINLINK_MOM_THRESHOLD", 0.0003),
    chainlinkMomReverseThreshold: parseEnvFiniteNumber("ANCHOR_MOM_REVERSE_THRESHOLD", -0.0005),
    anchorPriceMin: parseEnvFiniteNumber("ANCHOR_PRICE_MIN", 0.4),
    anchorPriceMax: parseEnvFiniteNumber("ANCHOR_PRICE_MAX", 0.65),
    tradeSize: resolveAnchorTradeSizeUsd(fallbackEntryUsd),
    exitBufferSeconds: parseEnvFiniteNumber("ANCHOR_EXIT_BUFFER_SECONDS", 30),
    maxYesMid: parseEnvFiniteNumber("ANCHOR_MAX_YES_MID", 0.7),
    minSecondsToExpiry: parseEnvFiniteNumber("ANCHOR_MIN_SECONDS_TO_EXPIRY", 60),
    maxOracleAgeMs: parseEnvFiniteNumber("ANCHOR_MAX_ORACLE_AGE_MS", 15_000),
    momentumLookbackPrices: parseEnvFiniteNumber("ANCHOR_MOMENTUM_LOOKBACK_PRICES", 4),
    anchorDebugLogs: String(process.env.ANCHOR_DEBUG_LOGS ?? "").toLowerCase() === "true"
  };
}
