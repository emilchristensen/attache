import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { ConnectionDefinition, SetupDefaults } from "@jarvis/contracts";
import { platformLocations } from "../../src/platform/locations.ts";
import { startTestService, type TestService } from "./harness.ts";

const running: TestService[] = [];
afterAll(async () => {
  for (const s of running) await s.stop().catch(() => {});
});

describe("folder suggestions and examples the Dashboard shows", () => {
  it("are paths on this computer, in its Documents folder and with its own separators", async () => {
    const svc = await startTestService({ setup: false });
    running.push(svc);
    const documents = join(platformLocations().home, "Documents");

    const defaults = await svc.get<SetupDefaults>("/setup/defaults");
    expect(defaults).toEqual({
      home: platformLocations().home,
      suggestion: join(documents, "Jarvis"),
      examples: { notes: join(documents, "Notes"), brain: join(documents, "Brain") },
    });

    // An imported folder's path field shows the same example.
    const caps = await svc.get<{ definitions: ConnectionDefinition[] }>("/capabilities");
    const vault = caps.definitions.find((d) => d.kind === "vault")!;
    const pathField = vault.authMethods.flatMap((m) => m.fields).find((f) => f.id === "path")!;
    expect(pathField.placeholder).toBe(defaults.examples.notes);

    // No macOS home folder reaches the Dashboard from another operating system.
    if (process.platform !== "darwin") expect(JSON.stringify({ defaults, caps })).not.toContain("/Users/");
  });
});
