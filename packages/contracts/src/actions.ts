import { z } from "zod";

/** API contract: Actions (drafts and approvals). */

export type ActionStatus = "draft" | "approved" | "rejected" | "expired" | "revoked" | "executing" | "succeeded" | "failed" | "unknown";

/** A draft in one of these is not finished: it waits for the owner, or is being sent. */
export const OPEN_ACTION_STATUSES: readonly ActionStatus[] = ["draft", "approved", "revoked", "executing"];

/** A draft in one of these waits for the owner's decision (approve, approve again, send or reject): the open ones minus `executing`. */
export const WAITING_ACTION_STATUSES: readonly ActionStatus[] = ["draft", "approved", "revoked"];

/** A draft in one of these is finished: nothing more happens to it, and its attention item can be drafted again. */
export const FINISHED_ACTION_STATUSES: readonly ActionStatus[] = ["succeeded", "failed", "unknown", "rejected", "expired"];

export interface ActionView {
  id: string;
  kind: string;
  connectionId: string | null;
  title: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  payloadHash: string;
  version: number;
  context: Record<string, unknown>;
  status: ActionStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  approval: { version: number; payloadHash: string; nonce: string; expiresAt: string; approvedAt: string } | null;
  receipt: Record<string, unknown> | null;
  events: Array<{ event: string; data: unknown; at: string; actor: string }>;
  executable: { ok: boolean; reason: string | null };
}

/** Events that start or end an approval; the last of them tells how the latest approval ended. */
const APPROVAL_EVENTS = new Set(["approved", "approval_expired", "approval_revoked", "approval_invalidated", "edited", "rejected", "restored", "expired"]);

/**
 * When the current version's approval ran out on its own (its 15 minutes passed and the
 * draft went back to `draft`), or null when the draft is not in that state.
 */
export function approvalEndedAt(action: Pick<ActionView, "status" | "version" | "events">): string | null {
  if (action.status !== "draft") return null;
  const last = action.events.findLast((e) => APPROVAL_EVENTS.has(e.event));
  if (last?.event !== "approval_expired") return null;
  const data = last.data as { version?: unknown; approvalExpiresAt?: unknown } | null;
  if (data?.version !== action.version) return null;
  return typeof data.approvalExpiresAt === "string" ? data.approvalExpiresAt : last.at;
}

export const ActionEditInput = z.object({ payload: z.record(z.string(), z.unknown()), expectedVersion: z.number().int() });
export const ActionRestoreInput = z.object({ expectedVersion: z.number().int() });
export const ActionApproveInput = z.object({ version: z.number().int(), payloadHash: z.string().length(64) });
export const ActionExecuteInput = z.object({ nonce: z.string().min(16), version: z.number().int(), payloadHash: z.string().length(64) });
