/**
 * A local stand-in for GitHub Releases for the install test: the release list
 * the installed service reads (`ATTACHE_RELEASE_FEED_URL`), newest first, and
 * each release's files as downloadable assets. Releases are folders the
 * release build wrote; publishing a version again replaces it.
 *
 * The server runs in a child process of its own: the install test runs the
 * owner's commands synchronously, which would leave a server in its own
 * process unable to answer the service while `attache update` runs.
 */
import { fork } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FEED_PATH = "/repos/emilchristensen/attache/releases";

/** The server itself, in the child: answers the feed and downloads, and takes `publish` messages from the parent. */
function serve() {
  /** Published releases, oldest first: { version, folder }. */
  let releases = [];
  const files = (folder) => readdirSync(folder).filter((f) => statSync(join(folder, f)).isFile());
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.method === "GET" && url.pathname === FEED_PATH) {
      const list = [...releases].reverse().map((r, i) => ({
        id: i + 1,
        tag_name: `v${r.version}`,
        name: `Attache ${r.version}`,
        draft: false,
        prerelease: r.version.includes("-"),
        assets: files(r.folder).map((name) => ({ name, size: statSync(join(r.folder, name)).size, browser_download_url: `${base}/download/v${r.version}/${encodeURIComponent(name)}` })),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(list));
    }
    const m = /^\/download\/v([^/]+)\/([^/]+)$/.exec(url.pathname);
    const release = m && releases.find((r) => r.version === decodeURIComponent(m[1]));
    const name = m && decodeURIComponent(m[2]);
    if (release && name && files(release.folder).includes(name)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(readFileSync(join(release.folder, name)));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });
  process.on("message", (msg) => {
    if (msg.op === "publish") releases = [...releases.filter((r) => r.version !== msg.version), { version: msg.version, folder: msg.folder }];
    process.send({ id: msg.id });
  });
  // The test ended, however it ended: nothing keeps this server up.
  process.on("disconnect", () => process.exit(0));
  server.listen(0, "127.0.0.1", () => process.send({ ready: true, port: server.address().port }));
}

export async function startReleaseServer() {
  const child = fork(import.meta.filename, ["--serve"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const port = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the release server stopped (exit code ${code})`)));
    child.once("message", (m) => resolve(m.port));
  });
  let next = 1;
  const ask = (msg) =>
    new Promise((resolve) => {
      const id = next++;
      const onMessage = (m) => {
        if (m.id !== id) return;
        child.off("message", onMessage);
        resolve();
      };
      child.on("message", onMessage);
      child.send({ ...msg, id });
    });
  const copies = [];
  return {
    feedUrl: `http://127.0.0.1:${port}${FEED_PATH}`,
    /** Publish the release folder `folder` as `version`, replacing an earlier one of that version. */
    publish: (version, folder) => ask({ op: "publish", version, folder }),
    /**
     * Publish `version` from a copy of `folder` whose archive `archive` has one byte changed after signing:
     * the manifest and its signature are genuine, the download is not what they name.
     */
    publishTampered(version, folder, archive) {
      const copy = mkdtempSync(join(tmpdir(), `attache-tampered-${version}-`));
      copies.push(copy);
      for (const f of readdirSync(folder)) if (statSync(join(folder, f)).isFile()) copyFileSync(join(folder, f), join(copy, f));
      const bytes = readFileSync(join(copy, archive));
      bytes[bytes.length - 1] ^= 0xff;
      writeFileSync(join(copy, archive), bytes);
      return ask({ op: "publish", version, folder: copy });
    },
    async close() {
      if (child.connected) child.disconnect();
      for (const c of copies) rmSync(c, { recursive: true, force: true });
    },
  };
}

if (process.argv.includes("--serve")) serve();
