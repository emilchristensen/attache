import type { ConnectionDefinition, ConnectionStatus } from "@attache/contracts";
import { post } from "./api.ts";

/**
 * How a signed-out Connection is reconnected, by the method it was saved with:
 * `browser` signs in again in the browser (OAuth), `test` checks again after the owner fixed the sign-in outside
 * Attache (claude.ai connectors, the local Claude sign-in), and `credentials` needs new secrets typed on Connections.
 */
export type ReconnectMethod = "browser" | "test" | "credentials";

export function reconnectMethod(status: ConnectionStatus, definition: ConnectionDefinition): ReconnectMethod {
  const current = definition.authMethods.find((a) => a.id === status.authMethod);
  if (current?.browserSignIn) return "browser";
  if (current?.fields.some((f) => f.secret)) return "credentials";
  return "test";
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

/** Where Connections opens one Connection's repair controls. */
export function connectionHref(id?: string): string {
  return id ? `/connections?open=${encodeURIComponent(id)}` : "/connections";
}
