import { ethers } from "ethers";
import { polygonRpcUrlLooksPlaceholder } from "./rpcEnv.js";

// AggregatorV3Interface (latestRoundData + decimals) ABI.
const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
] as const;

// Chainlink AggregatorV3Interface feed addresses on Polygon mainnet.
const CHAINLINK_FEED_BY_ASSET: Record<string, { feedAddress: string }> = {
  BTC: { feedAddress: "0xc907E116054Ad103354f2D350FD2514433D57F6f" },
  ETH: { feedAddress: "0xF9680D99D6C9589E2A93A78A04A279E509205945" },
  SOL: { feedAddress: "0x10C8264C0935b3B9870013e057f330Ff3e9C56dC" },
  XRP: { feedAddress: "0x785ba89291f676b5386652eB12b30cF361020694" }
};

/** Public Polygon HTTPS JSON-RPC when no env candidate passes health check. */
const PUBLIC_POLYGON_RPC_FALLBACK = "https://rpc.ankr.com/polygon";

/** Strict resolution order (same precedence as rpcEnv.resolvePolygonRpcUrl). */
const RPC_ENV_KEYS = ["POLYGON_RPC_PROXY_URL", "PROXY_URL", "POLYGON_RPC_URL", "RPC_URL"] as const;

const BOOT_TEST_ASSETS = ["BTC", "ETH", "SOL", "XRP"] as const;

export type ChainlinkUsdPriceTick = {
  asset: string;
  price: number;
  updatedAt: number; // ms epoch
  roundId: string;
  rawAnswer: string;
};

function maskRpcUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/v2\/([^/]+)$/i);
    if (m && m[1]) u.pathname = "/v2/***";
    return u.toString();
  } catch {
    return url.length > 64 ? `${url.slice(0, 64)}…` : url;
  }
}

export class ChainlinkFeedService {
  /** Cached working JSON-RPC endpoint after `initializeRpc()` (env or public fallback). */
  rpcUrl: string | null = null;
  private provider: ethers.JsonRpcProvider | null = null;
  private decimalsByFeed = new Map<string, number>();
  private contractByFeed = new Map<string, ethers.Contract>();
  private inflight = new Map<string, Promise<ChainlinkUsdPriceTick | null>>();
  private lastByAsset = new Map<string, { tick: ChainlinkUsdPriceTick; fetchedAtMs: number }>();
  private lastFailByAsset = new Map<string, number>();
  private connectedLogged = false;
  private initPromise: Promise<void> | null = null;
  private rpcInitComplete = false;

  /**
   * Production-safe RPC validation on boot (non-blocking).
   * Kicks off `initializeRpc()` once: priority resolve → health check → optional public fallback → 4-asset probe.
   */
  validateOnStartup() {
    if (!this.initPromise) {
      this.initPromise = this.performRpcInitialization();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.performRpcInitialization();
    }
    await this.initPromise;
  }

