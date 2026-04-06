import { randomBytes } from "node:crypto";
import { ethers } from "ethers";

interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

interface SessionEntry {
  address?: string;
  userId?: string;
  authType: "wallet" | "password";
  expiresAt: number;
}

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class AuthService {
  private nonces = new Map<string, NonceEntry>();
  private sessions = new Map<string, SessionEntry>();

  /** True when both `APP_USER_ID` and `APP_PASSWORD` are set (non-empty). No insecure defaults. */
  isPasswordAuthConfigured(): boolean {
    const u = String(process.env.APP_USER_ID ?? "").trim();
    const p = String(process.env.APP_PASSWORD ?? "").trim();
    return Boolean(u && p);
  }

  createNonce(address: string) {
    const normalized = address.toLowerCase();
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(normalized, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  /**
   * EIP-191 message for wallet login. URI is included only when configured — no localhost default.
   * Prefer `SIGN_IN_MESSAGE_URI` (exact string shown to the user), else `APP_ORIGIN`.
   */
  buildMessage(address: string, nonce: string) {
    const signInUri = String(process.env.SIGN_IN_MESSAGE_URI ?? "").trim();
    const appOrigin = String(process.env.APP_ORIGIN ?? "").trim();
    const uri = signInUri || appOrigin;
    const lines = [
      "PolyBot Sign-In",
      `Address: ${address}`,
      `Nonce: ${nonce}`,
      "Statement: Sign this message to authenticate with PolyBot."
    ];
    if (uri) {
      lines.push(`URI: ${uri}`);
    }
    lines.push("Version: 1", "Chain ID: 137");
    return lines.join("\n");
  }

  verifySignature(input: { address: string; signature: string }) {
    const normalized = input.address.toLowerCase();
    const nonceEntry = this.nonces.get(normalized);
    if (!nonceEntry || nonceEntry.expiresAt < Date.now()) return null;

    const message = this.buildMessage(input.address, nonceEntry.nonce);
    const recovered = this.recoverAddress(message, input.signature).toLowerCase();
    if (recovered !== normalized) return null;

    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { address: input.address, authType: "wallet", expiresAt: Date.now() + SESSION_TTL_MS });
    this.nonces.delete(normalized);
    return { token, address: input.address };
  }

  loginWithPassword(input: { userId: string; password: string }) {
    const expectedUser = String(process.env.APP_USER_ID ?? "").trim();
    const expectedPass = String(process.env.APP_PASSWORD ?? "").trim();
    if (!expectedUser || !expectedPass) return null;
    if (input.userId !== expectedUser || input.password !== expectedPass) return null;
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { userId: input.userId, authType: "password", expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, userId: input.userId };
  }

  getSession(token: string | undefined) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  private recoverAddress(message: string, signature: string) {
    const ethersAny = ethers as any;
    if (typeof ethersAny.verifyMessage === "function") {
      return ethersAny.verifyMessage(message, signature);
    }
    return ethersAny.utils.verifyMessage(message, signature);
  }
}
