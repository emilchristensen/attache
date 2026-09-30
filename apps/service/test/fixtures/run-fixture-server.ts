/**
 * TEST-ONLY: start the fixture server with every happy-path scenario mounted.
 *   node --experimental-strip-types apps/service/test/fixtures/run-fixture-server.ts [port]
 * Port comes from argv, then FIXTURE_PORT, then 4599. Prints "FIXTURE_READY <url>" once listening.
 */
import { startFixtureServer } from "./fixture-server.ts";
import { installScenarios } from "./scenarios.ts";

const port = Number(process.argv[2] ?? process.env.FIXTURE_PORT ?? 4599);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`Invalid fixture port: ${process.argv[2] ?? process.env.FIXTURE_PORT}\n`);
  process.exit(2);
}

const fx = await startFixtureServer(port);
installScenarios(fx, { ...(process.env.FIXTURE_SELF_EMAIL ? { selfEmail: process.env.FIXTURE_SELF_EMAIL } : {}) });
process.stdout.write(`FIXTURE_READY ${fx.url}\n`);

const stop = () => {
  void fx.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
