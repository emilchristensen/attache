/**
 * A minimal zip writer for the Windows release, so any host can build it
 * without a zip tool: deflated files, UTF-8 names, folders as entries.
 * Windows opens these with Explorer and with .NET's ZipFile.
 */
import { closeSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const STORE = 0;
const DIRECTORY = 0x10;
const LIMIT = 0xffffffff;

/** MS-DOS date and time, the only timestamp a plain zip entry has. */
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Every folder and file under `dir`, folders before their contents, as zip paths below `prefix`. */
function entries(dir, prefix) {
  const out = [{ name: `${prefix}/`, path: null }];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...entries(path, `${prefix}/${e.name}`));
    else if (e.isFile()) out.push({ name: `${prefix}/${e.name}`, path });
    else throw new Error(`zip: ${path} is neither a file nor a folder`);
  }
  return out;
}

/** Write `dir` into the zip file `out`, as the folder `prefix`. */
export function zipFolder(dir, prefix, out, at = new Date()) {
  const { time, date } = dosTime(at);
  const fd = openSync(out, "w");
  let offset = 0;
  const write = (buf) => {
    writeSync(fd, buf);
    offset += buf.length;
    if (offset > LIMIT) throw new Error("zip: the archive is larger than a plain zip can hold");
  };
  const central = [];
  try {
    for (const entry of entries(dir, prefix)) {
      const name = Buffer.from(entry.name, "utf8");
      const raw = entry.path ? readFileSync(entry.path) : Buffer.alloc(0);
      const data = entry.path ? deflateRawSync(raw, { level: 9 }) : raw;
      const method = entry.path ? DEFLATE : STORE;
      const crc = crc32(raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8_NAMES, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(time, 12);
      header.writeUInt16LE(date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(raw.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(entry.path ? 0 : DIRECTORY, 38);
      header.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([header, name]));
      write(local);
      write(name);
      write(data);
    }
    if (central.length > 0xffff) throw new Error("zip: more entries than a plain zip can hold");
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    write(directory);
    write(end);
  } finally {
    closeSync(fd);
  }
}
