import { createHash } from "node:crypto";

/**
 * SHA-256 over length-prefixed parts, truncated to 16 hex characters.
 * Length prefixes mean ("ab","c") and ("a","bc") can never collide, so a
 * crafted separator cannot make a changed item look unchanged.
 */
export function fingerprint(parts: Array<string | number | boolean | null | undefined>): string {
  const h = createHash("sha256");
  for (const p of parts) {
    const s = p === null || p === undefined ? "\u0000null" : typeof p === "string" ? p : JSON.stringify(p);
    const bytes = Buffer.from(s, "utf8");
    h.update(`${bytes.length}:`);
    h.update(bytes);
  }
  return h.digest("hex").slice(0, 16);
}
