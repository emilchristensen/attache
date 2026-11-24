import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

/**
 * The Agent sessions feature counts every Harness that saves sessions, not only the Harnesses that
 * run a hooks file: with only Pi, OpenCode or Copilot CLI connected, the feature is not waiting for a
 * Harness, and its text names every Harness it works with.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;

interface Feature {
  id: string;
  description: string;
  readiness: string;
  reason: string | null;
  dependsOn: { connections: Array<{ kinds: string[]; label: string; required: boolean }> };
}
interface Definition {
  kind: string;
  label: string;
  harness?: { capabilities: { capture: string } };
}

let svc: TestService;
const caps = () => svc.get<{ features: Feature[]; definitions: Definition[] }>("/capabilities");
const sessions = async () => (await caps()).features.find((f) => f.id === "sessions")!;

beforeAll(async () => {
  // Never run or find a real OpenCode or Copilot CLI.
  process.env.ATTACHE_OPENCODE_BIN = join(HOME, "no-opencode-here");
  process.env.ATTACHE_COPILOT_BIN = join(HOME, "no-copilot-here");
  svc = await startTestService();
});
afterAll(async () => {
  delete process.env.ATTACHE_OPENCODE_BIN;
  delete process.env.ATTACHE_COPILOT_BIN;
  await svc?.stop();
});

describe("the Agent sessions feature", () => {
  it("needs a Harness that saves sessions, and names every such Harness", async () => {
    const { definitions } = await caps();
    const savers = definitions.filter((d) => d.harness && d.harness.capabilities.capture !== "none");
    const harness = (await sessions()).dependsOn.connections.find((c) => c.required)!;
    expect([...harness.kinds].sort()).toEqual(savers.map((d) => d.kind).sort());
    const feature = await sessions();
    for (const d of savers) {
      expect(harness.label).toContain(d.label);
      expect(feature.description).toContain(d.label);
    }
    expect(feature.readiness).toBe("needs_setup");
  });

  for (const kind of ["pi", "opencode", "copilot-cli"]) {
    it(`is no longer waiting for a Harness once only ${kind} is connected`, async () => {
      await svc.post(`/connections/${kind}/configure`, { method: "mcp", fields: {} });
      const feature = await sessions();
      expect(feature.readiness, feature.reason ?? "").not.toBe("needs_setup");
      expect(feature.reason ?? "").not.toMatch(/Harness/);
      await svc.post(`/connections/${kind}/disconnect`, { deleteData: false });
    });
  }
});
