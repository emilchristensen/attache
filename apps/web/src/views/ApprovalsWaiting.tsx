import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionView, ProposalView } from "@attache/contracts";
import { post, type ApiError } from "../api.ts";
import { useResource, type Resource } from "../live.ts";
import { useSignals } from "../nav-signals.ts";
import { TypeIcon } from "../components/TypeIcon.tsx";
import { Link, Loading, useAction } from "../components/ui.tsx";
import { draftRowText, nothingWaits, proposalRowText } from "../approvals.ts";
import { shownEntries, type ApprovalsVisit } from "./approvals-visit.ts";
import { DecidedRow, GroupFailure, KIND_MARK, type ApprovalKind } from "./ApprovalRow.tsx";
import { DraftRow } from "./DraftRow.tsx";
import { brainNoteHref, ProposalRow } from "./ProposalRow.tsx";

/** How many Drafts being sent In progress lists. */
const SENDING_LIMIT = 50;

/** A ruled section with its stamp and word. */
function Group({ id, kind, title, lead, children }: { id: string; kind: ApprovalKind | null; title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="approvals-group" aria-labelledby={id} data-group={id}>
      <h2 id={id} className="approvals-group-title">
        {kind && <TypeIcon icon={KIND_MARK[kind].icon} hue={KIND_MARK[kind].hue} size="sm" />}
        {title}
      </h2>
      {lead && <p className="approvals-group-lead">{lead}</p>}
      {children}
    </section>
  );
}

/**
 * A group's state above its rows: still loading on first load, or its own failure (with the rows it still holds and
 * when they were loaded). Feature-off answers are not failures.
 */
function GroupState<T>({ what, resource, counted }: { what: string; resource: Resource<T>; counted: boolean }) {
  if (resource.error && resource.error.code !== "feature_disabled") return <GroupFailure what={what} error={resource.error} answeredAt={resource.answeredAt} retry={resource.reload} retained={resource.data !== null} counted={counted} />;
  if (!resource.data && resource.loading) return <Loading lines={2} label={`Loading ${what}`} />;
  return null;
}

/**
 * Approvals' Waiting tab: Drafts to send, Changes to the Brain, then In progress (Drafts being sent, not counted).
 * The waiting lists are the shell's, the ones behind the count, so the sections, the tab and the navigation agree.
 * Each group answers for its own request; "Nothing waits for your OK." shows only when both answered with nothing.
 */
