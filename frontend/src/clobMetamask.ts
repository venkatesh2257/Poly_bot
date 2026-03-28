import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { SignatureType } from "./constants/signatureType";

export type ClobSigningConfig = {
  host: string;
  chainId: number;
  signatureType: number;
  funderAddress: string;
  /** Server EOA from `EVM_PRIVATE_KEY` — MetaMask must match this for proxy/Safe funder. */
  signerAddress?: string;
  tokenIdUp: string;
  tokenIdDown: string;
};

/** EOA mode: MetaMask must equal funder. GNOSIS_SAFE / POLY_PROXY: MetaMask must equal signer EOA (not funder). */
export function assertMetaMaskMatchesClobRole(metamaskAddrLower: string, config: ClobSigningConfig): void {
  const st = config.signatureType;
  const modeName =
    st === SignatureType.GNOSIS_SAFE
      ? "GNOSIS_SAFE (2)"
      : st === SignatureType.POLY_PROXY
        ? "POLY_PROXY (1)"
        : "EOA (0)";
  const baseMsg = `Connected signer wallet: ${metamaskAddrLower}\nPolymarket funder wallet: ${config.funderAddress}\nSignature mode: ${modeName}`;
  if (st === SignatureType.GNOSIS_SAFE || st === SignatureType.POLY_PROXY) {
    const want = config.signerAddress?.toLowerCase();
    if (!want) {
      throw new Error(`${baseMsg}\nServer signing-config missing signerAddress (cannot verify MetaMask EOA signer).`);
    }
    if (metamaskAddrLower !== want) {
      throw new Error(`${baseMsg}\nExpected signer EOA: ${config.signerAddress}`);
    }
    return;
  }
  if (metamaskAddrLower !== config.funderAddress.toLowerCase()) {
    throw new Error(`${baseMsg}\nExpected funder EOA (EOA mode signer): ${config.funderAddress}`);
  }
}

function newClobClient(
  signer: ethers.JsonRpcSigner,
  creds: { key: string; secret: string; passphrase: string } | undefined,
  config: ClobSigningConfig
) {
  return new ClobClient(
    config.host,
    config.chainId,
    signer as never,
    creds as never,
    config.signatureType as never,
    config.funderAddress,
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );
}

async function ensurePolygon(provider: ethers.BrowserProvider) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== 137) {
    const w = window as unknown as {
      ethereum?: { request: (a: unknown) => Promise<unknown>; isMetaMask?: boolean; providers?: Array<any> };
    };
    const root = w.ethereum;
    const eth =
      root && Array.isArray(root.providers) && root.providers.length > 0
        ? root.providers.find((p) => p?.isMetaMask)
        : root?.isMetaMask
          ? root
          : null;
    if (!eth) throw new Error("MetaMask not found. Disable Trust Wallet extension or install MetaMask.");
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }]
    });
  }
}

async function getFirstMetaMaskSigner(provider: ethers.BrowserProvider) {
  // In ethers v6, BrowserProvider.listAccounts() returns JsonRpcSigner objects,
  // and we must explicitly fetch the address for downstream clob-client auth.
  const signers = await provider.listAccounts();
  const signer = signers?.[0];
  if (!signer) throw new Error("MetaMask has no active account (no signer returned).");
  const addr = (await signer.getAddress()).toLowerCase();
  return { signer, addr };
}

function wrapSignerForClob(signer: ethers.JsonRpcSigner): any {
  // clob-client checks for `signer._signTypedData` to decide how to auth/sign.
  // On some ethers versions, JsonRpcSigner has `signTypedData` but not `_signTypedData`,
  // which causes clob-client to misclassify it as a WalletClient and then fail with:
  // "wallet client is missing account address".
  if (typeof (signer as any)._signTypedData === "function") return signer;

  return {
    ...signer,
    getAddress: () => signer.getAddress(),
    _signTypedData: (domain: any, types: any, value: any) => signer.signTypedData(domain, types, value)
  };
}

function getClobNonce() {
  // clob-client uses nonce in EIP712 auth. Second-level timestamps collide when we
  // derive creds multiple times quickly (approve + balance + order), causing
  // intermittent "Could not create api key". Use ms + jitter for uniqueness.
  return Date.now() + Math.floor(Math.random() * 1000);
}

/**
 * Place a BUY on Polymarket CLOB using the user's MetaMask signer.
 * MetaMask must match EOA signer (proxy/Safe) or funder (EOA-only). See `assertMetaMaskMatchesClobRole`.
 */
