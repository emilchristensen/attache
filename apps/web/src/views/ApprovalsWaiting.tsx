import { useRef, useState, type ReactNode } from "react";
import type { ActionView, ProposalView } from "@attache/contracts";
import { post, type ApiError } from "../api.ts";
import { useResource, type Resource } from "../live.ts";
import { useSignals } from "../nav-signals.ts";
import { TypeIcon } from "../components/TypeIcon.tsx";
import { Link, Loading, useAction } from "../components/ui.tsx";
import { draftRowText, entryId, nothingWaits, proposalRowText, withDecided, type Entry } from "../approvals.ts";
import { DecidedRow, GroupFailure, KIND_MARK, type ApprovalKind } from "./ApprovalRow.tsx";
import { DraftRow } from "./DraftRow.tsx";
import { brainNoteHref, ProposalRow } from "./ProposalRow.tsx";

/** How many Drafts being sent In progress lists. */
const SENDING_LIMIT = 50;

/** What the owner decided in this visit, so the row stays as one line in its place. */
interface Decided {
  words: string;
  subject: string;
  /** The note an applied Proposal wrote, for "Open in Brain" on its line. */
  note?: string;
}

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

/** The rows of one list with the ones decided in this visit kept in place; remembers what it showed for the next answer. */
function useShown<T extends { id: string }>(live: readonly T[], decided: ReadonlyMap<string, Decided>): Array<Entry<T, Decided>> {
  const shown = useRef<string[]>([]);
  const entries = withDecided(shown.current, live, decided);
  shown.current = entries.map(entryId);
  return entries;
}

/**
 * Approvals' Waiting tab: Drafts to send, Changes to the Brain, then In progress (Drafts being sent, not counted).
 * The waiting lists are the shell's, the ones behind the count, so the sections, the tab and the navigation agree.
 * Each group answers for its own request; "Nothing waits for your OK." shows only when both answered with nothing.
 */
export function ApprovalsWaiting() {
  const signals = useSignals();
  const drafts = signals.waitingDrafts;
  const proposals = signals.waitingProposals;
  const draftsOff = signals.drafts.kind === "off";
  const sending = useResource<ActionView[]>(draftsOff ? null : `/actions?status=executing&limit=${SENDING_LIMIT}`, ["actions.changed", "job"]);
  const [open, setOpen] = useState<string | null>(null);
  const [decided, setDecided] = useState<ReadonlyMap<string, Decided>>(new Map());
  const [justDecided, setJustDecided] = useState<string | null>(null);
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const { busy, run } = useAction();

  const draftEntries = useShown(drafts.data ?? [], decided);
  const proposalEntries = useShown(proposals.data?.proposals ?? [], decided);
  const toggle = (key: string) => setOpen(open === key ? null : key);
  const settle = (id: string, d: Decided) => {
    setDecided(new Map(decided).set(id, d));
    setJustDecided(id);
    setOpen(null);
  };

  const rejectDraft = (d: ActionView) =>
    run(`reject:${d.id}`, async () => {
      await post(`/actions/${d.id}/reject`, {});
      settle(d.id, { words: "Rejected", subject: draftRowText(d).subject });
      drafts.reload();
    });
  const decideProposal = (p: ProposalView, decision: "apply" | "reject") =>
    run(`${decision}:${p.id}`, async () => {
      try {
        const out = await post<ProposalView>(`/memory/proposals/${p.id}/${decision}`);
        settle(p.id, { words: decision === "apply" ? "Applied" : "Rejected", subject: proposalRowText(p).note, ...(decision === "apply" ? { note: out.target } : {}) });
        proposals.reload();
      } catch (e) {
        // A refused Apply keeps the row, open, with the reason; Reject stays available.
        if (decision === "apply" && (e as ApiError).status >= 400 && (e as ApiError).status < 500) setRefusals(new Map(refusals).set(p.id, (e as ApiError).message));
        else throw e;
      }
    });

  const empty = nothingWaits(signals.drafts, signals.proposals) && decided.size === 0;
  const sendingRows = sending.data ?? [];

  const draftsGroup = draftsOff ? (
    <p className="approvals-none">
      Drafts are switched off. <Link to="/settings">Open Settings</Link>
    </p>
  ) : (
    <>
      <GroupState what="Drafts" resource={drafts} counted />
      {draftEntries.length > 0 && (
        <ul className="approval-rows">
          {draftEntries.map((e) =>
            e.kind === "decided" ? (
              <DecidedRow key={e.id} kind="draft" id={e.id} words={e.decision.words} subject={e.decision.subject} focus={justDecided === e.id} />
            ) : (
              <DraftRow key={e.row.id} d={e.row} place="waiting" open={open === `d:${e.row.id}`} onToggle={() => toggle(`d:${e.row.id}`)} reject={{ run: (d) => void rejectDraft(d), busy: busy !== null }} />
            ),
          )}
        </ul>
      )}
      {drafts.data?.length === 0 && draftEntries.length === 0 && !drafts.error && <p className="approvals-none">No Drafts wait.</p>}
    </>
  );

  const proposalsGroup = (
    <>
      <GroupState what="Proposals" resource={proposals} counted />
      {proposalEntries.length > 0 && (
        <ul className="approval-rows">
          {proposalEntries.map((e) =>
            e.kind === "decided" ? (
              <DecidedRow
                key={e.id}
                kind="proposal"
                id={e.id}
                words={e.decision.words}
                subject={e.decision.subject}
                focus={justDecided === e.id}
                after={
                  e.decision.note && (
                    <Link to={brainNoteHref(e.decision.note)} className="btn small">
                      Open in Brain
                    </Link>
                  )
                }
              />
            ) : (
              <ProposalRow
                key={e.row.id}
                p={e.row}
                open={open === `p:${e.row.id}`}
                onToggle={() => toggle(`p:${e.row.id}`)}
                decide={{ apply: (p) => void decideProposal(p, "apply"), reject: (p) => void decideProposal(p, "reject"), busy: busy !== null, refusal: refusals.get(e.row.id) ?? null }}
              />
            ),
          )}
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
