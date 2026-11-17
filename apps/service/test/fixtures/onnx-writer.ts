/**
 * TEST-ONLY: write the smallest ONNX model a meaning model can be, so tests
 * run the real ONNX runtime without downloading a real model. The model is one
 * `Gather` node: each token id picks a row of a fixed table, which gives the
 * `last_hidden_state` output a sentence-embedding model has.
 *
 * Protocol Buffers are encoded by hand for the few ONNX messages used; field
 * numbers are those of onnx/onnx.proto.
 */

const ONNX_FLOAT = 1;
const ONNX_INT64 = 7;
const IR_VERSION = 8;
const OPSET = 13;

const encoder = new TextEncoder();

function varint(value: number): number[] {
  const out: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

const key = (field: number, wire: 0 | 2) => varint((field << 3) | wire);
const int = (field: number, value: number) => [...key(field, 0), ...varint(value)];
const bytes = (field: number, value: Uint8Array | number[]) => [...key(field, 2), ...varint(value.length), ...value];
const text = (field: number, value: string) => bytes(field, encoder.encode(value));

/** A tensor shape: a number is a fixed size, a string a named size such as the batch. */
type Dim = number | string;

function valueInfo(name: string, elemType: number, dims: Dim[]): number[] {
  const shape = dims.flatMap((d) => bytes(1, typeof d === "number" ? int(1, d) : text(2, d)));
  const tensorType = [...int(1, elemType), ...bytes(2, shape)];
  return [...text(1, name), ...bytes(2, bytes(1, tensorType))];
}

/** Rows of `table` are the vectors for token ids 0..n-1. */
export function gatherEmbeddingModel(table: number[][]): Uint8Array {
  const rows = table.length;
  const dims = table[0]?.length ?? 0;
  if (!rows || !dims || table.some((r) => r.length !== dims)) throw new Error("table must be a non-empty rectangle");
  const raw = new Uint8Array(new Float32Array(table.flat()).buffer);
  const initializer = [...int(1, rows), ...int(1, dims), ...int(2, ONNX_FLOAT), ...text(8, "table"), ...bytes(9, raw)];
  const node = [...text(1, "table"), ...text(1, "input_ids"), ...text(2, "last_hidden_state"), ...text(3, "embed"), ...text(4, "Gather")];
  const graph = [
    ...bytes(1, node),
    ...text(2, "fixture-meaning-model"),
    ...bytes(5, initializer),
    ...bytes(11, valueInfo("input_ids", ONNX_INT64, ["batch", "sequence"])),
    ...bytes(11, valueInfo("attention_mask", ONNX_INT64, ["batch", "sequence"])),
    ...bytes(12, valueInfo("last_hidden_state", ONNX_FLOAT, ["batch", "sequence", dims])),
  ];
  const opset = [...text(1, ""), ...int(2, OPSET)];
  return Uint8Array.from([...int(1, IR_VERSION), ...text(2, "attache-tests"), ...bytes(7, graph), ...bytes(8, opset)]);
}