export async function placeClobOrderFromMetaMask(
  direction: "UP" | "DOWN",
  size: number,
  price: number,
  config: ClobSigningConfig
) {
  const w = window as unknown as {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
      providers?: Array<any>;
    };
  };
  const root = w.ethereum;
  const isRealMetaMask = (p: any) =>
    Boolean(p?.isMetaMask) && (p?._metamask != null || String(p?.name ?? "").toLowerCase().includes("metamask"));
  const eth =
    root && Array.isArray(root.providers) && root.providers.length > 0
      ? root.providers.find((p) => isRealMetaMask(p))
      : isRealMetaMask(root)
        ? root
        : null;
  if (!eth) throw new Error("MetaMask not found. Disable Trust Wallet extension or install MetaMask.");

  const provider = new ethers.BrowserProvider(eth);
  await ensurePolygon(provider);
  const { signer, addr } = await getFirstMetaMaskSigner(provider);
  assertMetaMaskMatchesClobRole(addr, config);
  const clobSigner = wrapSignerForClob(signer);

  const bootstrap = newClobClient(clobSigner, undefined, config);
  const creds = await bootstrap.createOrDeriveApiKey(getClobNonce());
  const key = (creds as { key?: string; apiKey?: string }).key ?? (creds as { apiKey?: string }).apiKey;
  if (!key || !(creds as { secret?: string }).secret || !(creds as { passphrase?: string }).passphrase) {
    throw new Error("Could not derive CLOB API key (check wallet / network)");
  }
  const normalized = {
    key,
    secret: (creds as { secret: string }).secret,
    passphrase: (creds as { passphrase: string }).passphrase
  };
  const client = newClobClient(clobSigner, normalized, config);

  const tokenID = direction === "UP" ? config.tokenIdUp : config.tokenIdDown;
  const tickSize = await client.getTickSize(tokenID);
  const negRisk = await client.getNegRisk(tokenID);
  // Engine/UI passes `size` as collateral USD to risk.
  // For BUY limit orders: cost ~= price * conditionalShares => shares ~= collateral / price.
  const collateral = size;
  const rawShares = price > 0 ? collateral / price : collateral;
  const tick = Number(tickSize);
  const decimals = tickSize.includes(".") ? tickSize.split(".")[1].length : 0;
  const sizeShares = Number(rawShares.toFixed(decimals));
  const result = await client.createAndPostOrder(
    {
      tokenID,
      price,
      side: Side.BUY,
      size: sizeShares
    },
    {
      tickSize: String(tickSize) as never,
      negRisk
    },
    OrderType.GTC
  );
  return result;
}

type CachedCreds = { key: string; secret: string; passphrase: string; expiresAtMs: number };
let cachedCreds: { cacheKey: string; creds: CachedCreds } | null = null;

function credsCacheKey(config: ClobSigningConfig) {
  const s = config.signerAddress?.toLowerCase() ?? "no-signer";
  return `${config.host}|${config.chainId}|${config.signatureType}|${config.funderAddress.toLowerCase()}|${s}`;
}

async function deriveApiCreds(config: ClobSigningConfig, signer: ethers.JsonRpcSigner) {
  const ck = credsCacheKey(config);
  const now = Date.now();
  if (cachedCreds && cachedCreds.cacheKey === ck && cachedCreds.creds.expiresAtMs > now) {
    return {
      key: cachedCreds.creds.key,
      secret: cachedCreds.creds.secret,
      passphrase: cachedCreds.creds.passphrase
    };
  }

  const bootstrap = newClobClient(signer, undefined, config);
  const tryOnce = async () => {
    const creds = await bootstrap.createOrDeriveApiKey(getClobNonce());
    const key = (creds as { key?: string; apiKey?: string }).key ?? (creds as { apiKey?: string }).apiKey;
    if (!key || !(creds as { secret?: string }).secret || !(creds as { passphrase?: string }).passphrase) {
      throw new Error("Could not derive CLOB API key (check wallet / network)");
    }
    const out = {
      key,
      secret: (creds as { secret: string }).secret,
      passphrase: (creds as { passphrase: string }).passphrase
    };
    cachedCreds = { cacheKey: ck, creds: { ...out, expiresAtMs: now + 60_000 } };
    return out;
  };

  try {
    return await tryOnce();
  } catch {
    cachedCreds = null;
    return await tryOnce();
  }
}

/**
 * Read the CLOB collateral balance (USDC) using the user's MetaMask signer.
 * This mirrors the server's `getCollateralUsdc()` but runs in the browser.
 */
