import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

/**
 * Smoke test against the real Pi executable, in an isolated Pi agent folder: connecting Pi through
 * Attache makes the real Pi register and connect Attache's MCP server, and disconnecting leaves Pi
 * with no Attache server. It runs only where `pi` is on PATH (or `ATTACHE_PI_EXECUTABLE` names it)
 * and is skipped otherwise.
 *
 * ADR 0006: Attache may call Pi's MCP access officially supported only while this passes; a failure
 * here withdraws that claim for Pi only.
 */

function findPi(): string | null {
  if (process.env.ATTACHE_PI_EXECUTABLE) return process.env.ATTACHE_PI_EXECUTABLE;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["pi", "pi.cmd", "pi.exe"]) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}
const PI = findPi();

/**
 * A test-only extension, loaded next to Attache's with `-e`: once the session has started it waits
 * for the named server's tools (or briefly, when none is named), then writes the MCP servers and
 * tools Pi has to a file. It never blocks Pi's own session start.
 */
const PROBE = `import { writeFileSync } from "node:fs";
export default function probe(pi) {
  pi.on("session_start", () => {
    void (async () => {
      // Pi namespaces a server's tools as mcp__<server>, with "-" in the server name turned into "_".
      const server = process.env.ATTACHE_PI_PROBE_SERVER;
      const deadline = Date.now() + (server ? 30000 : 3000);
      const tools = () => pi.getAllTools().filter((t) => t.namespace && t.namespace.name.startsWith("mcp__")).map((t) => ({ namespace: t.namespace.name, name: t.name }));
      while (Date.now() < deadline && !(server && tools().some((t) => t.namespace === "mcp__" + server.replace(/-/g, "_")))) await new Promise((r) => setTimeout(r, 250));
      const servers = pi.getMcpServers().map((s) => ({ name: s.name, extensionPath: s.extensionPath }));
      writeFileSync(process.env.ATTACHE_PI_PROBE_OUT, JSON.stringify({ servers, tools: tools() }));
    })();
  });
}
`;

interface Probe {
  servers: Array<{ name: string; extensionPath: string }>;
  /** MCP tools only, by Pi's namespace for their server. */
  tools: Array<{ namespace: string; name: string }>;
}

let svc: TestService;
let work: string;
let agentDir: string;

/** Start the real Pi with the probe, wait for its report, and stop Pi. */
async function runPi(server: string | null): Promise<Probe> {
  const out = join(work, `probe-${Date.now()}.json`);
  const probe = join(work, "probe.ts");
  writeFileSync(probe, PROBE);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ATTACHE_PI_PROBE_OUT: out, ATTACHE_PI_PROBE_SERVER: server ?? "" };
  const child = spawn(PI!, ["--mode", "rpc", "--no-session", "-e", probe], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  try {
    const deadline = Date.now() + 60_000;
    while (!existsSync(out)) {
      if (child.exitCode !== null) throw new Error(`pi exited with ${child.exitCode} before the probe reported: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`pi did not report its MCP servers within 60 s: ${stderr}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return JSON.parse(readFileSync(out, "utf8")) as Probe;
  } finally {
    child.kill();
  }
}

describe.skipIf(!PI)("the real Pi executable", () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "attache-pi-smoke-"));
    agentDir = join(work, "agent");
    // Both Attache and Pi use this agent folder, so the owner's real ~/.pi is never touched.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-pi-smoke-state-")) });
  });
  afterAll(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await svc?.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  // Each case starts the real Pi and Attache's MCP server, which together take far longer than a unit test.
  it("registers and connects Attache's MCP server once Attache connects Pi", { timeout: 120_000 }, async () => {
    await svc.post("/connections/pi/configure", { method: "mcp", fields: {} });
    const [file] = readdirSync(join(agentDir, "extensions"));
    const server = file!.replace(/\.ts$/, "");
    const r = await runPi(server);
    expect(r.servers).toEqual([{ name: server, extensionPath: join(agentDir, "extensions", file!) }]);
    const ours = r.tools.filter((t) => t.namespace === `mcp__${server.replace(/-/g, "_")}`);
    expect(ours.map((t) => t.name)).toEqual(expect.arrayContaining([expect.stringMatching(/search$/)]));
  });

  it("leaves Pi with no Attache server after disconnecting", { timeout: 120_000 }, async () => {
    const d = await svc.post<{ harness: { failures: string[] } }>("/connections/pi/disconnect", { deleteData: false });
    expect(d.harness.failures).toEqual([]);
    expect(readdirSync(join(agentDir, "extensions"))).toEqual([]);
    const r = await runPi(null);
    expect(r.servers.filter((s) => s.name.startsWith("attache"))).toEqual([]);
    expect(r.tools.filter((t) => t.namespace.startsWith("mcp__attache"))).toEqual([]);
  });
});
