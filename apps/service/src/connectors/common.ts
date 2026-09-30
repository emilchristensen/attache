import type { CoverageState } from "@jarvis/contracts";
import type { CoverageTracker } from "./types.ts";
import { RemoteError } from "./http.ts";

/** Normalise any thrown value into a classified RemoteError. */
export function asRemoteError(e: unknown): RemoteError {
  if (e instanceof RemoteError) return e;
  return new RemoteError((e as Error)?.message ?? String(e), "error");
}

/** Coverage state for a listing: failures and caps are partial, a successful zero is empty. */
export function listingState(r: { items: unknown[]; complete: boolean }, itemCount = r.items.length): CoverageState {
  if (!r.complete) return "partial";
  return itemCount ? "complete" : "empty";
}

/** Human note explaining why a listing is partial, if it is. */
export function listingNote(r: { complete: boolean; error: RemoteError | null }, maxPages: number, extra: string[] = []): string | undefined {
  const parts = [...extra];
  if (r.error) parts.unshift(r.error.message);
  else if (!r.complete) parts.unshift(`Stopped after ${maxPages} pages`);
  return parts.length ? parts.join("; ") : undefined;
}

export function recordFailure(cov: CoverageTracker, label: string, e: unknown): void {
  const err = asRemoteError(e);
  cov.add(label, err.state ?? "error", 0, 0, err.message);
}

export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, "utf8").toString("base64")}`;
}

/**
 * Validate a user-entered site URL (Atlassian Cloud or self-hosted). Only
 * https is accepted, except plain http on loopback for local testing.
 */
export function normalizeSiteUrl(raw: string, stripSuffix?: RegExp): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RemoteError(`"${raw}" is not a valid URL. Use the form https://your-site.atlassian.net`, "not_configured");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new RemoteError("The site URL must start with https://", "not_configured");
  let path = url.pathname.replace(/\/+$/, "");
  if (stripSuffix) path = path.replace(stripSuffix, "");
  return `${url.origin}${path}`;
}

/** Calendar date (YYYY-MM-DD) of a moment in the service's local time zone. */
export function localDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function stringSetting(settings: Record<string, unknown>, key: string): string {
  const v = settings[key];
  return typeof v === "string" ? v.trim() : "";
}

export function csvList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}
