import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unzip } from "../trace-requests/zip.mjs";
import { formatRequests, traceRequests } from "../trace-requests/requests.mjs";

/** A zip archive as Playwright writes a trace: the first file stored as is, the rest deflated. The reader skips CRCs. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const entries: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], n) => {
    const stored = n === 0;
    const raw = Buffer.from(text);
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    entries.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  });
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** One line of a trace's network file, as Playwright records a request. */
const snapshot = (at: string, method: string, url: string, status: number, postData?: object, content?: object) =>
  JSON.stringify({ type: "resource-snapshot", snapshot: { startedDateTime: at, request: { method, url, ...(postData ? { postData } : {}) }, response: { status, content: content ?? { size: 0 } } } });

describe("unzip", () => {
  it("reads stored and deflated files", () => {
    const files = unzip(zip({ "trace.trace": "first", "resources/a.json": '{"b":1}' }));
    expect([...files].map(([name, data]) => [name, data.toString()])).toEqual([
      ["trace.trace", "first"],
      ["resources/a.json", '{"b":1}'],
    ]);
  });

  it("refuses a file that is not a zip archive", () => {
    expect(() => unzip(Buffer.from("not a zip at all, just some words long enough"))).toThrow("Not a zip archive");
  });
});

describe("traceRequests", () => {
  const base = "http://127.0.0.1:51496";
  const network = [
    snapshot("2026-11-24T14:03:50.922Z", "POST", `${base}/api/v1/attention/x/decision`, 200, { text: "", _file: "resources/req.json" }, { _file: "resources/res.json" }),
    snapshot("2026-11-24T14:03:50.612Z", "POST", `${base}/api/v1/attention/x/decision`, 200, { text: '{"decision":"done"}' }, { _sha1: "old.json" }),
    snapshot("2026-11-24T14:03:50.995Z", "GET", `${base}/api/v1/attention?state=open&limit=200`, 200, undefined, { _file: "resources/gone.json" }),
    snapshot("2026-11-24T14:03:50.100Z", "GET", `${base}/assets/index.js`, 200),
  ].join("\n");
  const files = unzip(
    zip({
      "1-trace.network": network,
      // Another page's network file lists the same requests again.
      "3-trace.network": network,
      "resources/req.json": '{"decision":"reopen"}',
      "resources/res.json": '{"state":"open"}',
      "resources/old.json": '{"state":"resolved"}',
    }),
  );

  it("lists the API requests oldest first, once each, with bodies inline or from the trace's resources", () => {
    expect(traceRequests(files, "/api/")).toEqual([
      { at: "2026-11-24T14:03:50.612Z", method: "POST", path: "/api/v1/attention/x/decision", status: 200, request: '{"decision":"done"}', response: '{"state":"resolved"}' },
      { at: "2026-11-24T14:03:50.922Z", method: "POST", path: "/api/v1/attention/x/decision", status: 200, request: '{"decision":"reopen"}', response: '{"state":"open"}' },
      { at: "2026-11-24T14:03:50.995Z", method: "GET", path: "/api/v1/attention?state=open&limit=200", status: 200, request: "", response: "(resources/gone.json is not in the trace)" },
    ]);
  });

  it("keeps only the requests whose path and query contain the filter", () => {
    expect(traceRequests(files, "state=open").map((r) => r.path)).toEqual(["/api/v1/attention?state=open&limit=200"]);
  });

  it("prints one line per request with its bodies under it, long bodies cut", () => {
    expect(formatRequests(traceRequests(files, "/decision"), 12)).toBe(
      [
        "14:03:50.612 POST /api/v1/attention/x/decision 200",
        '  > {"decision":… (19 characters)',
        '  < {"state":"re… (20 characters)',
        "14:03:50.922 POST /api/v1/attention/x/decision 200",
        '  > {"decision":… (21 characters)',
        '  < {"state":"op… (16 characters)',
      ].join("\n"),
    );
  });
});
