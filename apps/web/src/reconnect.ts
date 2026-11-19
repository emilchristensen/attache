import type { ConnectionDefinition, ConnectionStatus } from "@attache/contracts";
import { post } from "./api.ts";

/**
 * How a signed-out Connection is reconnected, by the method it was saved with:
 * `browser` signs in again in the browser (OAuth); `test` checks again after the owner fixed the sign-in outside
 * Attache, where the method says how (claude.ai connectors, the local Claude sign-in); `reconfigure` saves the method
 * again so it picks up a login made elsewhere (the GitHub CLI's current token); `credentials` needs new secrets typed
 * on Connections.
 */
export type ReconnectMethod = "browser" | "test" | "reconfigure" | "credentials";

export function reconnectMethod(status: ConnectionStatus, definition: ConnectionDefinition): ReconnectMethod {
  const current = definition.authMethods.find((a) => a.id === status.authMethod);
  if (current?.browserSignIn) return "browser";
  if (current?.fields.some((f) => f.secret)) return "credentials";
  if (current && !current.reconnectHelp && current.fields.length === 0) return "reconfigure";
  return "test";
}

/** Save the Connection's method again with what it already has, so it reads a login made outside Attache; throws while it still fails. */
export async function reconfigureSignIn(status: ConnectionStatus): Promise<string> {
  const fields = typeof status.settings.apiBaseUrl === "string" && status.settings.apiBaseUrl ? { apiBaseUrl: status.settings.apiBaseUrl } : {};
  const r = await post<{ test: { ok: boolean; message: string } }>(`/connections/${status.kind}/configure`, { method: status.authMethod, fields, readScopes: status.readScopes });
  if (!r.test.ok) throw new Error(`Still not signed in: ${r.test.message}`);
  return r.test.message;
}

/** Leave for the provider's sign-in page; it returns to Connections. */
export async function startBrowserSignIn(kind: ConnectionStatus["kind"], includeWrite = false): Promise<void> {
  const r = await post<{ url: string }>(`/connections/${kind}/oauth/start`, { includeWrite });
  window.location.href = r.url;
}

/** Test the Connection again; throws with the service's words while it is still signed out. */
export async function testSignIn(id: string): Promise<string> {
  const r = await post<{ test: { ok: boolean; message: string } }>(`/connections/${id}/test`);
  if (!r.test.ok) throw new Error(`Still not signed in: ${r.test.message}`);
  return r.test.message;
}

/** Test a Connection that is in error again; throws with the service's words while it still fails. */
export async function retestConnection(id: string): Promise<string> {
  const r = await post<{ test: { ok: boolean; message: string } }>(`/connections/${id}/test`);
  if (!r.test.ok) throw new Error(`Still not working: ${r.test.message}`);
  return r.test.message;
}

/** Where Connections opens one Connection's repair controls. */
export function connectionHref(id?: string): string {
  return id ? `/connections?open=${encodeURIComponent(id)}` : "/connections";
}

/**
 * What the form for `method` starts with: the Connection's saved settings for its non-secret fields, only when it was
 * saved with that method. Saving sends every field again, so a blank one would replace what was saved (GitHub's API
 * address, a model's base URL); secrets always start blank.
 */
export function savedFields(status: ConnectionStatus, method: ConnectionDefinition["authMethods"][number] | undefined): Record<string, string> {
  if (!method || method.id !== status.authMethod) return {};
  const filled = method.fields.filter((f) => !f.secret).flatMap((f) => {
    const v = status.settings[f.id];
    return typeof v === "string" && v ? [[f.id, v] as const] : [];
  });
  return Object.fromEntries(filled);
}
