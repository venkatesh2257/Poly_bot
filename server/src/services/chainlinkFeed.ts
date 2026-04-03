import { ethers } from "ethers";
import { resolvePolygonRpcFallbackUrl, resolvePolygonRpcUrl } from "./rpcEnv.js";

// AggregatorV3Interface (latestRoundData + decimals) ABI.
const AGGREGATOR_V3_ABI = [
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)"
] as const;

// BTC/USD feed on Polygon (AggregatorV3Interface address).
// Extend this map later with ETH/SOL/XRP equivalents.
const CHAINLINK_FEED_BY_ASSET: Record<string, { feedAddress: string }> = {
  BTC: { feedAddress: "0xc907E116054Ad103354f2D350FD2514433D57F6f" }
};

export type ChainlinkUsdPriceTick = {
  asset: string;
  price: number;
  updatedAt: number; // ms epoch
  roundId: string;
  rawAnswer: string;
};

export class ChainlinkFeedService {
  private provider: ethers.JsonRpcProvider | null = null;
  private decimalsByFeed = new Map<string, number>();
  private contractByFeed = new Map<string, ethers.Contract>();
  private inflight = new Map<string, Promise<ChainlinkUsdPriceTick | null>>();
  private lastByAsset = new Map<string, { tick: ChainlinkUsdPriceTick; fetchedAtMs: number }>();
  private connectedLogged = false;

  private staleMaxMs(): number {
    const n =
      Number(process.env.CHAINLINK_MAX_STALE_MS ?? process.env.RTDS_MAX_STALE_MS ?? 8000);
    return Number.isFinite(n) ? Math.max(500, n) : 8000;
  }

  private cacheMs(): number {
    // Prevent hammering JSON-RPC: engine refresh loop is already ~4s.
    const n = Number(process.env.CHAINLINK_FEED_CACHE_MS ?? 2500);
    return Number.isFinite(n) && n >= 300 ? n : 2500;
  }

  private resolveProvider(): ethers.JsonRpcProvider | null {
    if (this.provider) return this.provider;
    const rpcUrl = resolvePolygonRpcUrl() || resolvePolygonRpcFallbackUrl() || "";
    if (!rpcUrl) return null;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
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
      console.warn("[CHAINLINK] feed connection skipped: missing RPC URL in env (POLYGON_RPC_URL/RPC_URL).");
      this.connectedLogged = true;
      return;
    }
    this.connectedLogged = true;
    console.log("[CHAINLINK] feed connected (on-chain BTC/USD via AggregatorV3Interface).");
  }

  async getLatestUsdPrice(asset: string): Promise<ChainlinkUsdPriceTick | null> {
    const a = asset.trim().toUpperCase();
    const feed = this.getFeed(a);
    if (!feed) return null;

    this.ensureConnectedLogged();
    const p = this.resolveProvider();
    if (!p) return null;

    const cached = this.lastByAsset.get(a);
    const now = Date.now();
    if (cached && now - cached.fetchedAtMs <= this.cacheMs()) return cached.tick;

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
          if (!Number.isFinite(decimals)) return null;
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

        // updatedAt is uint256 timestamp; typically seconds.
        let updatedAtMs = Number(updatedAtRaw);
        if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null;
        if (updatedAtMs < 1e12) updatedAtMs *= 1000;

        const rawAnswer = answer.toString();
        const price = Number(ethers.formatUnits(answer, decimals));
        if (!Number.isFinite(price) || price <= 0) return null;

        const ageMs = now - updatedAtMs;
        console.log(
          `[CHAINLINK] latest ${a}/USD price=$${price.toFixed(2)} updatedAt=${new Date(updatedAtMs).toISOString()} roundId=${roundId.toString()}`
        );

        if (ageMs > this.staleMaxMs()) {
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
        console.warn(
          `[CHAINLINK] failed latest ${a}/USD: ${e instanceof Error ? e.message : String(e)}`
        );
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