export function ApprovalsWaiting({ visit }: { visit: ApprovalsVisit }) {
  const signals = useSignals();
  const drafts = signals.waitingDrafts;
  const proposals = signals.waitingProposals;
  const draftsOff = signals.drafts.kind === "off";
  const sending = useResource<ActionView[]>(draftsOff ? null : `/actions?status=executing&limit=${SENDING_LIMIT}`, ["actions.changed", "job"]);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAction();

  const draftEntries = shownEntries(visit.drafts, drafts.data ?? []);
  const proposalEntries = shownEntries(visit.proposals, proposals.data?.proposals ?? []);
  const toggle = (key: string) => setOpen(open === key ? null : key);
  const { setJustDecided } = visit;
  const focused = useCallback(() => setJustDecided(null), [setJustDecided]);
  // A decision answered after the owner moved to Finished asks for no focus: the tab they came back by keeps it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settled = (id: string) => {
    if (!mounted.current) return;
    setJustDecided(id);
    setOpen(null);
  };

  const rejectDraft = (d: ActionView) =>
    run(`reject:${d.id}`, async () => {
      visit.drafts.begin(d);
      try {
        await post(`/actions/${d.id}/reject`, {});
      } catch (e) {
        visit.drafts.drop(d.id);
        throw e;
      }
      visit.drafts.finish(d.id, { words: "Rejected", subject: draftRowText(d).subject });
      settled(d.id);
      drafts.reload();
    });
  const decideProposal = (p: ProposalView, decision: "apply" | "reject") =>
    run(`${decision}:${p.id}`, async () => {
      visit.proposals.begin(p);
      let out: ProposalView;
      try {
        out = await post<ProposalView>(`/memory/proposals/${p.id}/${decision}`);
      } catch (e) {
        visit.proposals.drop(p.id);
        // A refused Apply keeps the row, open, with the reason; Reject stays available.
        if (decision === "apply" && (e as ApiError).status >= 400 && (e as ApiError).status < 500) return visit.refuse(p.id, (e as ApiError).message);
        throw e;
      }
      visit.proposals.finish(p.id, { words: decision === "apply" ? "Applied" : "Rejected", subject: proposalRowText(p).note, ...(decision === "apply" ? { note: out.target } : {}) });
      settled(p.id);
      proposals.reload();
    });

  // The count route counts every waiting decision, whatever these lists answer; only while the count is on the lists
  // (the route failed) does a failed group drop out of it, and then the Approvals part is a lower bound.
  const leftOut = !signals.count.approvals.exact;
  const empty = nothingWaits(signals.drafts, signals.proposals) && visit.drafts.decisions.size === 0 && visit.proposals.decisions.size === 0;
  const sendingRows = sending.data ?? [];

  const draftsGroup = draftsOff ? (
    <p className="approvals-none">
      Drafts are switched off. <Link to="/settings">Open Settings</Link>
    </p>
  ) : (
    <>
      <GroupState what="Drafts" resource={drafts} counted={leftOut} />
      {draftEntries.length > 0 && (
        <ul className="approval-rows">
          {draftEntries.map((e) => {
            if (e.kind === "decided" && e.decision.state === "done")
              return <DecidedRow key={e.id} kind="draft" id={e.id} words={e.decision.words} subject={e.decision.subject} focus={visit.justDecided === e.id} onFocused={focused} />;
            // Live, or held in its place while the decision is with the service.
            // A held row's decision is with the service (also after a tab switch remounted this list): nothing to press.
            const d = e.kind === "live" ? e.row : (e.decision as { row: ActionView }).row;
            return <DraftRow key={d.id} d={d} place="waiting" open={open === `d:${d.id}`} onToggle={() => toggle(`d:${d.id}`)} reject={{ run: (row) => void rejectDraft(row), busy: busy !== null || e.kind === "decided" }} />;
          })}
        </ul>
      )}
      {drafts.data?.length === 0 && draftEntries.length === 0 && !drafts.error && <p className="approvals-none">No Drafts wait.</p>}
    </>
  );

  const proposalsGroup = (
    <>
      <GroupState what="Proposals" resource={proposals} counted={leftOut} />
      {proposalEntries.length > 0 && (
        <ul className="approval-rows">
          {proposalEntries.map((e) => {
            if (e.kind === "decided" && e.decision.state === "done")
              return (
                <DecidedRow
                  key={e.id}
                  kind="proposal"
                  id={e.id}
                  words={e.decision.words}
                  subject={e.decision.subject}
                  focus={visit.justDecided === e.id}
                  onFocused={focused}
                  after={
                    e.decision.note && (
                      <Link to={brainNoteHref(e.decision.note)} className="btn small">
                        Open in Brain
                      </Link>
                    )
                  }
                />
              );
            // Live, or held in its place while the decision is with the service.
            const p = e.kind === "live" ? e.row : (e.decision as { row: ProposalView }).row;
            return (
              <ProposalRow
                key={p.id}
                p={p}
                open={open === `p:${p.id}`}
                onToggle={() => toggle(`p:${p.id}`)}
                decide={{ apply: (row) => void decideProposal(row, "apply"), reject: (row) => void decideProposal(row, "reject"), busy: busy !== null || e.kind === "decided", refusal: visit.refusals.get(p.id) ?? null }}
              />
            );
          })}
        </ul>
      )}
      {proposals.data?.proposals.length === 0 && proposalEntries.length === 0 && !proposals.error && <p className="approvals-none">No changes to the Brain wait.</p>}
    </>
  );

  return (
    <div className="approvals-waiting">
      {empty ? (
        <p className="approvals-empty" data-nothing-waits>
          Nothing waits for your OK.
        </p>
      ) : (
        <>
          <Group id="drafts-to-send" kind="draft" title="Drafts to send" lead="Nothing is sent until you approve one exact version on the Draft's page.">
            {draftsGroup}
          </Group>
          <Group id="changes-to-the-brain" kind="proposal" title="Changes to the Brain" lead="Apply writes the whole change to the note; Reject writes nothing.">
            {proposalsGroup}
          </Group>
        </>
      )}
      {(sendingRows.length > 0 || (sending.error && sending.error.code !== "feature_disabled")) && (
        <Group id="in-progress" kind={null} title="In progress" lead="Being sent now. Nothing here waits for you.">
          <GroupState what="Drafts being sent" resource={sending} counted={false} />
          {sendingRows.length > 0 && (
            <ul className="approval-rows">
              {sendingRows.map((d) => (
                <DraftRow key={d.id} d={d} place="sending" open={open === `s:${d.id}`} onToggle={() => toggle(`s:${d.id}`)} />
              ))}
            </ul>
          )}
        </Group>
      )}
    </div>
  );
}