export async function getCollateralUsdcFromMetaMask(config: ClobSigningConfig): Promise<number> {
  const w = window as unknown as {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
      providers?: Array<any>;
    };
  };
  const root = w.ethereum;
  const isRealMetaMask = (p: any) =>
    Boolean(p?.isMetaMask) && (p?._metamask != null || String(p?.name ?? "").toLowerCase().includes("metamask"));
  const eth =
    root && Array.isArray(root.providers) && root.providers.length > 0
      ? root.providers.find((p) => isRealMetaMask(p))
      : isRealMetaMask(root)
        ? root
        : null;
  if (!eth) throw new Error("MetaMask not found. Disable Trust Wallet extension or install MetaMask.");

  const provider = new ethers.BrowserProvider(eth);
  await ensurePolygon(provider);
  const { signer, addr } = await getFirstMetaMaskSigner(provider);
  assertMetaMaskMatchesClobRole(addr, config);
  const clobSigner = wrapSignerForClob(signer);

  // CLOB reads require L2 auth; derive API creds in the browser using the signer.
  const apiCreds = await deriveApiCreds(config, clobSigner);
  const client = newClobClient(
    clobSigner,
    { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
    config
  );

  const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  // clob-client returns `balance`/`allowance` as integer strings (6 decimals for USDC).
  const rawBalance = BigInt(String((res as any)?.balance ?? "0"));
  return Number(rawBalance) / 1e6;
}

export async function getBalanceAllowanceFromMetaMask(config: ClobSigningConfig): Promise<{
  balanceRaw: string;
  allowanceRaw: string;
  balanceUsdc: number;
  allowanceUsdc: number;
}> {
  const w = window as unknown as {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
      providers?: Array<any>;
    };
  };
  const root = w.ethereum;
  const isRealMetaMask = (p: any) =>
    Boolean(p?.isMetaMask) && (p?._metamask != null || String(p?.name ?? "").toLowerCase().includes("metamask"));
  const eth =
    root && Array.isArray(root.providers) && root.providers.length > 0
      ? root.providers.find((p) => isRealMetaMask(p))
      : isRealMetaMask(root)
        ? root
        : null;
  if (!eth) throw new Error("MetaMask not found. Disable Trust Wallet extension or install MetaMask.");

  const provider = new ethers.BrowserProvider(eth);
  await ensurePolygon(provider);
  const { signer, addr } = await getFirstMetaMaskSigner(provider);
  assertMetaMaskMatchesClobRole(addr, config);
  const clobSigner = wrapSignerForClob(signer);

  const apiCreds = await deriveApiCreds(config, clobSigner);
  const client = newClobClient(
    clobSigner,
    { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
    config
  );
  const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const balanceRaw = String((res as any)?.balance ?? "0");
  const allowanceRaw = String((res as any)?.allowance ?? "0");
  const balanceUsdc = Number(BigInt(balanceRaw)) / 1e6;
  const allowanceUsdc = Number(BigInt(allowanceRaw)) / 1e6;
  return { balanceRaw, allowanceRaw, balanceUsdc, allowanceUsdc };
}

/**
 * Triggers the SDK/relayer “approve spending cap” flow by updating the CLOB balance allowance.
 * This is the same class of wallet prompt you saw in the Polymarket UI (“Approve USDC spending cap”).
 */
export async function approveCollateralAllowanceFromMetaMask(config: ClobSigningConfig): Promise<void> {
  const w = window as unknown as {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
      providers?: Array<any>;
    };
  };
  const root = w.ethereum;
  const isRealMetaMask = (p: any) =>
    Boolean(p?.isMetaMask) && (p?._metamask != null || String(p?.name ?? "").toLowerCase().includes("metamask"));
  const eth =
    root && Array.isArray(root.providers) && root.providers.length > 0
      ? root.providers.find((p) => isRealMetaMask(p))
      : isRealMetaMask(root)
        ? root
        : null;
  if (!eth) throw new Error("MetaMask not found. Disable Trust Wallet extension or install MetaMask.");

  const provider = new ethers.BrowserProvider(eth);
  await ensurePolygon(provider);
  const { signer, addr } = await getFirstMetaMaskSigner(provider);
  assertMetaMaskMatchesClobRole(addr, config);
  const clobSigner = wrapSignerForClob(signer);

  const apiCreds = await deriveApiCreds(config, clobSigner);
  const client = newClobClient(
    clobSigner,
    { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
    config
  );

  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
}

