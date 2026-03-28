import { ethers } from "ethers";
import { Wallet as EthersV5Wallet } from "@ethersproject/wallet";
import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { DirectionalContext, MarketContext, MarketOption } from "../types/index.js";
import { signatureTypeModeName } from "../constants/signatureType.js";
import { resolveActiveUpDown5m } from "./marketDiscovery.js";

export class WalletService {
  private mode = (process.env.MODE as "SIMULATION" | "LIVE") || "SIMULATION";
  /**
   * When MODE=SIMULATION, still connect CLOB (read-only) so paper trades use real UP/DOWN books
   * and auto-discovery. No orders are posted unless MODE=LIVE.
   */
  private demoLiveMarkets = String(process.env.DEMO_LIVE_MARKETS ?? "false").toLowerCase() === "true";
  private wallet?: ethers.Wallet;
  private client?: ClobClient;
  private clobHost = process.env.CLOB_HOST ?? "https://clob.polymarket.com";
  private clobChainId = Number(process.env.CLOB_CHAIN_ID ?? 137);
  /** Decimal only (0/1/2). `SIGNATURE_TYPE` wins over legacy `CLOB_SIGNATURE_TYPE`. */
  private clobSignatureType = WalletService.readSignatureTypeFromEnv();
  private clobFunder = process.env.CLOB_FUNDER_ADDRESS;
  private clobTokenId = process.env.CLOB_TOKEN_ID;
  private clobTokenIdUp = process.env.CLOB_TOKEN_ID_UP;
  private clobTokenIdDown = process.env.CLOB_TOKEN_ID_DOWN;
  private clobApiKeyReady = false;
  private clobApiKey = process.env.POLY_API_KEY;
  private clobApiSecret = process.env.POLY_API_SECRET;
  private clobApiPassphrase = process.env.POLY_PASSPHRASE ?? process.env.POLY_API_PASSPHRASE;

