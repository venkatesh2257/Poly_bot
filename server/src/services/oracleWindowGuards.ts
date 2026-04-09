/**
 * Paper oracle-binary ORACLE_TOO_CLOSE for BTC 5m windows.
 * When MIN_MS_TO_WINDOW_END_BTC is unset, BTC 5m uses BTC_DEFAULT (500ms), not global 20s.
 */

/** When MIN_MS_TO_WINDOW_END_BTC is unset, use this floor (ms remaining before window end). */
export const BTC_5M_ORACLE_CLOSE_MIN_MS_DEFAULT = 500;

/**
 * Post-window buffer (ms): if >0, still block when `-buffer < ms_to_window_end <= 0`.
 * Default 0 — after end, do not treat as ORACLE_TOO_CLOSE (fixes ms_to_window_end negative vs global 20s).
 */
export function btc5mPostWindowEndBufferMs(): number {
  const n = Number(process.env.BTC_5M_POST_WINDOW_END_BUFFER_MS);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Effective min ms for BTC 5m oracle-close (env override or default 500). */
export function btc5mOracleCloseMinEffectiveMs(): number {
  const btc = Number(process.env.MIN_MS_TO_WINDOW_END_BTC);
  if (Number.isFinite(btc) && btc >= 0) return btc;
  return BTC_5M_ORACLE_CLOSE_MIN_MS_DEFAULT;
}

/**
 * True when paper simulation should skip entry for ORACLE_TOO_CLOSE_BTC_5M.
 * Before end: block if less than minEffective ms remain.
 * After end: only block if postEndBufferMs > 0 and still within that many ms after end.
 */
export function paperOracleTooCloseBtc5m(
  msToWindowEnd: number,
  minEffective: number,
  postEndBufferMs: number
): boolean {
  if (msToWindowEnd > 0) return msToWindowEnd < minEffective;
  if (postEndBufferMs <= 0) return false;
  return msToWindowEnd > -postEndBufferMs;
}

export type Btc5mChainlinkWindowState = "OPEN" | "TOO_CLOSE" | "JUST_CLOSED";

export function btc5mChainlinkWindowStateLabel(
  msToWindowEnd: number,
  minEffective: number,
  postEndBufferMs: number
): Btc5mChainlinkWindowState {
  if (paperOracleTooCloseBtc5m(msToWindowEnd, minEffective, postEndBufferMs)) return "TOO_CLOSE";
  if (msToWindowEnd > 0) return "OPEN";
  return "JUST_CLOSED";
}
