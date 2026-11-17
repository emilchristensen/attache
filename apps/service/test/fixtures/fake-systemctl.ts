import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";

/** What the fake `systemctl --user` remembers: which units are enabled and which are running. */
export interface FakeSystemdState {
  enabled: string[];
  active: string[];
}

/**
 * A stand-in for `systemctl --user` on PATH, for testing the Linux service
 * manager on any host. It keeps the user manager's state in a JSON file, and
 * can pretend there is no user session to talk to.
 */
export function fakeSystemctl(opts: { noUserSession?: boolean } = {}) {
  const dir = tempDir("attache-fake-systemctl-");
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ enabled: [], active: [] } satisfies FakeSystemdState));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);
if (args[0] !== "--user") { console.error("only --user is faked"); process.exit(2); }
if (${opts.noUserSession ? "true" : "false"}) { console.error("Failed to connect to bus: No medium found"); process.exit(1); }
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const unit = (a) => path.basename(a);
const [cmd, ...rest] = args.slice(1);
const without = (list, u) => list.filter((x) => x !== u);
switch (cmd) {
  case "enable": { const u = unit(rest[0]); if (!fs.existsSync(rest[0])) { console.error("Failed to enable unit: Unit file " + rest[0] + " does not exist."); process.exit(1); } s.enabled = [...without(s.enabled, u), u]; break; }
  case "disable": s.enabled = without(s.enabled, rest[0]); break;
  case "restart": case "start": s.active = [...without(s.active, rest[0]), rest[0]]; break;
  case "stop": s.active = without(s.active, rest[0]); break;
  case "daemon-reload": case "reset-failed": break;
  case "show": process.stdout.write((s.active.includes(rest[0]) ? "active" : "inactive") + "\\n"); break;
  default: console.error("unfaked command " + cmd); process.exit(2);
}
save();
`;
  writeFileSync(join(bin, "systemctl"), script, { mode: 0o755 });
  return {
    /** Put this folder first on PATH. */
    bin,
    state: (): FakeSystemdState => JSON.parse(readFileSync(stateFile, "utf8")) as FakeSystemdState,
  };
}
