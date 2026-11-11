import { type Db, tx } from "../core/db.ts";

/**
 * Vectors live in this Machine's own index, next to the chunks, and never in
 * the Brain. A vector belongs to a model and to the text it was made from, not
 * to a chunk row, so re-chunking a file keeps the vectors of text that did not change.
 */

export interface PendingText {
  hash: string;
  text: string;
}

/** Up to `limit` distinct chunk texts that have no vector from this model yet. */
export function pendingTexts(db: Db, modelId: string, limit: number): PendingText[] {
  return db
    .prepare(
      `select c.embed_hash as hash, min(c.embed_text) as text from chunks c
       where c.embed_hash is not null and not exists (select 1 from chunk_vectors v where v.model = ? and v.hash = c.embed_hash)
       group by c.embed_hash limit ?`,
    )
    .all(modelId, limit) as unknown as PendingText[];
}

export function storeVectors(db: Db, modelId: string, rows: ReadonlyArray<{ hash: string; vector: Float32Array }>): void {
  const insert = db.prepare("insert or replace into chunk_vectors (model, hash, vector) values (?, ?, ?)");
  tx(db, () => {
    for (const r of rows) insert.run(modelId, r.hash, encodeVector(r.vector));
  });
}

/** Chunks in the index, and how many have a vector from this model. */
export function vectorCoverage(db: Db, modelId: string): { chunks: number; embedded: number } {
  const row = db
    .prepare("select count(*) as chunks, count(v.hash) as embedded from chunks c left join chunk_vectors v on v.model = ? and v.hash = c.embed_hash")
    .get(modelId) as { chunks: number; embedded: number };
  return { chunks: Number(row.chunks), embedded: Number(row.embedded) };
}

/** Drop vectors of other models and of text no chunk has any more. */
export function pruneVectors(db: Db, modelId: string): number {
  const r = db.prepare("delete from chunk_vectors where model <> ? or not exists (select 1 from chunks c where c.embed_hash = chunk_vectors.hash)").run(modelId);
  return Number(r.changes);
}

/** Little-endian float32, the layout of a `Float32Array` on every platform Jarvis runs on. */
export function encodeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}
