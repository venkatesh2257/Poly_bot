/**
 * Declares how native Polymarket vs Synthesis data are combined for dashboard and optional bot fallback.
 */

import type { DashboardOrderbookSource, SynthesisChartMode } from "../types/index.js";

export type { DashboardOrderbookSource, SynthesisChartMode };

export function resolveDashboardOrderbookSource(args: {
  synthesisEnabled: boolean;
  dashboardPreferred: boolean;
  synthesisStale: boolean;
  synthesisHasBooks: boolean;
}): DashboardOrderbookSource {
  if (!args.synthesisEnabled || !args.synthesisHasBooks) return "native_polymarket";
  if (args.synthesisStale) return "synthesis_stale_fallback_native";
  if (args.dashboardPreferred) return "synthesis";
  return "native_polymarket";
}

export function resolveDashboardChartMode(args: {
  synthesisEnabled: boolean;
  synthesisHasPrices: boolean;
}): SynthesisChartMode {
  if (!args.synthesisEnabled || !args.synthesisHasPrices) return "native_only";
  return "synthesis_overlay";
}
