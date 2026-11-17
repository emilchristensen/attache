import { z } from "zod";
import type { ActionStatus } from "./actions.ts";

/** API contract: Attention. */

export interface AttentionItemView {
  id: string;
  key: string;
  kind: string;
  title: string;
  summary: string;
  why: string | null;
  sourceKind: string;
  connectionId: string | null;
  url: string | null;
  dueAt: string | null;
  priority: number;
  state: "open" | "dismissed" | "snoozed" | "resolved";
  snoozeUntil: string | null;
  evidence: Array<{ label: string; url?: string; relPath?: string; lines?: [number, number]; observedAt: string }>;
  firstSeenAt: string;
  updatedAt: string;
  /** The draft last prepared for this item on this Machine; drafts do not replicate, so another Machine has its own. */
  actionId: string | null;
  /** That draft's status now, or null when there is none. Only a draft in `OPEN_ACTION_STATUSES` still stands for the item. */
  actionStatus: ActionStatus | null;
  changedSinceDecision: boolean;
  draftable: { actionKind: string; target: Record<string, unknown>; context: Record<string, unknown> } | null;
}

export const AttentionDecision = z.object({
  decision: z.enum(["dismiss", "snooze", "reopen", "done"]),
  until: z.string().datetime().optional(),
});