  private async validateRpc(rpcUrl: string): Promise<boolean> {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      await provider.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve + validate Polygon RPC (env order, then public fallback). Idempotent; safe to await on every boot.
   */
  public async initializeRpc(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * After RPC is ready, probe all four feeds via `getLatestUsdPrice` (boot confirmation; failures logged, no throw).
   */
  public async testStartupConnectivity(): Promise<void> {
    await this.ensureInitialized();
    console.log("[CHAINLINK] Startup test: running (BTC, ETH, SOL, XRP) …");
    const parts: string[] = [];
    for (const asset of BOOT_TEST_ASSETS) {
      const tick = await this.getLatestUsdPrice(asset, { silent: true });
      const ok = tick != null && Number.isFinite(tick.price) && tick.price > 0;
      console.log(`[CHAINLINK] Startup test: ${asset}=${ok ? "✓" : "✗"}`);
      parts.push(`${asset}=${ok ? "✓" : "✗"}`);
    }
    console.log(`[CHAINLINK] Startup test: ${parts.join(" ")}`);
    console.log("[CHAINLINK] Boot: Chainlink connectivity checks complete.");
  }

  /**
   * Resolves RPC in strict env order, validates each with `getBlockNumber`, falls back to Ankr public if needed,
   * caches `this.rpcUrl` / `this.provider`, logs clearly.
   */
  private async performRpcInitialization(): Promise<void> {
    if (this.rpcInitComplete) return;
    try {
      console.log(
        `[CHAINLINK][RPC] resolving (order=${RPC_ENV_KEYS.join(" → ")}; fallback=${maskRpcUrlForLog(PUBLIC_POLYGON_RPC_FALLBACK)})`
      );

      let selected: { url: string; source: string } | null = null;

      for (const envKey of RPC_ENV_KEYS) {
        const raw = (process.env[envKey] ?? "").trim();
        if (!raw) continue;
        if (polygonRpcUrlLooksPlaceholder(raw)) {
          console.warn(`[CHAINLINK][RPC] skip ${envKey}: placeholder URL`);
          continue;
        }
        console.log(`[CHAINLINK][RPC] health check ${envKey} → ${maskRpcUrlForLog(raw)}`);
        const ok = await this.validateRpc(raw);
        if (ok) {
          selected = { url: raw, source: envKey };
          break;
        }
        console.warn(`[CHAINLINK][WARN] ${envKey} failed health check (getBlockNumber)`);
      }

      if (!selected) {
        console.warn("[CHAINLINK][RPC] no env RPC passed health check — trying public fallback");
        const ok = await this.validateRpc(PUBLIC_POLYGON_RPC_FALLBACK);
        if (ok) {
          selected = { url: PUBLIC_POLYGON_RPC_FALLBACK, source: "PUBLIC_FALLBACK_ANKR" };
        } else {
          console.warn(
            `[CHAINLINK][WARN] public fallback failed health check: ${maskRpcUrlForLog(PUBLIC_POLYGON_RPC_FALLBACK)}`
          );
        }
      }

      if (!selected) {
        console.warn(
          "[CHAINLINK][WARN] no working Polygon RPC (env + public fallback). Chainlink reads will return null until RPC is fixed."
        );
        this.rpcUrl = null;
        this.provider = null;
        this.connectedLogged = true;
        return;
      }

      this.rpcUrl = selected.url;
      this.provider = new ethers.JsonRpcProvider(selected.url);
      this.connectedLogged = true;
      console.log(`[CHAINLINK] Using RPC: ${maskRpcUrlForLog(selected.url)} (source=${selected.source})`);
      console.log("[CHAINLINK] feed connected (on-chain AggregatorV3Interface).");
    } catch (e) {
      console.warn(`[CHAINLINK][WARN] initializeRpc error: ${e instanceof Error ? e.message : String(e)}`);
      this.rpcUrl = null;
      this.provider = null;
      this.connectedLogged = true;
    } finally {
      this.rpcInitComplete = true;
    }
  }

  private staleMaxMs(): number {
    const raw = process.env.CHAINLINK_MAX_STALE_MS;
    const parsed = Number(raw);
    if (raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0) {
      return Math.max(500, parsed);
    }
    return 120_000;
  }

  private cacheMs(): number {
    const n = Number(process.env.CHAINLINK_FEED_CACHE_MS ?? 2500);
    return Number.isFinite(n) && n >= 300 ? n : 2500;
  }

  private resolveProvider(): ethers.JsonRpcProvider | null {
    return this.provider;
  }

  private getFeed(asset: string): { feedAddress: string } | null {
    const a = asset.trim().toUpperCase();
    return CHAINLINK_FEED_BY_ASSET[a] ?? null;
  }

  private ensureConnectedLogged() {
    if (this.connectedLogged) return;
    const p = this.resolveProvider();
    if (!p) {
      console.warn("[CHAINLINK][WARN] feed connection skipped: missing/invalid Polygon RPC URL (POLYGON_RPC_URL/RPC_URL).");
      this.connectedLogged = true;
      return;
    }
    this.connectedLogged = true;
    console.log("[CHAINLINK] feed connected (on-chain AggregatorV3Interface).");
  }

  async getLatestUsdPrice(
    asset: string,
    opts?: { silent?: boolean }
  ): Promise<ChainlinkUsdPriceTick | null> {
    await this.ensureInitialized();

    const a = asset.trim().toUpperCase();
    const feed = this.getFeed(a);
    if (!feed) return null;

    this.ensureConnectedLogged();
    const p = this.resolveProvider();
    if (!p) return null;

    const silent = opts?.silent === true;

    const cached = this.lastByAsset.get(a);
    const now = Date.now();
    if (cached && now - cached.fetchedAtMs <= this.cacheMs()) return cached.tick;

    const lastFail = this.lastFailByAsset.get(a);
    if (lastFail && now - lastFail <= this.cacheMs()) return null;

    const existing = this.inflight.get(a);
    if (existing) return existing;

    const prom = (async (): Promise<ChainlinkUsdPriceTick | null> => {
      try {
        const feedAddress = feed.feedAddress;
        let decimals = this.decimalsByFeed.get(feedAddress);
        if (decimals == null) {
          let c = this.contractByFeed.get(feedAddress);
          if (!c) {
            c = new ethers.Contract(feedAddress, AGGREGATOR_V3_ABI, p);
            this.contractByFeed.set(feedAddress, c);
          }
          decimals = Number(await c.decimals());
          if (!Number.isFinite(decimals)) {
            this.lastFailByAsset.set(a, now);
            return null;
          }
          this.decimalsByFeed.set(feedAddress, decimals);
        }

        let contract = this.contractByFeed.get(feed.feedAddress);
        if (!contract) {
          contract = new ethers.Contract(feed.feedAddress, AGGREGATOR_V3_ABI, p);
          this.contractByFeed.set(feed.feedAddress, contract);
        }

        const latest = await contract.latestRoundData();
        const [roundId, answer, _startedAt, updatedAtRaw] = latest as [
          bigint,
          bigint,
          bigint,
          bigint
        ];

        let updatedAtMs = Number(updatedAtRaw);
        if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) {
          this.lastFailByAsset.set(a, now);
          return null;
        }
        if (updatedAtMs < 1e12) updatedAtMs *= 1000;

        const rawAnswer = answer.toString();
        const price = Number(ethers.formatUnits(answer, decimals));
        if (!Number.isFinite(price) || price <= 0) {
          this.lastFailByAsset.set(a, now);
          return null;
        }

        const ageMs = now - updatedAtMs;
        if (!silent) {
          console.log(
            `[CHAINLINK] latest ${a}/USD price=$${price.toFixed(2)} updatedAt=${new Date(updatedAtMs).toISOString()} roundId=${roundId.toString()}`
          );
        }

        if (!silent && ageMs > this.staleMaxMs()) {
          console.warn(
            `[CHAINLINK] stale feed ${a}/USD ageMs=${ageMs} > ${this.staleMaxMs()} (updatedAt=${new Date(updatedAtMs).toISOString()})`
          );
        }

        const tick: ChainlinkUsdPriceTick = {
          asset: a,
          price,
          updatedAt: updatedAtMs,
          roundId: roundId.toString(),
          rawAnswer
        };
        this.lastByAsset.set(a, { tick, fetchedAtMs: now });
        return tick;
      } catch (e) {
        this.lastFailByAsset.set(a, now);
        if (!silent) {
          console.warn(
            `[CHAINLINK] failed latest ${a}/USD: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        return null;
      }
    })();

    this.inflight.set(a, prom);
    try {
      const tick = await prom;
      return tick;
    } finally {
      this.inflight.delete(a);
    }
  }
}
