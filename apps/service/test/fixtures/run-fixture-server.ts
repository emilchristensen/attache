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
const { claude, state } = installScenarios(fx, { ...(process.env.FIXTURE_SELF_EMAIL ? { selfEmail: process.env.FIXTURE_SELF_EMAIL } : {}) });
// Browser journeys flip a claude.ai connector's state (e.g. to "needs-auth") from outside the process.
fx.route("POST", "/__control/claude-server", (req) => {
  const b = req.body as { name: string; status: string };
  const s = claude.servers.find((x) => x.name === b.name);
  if (!s) return { status: 404, json: { error: `unknown server ${b.name}` } };
  s.status = b.status;
  return { json: { ok: true } };
});
// A journey makes GitHub's read-back of a posted comment fail, so a real send ends with an unknown outcome.
fx.route("POST", "/__control/github-read-back", (req) => {
  state.github.readBackFails = (req.body as { fails: boolean }).fails;
  return { json: { ok: true } };
});
// Journeys set the calendar to meetings at times relative to now (meeting prep, back-to-back meetings); a Source
// refresh of Google Calendar reads them.
fx.route("POST", "/__control/gcal-events", (req) => {
  const b = req.body as { events?: unknown };
  if (!Array.isArray(b.events)) return { status: 400, json: { error: "events must be a list" } };
  state.gcal.events = b.events as typeof state.gcal.events;
  return { json: { ok: true, events: state.gcal.events.length } };
});
// Journeys revoke a GitHub token, so GitHub answers 401 to it and the next read signs the Connection out, then
// restore it (`revoke: false`).
fx.route("POST", "/__control/github-token", (req) => {
  const b = req.body as { token?: unknown; revoke?: unknown };
  if (typeof b.token !== "string" || !b.token || typeof b.revoke !== "boolean") return { status: 400, json: { error: "token (string) and revoke (boolean) are required" } };
  const others = state.revokedGithubTokens.filter((t) => t !== b.token);
  state.revokedGithubTokens = b.revoke ? [...others, b.token] : others;
  return { json: { ok: true, revoked: state.revokedGithubTokens.length } };
});
installFixtureModel(fx, "/model");
// The meaning model a journey downloads from the Dashboard, described to the service by ATTACHE_MEANING_MODEL.
installFixtureMeaningModel(fx, "/meaning-model");
process.stdout.write(`FIXTURE_READY ${fx.url}\n`);

const stop = () => {
  void fx.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
