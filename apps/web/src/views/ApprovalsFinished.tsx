import { useState } from "react";
import { FINISHED_ACTION_STATUSES, type ActionView, type ProposalView } from "@attache/contracts";
import { useResource } from "../live.ts";
import { useSignals } from "../nav-signals.ts";
import { GroupFailure } from "../components/GroupFailure.tsx";
import { Loading } from "../components/ui.tsx";
import { finishedRows } from "../approvals.ts";
import { DraftRow } from "./DraftRow.tsx";
import { ProposalRow } from "./ProposalRow.tsx";

/** How many of each Finished lists: the latest outcomes. */
export const FINISHED_LIMIT = 50;

/**
 * Approvals' Finished tab: sent, not sent, unknown, rejected and expired Drafts, and applied or rejected Proposals,
 * the latest outcome first. The two lists load on their own, so one failure leaves the other's rows in view.
 */
export function ApprovalsFinished() {
  const draftsOff = useSignals().drafts.kind === "off";
  const drafts = useResource<ActionView[]>(draftsOff ? null : `/actions?status=${FINISHED_ACTION_STATUSES.join(",")}&limit=${FINISHED_LIMIT}`, ["actions.changed", "job"]);
  const proposals = useResource<{ proposals: ProposalView[] }>(`/memory/proposals?status=applied,rejected&limit=${FINISHED_LIMIT}`, ["memory.changed"]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = finishedRows(drafts.data ?? [], proposals.data?.proposals ?? []);
  const draftsAnswered = draftsOff || drafts.data !== null;
  const failed = (r: typeof drafts | typeof proposals) => r.error !== null && r.error.code !== "feature_disabled";
  const full = (drafts.data?.length ?? 0) >= FINISHED_LIMIT || (proposals.data?.proposals.length ?? 0) >= FINISHED_LIMIT;
  const toggle = (key: string) => setOpen(open === key ? null : key);
  return (
    <section className="approvals-group" aria-label="Finished" data-group="finished">
      {failed(drafts) && <GroupFailure what="Finished Drafts" error={drafts.error!} answeredAt={drafts.answeredAt} retry={drafts.reload} retained={drafts.data !== null} />}
      {failed(proposals) && <GroupFailure what="Decided Proposals" error={proposals.error!} answeredAt={proposals.answeredAt} retry={proposals.reload} retained={proposals.data !== null} />}
      {rows.length === 0 && (drafts.loading || proposals.loading) && !failed(drafts) && !failed(proposals) && <Loading lines={3} label="Loading Finished" />}
      {rows.length > 0 && (
        <ul className="approval-rows">
          {rows.map((r) =>
            r.kind === "draft" ? (
              <DraftRow key={`d:${r.row.id}`} d={r.row} place="finished" open={open === `d:${r.row.id}`} onToggle={() => toggle(`d:${r.row.id}`)} />
            ) : (
              <ProposalRow key={`p:${r.row.id}`} p={r.row} open={open === `p:${r.row.id}`} onToggle={() => toggle(`p:${r.row.id}`)} decide={null} />
            ),
          )}
        </ul>
      )}
      {rows.length === 0 && draftsAnswered && proposals.data !== null && !failed(drafts) && !failed(proposals) && <p className="approvals-empty">Nothing has finished yet.</p>}
      {full && <p className="approvals-none">Showing the latest {FINISHED_LIMIT} Drafts and the latest {FINISHED_LIMIT} Proposals.</p>}
    </section>
  );
}
