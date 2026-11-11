import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSecretStore } from "../src/platform/secret-store/file.ts";
import { SystemSecretStore, type SecretBackend } from "../src/platform/secret-store/system-store.ts";
import { tempDir } from "./helpers.ts";

/** A system store that refuses to store one key. */
function backendRefusing(refused: string): SecretBackend {
  const items = new Map<string, string>();
  return {
    lookup: async (key) => items.get(key) ?? null,
    store: async (key, value) => {
      if (key === refused) throw new Error("the keyring is locked");
      items.set(key, value);
    },
    clear: async (key) => void items.delete(key),
  };
}

describe("a system secret store taking in secrets left in the private file", () => {
  it("says which secrets it could not move, and why, while they stay readable from the file", async () => {
    const dir = tempDir();
    const leftovers = new FileSecretStore(join(dir, "secrets.json"));
    await leftovers.set("slack", "s-1");
    await leftovers.set("gmail", "g-1");
    const store = new SystemSecretStore({ kind: "secret-service", backend: backendRefusing("gmail"), indexFile: join(dir, "index.json"), leftovers });

    expect(await store.get("gmail")).toBe("g-1");
    expect(await store.get("slack")).toBe("s-1");
    expect(await leftovers.keys()).toEqual(["gmail"]);
    expect(store.note).toBe("1 secret (gmail) could not be moved into the system secret store (the keyring is locked), so it stays in a file only you can read.");
  });

  it("has no note when every leftover moved", async () => {
    const dir = tempDir();
    const leftovers = new FileSecretStore(join(dir, "secrets.json"));
    await leftovers.set("slack", "s-1");
    const store = new SystemSecretStore({ kind: "secret-service", backend: backendRefusing("none"), indexFile: join(dir, "index.json"), leftovers });

    expect(await store.keys()).toEqual(["slack"]);
    expect(store.note).toBeNull();
  });
});