export async function buildMetaMaskClobClient(config: ClobSigningConfig): Promise<ClobClient> {
  const w = window as unknown as {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
      providers?: Array<any>;
    };
  };
  const root = w.ethereum;
  const isRealMetaMask = (p: any) =>
    Boolean(p?.isMetaMask) && (p?._metamask != null || String(p?.name ?? "").toLowerCase().includes("metamask"));
  const eth =
    root && Array.isArray(root.providers) && root.providers.length > 0
      ? root.providers.find((p) => isRealMetaMask(p))
      : isRealMetaMask(root)
        ? root
        : null;
  if (!eth) throw new Error("MetaMask not found. Disable Trust Wallet extension or install MetaMask.");
  const provider = new ethers.BrowserProvider(eth);
  await ensurePolygon(provider);
  const { signer, addr } = await getFirstMetaMaskSigner(provider);
  assertMetaMaskMatchesClobRole(addr, config);
  const clobSigner = wrapSignerForClob(signer);
  const apiCreds = await deriveApiCreds(config, clobSigner);
  return newClobClient(
    clobSigner,
    { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase },
    config
  );
}

function sumReservedBuyCollateralUsdc(
  orders: Array<{ side: string; original_size: string; size_matched: string; price: string }>
): number {
  let sum = 0;
  for (const o of orders) {
    if (String(o.side).toUpperCase() !== Side.BUY) continue;
    const orig = Number(o.original_size ?? 0);
    const matched = Number(o.size_matched ?? 0);
    const remaining = Math.max(0, orig - matched);
    sum += Number(o.price ?? 0) * remaining;
  }
  return Number(sum.toFixed(6));
}

/** Balance minus open BUY reservations (same logic as server wallet). */
export async function getAvailableCollateralBudgetFromMetaMask(config: ClobSigningConfig): Promise<{
  balanceRaw: string;
  allowanceRaw: string;
  balanceUsdc: number;
  allowanceUsdc: number;
  reservedUsdc: number;
  availableUsdc: number;
}> {
  const ba = await getBalanceAllowanceFromMetaMask(config);
  const client = await buildMetaMaskClobClient(config);
  const raw = await client.getOpenOrders();
  const list = Array.isArray(raw) ? raw : [];
  const reservedUsdc = sumReservedBuyCollateralUsdc(list as any);
  const availableUsdc = Math.max(0, ba.balanceUsdc - reservedUsdc);
  return {
    ...ba,
    reservedUsdc,
    availableUsdc: Number(availableUsdc.toFixed(6))
  };
}

/** Poll until CLOB reports the order fully matched (or timeout). */
export async function pollOrderUntilFilledMetaMask(
  orderId: string,
  config: ClobSigningConfig,
  opts?: { maxMs?: number; intervalMs?: number; minMatchedRatio?: number }
): Promise<boolean> {
  const client = await buildMetaMaskClobClient(config);
  const maxMs = opts?.maxMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 2000;
  const minR = opts?.minMatchedRatio ?? 0.999;
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const o = await client.getOrder(orderId);
    if (!o) continue;
    const orig = Number(o.original_size);
    const matched = Number(o.size_matched);
    if (orig > 0 && matched >= orig * minR) return true;
  }
  return false;
}

export async function fetchOrderMatchedSharesMetaMask(
  orderId: string,
  config: ClobSigningConfig
): Promise<{ matched: number; original: number }> {
  const client = await buildMetaMaskClobClient(config);
  const o = await client.getOrder(orderId);
  if (!o) return { matched: 0, original: 0 };
  return {
    matched: Number(o.size_matched ?? 0),
    original: Number(o.original_size ?? 0)
  };
}

/**
 * Market-style SELL of conditional shares (MetaMask signs the CLOB order).
 * Uses FAK so partial fills still unwind when liquidity is thin.
 */
export async function placeClobMarketSellFromMetaMask(
  tokenID: string,
  shares: number,
  config: ClobSigningConfig
) {
  const client = await buildMetaMaskClobClient(config);
  const tickSize = await client.getTickSize(tokenID);
  const negRisk = await client.getNegRisk(tokenID);
  const decimals = String(tickSize).includes(".") ? String(tickSize).split(".")[1].length : 0;
  const amount = Number(Math.max(0, shares).toFixed(decimals));
  if (amount <= 0) throw new Error("SELL size must be positive");

  return client.createAndPostMarketOrder(
    {
      tokenID,
      side: Side.SELL,
      amount,
      orderType: OrderType.FAK
    },
    {
      tickSize: String(tickSize) as never,
      negRisk
    },
    OrderType.FAK
  );
}

export async function cancelClobMarketOrdersForAssetMetaMask(
  assetId: string,
  config: ClobSigningConfig
): Promise<void> {
  const client = await buildMetaMaskClobClient(config);
  try {
    await client.cancelMarketOrders({ asset_id: assetId });
  } catch {
    /* best-effort */
  }
}
