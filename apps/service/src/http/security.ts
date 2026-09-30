import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type Db, nowIso } from "../core/db.ts";

export const SESSION_COOKIE = "jarvis_session";
const PAIRING_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface ClientIdentity {
  id: string;
  name: string;
  kind: string;
}

export function allowedOrigins(port: number): Set<string> {
  const set = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "app://obsidian.md"]);
  for (const o of (process.env.JARVIS_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) set.add(o);
  return set;
}

/** Reject DNS-rebinding: the Host header must be the loopback address and our port. */
export function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? "").toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin navigations and non-browser clients (the plugin's requestUrl, the CLI)
  return allowedOrigins(port).has(origin);
}

export function createPairingCode(db: Db, purpose = "client"): { code: string; expiresAt: string } {
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  db.prepare("insert into pairing_codes (code_hash, purpose, created_at, expires_at) values (?,?,?,?)").run(sha256(code), purpose, nowIso(), expiresAt);
  return { code, expiresAt };
}

/** Exchange a single-use pairing code for a client token. */
export function redeemPairingCode(db: Db, code: string, client: { name: string; kind: string }): { token: string; client: ClientIdentity } | null {
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  const hash = sha256(normalized);
  const row = db.prepare("select code_hash, expires_at, used_at from pairing_codes where code_hash = ?").get(hash) as { expires_at: string; used_at: string | null } | undefined;
  if (!row || row.used_at || row.expires_at <= nowIso()) return null;
  const used = db.prepare("update pairing_codes set used_at = ? where code_hash = ? and used_at is null").run(nowIso(), hash);
  if (!used.changes) return null;
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  db.prepare("insert into clients (id, name, kind, token_hash, created_at, last_seen_at) values (?,?,?,?,?,?)").run(id, client.name.slice(0, 100), client.kind.slice(0, 30), sha256(token), nowIso(), nowIso());
  return { token, client: { id, name: client.name, kind: client.kind } };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function tokenFrom(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function authenticate(db: Db, req: IncomingMessage): ClientIdentity | null {
  const token = tokenFrom(req);
  if (!token || token.length < 20) return null;
  const hash = sha256(token);
  const row = db.prepare("select id, name, kind, token_hash from clients where token_hash = ? and revoked_at is null").get(hash) as { id: string; name: string; kind: string; token_hash: string } | undefined;
  if (!row) return null;
  if (!timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) return null;
  db.prepare("update clients set last_seen_at = ? where id = ?").run(nowIso(), row.id);
  return { id: row.id, name: row.name, kind: row.kind };
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 365}`;
}

export const clearedCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