  private static readSignatureTypeFromEnv(): number {
    const raw = process.env.SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE ?? "0";
    const s = String(raw).trim();
    if (!s) return 0;
    if (/^0x[0-9a-fA-F]+$/i.test(s)) {
      console.warn("[WalletService] SIGNATURE_TYPE must be decimal 0, 1, or 2 (not hex). Defaulting to 0.");
      return 0;
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return 0;
    return Math.trunc(n);
  }

  /** Set by Gamma auto-discovery when AUTO_DISCOVER_UPDOWN is true (LIVE). */
  private discoveredUpDown: {
    tokenIdUp: string;
    tokenIdDown: string;
    label: string;
    slug: string;
    /** ISO end time from Gamma (market window expiry). */
    endDateIso: string;
    /** From slug …-updown-5m-{unix}; used for “time since rollover”. */
    windowStartSec?: number;
  } | null = null;

  private autoDiscoverUpDownEnabled() {
    return String(process.env.AUTO_DISCOVER_UPDOWN ?? "true").toLowerCase() !== "false";
  }

  private upDownAssetFromEnv() {
    return process.env.UPDOWN_ASSET ?? "BTC";
  }

  /** CLOB token id for UP outcome (auto-resolved or CLOB_TOKEN_ID_UP / CLOB_TOKEN_ID). */
  private activeTokenUp(): string | undefined {
    if (this.discoveredUpDown?.tokenIdUp) return this.discoveredUpDown.tokenIdUp;
    return this.clobTokenIdUp || this.clobTokenId;
  }

  /** CLOB token id for DOWN outcome (auto-resolved or CLOB_TOKEN_ID_DOWN / CLOB_TOKEN_ID). */
  private activeTokenDown(): string | undefined {
    if (this.discoveredUpDown?.tokenIdDown) return this.discoveredUpDown.tokenIdDown;
    return this.clobTokenIdDown || this.clobTokenId;
  }

  getDiscoveredMarketLabel(): string | null {
    return this.discoveredUpDown?.label ?? null;
  }

  /** For UI / engine: primary token id + label when auto-discovery is active. */
  getDiscoveredSelection(): { tokenID: string; label: string } | null {
    if (!this.discoveredUpDown) return null;
    return { tokenID: this.discoveredUpDown.tokenIdUp, label: this.discoveredUpDown.label };
  }

  /** Gamma metadata for the active auto-discovered window (LIVE + discovery only). */
  getDiscoveredMeta():
    | {
        label: string;
        slug: string;
        endDateIso: string;
        windowStartSec?: number;
        tokenIdUp: string;
        tokenIdDown: string;
      }
    | null {
    if (!this.discoveredUpDown) return null;
    const d = this.discoveredUpDown;
    return {
      label: d.label,
      slug: d.slug,
      endDateIso: d.endDateIso,
      windowStartSec: d.windowStartSec,
      tokenIdUp: d.tokenIdUp,
      tokenIdDown: d.tokenIdDown
    };
  }

  isAutoDiscoverEnabled() {
    return this.autoDiscoverUpDownEnabled();
  }

  isClobAuthenticated() {
    return Boolean(this.client) && this.clobApiKeyReady;
  }

  /** Seconds since current 5m window started (auto-discovery only); null if manual tokens. */
  getTimingForBetLog(): { secondsSinceWindowStart: number | null; warmupWindow: boolean } {
    const ws = this.discoveredUpDown?.windowStartSec;
    if (ws == null) return { secondsSinceWindowStart: null, warmupWindow: false };
    const elapsed = Date.now() / 1000 - ws;
    const warmupSec = Number(process.env.MARKET_WARMUP_SEC ?? 90);
    return {
      secondsSinceWindowStart: Math.max(0, Math.round(elapsed)),
      warmupWindow: elapsed >= 0 && elapsed < warmupSec
    };
  }

  /**
   * Fetches the current 5m Up/Down market from Gamma (slug by UTC window).
   * @returns true if UP/DOWN token ids changed (new window).
   */
  async refreshActiveUpDownMarket(): Promise<boolean> {
    if (!this.client || !this.clobApiKeyReady || !this.autoDiscoverUpDownEnabled()) {
      return false;
    }
    const resolved = await resolveActiveUpDown5m(this.upDownAssetFromEnv());
    if (!resolved) return false;
    const prev = this.discoveredUpDown;
    const changed =
      !prev || prev.tokenIdUp !== resolved.tokenIdUp || prev.tokenIdDown !== resolved.tokenIdDown;
    const wm = /-updown-5m-(\d+)$/.exec(resolved.slug);
    const windowStartSec = wm ? Number(wm[1]) : undefined;
    this.discoveredUpDown = {
      tokenIdUp: resolved.tokenIdUp,
      tokenIdDown: resolved.tokenIdDown,
      label: resolved.label,
      slug: resolved.slug,
      endDateIso: resolved.endDate,
      windowStartSec
    };
    return changed;
  }

  private newClient(wallet: ethers.Wallet, creds?: { apiKey?: string; key?: string; secret: string; passphrase: string }, signatureType?: number) {
    const normalizedCreds = creds
      ? {
          key: creds.key ?? creds.apiKey ?? "",
          secret: creds.secret,
          passphrase: creds.passphrase
        }
      : undefined;
    return new ClobClient(
      this.clobHost,
      this.clobChainId as any,
      wallet as any,
      normalizedCreds as any,
      (signatureType ?? this.clobSignatureType) as any,
      this.clobFunder,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    );
  }

  getMode(): "SIMULATION" | "LIVE" {
    return this.mode;
  }

  /** True when CLOB is connected for live order books (LIVE mode or demo paper + DEMO_LIVE_MARKETS). */
  hasLiveMarketData(): boolean {
    return Boolean(this.client) && this.clobApiKeyReady;
  }

  getDemoLiveMarkets(): boolean {
    return this.demoLiveMarkets;
  }

  /**
   * Public params for browser MetaMask signing (no secrets).
   * - EOA (0): MetaMask should match funder.
   * - GNOSIS_SAFE (2) / POLY_PROXY (1): MetaMask EOA should match `signerAddress` (from `EVM_PRIVATE_KEY`); funder is the proxy/Safe.
   */
  getPublicSigningConfig():
    | {
        host: string;
        chainId: number;
        signatureType: number;
        funderAddress: string;
        /** EOA derived from server `EVM_PRIVATE_KEY` — must match MetaMask when using proxy/Safe funder. */
        signerAddress?: string;
        tokenIdUp: string;
        tokenIdDown: string;
      }
    | null {
    if (!this.clobFunder || !/^0x[a-fA-F0-9]{40}$/.test(this.clobFunder)) return null;
    const up = this.activeTokenUp();
    const down = this.activeTokenDown();
    if (!up || !down) return null;
    return {
      host: this.clobHost,
      chainId: this.clobChainId,
      signatureType: this.clobSignatureType,
      funderAddress: this.clobFunder,
      signerAddress: this.wallet?.address,
      tokenIdUp: up,
      tokenIdDown: down
    };
  }

  private teardownLive() {
    this.client = undefined;
    this.wallet = undefined;
    this.clobApiKeyReady = false;
    this.discoveredUpDown = null;
  }

  /** Connect CLOB + L2; on failure sets mode to SIMULATION (same as startup). */
  private async connectLive() {
    const pkRaw = process.env.EVM_PRIVATE_KEY;
    const pk = pkRaw?.startsWith("0x") ? pkRaw : pkRaw ? `0x${pkRaw}` : pkRaw;
    if (!pk) {
      console.warn("[WalletService] Missing EVM_PRIVATE_KEY — staying in simulation");
      this.mode = "SIMULATION";
      this.teardownLive();
      return;
    }
    if (pk.includes("REPLACE_WITH_") || pk.includes("YOUR_REAL_PRIVATE_KEY")) {
      console.warn("[WalletService] EVM_PRIVATE_KEY placeholder — staying in simulation");
      this.mode = "SIMULATION";
      this.teardownLive();
      return;
    }
    if (!this.clobFunder || !/^0x[a-fA-F0-9]{40}$/.test(this.clobFunder)) {
      console.warn("[WalletService] CLOB_FUNDER_ADDRESS invalid — staying in simulation");
      this.mode = "SIMULATION";
      this.teardownLive();
      return;
    }
    this.wallet = new EthersV5Wallet(pk) as unknown as ethers.Wallet;

    const envCreds =
      this.clobApiKey && this.clobApiSecret && this.clobApiPassphrase
        ? { apiKey: this.clobApiKey, secret: this.clobApiSecret, passphrase: this.clobApiPassphrase }
        : null;

    // If the user explicitly configured SIGNATURE_TYPE, we should not try other signature
    // modes, otherwise the runtime "role" (funder vs signer) may flip unexpectedly.
    const explicitSignatureType =
      process.env.SIGNATURE_TYPE != null && String(process.env.SIGNATURE_TYPE).trim() !== "";
    const signatureTypes = explicitSignatureType
      ? [this.clobSignatureType]
      : Array.from(new Set([this.clobSignatureType, 0, 1, 2]));
    let lastError: unknown = null;
    for (const signatureType of signatureTypes) {
      try {
        const bootstrapClient = this.newClient(this.wallet, undefined, signatureType);
        const derivedCreds: any = envCreds ?? (await bootstrapClient.createOrDeriveApiKey());
        const hasKey = derivedCreds?.apiKey ?? derivedCreds?.key;
        if (!hasKey || !derivedCreds?.secret || !derivedCreds?.passphrase) {
          throw new Error("Could not derive L2 credentials");
        }
        const candidate = this.newClient(this.wallet, derivedCreds, signatureType);
        await candidate.getOpenOrders();
        this.client = candidate;
        this.clobSignatureType = signatureType;
        this.clobApiKeyReady = true;
        const signerAddr = this.wallet.address;
        const funderAddr = this.clobFunder ?? "";
        const signerEqualsFunder = signerAddr.toLowerCase() === funderAddr.toLowerCase();
        const modeName = signatureTypeModeName(signatureType);
        console.log(
          `[WalletService] signerAddress=${signerAddr} funderAddress=${funderAddr} signatureType=${signatureType} mode=${modeName} signerEqualsFunder=${signerEqualsFunder}`
        );
        if (this.autoDiscoverUpDownEnabled()) {
          await this.refreshActiveUpDownMarket().catch(() => undefined);
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : "unknown";
    console.warn(`[WalletService] LIVE auth unavailable, falling back to simulation: ${reason}`);
    this.mode = "SIMULATION";
    this.teardownLive();
  }

  async init() {
    if (this.mode !== "LIVE" && !this.demoLiveMarkets) return;
    await this.connectLive();
  }

  /**
   * Runtime switch between paper (SIMULATION) and real CLOB (LIVE).
   * LIVE may fall back to SIMULATION if keys/auth fail (same as cold start).
   */
  async setMode(next: "SIMULATION" | "LIVE"): Promise<{ ok: boolean; reason?: string }> {
    if (next === this.mode) return { ok: true };
    if (next === "SIMULATION") {
      this.mode = next;
      if (!this.demoLiveMarkets) {
        this.teardownLive();
      } else if (!this.hasLiveMarketData()) {
        await this.connectLive();
      }
      return { ok: true };
    }
    this.teardownLive();
    this.mode = next;
    await this.connectLive();
    if (this.mode !== "LIVE" || !this.clobApiKeyReady) {
      return {
        ok: false,
        reason: "Could not activate LIVE CLOB (check EVM_PRIVATE_KEY, POLY_*, funder). Running as simulation."
      };
    }
    return { ok: true };
  }

  getSummary() {
    return {
      mode: this.mode,
      /** Polymarket trading/funder (proxy/Safe or EOA). */
      address: this.clobFunder ?? this.wallet?.address,
      signerAddress: this.wallet?.address,
      funderAddress: this.clobFunder,
      signatureType: this.clobSignatureType,
      network: this.mode === "LIVE" ? "polygon" : "simulation",
      connected: this.mode === "SIMULATION" || (Boolean(this.wallet) && this.clobApiKeyReady),
      demoLiveMarkets: this.demoLiveMarkets,
      liveBooksConnected: this.hasLiveMarketData()
    };
  }

  /** USDC collateral available for trading (6 decimals on Polygon). */
  async getCollateralUsdc(): Promise<number | null> {
    if (this.mode !== "LIVE" || !this.client) return null;
    try {
      const res = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const raw = BigInt(String(res.balance ?? "0"));
      return Number(raw) / 1e6;
    } catch {
      return null;
    }
  }

  async getMarkets(limit = 20): Promise<MarketOption[]> {
    if (!this.client) {
      return [
        { tokenID: "sim-btc-up", label: "BTC 5s UP", outcome: "UP" },
        { tokenID: "sim-btc-down", label: "BTC 5s DOWN", outcome: "DOWN" }
      ];
    }
    const res: any = await this.client.getSimplifiedMarkets().catch(() => null);
    const data = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    const discovered = data
      .flatMap((m: any) => {
        const question = String(m?.question ?? m?.market ?? "Polymarket");
        const outcomes = Array.isArray(m?.outcomes) ? m.outcomes : [];
        return outcomes.map((o: any) => ({
          tokenID: String(o?.token_id ?? o?.tokenID ?? ""),
          label: `${question} - ${String(o?.name ?? o?.outcome ?? "Outcome")}`,
          outcome: String(o?.name ?? o?.outcome ?? "")
        }));
      })
      .filter((m: MarketOption) => m.tokenID)
      .slice(0, limit);
    if (this.discoveredUpDown) {
      const d = this.discoveredUpDown;
      discovered.unshift({
        tokenID: d.tokenIdUp,
        label: d.label,
        outcome: "AUTO"
      });
    }
    if (discovered.length > 0) return discovered;
    const preferred = this.activeTokenUp() || this.clobTokenId || this.activeTokenDown() || "unknown";
    return [{ tokenID: preferred, label: "Configured Market (Bot decides UP/DOWN)", outcome: "AUTO" }];
  }

  async getMarketContext(tokenID: string): Promise<MarketContext> {
    if (!this.client) {
      const bestBid = 0.49;
      const bestAsk = 0.51;
      return {
        tokenID,
        mid: 0.5,
        spread: 0.02,
        liquidity: 1500,
        bestBid,
        bestAsk
      };
    }
    const book: any = await this.client.getOrderBook(tokenID);
    const bidsRaw = Array.isArray(book?.bids) ? book.bids : [];
    const asksRaw = Array.isArray(book?.asks) ? book.asks : [];

    // Some orderbook responses are not guaranteed to be sorted.
    // We must compute the best bid as MAX(price) and best ask as MIN(price).
    const toPrice = (x: any) => Number(x?.price ?? x?.p ?? x?.px ?? NaN);
    const toSize = (x: any) => Number(x?.size ?? x?.s ?? 0);

    const bids = bidsRaw
      .map((b: any) => ({ ...b, _price: toPrice(b) }))
      .filter((b: any) => Number.isFinite(b._price));
    const asks = asksRaw
      .map((a: any) => ({ ...a, _price: toPrice(a) }))
      .filter((a: any) => Number.isFinite(a._price));

    bids.sort((a: any, b: any) => b._price - a._price); // highest bid first
    asks.sort((a: any, b: any) => a._price - b._price); // lowest ask first

    const bestBid = bids.length > 0 ? Number(bids[0]._price) : 0.49;
    const bestAsk = asks.length > 0 ? Number(asks[0]._price) : 0.51;

    const mid = (bestBid + bestAsk) / 2;
    const spread = Math.max(0, bestAsk - bestBid);

    // For “liquidity” we approximate depth at the best side (top 5 levels).
    const bidDepth = bids.slice(0, 5).reduce((a: number, b: any) => a + toSize(b), 0);
    const askDepth = asks.slice(0, 5).reduce((a: number, b: any) => a + toSize(b), 0);
    return {
      tokenID,
      mid: Number(mid.toFixed(4)),
      spread: Number(spread.toFixed(4)),
      liquidity: Number((bidDepth + askDepth).toFixed(2)),
      bestBid: Number(bestBid.toFixed(4)),
      bestAsk: Number(bestAsk.toFixed(4))
    };
  }

  async getDirectionalContext(): Promise<DirectionalContext | null> {
    const upId = this.activeTokenUp();
    const downId = this.activeTokenDown();
    if (!upId || !downId) return null;
    const [up, down] = await Promise.all([this.getMarketContext(upId), this.getMarketContext(downId)]);
    return { up, down };
  }

  async getOpenOrders() {
    if (this.mode !== "LIVE" || !this.client) return [];
    return this.client.getOpenOrders();
  }

  async getOrder(orderId: string) {
    if (!this.client) return null;
    try {
      return await this.client.getOrder(orderId);
    } catch {
      return null;
    }
  }

  /**
   * USDC collateral reserved by open BUY limit orders (approx: price × remaining shares).
   */
  sumReservedBuyCollateralUsdcFromOpenOrders(orders: Array<{ side: string; original_size: string; size_matched: string; price: string }>): number {
    let sum = 0;
    for (const o of orders) {
      if (String(o.side).toUpperCase() !== Side.BUY) continue;
      const orig = Number(o.original_size ?? 0);
      const matched = Number(o.size_matched ?? 0);
      const remaining = Math.max(0, orig - matched);
      const p = Number(o.price ?? 0);
      sum += p * remaining;
    }
    return Number(sum.toFixed(6));
  }

  /** CLOB balance minus open BUY reservations (what you can still spend on new BUYs). */
  async getAvailableCollateralBudget(): Promise<{ balanceUsdc: number; reservedUsdc: number; availableUsdc: number } | null> {
    if (this.mode !== "LIVE" || !this.client || !this.clobApiKeyReady) return null;
    try {
      const ba = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const balanceUsdc = Number(BigInt(String(ba.balance ?? "0"))) / 1e6;
      const raw = await this.client.getOpenOrders();
      const list = Array.isArray(raw) ? raw : [];
      const reservedUsdc = this.sumReservedBuyCollateralUsdcFromOpenOrders(list as any);
      const availableUsdc = Math.max(0, balanceUsdc - reservedUsdc);
      return {
        balanceUsdc: Number(balanceUsdc.toFixed(6)),
        reservedUsdc: Number(reservedUsdc.toFixed(6)),
        availableUsdc: Number(availableUsdc.toFixed(6))
      };
    } catch {
      return null;
    }
  }

  async getBalanceAllowance() {
    if (this.mode !== "LIVE" || !this.client) return { mode: "SIMULATION" };
    return this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  }

  async getUserTrades() {
    if (this.mode !== "LIVE" || !this.client) return [];
    return this.client.getTrades();
  }

  async placeOrder(input: { direction: "UP" | "DOWN"; amount: number; price: number }) {
    if (this.mode !== "LIVE") {
      return { orderID: "simulated", sizeFilled: input.amount, price: input.price, tokenID: "simulation" };
    }
    if (!this.client || !this.clobApiKeyReady) throw new Error("Polymarket client not initialized");
    const tokenID =
      input.direction === "UP" ? this.activeTokenUp() || this.clobTokenId : this.activeTokenDown() || this.clobTokenId;
    if (!tokenID || tokenID === "btc-5s-token") {
      throw new Error("Set CLOB_TOKEN_ID_UP/DOWN or enable AUTO_DISCOVER_UPDOWN for LIVE trading");
    }

    const tickSize = await this.client.getTickSize(tokenID);
    const negRisk = await this.client.getNegRisk(tokenID);
    const side = Side.BUY;
    // `amount` is treated by the engine/UI as collateral USD to risk.
    // In Polymarket CLOB limit orders, `size` is token conditional shares.
    // For BUY orders: collateral cost ~= price * size => size ~= collateral / price.
    const price = input.price;
    const collateral = input.amount;
    const rawShares = price > 0 ? collateral / price : collateral;
    const tick = Number(tickSize);
    const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
    const sizeShares = Number(rawShares.toFixed(decimals));
    const result: any = await this.client.createAndPostOrder(
      {
        tokenID,
        price,
        side,
        size: sizeShares
      },
      {
        tickSize: String(tickSize) as any,
        negRisk
      },
      OrderType.GTC
    );

    return {
      orderID: String(result?.orderID ?? result?.orderId ?? "unknown"),
      sizeFilled: Number(result?.sizeFilled ?? result?.takingAmount ?? result?.sizeMatched ?? 0),
      price: Number(result?.price ?? input.price),
      tokenID
    };
  }

  /**
   * After a BUY fill on UP/DOWN, post GTC on the opposite token (per bot spec: SELL opposite when entry was BUY).
   * Uses postOnly for maker-style resting when supported.
   */
  async postGtcOppositeExit(input: {
    direction: "UP" | "DOWN";
    entrySide: "BUY" | "SELL";
    entryShares: number;
    gtcPrice: number;
    maxShares: number;
  }): Promise<{ orderID: string; tokenID: string; side: string; size: number; latencyMs: number } | null> {
    if (this.mode !== "LIVE" || !this.client || !this.clobApiKeyReady) return null;
    const up = this.activeTokenUp();
    const down = this.activeTokenDown();
    if (!up || !down) return null;

    const oppositeTokenId = input.direction === "UP" ? down : up;
    const side = input.entrySide === "BUY" ? Side.SELL : Side.BUY;

    let size = Math.min(input.maxShares, Math.max(0, input.entryShares));
    if (size <= 0) return null;

    const tickSize = await this.client.getTickSize(oppositeTokenId);
    const negRisk = await this.client.getNegRisk(oppositeTokenId);
    const decimals = String(tickSize).includes(".") ? String(tickSize).split(".")[1].length : 0;
    size = Number(size.toFixed(decimals));
    if (size <= 0) return null;

    const t0 = Date.now();
    let result: any;
    try {
      result = await this.client.createAndPostOrder(
        {
          tokenID: oppositeTokenId,
          price: input.gtcPrice,
          side,
          size
        },
        { tickSize: String(tickSize) as any, negRisk },
        OrderType.GTC,
        false,
        true
      );
    } catch {
      return null;
    }
    const latencyMs = Date.now() - t0;
    const orderID = String(result?.orderID ?? result?.orderId ?? "");
    if (!orderID || orderID === "unknown") return null;
    return { orderID, tokenID: oppositeTokenId, side, size, latencyMs };
  }

  async cancelClobOrder(orderID: string) {
    if (this.mode !== "LIVE" || !this.client || !this.clobApiKeyReady) return;
    try {
      await this.client.cancelOrder({ orderID });
    } catch {
      /* best-effort */
    }
  }

  /** Cancels all open orders for a conditional token (CLOB `asset_id`). */
  async cancelMarketOrdersForAsset(assetId: string) {
    if (this.mode !== "LIVE" || !this.client || !this.clobApiKeyReady) return;
    try {
      await this.client.cancelMarketOrders({ asset_id: assetId });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Market SELL conditional shares (FAK) — flattens a long outcome position on Polymarket.
   */
  async postMarketSellShares(tokenID: string, shares: number): Promise<{ orderID: string } | null> {
    if (this.mode !== "LIVE" || !this.client || !this.clobApiKeyReady) return null;
    const tickSize = await this.client.getTickSize(tokenID);
    const negRisk = await this.client.getNegRisk(tokenID);
    const decimals = String(tickSize).includes(".") ? String(tickSize).split(".")[1].length : 0;
    const amount = Number(Math.max(0, shares).toFixed(decimals));
    if (amount <= 0) return null;
    try {
      const result: any = await this.client.createAndPostMarketOrder(
        {
          tokenID,
          side: Side.SELL,
          amount,
          orderType: OrderType.FAK
        },
        { tickSize: String(tickSize) as any, negRisk },
        OrderType.FAK
      );
      const orderID = String(result?.orderID ?? result?.orderId ?? "");
      if (!orderID) return null;
      return { orderID };
    } catch {
      return null;
    }
  }
}
