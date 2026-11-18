import { describe, expect, it } from "vitest";
import type { ConnectionDefinition, ConnectionStatus } from "@attache/contracts";
import { savedFields } from "../src/reconnect.ts";

// The form to repair or reconfigure a Connection starts with what it saved, except its secrets, so typing only a new
// token keeps the rest (a GitHub Enterprise address would otherwise be sent to public GitHub).

const method = (id: string, fields: Array<{ id: string; secret: boolean }>): ConnectionDefinition["authMethods"][number] => ({ id, label: id, fields: fields.map((f) => ({ ...f, label: f.id })) });
const github = method("token", [{ id: "token", secret: true }, { id: "apiBaseUrl", secret: false }]);
const status = (settings: Record<string, unknown>, authMethod = "token") => ({ settings, authMethod }) as Pick<ConnectionStatus, "settings" | "authMethod"> as ConnectionStatus;

describe("savedFields", () => {
  it("fills a saved non-secret field and never a secret", () => {
    expect(savedFields(status({ apiBaseUrl: "https://ghe.example.com/api/v3", token: "leak" }), github)).toEqual({ apiBaseUrl: "https://ghe.example.com/api/v3" });
  });
  it("leaves out empty and non-text settings", () => {
    expect(savedFields(status({ apiBaseUrl: "", builtin: true }), github)).toEqual({});
  });
  it("fills nothing for a method the Connection was not saved with", () => {
    expect(savedFields(status({ apiBaseUrl: "https://ghe.example.com/api/v3" }, "gh-cli"), github)).toEqual({});
  });
  it("fills nothing without a method", () => {
    expect(savedFields(status({ apiBaseUrl: "x" }), undefined)).toEqual({});
  });
});
