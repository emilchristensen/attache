import type { WrapUpInput, WrapUpResult } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";
import { HttpError } from "../http/router.ts";

export const NOTHING_DURABLE = "The conversation held nothing durable, so nothing was stored.";

/**
 * Store the durable points of a Harness conversation as one evidence document.
 * A wrap-up without points stores nothing: an empty document would only add
 * noise to search.
 */
export function recordWrapUp(app: App, input: WrapUpInput, clientId: string | null): WrapUpResult {
  if (!input.points.length) return { stored: false, reason: NOTHING_DURABLE };
  if (!app.memory.dataRoot) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
  const { relPath, title, date } = app.memory.recordWrapUp({ harness: input.harness, title: input.title ?? `Conversation in ${input.harness.label}`, points: input.points });
  app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), clientId ?? "user", "wrap_up_recorded", JSON.stringify({ harness: input.harness.id, relPath, points: input.points.length }));
  return { stored: true, relPath, title, date, points: input.points.length };
}
