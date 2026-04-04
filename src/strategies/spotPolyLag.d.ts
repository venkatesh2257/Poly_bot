/**
 * Typings for spotPolyLag.js (CommonJS `module.exports`). Runtime unchanged.
 */
interface SpotPolyLagExports {
  configureSpotPolyLagContext: (ctx: unknown) => void;
  connect_binance_ob?: () => Promise<void>;
  get_binance_imbalance: (...args: unknown[]) => unknown;
  binance_ob_confirms: (...args: unknown[]) => boolean;
  get_poly_clob: (...args: unknown[]) => Promise<unknown>;
  poly_clob_valid: (...args: unknown[]) => boolean;
  spot_poly_lag_engine: (...args: unknown[]) => void | Promise<void>;
}

declare const spotPolyLag: SpotPolyLagExports;
export = spotPolyLag;
