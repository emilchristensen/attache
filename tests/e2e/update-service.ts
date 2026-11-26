/**
 * TEST-ONLY: the service as a release install would run it, for journeys through Updates (spec #130).
 *   node tests/e2e/update-service.ts --state-dir <folder> --port <n> --prefix <folder> --requests <file>
 * It runs from source, so `ATTACHE_RELEASE_PUBLIC_KEY` (the test key), `ATTACHE_VERSION` and `ATTACHE_RELEASE_FEED_URL`
 * (the journey's local release server) come from the environment, as they do in the service tests. A release bundle
 * builds its key in, so nothing here reaches a shipped service. The installer runner is a fake: it starts no installer
 * and appends each request, as a line of JSON, to the `--requests` file, where the journey reads it and plays the installer.
 * Prints the bundle's "attache service listening" line and writes `runtime.json`, so `stack.ts` starts it like the bundle.
 */
import { appendFileSync } from "node:fs";
import { App, VERSION } from "../../apps/service/src/app.ts";
import { resolvePaths } from "../../apps/service/src/core/paths.ts";
import { startServer } from "../../apps/service/src/http/server.ts";
import { writeFileWhole } from "../../apps/service/src/platform/replace-file.ts";
import type { InstallerRunner } from "../../apps/service/src/updates/installer-runner.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`update-service.ts needs --${name}`);
  return value;
}

const paths = resolvePaths(arg("state-dir"));
const prefix = arg("prefix");
const requests = arg("requests");
const installerRunner: InstallerRunner = {
  async start(request) {
    appendFileSync(requests, `${JSON.stringify(request)}\n`);
  },
};
const app = new App({ stateDir: paths.stateDir, updates: { releaseInstall: { prefix }, installerRunner } });
const handle = await startServer(app, { port: Number(arg("port")) });
app.start();
writeFileWhole(app.paths.runtimeFile, JSON.stringify({ pid: process.pid, port: handle.port, url: handle.url, version: VERSION, startedAt: app.startedAt, instance: app.instance }, null, 2), { mode: 0o600 });
app.log.info("attache service listening", { url: handle.url, version: VERSION, stateDir: app.paths.stateDir });
process.on("SIGTERM", () => {
  void handle
    .close()
    .then(() => app.stop())
    .finally(() => process.exit(0));
});
