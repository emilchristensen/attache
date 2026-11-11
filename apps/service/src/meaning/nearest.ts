import type { Db } from "../core/db.ts";
import { decodeVector } from "./vectors.ts";

/**
 * The chunks whose vectors point most nearly the way `query` does, best first.
 * Vectors are unit length, so the dot product is the cosine. A chunk that
 * points away from the question, or whose text the model had nothing to say
 * about (a zero vector), is not near it at all and is left out.
 */
export function nearestChunks(db: Db, modelId: string, query: Float32Array, limit: number): number[] {
  const rows = db
    .prepare("select c.id as id, v.vector as vector from chunks c join chunk_vectors v on v.model = ? and v.hash = c.embed_hash")
    .all(modelId) as Array<{ id: number; vector: Uint8Array }>;
  const scored: Array<{ id: number; score: number }> = [];
  for (const r of rows) {
    const score = dot(decodeVector(r.vector), query);
    if (score > 0) scored.push({ id: Number(r.id), score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit)
    .map((s) => s.id);
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}
