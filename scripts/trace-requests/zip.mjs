/**
 * The files in a zip archive, read with node:zlib: a Playwright trace stores each file either as is or deflated, so
 * no zip library is needed.
 */
import { inflateRawSync } from "node:zlib";

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

function endOfDirectory(zip) {
  // The record is 22 bytes plus a comment of at most 65535, at the very end.
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) if (zip.readUInt32LE(at) === END_OF_DIRECTORY) return at;
  throw new Error("Not a zip archive: no end of central directory record.");
}

/** @returns {Map<string, Buffer>} each file's name and contents */
export function unzip(zip) {
  const end = endOfDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  const files = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error(`Damaged zip archive: no directory entry at byte ${at}.`);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + skip;
    if (name.endsWith("/")) continue;
    if (zip.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`Damaged zip archive: no local header for ${name}.`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    if (method === STORED) files.set(name, data);
    else if (method === DEFLATED) files.set(name, inflateRawSync(data));
    else throw new Error(`${name} uses zip compression method ${method}; only stored and deflated files can be read.`);
  }
  return files;
}
