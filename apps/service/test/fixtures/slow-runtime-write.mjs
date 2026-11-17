// Preloaded with `node --import` so the `attache` executable writes runtime.json the way a loaded
// machine can make it: paused between creating the file and filling it. Every write to a file named
// after runtime.json, its temporary files included, waits SLOW_RUNTIME_WRITE_MS after opening the
// file, and its path is appended to SLOW_RUNTIME_WRITE_LOG, so a test can tell the pause took place.
import fs from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const pauseMs = Number(process.env.SLOW_RUNTIME_WRITE_MS ?? 500);
const log = process.env.SLOW_RUNTIME_WRITE_LOG;
const writeFileSync = fs.writeFileSync;

fs.writeFileSync = function (file, data, options) {
  if (typeof file !== "string" || !basename(file).includes("runtime.json")) return writeFileSync.apply(this, arguments);
  const opts = typeof options === "object" && options !== null ? options : {};
  const fd = fs.openSync(file, opts.flag ?? "w", opts.mode ?? 0o666);
  try {
    if (log) fs.appendFileSync(log, `${file}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
    fs.writeSync(fd, typeof data === "string" ? data : Buffer.from(data));
  } finally {
    fs.closeSync(fd);
  }
};
// `import { writeFileSync } from "node:fs"` in the service sees the replacement too.
syncBuiltinESMExports();
