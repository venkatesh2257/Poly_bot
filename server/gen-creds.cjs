/**
 * L1 → derive L2 Polymarket API credentials (run from server/: node gen-creds.cjs)
 * Reads EVM_PRIVATE_KEY from .env (same folder).
 * Uses SIGNATURE_TYPE (or CLOB_SIGNATURE_TYPE) + CLOB_FUNDER_ADDRESS like the live WalletService (signer EOA ≠ funder for GNOSIS_SAFE).
 */
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const { Wallet } = require("@ethersproject/wallet");
const { ClobClient } = require("@polymarket/clob-client");

const pk = process.env.EVM_PRIVATE_KEY;
if (!pk) {
  console.error("Missing EVM_PRIVATE_KEY in .env");
  process.exit(1);
}

function readSignatureType() {
  const raw = process.env.SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE ?? "0";
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^0x[0-9a-fA-F]+$/i.test(s)) {
    console.warn("SIGNATURE_TYPE must be decimal 0, 1, or 2 (not hex). Using 0.");
    return 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

const signatureType = readSignatureType();
const funder = process.env.CLOB_FUNDER_ADDRESS;

const wallet = new Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
const client = new ClobClient(
  process.env.CLOB_HOST ?? "https://clob.polymarket.com",
  Number(process.env.CLOB_CHAIN_ID ?? 137),
  wallet,
  undefined,
  signatureType,
  funder,
  undefined,
  true,
  undefined,
  undefined,
  undefined,
  undefined,
  true
);

client
  .createOrDeriveApiKey()
  .then((creds) => {
    const apiKey = creds.apiKey ?? creds.key;
    const { secret, passphrase } = creds;
    console.log("signerAddress=" + wallet.address);
    console.log("funderAddress=" + (funder ?? ""));
    console.log("signatureType=" + signatureType);
    console.log("POLY_API_KEY=" + apiKey);
    console.log("POLY_API_SECRET=" + secret);
    console.log("POLY_PASSPHRASE=" + passphrase);
    console.log("POLY_API_PASSPHRASE=" + passphrase);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
