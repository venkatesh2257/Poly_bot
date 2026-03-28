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

  createNonce(address: string) {
    const normalized = address.toLowerCase();
    const nonce = randomBytes(16).toString("hex");
    this.nonces.set(normalized, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
    return nonce;
  }

  buildMessage(address: string, nonce: string) {
    return `PolyBot Sign-In
Address: ${address}
Nonce: ${nonce}
Statement: Sign this message to authenticate with PolyBot.
URI: http://localhost:5173
Version: 1
Chain ID: 137`;
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
    const expectedUser = process.env.APP_USER_ID ?? "admin";
    const expectedPass = process.env.APP_PASSWORD ?? "admin123";
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
