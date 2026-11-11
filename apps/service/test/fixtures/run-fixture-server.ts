/**
 * TEST-ONLY: start the fixture server with every happy-path scenario mounted.
 *   node --experimental-strip-types apps/service/test/fixtures/run-fixture-server.ts [port]
 * Port comes from argv, then FIXTURE_PORT, then 4599. Prints "FIXTURE_READY <url>" once listening.
 */
import { startFixtureServer } from "./fixture-server.ts";
import { installScenarios } from "./scenarios.ts";
import { installFixtureModel } from "./fixture-model.ts";
import { installFixtureMeaningModel } from "./fixture-meaning-model.ts";

const port = Number(process.argv[2] ?? process.env.FIXTURE_PORT ?? 4599);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Invalid fixture port: ${process.argv[2] ?? process.env.FIXTURE_PORT}\n`);
  process.exit(2);
}

const fx = await startFixtureServer(port);
const { claude } = installScenarios(fx, { ...(process.env.FIXTURE_SELF_EMAIL ? { selfEmail: process.env.FIXTURE_SELF_EMAIL } : {}) });
// Browser journeys flip a claude.ai connector's state (e.g. to "needs-auth") from outside the process.
fx.route("POST", "/__control/claude-server", (req) => {
  const b = req.body as { name: string; status: string };
  const s = claude.servers.find((x) => x.name === b.name);
  if (!s) return { status: 404, json: { error: `unknown server ${b.name}` } };
  s.status = b.status;
  return { json: { ok: true } };
});
installFixtureModel(fx, "/model");
// The meaning model a journey downloads from the Dashboard, described to the service by JARVIS_MEANING_MODEL.
installFixtureMeaningModel(fx, "/meaning-model");
process.stdout.write(`FIXTURE_READY ${fx.url}\n`);

const stop = () => {
  void fx.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
