import { ethers } from "ethers";
import { Wallet as EthersV5Wallet } from "@ethersproject/wallet";
import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { DirectionalContext, MarketContext, MarketOption } from "../types/index.js";
import { signatureTypeModeName } from "../constants/signatureType.js";
import { resolveActiveUpDown5m } from "./marketDiscovery.js";
import { batchBook } from "./clobService.js";
import { normalizeRawOrderBook } from "./paperExecution.js";

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

  /** Concurrent `getMarketContext(token)` coalesces to one CLOB/public HTTP round-trip per token. */
  private bookInflight = new Map<string, Promise<MarketContext>>();
  private readonly clobPublicBookTimeoutMs = (() => {
    const n = Number(process.env.CLOB_PUBLIC_BOOK_TIMEOUT_MS ?? 8_000);
    return Number.isFinite(n) && n >= 2_000 && n <= 30_000 ? n : 8_000;
  })();
  private readonly clobBooksBatchChunk = (() => {
    const n = Number(process.env.CLOB_BOOKS_BATCH_CHUNK ?? 50);
    return Number.isFinite(n) && n >= 2 && n <= 80 ? n : 50;
  })();

  /** Single refresh wave: POST /books fills this map; `getMarketContext` reads it before HTTP. */
  private bookPrime: Map<string, MarketContext> | null = null;

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

  /** One resolved 5m Up/Down window from Gamma (AUTO_DISCOVER_UPDOWN). */
  private discoveredSlots: Array<{
    asset: string;
    tokenIdUp: string;
    tokenIdDown: string;
    label: string;
    slug: string;
    endDateIso: string;
    windowStartSec?: number;
  }> = [];

  /** Index into `discoveredSlots` for books, orders, and UI primary market. */
  private activeSlotIndex = 0;

  private autoDiscoverUpDownEnabled() {
    return String(process.env.AUTO_DISCOVER_UPDOWN ?? "true").toLowerCase() !== "false";
  }

  /** Parsed `UPDOWN_ASSETS` / `UPDOWN_ASSET` for UI and engine. */
  getUpdownAssetsConfigured(): string[] {
    return this.upDownAssetsFromEnv().map((a) => a.trim().toUpperCase());
  }

  /**
   * Comma list from `UPDOWN_ASSETS`, else single `UPDOWN_ASSET`, else default four 5m majors (BTC, ETH, SOL, XRP).
   * Precedence avoids legacy `.env` lines like `UPDOWN_ASSET=BTC` silently overriding a multi list.
   */
  private upDownAssetsFromEnv(): string[] {
    const allowed = ["BTC", "ETH", "SOL", "XRP"];
    const multi = process.env.UPDOWN_ASSETS?.trim();
    if (multi) {
      const parts = multi
        .split(/[,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const filtered = parts.filter((p) => allowed.includes(p));
      return filtered.length ? filtered : allowed;
    }
    const single = process.env.UPDOWN_ASSET?.trim();
    if (single) {
      const s = single.toUpperCase();
      if (allowed.includes(s)) {
        // Legacy single-symbol env should still enable the full 4-asset set.
        return [...allowed];
      }
      return allowed;
    }
    return allowed;
  }

  private activeSlot() {
    if (this.discoveredSlots.length === 0) return null;
    const i = Math.max(0, Math.min(this.activeSlotIndex, this.discoveredSlots.length - 1));
    return this.discoveredSlots[i] ?? null;
  }

  /** How many active 5m markets were resolved (for round-robin auto-trading). */
  getDiscoveredSlotCount(): number {
    return this.discoveredSlots.length;
  }

  /** Gamma slugs/labels per discovered asset (dashboard multi-pair strip). */
  getDiscoveredWindowsSummary(): Array<{ asset: string; slug: string; label: string }> {
    return this.discoveredSlots.map((s) => ({
      asset: s.asset,
      slug: s.slug,
      label: s.label
    }));
  }

  /** Snapshot for parallel CLOB reads (token ids per asset). */
  getDiscoveredSlotsSnapshot(): Array<{
    asset: string;
    slug: string;
    label: string;
    tokenIdUp: string;
    tokenIdDown: string;
    endDateIso: string;
    windowStartSec?: number;
  }> {
    return this.discoveredSlots.map((s) => ({
      asset: s.asset,
      slug: s.slug,
      label: s.label,
      tokenIdUp: s.tokenIdUp,
      tokenIdDown: s.tokenIdDown,
      endDateIso: s.endDateIso,
      windowStartSec: s.windowStartSec
    }));
  }

  /** Set which discovered market drives CLOB token ids and `getDiscoveredMeta*` (0 = first in UPDOWN_ASSETS). */
  setActiveSlot(index: number) {
    if (this.discoveredSlots.length === 0) return;
    const n = this.discoveredSlots.length;
    this.activeSlotIndex = ((index % n) + n) % n;
  }

  /** Slug of the currently active slot (per-market cooldown key). */
  getActiveDiscoveredSlug(): string | null {
    return this.activeSlot()?.slug ?? null;
  }

  /** Canonical symbol (BTC, ETH, …) for the active discovered slot — used for per-asset spot / BONE_LATENCY. */
  getActiveDiscoveredAsset(): string | null {
    return this.activeSlot()?.asset ?? null;
  }

  /** CLOB token id for UP outcome (auto-resolved or CLOB_TOKEN_ID_UP / CLOB_TOKEN_ID). */
  private activeTokenUp(): string | undefined {
    const s = this.activeSlot();
    if (s?.tokenIdUp) return s.tokenIdUp;
    return this.clobTokenIdUp || this.clobTokenId;
  }

  /** CLOB token id for DOWN outcome (auto-resolved or CLOB_TOKEN_ID_DOWN / CLOB_TOKEN_ID). */
  private activeTokenDown(): string | undefined {
    const s = this.activeSlot();
    if (s?.tokenIdDown) return s.tokenIdDown;
    return this.clobTokenIdDown || this.clobTokenId;
  }

  getDiscoveredMarketLabel(): string | null {
    return this.activeSlot()?.label ?? null;
  }

  /** For UI / engine: primary token id + label when auto-discovery is active. */
  getDiscoveredSelection(): { tokenID: string; label: string } | null {
    const s = this.activeSlot();
    if (!s) return null;
    return { tokenID: s.tokenIdUp, label: s.label };
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
    const d = this.activeSlot();
    if (!d) return null;
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

  /** True when L2 credentials are ready and orders/balance APIs may be used (authenticated trading). */
  hasAuthenticatedLiveTrading(): boolean {
    return Boolean(this.client) && this.clobApiKeyReady;
  }

  isClobAuthenticated() {
    return this.hasAuthenticatedLiveTrading();
  }

  getClobHostForPing(): string {
    return this.clobHost;
  }

  /** Real CLOB token id for connectivity ping; null if only synthetic ids. */
  getSampleTokenIdForPing(): string | null {
    const up = this.activeTokenUp();
    if (up && !/^sim-/i.test(up) && up !== "unknown") return up;
    const down = this.activeTokenDown();
    if (down && !/^sim-/i.test(down) && down !== "unknown") return down;
    if (this.clobTokenId && !/^sim-/i.test(this.clobTokenId)) return this.clobTokenId;
    return null;
  }

  /** Seconds since current 5m window started (auto-discovery only); null if manual tokens. */
  getTimingForBetLog(): { secondsSinceWindowStart: number | null; warmupWindow: boolean } {
    const ws = this.activeSlot()?.windowStartSec;
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
    /** Gamma is public; do not require CLOB keys — SIM / failed LIVE still get slugs + token ids for UI + public books. */
    if (!this.autoDiscoverUpDownEnabled()) {
      return false;
    }
    const assets = this.upDownAssetsFromEnv();
    const pairs = await Promise.all(
      assets.map(async (raw) => {
        const resolved = await resolveActiveUpDown5m(raw);
        return { raw, resolved };
      })
    );
    const next: typeof this.discoveredSlots = [];
    for (const { raw, resolved } of pairs) {
      if (!resolved) continue;
      const wm = /-updown-5m-(\d+)$/.exec(resolved.slug);
      const windowStartSec = wm ? Number(wm[1]) : undefined;
      const asset = raw.trim().toUpperCase();
      next.push({
        asset,
        tokenIdUp: resolved.tokenIdUp,
        tokenIdDown: resolved.tokenIdDown,
        label: resolved.label,
        slug: resolved.slug,
        endDateIso: resolved.endDate,
        windowStartSec
      });
    }
    const prev = this.discoveredSlots;
    if (next.length === 0) {
      const cleared = prev.length > 0;
      this.discoveredSlots = [];
      this.activeSlotIndex = 0;
      return cleared;
    }

    let changed = prev.length !== next.length;
    if (!changed) {
      const prevByAsset = new Map(prev.map((s) => [s.asset, `${s.tokenIdUp}|${s.tokenIdDown}`]));
      for (const s of next) {
        if (prevByAsset.get(s.asset) !== `${s.tokenIdUp}|${s.tokenIdDown}`) {
          changed = true;
          break;
        }
      }
    }
    this.discoveredSlots = next;
    if (this.activeSlotIndex >= this.discoveredSlots.length) this.activeSlotIndex = 0;
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

  /**
   * Public or authenticated live market data available (CLOB books via auth client, public /book, or
   * Gamma-resolved token ids). Not the same as authenticated trading — see `hasAuthenticatedLiveTrading()`.
   */
  hasLiveMarketData(): boolean {
    if (Boolean(this.client) && this.clobApiKeyReady) return true;
    return this.discoveredSlots.length > 0;
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
    this.discoveredSlots = [];
    this.activeSlotIndex = 0;
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
    if (this.mode === "LIVE" || this.demoLiveMarkets) {
      await this.connectLive();
    }
    if (this.autoDiscoverUpDownEnabled()) {
      await this.refreshActiveUpDownMarket().catch((e) =>
        console.warn(`[WalletService] Gamma discovery on init: ${e instanceof Error ? e.message : String(e)}`)
      );
    }
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
    const liveBooks = this.hasLiveMarketData();
    const liveTradingAuth = this.hasAuthenticatedLiveTrading();
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
      liveBooksConnected: liveBooks,
      liveTradingAuthenticated: liveTradingAuth,
      publicBooksOnlyMode: liveBooks && !liveTradingAuth,
      discoveredSlotCount: this.getDiscoveredSlotCount(),
      activeDiscoveredAsset: this.getActiveDiscoveredAsset(),
      activeDiscoveredSlug: this.getActiveDiscoveredSlug()
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
      // Simulation fallback (no CLOB keys / no live client):
      // expose the same 4 majors so UI + manual selection are not BTC-only.
      const assets: Array<"BTC" | "ETH" | "SOL" | "XRP"> = ["BTC", "ETH", "SOL", "XRP"];
      const out: MarketOption[] = [];
      for (const a of assets) {
        out.push({ tokenID: `sim-${a.toLowerCase()}-up`, label: `${a} 5s UP`, outcome: "UP" });
        out.push({ tokenID: `sim-${a.toLowerCase()}-down`, label: `${a} 5s DOWN`, outcome: "DOWN" });
      }
      return out.slice(0, limit);
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
    if (this.discoveredSlots.length > 0) {
      for (let i = this.discoveredSlots.length - 1; i >= 0; i--) {
        const d = this.discoveredSlots[i]!;
        discovered.unshift({
          tokenID: d.tokenIdUp,
          label: `[${d.asset}] ${d.label}`,
          outcome: "AUTO"
        });
      }
    }
    if (discovered.length > 0) return discovered;
    const preferred = this.activeTokenUp() || this.clobTokenId || this.activeTokenDown() || "unknown";
    return [{ tokenID: preferred, label: "Configured Market (Bot decides UP/DOWN)", outcome: "AUTO" }];
  }

  /** CLOB order book is public — use when there is no authenticated client (SIM, or read-only dashboard). */
  private async fetchPublicOrderBook(tokenID: string): Promise<any | null> {
    try {
      const url = `${this.clobHost}/book?token_id=${encodeURIComponent(tokenID)}`;
      const r = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "PolyBot/1.0 (public book)" },
        signal: AbortSignal.timeout(this.clobPublicBookTimeoutMs)
      });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  /**
   * Raw CLOB depth (same as live bot). Used by paper execution to walk the book; not a mid fallback.
   */
  async getRawOrderBook(tokenID: string): Promise<any | null> {
    const id = String(tokenID ?? "").trim();
    if (!id || id === "unknown") return null;
    if (this.client) {
      try {
        return await this.client.getOrderBook(id);
      } catch {
        /* fall through */
      }
    }
    return this.fetchPublicOrderBook(id);
  }

  private syntheticMarketContext(tokenID: string): MarketContext {
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

  private rawOrderBookToMarketContext(tokenID: string, book: any): MarketContext {
    const bidsRaw = Array.isArray(book?.bids) ? book.bids : [];
    const asksRaw = Array.isArray(book?.asks) ? book.asks : [];

    const toPrice = (x: any) => Number(x?.price ?? x?.p ?? x?.px ?? NaN);
    const toSize = (x: any) => Number(x?.size ?? x?.s ?? 0);

    const bids = bidsRaw
      .map((b: any) => ({ ...b, _price: toPrice(b) }))
      .filter((b: any) => Number.isFinite(b._price));
    const asks = asksRaw
      .map((a: any) => ({ ...a, _price: toPrice(a) }))
      .filter((a: any) => Number.isFinite(a._price));

    bids.sort((a: any, b: any) => b._price - a._price);
    asks.sort((a: any, b: any) => a._price - b._price);

    const bestBid = bids.length > 0 ? Number(bids[0]._price) : 0.49;
    const bestAsk = asks.length > 0 ? Number(asks[0]._price) : 0.51;

    const mid = (bestBid + bestAsk) / 2;
    const spread = Math.max(0, bestAsk - bestBid);

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

  /** POST `/books` once per refresh; `getMarketContext` hits this map for listed ids. */
  async primeBooksForTokens(tokenIds: string[]): Promise<void> {
    const unique = [...new Set(tokenIds.map((t) => String(t).trim()).filter((t) => t && t !== "unknown"))];
    const map = new Map<string, MarketContext>();
    if (unique.length === 0) {
      this.bookPrime = map;
      return;
    }

    const rawById = new Map<string, any>();

    if (this.client) {
      try {
        const books = await this.client.getOrderBooks(unique.map((token_id) => ({ token_id, side: Side.BUY })));
        if (Array.isArray(books)) {
          for (const book of books) {
            if (book?.asset_id != null) rawById.set(String(book.asset_id), book);
          }
        }
      } catch {
        /* fall through to public batch */
      }
    }

    const missing = unique.filter((id) => !rawById.has(id));
    if (missing.length > 0) {
      const pub = await batchBook(
        this.clobHost,
        missing,
        this.clobPublicBookTimeoutMs,
        this.clobBooksBatchChunk
      );
      for (const id of missing) {
        const b = pub.get(id);
        if (b) rawById.set(id, b);
      }
    }

    for (const id of unique) {
      const book = rawById.get(id);
      map.set(id, book ? this.rawOrderBookToMarketContext(id, book) : this.syntheticMarketContext(id));
    }

    this.bookPrime = map;
  }

  clearBookPrime(): void {
    this.bookPrime = null;
  }

  async getMarketContext(tokenID: string): Promise<MarketContext> {
    const primed = this.bookPrime?.get(tokenID);
    if (primed) return primed;

    let p = this.bookInflight.get(tokenID);
    if (!p) {
      p = this.loadMarketContextUncached(tokenID).finally(() => {
        this.bookInflight.delete(tokenID);
      });
      this.bookInflight.set(tokenID, p);
    }
    return p;
  }

  private async loadMarketContextUncached(tokenID: string): Promise<MarketContext> {
    let book: any = null;
    if (this.client) {
      try {
        book = await this.client.getOrderBook(tokenID);
      } catch {
        book = null;
      }
    }
    if (!book) {
      book = await this.fetchPublicOrderBook(tokenID);
    }
    if (!book) {
      return this.syntheticMarketContext(tokenID);
    }
    return this.rawOrderBookToMarketContext(tokenID, book);
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
      // Paper fills use engine → paperExecution.simulatePaperLimitBuy (best ask + PAPER_ENTRY_ASK_CROSS_BUFFER).
      return { orderID: "simulated", sizeFilled: input.amount, price: input.price, tokenID: "simulation" };
    }
    if (!this.client || !this.clobApiKeyReady) throw new Error("Polymarket client not initialized");
    const tokenID =
      input.direction === "UP" ? this.activeTokenUp() || this.clobTokenId : this.activeTokenDown() || this.clobTokenId;
    if (!tokenID || tokenID === "btc-5s-token") {
      throw new Error("Set CLOB_TOKEN_ID_UP/DOWN or enable AUTO_DISCOVER_UPDOWN for LIVE trading");
    }

    let price = input.price;
    const liveAskBuf = Number(process.env.LIVE_ENTRY_ASK_CROSS_BUFFER ?? "");
    if (Number.isFinite(liveAskBuf) && liveAskBuf > 0) {
      try {
        const raw = await this.getRawOrderBook(tokenID);
        const nb = normalizeRawOrderBook(raw);
        if (nb?.bestAsk != null && Number.isFinite(nb.bestAsk)) {
          price = Math.min(0.999, Math.max(price, nb.bestAsk + liveAskBuf));
        }
      } catch {
        /* keep input.price */
      }
    }

    const tickSize = await this.client.getTickSize(tokenID);
    const negRisk = await this.client.getNegRisk(tokenID);
    const side = Side.BUY;
    // `amount` is treated by the engine/UI as collateral USD to risk.
    // In Polymarket CLOB limit orders, `size` is token conditional shares.
    // For BUY orders: collateral cost ~= price * size => size ~= collateral / price.
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

export { settleReal, logRealSettlement } from "./polymarketSettlement.js";
