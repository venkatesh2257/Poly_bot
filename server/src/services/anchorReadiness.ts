import type {
  AnchorLiveExecutionReason,
  AnchorReadinessSnapshot,
  EntryStrategyKind,
  LiveReadinessSnapshot,
  Mode
} from "../types/index.js";

export function parseDryRunEnv(): boolean {
  const s = String(process.env.DRY_RUN ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function liveExecutionReasonToMessage(reason: AnchorLiveExecutionReason | null): string {
  if (reason == null) return "";
  switch (reason) {
    case "DRY_RUN_MODE":
      return "DRY_RUN_MODE (set DRY_RUN=false for real orders when LIVE + executor is configured)";
    case "SIMULATION_MODE":
      return "SIMULATION_MODE (paper balance — no real Polymarket orders)";
    case "LIVE_EXECUTOR_MISSING":
      return "LIVE_EXECUTOR_MISSING (LIVE mode but CLOB live execution path is not ready)";
    case "LIVE_EXECUTOR_DISABLED_BY_CONFIG":
      return "LIVE_EXECUTOR_DISABLED_BY_CONFIG (ANCHOR_LIVE_EXECUTOR_AVAILABLE=false)";
    default:
      return reason;
  }
}

function computeLiveExecution(input: {
  anchorEnvEnabled: boolean;
  anchorTradingEnabled: boolean;
  dryRunEnv: boolean;
  walletMode: Mode;
  canExecuteLiveOrders: boolean;
  anchorLiveExecutorEnvOk: boolean;
}): { liveExecutionAvailable: boolean; liveExecutionReason: AnchorLiveExecutionReason | null } {
  const {
    anchorEnvEnabled,
    anchorTradingEnabled,
    dryRunEnv,
    walletMode,
    canExecuteLiveOrders,
    anchorLiveExecutorEnvOk
  } = input;

  if (!anchorEnvEnabled) {
    return { liveExecutionAvailable: false, liveExecutionReason: null };
  }
  if (!anchorTradingEnabled) {
    return { liveExecutionAvailable: false, liveExecutionReason: null };
  }
  if (dryRunEnv) {
    return { liveExecutionAvailable: false, liveExecutionReason: "DRY_RUN_MODE" };
  }
  if (walletMode === "SIMULATION") {
    return { liveExecutionAvailable: false, liveExecutionReason: "SIMULATION_MODE" };
  }
  if (!anchorLiveExecutorEnvOk) {
    return { liveExecutionAvailable: false, liveExecutionReason: "LIVE_EXECUTOR_DISABLED_BY_CONFIG" };
  }
  if (!canExecuteLiveOrders) {
    return { liveExecutionAvailable: false, liveExecutionReason: "LIVE_EXECUTOR_MISSING" };
  }
  return { liveExecutionAvailable: true, liveExecutionReason: null };
}

function buildLiveExecutionBanner(input: {
  anchorEnvEnabled: boolean;
  anchorTradingEnabled: boolean;
  liveExecutionAvailable: boolean;
  liveExecutionReason: AnchorLiveExecutionReason | null;
}): { indicator: "green" | "yellow"; text: string } {
  const { anchorEnvEnabled, anchorTradingEnabled, liveExecutionAvailable, liveExecutionReason } = input;

  if (!anchorEnvEnabled) {
    return {
      indicator: "yellow",
      text: "Anchor trading is disabled by server configuration (ANCHOR_STRATEGY_ENABLED=false)."
    };
  }
  if (!anchorTradingEnabled) {
    return {
      indicator: "yellow",
      text: "Anchor trading is not active (runtime toggle or entry strategy)."
    };
  }
  if (liveExecutionAvailable) {
    return {
      indicator: "green",
      text: "Anchor trading is enabled and live execution is available."
    };
  }
  return {
    indicator: "yellow",
    text: `Anchor trading enabled but live execution is not available (reason: ${liveExecutionReasonToMessage(liveExecutionReason)}).`
  };
}

export function computeAnchorReadinessSnapshot(input: {
  entryStrategyEffective: EntryStrategyKind;
  anchorEnvEnabled: boolean;
  anchorRuntimeEnabled: boolean;
  anchorFastLaneEnv: boolean;
  dryRunEnv: boolean;
  walletMode: Mode;
  canExecuteLiveOrders: boolean;
  anchorLiveExecutorEnvOk: boolean;
}): AnchorReadinessSnapshot {
  const {
    entryStrategyEffective,
    anchorEnvEnabled,
    anchorRuntimeEnabled,
    anchorFastLaneEnv,
    dryRunEnv,
    walletMode,
    canExecuteLiveOrders,
    anchorLiveExecutorEnvOk
  } = input;

  const selectedAnchor = entryStrategyEffective === "anchor";
  const anchorConfigured = anchorEnvEnabled;
  const anchorTradingEnabled = selectedAnchor && anchorEnvEnabled && anchorRuntimeEnabled;

  let anchorCadence: AnchorReadinessSnapshot["anchorCadence"] = "off";
  if (anchorTradingEnabled) {
    anchorCadence = anchorFastLaneEnv ? "fast" : "normal";
  }

  let anchorBlockReason: string | null = null;
  const anchorDiagnostics: string[] = [];

  if (selectedAnchor) {
    if (!anchorEnvEnabled) {
      anchorBlockReason = "ANCHOR_DISABLED_BY_ENV";
      anchorDiagnostics.push(
        "Anchor trading is disabled by server configuration (set ANCHOR_STRATEGY_ENABLED=true in .env)."
      );
    } else if (!anchorRuntimeEnabled) {
      anchorBlockReason = "ANCHOR_RUNTIME_DISABLED";
      anchorDiagnostics.push(
        "Anchor is turned off in the dashboard; enable the anchor runtime toggle to allow anchor entries."
      );
    }
    if (anchorTradingEnabled && !anchorFastLaneEnv) {
      anchorDiagnostics.push(
        "Fast-lane anchor entries are disabled; using normal ~5s cadence only (this is expected unless ANCHOR_FAST_LANE=true)."
      );
    }
  }

  const { liveExecutionAvailable, liveExecutionReason } = computeLiveExecution({
    anchorEnvEnabled,
    anchorTradingEnabled,
    dryRunEnv,
    walletMode,
    canExecuteLiveOrders,
    anchorLiveExecutorEnvOk
  });

  if (anchorTradingEnabled) {
    if (!liveExecutionAvailable && liveExecutionReason) {
      anchorDiagnostics.push(
        `Anchor trading enabled but live execution is not available (reason: ${liveExecutionReasonToMessage(liveExecutionReason)}).`
      );
    }
    if (liveExecutionAvailable) {
      anchorDiagnostics.push("Anchor trading is enabled and live execution is available.");
    }
  }

  let anchorStatusSummary: string;
  if (!selectedAnchor) {
    anchorStatusSummary = "Not using anchor entry strategy";
  } else if (!anchorEnvEnabled) {
    anchorStatusSummary = "Disabled by configuration";
  } else if (!anchorRuntimeEnabled) {
    anchorStatusSummary = "Disabled by dashboard toggle";
  } else if (anchorTradingEnabled && anchorFastLaneEnv) {
    anchorStatusSummary = "Enabled (normal + fast lane)";
  } else if (anchorTradingEnabled) {
    anchorStatusSummary = "Normal cadence only";
  } else {
    anchorStatusSummary = "Unavailable";
  }

  const liveExecutionBanner = buildLiveExecutionBanner({
    anchorEnvEnabled,
    anchorTradingEnabled,
    liveExecutionAvailable,
    liveExecutionReason
  });

  return {
    anchorConfigured,
    anchorTradingEnabled,
    anchorFastLaneEnabled: anchorFastLaneEnv,
    anchorCadence,
    anchorBlockReason,
    anchorDiagnostics,
    anchorStatusSummary,
    liveExecutionAvailable,
    liveExecutionReason,
    liveExecutionBanner
  };
}

export function computeLiveReadiness(input: {
  entryStrategyEffective: EntryStrategyKind;
  anchor: AnchorReadinessSnapshot;
  marketDataBlockReason: string | null;
  /** When false, the selected entry strategy cannot place orders in the current mode (config / executor gates). */
  executionEligible: boolean;
  executionBlockedReasons: string[];
}): LiveReadinessSnapshot {
  const {
    entryStrategyEffective,
    anchor,
    marketDataBlockReason,
    executionEligible,
    executionBlockedReasons
  } = input;
  if (marketDataBlockReason) {
    return {
      level: "degraded",
      summary: `Market data issue: ${marketDataBlockReason} — feeds or discovery may be incomplete.`
    };
  }

  if (!executionEligible) {
    const detail =
      executionBlockedReasons.length > 0
        ? executionBlockedReasons.join("; ")
        : "current strategy configuration cannot place orders";
    return {
      level: "partial",
      summary: `Bot running, but no selected auto-trading strategy can place orders (${detail}).`
    };
  }

  if (entryStrategyEffective === "anchor" && anchor.anchorTradingEnabled && !anchor.liveExecutionAvailable) {
    const r = anchor.liveExecutionReason;
    if (r === "DRY_RUN_MODE" || r === "SIMULATION_MODE") {
      return {
        level: "partial",
        summary: `Partial — connectivity can be healthy, but anchor live execution is disabled: ${r} (paper / dry-run).`
      };
    }
    if (r === "LIVE_EXECUTOR_MISSING" || r === "LIVE_EXECUTOR_DISABLED_BY_CONFIG") {
      return {
        level: "partial",
        summary: `Partial — connectivity can be healthy, but anchor live execution is disabled: ${r}.`
      };
    }
  }

  if (entryStrategyEffective === "anchor" && !anchor.anchorTradingEnabled) {
    if (anchor.anchorBlockReason === "ANCHOR_DISABLED_BY_ENV") {
      return {
        level: "partial",
        summary:
          "Partial — connectivity can be healthy, but anchor trading is disabled by server configuration (ANCHOR_STRATEGY_ENABLED)."
      };
    }
    if (anchor.anchorBlockReason === "ANCHOR_RUNTIME_DISABLED") {
      return {
        level: "partial",
        summary:
          "Partial — connectivity can be healthy, but anchor is off in the dashboard; enable the anchor runtime toggle to trade."
      };
    }
    return {
      level: "partial",
      summary: "Partial — anchor entry strategy is selected but the anchor path is not fully available."
    };
  }
  if (
    executionEligible &&
    entryStrategyEffective === "anchor" &&
    anchor.anchorTradingEnabled &&
    anchor.liveExecutionAvailable
  ) {
    return {
      level: "full",
      summary:
        "Ready — live BTC‑5m / ETH‑5m anchor trading enabled (CLOB executes when signals qualify)."
    };
  }
  return {
    level: "full",
    summary: "Live trading readiness: OK — connectivity and selected strategy path are consistent."
  };
}

export function tradingDiagnosticTokenToMessage(token: string): string {
  switch (token) {
    case "auto_start_disabled":
      return "Auto-start is disabled (AUTO_START_BOT); bot will not start until you start it manually.";
    case "discovery_disabled":
      return "Market auto-discovery is disabled; you may need manual token IDs.";
    case "live_auth_not_ready":
      return "CLOB authentication is not ready for LIVE mode (check API keys / wallet).";
    case "entry_strategy_not_enabled":
      return "ENTRY_STRATEGY in .env is set but not recognized; check spelling.";
    case "anchor_runtime_disabled":
      return "Anchor runtime toggle is off in the dashboard.";
    case "auto_trading_off":
      return "Auto-trading is off while the engine is running.";
    default:
      return token;
  }
}
