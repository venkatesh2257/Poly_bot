import type {
  AnchorReadinessSnapshot,
  EntryStrategyKind,
  ExecutionEligibilityWire,
  Mode
} from "../types/index.js";

/**
 * Whether the selected auto-trade path can actually place orders (paper in SIMULATION, live CLOB in LIVE).
 * Does not change signal math — observability / startup truthfulness only.
 */
export function computeExecutionEligibility(input: {
  entryStrategyEffective: EntryStrategyKind;
  mode: Mode;
  dryRunEnv: boolean;
  anchorReadiness: AnchorReadinessSnapshot;
  smEnabled: boolean;
  canExecuteLiveOrders: boolean;
  anchorLiveExecutorEnvOk: boolean;
}): ExecutionEligibilityWire {
  const {
    entryStrategyEffective: eff,
    mode,
    dryRunEnv,
    anchorReadiness: ar,
    smEnabled,
    canExecuteLiveOrders,
    anchorLiveExecutorEnvOk
  } = input;

  const blocked: string[] = [];
  const eligible: EntryStrategyKind[] = [];

  const pushBlocked = (s: string) => {
    if (!blocked.includes(s)) blocked.push(s);
  };

  if (eff === "anchor") {
    if (!ar.anchorConfigured) pushBlocked("Anchor disabled by config");
    if (ar.anchorBlockReason === "ANCHOR_RUNTIME_DISABLED") pushBlocked("Anchor runtime disabled in dashboard");
    const canRun =
      ar.anchorTradingEnabled && (mode === "SIMULATION" || (mode === "LIVE" && ar.liveExecutionAvailable));
    if (canRun) eligible.push("anchor");
    else {
      if (mode === "LIVE") {
        if (dryRunEnv) pushBlocked("Anchor trading disabled (DRY_RUN=true)");
        else if (!ar.liveExecutionAvailable) {
          if (ar.liveExecutionReason === "LIVE_EXECUTOR_MISSING" || ar.liveExecutionReason === "LIVE_EXECUTOR_DISABLED_BY_CONFIG") {
            pushBlocked("Anchor live executor unavailable");
          } else if (ar.liveExecutionReason != null) {
            pushBlocked(`Anchor live execution blocked (${ar.liveExecutionReason})`);
          } else {
            pushBlocked("Anchor live executor unavailable");
          }
        }
      }
    }
  } else if (eff === "selective_momentum") {
    if (!smEnabled) pushBlocked("PM5M disabled by config (SM_ENABLED=false)");
    const canRun =
      smEnabled &&
      (mode === "SIMULATION" ||
        (mode === "LIVE" && !dryRunEnv && canExecuteLiveOrders && anchorLiveExecutorEnvOk));
    if (canRun) eligible.push("selective_momentum");
    else {
      if (mode === "LIVE" && smEnabled) {
        if (dryRunEnv) pushBlocked("PM5M live blocked (DRY_RUN=true)");
        else if (!anchorLiveExecutorEnvOk) pushBlocked("PM5M live executor unavailable");
        else if (!canExecuteLiveOrders) pushBlocked("Live execution disabled (EXECUTE_TRADES / PAPER_TRADING / PAPER_ONLY)");
      }
    }
  } else {
    const canRun = mode === "SIMULATION" || canExecuteLiveOrders;
    if (canRun) eligible.push(eff);
    else {
      pushBlocked("Live execution disabled (EXECUTE_TRADES / PAPER_TRADING / PAPER_ONLY)");
    }
  }

  const selectedEligible = eligible.includes(eff);
  return {
    eligibleStrategies: eligible,
    blockedReasons: blocked,
    selectedEligible,
    /** First blocked reason; stable one-line for UI when `selectedEligible` is false. */
    primaryBlockedReason: blocked[0]
  };
}
